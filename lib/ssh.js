/**
 * OpenSSH 驱动 —— 让模型可以通过别名调用本机 `ssh` / `scp`，而口令从不出现在命令行。
 *
 * 密码注入原理：Windows OpenSSH 9.x 支持 `SSH_ASKPASS_REQUIRE=force`，
 * 在没有终端时改用 `SSH_ASKPASS` 指定的辅助程序索取口令。我们生成一个
 * `.cmd` 包装器，由它以 Node 模式启动辅助脚本，脚本把口令写到标准输出。
 * 口令仅存在于本次 `ssh` 子进程的环境变量中，既不落盘也不进入命令行。
 *
 * @module dsh-ssh-vault/ssh
 */

import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'

/** 生成 askpass 辅助脚本时使用的文件基名。 */
const ASKPASS_JS = 'askpass.js'
const ASKPASS_CMD = 'askpass.cmd'

/**
 * 在保险库目录中准备好 askpass 辅助脚本（内容固定、不含任何机密）。
 * @param dir - 保险库目录。
 * @returns `.cmd` 包装器的绝对路径，供 `SSH_ASKPASS` 使用。
 */
export async function ensureAskpass(dir) {
  const jsPath = path.join(dir, ASKPASS_JS)
  const cmdPath = path.join(dir, ASKPASS_CMD)
  await writeFile(
    jsPath,
    '// 由 ssh 以 askpass 身份调用：把本次连接的口令写到标准输出。\n'
    + 'process.stdout.write(process.env.DSH_SSH_ASKPASS_SECRET ?? "");\n'
    + 'process.exit(0);\n',
    'utf8',
  )
  // 以 Node 模式启动宿主可执行文件；路径中的 % 需要在批处理中转义。
  const exe = process.execPath.replace(/%/g, '%%')
  const cmd = [
    '@echo off',
    'setlocal',
    'set ELECTRON_RUN_AS_NODE=1',
    `"${exe}" "${jsPath.replace(/%/g, '%%')}"`,
    '',
  ].join('\r\n')
  await writeFile(cmdPath, cmd, 'ascii')
  return cmdPath
}

/**
 * 把 shell 名称翻译成远端要执行的命令与参数。
 *
 * POSIX shell 统一用 `<shell> -s`，从标准输入读脚本；Windows 目标各有自己的读法：
 * `cmd.exe` 直接读标准输入，PowerShell 用 `-Command -`。这样调用方不必关心引号转义。
 *
 * @param shell - 主机记录里的 shell 字段。
 * @returns 远端命令行数组。
 */
export function shellArgv(shell) {
  const name = typeof shell === 'string' && shell.trim().length > 0 ? shell.trim() : 'bash'
  const lower = name.toLowerCase()
  if (lower === 'cmd' || lower === 'cmd.exe') return ['cmd.exe', '/Q']
  if (lower.startsWith('powershell') || lower.startsWith('pwsh')) {
    return [name, '-NoProfile', '-NonInteractive', '-Command', '-']
  }
  return [name, '-s']
}

/**
 * 归一化 shell 名称，用于选择探测命令与说明文字。
 * @param shell - 主机记录里的 shell。
 * @returns `cmd` / `powershell` / `posix` 之一。
 */
export function shellKind(shell) {
  const lower = (typeof shell === 'string' && shell.trim().length > 0 ? shell.trim() : 'bash').toLowerCase()
  if (lower === 'cmd' || lower === 'cmd.exe') return 'cmd'
  if (lower.startsWith('powershell') || lower.startsWith('pwsh')) return 'powershell'
  return 'posix'
}

/**
 * 按目标平台的 shell 生成自检命令。
 *
 * Windows 的 cmd 与 PowerShell 不认 `uname` / `id`，因此自检必须换一套命令，
 * 否则在 Windows 目标上探测会永远失败。
 *
 * @param shell - 主机记录里的 shell。
 * @returns 远端自检脚本。
 */
