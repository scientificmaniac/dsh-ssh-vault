/**
 * Host 侧的双语文本表与 locale 解析。
 *
 * 为什么 Host 需要知道语言：工具输出、`/hosts` 结果、设置接口的错误消息都由这里生成，
 * 而它们的读者是使用界面的人。DSH 的语言**不是**浏览器语言猜出来的，而是用户在选择
 * 「设置 → 常规 → 语言」后写进 Host 设置里的 `locale.preference`；`index.js` 通过
 * `settings.describe()` 读取它，并订阅 `settings/document-updated` 跟随切换。
 * 只有在完全没有显式偏好时，才退回 HTTP 请求的 `Accept-Language`（它与 DSH 未设置
 * 偏好时的浏览器派生语言一致）。
 *
 * 保持零依赖：表就是几个普通对象，`t()` 只是查表 + 回退。
 *
 * @module dsh-ssh-vault/i18n
 */

import { SSH_MESSAGES } from './locales/ssh.js'

/** 支持的 locale 标识。 */
export const LOCALES = ['zh', 'en']

/** 没有任何信号时的默认语言，与插件历史行为一致。 */
export const DEFAULT_LOCALE = 'zh'

/** DSH locale 设置条目（Loader 行 id）与字段名。 */
export const LOCALE_SETTINGS_NAMESPACE = 'locale'
/** 该条目里承载用户选择的字段。 */
export const LOCALE_PREFERENCE_FIELD = 'preference'

/** 当前生效的 locale。 */
let currentLocale = DEFAULT_LOCALE
/** 是否已经拿到过显式偏好（拿到后不再被 Accept-Language 覆盖）。 */
let explicitPreference = false
/** locale 变化订阅者。 */
const listeners = new Set()

/**
 * 把任意标识归一化成我们支持的 locale。
 *
 * DSH 允许安装 `zh`/`en` 之外的语言包（它们的回退链最终都以 en 收尾），
 * 本插件没有那些语言的文案，因此除中文外一律按英文输出。
 *
 * @param value - 语言标识，例如 `zh`、`zh-CN`、`en-US`、`ja`。
 * @returns `zh` 或 `en`。
 */
export function normalizeLocale(value) {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return text.startsWith('zh') ? 'zh' : 'en'
}

/**
 * 读取当前 locale。
 * @returns `zh` 或 `en`。
 */
export function getLocale() {
  return currentLocale
}

/**
 * 是否已经拿到显式偏好。
 * @returns 是否有显式偏好。
 */
export function hasExplicitPreference() {
  return explicitPreference
}

/**
 * 设置 locale；只有值真的变化时才通知订阅者。
 * @param value - 语言标识。
 * @returns 生效后的 locale。
 */
export function setLocale(value) {
  const next = value === 'zh' || value === 'en' ? value : normalizeLocale(value)
  if (next === currentLocale) return currentLocale
  currentLocale = next
  for (const listener of [...listeners]) {
    try {
      listener(currentLocale)
    } catch {
      // 订阅者是命令重注册之类的副作用；它失败不该影响文案解析。
    }
  }
  return currentLocale
}

/**
 * 采用 DSH 设置里的显式偏好。
 * @param preference - `locale.preference` 的值；`undefined` 表示用户没有显式选择。
 * @returns 是否记录到了偏好。
 */
export function applyPreference(preference) {
  if (typeof preference !== 'string' || preference.trim().length === 0) return false
  explicitPreference = true
  setLocale(preference)
  return true
}

/**
 * 从 `Accept-Language` 头解析出第一个受支持的语言。
 *
 * 只在没有显式偏好时作为兜底使用：它反映的是浏览器的语言，而 DSH 在没有用户选择
 * 时正是按浏览器语言派生的，所以两者通常一致。
 *
 * @param header - 请求头值，可能是字符串或数组。
 * @returns `zh`、`en`，或 `undefined`（头里没有可用语言）。
 */
export function localeFromHeader(header) {
  const raw = Array.isArray(header) ? header.join(',') : String(header ?? '')
  const entries = raw
    .split(',')
    .map((part, index) => {
      const [tag, ...params] = part.trim().split(';')
      const qParam = params.map((param) => param.trim()).find((param) => param.startsWith('q='))
      const quality = qParam === undefined ? 1 : Number.parseFloat(qParam.slice(2))
      return { tag: tag.trim(), index, quality: Number.isFinite(quality) ? quality : 1 }
    })
    .filter((entry) => entry.tag.length > 0 && entry.quality > 0)
  entries.sort((a, b) => (b.quality - a.quality) || (a.index - b.index))
  for (const entry of entries) {
    const lower = entry.tag.toLowerCase()
    if (lower.startsWith('zh')) return 'zh'
    if (lower.startsWith('en')) return 'en'
  }
  return undefined
}

