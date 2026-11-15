/**
 * 兼容层回归：识别 `dsh-vm-control`、校验契约、处理别名冲突与失败降级。
 *
 * 这一组测试不启动 Host，也不需要 VMware：发现动作只读文件与 ESM 导出，导入动作写的是
 * 内存里的假保险库。真实插件的目录就在仓库里，所以「能识别」这条结论是真的；坏掉的
 * 插件用临时目录伪造，覆盖清单损坏、版本越界、入口缺失、import 抛错等失败路径。
 *
 * 运行：node test/vm-control-compat.mjs
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  SSH_NAMESPACE,
  VM_CONTROL_NAME,
  VM_CONTROL_SUPPORTED_RANGE,
  VM_IMPORT_ALIAS_POLICIES,
  candidateDirs,
  compareVersions,
  createVmControlCompat,
  parseVersion,
  probeVmControl,
  rangeLabel,
  renderStatus,
  satisfiesRange,
} from '../lib/vm-control-compat.js'
import { API_PREFIX, createVaultApi } from '../lib/vault-api.js'
import { applyPreference, resetLocaleForTests } from '../lib/i18n.js'

let passed = 0
const failures = []
function check(name, condition, detail) {
  if (condition) {
    passed += 1
    return
  }
  failures.push(`${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

/** 最小内存保险库：与 `Vault` 的 `list/get/put/remove` 形状一致。 */
function memoryStore(seed = []) {
  const map = new Map(seed.map((record) => [record.alias, record]))
  return {
    map,
    async list() { return [...map.values()] },
    async get(alias) { return map.get(alias) },
    async put(record) { map.set(record.alias, record); return record },
    async remove(alias) { return map.delete(alias) },
  }
}

const REAL_SERVICES = () => ({ tools: true, webServer: true, commands: true, settings: true })

const roots = []

/**
 * 在临时目录里伪造一个插件。
 * @param options - 覆盖清单与入口内容。
 * @returns 插件目录。
 */
async function fakePlugin({
  version = '1.0.0',
  name = VM_CONTROL_NAME,
  entry = "export const name = 'vm-control'\nexport const inject = ['tools']\nexport function apply() {}\n",
  manifest = {},
  dirName = VM_CONTROL_NAME,
} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-vm-compat-'))
  roots.push(root)
  const dir = path.join(root, dirName)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({
    name,
    version,
    type: 'module',
    exports: { '.': './index.js' },
    engines: { node: '>=20' },
    ...manifest,
  }))
  if (entry !== null) await writeFile(path.join(dir, 'index.js'), entry)
  return dir
}

// —— 版本工具 ——
check('解析版本', JSON.stringify(parseVersion('v1.2.3-beta')) === JSON.stringify([1, 2, 3]), JSON.stringify(parseVersion('v1.2.3-beta')))
check('解析非法版本', parseVersion('abc') === undefined)
check('版本比较', compareVersions('1.1.0', '1.0.9') > 0 && compareVersions('1.0.0', '1.0.0') === 0)
check('兼容区间含边界', satisfiesRange('1.0.0') && satisfiesRange('1.99.0'))
check('兼容区间排除 2.0', !satisfiesRange('2.0.0'))
check('区间说明', rangeLabel() === `>=${VM_CONTROL_SUPPORTED_RANGE.min} <${VM_CONTROL_SUPPORTED_RANGE.max}`, rangeLabel())

// —— 候选目录 ——
const explicitOnly = candidateDirs({ dir: 'C:\\vms\\dsh-vm-control', packageRoot: 'C:\\plugins\\dsh-ssh-vault', searchRoots: ['C:\\extra'] })
check('显式目录是排他的', explicitOnly.length === 1 && explicitOnly[0].toLowerCase().endsWith('dsh-vm-control'), explicitOnly.join(' | '))
const candidates = candidateDirs({ packageRoot: 'C:\\plugins\\dsh-ssh-vault', searchRoots: ['C:\\extra'] })
check('搜索根会被补上包名', candidates.some((item) => item.toLowerCase() === 'c:\\extra\\dsh-vm-control'), candidates.join(' | '))
check('候选目录去重', new Set(candidates.map((item) => item.toLowerCase())).size === candidates.length, candidates.join(' | '))