export function probeCommand(shell) {
  const kind = shellKind(shell)
  if (kind === 'cmd') {
    return 'echo ##identity## %USERNAME%@%COMPUTERNAME%'
      + ' & echo ##kernel## & ver'
      + ' & echo ##os## & wmic os get Caption /value 2>nul'
      + ' & echo ##cwd## %CD%'
  }
  if (kind === 'powershell') {
    return 'Write-Output "##identity## $env:USERNAME@$env:COMPUTERNAME";'
      + ' Write-Output "##kernel## $([Environment]::OSVersion.VersionString)";'
      + ' Write-Output "##os## $((Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue).Caption)";'
      + ' Write-Output "##uptime## $((Get-Date) - (Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue).LastBootUpTime)";'
      + ' Write-Output "##cwd## $($PWD.Path)"'
  }
  return 'echo "##identity## $(id -un)@$(hostname)"; echo "##kernel## $(uname -srm)"; '
    + 'echo "##os## $( (cat /etc/os-release 2>/dev/null | grep -E \'^(PRETTY_NAME|NAME)=\' | head -1) || cat /etc/redhat-release 2>/dev/null || echo unknown)"; '
    + 'echo "##uptime## $(uptime -p 2>/dev/null || uptime)"; echo "##cwd## $(pwd)"'
}

/**
 * 还原 OpenSSH 用 vis 风格八进制转义写出的非 ASCII 路径。
 *
 * ssh 客户端会把错误信息里的中文路径写成 `\346\223\215\344\275\234` 这样的形式，
 * 直接展示几乎无法阅读。这里把连续的八进制转义还原成 UTF-8 文本；只有确实解出
 * 非 ASCII 内容时才替换，避免破坏正常路径。
 *
 * @param text - 原始文本。
 * @returns 可读文本。
 */
export function decodeOctalEscapes(text) {
  if (typeof text !== 'string' || !text.includes('\\')) return text
  return text.replace(/(?:\\[0-7]{3})+/g, (match) => {
    const bytes = []
    for (const part of match.matchAll(/\\([0-7]{3})/g)) bytes.push(Number.parseInt(part[1], 8))
    if (!bytes.some((byte) => byte > 0x7f)) return match
    const decoded = Buffer.from(bytes).toString('utf8')
    return decoded.includes('\uFFFD') ? match : decoded
  })
}

/**
 * 组装一次 SSH 调用的认证选项。
 * @param auth - 主机认证配置。
 * @returns 追加到命令行末尾的选项数组。
 */
function authOptions(auth) {
  switch (auth?.type) {
    case 'password':
      return ['-o', 'PreferredAuthentications=password,keyboard-interactive', '-o', 'PubkeyAuthentication=no']
    case 'key':
      return [
        '-i', auth.privateKeyPath,
        '-o', 'PreferredAuthentications=publickey',
        '-o', 'IdentitiesOnly=yes',
      ]
    default:
      return []
  }
}

/**
 * 公共连接选项：连接超时、主机密钥策略、保活与保险库私有的 known_hosts。
 *
 * `HashKnownHosts` 让 known_hosts 只保存主机名的哈希，避免地址以明文落盘；
 * `UserKnownHostsFile` 永远指向保险库目录，因此不会去写用户的 `~/.ssh`。
 * `ServerAliveInterval` 让长时间无输出的命令不被中间设备静默切断。
 *
 * @param options - 连接与超时设置。
 * @returns 选项数组。
 */
function connectionOptions({ knownHostsPath, connectTimeoutSec, sshConfigFile }) {
  return [
    ...(typeof sshConfigFile === 'string' && sshConfigFile.length > 0 ? ['-F', sshConfigFile] : []),
    '-o', `ConnectTimeout=${connectTimeoutSec}`,
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'HashKnownHosts=yes',
    '-o', `UserKnownHostsFile=${knownHostsPath}`,
    '-o', 'NumberOfPasswordPrompts=1',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=4',
    '-o', 'LogLevel=ERROR',
  ]
}

/**
 * 组装一次 `ssh` 调用的完整参数。
 * @param options - 主机记录与连接设置。
 * @returns 传给 ssh 的参数数组。
 */
