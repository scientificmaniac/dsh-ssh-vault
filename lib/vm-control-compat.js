/**
 * 与同目录下的 `dsh-vm-control` 插件的兼容层。
 *
 * 为什么需要一层「兼容」而不是直接 `import` 对方的 `apply`：
 * `dsh-vm-control` 是一个独立的 DSH 插件，由宿主的 Loader 行（`dsh.bundle.patch`）激活。
 * 本插件若再调用一次它的 `apply`，工具名（`vm_*`）、路由前缀（`/vm-control`）与 `/vm`
 * 命令都会被**重复注册**——那是最典型的一类加载冲突，而且报错发生在宿主的注册表里，
 * 用户看到的只是一句「工具已存在」。所以这里的边界是明确的：
 *
 * - **只识别、不激活**：读它的 `package.json`、校验入口模块的导出形状、按需 `import()`
 *   一次以验证「能加载」，但从不调用 `apply`，也从不注册它的任何工具 / 路由 / 命令。
 * - **只对接一条接口**：把虚拟机侧整理好的 SSH 字段（`host`/`port`/`username`/认证信息）
 *   写进本插件自己的保险库。写入只经过本插件的加密路径，对方拿不到密钥材料。
 * - **失败只降级、不连坐**：兼容层任何一步失败都只让 `vmStatus` / `vmImport` 返回一条
 *   可读的错误；`ssh_hosts`、`ssh_run`、`ssh-transfer`、`/hosts`、设置页与原来的
 *   `ssh-vault/save` 全部照旧工作。
 *
 * 加载顺序因此是无所谓的：本层不做任何「等对方先加载」的假设。发现动作在第一次被
 * 查询时才发生（惰性），并带 TTL 缓存；先装本插件、后装虚拟机插件也能在下次查询时
 * 认出来，不需要重启 DSH。
 *
 * @module dsh-ssh-vault/vm-control-compat
 */

import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { t } from './i18n.js'

/** 目标插件的包名，同时是 Loader 行 id 的来源。 */
export const VM_CONTROL_NAME = 'dsh-vm-control'
/** 目标插件在宿主里的 Loader id（`cordis.patch.yml` 中声明）。 */
export const VM_CONTROL_PLUGIN_ID = 'vm-control'
/** 目标插件的入口文件名（`exports['.']` 缺失时的回退）。 */
export const VM_CONTROL_ENTRY = 'index.js'
/** 目标插件的 API 前缀。 */
export const VM_CONTROL_API_PREFIX = '/vm-control'
/** 目标插件注册的对话命令。 */
export const VM_CONTROL_COMMAND = 'vm'
/** 目标插件注册的工具名前缀。 */
export const VM_CONTROL_TOOL_PREFIX = 'vm_'

/**
 * 兼容的版本区间：`[min, max)`。
 *
 * 只承诺 1.x：`vmImport` 依赖的字段契约（`alias`/`host`/`port`/`username`/`authType`/
 * `password`/`privateKeyPath`/`passphrase`/`tags`）在 1.x 里稳定；2.0 如果改动契约，
 * 应当由作者显式提升这里的区间，而不是让本插件猜。
 */
export const VM_CONTROL_SUPPORTED_RANGE = Object.freeze({ min: '1.0.0', max: '2.0.0' })

/** 本插件占用的命名空间，用于兼容性审计。 */
export const SSH_NAMESPACE = Object.freeze({
  pluginId: 'ssh-vault',
  toolPrefix: 'ssh_',
  tools: Object.freeze(['ssh_hosts', 'ssh_run', 'ssh_transfer', 'ssh_probe', 'ssh_tunnel']),
  apiPrefix: '/ssh-vault',
  command: 'hosts',
})

/**
 * 1.x 目标插件声明的工具名。
 *
 * 这是一份**契约快照**，不是从对方源码里扫出来的：扫描源码对压缩/重构很脆，
 * 而命名空间冲突只需要知道「前缀是否重叠」。区间之外的版本本来就会被拒绝。
 */
const VM_CONTROL_TOOLS_1X = Object.freeze(['vm_list', 'vm_power', 'vm_snapshot', 'vm_config'])

/** `vmImport` 接受的别名冲突策略。 */
export const VM_IMPORT_ALIAS_POLICIES = Object.freeze(['reuse', 'suffix', 'overwrite'])

/**
 * `vmImport` 接受的字段白名单。
 *
 * 与 `dsh-vm-control` 的 `SSH_VAULT_SAVE_FIELDS` 一致，外加三个兼容层自用字段：
 * `vmx`（虚拟机身份，用于幂等）、`aliasPolicy`、`confirm`。别的字段一律忽略，
 * 尤其是 `sudoPassword` / `credentialRef` —— 那些属于用户在主机的编辑表单里做的决定，
 * 不该由一次「导入」代劳。
 */
export const VM_IMPORT_FIELDS = Object.freeze([
  'alias',
  'host',
  'port',
  'username',
  'shell',
  'description',
  'tags',
  'authType',
  'password',
  'privateKeyPath',
  'passphrase',
  'vmx',
  'aliasPolicy',
  'confirm',
])

/** 本插件自己的包根目录（`lib/` 的上一级）。 */
export function defaultPackageRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
}

/**
 * 解析 `x.y.z`（容忍前缀 `v` 与 `-prerelease` 后缀）。
 * @param value - 版本字符串。
 * @returns `[major, minor, patch]`；无法解析时为 `undefined`。
 */
