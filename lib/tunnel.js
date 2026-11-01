/**
 * SSH 本地端口转发引擎 —— 把 `ssh -N -L` 的生命周期管起来。
 *
 * 为什么单独一层：`ssh -L` 里「连上了」和「转发成功」是两件事。进程还活着不代表本地端口
 * 已经可用——服务器侧 AllowTcpForwarding/PermitOpen 拒绝时，ssh 可能先建立连接、再在
 * 申请通道时报 `administratively prohibited`；也可能直接退出。因此这里同时做三件事：
 *
 *   1. 启动前用 `net.createServer().listen()` 探测本地端口是否空闲，避免把 EADDRINUSE
 *      误报成服务器问题；
 *   2. 启动后观察一小段 stderr，出现转发被拒/认证失败就立即收摊，并把 stderr 原文带出；
 *   3. 进程意外退出时按指数退避重连，把 dropped / reconnecting / exited 交给 onEvent。
 *
 * 口令注入沿用 lib/ssh.js 的 askpass 方案：口令只进子进程环境变量
 * （SSH_ASKPASS、SSH_ASKPASS_REQUIRE=force、DSH_SSH_ASKPASS_SECRET），不进命令行、不落盘。
 *
 * 零依赖：只用 node:child_process 与 node:net。
 *
 * @module dsh-ssh-vault/tunnel
 */

import { spawn as spawnChild } from 'node:child_process'
import { createServer } from 'node:net'

/** AllowTcpForwarding 的合法取值（见 sshd_config(5)）。 */
const ALLOW_TCP_FORWARDING_VALUES = ['yes', 'no', 'all', 'local', 'remote']

/** sshd 配置里与本地转发有关的指令键名（小写）。 */
const FORWARDING_DIRECTIVE_KEYS = ['allowtcpforwarding', 'permitopen', 'gatewayports']

/** 默认的建立观察窗口（毫秒）：这段时间内 stderr 出现失败特征就判定建立失败。 */
const DEFAULT_ESTABLISH_MS = 900

/** 本地端口预检的超时（毫秒）。 */
const PORT_PROBE_TIMEOUT_MS = 1500

/** 重连退避的基线延迟与单次上限（毫秒）。 */
const DEFAULT_RECONNECT_BASE_MS = 500
const RECONNECT_MAX_DELAY_MS = 8000

/** 单次掉线默认最多重连几次。 */
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 5

/** 每条隧道保留的 stderr 上限（字符），避免长连接把内存吃满。 */
const STDERR_LIMIT = 4000

/** 终止子进程时最多等这么久（毫秒），兜底防止 dispose 被挂住。 */
const TERMINATE_GRACE_MS = 1500

/**
 * 观察窗内出现这些字样，说明转发根本建不起来，不必再等满窗口。
 *
 * `administratively prohibited` 是 sshd 拒绝通道申请的原文；`Cannot listen to port`
 * 是本地绑定失败；`Permission denied` / `Host key verification failed` 是认证与信任问题。
 */
const ESTABLISH_FAILURE_RE = /administratively prohibited|remote port forwarding failed|administratively|cannot listen to port|address already in use|permission denied|host key verification failed|could not resolve hostname|connection refused|connection timed out|no route to host|network is unreachable/i

/** 这些失败重试也不会变好（服务器策略或凭据问题），直接放弃重连。 */
const NON_RETRYABLE_RE = /administratively prohibited|remote port forwarding failed|cannot listen to port|address already in use|permission denied|host key verification failed/i

/**
 * 把端口字段解析成 1..65535 的整数。
 * @param text - 原始字段（字符串或数字）。
 * @param label - 出错时用于说明这是哪个端口的中文标签。
 * @returns 端口整数。
 */
