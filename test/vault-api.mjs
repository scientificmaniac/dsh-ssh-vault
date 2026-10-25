/**
 * 单元回归：设置界面 API 的校验、脱敏与响应形状。
 *
 * 不需要真实主机，也不需要 HTTP 服务器——用最小的 req/res 替身驱动真正的路由处理器，
 * 所以整条请求路径（方法检查、路径解析、body 解析、分发、envelope）都被覆盖到。
 *
 * 运行：node test/vault-api.mjs
 */
import { readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { API_PREFIX, SETTINGS_PROBE_TIMEOUT_MS, createVaultApi, resetFilePermissions } from '../lib/vault-api.js'

/**
 * 测试用的保险库目录。走系统临时目录，因为「上传私钥」的用例会真的落盘；
 * 结束时整目录删除，不在用户磁盘上留东西。
 */
const VAULT_DIR = path.join(os.tmpdir(), `dsh-ssh-vault-test-${process.pid}`)

/**
 * 删除测试保险库目录。上传的私钥副本被收紧成了用户只读 ACL（icacls），
 * 这种 ACL 连删除都拒绝（EPERM），必须先逐个恢复再整目录 rm。
 */
async function removeVaultDir() {
  try {
    const keyDir = path.join(VAULT_DIR, 'keys')
    for (const name of await readdir(keyDir)) await resetFilePermissions(path.join(keyDir, name))
  } catch {
    // keys/ 不存在（还没跑过上传用例）时无需恢复。
  }
  await rm(VAULT_DIR, { recursive: true, force: true })
}

let passed = 0
const failures = []
function check(name, condition, detail) {
  if (condition) {
    passed += 1
    return
  }
  failures.push(`${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

/** 最小的请求替身：异步可迭代，提供 method/url/destroy/headers。 */
function fakeRequest(url, body, method = 'POST', headers = {}) {
  const payload = Buffer.from(body === undefined ? '{}' : JSON.stringify(body), 'utf8')
  return {
    method,
    url,
    headers,
    async *[Symbol.asyncIterator]() {
      yield payload
    },
    destroy() {},
  }
}

/** 最小的响应替身：记录状态码与响应体。 */
function fakeResponse() {
  return {
    statusCode: 0,
    headers: undefined,
    body: '',
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = headers
    },
    end(chunk) {
      this.body = chunk ?? ''
      this.complete = true
    },
  }
}

/** 一台内存保险库。 */
function memoryVault(seed = {}) {
  const hosts = { ...seed }
  return {
    hosts,
    keyMode: 'dpapi',
    async list() {
      return Object.values(hosts)
    },
    async get(alias) {
      return hosts[alias]
    },
    async put(record) {
      hosts[record.alias] = record
      return record
    },
    async remove(alias) {
      if (hosts[alias] === undefined) return false
      delete hosts[alias]
      return true
    },
  }
}

const sampleRecord = {
  alias: 'demo',
  host: '192.0.2.10',
  port: 22,
  username: 'root',
  auth: { type: 'password', password: 'stored-secret' },
  shell: 'bash',
  description: 'demo host',
  tags: ['lab'],
  sudoPassword: 'sudo-secret',
  updatedAt: '2026-10-17T00:00:00.000Z',
}

/** 跑一次请求并解析 envelope。 */
async function invoke(handler, url, body, method, headers) {
  const res = fakeResponse()
  await handler(fakeRequest(url, body, method, headers), res)
  let parsed
  try {
    parsed = JSON.parse(res.body)
  } catch {
    parsed = undefined
  }
  return { status: res.statusCode, envelope: parsed, raw: res.body, headers: res.headers }
}

// —— list：脱敏且永不返回口令 ——
{
  const vault = memoryVault({ demo: sampleRecord })
  const handler = createVaultApi({ vault, vaultDir: VAULT_DIR, probe: async () => ({ ok: true, detail: '', notes: [] }) })
  const { status, envelope, raw } = await invoke(handler, `${API_PREFIX}/list`, {})
  check('list 返回 200', status === 200, String(status))
  check('list 成功 envelope', envelope.ok === true, raw)
  check('list 含 1 台主机', envelope.value.hosts.length === 1, raw)
  check('list 掩码地址', envelope.value.hosts[0].host === '192.0.*.*', envelope.value.hosts[0].host)
  check('list 掩码账号', envelope.value.hosts[0].username === 'r***', envelope.value.hosts[0].username)
  check('list 不含口令字段', !raw.includes('stored-secret') && !raw.includes('sudo-secret'), raw)
  check('list 报告密钥保护方式', envelope.value.keyMode === 'dpapi', raw)
  check('list 标记已存口令', envelope.value.hosts[0].hasPassword === true, raw)
}

// —— save：校验 ——
{
  const vault = memoryVault()
  const handler = createVaultApi({ vault, vaultDir: VAULT_DIR, probe: async () => ({ ok: true, detail: '', notes: [] }) })
  const cases = [
    ['空别名被拒', { alias: '', host: 'h', username: 'u', password: 'p' }, '别名'],
    ['非法别名被拒', { alias: 'a b/c', host: 'h', username: 'u', password: 'p' }, '别名'],
    ['空主机被拒', { alias: 'ok', host: '', username: 'u', password: 'p' }, '地址'],
    ['空账号被拒', { alias: 'ok', host: 'h', username: '', password: 'p' }, '账号'],
    ['端口越界被拒', { alias: 'ok', host: 'h', username: 'u', password: 'p', port: 70000 }, '端口'],
  ]
  for (const [name, payload, expect] of cases) {
    const { envelope } = await invoke(handler, `${API_PREFIX}/save`, payload)
    check(name, envelope.ok === false && String(envelope.error.message).includes(expect), JSON.stringify(envelope))
  }
  check('校验失败不写入保险库', Object.keys(vault.hosts).length === 0, JSON.stringify(vault.hosts))
}

// —— save：口令认证 ——
{
  const vault = memoryVault()
  const handler = createVaultApi({ vault, vaultDir: VAULT_DIR, probe: async () => ({ ok: true, detail: '', notes: [] }) })
  const { envelope } = await invoke(handler, `${API_PREFIX}/save`, {
    alias: 'web', host: '192.0.2.20', port: 2222, username: 'deploy', authType: 'password', password: 'pw-from-ui', shell: 'bash',
  })
  check('口令保存成功', envelope.ok === true, JSON.stringify(envelope))
  const saved = vault.hosts.web
  check('口令写入 auth', saved.auth.type === 'password' && saved.auth.password === 'pw-from-ui', JSON.stringify(saved.auth))
  check('端口被保存', saved.port === 2222, String(saved.port))
}

// —— save：编辑时留空口令表示沿用 ——
{
  const vault = memoryVault({ demo: sampleRecord })
  const handler = createVaultApi({ vault, vaultDir: VAULT_DIR, probe: async () => ({ ok: true, detail: '', notes: [] }) })
  const { envelope } = await invoke(handler, `${API_PREFIX}/save`, {
    alias: 'demo', host: '192.0.2.10', port: 22, username: 'root', authType: 'password', password: '',
  })
  check('留空口令沿用旧值', envelope.ok === true && vault.hosts.demo.auth.password === 'stored-secret', JSON.stringify(envelope))
}

// —— save：新建时留空口令被拒 ——
{
  const vault = memoryVault()
  const handler = createVaultApi({ vault, vaultDir: VAULT_DIR, probe: async () => ({ ok: true, detail: '', notes: [] }) })
  const { envelope } = await invoke(handler, `${API_PREFIX}/save`, {
    alias: 'fresh', host: '192.0.2.30', username: 'root', authType: 'password', password: '',
  })
  check('新建缺口令被拒', envelope.ok === false, JSON.stringify(envelope))
}

// —— save：密钥认证的各种输入 ——
{
  const vault = memoryVault()
  const handler = createVaultApi({ vault, vaultDir: VAULT_DIR, probe: async () => ({ ok: true, detail: '', notes: [] }) })
  const base = { alias: 'keyed', host: '192.0.2.40', username: 'root', authType: 'key' }

  const missing = await invoke(handler, `${API_PREFIX}/save`, { ...base })
  check('密钥认证缺私钥被拒', missing.envelope.ok === false, JSON.stringify(missing.envelope))

  const publicKey = Buffer.from('ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQ user@host\n', 'utf8').toString('base64')
  const asPublic = await invoke(handler, `${API_PREFIX}/save`, { ...base, privateKeyFile: { name: 'id_rsa.pub', base64: publicKey } })
  check('上传公钥被拒', asPublic.envelope.ok === false && String(asPublic.envelope.error.message).includes('公钥'), JSON.stringify(asPublic.envelope))

  const notAKey = Buffer.from('hello world\n', 'utf8').toString('base64')
  const garbage = await invoke(handler, `${API_PREFIX}/save`, { ...base, privateKeyFile: { name: 'notes.txt', base64: notAKey } })
  check('上传非密钥文件被拒', garbage.envelope.ok === false && String(garbage.envelope.error.message).includes('PRIVATE KEY'), JSON.stringify(garbage.envelope))

  const pathOnly = await invoke(handler, `${API_PREFIX}/save`, { ...base, privateKeyPath: 'C:\\keys\\id_rsa' })
  check('仅给路径即可保存', pathOnly.envelope.ok === true, JSON.stringify(pathOnly.envelope))
  check('路径写入 auth', vault.hosts.keyed.auth.type === 'key' && vault.hosts.keyed.auth.privateKeyPath === 'C:\\keys\\id_rsa', JSON.stringify(vault.hosts.keyed?.auth))

  const withPassphrase = await invoke(handler, `${API_PREFIX}/save`, {
    ...base, privateKeyPath: 'C:\\keys\\id_rsa', passphrase: 'key-secret',
  })
  check('私钥口令被保存', withPassphrase.envelope.ok === true && vault.hosts.keyed.auth.passphrase === 'key-secret', JSON.stringify(vault.hosts.keyed?.auth))

  const ppk = Buffer.from('PuTTY-User-Key-File-3: ssh-rsa\nEncryption: none\nComment: imported\n', 'utf8').toString('base64')
  const asPpk = await invoke(handler, `${API_PREFIX}/save`, { ...base, privateKeyFile: { name: 'id_rsa.ppk', base64: ppk } })
  check('上传 .ppk 被拒并提示转换', asPpk.envelope.ok === false && String(asPpk.envelope.error.message).includes('ppk'), JSON.stringify(asPpk.envelope))

  // 关键：只搜 “PRIVATE KEY” 字样太松——普通文本里出现这几个词不该被当成私钥。
  const lookalike = Buffer.from('Here are notes: my PRIVATE KEY is somewhere else entirely.\n', 'utf8').toString('base64')
  const asLookalike = await invoke(handler, `${API_PREFIX}/save`, { ...base, privateKeyFile: { name: 'notes.txt', base64: lookalike } })
  check('只含 PRIVATE KEY 字样的文本被拒', asLookalike.envelope.ok === false, JSON.stringify(asLookalike.envelope))

  // 拼接出 PEM 头尾，源码里不出现完整的私钥标记——CI 会扫描这种字面量，而这里
  // 只是一段结构合法的占位文本，不是任何真实密钥。
  const pemHeader = ['-----BEGIN RSA', 'PRIVATE KEY-----'].join(' ')
  const pemFooter = ['-----END RSA', 'PRIVATE KEY-----'].join(' ')
  const placeholderPem = `${pemHeader}\nMIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu\n${pemFooter}\n`
  const asPem = await invoke(handler, `${API_PREFIX}/save`, {
    ...base, privateKeyFile: { name: 'id_rsa.pem', base64: Buffer.from(placeholderPem, 'utf8').toString('base64') },
  })
  check('合法的 PEM 私钥被接受', asPem.envelope.ok === true, JSON.stringify(asPem.envelope))

  // 回归：上一次上传的副本已被收紧成只读 ACL，同名再次上传必须先恢复才能覆盖。
  const rePem = await invoke(handler, `${API_PREFIX}/save`, {
    ...base, privateKeyFile: { name: 'id_rsa.pem', base64: Buffer.from(placeholderPem, 'utf8').toString('base64') },
  })
  check('同名重复上传私钥可覆盖', rePem.envelope.ok === true, JSON.stringify(rePem.envelope))
}

// —— remove / test / reveal ——
{
  const vault = memoryVault({ demo: sampleRecord })
  const probed = []
  const handler = createVaultApi({
    vault,
    vaultDir: VAULT_DIR,
    probe: async (alias) => {
      probed.push(alias)
      return { ok: true, detail: 'identity: root@demo', notes: [] }
    },
  })

  const removed = await invoke(handler, `${API_PREFIX}/remove`, { alias: 'demo' })
  check('删除存在的主机', removed.envelope.ok === true && vault.hosts.demo === undefined, JSON.stringify(removed.envelope))

  const missing = await invoke(handler, `${API_PREFIX}/remove`, { alias: 'demo' })
  check('删除不存在的主机报错', missing.envelope.ok === false, JSON.stringify(missing.envelope))

  const tested = await invoke(handler, `${API_PREFIX}/test`, { alias: 'demo' })
  check('测试不存在的主机报错', tested.envelope.ok === false, JSON.stringify(tested.envelope))

  vault.hosts.demo = sampleRecord
  const testOk = await invoke(handler, `${API_PREFIX}/test`, { alias: 'demo' })
  check('测试走 probe 回调', testOk.envelope.ok === true && probed.length === 1 && probed[0] === 'demo', JSON.stringify({ envelope: testOk.envelope, probed }))
  check('测试返回明细', testOk.envelope.value.detail.includes('identity'), JSON.stringify(testOk.envelope))

  const revealed = await invoke(handler, `${API_PREFIX}/reveal`, { alias: 'demo' })
  check('reveal 返回未脱敏的地址与账号', revealed.envelope.value.host === '192.0.2.10' && revealed.envelope.value.username === 'root', JSON.stringify(revealed.envelope))
  check('reveal 不含口令', !revealed.raw.includes('stored-secret'), revealed.raw)
}

// —— 协议层 ——
{
  const vault = memoryVault()
  const handler = createVaultApi({ vault, vaultDir: VAULT_DIR, probe: async () => ({ ok: true, detail: '', notes: [] }) })

  const wrongMethod = await invoke(handler, `${API_PREFIX}/list`, {}, 'GET')
  check('非 POST 返回 405', wrongMethod.status === 405, String(wrongMethod.status))

  const unknown = await invoke(handler, `${API_PREFIX}/nope`, {})
  check('未知操作报错', unknown.envelope.ok === false && String(unknown.envelope.error.message).includes('未知操作'), JSON.stringify(unknown.envelope))

  const nested = await invoke(handler, `${API_PREFIX}/a/b`, {})
  check('多段路径返回 404', nested.status === 404, String(nested.status))

  const badJson = fakeResponse()
  await handler({ method: 'POST', url: `${API_PREFIX}/list`, async *[Symbol.asyncIterator]() { yield Buffer.from('{not json', 'utf8') }, destroy() {} }, badJson)
  check('非法 JSON 返回 400', badJson.statusCode === 400, String(badJson.statusCode))
}

// —— openVault：永远只打开插件自己的目录 ——
{
  const vault = memoryVault()
  const opened = []
  const handler = createVaultApi({
    vault,
    vaultDir: VAULT_DIR,
    probe: async () => ({ ok: true, detail: '', notes: [] }),
    openFolder: async (target) => { opened.push(target) },
  })

  const direct = await invoke(handler, `${API_PREFIX}/openVault`, {})
  check('openVault 返回成功', direct.envelope.ok === true, JSON.stringify(direct.envelope))
  check('openVault 打开保险库目录', opened.length === 1 && opened[0] === VAULT_DIR, JSON.stringify(opened))

  // 安全性回归：请求体里的 path 必须被完全忽略，否则这就成了「按需启动本机程序」的接口。
  await invoke(handler, `${API_PREFIX}/openVault`, { path: '/etc', target: 'C:\\Windows' })
  check('openVault 忽略请求体里的路径', opened.length === 2 && opened[1] === VAULT_DIR, JSON.stringify(opened))

  const failing = createVaultApi({
    vault,
    vaultDir: VAULT_DIR,
    probe: async () => ({ ok: true, detail: '', notes: [] }),
    openFolder: async () => { throw new Error('shell unavailable') },
  })
  const failed = await invoke(failing, `${API_PREFIX}/openVault`, {})
  check('openVault 失败时报错', failed.envelope.ok === false && String(failed.envelope.error.message).includes('shell unavailable'), JSON.stringify(failed.envelope))
}

await removeVaultDir()

// —— test 必须走短超时：设置页会给每台主机自动体检，一条不通的主机不能拖住整页 ——
{
  const vault = memoryVault({ demo: sampleRecord })
  const seen = []
  const handler = createVaultApi({
    vault,
    vaultDir: VAULT_DIR,
    probe: async (alias, timeoutMs) => {
      seen.push({ alias, timeoutMs })
      return { ok: true, detail: '', notes: [] }
    },
  })
  const result = await invoke(handler, `${API_PREFIX}/test`, { alias: 'demo' })
  check('test 成功返回', result.envelope.ok === true, JSON.stringify(result.envelope))
  check('test 把短超时传给 probe', seen.length === 1 && seen[0].timeoutMs === SETTINGS_PROBE_TIMEOUT_MS, JSON.stringify(seen))
}

// —— 改名：凭据随记录搬迁，旧记录被删掉 ——
{
  const vault = memoryVault({ demo: { ...sampleRecord } })
  const handler = createVaultApi({ vault, vaultDir: VAULT_DIR, probe: async () => ({ ok: true, detail: '', notes: [] }) })

  const renamed = await invoke(handler, `${API_PREFIX}/save`, {
    alias: 'renamed', renameFrom: 'demo', host: '192.0.2.10', port: 22, username: 'root', authType: 'password', password: '',
  })
  check('改名成功', renamed.envelope.ok === true, JSON.stringify(renamed.envelope))
  check('改名后沿用原口令', vault.hosts.renamed?.auth?.password === 'stored-secret', JSON.stringify(vault.hosts.renamed?.auth))
  check('改名后旧记录已删除', vault.hosts.demo === undefined, JSON.stringify(Object.keys(vault.hosts)))

  const ghost = await invoke(handler, `${API_PREFIX}/save`, {
    alias: 'other', renameFrom: 'ghost', host: '192.0.2.10', port: 22, username: 'root', authType: 'password', password: 'x',
  })
  check('改名源不存在时报错', ghost.envelope.ok === false, JSON.stringify(ghost.envelope))

  vault.hosts.taken = { ...sampleRecord, alias: 'taken' }
  const occupied = await invoke(handler, `${API_PREFIX}/save`, {
    alias: 'taken', renameFrom: 'renamed', host: '192.0.2.10', port: 22, username: 'root', authType: 'password', password: '',
  })
  check('目标别名被占用时报错', occupied.envelope.ok === false, JSON.stringify(occupied.envelope))
  check('占用失败时不破坏原记录', vault.hosts.renamed !== undefined && vault.hosts.taken?.alias === 'taken', JSON.stringify(Object.keys(vault.hosts)))
}

// —— 语言：显式英文偏好下，用户可见的错误消息必须是英文 ——
{
  const { applyPreference, resetLocaleForTests } = await import('../lib/i18n.js')
  applyPreference('en')
  const vault = memoryVault({ demo: sampleRecord })
  const handler = createVaultApi({ vault, vaultDir: VAULT_DIR, probe: async () => ({ ok: true, detail: '', notes: [] }) })

  const unknown = await invoke(handler, `${API_PREFIX}/who-knows`, {})
  check('英文下未知操作消息为英文', String(unknown.envelope.error.message).includes('Unknown action'), JSON.stringify(unknown.envelope))

  const badPort = await invoke(handler, `${API_PREFIX}/save`, {
    alias: 'x', host: 'h', username: 'u', authType: 'password', password: 'p', port: 70000,
  })
  check('英文下端口校验消息为英文', String(badPort.envelope.error.message).includes('Port'), JSON.stringify(badPort.envelope))

  const missing = await invoke(handler, `${API_PREFIX}/test`, { alias: 'ghost' })
  check('英文下未知主机消息为英文', String(missing.envelope.error.message).includes('No host named'), JSON.stringify(missing.envelope))

  resetLocaleForTests()
}

// —— 信任栅栏：所有动作先过 requestRejection，未认证请求不接触保险库 ——
{
  const vault = memoryVault({ demo: sampleRecord })
  const rejections = []
  const handler = createVaultApi({
    vault,
    vaultDir: VAULT_DIR,
    probe: async () => ({ ok: true, detail: '', notes: [] }),
    requestRejection: (req) => {
      rejections.push(req.headers?.['x-test-reject'])
      const value = req.headers?.['x-test-reject']
      return value === '401' ? 401 : value === '403' ? 403 : undefined
    },
  })

  const unauthorized = await invoke(handler, `${API_PREFIX}/save`, {
    alias: 'x', host: 'h', username: 'u', authType: 'password', password: 'p',
  }, 'POST', { 'x-test-reject': '401' })
  check('401 请求被拒绝', unauthorized.status === 401, String(unauthorized.status))
  check('401 响应是纯文本且 no-store', unauthorized.headers?.['cache-control'] === 'no-store' && unauthorized.raw === 'unauthorized', JSON.stringify(unauthorized))
  check('401 请求没有写入保险库', Object.keys(vault.hosts).length === 1, JSON.stringify(Object.keys(vault.hosts)))

  const forbidden = await invoke(handler, `${API_PREFIX}/list`, {}, 'POST', { 'x-test-reject': '403' })
  check('403 请求被拒绝', forbidden.status === 403, String(forbidden.status))
  check('403 响应体为 forbidden', forbidden.raw === 'forbidden', forbidden.raw)

  // 顺序：信任栅栏必须先于方法检查/body 解析，否则未认证方仍能探测路由行为。
  const getRejected = await invoke(handler, `${API_PREFIX}/list`, undefined, 'GET', { 'x-test-reject': '401' })
  check('拒绝先于方法检查（GET 返回 401 而不是 405）', getRejected.status === 401, String(getRejected.status))
  const malformedRejected = await invoke(handler, `${API_PREFIX}/save`, undefined, 'POST', { 'x-test-reject': '403' })
  check('拒绝先于 body 解析', malformedRejected.status === 403, String(malformedRejected.status))

  const allowed = await invoke(handler, `${API_PREFIX}/list`, {}, 'POST', {})
  check('未被拒绝的请求照常处理', allowed.status === 200 && allowed.envelope?.ok === true, JSON.stringify(allowed))
  check('每个请求都问过信任栅栏', rejections.length === 5, String(rejections.length))
}

console.log(`${passed} 项通过，${failures.length} 项失败`)
for (const failure of failures) console.error(`FAIL: ${failure}`)
if (failures.length > 0) process.exit(1)
console.log('全部通过')