// —— 识别仓库里真实的 dsh-vm-control ——
const realRaw = await probeVmControl({})
check('识别到真实插件', realRaw.found === true, JSON.stringify(realRaw.issues))
check('读到版本 1.x', typeof realRaw.version === 'string' && realRaw.version.startsWith('1.'), String(realRaw.version))
check('入口导出 apply 与 inject', realRaw.moduleExports?.ok === true
  && realRaw.moduleExports.exports.hasApply === true
  && realRaw.moduleExports.exports.inject.includes('tools'), JSON.stringify(realRaw.moduleExports))
check('真实插件没有契约问题', realRaw.issues.length === 0, JSON.stringify(realRaw.issues))

const realStatus = renderStatus(realRaw, { services: REAL_SERVICES() })
check('状态 ready', realStatus.state === 'ready', realStatus.state)
check('导入可用', realStatus.importReady === true)
check('命名空间互不重叠', realStatus.namespaces.disjoint === true, JSON.stringify(realStatus.namespaces.collisions))
check('工具前缀不同', realStatus.namespaces.theirs.toolPrefix !== SSH_NAMESPACE.toolPrefix)
check('边界声明：不激活对方插件', realStatus.boundary.activatesPlugin === false)
check('边界声明：不注册对方工具', realStatus.boundary.registersPluginTools === false)
check('边界声明：接受字段白名单', Array.isArray(realStatus.boundary.acceptedFields) && realStatus.boundary.acceptedFields.includes('vmx'))
check('加载顺序声明为独立', realStatus.loadOrder === 'independent')
check('中文状态消息可读', realStatus.message.includes(VM_CONTROL_NAME) && realStatus.message.includes(realRaw.version), realStatus.message)

// —— 可选服务缺失只提示、不阻断 ——
const noWeb = renderStatus(realRaw, {
  services: { tools: true, webServer: false, commands: false, settings: false },
})
check('缺 webServer 仍是 ready', noWeb.state === 'ready', noWeb.state)
check('可选服务缺失有提示', noWeb.issues.some((issue) => issue.code === 'service-missing' && issue.severity === 'info'), JSON.stringify(noWeb.issues))
check('缺失服务被列出', noWeb.services.missing.includes('webServer'), JSON.stringify(noWeb.services))

// —— 失败路径：显式目录不存在 ——
const missingDir = path.join(tmpdir(), `dsh-vm-compat-missing-${process.pid}`)
const missing = await probeVmControl({ dir: missingDir })
check('目录缺失时 found=false', missing.found === false)
check('目录缺失给出 dir-missing', missing.issues.some((issue) => issue.code === 'dir-missing'), JSON.stringify(missing.issues))
const missingStatus = renderStatus(missing, { services: REAL_SERVICES() })
check('目录缺失是 unavailable', missingStatus.state === 'unavailable', missingStatus.state)
check('目录缺失消息带原因', missingStatus.message.includes('不存在'), missingStatus.message)

// —— 失败路径：清单不是 JSON ——
const brokenRoot = await mkdtemp(path.join(tmpdir(), 'dsh-vm-compat-broken-'))
roots.push(brokenRoot)
const brokenDir = path.join(brokenRoot, VM_CONTROL_NAME)
await mkdir(brokenDir, { recursive: true })
await writeFile(path.join(brokenDir, 'package.json'), '{ not json')
const broken = await probeVmControl({ dir: brokenDir })
check('坏清单被报出', broken.issues.some((issue) => issue.code === 'manifest-unreadable'), JSON.stringify(broken.issues))

// —— 失败路径：包名不符 ——
const wrongNameDir = await fakePlugin({ name: 'something-else' })
const wrongName = await probeVmControl({ dir: wrongNameDir })
check('包名不符被拒绝', wrongName.found === false && wrongName.issues.some((issue) => issue.code === 'name-mismatch'), JSON.stringify(wrongName.issues))

// —— 失败路径：版本越界 ——
const futureDir = await fakePlugin({ version: '2.0.0' })
const future = await probeVmControl({ dir: futureDir })
check('2.0 被拒绝自动对接', future.issues.some((issue) => issue.code === 'version-unsupported'), JSON.stringify(future.issues))
const futureStatus = renderStatus(future, { services: REAL_SERVICES() })
check('版本越界是 incompatible', futureStatus.state === 'incompatible', futureStatus.state)
check('版本越界不可导入', futureStatus.importReady === false)