function parsePort(text, label) {
  const trimmed = String(text ?? '').trim()
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`${label}「${trimmed}」不是整数：端口必须是 1 到 65535 之间的整数。`)
  }
  const port = Number(trimmed)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${label}「${trimmed}」超出范围：端口必须是 1 到 65535 之间的整数。`)
  }
  return port
}

/**
 * 校验主机/地址字段。
 *
 * 只接受 IPv4 或主机名：IPv6 字面量在转发规则里需要 `[::1]:port` 形式的方括号，
 * 会把「按冒号切段」的解析规则搅乱，因此明确报错而不是猜。
 *
 * @param value - 原始字段。
 * @param label - 出错时用于说明这是哪个字段的中文标签。
 * @returns 去掉首尾空白后的主机字符串。
 */
function assertHost(value, label) {
  const host = String(value ?? '').trim()
  if (host.length === 0) throw new Error(`${label}为空：转发规则里必须写明主机。`)
  if (/[\s]/.test(host)) throw new Error(`${label}「${host}」含有空白字符，不像是主机名或 IP。`)
  if (host.includes(':') || host.includes('[') || host.includes(']')) {
    throw new Error(`${label}「${host}」包含冒号或方括号（IPv6 字面量）：当前实现只支持 IPv4 或主机名。`)
  }
  return host
}

/**
 * 解析一条本地转发规则。
 *
 * 支持两种写法（与 `ssh -L` 一致）：
 *   - 3 段 `本地端口:远端主机:远端端口`，本地地址默认 127.0.0.1；
 *   - 4 段 `本地地址:本地端口:远端主机:远端端口`。
 *
 * @param spec - 转发规则文本，例如 `18787:127.0.0.1:8787`。
 * @returns 归一化后的转发规则 `{localPort, localHost, remoteHost, remotePort}`。
 * @throws {Error} 规则为空、段数不对、端口越界、主机为空时抛出带中文说明的错误。
 */
export function parseForward(spec) {
  if (typeof spec !== 'string' || spec.trim().length === 0) {
    throw new Error('本地转发规则不能为空：请写成「本地端口:远端主机:远端端口」或「本地地址:本地端口:远端主机:远端端口」。')
  }
  const text = spec.trim()
  // 方括号形式的 IPv6 字面量（[::1]:…）按冒号切段会被切碎，先明确拒绝而不是给出误导性的格式错误。
  if (text.includes('[') || text.includes(']')) {
    throw new Error(`本地转发规则「${text}」包含方括号（IPv6 字面量）：当前实现只支持 IPv4 或主机名。`)
  }
  const parts = text.split(':')
  if (parts.length !== 3 && parts.length !== 4) {
    throw new Error(
      `本地转发规则「${text}」格式不正确：应为「本地端口:远端主机:远端端口」`
      + '或「本地地址:本地端口:远端主机:远端端口」。',
    )
  }
  const [localHostPart, localPortPart, remoteHostPart, remotePortPart] = parts.length === 3
    ? ['127.0.0.1', parts[0], parts[1], parts[2]]
    : parts
  return {
    localPort: parsePort(localPortPart, `本地转发规则「${text}」的本地端口`),
    localHost: assertHost(localHostPart, `本地转发规则「${text}」的本地地址`),
    remoteHost: assertHost(remoteHostPart, `本地转发规则「${text}」的远端主机`),
    remotePort: parsePort(remotePortPart, `本地转发规则「${text}」的远端端口`),
  }
}

/**
 * 归一化一条转发规则：既接受字符串写法，也接受已经解析好的对象。
 * @param item - 字符串规则或 `{localHost, localPort, remoteHost, remotePort}` 对象。
 * @returns 归一化后的规则对象。
 */
function normalizeForward(item) {
  if (typeof item === 'string') return parseForward(item)
  if (item !== null && typeof item === 'object') {
    return {
      localPort: parsePort(item.localPort, '本地转发规则的本地端口'),
      localHost: assertHost(
        typeof item.localHost === 'string' && item.localHost.trim().length > 0 ? item.localHost : '127.0.0.1',
        '本地转发规则的本地地址',
      ),
      remoteHost: assertHost(item.remoteHost, '本地转发规则的远端主机'),
      remotePort: parsePort(item.remotePort, '本地转发规则的远端端口'),
    }
  }
  throw new Error('本地转发规则必须是字符串（如「18787:127.0.0.1:8787」）或含 localPort/remoteHost/remotePort 的对象。')
}

/**
 * 把转发规则格式化成 `ssh -L` 的取值。
 * @param forward - 已解析的转发规则。
 * @returns 形如 `127.0.0.1:18787:127.0.0.1:8787` 的字符串。
 */
export function formatForward(forward) {
  return `${forward.localHost}:${forward.localPort}:${forward.remoteHost}:${forward.remotePort}`
}

/**
 * 转发规则对应的本地访问地址。
 *
 * 绑定 0.0.0.0 时本机仍要用 127.0.0.1 访问。scheme 用中性的 `tcp://`：远端端口跑的是
 * HTTP 还是数据库，这里无从判断，不能一律写 http。
 *
 * @param forward - 已解析的转发规则。
 * @returns 形如 `tcp://127.0.0.1:18787` 的地址。
 */
function localUrl(forward) {
  const host = forward.localHost === '0.0.0.0' ? '127.0.0.1' : forward.localHost
  return `tcp://${host}:${forward.localPort}`
}

/**
 * 组装认证选项，与 lib/ssh.js 的策略保持一致（口令优先、密钥只认指定文件）。
 * @param auth - 主机记录里的 auth 字段。
 * @returns 追加到命令行的选项数组。
 */
function authOptions(auth) {
  if (auth?.type === 'password') {
    return ['-o', 'PreferredAuthentications=password,keyboard-interactive', '-o', 'PubkeyAuthentication=no']
  }
  if (auth?.type === 'key') {
    return [
      ...(typeof auth.privateKeyPath === 'string' && auth.privateKeyPath.length > 0 ? ['-i', auth.privateKeyPath] : []),
      '-o', 'PreferredAuthentications=publickey',
      '-o', 'IdentitiesOnly=yes',
    ]
  }
  return []
}

/**
 * 构造把口令交给 askpass 的环境变量。
 *
 * 这是 lib/ssh.js 里同名逻辑的本地副本：那边是私有函数，而这里不改动既有文件。
 *
 * @param askpassPath - askpass 包装器路径。
 * @param secret - 本次连接使用的口令。
 * @returns 需要并入子进程环境的环境变量（没有口令时为空对象）。
 */
function askpassEnvironment(askpassPath, secret) {
  if (typeof secret !== 'string' || secret.length === 0) return {}
  if (typeof askpassPath !== 'string' || askpassPath.length === 0) return {}
  return {
    SSH_ASKPASS: askpassPath,
    SSH_ASKPASS_REQUIRE: 'force',
    DSH_SSH_ASKPASS_SECRET: secret,
  }
}

/**
 * 构造 `ssh -N -L …` 的参数数组。
 *
 * 关键选项：`-N`（不执行远端命令）、`ExitOnForwardFailure=yes`（转发建不起来就让进程退出，
 * 而不是挂着假装成功）、`ServerAliveInterval`（发现半死连接）。
 *
 * @param options - 构造参数。
 * @param options.record - 主机记录（host/port/username/auth）。
 * @param options.forwards - 转发规则数组，字符串或对象皆可。
 * @param options.knownHostsPath - 保险库私有的 known_hosts 路径。
 * @param options.connectTimeoutSec - 连接超时秒数，默认 10。
 * @param options.sshConfigFile - 可选的 `-F` 配置文件。
 * @param options.bindAddress - 可选的本地源地址（`-b`）。
 * @param options.sshExecutable - 仅用于与 start 的参数对象保持一致，不参与参数构造。
 * @returns 传给 ssh 的参数数组。
 */
