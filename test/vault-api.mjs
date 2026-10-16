/**
 * 单元回归：设置界面 API 的校验、脱敏与响应形状。
 *
 * 不需要真实主机，也不需要 HTTP 服务器——用最小的 req/res 替身驱动真正的路由处理器，
 * 所以整条请求路径（方法检查、路径解析、body 解析、分发、envelope）都被覆盖到。
 *
 * 运行：node test/vault-api.mjs
 */
import { API_PREFIX, createVaultApi } from '../lib/vault-api.js'

let passed = 0
const failures = []
function check(name, condition, detail) {
  if (condition) {
    passed += 1
    return
  }
  failures.push(`${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

/** 最小的请求替身：异步可迭代，提供 method/url/destroy。 */
function fakeRequest(url, body, method = 'POST') {
  const payload = Buffer.from(body === undefined ? '{}' : JSON.stringify(body), 'utf8')
  return {
    method,
    url,
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
async function invoke(handler, url, body, method) {
  const res = fakeResponse()
  await handler(fakeRequest(url, body, method), res)
  let parsed
  try {
    parsed = JSON.parse(res.body)
  } catch {
    parsed = undefined
  }
  return { status: res.statusCode, envelope: parsed, raw: res.body }
}

// —— list：脱敏且永不返回口令 ——
{
  const vault = memoryVault({ demo: sampleRecord })
  const handler = createVaultApi({ vault, vaultDir: '/tmp/vault', probe: async () => ({ ok: true, detail: '', notes: [] }) })
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
  const handler = createVaultApi({ vault, vaultDir: '/tmp/vault', probe: async () => ({ ok: true, detail: '', notes: [] }) })
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
  const handler = createVaultApi({ vault, vaultDir: '/tmp/vault', probe: async () => ({ ok: true, detail: '', notes: [] }) })
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
  const handler = createVaultApi({ vault, vaultDir: '/tmp/vault', probe: async () => ({ ok: true, detail: '', notes: [] }) })
  const { envelope } = await invoke(handler, `${API_PREFIX}/save`, {
    alias: 'demo', host: '192.0.2.10', port: 22, username: 'root', authType: 'password', password: '',
  })
  check('留空口令沿用旧值', envelope.ok === true && vault.hosts.demo.auth.password === 'stored-secret', JSON.stringify(envelope))
}

// —— save：新建时留空口令被拒 ——
{
  const vault = memoryVault()
  const handler = createVaultApi({ vault, vaultDir: '/tmp/vault', probe: async () => ({ ok: true, detail: '', notes: [] }) })
  const { envelope } = await invoke(handler, `${API_PREFIX}/save`, {
    alias: 'fresh', host: '192.0.2.30', username: 'root', authType: 'password', password: '',
  })
  check('新建缺口令被拒', envelope.ok === false, JSON.stringify(envelope))
}

// —— save：密钥认证的各种输入 ——
{
  const vault = memoryVault()
  const handler = createVaultApi({ vault, vaultDir: '/tmp/vault', probe: async () => ({ ok: true, detail: '', notes: [] }) })
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
}

// —— remove / test / reveal ——
{
  const vault = memoryVault({ demo: sampleRecord })
  const probed = []
  const handler = createVaultApi({
    vault,
    vaultDir: '/tmp/vault',
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
  const handler = createVaultApi({ vault, vaultDir: '/tmp/vault', probe: async () => ({ ok: true, detail: '', notes: [] }) })

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

console.log(`${passed} 项通过，${failures.length} 项失败`)
for (const failure of failures) console.error(`FAIL: ${failure}`)
if (failures.length > 0) process.exit(1)
console.log('全部通过')