// —— 失败路径：入口缺失 / 导出不全 / import 抛错 ——
const noEntryDir = await fakePlugin({ entry: null })
const noEntry = await probeVmControl({ dir: noEntryDir })
check('入口缺失被报出', noEntry.issues.some((issue) => issue.code === 'entry-missing'), JSON.stringify(noEntry.issues))

const noApplyDir = await fakePlugin({ entry: "export const name = 'vm-control'\nexport const inject = ['tools']\n" })
const noApply = await probeVmControl({ dir: noApplyDir })
check('缺 apply 被报出', noApply.issues.some((issue) => issue.code === 'missing-apply'), JSON.stringify(noApply.issues))

const noInjectDir = await fakePlugin({ entry: "export const name = 'vm-control'\nexport function apply() {}\n" })
const noInject = await probeVmControl({ dir: noInjectDir })
check('缺 inject tools 被报出', noInject.issues.some((issue) => issue.code === 'missing-tools-inject'), JSON.stringify(noInject.issues))

const cjsDir = await fakePlugin({ manifest: { type: 'commonjs' } })
// 已知 CommonJS 时不 import：Node 会先打印一条 ESM 警告，而结论（not-esm）只看清单就够了。
const cjs = await probeVmControl({ dir: cjsDir, probeModule: false })
check('CommonJS 插件被拒绝', cjs.issues.some((issue) => issue.code === 'not-esm'), JSON.stringify(cjs.issues))

const oldNodeDir = await fakePlugin({ manifest: { engines: { node: '>=99' } } })
const oldNode = await probeVmControl({ dir: oldNodeDir })
check('Node 版本不满足被报出', oldNode.issues.some((issue) => issue.code === 'node-unsupported'), JSON.stringify(oldNode.issues))

const throwingDir = await fakePlugin({ entry: "throw new Error('boom-on-import')\n" })
const throwing = await probeVmControl({ dir: throwingDir })
check('import 失败被捕获', throwing.issues.some((issue) => issue.code === 'module-load-failed'), JSON.stringify(throwing.issues))
check('import 失败保留原始消息', throwing.issues.some((issue) => String(issue.params?.message).includes('boom-on-import')))

// —— 多份副本：告警而不是崩溃 ——
const copyA = await fakePlugin()
const copyB = await fakePlugin()
const duplicated = await probeVmControl({ searchRoots: [copyA, copyB], packageRoot: '' })
check('发现多份副本', duplicated.duplicates?.length >= 1, JSON.stringify(duplicated.duplicates))
check('多副本给出 duplicate-install', duplicated.issues.some((issue) => issue.code === 'duplicate-install'), JSON.stringify(duplicated.issues))
const duplicatedStatus = renderStatus(duplicated, { services: REAL_SERVICES() })
check('多副本降级但仍可导入', duplicatedStatus.state === 'degraded' && duplicatedStatus.importReady === true, duplicatedStatus.state)

// —— 导入：正常路径与幂等 ——
const store = memoryStore()
const compat = createVmControlCompat({ store, serviceProbe: REAL_SERVICES })
const payload = {
  alias: 'kali-linux',
  host: '192.0.2.10',
  port: 22,
  username: 'root',
  shell: 'bash',
  description: '软件安全kali · VMware',
  tags: ['vmware', 'lab'],
  authType: 'password',
  password: 's3cret-pass',
  vmx: 'E:\\VMs\\kali\\kali.vmx',
}
const first = await compat.importHost(payload)
check('首次导入成功', first.value?.created === true && first.value.alias === 'kali-linux', JSON.stringify(first))
check('记录来源被标记', first.value?.source?.plugin === VM_CONTROL_NAME && first.value.source.ref === payload.vmx, JSON.stringify(first.value?.source))
check('结果不包含口令', !JSON.stringify(first).includes('s3cret-pass'), JSON.stringify(first))
const stored = await store.get('kali-linux')
check('保险库记录带来源', stored?.source?.plugin === VM_CONTROL_NAME && stored.source.ref === payload.vmx, JSON.stringify(stored?.source))
check('保险库记录保留标签', JSON.stringify(stored?.tags) === JSON.stringify(['vmware', 'lab']), JSON.stringify(stored?.tags))
check('保险库记录保存口令', stored?.auth?.type === 'password' && stored.auth.password === 's3cret-pass')