export function buildSshArgs({ record, knownHostsPath, connectTimeoutSec, sshConfigFile, bindAddress }) {
  return [
    '-T',
    ...connectionOptions({ knownHostsPath, connectTimeoutSec, sshConfigFile }),
    ...authOptions(record.auth),
    ...(typeof bindAddress === 'string' && bindAddress.length > 0 ? ['-b', bindAddress] : []),
    '-p', String(record.port),
    '--',
    `${record.username}@${record.host}`,
    ...shellArgv(record.shell),
  ]
}

/**
 * 组装一次 `scp` 调用的完整参数。
 * @param options - 主机记录、传输方向与连接设置。
 * @returns 传给 scp 的参数数组。
 */
export function buildScpArgs({
  record, direction, local, remote, recursive,
  knownHostsPath, connectTimeoutSec, sshConfigFile, bindAddress,
}) {
  const remoteSpec = `${record.username}@${record.host}:${remote}`
  return [
    '-P', String(record.port),
    ...connectionOptions({ knownHostsPath, connectTimeoutSec, sshConfigFile }),
    ...authOptions(record.auth),
    ...(typeof bindAddress === 'string' && bindAddress.length > 0 ? ['-o', `BindAddress=${bindAddress}`] : []),
    ...(recursive === true ? ['-r'] : []),
    '--',
    ...(direction === 'upload' ? [local, remoteSpec] : [remoteSpec, local]),
  ]
}

/**
 * 把子进程的输出收集成有界的字符串。
 * @param stream - 可读流。
 * @param limit - 保留的最大字节数。
 * @param channel - 该流的通道名。
 * @param onData - 可选的实时回调，用于把输出同步送进后台任务的环形缓冲。
 * @returns 读取最终文本的函数。
 */
function collector(stream, limit, channel, onData) {
  let text = ''
  let truncated = false
  stream.setEncoding('utf8')
  stream.on('data', (chunk) => {
    try {
      onData?.(chunk, channel)
    } catch {
      // 后台任务可能已经结算，实时回调失败不影响本次调用结果。
    }
    if (text.length >= limit) {
      truncated = true
      return
    }
    text += chunk
    if (text.length > limit) {
      text = text.slice(0, limit)
      truncated = true
    }
  })
  return () => ({ text, truncated })
}

/**
 * 执行一次子进程并等待结束，支持超时、取消与实时输出回调。
 *
 * 无论超时还是取消，已收到的输出都会随结果返回——中断不等于失明。
 *
 * @param exe - 可执行文件。
 * @param args - 参数数组。
 * @param options - 标准输入、环境变量、超时、取消信号与回调。
 * @returns 退出码、标准输出、标准错误、是否超时或取消。
 */
export function runProcess(exe, args, { input, env, timeoutMs, signal, maxOutputBytes, onSpawn, onData }) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env,
    })
    const readOut = collector(child.stdout, maxOutputBytes, 'stdout', onData)
    const readErr = collector(child.stderr, maxOutputBytes, 'stderr', onData)
    let timedOut = false
    let aborted = false
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      fn(value)
    }
    const kill = () => { try { child.kill() } catch { /* 进程可能已退出 */ } }
    // timeoutMs 为 0 表示不限时，供后台任务使用。
    const timer = timeoutMs > 0 ? setTimeout(() => {
      timedOut = true
      kill()
    }, timeoutMs) : undefined
    const onAbort = () => {
      aborted = true
      kill()
    }
    if (signal !== undefined) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    try {
      onSpawn?.(child)
    } catch {
      // 回调失败不应让本次调用挂起。
    }
    child.on('error', (error) => finish(reject, error))
    child.on('close', (code) => {
      const out = readOut()
      const err = readErr()
      finish(resolve, {
        exitCode: code,
        stdout: out.text,
        stdoutTruncated: out.truncated,
        stderr: err.text,
        stderrTruncated: err.truncated,
        timedOut,
        aborted,
      })
    })
    if (input !== undefined) child.stdin.end(input)
    else child.stdin.end()
  })
}