export function buildTunnelArgs({
  record,
  forwards,
  knownHostsPath,
  connectTimeoutSec = 10,
  sshConfigFile,
  bindAddress,
  // sshExecutable 由调用方决定用哪个可执行文件，参数本身与它无关。
  sshExecutable: _sshExecutable,
}) {
  if (record === null || typeof record !== 'object') {
    throw new Error('缺少主机记录 record，无法构造本地转发参数。')
  }
  const specs = Array.isArray(forwards) ? forwards : (forwards === undefined ? [] : [forwards])
  if (specs.length === 0) {
    throw new Error('至少需要一个本地转发规则（forwards），例如「18787:127.0.0.1:8787」。')
  }
  const parsed = specs.map((spec) => normalizeForward(spec))
  return [
    '-N',
    '-T',
    ...(typeof sshConfigFile === 'string' && sshConfigFile.length > 0 ? ['-F', sshConfigFile] : []),
    '-o', `ConnectTimeout=${connectTimeoutSec}`,
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'HashKnownHosts=yes',
    ...(typeof knownHostsPath === 'string' && knownHostsPath.length > 0
      ? ['-o', `UserKnownHostsFile=${knownHostsPath}`]
      : []),
    '-o', 'NumberOfPasswordPrompts=1',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'LogLevel=ERROR',
    ...authOptions(record.auth),
    ...(typeof bindAddress === 'string' && bindAddress.length > 0 ? ['-b', bindAddress] : []),
    '-p', String(record.port ?? 22),
    ...parsed.flatMap((forward) => ['-L', formatForward(forward)]),
    '--',
    `${record.username}@${record.host}`,
  ]
}

/**
 * 生成远端 sshd 转发策略探针脚本。
 *
 * 取值顺序刻意写成三级回退：
 *   1. `sshd -T`（需要 root）—— 唯一能拿到「生效值」的方式；
 *   2. `sudo -n sshd -T`（要求免密 sudo）—— 普通账号下最常见的可用路径；
 *   3. 读 `/etc/ssh/sshd_config` 与 `sshd_config.d/*.conf` —— 只能看到「显式写出来的值」。
 *
 * 第 3 级的关键约束：CentOS 7 的 sshd_config 默认把 AllowTcpForwarding 注释掉，此时
 * 输出空值（由解析器判 unknown），绝不替用户编一个 yes 出来。
 *
 * 输出统一成标记行，便于调用方解析：
 *   `##source##sshd-T` / `##source##config`
 *   `##allowtcpforwarding##<值>`、`##permitopen##<值…>`、`##gatewayports##<值>`
 *
 * @returns 可直接交给远端 `sh -s` 的脚本字符串。
 */
export function buildSshdProbeCommand() {
  return `# 只回传结论，不把远端 sshd 配置整段带回来。
# sshd -T 需要 root：先试当前身份，失败再试 sudo -n（要求免密），两者都不行才回退读 sshd_config。
# 配置文件里被注释掉的指令（CentOS 7 默认如此）不会输出成值 —— 一律按 unknown 交给调用方判断。
dsh_tunnel_emit() {
  printf '%s\\n' "$1" | awk '
    tolower($1) == "allowtcpforwarding" { atf = $2 }
    tolower($1) == "permitopen" { for (i = 2; i <= NF; i++) po = (po == "" ? $i : po " " $i) }
    tolower($1) == "gatewayports" { gw = $2 }
    END {
      print "##allowtcpforwarding##" atf
      print "##permitopen##" po
      print "##gatewayports##" gw
    }'
}
dsh_tunnel_has_forwarding() {
  printf '%s\\n' "$1" | grep -qiE '^[[:space:]]*(allowtcpforwarding|permitopen|gatewayports)([[:space:]]|$)'
}
dsh_tunnel_sshd_t=""
if command -v sshd >/dev/null 2>&1; then
  dsh_tunnel_sshd_t=$(sshd -T 2>/dev/null) || dsh_tunnel_sshd_t=""
fi
if [ -z "$dsh_tunnel_sshd_t" ] && command -v sudo >/dev/null 2>&1; then
  dsh_tunnel_sshd_t=$(sudo -n sshd -T 2>/dev/null) || dsh_tunnel_sshd_t=""
fi
if [ -n "$dsh_tunnel_sshd_t" ] && dsh_tunnel_has_forwarding "$dsh_tunnel_sshd_t"; then
  echo '##source##sshd-T'
  dsh_tunnel_emit "$dsh_tunnel_sshd_t"
  exit 0
fi
echo '##source##config'
dsh_tunnel_raw=$(
  if [ -r /etc/ssh/sshd_config ]; then
    grep -iE '^[[:space:]]*(allowtcpforwarding|permitopen|gatewayports)([[:space:]]|$)' /etc/ssh/sshd_config 2>/dev/null
  fi
  for dsh_tunnel_dropin in /etc/ssh/sshd_config.d/*.conf; do
    [ -r "$dsh_tunnel_dropin" ] || continue
    grep -iE '^[[:space:]]*(allowtcpforwarding|permitopen|gatewayports)([[:space:]]|$)' "$dsh_tunnel_dropin" 2>/dev/null
  done
)
dsh_tunnel_emit "$dsh_tunnel_raw"
if [ -z "$dsh_tunnel_raw" ]; then
  echo '##note##sshd -T 不可用，且 sshd_config 里没有未注释的转发指令（CentOS 7 默认全部注释）；如需确证请用 root 执行 sshd -T。'
fi
exit 0
`
}