const second = await compat.importHost({ ...payload, password: 'next-pass' })
check('同别名同虚拟机是更新', second.value?.updated === true && second.value.created === false, JSON.stringify(second))
check('更新后只有一条记录', store.map.size === 1, String(store.map.size))
check('更新覆盖口令', (await store.get('kali-linux')).auth.password === 'next-pass')

const renamed = await compat.importHost({ ...payload, alias: 'kali-linux-2' })
check('同虚拟机换别名被拒绝', renamed.code === 'already-imported', JSON.stringify(renamed))
check('拒绝时给出已有别名', renamed.details?.alias === 'kali-linux', JSON.stringify(renamed.details))

// —— 导入：别名冲突与策略 ——
const conflictStore = memoryStore([{
  alias: 'kali-linux',
  host: '192.0.2.9',
  port: 22,
  username: 'root',
  auth: { type: 'password', password: 'manual-secret' },
  sudoPassword: 'sudo-secret',
  credentialRef: 'manual-ref',
  bindAddress: '192.0.2.200',
}])
const conflicts = createVmControlCompat({ store: conflictStore, serviceProbe: REAL_SERVICES })
const conflict = await conflicts.importHost(payload)
check('同名他源记录默认拒绝', conflict.code === 'alias-conflict', JSON.stringify(conflict))
check('冲突给出候选别名', Array.isArray(conflict.details?.suggestions) && conflict.details.suggestions[0] === 'kali-linux-2', JSON.stringify(conflict.details))
check('冲突时没有写入', conflictStore.map.size === 1)
check('冲突消息不含既有口令', !JSON.stringify(conflict).includes('manual-secret') && !JSON.stringify(conflict).includes('sudo-secret'))

const suffixed = await conflicts.importHost({ ...payload, aliasPolicy: 'suffix' })
check('suffix 策略新建别名', suffixed.value?.alias === 'kali-linux-2' && suffixed.value.created === true, JSON.stringify(suffixed))
check('suffix 不删除原有主机', conflictStore.map.has('kali-linux'))
check('suffix 给出说明', suffixed.value?.warnings?.some((warning) => warning.code === 'suffixed'), JSON.stringify(suffixed.value?.warnings))

const noConfirm = await conflicts.importHost({ ...payload, aliasPolicy: 'overwrite' })
check('overwrite 缺 confirm 被拒绝', noConfirm.code === 'alias-conflict', JSON.stringify(noConfirm))

const overwritten = await conflicts.importHost({ ...payload, aliasPolicy: 'overwrite', confirm: true })
check('overwrite + confirm 成功', overwritten.value?.overwritten === true, JSON.stringify(overwritten))
const replaced = await conflictStore.get('kali-linux')
check('覆盖后地址更新', replaced.host === '192.0.2.10', replaced.host)
check('覆盖不沿用 sudo 口令', replaced.sudoPassword === undefined, JSON.stringify(replaced.sudoPassword))
check('覆盖不沿用凭据引用', replaced.credentialRef === undefined, JSON.stringify(replaced.credentialRef))
check('覆盖不沿用绑定地址', replaced.bindAddress === undefined, JSON.stringify(replaced.bindAddress))
check('覆盖删除了旧来源别名', !conflictStore.map.has('kali-linux-2'), [...conflictStore.map.keys()].join(','))
check('覆盖给出说明', overwritten.value?.warnings?.some((warning) => warning.code === 'overwrote-foreign' || warning.code === 'replaced-source'), JSON.stringify(overwritten.value?.warnings))

const disabledOverwrite = createVmControlCompat({
  store: memoryStore([{ alias: 'kali-linux', host: '192.0.2.9', port: 22, username: 'root', auth: { type: 'password', password: 'x' } }]),
  serviceProbe: REAL_SERVICES,
  allowOverwrite: false,
})
const blocked = await disabledOverwrite.importHost({ ...payload, aliasPolicy: 'overwrite', confirm: true })
check('allowOverwrite=false 时拒绝覆盖', blocked.code === 'alias-conflict', JSON.stringify(blocked))