export function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(value ?? '').trim())
  return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])]
}

/**
 * 比较两个版本。
 * @param left - 版本字符串。
 * @param right - 版本字符串。
 * @returns 负数 / 0 / 正数；无法解析时按 0 处理。
 */
export function compareVersions(left, right) {
  const a = parseVersion(left) ?? [0, 0, 0]
  const b = parseVersion(right) ?? [0, 0, 0]
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index]
  }
  return 0
}

/**
 * 版本是否落在 `[min, max)` 内。
 * @param version - 版本字符串。
 * @param range - 区间；默认 {@link VM_CONTROL_SUPPORTED_RANGE}。
 * @returns 在区间内为 true。
 */
export function satisfiesRange(version, range = VM_CONTROL_SUPPORTED_RANGE) {
  if (parseVersion(version) === undefined) return false
  return compareVersions(version, range.min) >= 0 && compareVersions(version, range.max) < 0
}

/**
 * 把区间渲染成人类可读的字符串。
 * @param range - 区间。
 * @returns 形如 `>=1.0.0 <2.0.0`。
 */
export function rangeLabel(range = VM_CONTROL_SUPPORTED_RANGE) {
  return `>=${range.min} <${range.max}`
}

/**
 * 生成候选目录：显式配置 → 搜索根 → 包根与其相邻目录。
 *
 * 覆盖三种真实布局：随包一起放置（`<root>/dsh-vm-control`）、并列克隆
 * （`<root>/../dsh-vm-control`）、以及带 `-main` 后缀的源码检出
 * （`<root>/../dsh-vm-control-main/dsh-vm-control-main`）。
 *
 * @param options - 配置。
 * @param options.dir - 显式目录。
 * @param options.packageRoot - 本插件包根。
 * @param options.searchRoots - 额外搜索根（每个根下找同名目录）。
 * @returns 去重后的绝对路径数组（保持优先级顺序）。
 */
export function candidateDirs({ dir, packageRoot = defaultPackageRoot(), searchRoots = [] } = {}) {
  const list = []
  const explicit = typeof dir === 'string' && dir.trim().length > 0 ? path.resolve(dir.trim()) : ''
  // 显式配置是**排他**的：用户点名了一个目录，就不该在它坏掉时悄悄启用别处的副本。
  // 否则「我明明指向 A，跑起来的却是 B」会变成一类无法解释的行为。
  if (explicit.length > 0) return [explicit]
  for (const root of Array.isArray(searchRoots) ? searchRoots : []) {
    if (typeof root !== 'string' || root.trim().length === 0) continue
    const absolute = path.resolve(root.trim())
    // 既能传「插件目录本身」，也能传「装着插件的父目录」。
    list.push(path.basename(absolute).toLowerCase() === VM_CONTROL_NAME ? absolute : path.join(absolute, VM_CONTROL_NAME))
  }
  if (typeof packageRoot === 'string' && packageRoot.length > 0) {
    const root = path.resolve(packageRoot)
    const parent = path.resolve(root, '..')
    list.push(
      path.join(root, VM_CONTROL_NAME),
      path.join(root, VM_CONTROL_NAME, VM_CONTROL_NAME),
      path.join(parent, VM_CONTROL_NAME),
      path.join(parent, `${VM_CONTROL_NAME}-main`, VM_CONTROL_NAME),
      path.join(parent, `${VM_CONTROL_NAME}-main`, `${VM_CONTROL_NAME}-main`),
    )
  }
  const seen = new Set()
  const result = []
  for (const candidate of list) {
    // Windows 路径大小写不敏感：同一目录的不同写法不能算两份副本。
    const key = keyOfPath(candidate)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(candidate)
  }
  return result
}

/**
 * 路径比较键：Windows 上折叠大小写与分隔符差异。
 * @param value - 路径。
 * @returns 比较键。
 */