/**
 * 归一化 AllowTcpForwarding 的取值。
 * @param value - 原始值（可能带注释或大小写差异）。
 * @returns 合法取值之一，无法识别时为 `unknown`。
 */
function normalizeAllowTcpForwarding(value) {
  const first = String(value ?? '').trim().split(/\s+/)[0] ?? ''
  const cleaned = first.startsWith('#') ? '' : first.toLowerCase()
  return ALLOW_TCP_FORWARDING_VALUES.includes(cleaned) ? cleaned : 'unknown'
}

/**
 * 拆分 PermitOpen 的取值列表（一行多个值、多行合并都支持，忽略行尾注释）。
 * @param value - 原始值。
 * @returns 取值数组。
 */
function splitPermitOpen(value) {
  const tokens = []
  for (const token of String(value ?? '').trim().split(/\s+/)) {
    if (token.length === 0) continue
    if (token.startsWith('#')) break
    tokens.push(token)
  }
  return tokens
}

/**
 * 解析 sshd 转发策略探针的输出。
 *
 * 同时吃两种输入，因为探针本身也允许人工执行后把结果贴回来：
 *   - 探针的标记行：`##allowtcpforwarding##no`；
 *   - 原始指令行：`sshd -T` 的小写 `allowtcpforwarding no`，或 sshd_config 的
 *     `AllowTcpForwarding no`（大小写不敏感，允许前导空白）。
 *
 * 注意 `local` 对 `-L` 来说是允许的，只有 `no` 与 `remote` 才拒绝本地转发。
 *
 * @param text - 探针输出或 sshd 配置片段。
 * @returns `{allowTcpForwarding, permitOpen, source}`；无法判定时值分别为 unknown / [] / unknown。
 */
export function parseSshdForwarding(text) {
  const result = { allowTcpForwarding: 'unknown', permitOpen: [], source: 'unknown' }
  if (typeof text !== 'string' || text.trim().length === 0) return result

  const permitOpen = []
  let sourceFromMarker
  let sawMarker = false
  let sawSshdTStyle = false
  let sawConfigStyle = false

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0) continue

    const marker = /^##([A-Za-z]+)##(.*)$/.exec(line)
    if (marker !== null) {
      const key = marker[1].toLowerCase()
      const value = marker[2].trim()
      if (key === 'source') {
        const lowered = value.toLowerCase()
        if (lowered === 'sshd-t') sourceFromMarker = 'sshd-T'
        else if (lowered === 'config') sourceFromMarker = 'config'
        continue
      }
      // note 之类的人读提示不参与结论。
      if (key === 'note') continue
      sawMarker = true
      if (key === 'allowtcpforwarding') {
        const parsed = normalizeAllowTcpForwarding(value)
        if (parsed !== 'unknown') result.allowTcpForwarding = parsed
      } else if (key === 'permitopen') {
        permitOpen.push(...splitPermitOpen(value))
      }
      continue
    }

    // 注释行必须忽略：CentOS 7 默认就是「#AllowTcpForwarding yes」这种形态，
    // 把它当成 yes 会给用户一个假的结论。
    if (line.startsWith('#')) continue

    const directive = /^([A-Za-z][A-Za-z0-9]*)[ \t]+(.*)$/.exec(line)
    if (directive === null) continue
    const key = directive[1].toLowerCase()
    if (!FORWARDING_DIRECTIVE_KEYS.includes(key)) continue
    // sshd -T 的键名是小写的；sshd_config 里的指令习惯上首字母大写。用这个差异判来源。
    if (directive[1] === directive[1].toLowerCase()) sawSshdTStyle = true
    else sawConfigStyle = true
    if (key === 'allowtcpforwarding') {
      const parsed = normalizeAllowTcpForwarding(directive[2])
      if (parsed !== 'unknown') result.allowTcpForwarding = parsed
    } else if (key === 'permitopen') {
      permitOpen.push(...splitPermitOpen(directive[2]))
    }
  }

  result.permitOpen = [...new Set(permitOpen)]
  result.source = sourceFromMarker
    ?? (sawMarker || sawSshdTStyle ? 'sshd-T' : sawConfigStyle ? 'config' : 'unknown')
  return result
}

/**
 * 根据远端转发策略生成给用户看的修复建议。
 *
 * 设计原则：只有 `no`/`remote` 才给出「阻断」结论；`local`/`yes`/`all` 允许本地转发时不
 * 制造焦虑。`unknown` 给出核实路径，而不是替用户假设一个值。
 *
 * 最关键的修复指引是 `Match User`：绝大多数生产机不允许全局放开 AllowTcpForwarding，
 * 但可以按账号在 Match 段里放行本地转发。这是唯一既安全又能解决问题的做法。
 *
 * @param config - `parseSshdForwarding` 的结果，可额外带 `user`（账号名）。
 * @returns 中文建议行数组；完全没必要时为空数组。
 */