// —— 导入：字段校验 ——
const validationStore = memoryStore()
const validating = createVmControlCompat({ store: validationStore, serviceProbe: REAL_SERVICES })
for (const [label, override, code] of [
  ['非法别名', { alias: '软件安全' }, 'invalid-alias'],
  ['缺地址', { host: '' }, 'missing-host'],
  ['缺账号', { username: '' }, 'missing-username'],
  ['端口越界', { port: 70000 }, 'invalid-port'],
  ['缺口令', { password: '' }, 'missing-password'],
  ['私钥缺路径', { authType: 'key', password: undefined }, 'missing-key'],
  ['非法策略', { aliasPolicy: 'merge' }, 'bad-policy'],
]) {
  const result = await validating.importHost({ ...payload, ...override })
  check(`字段校验：${label}`, result.code === code, `${result.code} / ${result.error}`)
}
check('校验失败不写入', validationStore.map.size === 0, String(validationStore.map.size))

const inheritedStore = memoryStore()
const inheriting = createVmControlCompat({ store: inheritedStore, serviceProbe: REAL_SERVICES })
await inheriting.importHost(payload)
const inherited = await inheriting.importHost({ ...payload, password: undefined })
check('留空口令时沿用旧口令', inherited.value?.updated === true
  && inherited.value.warnings.some((warning) => warning.code === 'password-inherited'), JSON.stringify(inherited))

// —— 兼容层不可用 / 关闭时的降级 ——
const unavailable = createVmControlCompat({
  packageRoot: path.join(tmpdir(), `dsh-vm-compat-empty-${process.pid}`),
  store: memoryStore(),
  serviceProbe: REAL_SERVICES,
})
const unavailableStatus = await unavailable.status()
check('找不到插件时状态 unavailable', unavailableStatus.state === 'unavailable', unavailableStatus.state)
const unavailableImport = await unavailable.importHost(payload)
check('找不到插件时导入被拒绝', unavailableImport.code === 'compat-unavailable', JSON.stringify(unavailableImport))
check('拒绝消息说明降级路径', String(unavailableImport.error).includes('手工添加'), String(unavailableImport.error))
check('找不到插件时状态消息可读', unavailableStatus.message.includes(VM_CONTROL_NAME), unavailableStatus.message)

const disabled = createVmControlCompat({ enabled: false, packageRoot: tmpdir(), store: memoryStore() })
const disabledStatus = await disabled.status()
check('关闭时状态 disabled', disabledStatus.state === 'disabled', disabledStatus.state)
check('关闭时导入被拒绝', (await disabled.importHost(payload)).code === 'compat-disabled')

// —— 设置接口：新增动作是纯增量 ——
const apiStore = memoryStore([{
  alias: 'manual',
  host: '192.0.2.20',
  port: 22,
  username: 'root',
  auth: { type: 'password', password: 'keep-me' },
}])
const apiCompat = createVmControlCompat({ store: apiStore, serviceProbe: REAL_SERVICES })
const api = createVaultApi({
  vault: apiStore,
  vaultDir: path.join(tmpdir(), 'dsh-vm-compat-vault'),
  probe: async () => ({ ok: true, detail: '', notes: [] }),
  vmCompat: apiCompat,
})

/**
 * 调一次设置接口。
 * @param action - 路由末段。
 * @param body - 请求体。
 * @returns 解析后的 envelope 与状态码。
 */
async function callApi(action, body) {
  const captured = { status: 0, body: '' }
  const res = {
    writeHead(status) { captured.status = status },
    end(chunk) { captured.body = chunk ?? '' },
  }
  const text = Buffer.from(JSON.stringify(body ?? {}), 'utf8')
  await api({
    method: 'POST',
    url: `${API_PREFIX}/${action}`,
    headers: {},
    async *[Symbol.asyncIterator]() { yield text },
    destroy() {},
  }, res)
  let envelope
  try {
    envelope = JSON.parse(captured.body)
  } catch {
    envelope = undefined
  }
  return { status: captured.status, envelope }
}

const statusResponse = await callApi('vmStatus', {})
check('vmStatus 返回 ready', statusResponse.envelope?.value?.state === 'ready', JSON.stringify(statusResponse.envelope))
const refreshResponse = await callApi('vmStatus', { refresh: true })
check('vmStatus 支持 refresh', refreshResponse.envelope?.value?.cached === false, JSON.stringify(refreshResponse.envelope?.value?.cached))

const importResponse = await callApi('vmImport', { ...payload, alias: 'imported-vm' })
check('vmImport 写入成功', importResponse.envelope?.ok === true && importResponse.envelope.value.alias === 'imported-vm', JSON.stringify(importResponse.envelope))
check('vmImport 不泄露口令', !JSON.stringify(importResponse.envelope).includes('s3cret-pass'), JSON.stringify(importResponse.envelope))