/**
 * 把一次失败翻译成可执行的诊断建议。
 *
 * 顺序很重要：本地密钥文件的问题（权限过宽、误传公钥、路径不存在）常常与
 * `Permission denied` 同时出现，必须先于服务器侧结论给出，否则会把本地问题
 * 误报成“账号或口令不正确”。
 *
 * @param result - 子进程结果。
 * @param target - 连接目标描述。
 * @returns 去重后的诊断行数组。
 */
export function diagnose(result, target) {
  const err = decodeOctalEscapes(result.stderr ?? '')
  const local = []
  const server = []
  const transport = []

  // —— 本地密钥与配置：ssh 客户端在发起认证前就失败了 ——
  if (/UNPROTECTED PRIVATE KEY FILE|are too open|bad permissions|Permissions for/i.test(err)) {
    local.push('本地私钥文件权限过宽，ssh 客户端已拒绝加载它（即错误中的 UNPROTECTED PRIVATE KEY FILE），'
      + '这与服务器上的账号口令无关。Windows 下需把该文件 ACL 收紧到仅当前用户；'
      + '若所在环境不允许改 ACL，可把私钥复制到保险库目录（%DSH_HOME%\\ssh-vault）并用 ssh_hosts 的 update 指向新路径。')
  }
  if (/Load key .*(invalid format|error in libcrypto)|invalid format/i.test(err)) {
    local.push('该文件不是可用的私钥。`.pub` 是公钥，不能用于登录；'
      + '请提供不带 .pub 后缀的私钥文件（如 id_rsa）。PuTTY 的 .ppk 需先转换。')
  }
  if (/Could not open a connection to your authentication agent|No such file or directory.*(private|identity)/i.test(err)) {
    local.push('本地找不到可用的私钥或认证代理：请确认 privateKeyPath 指向的文件存在且可读。')
  }
  if (/a terminal is required to read the password|no tty present|askpass program specified|需要密码|sudo: .*password/i.test(err)) {
    local.push('sudo 没有取到口令，相关命令并未执行（错误里的 a terminal is required / 需要密码 即此）。'
      + '用 ssh_run 的 sudo: true 让插件从保险库取口令预置 sudo 缓存，不必手写 `echo <pw> | sudo -S`。'
      + '另注意管道陷阱：`sudo ... | grep ...` 的退出码取决于管道最后一段，sudo 失败时整条命令仍可能返回 0。')
  }

  // —— 服务器侧认证 ——
  // `Permission denied (publickey,password,...)` 只是服务器在列举它接受的方式，不能据此断言公钥被拒；
  // 只有确实在用密钥认证（且本地密钥已被加载），或列表里只剩下 publickey 时，公钥结论才成立。
  const localKeyProblem = /UNPROTECTED PRIVATE KEY FILE|are too open|bad permissions|Permissions for|invalid format|Load key/i.test(err)
  const denied = err.match(/Permission denied \(([^)]*)\)/i)
  const methods = denied === null
    ? []
    : denied[1].split(',').map((method) => method.trim().toLowerCase()).filter((method) => method.length > 0)
  const publickeyOnly = methods.length > 0 && methods.every((method) => method === 'publickey')
  if (!localKeyProblem && /Permission denied/i.test(err) && (target.authType === 'key' || publickeyOnly)) {
    server.push('服务器拒绝了公钥认证：公钥没有装到目标账户的 authorized_keys。'
      + '若目标是 Windows 且账号属于管理员组，公钥必须写入 %ProgramData%\\ssh\\administrators_authorized_keys，'
      + '而不是用户目录下的 .ssh\\authorized_keys；该文件还需仅保留 Administrators 与 SYSTEM 的权限。')
  }
  if (/Too many authentication failures/i.test(err)) {
    server.push('认证尝试次数过多：客户端逐个试了太多密钥。改用明确的口令或 privateKeyPath 认证，'
      + '本插件对密钥认证已加 IdentitiesOnly=yes。')
  }
  if (/no mutual signature algorithm|unsupported public key algorithm/i.test(err)) {
    server.push('客户端与服务器没有共同的公钥签名算法（老服务器常见）。可改用口令认证。')
  }

  // —— 传输层 ——
  if (/bind .*: (Unknown error|Cannot assign requested address)|bind: Cannot assign|Cannot assign requested address/i.test(err)) {
    transport.push('指定的源地址在本机不可用（bind 失败）'
      + (typeof target.bindAddress === 'string' && target.bindAddress.length > 0 ? `：${target.bindAddress}` : '')
      + '。请确认该地址仍在网卡上——DHCP 续约后手工 ip addr add 的地址会丢失。')
  }
  if (/Connection refused/i.test(err)) {
    transport.push(`目标端口拒绝连接：sshd 可能未运行，或端口不是 ${target.port}。`)
  }
  if (/Connection timed out|No route to host|Network is unreachable|Connection timed out during banner exchange/i.test(err)) {
    transport.push('网络不可达或连接被拦截：确认目标 IP 与出口网卡在同一网段'
      + (target.bindAddress ? `（当前绑定源地址 ${target.bindAddress}）` : '')
      + '，且中间设备与目标防火墙放行了该端口。')
  }
  if (/Connection reset by peer|Connection closed by .* port|kex_exchange_identification/i.test(err)) {
    transport.push('连接在握手阶段被对端关闭：通常是防火墙或安全组丢包，而不是认证问题。')
  }
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(err)) {
    transport.push('主机密钥与保险库中记录的不一致：可能是目标被重建。'
      + '确认无误后删除保险库目录下 known_hosts 中的对应条目再重试。')
  } else if (/Host key verification failed/i.test(err)) {
    transport.push('主机密钥校验失败，连接已被拒绝。')
  }
  if (/command not found|No such file or directory.*shell|is not recognized as an internal/i.test(err)) {
    transport.push('远端缺少指定的 shell。Linux 目标可用 /bin/sh；Windows 目标请把主机记录的 shell 设为 cmd 或 powershell。')
  }
  if (result.timedOut) {
    transport.push(`连接或命令执行超过 ${target.timeoutMs}ms 仍未结束，已中断本地客户端。`
      + '远端命令可能仍在运行——脚本类操作请改用 run_in_background，再用 job_output 读取结果。')
  }

  // 只有在没有更具体结论时，才给出“账号或口令不正确”这一通用判断。
  if (local.length === 0 && server.length === 0 && /Permission denied/i.test(err)) {
    server.push('认证失败：账号或口令不正确，或该账号不允许所用认证方式。'
      + '可用 ssh_hosts 的 update 动作更正凭据。')
  }
  return [...local, ...server, ...transport]
}