export function diagnoseForwarding(config = {}) {
  const allow = normalizeAllowTcpForwarding(config?.allowTcpForwarding)
  const permitOpen = Array.isArray(config?.permitOpen)
    ? config.permitOpen.filter((token) => typeof token === 'string' && token.length > 0)
    : []
  const user = typeof config?.user === 'string' && config.user.trim().length > 0 ? config.user.trim() : '<账号>'
  const sourceLabel = config?.source === 'sshd-T'
    ? 'sshd -T 的生效配置'
    : config?.source === 'config'
      ? '/etc/ssh/sshd_config 的显式配置'
      : '远端配置（来源未知）'
  const notes = []

  if (allow === 'no' || allow === 'remote') {
    notes.push(`服务器禁止本地转发：AllowTcpForwarding=${allow}（来自 ${sourceLabel}），所以 ssh -L 的通道申请会被拒绝，stderr 常见 "administratively prohibited"。`)
    notes.push(
      `不要全局改 AllowTcpForwarding：在 /etc/ssh/sshd_config 末尾追加「Match User ${user}」段，`
      + '段内写 AllowTcpForwarding local（只放开本地转发）；ssh 客户端侧的对应开关是 LocalForwarding，'
      + '如果它被写成了 no 也要一起改成 yes。',
    )
    notes.push(`如果这个账号只需要访问特定目标，在同一个 Match User ${user} 段里用 PermitOpen <主机>:<端口> 限定范围，比全局 AllowTcpForwarding yes 安全得多。`)
    notes.push('改完先执行 sshd -t 校验语法，再 systemctl reload sshd（RHEL/CentOS）或 systemctl reload ssh（Debian/Ubuntu）；sshd 不会自己重读配置。')
    notes.push('服务器配置改不了时的替代路径：让服务端主动连回来（ssh -R 反向隧道），或请运维代开一条转发。')
  } else if (allow === 'unknown') {
    notes.push('无法从远端确认 AllowTcpForwarding：解析 sshd -T 需要 root（或 sudo -n 免密），回退读取的 /etc/ssh/sshd_config 也可能不可读，或者该指令被注释掉（CentOS 7 默认就是注释状态）。')
    notes.push('「被注释掉」既不等于是 yes 也不等于是 no：请用 root 执行 `sshd -T | grep -iE "allowtcpforwarding|permitopen"` 拿到生效值；在拿到之前可以用一次真实连接验证。')
  } else {
    const tightened = permitOpen.filter((token) => token.toLowerCase() !== 'any')
    if (tightened.length > 0) {
      // 允许本地转发，但 PermitOpen 限定了目标；不阻断，只提示可能的失败点。
      notes.push(`本地转发已允许（AllowTcpForwarding=${allow}），但服务器用 PermitOpen 限定了可连接目标：${tightened.join('、')}；目标不在列表里时转发仍会被拒绝。`)
    }
  }
  return notes
}

/**
 * 探测本地端口能否监听。
 *
 * 用真实的 `listen()` 而不是查表：只有内核知道端口是否被占用。listener 用
 * `exclusive: true`（避免 SO_REUSEADDR 让占用中的端口看起来可用），探完在 close 回调里
 * 才 resolve——端口真正释放后再启动 ssh，否则会自己撞上自己。
 *
 * @param host - 本地地址，例如 127.0.0.1。
 * @param port - 本地端口。
 * @param timeoutMs - 探测超时，默认 1500ms。
 * @returns `{available, code, message}`；available 为 false 时 code 是 Node 的错误码。
 */
export function probeLocalPort(host, port, timeoutMs = PORT_PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false
    let timer
    const server = createServer()
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        server.close()
      } catch {
        // 尚未 listen 或已经关掉，忽略。
      }
      resolve(result)
    }
    server.once('error', (error) => finish({
      available: false,
      code: error.code,
      message: error instanceof Error ? error.message : String(error),
    }))
    server.once('listening', () => {
      // 真正 close 之后再 resolve：否则紧接着启动 ssh 时可能仍然 EADDRINUSE。
      server.close(() => finish({ available: true, code: undefined, message: '' }))
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
    })
    timer = setTimeout(
      () => finish({ available: false, code: 'ETIMEDOUT', message: `端口探测超时（${timeoutMs}ms）` }),
      Math.max(1, timeoutMs),
    )
    try {
      server.listen({ port, host, exclusive: true })
    } catch (error) {
      finish({ available: false, code: error?.code, message: error instanceof Error ? error.message : String(error) })
    }
  })
}

/**
 * 追加并截断 stderr 缓冲（保留末尾，因为最近的错误最有诊断价值）。
 * @param current - 已有文本。
 * @param chunk - 新到的文本。
 * @param limit - 最大保留字符数。
 * @returns 截断后的文本。
 */
function appendBounded(current, chunk, limit) {
  const next = current + chunk
  return next.length <= limit ? next : next.slice(next.length - limit)
}

/**
 * 取文本末尾的若干非空行，用于把 stderr 原文带进错误消息。
 * @param text - 原始文本。
 * @param maxLines - 最多保留几行。
 * @returns 用换行连接的末尾若干行。
 */
function tailLines(text, maxLines) {
  const lines = String(text ?? '')
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
  return lines.slice(-maxLines).join('\n')
}

/**
 * 生成「stderr 表明转发建不起来」的错误对象。
 * @param entry - 隧道条目。
 * @returns 带 stderr 原文与错误码的 Error。
 */
function establishError(entry) {
  const detail = tailLines(entry.stderr, 6)
  const policyRefused = NON_RETRYABLE_RE.test(entry.stderr)
  const error = new Error(
    `ssh 无法建立本地转发：${detail.length > 0 ? detail : '（ssh 没有输出具体原因）'}`
    + (policyRefused
      ? '\n提示：这通常来自服务器 sshd 的 AllowTcpForwarding / PermitOpen 限制，可用 diagnoseForwarding() 生成修复建议。'
      : ''),
  )
  error.code = policyRefused ? 'TUNNEL_FORWARDING_REFUSED' : 'TUNNEL_ESTABLISH_FAILED'
  error.stderr = entry.stderr
  return error
}

/**
 * 生成「ssh 进程在建立阶段退出」的错误对象。
 * @param entry - 隧道条目。
 * @param code - 退出码。
 * @param signal - 终止信号。
 * @returns 带 stderr 原文的错误。
 */