const conflictResponse = await callApi('vmImport', {
  ...payload,
  alias: 'manual',
  vmx: 'E:\\VMs\\other\\other.vmx',
  host: '192.0.2.31',
})
check('vmImport 冲突返回结构化错误', conflictResponse.envelope?.ok === false
  && conflictResponse.envelope.error.code === 'alias-conflict'
  && Array.isArray(conflictResponse.envelope.error.details?.suggestions), JSON.stringify(conflictResponse.envelope))

const listResponse = await callApi('list', {})
check('list 附带兼容状态', listResponse.envelope?.value?.vmControl?.state === 'ready', JSON.stringify(listResponse.envelope?.value?.vmControl))
check('list 仍保留原有字段', Array.isArray(listResponse.envelope?.value?.hosts)
  && typeof listResponse.envelope.value.version === 'string'
  && typeof listResponse.envelope.value.vaultDir === 'string', JSON.stringify(Object.keys(listResponse.envelope?.value ?? {})))

// 原有保存接口的语义不变：同名即更新，不参与兼容层的冲突策略。
const saveResponse = await callApi('save', {
  alias: 'manual', host: '192.0.2.21', port: 2222, username: 'root', authType: 'password',
})
check('原有 save 仍按同名更新', saveResponse.envelope?.ok === true && saveResponse.envelope.value.alias === 'manual', JSON.stringify(saveResponse.envelope))
check('原有 save 改写了地址', (await apiStore.get('manual')).host === '192.0.2.21')
check('原有 save 保留口令', (await apiStore.get('manual')).auth.password === 'keep-me')

// 没有兼容层时，新动作给出明确错误，list 不出现附加字段（老组合的响应形状不变）。
const plainApi = createVaultApi({
  vault: memoryStore(),
  vaultDir: path.join(tmpdir(), 'dsh-vm-compat-plain'),
  probe: async () => ({ ok: true, detail: '', notes: [] }),
})
const plainList = { status: 0, body: '' }
await plainApi({
  method: 'POST',
  url: `${API_PREFIX}/list`,
  headers: {},
  async *[Symbol.asyncIterator]() { yield Buffer.from('{}', 'utf8') },
  destroy() {},
}, { writeHead(status) { plainList.status = status }, end(chunk) { plainList.body = chunk ?? '' } })
const plainEnvelope = JSON.parse(plainList.body)
check('无兼容层时 list 形状不变', plainEnvelope.ok === true && plainEnvelope.value.vmControl === undefined, JSON.stringify(Object.keys(plainEnvelope.value ?? {})))
const plainStatus = { status: 0, body: '' }
await plainApi({
  method: 'POST',
  url: `${API_PREFIX}/vmStatus`,
  headers: {},
  async *[Symbol.asyncIterator]() { yield Buffer.from('{}', 'utf8') },
  destroy() {},
}, { writeHead(status) { plainStatus.status = status }, end(chunk) { plainStatus.body = chunk ?? '' } })
const plainStatusEnvelope = JSON.parse(plainStatus.body)
check('无兼容层时 vmStatus 明确失败', plainStatusEnvelope.ok === false && plainStatusEnvelope.error.code === 'compat-disabled', JSON.stringify(plainStatusEnvelope))

// —— 语言切换：状态消息跟随界面语言 ——
resetLocaleForTests()
applyPreference('en')
const englishStatus = await compat.status()
check('英文状态消息', englishStatus.message.includes('Recognized'), englishStatus.message)
const englishConflict = await compat.importHost({
  ...payload,
  alias: 'kali-linux',
  vmx: 'E:\\VMs\\other\\other.vmx',
  host: '192.0.2.30',
})
check('英文冲突消息', String(englishConflict.error).includes('already used by'), String(englishConflict.error))
resetLocaleForTests()

check('策略集合稳定', VM_IMPORT_ALIAS_POLICIES.join(',') === 'reuse,suffix,overwrite', VM_IMPORT_ALIAS_POLICIES.join(','))

for (const root of roots) {
  try {
    await rm(root, { recursive: true, force: true })
  } catch {
    // 临时目录清理失败不影响结论。
  }
}

console.log(`${passed} 项通过，${failures.length} 项失败`)
for (const failure of failures) console.error(`FAIL: ${failure}`)
if (failures.length > 0) process.exit(1)
console.log('全部通过')