/**
 * 记录一次请求使用的语言；已有显式偏好时忽略。
 * @param header - `Accept-Language` 头。
 * @returns 生效后的 locale。
 */
export function learnLocaleFromHeader(header) {
  if (explicitPreference) return currentLocale
  const parsed = localeFromHeader(header)
  if (parsed !== undefined) setLocale(parsed)
  return currentLocale
}

/**
 * 订阅 locale 变化。
 * @param listener - 变化回调，参数为新 locale。
 * @returns 取消订阅函数。
 */
export function onLocaleChange(listener) {
  if (typeof listener !== 'function') return () => {}
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * 从设置服务的描述里读出一条配置条目的当前值。
 *
 * DSH 的 `settings.describe()` 返回所有活动插件条目的 volatile 表单值；
 * 语言条目就是 `@deepseek-ai/dsh-client-locale` 注册的 `locale` 命名空间。
 *
 * @param settings - Host 的 settings 服务。
 * @param namespace - Loader 行 id。
 * @returns 该条目的 value；读不到时为 `undefined`。
 */
export function readSettingsValue(settings, namespace = LOCALE_SETTINGS_NAMESPACE) {
  if (settings === undefined || settings === null || typeof settings.describe !== 'function') return undefined
  const rows = settings.describe()
  const entry = rows.find((row) => String(row?.ns) === namespace)
  return entry?.value
}

/**
 * 读取 DSH 当前的界面语言偏好。
 * @param settings - Host 的 settings 服务。
 * @returns `locale.preference` 的值，未设置时为 `undefined`。
 */
export function readLocalePreference(settings) {
  const value = readSettingsValue(settings, LOCALE_SETTINGS_NAMESPACE)
  const preference = value?.[LOCALE_PREFERENCE_FIELD]
  return typeof preference === 'string' && preference.length > 0 ? preference : undefined
}

/** 基础文本表：键名按模块分组，值形如 `{ zh, en }`。 */
const CORE_MESSAGES = {
  // —— `/hosts` 命令 ——
  'hosts.description': {
    zh: '列出已配置的 SSH 主机与在线状态，或探测指定主机、在指定主机上执行 shell 命令',
    en: 'List configured SSH hosts and their online state, or probe hosts and run shell commands on them',
  },
  'hosts.hint': {
    zh: '别名,别名; shell 命令（只列出主机就再按一次回车；自然语言直接说，不要加 /hosts）',
    en: 'alias,alias; shell command (press Enter again to just list hosts; for plain language, ask without /hosts)',
  },
  'hosts.usage': {
    zh: '用法：`/hosts 别名,别名; shell 命令` —— 逗号分隔多台（中英文都行），分号之后是要执行的命令，留空则只探测。',
    en: 'Usage: `/hosts alias,alias; shell command` — comma-separated hosts (ASCII or full-width); everything after the semicolon is executed, leave it empty to probe only.',
  },
  'hosts.vaultEmpty': {
    zh: 'SSH 保险库为空。可在「设置 → SSH 连接」中添加主机。',
    en: 'The SSH vault is empty. Add a host in Settings → SSH Connections.',
  },
  'hosts.noReachable': {
    zh: '当前没有可达主机。',
    en: 'No reachable host right now.',
  },
  'hosts.onlineCount': {
    zh: '在线 {n} 台：',
    en: 'Online ({n}):',
  },
  'hosts.offlineCount': {
    zh: '离线 {n} 台：',
    en: 'Offline ({n}):',
  },
  'hosts.needHost': {
    zh: '分号前没有指定主机。',
    en: 'No host was named before the semicolon.',
  },
  'hosts.needHostWithUsage': {
    zh: '{head}{usage}',
    en: '{head} {usage}',
  },
  'hosts.unknownWithUsage': {
    zh: '未找到：{list}（{usage}）',
    en: 'Not found: {list} ({usage})',
  },
  'hosts.listSeparator': {
    zh: '、',
    en: ', ',
  },
  'hosts.notNatural': {
    zh: '「{text}」看起来是自然语言，不是 shell 命令，我没有执行它。\n\n'
      + '命令的运行结果不会回流给我（模型），所以这种请求不能塞进分号——把这句话直接发给对话就行，'
      + '我会自己挑主机并执行。\n\n'
      + '如果确实要跑命令，写成：`/hosts {alias}; <shell 命令>`',
    en: '"{text}" looks like natural language rather than a shell command, so it was not executed.\n\n'
      + 'Command output never flows back to me (the model), so a request like this cannot go after the '
      + 'semicolon — send that sentence to the conversation instead and I will pick a host and run it.\n\n'
      + 'If you did mean a command, write: `/hosts {alias}; <shell command>`',
  },
  'hosts.probeFailed': {
    zh: '连接失败',
    en: 'Connection failed',
  },
  'hosts.aliasPlaceholder': {
    zh: '<别名>',
    en: 'alias',
  },
  'hosts.outputTruncated': {
    zh: '…（输出已截断）',
    en: '…(output truncated)',
  },
  'hosts.timeout': {
    zh: '[超时：{ms}ms 内未结束]',
    en: '[timed out: did not finish within {ms}ms]',
  },
  'hosts.listLine': {
    zh: '{alias}（{host}:{port}，{user}，{auth}）',
    en: '{alias} ({host}:{port}, {user}, {auth})',
  },
  'hosts.probeSection': {
    zh: '连接状态',
    en: 'Connection',
  },
  'hosts.execSection': {
    zh: '命令执行',
    en: 'Command',
  },

  // —— 探测 ——
  'probe.timeoutDetail': {
    zh: '连接在 {ms}ms 内未建立：主机可能在线但 SSH 端口不通，或地址已变',
    en: 'The connection was not established within {ms}ms: the host may be up with the SSH port closed, or its address changed',
  },

  // —— 工具参数与主机查找 ——
  'err.aliasRequired': {
    zh: '必须提供主机别名 alias。',
    en: 'A host alias is required.',
  },
  'err.aliasNotFound': {
    zh: '保险库中没有名为 {alias} 的主机。{hint}',
    en: 'No host named {alias} in the vault. {hint}',
  },
  'err.knownHosts': {
    zh: '现有主机：{list}。',
    en: 'Known hosts: {list}.',
  },
  'err.vaultEmptyHint': {
    zh: '当前保险库为空，请先用 ssh_hosts 的 add 动作添加主机。',
    en: 'The vault is empty; add a host with ssh_hosts action "add" first.',
  },
  'err.keyEmpty': {
    zh: 'privateKeyPath 不能为空。',
    en: 'privateKeyPath must not be empty.',
  },
  'err.keyPublicSuffix': {
    zh: '{path} 以 .pub 结尾，是公钥文件。公钥不能用于登录，请提供配套的私钥文件（如 id_rsa）。',
    en: '{path} ends with .pub, so it is a public key. Public keys cannot log in; provide the matching private key (for example id_rsa).',
  },
  'err.keyReadFailed': {
    zh: '无法读取 {path}：{message}',
    en: 'Could not read {path}: {message}',
  },
  'err.keyPublicContent': {
    zh: '{path} 的内容是公钥（以 {prefix} 开头），不能用于登录。',
    en: 'The content of {path} is a public key (starts with {prefix}); it cannot log in.',
  },
  'err.keyPpkPath': {
    zh: '{path} 是 PuTTY 的 .ppk 格式，OpenSSH 无法直接使用；请先用 puttygen 导出 OpenSSH 私钥。',
    en: '{path} is a PuTTY .ppk file, which OpenSSH cannot use directly; export an OpenSSH private key with puttygen first.',
  },
  'err.keyNotPemPath': {
    zh: '{path} 看起来不是 OpenSSH/PEM 私钥文件。',
    en: '{path} does not look like an OpenSSH/PEM private key.',
  },

  // —— 凭据解析 ——
  'err.credentialRefFallback': {
    zh: '主机 {alias} 配置了 credentialRef={ref}，但该引用当前不可用{reason}；本次已回退使用保险库中保存的口令。',
    en: 'Host {alias} declares credentialRef={ref}, but that reference is unavailable{reason}; this call fell back to the password stored in the vault.',
  },
  'err.credentialsServiceAbsent': {
    zh: '（当前组合没有凭据服务）',
    en: ' (this composition has no credential service)',
  },
  'err.credentialsNotConfigured': {
    zh: '（尚未配置，或写入凭据文件后未重启 DSH Desktop）',
    en: ' (it is not configured, or DSH Desktop has not been restarted since the credentials file was written)',
  },
  'err.credentialRefUnavailable': {
    zh: '主机 {alias} 引用的凭据 {ref} 当前不可用，且保险库中没有可回退的口令。'
      + '请在 Harness 中配置该引用（新增引用需要重启 DSH Desktop），'
      + '或用 scripts/set-secret.mjs {alias} 把口令写入保险库。',
    en: 'The credential {ref} referenced by host {alias} is unavailable and the vault has no fallback password. '
      + 'Configure that reference in the Harness (new references need a DSH Desktop restart), '
      + 'or store the password with scripts/set-secret.mjs {alias}.',
  },
  'err.noPassword': {
    zh: '主机 {alias} 未保存口令，且没有可用的 credentialRef。',
    en: 'Host {alias} has no stored password and no usable credentialRef.',
  },

  // —— 执行过程提示 ——
  'msg.cancelledWithOutput': {
    zh: '工具调用被取消；本地 ssh 客户端已结束，但远端命令可能仍在运行。\n取消前已收到的输出：\n{output}',
    en: 'The tool call was cancelled; the local ssh client has exited, but the remote command may still be running.\nOutput received before the cancellation:\n{output}',
  },
  'note.sudoInline': {
    zh: '提示：命令里出现了 `sudo -S` 手写口令。改用 ssh_run 的 sudo: true——插件会从保险库取口令预置 sudo 缓存，'
      + '口令不进命令文本、不进两端命令行，也不会出现在远端 ps 里。',
    en: 'Note: the command writes a password inline via `sudo -S`. Use ssh_run with sudo: true instead — the plugin primes the sudo cache from the vault, '
      + 'so the password never enters the command text, either command line, or the remote process list.',
  },
  'note.accountLockRisk': {
    zh: '⚠ 这条命令会修改账户状态或锁定策略。若同时在同一台机器上反复用某个账号试登录，'
      + '可能把它锁死——Windows 账号一旦锁定，连密钥登录都会一起失效，只能从另一台机器用别的账号解锁。'
      + '执行前请确认已有一条可用的备用管理通道。',
    en: '⚠ This command changes account state or lockout policy. Repeated login attempts with some account on the same machine at the same time '
      + 'could lock it out — on Windows a locked account also blocks key-based login, and recovery requires another account from another machine. '
      + 'Make sure a working fallback management path exists first.',
  },
  'err.noSudoOnWindows': {
    zh: '主机 {alias} 的远端 shell 是 {shell}，没有 sudo。Windows 目标请改用管理员凭据或计划任务执行特权操作。',
    en: 'Host {alias} runs {shell} remotely and has no sudo. On Windows, perform privileged actions through administrator credentials or a scheduled task.',
  },
  'err.noSudoPassword': {
    zh: '主机 {alias} 没有可用于 sudo 的口令：可用 ssh_hosts 的 update 传 sudoPassword，'
      + '或用 scripts/set-secret.mjs {alias} --sudo 从终端录入，'
      + '也可以让该主机使用口令认证（保险库里的登录口令会被复用）。',
    en: 'Host {alias} has no password usable for sudo: pass sudoPassword via ssh_hosts update, '
      + 'record one with scripts/set-secret.mjs {alias} --sudo, or switch the host to password authentication '
      + '(its vault login password is reused).',
  },
  'err.jobsUnavailable': {
    zh: '后台执行不可用：当前组合没有 jobs 服务（需要 @deepseek-ai/dsh-jobs 与 @deepseek-ai/dsh-tool-jobs）。'
      + '去掉 run_in_background 并提高 timeoutMs 也能得到中断前的全部输出。',
    en: 'Background execution is unavailable: this composition has no jobs service (requires @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs). '
      + 'Drop run_in_background and raise timeoutMs to get all output produced before an interruption.',
  },
  'err.backgroundRegister': {
    zh: '后台任务注册失败：{message}。可以去掉 run_in_background 并为该命令提高 timeoutMs。',
    en: 'Registering the background job failed: {message}. Drop run_in_background and raise timeoutMs for this command.',
  },
  'err.transferCancelled': {
    zh: '传输被取消；远端可能已收到部分文件。\n{stderr}',
    en: 'The transfer was cancelled; the remote side may have received some files.\n{stderr}',
  },
  'err.probeCancelled': {
    zh: '探测被取消。\n{output}',
    en: 'The probe was cancelled.\n{output}',
  },
  'marker.timedOut': {
    zh: '[本地客户端已按时限中断]',
    en: '[local client interrupted at the timeout]',
  },
  'marker.cancelled': {
    zh: '[调用被取消]',
    en: '[call cancelled]',
  },

  // —— 设置接口 ——
  'api.aliasRequired': {
    zh: '别名不能为空。',
    en: 'Alias must not be empty.',
  },
  'api.aliasInvalid': {
    zh: '别名只能包含字母、数字、点、下划线和连字符。',
    en: 'Alias may contain only letters, digits, dot, underscore and hyphen.',
  },
  'api.renameSourceMissing': {
    zh: '找不到要改名的原记录 {alias}。',
    en: 'Cannot find the entry to rename: {alias}.',
  },
  'api.aliasTaken': {
    zh: '别名 {alias} 已被占用。',
    en: 'Alias {alias} is already in use.',
  },
  'api.hostRequired': {
    zh: '主机地址不能为空。',
    en: 'Host address must not be empty.',
  },
  'api.usernameRequired': {
    zh: '账号不能为空。',
    en: 'Account must not be empty.',
  },
  'api.portInvalid': {
    zh: '端口必须在 1 到 65535 之间。',
    en: 'Port must be an integer between 1 and 65535.',
  },
  'api.keyEmpty': {
    zh: '私钥内容为空。',
    en: 'The private key is empty.',
  },
  'api.keyTooLarge': {
    zh: '私钥文件过大。',
    en: 'The private key file is too large.',
  },
  'api.keyBadBase64': {
    zh: '私钥内容不是合法的 base64。',
    en: 'The private key is not valid base64.',
  },
  'api.keyPublic': {
    zh: '上传的是公钥，不是私钥。请选择不带 .pub 后缀的私钥文件。',
    en: 'The uploaded file is a public key, not a private key. Choose the private key without the .pub suffix.',
  },
  'api.keyPpk': {
    zh: '上传的是 PuTTY 的 .ppk 私钥，OpenSSH 无法直接使用；请先用 puttygen 导出 OpenSSH 私钥。',
    en: 'The uploaded file is a PuTTY .ppk private key, which OpenSSH cannot use directly; export an OpenSSH private key with puttygen first.',
  },
  'api.keyNotPrivate': {
    zh: '上传的文件不是 OpenSSH/PEM 私钥：缺少 BEGIN … PRIVATE KEY 头。',
    en: 'The uploaded file is not an OpenSSH/PEM private key: it lacks a BEGIN … PRIVATE KEY header.',
  },
  'api.keyRequired': {
    zh: '密钥认证需要提供私钥：上传文件或填写私钥路径。',
    en: 'Key authentication needs a private key: upload a file or give a path.',
  },
  'api.passwordRequired': {
    zh: '口令认证需要输入密码（编辑时留空表示保持原密码）。',
    en: 'Password authentication needs a password (leave it blank when editing to keep the current one).',
  },
  'api.removeAliasRequired': {
    zh: '缺少别名。',
    en: 'Alias is missing.',
  },
  'api.hostNotFound': {
    zh: '保险库中没有名为 {alias} 的主机。',
    en: 'No host named {alias} in the vault.',
  },
  'api.openFolderFailed': {
    zh: '无法打开保险库目录：{message}',
    en: 'Could not open the vault directory: {message}',
  },
  'api.unknownAction': {
    zh: '未知操作：{action}',
    en: 'Unknown action: {action}',
  },
  'api.methodPostOnly': {
    zh: '只接受 POST。',
    en: 'Only POST is accepted.',
  },
  'api.routeUnknown': {
    zh: '未知路由。',
    en: 'Unknown route.',
  },
  'api.bodyInvalid': {
    zh: '请求体不是合法 JSON 或超出大小限制。',
    en: 'The request body is not valid JSON or exceeds the size limit.',
  },

  // —— 后台任务 ——
  'bg.cancelled': {
    zh: '调用被取消；本地客户端已结束，远端命令是否仍在运行无法从本机判断',
    en: 'The call was cancelled; the local client has exited, but whether the remote command still runs cannot be determined from here',
  },
  'bg.transportFailed': {
    zh: 'SSH 连接层失败（本地客户端退出码 255）；远端命令是否已启动、是否仍在运行都无法从本机判断',
    en: 'The SSH transport failed (local client exit code 255); from here it cannot be determined whether the remote command started or still runs',
  },
  'bg.remoteExit': {
    zh: '远端退出码 {code}',
    en: 'Remote exit code {code}',
  },

  // —— 保险库自身 ——
  'vault.dpapiTimeout': {
    zh: 'DPAPI 调用超时（15s）',
    en: 'The DPAPI call timed out (15s)',
  },
  'vault.dpapiFailed': {
    zh: 'DPAPI 调用失败（exit {code}）：{output}',
    en: 'The DPAPI call failed (exit {code}): {output}',
  },
  'vault.noOutput': {
    zh: '无输出',
    en: 'no output',
  },
  'vault.masterPasswordMissing': {
    zh: 'SSH 保险库由主口令保护，但插件配置缺少 masterPassword；请在 cordis.patch.yml 的 ssh-vault 行中补上 masterPassword 后重试。',
    en: 'The SSH vault is protected by a master password, but the plugin config has no masterPassword; add it to the ssh-vault entry in cordis.patch.yml and retry.',
  },
  'vault.dpapiUnwrapFailed': {
    zh: 'SSH 保险库的数据密钥无法用 Windows DPAPI 解开（{message}）。'
      + '该密钥只能由创建它的 Windows 用户解开；若主机清单可以重建，删除 key.json 与 vault.json 后重新录入即可。',
    en: 'The SSH vault data key cannot be unwrapped with Windows DPAPI ({message}). '
      + 'Only the Windows user that created it can unwrap it; if the host list can be rebuilt, delete key.json and vault.json and enter the hosts again.',
  },
  'vault.masterPasswordRequired': {
    zh: 'keyProtection 为 passphrase 时必须提供 masterPassword。',
    en: 'keyProtection "passphrase" requires masterPassword.',
  },
  'vault.dpapiUnavailable': {
    zh: 'ssh-vault: Windows DPAPI 不可用（{message}），数据密钥将以明文文件保存，安全边界降级为文件系统权限。',
    en: 'ssh-vault: Windows DPAPI is unavailable ({message}); the data key will be stored as a plaintext file and the security boundary degrades to filesystem permissions.',
  },
  'vault.decryptFailed': {
    zh: 'SSH 保险库解密失败：密文与当前数据密钥不匹配，或文件已被篡改。若主机清单可以重建，删除 vault.json 后重新录入。',
    en: 'Decrypting the SSH vault failed: the ciphertext does not match the current data key, or the file was tampered with. If the host list can be rebuilt, delete vault.json and enter the hosts again.',
  },

  // —— 平台支持 ——
  'platform.unsupported': {
    zh: 'dsh-ssh-vault 仅支持 Windows，当前平台是 {platform}（{raw}）。'
      + '插件依赖 Windows DPAPI 保护数据密钥、并使用 Windows 的 askpass 包装器，'
      + '非 Windows 上继续运行只会把密钥退化成明文文件。请在 Windows 上运行 DSH。',
    en: 'dsh-ssh-vault supports Windows only; the current platform is {platform} ({raw}). '
      + 'It relies on Windows DPAPI to protect the data key and on the Windows askpass wrapper; '
      + 'running elsewhere would only degrade the key to a plaintext file. Run DSH on Windows.',
  },
}

/** 合并后的完整字典。 */
const MESSAGES = { ...CORE_MESSAGES, ...SSH_MESSAGES }

/**
 * 取一条文本。
 * @param key - 字典键。
 * @param vars - 需要替换的 `{name}` 占位符。
 * @param locale - 强制使用的 locale；省略则用当前值。
 * @returns 该 locale 下的文本，缺失时回退中文，再回退键名。
 */
export function t(key, vars = {}, locale = currentLocale) {
  const entry = MESSAGES[key]
  if (entry === undefined) return key
  const template = entry[locale] ?? entry.zh ?? key
  return template.replace(/\{(\w+)\}/g, (match, name) => (vars[name] === undefined ? match : String(vars[name])))
}

/**
 * 该键是否有任何文案（测试与静态检查用）。
 * @param key - 字典键。
 * @returns 是否存在。
 */
export function hasMessage(key) {
  return Object.prototype.hasOwnProperty.call(MESSAGES, key)
}

/**
 * 列出所有字典键（测试用）。
 * @returns 键名数组。
 */
export function messageKeys() {
  return Object.keys(MESSAGES)
}

/**
 * 测试专用：把进程内状态恢复到「没有收到任何信号」。
 */
export function resetLocaleForTests() {
  currentLocale = DEFAULT_LOCALE
  explicitPreference = false
  listeners.clear()
}