/** 用单引号把一段文本安全地嵌进 POSIX shell 脚本。 */
function shellQuote(text) {
  return `'${String(text).replace(/'/g, `'\\''`)}'`
}

/**
 * 生成 sudo 预热脚本。
 *
 * 口令以字面量写进脚本，脚本本身通过 SSH 的**标准输入**送进远端 shell，因此口令
 * 不出现在本地命令行、不出现在 ssh 进程参数、不出现在远端的 `ps` 输出里，也不落盘。
 * 预热后 `sudo` 在时间戳窗口内免密，用户命令里照常写 `sudo ...` 即可。
 *
 * @param password - 用于 sudo 的口令。
 * @returns 拼在用户命令之前的脚本片段。
 */
export function sudoPrelude(password) {
  return `printf '%s\\n' ${shellQuote(password)} | sudo -S -p '' -v 2>/dev/null`
    + ' || { echo "[dsh-ssh-vault] sudo 凭据校验失败：保存的口令可能不是该账户的 sudo 口令，'
    + '或目标 sudoers 要求 tty（Defaults requiretty）。" >&2; exit 1; }\n'
}

/**
 * 生成远端条件等待脚本。
 *
 * 长任务（升级、扩容、扫描）不必再用「sleep + 读日志」轮询：把等待条件交给远端，
 * 一次调用就等到满足或超时，命中时回传匹配到的最后一行。配合 run_in_background
 * 使用时，等待本身也不占用一次前台调用的额度。
 *
 * @param options - 目标路径、可选正则、超时与轮询间隔。
 * @returns 远端脚本。
 */
export function buildWaitScript({ path, regex, timeoutMs, intervalMs }) {
  const waitSeconds = Math.max(1, Math.ceil((Number.isFinite(timeoutMs) ? timeoutMs : 600000) / 1000))
  const interval = Math.max(1, Math.ceil((Number.isFinite(intervalMs) ? intervalMs : 3000) / 1000))
  const hasPattern = typeof regex === 'string' && regex.length > 0
  const lines = [
    `DSH_TARGET=${shellQuote(path)}`,
    `DSH_DEADLINE=$(( $(date +%s) + ${waitSeconds} ))`,
  ]
  if (hasPattern) lines.push(`DSH_PATTERN=${shellQuote(regex)}`)
  lines.push('while :; do')
  lines.push('  if [ -e "$DSH_TARGET" ]; then')
  if (hasPattern) {
    lines.push('    if grep -qE "$DSH_PATTERN" "$DSH_TARGET" 2>/dev/null; then')
    lines.push('      echo "[dsh-ssh-vault] 条件满足，匹配行："')
    lines.push('      grep -E "$DSH_PATTERN" "$DSH_TARGET" | tail -1')
    lines.push('      exit 0')
    lines.push('    fi')
  } else {
    lines.push('    echo "[dsh-ssh-vault] 目标已出现：$DSH_TARGET"')
    lines.push('    exit 0')
  }
  lines.push('  fi')
  lines.push('  if [ "$(date +%s)" -ge "$DSH_DEADLINE" ]; then')
  lines.push('    echo "[dsh-ssh-vault] 等待超时：$DSH_TARGET 未满足条件" >&2')
  lines.push('    exit 124')
  lines.push('  fi')
  lines.push(`  sleep ${interval}`)
  lines.push('done')
  return lines.join('\n')
}

/**
 * 生成远端脱离脚本：用 `setsid` 让命令脱离 SSH 会话独立运行，输出落到日志文件。
 *
 * 与「本地长连接式后台」相比，这种方式不怕本地连接断开、代理超时或调用被取消——
 * 远端进程活着，pid 与日志文件就在，随时可以回来查状态、读增量输出。
 *
 * @param options - 要执行的命令与本次标记。
 * @returns 远端脚本。
 */
export function buildDetachScript({ command, token }) {
  const log = `/tmp/.dsh-ssh-${token}.log`
  const pidFile = `/tmp/.dsh-ssh-${token}.pid`
  return [
    `DSH_LOG=${shellQuote(log)}`,
    `DSH_PID=${shellQuote(pidFile)}`,
    `setsid sh -c ${shellQuote(command)} > "$DSH_LOG" 2>&1 < /dev/null &`,
    'echo $! > "$DSH_PID"',
    'sleep 1',
    'if kill -0 "$(cat "$DSH_PID")" 2>/dev/null; then',
    '  echo "[dsh-ssh-vault] 已在远端后台启动：pid=$(cat "$DSH_PID")"',
    'else',
    '  echo "[dsh-ssh-vault] 远端进程启动后已退出，请读日志确认结果" >&2',
    'fi',
    'echo "[dsh-ssh-vault] 日志：$DSH_LOG"',
    'echo "[dsh-ssh-vault] 存活查询：ps -p $(cat "$DSH_PID") >/dev/null 2>&1 && echo ALIVE || echo GONE"',
    'echo "[dsh-ssh-vault] 结束标记：在命令末尾追加 `echo DONE > ${DSH_LOG}.done`，再用 wait_for 等待它"',
  ].join('\n')
}

/**
 * 在一台已保存的主机上执行命令。
 * @param options - 调用参数。
 * @returns 归一化后的执行结果。
 */
export async function runRemote({
  record,
  secret,
  command,
  askpassPath,
  knownHostsPath,
  connectTimeoutSec,
  timeoutMs,
  maxOutputBytes,
  signal,
  bindAddress,
  sshConfigFile,
  sudoPassword,
  extraNotes,
  sshExecutable = 'ssh',
  env = process.env,
  onSpawn,
  onData,
}) {
  const args = buildSshArgs({ record, knownHostsPath, connectTimeoutSec, sshConfigFile, bindAddress })
  const childEnv = { ...env, ...askpassEnvironment(askpassPath, secret) }
  const body = command.endsWith('\n') ? command : `${command}\n`
  const input = typeof sudoPassword === 'string' && sudoPassword.length > 0
    ? `${sudoPrelude(sudoPassword)}${body}`
    : body
  const result = await runProcess(sshExecutable, args, {
    input,
    env: childEnv,
    timeoutMs,
    signal,
    maxOutputBytes,
    onSpawn,
    onData,
  })
  return {
    ...result,
    stderr: decodeOctalEscapes(result.stderr ?? ''),
    notes: [
      ...(Array.isArray(extraNotes) ? extraNotes : []),
      ...diagnose(result, { port: record.port, timeoutMs, bindAddress, authType: record.auth?.type }),
    ],
  }
}

/**
 * 在主机与本地之间传输文件。
 * @param options - 调用参数。
 * @returns 归一化后的传输结果。
 */
export async function transferFile({
  record,
  secret,
  direction,
  local,
  remote,
  recursive,
  askpassPath,
  knownHostsPath,
  connectTimeoutSec,
  timeoutMs,
  maxOutputBytes,
  signal,
  bindAddress,
  sshConfigFile,
  scpExecutable = 'scp',
  env = process.env,
  onSpawn,
  onData,
}) {
  const args = buildScpArgs({
    record, direction, local, remote, recursive, knownHostsPath, connectTimeoutSec, sshConfigFile, bindAddress,
  })
  const childEnv = { ...env, ...askpassEnvironment(askpassPath, secret) }
  const result = await runProcess(scpExecutable, args, {
    env: childEnv,
    timeoutMs,
    signal,
    maxOutputBytes,
    onSpawn,
    onData,
  })
  const err = decodeOctalEscapes(result.stderr ?? '')
  const notes = diagnose(result, { port: record.port, timeoutMs, bindAddress, authType: record.auth?.type })
  if (/No such file or directory/i.test(err)) notes.push('本地或远端路径不存在，或远端目录没有写权限。')
  return { ...result, stderr: err, notes }
}

/**
 * 构造把口令交给 askpass 的环境变量。
 * @param askpassPath - askpass 包装器路径。
 * @param secret - 本次连接使用的口令。
 * @returns 需要并入子进程环境的环境变量。
 */
function askpassEnvironment(askpassPath, secret) {
  if (typeof secret !== 'string' || secret.length === 0) return {}
  return {
    SSH_ASKPASS: askpassPath,
    SSH_ASKPASS_REQUIRE: 'force',
    DSH_SSH_ASKPASS_SECRET: secret,
  }
}

/**
 * 从渲染好的结果文本里取出退出状态，供对话里的终端卡片显示状态标签。
 *
 * 与 `@deepseek-ai/dsh-shell` 的同名函数行为一致，但不引入那个依赖；区别只在匹配
 * 更宽松——我们的标记后面还可能跟着诊断建议，所以不要求它在整个文本的最末尾。
 *
 * @param text - 工具的展示文本。
 * @returns 去掉状态标记的正文，以及退出码或终止信号。
 */
export function parseExitStatus(text) {
  const signal = /\n\[killed by signal: ([^\]\n]+)\](?:\n|$)/.exec(text)
  if (signal?.[1] !== undefined) {
    return { body: text.replace(signal[0], '\n').replace(/\n+$/, ''), signal: signal[1] }
  }
  const exit = /\n\[exit code: (\d+)\](?:\n|$)/.exec(text)
  if (exit?.[1] !== undefined) {
    return { body: text.replace(exit[0], '\n').replace(/\n+$/, ''), exitCode: Number(exit[1]) }
  }
  return { body: text.replace(/\n+$/, ''), exitCode: 0 }
}

/** 一次 SSH 调用的超时上限，防止误配置导致永久挂起。 */
export const MAX_TIMEOUT_MS = 30 * 60 * 1000