function exitError(entry, code, signal) {
  const detail = tailLines(entry.stderr, 4)
  const error = new Error(
    `ssh 进程在建立隧道时退出（code=${code ?? 'null'}${signal ? `，signal=${signal}` : ''}）`
    + (detail.length > 0 ? `：${detail}` : ''),
  )
  error.code = 'TUNNEL_ESTABLISH_FAILED'
  error.stderr = entry.stderr
  return error
}

/**
 * 本地端口转发的生命周期管理器。
 *
 * 一个实例管理多条隧道：`start` 返回隧道 id 与本地访问地址，`stop` 按 id 收摊，
 * `list` 看状态，`dispose` 一次性清空（等所有子进程真正退出后才 resolve）。
 */
export class TunnelManager {
  /** 隧道表：id → 条目。 */
  #entries = new Map()
  /** 递增序号，用于生成 id。 */
  #sequence = 0
  /** ssh 可执行文件。 */
  #sshExecutable
  /** 生命周期事件回调。 */
  #onEvent
  /** 子进程工厂（测试时可替换）。 */
  #spawnProcess
  /** 建立观察窗口（毫秒）。 */
  #establishMs
  /** 重连退避基线（毫秒）。 */
  #reconnectBaseMs
  /** 单次掉线最多重连次数。 */
  #maxReconnectAttempts
  /** 是否已经 dispose。 */
  #disposed = false

  /**
   * @param options - 构造参数。
   * @param options.sshExecutable - ssh 可执行文件，默认 `ssh`。
   * @param options.onEvent - 生命周期事件回调 `({type, id, detail}) => void`；抛错会被吞掉。
   * @param options.spawnProcess - 子进程工厂，默认 `child_process.spawn`；仅供测试替换。
   * @param options.establishMs - 建立观察窗口（毫秒），默认 900。
   * @param options.reconnectBaseMs - 重连退避基线（毫秒），默认 500。
   * @param options.maxReconnectAttempts - 单次掉线最多重连几次，默认 5。
   */
  constructor({
    sshExecutable = 'ssh',
    onEvent,
    spawnProcess = spawnChild,
    establishMs = DEFAULT_ESTABLISH_MS,
    reconnectBaseMs = DEFAULT_RECONNECT_BASE_MS,
    maxReconnectAttempts = DEFAULT_MAX_RECONNECT_ATTEMPTS,
  } = {}) {
    this.#sshExecutable = typeof sshExecutable === 'string' && sshExecutable.length > 0 ? sshExecutable : 'ssh'
    this.#onEvent = typeof onEvent === 'function' ? onEvent : undefined
    this.#spawnProcess = typeof spawnProcess === 'function' ? spawnProcess : spawnChild
    this.#establishMs = Number.isFinite(establishMs) ? Math.max(0, establishMs) : DEFAULT_ESTABLISH_MS
    this.#reconnectBaseMs = Number.isFinite(reconnectBaseMs) ? Math.max(1, reconnectBaseMs) : DEFAULT_RECONNECT_BASE_MS
    this.#maxReconnectAttempts = Number.isFinite(maxReconnectAttempts)
      ? Math.max(0, Math.floor(maxReconnectAttempts))
      : DEFAULT_MAX_RECONNECT_ATTEMPTS
  }