function keyOfPath(value) {
  const normalized = path.resolve(value)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

/**
 * 从 `exports['.']` 解出入口相对路径。
 * @param manifest - 已解析的 package.json。
 * @returns 相对路径；无法确定时回退 {@link VM_CONTROL_ENTRY}。
 */
function entryFromManifest(manifest) {
  const exported = manifest?.exports?.['.']
  if (typeof exported === 'string' && exported.length > 0) return exported
  if (exported !== null && typeof exported === 'object') {
    for (const key of ['import', 'default', 'require']) {
      if (typeof exported[key] === 'string' && exported[key].length > 0) return exported[key]
    }
  }
  return VM_CONTROL_ENTRY
}

/**
 * 校验 `engines.node` 是否满足当前运行时。
 * @param requirement - 形如 `>=20` / `>=20.11` 的声明。
 * @param current - 当前 Node 版本。
 * @returns 满足或无法判断时为 true。
 */
function satisfiesNodeEngine(requirement, current) {
  if (typeof requirement !== 'string' || requirement.trim().length === 0) return true
  const minMatch = />=\s*v?(\d+)/.exec(requirement)
  if (minMatch === null) return true
  const required = Number(minMatch[1])
  const actual = Number(String(current).split('.')[0])
  return !Number.isFinite(required) || !Number.isFinite(actual) || actual >= required
}

/**
 * 尝试 `import()` 入口模块，只读导出形状，不调用 `apply`。
 * @param entryPath - 入口文件绝对路径。
 * @returns `{ ok: true, exports }` 或 `{ ok: false, message }`。
 */
async function probeModule(entryPath) {
  try {
    const module = await import(pathToFileURL(entryPath).href)
    return {
      ok: true,
      exports: {
        name: typeof module.name === 'string' ? module.name : undefined,
        hasApply: typeof module.apply === 'function',
        inject: Array.isArray(module.inject) ? module.inject.filter((item) => typeof item === 'string') : [],
      },
    }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 发现并静态校验目标插件。
 *
 * 任何异常都被收拢成 `issues` 里的一条记录：发现路径上抛错会让一次「看看装没装」
 * 变成插件启动失败，那与兼容层的定位正好相反。
 *
 * @param options - 发现配置。
 * @param options.dir - 显式目录。
 * @param options.packageRoot - 本插件包根。
 * @param options.searchRoots - 额外搜索根。
 * @param options.probeModule - 是否 `import()` 入口模块验证导出。
 * @param options.platform - 当前平台（测试可覆盖）。
 * @param options.nodeVersion - 当前 Node 版本（测试可覆盖）。
 * @param options.moduleCache - 已探测模块的缓存（目录 → 结果）。
 * @returns 发现结果（永不抛错）。
 */
export async function probeVmControl({
  dir,
  packageRoot = defaultPackageRoot(),
  searchRoots = [],
  probeModule: shouldProbeModule = true,
  platform = process.platform,
  nodeVersion = process.versions.node,
  moduleCache = new Map(),
} = {}) {
  const candidates = candidateDirs({ dir, packageRoot, searchRoots })
  const issues = []
  const matches = []
  const explicit = typeof dir === 'string' && dir.trim().length > 0 ? keyOfPath(dir.trim()) : ''

  for (const candidate of candidates) {
    const manifestPath = path.join(candidate, 'package.json')
    let text
    try {
      text = await readFile(manifestPath, 'utf8')
    } catch (error) {
      const code = error?.code
      if (explicit.length > 0 && keyOfPath(candidate) === explicit) {
        issues.push({
          code: code === 'ENOENT' || code === 'ENOTDIR' ? 'dir-missing' : 'manifest-unreadable',
          severity: 'error',
          params: code === 'ENOENT' || code === 'ENOTDIR'
            ? { path: candidate }
            : { path: manifestPath, message: error instanceof Error ? error.message : String(error) },
        })
      }
      continue
    }
    let manifest
    try {
      manifest = JSON.parse(text)
    } catch (error) {
      issues.push({
        code: 'manifest-unreadable',
        severity: 'error',
        params: { path: manifestPath, message: error instanceof Error ? error.message : String(error) },
      })
      continue
    }
    if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)
      || typeof manifest.name !== 'string' || typeof manifest.version !== 'string') {
      issues.push({ code: 'manifest-invalid', severity: 'error', params: { path: manifestPath } })
      continue
    }
    if (manifest.name !== VM_CONTROL_NAME) {
      // 顺手扫到的其它包只是噪音；只有用户显式指到它时才值得说一句。
      if (explicit.length > 0 && keyOfPath(candidate) === explicit) {
        issues.push({
          code: 'name-mismatch',
          severity: 'error',
          params: { path: candidate, expected: VM_CONTROL_NAME, actual: manifest.name },
        })
      }
      continue
    }
    matches.push({ dir: candidate, manifest, version: manifest.version })
  }

  if (matches.length === 0) {
    if (!issues.some((issue) => issue.severity === 'error')) {
      // 「没找到」不是错误而是事实：把它标成 error 会让状态落到 incompatible，
      // 而用户需要的结论是「未安装，原有功能照常」。
      issues.push({ code: 'not-found', severity: 'info', params: { dirs: candidates.join(', ') } })
    }
    return { found: false, candidates, issues, checkedAt: new Date().toISOString() }
  }

  const chosen = matches[0]
  const duplicates = matches.slice(1)
  if (duplicates.length > 0) {
    issues.push({
      code: 'duplicate-install',
      severity: 'warning',
      params: {
        dirs: matches.map((match) => match.dir).join(', '),
        chosen: chosen.dir,
      },
    })
  }

  if (!satisfiesRange(chosen.version)) {
    issues.push({
      code: 'version-unsupported',
      severity: 'error',
      params: { version: chosen.version, range: rangeLabel() },
    })
  }

  const entryRelative = entryFromManifest(chosen.manifest)
  const entryPath = path.resolve(chosen.dir, entryRelative)
  let entryExists = false
  try {
    entryExists = (await stat(entryPath)).isFile()
  } catch {
    entryExists = false
  }
  if (!entryExists) {
    issues.push({ code: 'entry-missing', severity: 'error', params: { path: entryPath } })
  }
  if (chosen.manifest.type !== 'module') {
    issues.push({ code: 'not-esm', severity: 'error', params: { path: path.join(chosen.dir, 'package.json') } })
  }
  if (!satisfiesNodeEngine(chosen.manifest.engines?.node, nodeVersion)) {
    issues.push({
      code: 'node-unsupported',
      severity: 'error',
      params: { required: chosen.manifest.engines?.node, current: nodeVersion },
    })
  }

  let moduleExports
  // 已知不是 ESM 就不 import：Node 会先打印一条 ESM 加载警告，而 `not-esm` 这条结论
  // 只看清单就够了，没必要用一条噪音换一遍加载尝试。
  if (entryExists && shouldProbeModule && chosen.manifest.type === 'module') {
    const cacheKey = `${keyOfPath(chosen.dir)}@${chosen.version}`
    if (moduleCache.has(cacheKey)) {
      moduleExports = moduleCache.get(cacheKey)
    } else {
      moduleExports = await probeModule(entryPath)
      // 失败不缓存：用户修好依赖或代码后，点一次「重新检查」就该有机会成功。
      // （Node 自己会缓存失败的模块，那是运行时行为，不是这里的决策。）
      if (moduleExports.ok === true) moduleCache.set(cacheKey, moduleExports)
    }
    if (moduleExports.ok !== true) {
      issues.push({ code: 'module-load-failed', severity: 'error', params: { message: moduleExports.message } })
    } else {
      if (moduleExports.exports.hasApply !== true) {
        issues.push({ code: 'missing-apply', severity: 'error', params: { path: entryPath } })
      }
      if (!moduleExports.exports.inject.includes('tools')) {
        issues.push({ code: 'missing-tools-inject', severity: 'error', params: { path: entryPath } })
      }
    }
  }

  // 平台差异只做记录：目标插件支持 win32/darwin/linux，而本插件只在 Windows 上加载，
  // 实际组合里两者永远同时满足；把它写成错误只会制造一条永不触发的告警。
  const platformSupported = ['win32', 'darwin', 'linux'].includes(platform)

  return {
    found: true,
    dir: chosen.dir,
    version: chosen.version,
    manifest: chosen.manifest,
    entry: entryPath,
    entryRelative,
    moduleExports,
    platformSupported,
    candidates,
    duplicates,
    issues,
    checkedAt: new Date().toISOString(),
  }
}

/**
 * 审计命名空间是否重叠。
 *
 * 兼容层从不注册对方的工具，所以这里不是「运行时撞名检测」，而是把**契约层面**的
 * 占用写清楚：两边各自的前缀、路由、命令、Loader id 是否互不相交。真正会撞的东西
 * 是保险库里的**别名**，那在 `importHost` 里按记录来源逐条处理。
 *
 * @param found - 是否发现了目标插件。
 * @returns 审计结果。
 */
export function auditNamespaces(found = true) {
  const theirs = {
    pluginId: VM_CONTROL_PLUGIN_ID,
    toolPrefix: VM_CONTROL_TOOL_PREFIX,
    tools: found ? [...VM_CONTROL_TOOLS_1X] : [],
    apiPrefix: VM_CONTROL_API_PREFIX,
    command: VM_CONTROL_COMMAND,
  }
  const collisions = []
  for (const tool of theirs.tools) {
    if (SSH_NAMESPACE.tools.includes(tool)) collisions.push(`tool:${tool}`)
  }
  if (theirs.apiPrefix === SSH_NAMESPACE.apiPrefix) collisions.push(`api:${theirs.apiPrefix}`)
  if (theirs.command === SSH_NAMESPACE.command) collisions.push(`command:${theirs.command}`)
  if (theirs.pluginId === SSH_NAMESPACE.pluginId) collisions.push(`plugin:${theirs.pluginId}`)
  return {
    ours: SSH_NAMESPACE,
    theirs,
    collisions,
    disjoint: collisions.length === 0,
  }
}

/**
 * 把原始发现结果渲染成面向调用方的状态。
 *
 * @param raw - {@link probeVmControl} 的结果。
 * @param options - 渲染上下文。
 * @param options.enabled - 兼容层是否启用。
 * @param options.services - 宿主可用服务（`tools` / `settings` / `webServer` / `commands`）。
 * @param options.aliasPolicy - 默认别名冲突策略。
 * @param options.allowOverwrite - 是否允许 `overwrite` 策略。
 * @param options.cached - 是否来自缓存。
 * @returns 可直接序列化的状态对象。
 */
export function renderStatus(raw, { enabled = true, services = {}, aliasPolicy = 'reuse', allowOverwrite = true, cached = false } = {}) {
  const issues = [...(raw?.issues ?? [])]
  const serviceIssues = []
  // 目标插件的 `inject` 里只有 `tools` 是硬依赖，其余都是可选能力；缺失时说明影响，
  // 但不改变「导入接口是否可用」这个结论。
  const optionalServices = [
    { name: 'webServer', impact: 'compat.issue.service-missing.webServer' },
    { name: 'commands', impact: 'compat.issue.service-missing.commands' },
    { name: 'settings', impact: 'compat.issue.service-missing.settings' },
  ]
  if (services.tools !== true) {
    serviceIssues.push({ code: 'service-missing', severity: 'error', params: { service: 'tools', impact: t('compat.issue.service-missing.tools') } })
  } else {
    for (const entry of optionalServices) {
      if (services[entry.name] === false) {
        serviceIssues.push({
          code: 'service-missing',
          severity: 'info',
          params: { service: entry.name, impact: t(entry.impact) },
        })
      }
    }
  }
  issues.push(...serviceIssues)

  const errors = issues.filter((issue) => issue.severity === 'error')
  const warnings = issues.filter((issue) => issue.severity === 'warning')

  let state
  if (enabled !== true) state = 'disabled'
  // 「没找到」与「找到了但契约不符」是两种处置方式完全不同的结论：前者是环境缺件，
  // 后者是版本/代码问题。只有 found 为真时才谈 incompatible。
  else if (raw?.found !== true) state = 'unavailable'
  else if (errors.length > 0) state = 'incompatible'
  else if (warnings.length > 0) state = 'degraded'
  else state = 'ready'

  const localizedIssues = issues.map((issue) => ({
    code: issue.code,
    severity: issue.severity,
    message: t(`compat.issue.${issue.code}`, issue.params ?? {}),
  }))

  const reason = localizedIssues.find((issue) => issue.severity === 'error')?.message ?? ''
  const dirs = (raw?.candidates ?? []).join(', ')
  let message
  if (state === 'disabled') message = t('compat.state.disabled', { name: VM_CONTROL_NAME })
  else if (state === 'unavailable') {
    message = reason.length > 0
      ? t('compat.state.unavailable.reason', { name: VM_CONTROL_NAME, reason })
      : t('compat.state.unavailable', { name: VM_CONTROL_NAME, dirs })
  }
  else if (state === 'incompatible') {
    message = t('compat.state.incompatible', {
      name: VM_CONTROL_NAME,
      version: raw?.version === undefined ? '' : ` v${raw.version}`,
      reason,
    })
  } else if (state === 'degraded') {
    message = t('compat.state.degraded', { name: VM_CONTROL_NAME, version: raw.version, count: warnings.length })
  } else {
    message = t('compat.state.ready', { name: VM_CONTROL_NAME, version: raw.version, dir: raw.dir })
  }

  const importReady = state === 'ready' || state === 'degraded'
  return {
    state,
    enabled: enabled === true,
    importReady,
    found: raw?.found === true,
    name: VM_CONTROL_NAME,
    dir: raw?.dir ?? null,
    version: raw?.version ?? null,
    entry: raw?.entry ?? null,
    range: rangeLabel(),
    platformSupported: raw?.platformSupported ?? false,
    namespaces: auditNamespaces(raw?.found === true),
    services: {
      available: Object.keys(services).filter((key) => services[key] === true),
      missing: optionalServices.filter((entry) => services[entry.name] === false).map((entry) => entry.name),
    },
    aliasPolicy,
    allowOverwrite: allowOverwrite === true,
    issues: localizedIssues,
    message,
    // 机器可读的边界声明：调用方不必去读文档就知道这里做了什么、没做什么。
    boundary: {
      activatesPlugin: false,
      registersPluginTools: false,
      registersPluginRoutes: false,
      writesVaultRecords: importReady,
      acceptedFields: VM_IMPORT_FIELDS,
      identityField: 'vmx',
    },
    loadOrder: 'independent',
    checkedAt: raw?.checkedAt ?? new Date().toISOString(),
    cached,
  }
}

/**
 * 给一个别名找可用的后缀变体（`base-2`、`base-3`…）。
 * @param base - 建议别名。
 * @param taken - 已占用的别名集合（小写）。
 * @returns 可用别名。
 */
function uniqueAlias(base, taken) {
  if (!taken.has(base.toLowerCase())) return base
  for (let index = 2; index < 100; index += 1) {
    const candidate = `${base}-${index}`
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
  return `${base}-${Date.now().toString(36).slice(-4)}`
}

/**
 * 别名比较：保险库的键是精确匹配，但「同名」在用户眼里不分大小写。
 * @param left - 别名。
 * @param right - 别名。
 * @returns 是否视为同一个别名。
 */
function sameAlias(left, right) {
  return String(left ?? '').toLowerCase() === String(right ?? '').toLowerCase()
}

/**
 * 描述一条已占用别名的记录来源，用于冲突消息。
 * @param record - 保险库记录。
 * @returns 已本地化的描述。
 */
function describeOwner(record) {
  if (record?.source?.plugin !== VM_CONTROL_NAME) return t('compat.error.alias-conflict.manual')
  const ref = String(record.source.ref ?? '').trim()
  return ref.length > 0
    ? t('compat.error.alias-conflict.other-vm', { ref })
    : t('compat.error.alias-conflict.vm-record')
}

/**
 * 从请求体里取字符串字段。
 * @param body - 请求体。
 * @param key - 字段名。
 * @returns 去空白后的字符串；缺失时为空串。
 */
function textOf(body, key) {
  return typeof body?.[key] === 'string' ? body[key].trim() : ''
}

/**
 * 规范化标签数组：去空、去重、保持顺序。
 * @param value - 请求体里的 `tags`。
 * @param fallback - 缺失时沿用的旧值。
 * @returns 标签数组。
 */
function normalizeTags(value, fallback) {
  if (!Array.isArray(value)) return Array.isArray(fallback) ? [...fallback] : []
  const result = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const tag = item.trim()
    if (tag.length === 0 || result.includes(tag)) continue
    result.push(tag)
  }
  return result
}

/**
 * 创建兼容层实例。
 *
 * @param options - 依赖与策略。
 * @param options.enabled - 是否启用；默认 true。
 * @param options.dir - 显式插件目录。
 * @param options.packageRoot - 本插件包根。
 * @param options.searchRoots - 额外搜索根。
 * @param options.store - 保险库接口：`{ list, get, put }`。
 * @param options.logger - 可选日志接口。
 * @param options.diagnostics - 可选诊断日志（只用 info/warn）。
 * @param options.aliasPolicy - 默认别名冲突策略（默认 `reuse`）。
 * @param options.allowOverwrite - 是否允许显式覆盖他源记录（默认 true，仍需 confirm）。
 * @param options.cacheTtlMs - 命中性缓存时长（默认 30 秒）。
 * @param options.retryTtlMs - 未命中/不兼容时的重试间隔（默认 5 秒）。
 * @param options.probeModule - 是否 `import()` 目标插件验证导出（默认 true）。
 * @param options.serviceProbe - 返回宿主可用服务的回调（惰性求值，避免加载顺序假设）。
 * @param options.now - 时间源（测试可覆盖）。
 * @returns 兼容层实例。
 */
export function createVmControlCompat({
  enabled = true,
  dir,
  packageRoot = defaultPackageRoot(),
  searchRoots = [],
  store,
  logger,
  diagnostics,
  aliasPolicy = 'reuse',
  allowOverwrite = true,
  cacheTtlMs = 30000,
  retryTtlMs = 5000,
  probeModule: shouldProbeModule = true,
  serviceProbe,
  now = () => Date.now(),
} = {}) {
  // 配置里的策略值不合法时退回 `reuse`：那是最安全的一档（拒绝而不是覆盖）。
  // 与其让每次导入都报 bad-policy，不如在创建时收口，并把实际生效的值放进状态里。
  const defaultPolicy = VM_IMPORT_ALIAS_POLICIES.includes(aliasPolicy) ? aliasPolicy : 'reuse'
  const moduleCache = new Map()
  let cachedRaw
  let cachedAt = 0
  let inflight

  /**
   * 取（必要时重新）发现结果。并发调用共享同一次探测。
   * @param force - 忽略缓存。
   * @returns 原始发现结果。
   */
  const ensureProbe = async (force = false) => {
    const age = now() - cachedAt
    const ttl = cachedRaw?.found === true && !cachedRaw.issues.some((issue) => issue.severity === 'error')
      ? cacheTtlMs
      : retryTtlMs
    if (!force && cachedRaw !== undefined && age < ttl) return cachedRaw
    if (inflight !== undefined) return inflight
    inflight = (async () => {
      try {
        const raw = await probeVmControl({
          dir,
          packageRoot,
          searchRoots,
          probeModule: shouldProbeModule,
          moduleCache,
        })
        cachedRaw = raw
        cachedAt = now()
        return raw
      } catch (error) {
        // probeVmControl 自己已经兜住了绝大多数错误；这里是最后一道，
        // 保证「兼容层失败」永远不会变成「SSH 插件失败」。
        const raw = {
          found: false,
          candidates: candidateDirs({ dir, packageRoot, searchRoots }),
          issues: [{
            code: 'module-load-failed',
            severity: 'error',
            params: { message: error instanceof Error ? error.message : String(error) },
          }],
          checkedAt: new Date(now()).toISOString(),
        }
        cachedRaw = raw
        cachedAt = now()
        return raw
      } finally {
        inflight = undefined
      }
    })()
    return inflight
  }

  /**
   * 读取宿主可用服务；探针本身抛错时按「未知」处理，不制造假告警。
   * @returns 服务映射。
   */
  const readServices = () => {
    try {
      const probe = typeof serviceProbe === 'function' ? serviceProbe() : serviceProbe
      if (probe === null || typeof probe !== 'object') return { tools: true }
      const result = {}
      for (const key of ['tools', 'settings', 'webServer', 'commands']) {
        if (typeof probe[key] === 'boolean') result[key] = probe[key]
      }
      return result
    } catch {
      return { tools: true }
    }
  }

  /**
   * 当前兼容状态。
   * @param options - `{ refresh }`：强制重新发现。
   * @returns 状态对象（永不抛错）。
   */
  const status = async ({ refresh = false } = {}) => {
    if (enabled !== true) {
      return renderStatus({ found: false, issues: [], candidates: [] }, {
        enabled: false,
        services: readServices(),
        aliasPolicy: defaultPolicy,
        allowOverwrite,
      })
    }
    const before = cachedAt
    const raw = await ensureProbe(refresh === true)
    return renderStatus(raw, {
      enabled: true,
      services: readServices(),
      aliasPolicy: defaultPolicy,
      allowOverwrite,
      // 探测没有更新 `cachedAt` 就说明这次是缓存命中，状态里如实标出来。
      cached: refresh !== true && before !== 0 && before === cachedAt,
    })
  }

  /**
   * 构造一条本地化错误。
   * @param code - 错误码。
   * @param message - 已本地化的消息。
   * @param details - 附加信息（可序列化）。
   * @returns 分发结果。
   */
  const failure = (code, message, details) => ({ error: message, code, details })

  /**
   * 导入一台虚拟机的 SSH 接入信息。
   *
   * 与 `ssh-vault/save` 的差别只在**冲突语义**：`save` 是「同名即更新」，因为它服务于
   * 用户亲手填的表单；`vmImport` 的调用方是另一个插件，同名很可能是两台不同的机器
   * （「Kali Linux」与「软件安全kali Linux」都会压成 `kali-linux`），所以默认拒绝覆盖，
   * 并把「换哪个别名」直接算好给调用方。
   *
   * @param body - 请求体（字段见 {@link VM_IMPORT_FIELDS}）。
   * @returns `{ value }` 或 `{ error, code, details }`。
   */
  const importHost = async (input = {}) => {
    const body = input !== null && typeof input === 'object' ? input : {}
    const current = await status()
    if (!current.enabled) {
      return failure('compat-disabled', t('compat.error.disabled', { name: VM_CONTROL_NAME }), {
        state: current.state,
        fallback: 'manual',
      })
    }
    if (current.state === 'unavailable' || current.state === 'incompatible') {
      const code = current.state === 'incompatible' ? 'compat-incompatible' : 'compat-unavailable'
      const reason = current.issues.find((issue) => issue.severity === 'error')?.message ?? ''
      const message = current.state === 'incompatible'
        ? t('compat.error.incompatible', { name: VM_CONTROL_NAME, reason })
        : [
          t('compat.error.unavailable', {
            name: VM_CONTROL_NAME,
            dirs: candidateDirs({ dir, packageRoot, searchRoots }).join(', '),
          }),
          reason,
        ].filter((part) => part.length > 0).join('\n')
      return failure(code, message, { state: current.state, issues: current.issues, fallback: 'manual' })
    }

    const policy = typeof body.aliasPolicy === 'string' && body.aliasPolicy.length > 0
      ? body.aliasPolicy.trim().toLowerCase()
      : defaultPolicy
    if (!VM_IMPORT_ALIAS_POLICIES.includes(policy)) {
      return failure('bad-policy', t('compat.error.bad-policy', { policy }), { accepted: VM_IMPORT_ALIAS_POLICIES })
    }

    const alias = textOf(body, 'alias')
    if (alias.length === 0 || !/^[A-Za-z0-9._-]+$/.test(alias)) {
      return failure('invalid-alias', t('compat.error.alias-invalid', { alias: alias || '""' }), { alias })
    }
    const host = textOf(body, 'host')
    if (host.length === 0) return failure('missing-host', t('compat.error.host-required'))
    const username = textOf(body, 'username')
    if (username.length === 0) return failure('missing-username', t('compat.error.username-required'))
    // 允许数字或数字字符串：表单与 JSON 两条来源的写法并不一致，这里统一收口。
    const rawPort = body.port === undefined || body.port === null || body.port === '' ? 22 : Number(body.port)
    if (!Number.isInteger(rawPort) || rawPort < 1 || rawPort > 65535) {
      return failure('invalid-port', t('compat.error.port-invalid', { port: String(body.port) }), { port: body.port })
    }
    const port = rawPort

    const vmx = textOf(body, 'vmx')
    let records
    try {
      records = await store.list()
    } catch (error) {
      return failure('store-failed', t('compat.error.store-failed', {
        message: error instanceof Error ? error.message : String(error),
      }))
    }
    const existingByAlias = records.find((record) => sameAlias(record.alias, alias))
    const existingBySource = vmx.length === 0
      ? undefined
      : records.find((record) => record?.source?.plugin === VM_CONTROL_NAME && record?.source?.ref === vmx)

    const sameSource = existingByAlias !== undefined && vmx.length > 0 && existingByAlias.source?.ref === vmx
    let targetAlias = alias
    let overwriting = false
    let suffixWarning
    if (existingByAlias !== undefined && !sameSource) {
      const owner = describeOwner(existingByAlias)
      if (policy === 'overwrite') {
        if (allowOverwrite !== true || body.confirm !== true) {
          const suggestions = aliasSuggestions(alias, records)
          return failure('alias-conflict', t('compat.error.alias-conflict', {
            alias,
            owner,
            suggestions: suggestions.join(', '),
          }), {
            alias,
            existing: { alias: existingByAlias.alias, source: existingByAlias.source ?? null },
            suggestions,
            requires: 'confirm',
          })
        }
        overwriting = true
      } else if (policy === 'suffix') {
        targetAlias = uniqueAlias(alias, new Set(records.map((record) => String(record.alias).toLowerCase())))
        suffixWarning = { code: 'suffixed', message: t('compat.warn.suffixed', { alias, chosen: targetAlias }) }
      } else {
        const suggestions = aliasSuggestions(alias, records)
        return failure('alias-conflict', t('compat.error.alias-conflict', {
          alias,
          owner,
          suggestions: suggestions.join(', '),
        }), {
          alias,
          existing: { alias: existingByAlias.alias, source: existingByAlias.source ?? null },
          suggestions,
          requires: 'confirm',
        })
      }
    }

    if (existingByAlias === undefined && existingBySource !== undefined) {
      return failure('already-imported', t('compat.error.already-imported', {
        ref: vmx,
        alias: existingBySource.alias,
      }), {
        alias: existingBySource.alias,
        existing: { alias: existingBySource.alias, source: existingBySource.source ?? null },
        suggestions: [existingBySource.alias],
      })
    }

    // 覆盖他源记录时**不**继承任何旧字段：那台机器的绑定地址、sudo 口令与凭据引用
    // 属于另一台机器，沿用过来只会把认证失败包装成「导入成功」。
    const base = sameSource && existingByAlias !== undefined ? existingByAlias : {}
    const authType = body.authType === 'key' ? 'key' : 'password'
    const warnings = []
    if (overwriting) {
      warnings.push({
        code: 'overwrote-foreign',
        message: t('compat.warn.overwrote-foreign', { alias, owner: describeOwner(existingByAlias) }),
      })
    }
    if (suffixWarning !== undefined) warnings.push(suffixWarning)

    let auth
    if (authType === 'key') {
      const keyPath = textOf(body, 'privateKeyPath')
        || (base.auth?.type === 'key' ? String(base.auth.privateKeyPath ?? '') : '')
      if (keyPath.length === 0) return failure('missing-key', t('compat.error.key-required'))
      const passphrase = typeof body.passphrase === 'string' && body.passphrase.length > 0
        ? body.passphrase
        : (base.auth?.type === 'key' && typeof base.auth.passphrase === 'string' ? base.auth.passphrase : '')
      auth = { type: 'key', privateKeyPath: keyPath, ...(passphrase.length > 0 ? { passphrase } : {}) }
    } else {
      const password = typeof body.password === 'string' ? body.password : ''
      if (password.length > 0) {
        auth = { type: 'password', password }
      } else if (base.auth?.type === 'password' && typeof base.auth.password === 'string' && base.auth.password.length > 0) {
        auth = { type: 'password', password: base.auth.password }
        warnings.push({ code: 'password-inherited', message: t('compat.warn.password-inherited') })
      } else if (base.auth?.type === 'key') {
        return failure('password-on-key-host', t('compat.error.password-on-key-host'))
      } else {
        return failure('missing-password', t('compat.error.password-required'))
      }
    }

    if (current.state === 'degraded') {
      warnings.push({
        code: 'degraded',
        message: t('compat.warn.degraded', { count: current.issues.filter((issue) => issue.severity === 'warning').length }),
      })
    }

    const timestamp = new Date(now()).toISOString()
    const record = {
      ...base,
      alias: targetAlias,
      host,
      port,
      username,
      shell: textOf(body, 'shell') || (typeof base.shell === 'string' && base.shell.length > 0 ? base.shell : 'bash'),
      description: typeof body.description === 'string' ? body.description : (base.description ?? ''),
      tags: normalizeTags(body.tags, base.tags),
      auth,
      source: {
        plugin: VM_CONTROL_NAME,
        ...(vmx.length > 0 ? { ref: vmx } : {}),
        version: current.version ?? 'unknown',
        importedAt: timestamp,
      },
    }
    // 私钥认证的机器上残留的口令型凭据引用会让「换认证方式」变成一次静默回退。
    if (auth.type === 'key') delete record.credentialRef

    // 只有「同一条记录换了大小写写法」才需要删旧键；suffix 是新增一条记录，
    // 覆盖他源记录时旧记录的键名就是目标键名，都不该走到删除分支——否则会误删别人的主机。
    const renameExisting = existingByAlias !== undefined
      && (sameSource || overwriting)
      && existingByAlias.alias !== targetAlias

    try {
      await store.put(record)
      // 保险库的键是精确字符串，而「同名」在用户眼里不分大小写：`Kali` 与 `kali`
      // 被当成同一条记录时，新键写进去之后旧键还留在那里，就会凭空多出一台主机。
      if (renameExisting && typeof store.remove === 'function') await store.remove(existingByAlias.alias)
      // 覆盖到另一个别名后，同一台虚拟机可能还挂在旧别名下：一台机器两个别名会让
      // 「按别名运维」变成猜谜，因此把旧记录清掉，并在结果里说清楚。
      const staleSource = existingBySource !== undefined && !sameAlias(existingBySource.alias, targetAlias)
        ? existingBySource
        : undefined
      if (staleSource !== undefined && typeof store.remove === 'function') {
        await store.remove(staleSource.alias)
        warnings.push({
          code: 'replaced-source',
          message: t('compat.warn.replaced-source', { old: staleSource.alias, alias: targetAlias }),
        })
      }
    } catch (error) {
      return failure('store-failed', t('compat.error.store-failed', {
        message: error instanceof Error ? error.message : String(error),
      }))
    }

    diagnostics?.info?.('vm-control:import', `${targetAlias}${vmx.length > 0 ? ` <- ${vmx}` : ''}`)
    logger?.info?.(`ssh-vault: imported VM host ${targetAlias} from ${VM_CONTROL_NAME}`)

    // `created` / `updated` 描述的是**目标别名**上的记录，而不是请求里那个别名：
    // suffix 策略下请求别名被占用，但目标别名是新建的，调用方需要看到 created=true。
    const targetExisting = records.find((item) => sameAlias(item.alias, targetAlias))
    return {
      value: {
        alias: targetAlias,
        created: targetExisting === undefined,
        updated: targetExisting !== undefined,
        overwritten: overwriting,
        vmx: vmx.length > 0 ? vmx : undefined,
        source: record.source,
        warnings,
      },
    }
  }

  return {
    status,
    importHost,
    /** 强制重新发现（设置页的「重新检查」）。 */
    refresh: async () => status({ refresh: true }),
    /** 释放缓存；没有长生命周期资源。 */
    dispose: () => {
      moduleCache.clear()
      cachedRaw = undefined
      cachedAt = 0
    },
  }
}

/**
 * 生成避让用的别名建议。
 * @param alias - 冲突的别名。
 * @param records - 现有记录。
 * @returns 最多三个建议。
 */
function aliasSuggestions(alias, records) {
  const taken = new Set(records.map((record) => String(record.alias).toLowerCase()))
  const result = []
  for (let index = 2; index < 10 && result.length < 3; index += 1) {
    const candidate = `${alias}-${index}`
    if (!taken.has(candidate.toLowerCase())) result.push(candidate)
  }
  return result
}