  /**
   * 启动一条本地转发隧道。
   *
   * 流程：解析规则 → 逐个预检本地端口 → spawn ssh → 观察 stderr 一个短窗口。
   * 端口被占用、认证失败、转发被服务器拒绝都会直接抛错（错误消息里带中文说明与 stderr 原文）。
   *
   * @param spec - 启动参数。
   * @param spec.record - 主机记录。
   * @param spec.secret - 本次连接的口令；没有口令（密钥认证）时可省略。
   * @param spec.askpassPath - askpass 包装器路径（口令认证必填）。
   * @param spec.knownHostsPath - 保险库私有的 known_hosts 路径。
   * @param spec.connectTimeoutSec - 连接超时秒数。
   * @param spec.sshConfigFile - 可选的 `-F` 配置文件。
   * @param spec.bindAddress - 可选的本地源地址。
   * @param spec.forwards - 转发规则数组，例如 `['18787:127.0.0.1:8787']`。
   * @param spec.label - 展示用标签，默认用主机别名。
   * @returns `{id, forwards, localUrls, pid}`。
   * @throws {Error} 规则非法、端口被占用、ssh 建立失败时抛出。
   */
  async start({
    record,
    secret,
    askpassPath,
    knownHostsPath,
    connectTimeoutSec = 10,
    sshConfigFile,
    bindAddress,
    forwards,
    label,
  } = {}) {
    if (this.#disposed) throw new Error('TunnelManager 已经 dispose，不能继续启动新隧道；请重新创建实例。')
    if (record === null || typeof record !== 'object') {
      throw new Error('缺少主机记录 record，无法启动本地转发隧道。')
    }
    const specs = Array.isArray(forwards) ? forwards : (forwards === undefined ? [] : [forwards])
    if (specs.length === 0) {
      throw new Error('至少需要一个本地转发规则（forwards），例如「18787:127.0.0.1:8787」。')
    }
    const parsedForwards = specs.map((spec) => normalizeForward(spec))

    // 预检：本地端口被占时，ssh 只会报 bind 失败（容易误判成服务器问题），所以在启动前拦下来。
    for (const forward of parsedForwards) {
      const probe = await probeLocalPort(forward.localHost, forward.localPort, PORT_PROBE_TIMEOUT_MS)
      if (probe.available) continue
      const error = probe.code === 'EADDRINUSE'
        ? new Error(`本地端口 ${forward.localHost}:${forward.localPort} 已被占用，无法建立隧道；请换一个本地端口，或先停掉占用它的进程。`)
        : new Error(`本地端口 ${forward.localHost}:${forward.localPort} 无法监听（${probe.code ?? 'UNKNOWN'}）：${probe.message}`)
      error.code = probe.code ?? 'ELISTENFAILED'
      throw error
    }

    const id = `tunnel-${++this.#sequence}`
    const entry = {
      id,
      label: typeof label === 'string' && label.length > 0 ? label : (record.alias ?? id),
      record,
      spec: { record, forwards: parsedForwards, knownHostsPath, connectTimeoutSec, sshConfigFile, bindAddress },
      forwards: parsedForwards,
      secret,
      askpassPath,
      child: undefined,
      pid: null,
      status: 'starting',
      stderr: '',
      fatal: false,
      stopped: false,
      established: false,
      exitHandled: false,
      attempts: 0,
      timer: undefined,
      lastError: undefined,
    }
    this.#entries.set(id, entry)
    const launched = await this.#launch(entry)
    if (!launched.ok) {
      this.#entries.delete(id)
      entry.stopped = true
      throw launched.error
    }
    return {
      id,
      forwards: parsedForwards.map(formatForward),
      localUrls: parsedForwards.map(localUrl),
      pid: entry.pid ?? null,
    }
  }

  /**
   * 停止并移除一条隧道。
   * @param spec - `{id}`。
   * @returns `{stopped, id}`；id 不存在时 stopped 为 false，不抛异常。
   */
  async stop({ id } = {}) {
    const entry = this.#entries.get(id)
    if (entry === undefined) return { stopped: false, id }
    entry.stopped = true
    entry.status = 'stopped'
    if (entry.timer !== undefined) {
      clearTimeout(entry.timer)
      entry.timer = undefined
    }
    this.#entries.delete(id)
    await this.#terminate(entry.child)
    entry.child = undefined
    entry.pid = null
    return { stopped: true, id }
  }

  /**
   * 列出当前所有隧道（含已掉线、正在重连、已放弃的）。
   * @returns 只含可序列化字段的快照数组。
   */
  list() {
    return [...this.#entries.values()].map((entry) => ({
      id: entry.id,
      label: entry.label,
      status: entry.status,
      forwards: entry.forwards.map(formatForward),
      localUrls: entry.forwards.map(localUrl),
      pid: entry.pid ?? null,
      attempts: entry.attempts,
      lastError: entry.lastError,
    }))
  }

  /**
   * 停掉并清空所有隧道；Promise 在所有子进程确实退出后才 resolve。
   * @returns 被清理的隧道条数。
   */
  async dispose() {
    this.#disposed = true
    const entries = [...this.#entries.values()]
    this.#entries.clear()
    for (const entry of entries) {
      entry.stopped = true
      entry.status = 'stopped'
      if (entry.timer !== undefined) {
        clearTimeout(entry.timer)
        entry.timer = undefined
      }
    }
    await Promise.all(entries.map((entry) => this.#terminate(entry.child)))
    for (const entry of entries) {
      entry.child = undefined
      entry.pid = null
    }
    return entries.length
  }

  /**
   * 拉起一次 ssh 子进程，并等待「建立成功 / 立即失败」的结论。
   * @param entry - 隧道条目。
   * @returns `{ok:true}` 或 `{ok:false, error}`。
   */
  async #launch(entry) {
    entry.exitHandled = false
    entry.fatal = false
    entry.status = 'starting'
    entry.stderr = ''
    let child
    try {
      child = this.#spawnProcess(this.#sshExecutable, buildTunnelArgs(entry.spec), {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env, ...askpassEnvironment(entry.askpassPath, entry.secret) },
      })
    } catch (error) {
      const wrapped = new Error(
        `无法启动 ssh 进程（${this.#sshExecutable}）：${error instanceof Error ? error.message : String(error)}`,
      )
      wrapped.cause = error
      return { ok: false, error: wrapped }
    }
    entry.child = child
    entry.pid = typeof child.pid === 'number' ? child.pid : null
    const watch = await this.#watchEstablishment(entry)
    if (!watch.ok) {
      await this.#terminate(entry.child)
      return watch
    }
    entry.established = true
    entry.status = 'running'
    entry.attempts = 0
    return { ok: true }
  }

  /**
   * 观察新子进程的建立阶段：stderr 出现失败特征、进程提前退出、或窗口期满仍然存活。
   *
   * 窗口期满仍然存活就认为转发已建立——`ExitOnForwardFailure=yes` 保证真正的失败会让
   * 进程退出，所以「活着」在这里是可信信号；但 ftp 之外的策略拒绝可能只出现在 stderr
   * 而不伴随退出，因此必须同时看 stderr。
   *
   * @param entry - 隧道条目（entry.child 已就位）。
   * @returns Promise，resolve 为 `{ok:true}` 或 `{ok:false, error}`。
   */
  #watchEstablishment(entry) {
    return new Promise((resolve) => {
      const child = entry.child
      let settled = false
      let timer
      const settle = (result) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(result)
      }
      const onStderr = (chunk) => {
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
        entry.stderr = appendBounded(entry.stderr, text, STDERR_LIMIT)
        if (!ESTABLISH_FAILURE_RE.test(entry.stderr)) return
        entry.fatal = NON_RETRYABLE_RE.test(entry.stderr) || entry.fatal
        settle({ ok: false, error: establishError(entry) })
      }
      if (child.stderr !== null && child.stderr !== undefined && typeof child.stderr.on === 'function') {
        try {
          child.stderr.setEncoding?.('utf8')
        } catch {
          // 流可能已结束，忽略。
        }
        child.stderr.on('data', onStderr)
      }
      const onExit = (code, signal) => {
        if (!settled) {
          settle({ ok: false, error: exitError(entry, code, signal) })
          return
        }
        if (entry.established) this.#handleExit(entry, code, signal)
      }
      child.once('exit', onExit)
      // close 是 exit 之后的兜底：个别平台上 stdio 可能先于事件被回收。
      child.once('close', (code) => {
        if (!settled) {
          settle({ ok: false, error: exitError(entry, code ?? null, null) })
          return
        }
        if (entry.established) this.#handleExit(entry, code ?? null, null)
      })
      child.once('error', (error) => {
        const text = error instanceof Error ? error.message : String(error)
        entry.stderr = appendBounded(entry.stderr, `无法启动 ssh：${text}\n`, STDERR_LIMIT)
        if (!settled) {
          const wrapped = new Error(`无法启动 ssh 进程（${this.#sshExecutable}）：${text}`)
          wrapped.cause = error
          wrapped.stderr = entry.stderr
          settle({ ok: false, error: wrapped })
        }
      })
      timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          settle({ ok: true })
        } else {
          settle({ ok: false, error: exitError(entry, child.exitCode, child.signalCode) })
        }
      }, this.#establishMs)
    })
  }

  /**
   * 处理「已经建立成功之后」的进程退出。
   * @param entry - 隧道条目。
   * @param code - 退出码。
   * @param signal - 终止信号。
   */
  #handleExit(entry, code, signal) {
    if (entry.exitHandled) return
    entry.exitHandled = true
    entry.child = undefined
    entry.pid = null
    if (entry.stopped) return
    const detail = entry.stderr.trim().length > 0
      ? `ssh 进程意外退出（code=${code ?? 'null'}${signal ? `，signal=${signal}` : ''}）：${tailLines(entry.stderr, 4)}`
      : `ssh 进程意外退出（code=${code ?? 'null'}${signal ? `，signal=${signal}` : ''}）`
    entry.status = 'exited'
    entry.lastError = detail
    this.#emit(entry, 'dropped', detail)
    if (entry.fatal) {
      this.#emit(entry, 'exited', detail)
      return
    }
    this.#scheduleReconnect(entry)
  }

  /**
   * 安排下一次重连（指数退避：base、2×base、4×base…，单次不超过 8s）。
   * @param entry - 隧道条目。
   */
  #scheduleReconnect(entry) {
    if (entry.stopped || this.#disposed) return
    if (entry.attempts >= this.#maxReconnectAttempts) {
      entry.status = 'exited'
      this.#emit(entry, 'exited', entry.lastError ?? '重连次数已用尽，隧道已放弃')
      return
    }
    entry.attempts += 1
    const delay = Math.min(this.#reconnectBaseMs * (2 ** (entry.attempts - 1)), RECONNECT_MAX_DELAY_MS)
    entry.status = 'reconnecting'
    entry.timer = setTimeout(() => {
      entry.timer = undefined
      this.#reconnect(entry).catch(() => {
        // 重连内部已把失败写进 entry.status / lastError；这里只保证不产生未处理的 rejection。
      })
    }, delay)
  }

  /**
   * 执行一次重连尝试。
   * @param entry - 隧道条目。
   */
  async #reconnect(entry) {
    if (entry.stopped || this.#disposed || this.#entries.get(entry.id) !== entry) return
    this.#emit(entry, 'reconnecting', `第 ${entry.attempts}/${this.#maxReconnectAttempts} 次重连本地转发隧道`, {
      attempt: entry.attempts,
      delayMs: this.#reconnectBaseMs * (2 ** (entry.attempts - 1)),
    })
    entry.established = false
    const launched = await this.#launch(entry)
    if (launched.ok) return
    entry.established = false
    entry.status = 'exited'
    entry.lastError = launched.error instanceof Error ? launched.error.message : String(launched.error)
    if (entry.fatal) {
      this.#emit(entry, 'exited', entry.lastError)
      return
    }
    this.#scheduleReconnect(entry)
  }

  /**
   * 杀掉一个子进程并等它真的退出。
   *
   * Windows 上 `kill()` 走 TerminateProcess，通常立刻就没了；但真机上仍可能短暂存活，
   * 因此 300ms 后补一次 SIGKILL，并以 1.5s 为硬上限——dispose 不能因为一个不听话的
   * 子进程永久挂住。
   *
   * @param child - 子进程或 undefined。
   * @returns 进程退出（或已确认不可能再等）后 resolve。
   */
  async #terminate(child) {
    if (child === undefined || child === null) return
    if (child.exitCode !== null && child.exitCode !== undefined) return
    if (child.signalCode !== null && child.signalCode !== undefined) return
    await new Promise((resolve) => {
      let settled = false
      let soft
      let hard
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(soft)
        clearTimeout(hard)
        resolve()
      }
      child.once('exit', finish)
      try {
        child.kill()
      } catch {
        finish()
        return
      }
      soft = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          // 已经退出。
        }
      }, 300)
      hard = setTimeout(finish, TERMINATE_GRACE_MS)
    })
  }

  /**
   * 安全地发出一条生命周期事件：回调抛错不能影响隧道状态机。
   * @param entry - 隧道条目。
   * @param type - 事件类型：dropped / reconnecting / exited。
   * @param detail - 人类可读说明。
   * @param extra - 附加字段（如 attempt、delayMs）。
   */
  #emit(entry, type, detail, extra = {}) {
    if (this.#onEvent === undefined) return
    try {
      this.#onEvent({ type, id: entry.id, detail, ...extra })
    } catch {
      // 调用方回调的问题不应该让隧道状态机崩掉。
    }
  }
}
