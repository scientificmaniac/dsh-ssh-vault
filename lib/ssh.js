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
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { t } from './i18n.js'

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
 * PowerShell 的错误流压平器。
 *
 * `powershell.exe` 在输出被重定向时会把 error 流序列化成 CLIXML 写进 stderr——连脚本源码
 * 都被当成错误上下文回显，真正的错误信息淹没在一大段 XML 里。`-OutputFormat` 只作用于
 * stdout，压不住它。所以脚本内部就把 error 流并进 stdout，再用这个过滤器把 ErrorRecord
 * 压成一行 `[error] 消息`，避免 CategoryInfo 之类的框架细节。
 */
const POWERSHELL_ERROR_FILTER = 'ForEach-Object { if ($_ -is [System.Management.Automation.ErrorRecord]) '
  + '{ "[error] " + $_.Exception.Message } else { $_ } }'

/**
 * 支持 `-lc` 的 POSIX 登录 shell 白名单。
 *
 * 这里刻意不收录 `sh` / `dash` / `ash`：它们不认 `-l`，加上去只会让远端直接报
 * “invalid option”。对它们继续用 `-s` 从 stdin 读脚本，兼容性优先。
 */
const LOGIN_SHELLS = new Set(['bash', 'zsh', 'ksh', 'ksh93', 'mksh'])

/**
 * 把命令作为 `-c` 参数传给远端 shell 时的长度预算（字符）。
 *
 * `ssh` 会把本地 argv 拼成一个命令字符串交给远端登录 shell，再由目标 shell 的 `-c`
 * 执行；这条路径受远端命令行长度上限（ARG_MAX）约束，且要经过远端登录 shell 的一次
 * 解析。短命令走参数模式可以拿到 `-l` 的登录环境（/etc/profile、PATH），长脚本则
 * 退回 `-s` + stdin——stdin 没有长度上限，也不经远端登录 shell 的引号处理。
 */
export const SHELL_ARG_BUDGET = 64 * 1024

/**
 * 把 shell 名称翻译成远端要执行的命令与参数。
 *
 * **POSIX 默认走显式包装**：`<shell> -lc '<command>'`。它的价值不在语法，而在
 * **不依赖远端的登录 shell**——主机记录里写的是 bash，但用户手工登录时落到的是
 * fish/zsh，命令里的 `grep '^\[login\]'` 会被不同 shell 解释成不同东西。显式包装后，
 * 无论远端登录 shell 是什么，命令都由记录中声明的 shell 解析一次。
 *
 * 命令文本用单引号整体包裹，因此 `$`、反引号、通配符都不会被远端登录 shell 展开；
 * 远端登录 shell 只负责把它原样交给目标 shell。命令超长或 shell 不支持 `-l` 时退回
 * `<shell> -s`，由 stdin 传脚本。
 *
 * `cmd.exe` 直接读标准输入。
 *
 * **PowerShell 例外**：`-Command -` 是从标准输入逐行读取的，here-string（`@'…'@`）、
 * `foreach (…) {…}` 这类多行块会在读的过程中被拆散——拆散后产生的语法错误不会以非零
 * 退出码回传，于是整条命令看起来"执行了但什么都没发生"。`-EncodedCommand` 把整段脚本
 * 作为 Base64(UTF-16LE) 参数一次传过去，由 PowerShell 一次性解析，没有 stdin 依赖。
 *
 * @param shell - 主机记录里的 shell 字段。
 * @param script - 要执行的脚本；PowerShell 需要它来编码，POSIX 需要它来决定包装方式。
 * @param options - `login=false` 时强制用 stdin 模式（用于 invoke 层已决定走 stdin 的场合）。
 * @returns 远端命令行数组。
 */
export function shellArgv(shell, script = '', { login = true } = {}) {
  const name = primaryShell(shell)
  const lower = name.toLowerCase()
  if (lower === 'cmd' || lower === 'cmd.exe') {
    // cmd 没有「从 stdin 读脚本、又不显示 banner」的模式：只要不带 /C，它就进交互模式，
    // Windows banner 和 `DESKTOP-xxx C:\Users\...>` 提示符会一起混进 stdout，把结构化输出
    // 全部污染（实测：每行都变成 `<提示符>实际输出`）。所以带 /C 把脚本作为参数传，
    // /D 关 AutoRun、/Q 关回显。
    return script.length > 0 ? ['cmd.exe', '/Q', '/D', '/C', script] : ['cmd.exe', '/Q', '/D']
  }
  if (lower.startsWith('powershell') || lower.startsWith('pwsh')) {
    // 脚本头部：固定输出编码（否则非 ASCII 变乱码）、关掉进度偏好。
    const head = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8\n'
      + '$ProgressPreference="SilentlyContinue"\n'
    const body = script.endsWith('\n') || script.length === 0 ? script : `${script}\n`
    // **在脚本内部把 error 流并入 stdout**。powershell.exe 在输出被重定向时会把 error 流
    // 序列化成 CLIXML 写到 stderr，连脚本源码都被当成错误上下文回显；-OutputFormat 只管
    // stdout，压不住它。合并之后这条路径就不再被触发，Out-String -Stream 同时保住对象的
    // 常规文本形态，不至于让 Get-Process 之类变成一行类型名。
    const wrapped = `${head}& {\n${body}} 2>&1 | ${POWERSHELL_ERROR_FILTER} | Out-String -Stream\n`
    const encoded = Buffer.from(wrapped, 'utf16le').toString('base64')
    return [name, '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded]
  }
  // POSIX：能走参数模式就走参数模式，固定解析器；否则退回 stdin。
  // 默认用**非登录**的 `-c`：`-lc` 会加载 /etc/profile 与 ~/.bash_profile，用户 profile 里的
  // 任何提示行或坏掉的 source 都会混进 stderr（实测 CentOS 上每命令多出一行 .bashrc 报错），
  // 既污染输出，又会让下面的诊断把成功命令误判成「shell 缺失」。需要登录环境时显式开 login。
  //
  // 还要额外关掉 `~/.bashrc`：RHEL/CentOS 的 bash 打了 SSH_SOURCE_BASHRC 补丁，只要检测到
  // SSH_CLIENT / SSH_CONNECTION，**非交互** bash 也会 source ~/.bashrc。用户 .bashrc 里一条
  // 失败的 source 就会让每条命令的 stderr 都带一行噪声。`--norc` 正是补丁检查的那个开关。
  const base = lower.split('/').pop() ?? lower
  const useArgument = LOGIN_SHELLS.has(base) && script.length > 0 && script.length <= SHELL_ARG_BUDGET
  if (!useArgument) return [name, '-s']
  if (login) return [name, '-lc', shellQuote(script)]
  if (base === 'bash') return [name, '--norc', '-c', shellQuote(script)]
  return [name, '-c', shellQuote(script)]
}

/**
 * 决定一次远端调用实际怎么把脚本送过去。
 *
 * 把「拼 argv」与「写 stdin」放在同一处判断，避免 `buildSshArgs` 与 `runRemote`
 * 各算一次得出不一致的结论——那会导致命令既进了参数又留在 stdin，远端把第二份
 * 当成输入残留。
 *
 * @param shell - 主机记录里的 shell 字段。
 * @param script - 完整脚本（已包含 sudo 前置等）。
 * @returns 远端 argv、需要写入 stdin 的文本（无则 `undefined`）、以及可回显的说明。
 */
export function resolveShellInvocation(shell, script, { login = false } = {}) {
  const kind = shellKind(shell)
  const name = primaryShell(shell)
  if (kind === 'cmd') {
    const argv = shellArgv(shell, script)
    // `cmd.exe /Q /D /C <script>`：脚本在参数里，stdin 不参与。
    const useArgument = argv.length >= 5 && argv[3] === '/C'
    return {
      argv,
      input: useArgument ? undefined : script,
      remoteShell: useArgument ? `${name} /Q /D /C` : `${name} (stdin)`,
      mode: useArgument ? 'argument' : 'stdin',
    }
  }
  if (kind === 'powershell') {
    return { argv: shellArgv(shell, script), input: undefined, remoteShell: `${name} (encoded)`, mode: 'encoded' }
  }
  const argv = shellArgv(shell, script, { login })
  // 参数模式的判据：脚本是 argv 的最后一项，前一项是 `-c` / `-lc`（bash 还多一个 --norc）。
  const useArgument = argv.length >= 3 && ['-c', '-lc'].includes(argv[argv.length - 2])
  return {
    argv,
    input: useArgument ? undefined : script,
    remoteShell: useArgument ? argv.slice(0, -1).join(' ') : `${name} -s`,
    mode: useArgument ? 'argument' : 'stdin',
  }
}

/**
 * 把 `##key##value` 形式的探测输出拆成键值表。
 *
 * 必须先归一化换行：PowerShell / cmd 的输出是 CRLF，而 JS 正则里的 `.` **不匹配 `\r`**，
 * 于是 `^##key##(.*)$` 在 Windows 目标上永远匹配不上，facts 会静默变成空表——探针明明
 * 输出了全部信息，插件却只显示一行标题。
 *
 * @param stdout - 远端标准输出。
 * @returns 键值映射。
 */
export function parseProbeFacts(stdout) {
  const facts = {}
  for (const line of String(stdout ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    const match = /^##(\w+)##(.*)$/.exec(line)
    if (match !== null) facts[match[1]] = match[2].trim()
  }
  return facts
}

/**
 * 远端 shell 是否从标准输入读取脚本。
 *
 * PowerShell 走 `-EncodedCommand`，脚本已经在参数里了；再往 stdin 写内容不会被执行，
 * 只会被当成输入残留。
 *
 * @param shell - 主机记录里的 shell 字段。
 * @returns PowerShell 目标返回 false。
 */
export function shellReadsStdin(shell) {
  return shellKind(shell) !== 'powershell'
}

/**
 * 把主机记录的 `shell` 字段拆成列表。
 *
 * 设置界面里允许用逗号声明多个终端，例如 `powershell,cmd`：同一个 Windows 主机既能用
 * PowerShell 跑结构化命令，也能用 cmd 跑只有 cmd 才认的老工具。中英文逗号都认
 * （中文输入法下打出来的是全角「，」）。
 *
 * @param shell - 主机记录里的 shell 字段（单值或多值）。
 * @returns 非空 shell 列表；未声明时退回 `['bash']`。
 */
export function parseShellList(shell) {
  const raw = typeof shell === 'string' ? shell : ''
  const parts = raw.split(/[,，]/).map((item) => item.trim()).filter((item) => item.length > 0)
  return parts.length > 0 ? parts : ['bash']
}

/**
 * 取列表里的主 shell（第一个）。
 * @param shell - 主机记录里的 shell 字段。
 * @returns 主 shell 名称。
 */
export function primaryShell(shell) {
  return parseShellList(shell)[0]
}

/**
 * 在声明列表里选出本次实际使用的 shell。
 *
 * 显式指定时必须命中声明列表：cmd 与 PowerShell 的语法没有任何交集，打错一个字母就会
 * 换一套完全不同的执行路径，静默回落只会产生更难查的失败。
 *
 * @param declared - 记录的 shell 字段（可能多值）。
 * @param requested - 本次调用显式指定的 shell；省略时用主 shell。
 * @returns 选中的 shell 名称。
 * @throws 显式指定的 shell 不在声明列表里时。
 */
export function pickShell(declared, requested) {
  const list = parseShellList(declared)
  if (typeof requested !== 'string' || requested.trim().length === 0) return list[0]
  const wanted = requested.trim()
  const found = list.find((item) => item.toLowerCase() === wanted.toLowerCase())
  if (found === undefined) {
    throw new Error(t('err.shellNotDeclared', { requested: wanted, list: list.join(', ') }))
  }
  return found
}

/**
 * 归一化 shell 名称，用于选择探测命令与说明文字。
 * @param shell - 主机记录里的 shell（多值时取主 shell）。
 * @returns `cmd` / `powershell` / `posix` 之一。
 */
export function shellKind(shell) {
  const lower = primaryShell(shell).toLowerCase()
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
 *
 * `shellInvocation` 由 {@link resolveShellInvocation} 产出时直接复用，避免这里与
 * `runRemote` 对「走参数还是走 stdin」各判一次而得出不同结论。
 *
 * @param options - 主机记录、连接设置与要执行的远端命令。
 * @returns 传给 ssh 的参数数组。
 */
export function buildSshArgs({
  record, knownHostsPath, connectTimeoutSec, sshConfigFile, bindAddress, remoteCommand = '', shellInvocation, loginShell = false,
}) {
  const invocation = shellInvocation ?? resolveShellInvocation(record.shell, remoteCommand, { login: loginShell === true })
  return [
    '-T',
    ...connectionOptions({ knownHostsPath, connectTimeoutSec, sshConfigFile }),
    ...authOptions(record.auth),
    ...(typeof bindAddress === 'string' && bindAddress.length > 0 ? ['-b', bindAddress] : []),
    '-p', String(record.port),
    '--',
    `${record.username}@${record.host}`,
    ...invocation.argv,
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
 * 把子进程的输出收集成有界的字符串；超出上限时把**完整**内容落盘。
 *
 * 只截断不落地等于让调用方丢失证据：一次 `seq 1 500000` 的真失败日志被砍掉头部后，
 * 既看不出原因，也没有地方可查。因此第一次溢出时把已收到的部分补写进溢出文件，
 * 之后的每个数据块直接流式写入——内存里只保留上限那么多字符。
 *
 * @param stream - 可读流。
 * @param limit - 保留在内存中的最大字符数。
 * @param channel - 该流的通道名。
 * @param onData - 可选的实时回调，用于把输出同步送进后台任务的环形缓冲。
 * @param overflowPath - 溢出时写入的本地文件路径；省略时只截断。
 * @returns 读取最终文本的异步函数。
 */
function collector(stream, limit, channel, onData, overflowPath) {
  let text = ''
  let truncated = false
  let sink = null
  let sinkError
  let sinkDone = Promise.resolve()
  stream.setEncoding('utf8')
  stream.on('data', (chunk) => {
    try {
      onData?.(chunk, channel)
    } catch {
      // 后台任务可能已经结算，实时回调失败不影响本次调用结果。
    }
    if (truncated) {
      sink?.write(chunk)
      return
    }
    if (text.length + chunk.length <= limit) {
      text += chunk
      return
    }
    // 第一次溢出：内存里留满上限，磁盘上从这一块开始留完整副本。
    truncated = true
    const prior = text
    const room = Math.max(0, limit - prior.length)
    text = prior + chunk.slice(0, room)
    if (typeof overflowPath !== 'string' || overflowPath.length === 0) return
    sink = createWriteStream(overflowPath, { flags: 'w' })
    sinkDone = new Promise((resolve) => {
      sink.on('error', (error) => {
        sinkError = error
        resolve()
      })
      sink.on('close', resolve)
    })
    sink.write(prior)
    sink.write(chunk)
  })
  return async () => {
    if (sink !== null) {
      sink.end()
      await sinkDone
    }
    return {
      text,
      truncated,
      ...(truncated && sink !== null ? { overflowPath } : {}),
      ...(sinkError !== undefined ? { overflowError: sinkError.message } : {}),
    }
  }
}

/**
 * 执行一次子进程并等待结束，支持超时、取消与实时输出回调。
 *
 * 无论超时还是取消，已收到的输出都会随结果返回——中断不等于失明。输出超过
 * `maxOutputBytes` 时，若给了 `outputBase`，完整内容会写到
 * `<outputBase>.stdout.log` / `<outputBase>.stderr.log`，响应里只留摘要与路径。
 *
 * @param exe - 可执行文件。
 * @param args - 参数数组。
 * @param options - 标准输入、环境变量、超时、取消信号、回调与溢出落地路径前缀。
 * @returns 退出码、标准输出、标准错误、是否超时或取消、以及溢出日志路径。
 */
export function runProcess(exe, args, { input, env, timeoutMs, signal, maxOutputBytes, onSpawn, onData, outputBase }) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env,
    })
    const withSuffix = (suffix) => (typeof outputBase === 'string' && outputBase.length > 0 ? `${outputBase}.${suffix}` : undefined)
    const readOut = collector(child.stdout, maxOutputBytes, 'stdout', onData, withSuffix('stdout.log'))
    const readErr = collector(child.stderr, maxOutputBytes, 'stderr', onData, withSuffix('stderr.log'))
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
      // 等待溢出文件落盘完成，否则调用方拿着路径去读时可能只看到半截。
      Promise.all([readOut(), readErr()]).then(([out, err]) => {
        finish(resolve, {
          exitCode: code,
          stdout: out.text,
          stdoutTruncated: out.truncated,
          stderr: err.text,
          stderrTruncated: err.truncated,
          ...(out.overflowPath !== undefined ? { stdoutPath: out.overflowPath } : {}),
          ...(err.overflowPath !== undefined ? { stderrPath: err.overflowPath } : {}),
          ...(out.overflowError !== undefined || err.overflowError !== undefined
            ? { outputError: out.overflowError ?? err.overflowError }
            : {}),
          timedOut,
          aborted,
        })
      }, (error) => finish(reject, error))
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
    local.push(t('ssh.keyPermissionsTooOpen'))
  }
  if (/Load key .*(invalid format|error in libcrypto)|invalid format/i.test(err)) {
    local.push(t('ssh.publicKeyAsPrivate'))
  }
  if (/Could not open a connection to your authentication agent|No such file or directory.*(private|identity)/i.test(err)) {
    local.push(t('ssh.keyUnavailable'))
  }
  if (/a terminal is required to read the password|no tty present|askpass program specified|需要密码|sudo: .*password/i.test(err)) {
    local.push(t('ssh.sudoNoPassword'))
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
    server.push(t('ssh.publicKeyNotInstalled'))
  }
  if (/Too many authentication failures/i.test(err)) {
    server.push(t('ssh.tooManyAuthAttempts'))
  }
  if (/no mutual signature algorithm|unsupported public key algorithm/i.test(err)) {
    server.push(t('ssh.algorithmMismatch'))
  }
  // 直接出现的锁定提示（部分平台会明确报出来）。
  if (/account is locked|account has been locked|Account active\s+Locked|账户.*锁定/i.test(err)) {
    server.push(t('ssh.accountLocked'))
  }

  // —— 传输层 ——
  if (/bind .*: (Unknown error|Cannot assign requested address)|bind: Cannot assign|Cannot assign requested address/i.test(err)) {
    transport.push(t('ssh.bindUnavailable', {
      address: target.bindAddress ? t('ssh.bindAddressSuffix', { address: target.bindAddress }) : '',
    }))
  }
  if (/Connection refused/i.test(err)) {
    transport.push(t('ssh.portRefused', { port: target.port }))
  }
  if (/Connection timed out|No route to host|Network is unreachable|Connection timed out during banner exchange/i.test(err)) {
    transport.push(t('ssh.networkUnreachable', {
      bound: target.bindAddress ? t('ssh.boundSuffix', { address: target.bindAddress }) : '',
    }))
  }
  if (/Connection reset by peer|Connection closed by .* port|kex_exchange_identification/i.test(err)) {
    // Windows OpenSSH 对**已锁定**的账户是直接断开连接，而不是回 Permission denied，
    // 因此这里不能只归因于防火墙——否则「端口通、banner 正常、就是连不上」会被引向错误方向。
    transport.push(t('ssh.handshakeClosed'))
  }
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(err)) {
    transport.push(t('ssh.hostKeyChanged'))
  } else if (/Host key verification failed/i.test(err)) {
    transport.push(t('ssh.hostKeyRejected'))
  }
  if (/command not found|未找到命令|No such file or directory.*shell|没有那个文件或目录.*shell|is not recognized as an internal/i.test(err)) {
    transport.push(t('ssh.shellMissing'))
  }
  if (result.timedOut) {
    transport.push(t('ssh.timeout', { ms: target.timeoutMs }))
  }

  // 只有在没有更具体结论时，才给出“账号或口令不正确”这一通用判断。
  // 判据必须比裸 `Permission denied` 更严：scp 的 `remote open "...": Permission denied`
  // 是远端文件权限问题，把它写成「认证失败」会让人去改口令，越修越远。
  // 但 `Permission denied, please try again.` 恰好是口令认证失败的真实输出，必须认。
  if (local.length === 0 && server.length === 0
    && (denied !== null || /Authentication failed|Permission denied to|please try again|请再试一次/i.test(err))) {
    server.push(t('ssh.authFailed'))
  }
  return [...local, ...server, ...transport]
}

/**
 * 把一次失败归入一个稳定的类别，供渲染层加一行分类标签。
 *
 * 顺序即优先级：sudo 失败常常同时带着 `Permission denied`，连接层失败又常常让远端
 * 命令根本没启动——先归因到最靠外的那一层，才不会把「连不上」写成「命令出错」。
 *
 * @param result - 子进程结果。
 * @param target - 连接目标描述。
 * @returns `connection` / `auth` / `sudo` / `remote` / `truncated` / `none`。
 */
export function diagnoseCategory(result, target) {
  const err = decodeOctalEscapes(result.stderr ?? '')
  if (result.timedOut === true) return 'connection'
  if (/sudo:|不在 sudoers|a password is required|需要密码|requiretty/i.test(err)) return 'sudo'
  if (/no mutual signature|Too many authentication failures|Authentication failed/i.test(err)) return 'auth'
  if (/Permission denied/i.test(err)) return 'auth'
  if (/Connection (refused|timed out|reset|closed)|No route to host|Network is unreachable|kex_exchange_identification|REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed|client_loop/i.test(err)) {
    return 'connection'
  }
  if (result.stdoutTruncated === true || result.stderrTruncated === true) return 'truncated'
  // 255 是 ssh 客户端自己的连接层退出码，不代表远端命令的结论。
  if (typeof result.exitCode === 'number' && result.exitCode !== 0 && result.exitCode !== 255) return 'remote'
  return 'none'
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

/** sudo 探测输出行的标记。 */
const SUDO_PROBE_MARK = '##sudo##'

/**
 * 生成远端 sudo 能力探测脚本。
 *
 * 三种结论决定后续走哪条路：`nopasswd`（root 或 NOPASSWD，可直接 `sudo -n`）、
 * `password`（需要口令，可用保险库里的 sudoPassword）、`none`（没有 sudo 或当前账号无权）。
 * 提前问清比事后从 "sudo: a password is required" 反推更省一次往返。
 *
 * @returns 远端脚本。
 */
export function buildSudoProbeCommand() {
  return [
    'if command -v sudo >/dev/null 2>&1; then',
    '  if sudo -n true 2>/dev/null; then',
    `    echo "${SUDO_PROBE_MARK}nopasswd"`,
    '  elif sudo -n -l >/dev/null 2>&1 || sudo -n -v >/dev/null 2>&1; then',
    `    echo "${SUDO_PROBE_MARK}nopasswd"`,
    '  else',
    `    echo "${SUDO_PROBE_MARK}password"`,
    '  fi',
    'else',
    `  echo "${SUDO_PROBE_MARK}none"`,
    'fi',
  ].join('\n')
}

/**
 * 解析 {@link buildSudoProbeCommand} 的输出。
 * @param stdout - 远端标准输出。
 * @returns `nopasswd` / `password` / `none` / `unknown`。
 */
export function parseSudoProbe(stdout) {
  const match = new RegExp(`${SUDO_PROBE_MARK}(nopasswd|password|none)`).exec(String(stdout ?? ''))
  return match?.[1] ?? 'unknown'
}

/**
 * 把一条命令整体包成一次免密 sudo 调用。
 *
 * 注意语义：命令文本里**不要**再写 sudo。`sudo: true` 的约定是"由插件负责提权"，
 * 写了两层会变成 `sudo sudo ...`。
 *
 * 用非登录的 `bash -c` 而不是 `-lc`：sudo 本来就会重置环境变量，这里不需要 profile；
 * 而 `-lc` 会把用户 profile 里的报错混进 stderr（实测 root 的坏 .bashrc 每次都留一行）。
 *
 * @param command - 要以 root 执行的命令。
 * @returns 远端脚本行。
 */
export function buildSudoWrapCommand(command) {
  return `sudo -n bash -c ${shellQuote(command)}`
}

/**
 * 生成"临时脚本 + sudo 执行"的远端运行器。
 *
 * 这是 sudo 的推荐形态，因为它把命令与 shell 解析隔离开了：
 * - 命令经 base64 传过去再解码，`$()`、反引号、单双引号、heredoc、`&&`、后台 `&`
 *   都不会被中途的 shell 改写；
 * - 整段流程在一个 root 脚本里执行，不存在"子 shell 丢掉 sudo 缓存"的问题；
 * - 脚本执行完立刻删除，不留在磁盘上。
 *
 * 口令同样 base64 后经管道喂给 `sudo -S`，因此它不会出现在远端的进程列表里。
 *
 * @param options - 命令、可选口令与本次调用的唯一标记。
 * @returns 远端脚本。
 */
export function buildSudoScriptRunner({ command, password, token }) {
  const payload = Buffer.from(String(command), 'utf8').toString('base64')
  const temp = `/tmp/.dsh-ssh-sudo-${token}.sh`
  const hasPassword = typeof password === 'string' && password.length > 0
  const secret = hasPassword ? Buffer.from(password, 'utf8').toString('base64') : ''
  // 解码后必须补一个换行：sudo -S 从标准输入读口令，读到 EOF 而没有换行时，
  // sudo 1.8.23（CentOS 7）会报 `sudo: no password was provided` 并直接失败。
  // 加在 base64 输入上是没用的——解码出来的字节里照样没有换行，必须在管道下游补。
  const invoke = hasPassword
    ? `{ printf '%s' ${shellQuote(secret)} | base64 -d; echo; } | sudo -S -p '' bash ${shellQuote(temp)}`
    : `sudo -n bash ${shellQuote(temp)}`
  return [
    `DSH_SUDO_TMP=${shellQuote(temp)}`,
    `printf '%s' ${shellQuote(payload)} | base64 -d > "$DSH_SUDO_TMP" 2>/dev/null`
      + ' || { echo "[dsh-ssh-vault] 无法写入 sudo 临时脚本：base64 不可用或 /tmp 不可写。" >&2; exit 1; }',
    'chmod 700 "$DSH_SUDO_TMP"',
    `${invoke}; DSH_SUDO_RC=$?`,
    'rm -f "$DSH_SUDO_TMP"',
    'exit $DSH_SUDO_RC',
  ].join('\n')
}

/**
 * 把 sudo 失败归因到可执行的结论。
 *
 * 三种失败长得像但修法完全不同：要口令（补存 sudoPassword）、不在 sudoers（加组）、
 * 缓存失效（重试）。归错了会把「权限问题」误报成「口令问题」，让人反复改密码。
 *
 * @param stderr - 远端标准错误。
 * @returns 归因类别与匹配到的原始行。
 */
export function classifySudoFailure(stderr) {
  const text = String(stderr ?? '')
  if (/is not in the sudoers file|不在 sudoers|not allowed to run sudo|may not run sudo|不在 sudoers 文件中/i.test(text)) {
    return { kind: 'not-in-sudoers', evidence: (text.match(/[^\n]*sudoers[^\n]*/i) ?? [''])[0].trim() }
  }
  if (/a terminal is required|no tty present|a password is required|需要密码|password is required|sorry, try again/i.test(text)) {
    return { kind: 'need-password', evidence: (text.match(/[^\n]*(?:密码|password)[^\n]*/i) ?? [''])[0].trim() }
  }
  if (commandMissingError(text, 'sudo')) {
    return { kind: 'no-sudo', evidence: (text.match(/[^\n]*sudo[^\n]*/i) ?? [''])[0].trim() }
  }
  return { kind: 'unknown', evidence: '' }
}

/**
 * 判断错误文本里是否在说某个命令不存在。
 * @param text - 标准错误。
 * @param name - 命令名。
 * @returns 是否缺失。
 */
function commandMissingError(text, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`${escaped}[:\\s]+(?:command )?not found|command not found:?\\s*${escaped}`, 'i').test(text)
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
    'echo "[dsh-ssh-vault] 结束标记：在生成命令的末尾追加一行 echo DONE >> ${DSH_LOG}.done ，再用 wait_for 等待它"',
  ].join('\n')
}

/**
 * 把命令数组转成引号安全的远端命令行。
 *
 * `ssh` 只能传一个命令字符串，真正意义上的 execv 无法表达；这里对每个元素单独做
 * 单引号转义，效果是**远端 shell 不会对任何元素做变量展开、通配或分词**——元素边界
 * 与调用方给出的完全一致。这解决 `find . -name '*.log'`、`grep '^\[x\]'` 这类在
 * 双层 shell 里被改写的引号问题。
 *
 * @param argv - 命令与参数数组，第一个元素是程序。
 * @returns 可交给远端 shell 的一行命令。
 */
export function quoteArgv(argv) {
  if (!Array.isArray(argv) || argv.length === 0) throw new Error(t('err.commandArrayEmpty'))
  return argv.map((part) => {
    if (typeof part !== 'string' || part.length === 0) throw new Error(t('err.commandArrayBadElement'))
    return shellQuote(part)
  }).join(' ')
}

/**
 * 把 sudo 失败翻译成修复建议。
 * @param result - 执行结果。
 * @param record - 主机记录，用于填充别名与账号。
 * @returns 诊断行数组。
 */
function sudoFailureNotes(result, record) {
  const classified = classifySudoFailure(result.stderr ?? '')
  const alias = record.alias ?? '(host)'
  const user = record.username ?? '(user)'
  switch (classified.kind) {
    case 'need-password':
      return [t('sudo.needPassword', { alias }), t('sudo.needPasswordHint', { alias })]
    case 'not-in-sudoers':
      return [t('sudo.notInSudoers', { alias, user })]
    case 'no-sudo':
      return [t('sudo.probeNone')]
    default:
      return []
  }
}

/**
 * 在一台已保存的主机上执行命令。
 *
 * `sudoMode` 由调用层解析后传入（`none` / `wrap` / `script` / `prime`），执行层不再
 * 猜「要不要提权」——探测与决策留在 `index.js`，这里只负责把选定形态拼成远端脚本。
 *
 * @param options - 调用参数。
 * @returns 归一化后的执行结果，含本次使用的远端 shell 与 sudo 形态。
 */
export async function runRemote({
  record,
  secret,
  command,
  commandArray,
  shell: shellOption,
  askpassPath,
  knownHostsPath,
  connectTimeoutSec,
  timeoutMs,
  maxOutputBytes,
  signal,
  bindAddress,
  sshConfigFile,
  sudoMode = 'none',
  sudoPassword,
  loginShell = false,
  outputBase,
  extraNotes,
  sshExecutable = 'ssh',
  env = process.env,
  onSpawn,
  onData,
}) {
  const childEnv = { ...env, ...askpassEnvironment(askpassPath, secret) }
  // 记录里可能声明了多个终端（`powershell,cmd`）：本次调用用 `shell` 选一个，
  // 省略时用主 shell。后面所有包装判断都基于这个「实际使用」的 shell。
  const effectiveShell = pickShell(record.shell, shellOption)
  const effectiveRecord = effectiveShell === record.shell ? record : { ...record, shell: effectiveShell }
  // command_array 的逐元素单引号化是 POSIX 规则：cmd 不认单引号，PowerShell 会把 'x' 当成
  // 字符串字面量而不是命令——两者都会把数组变成一条错误命令，所以直接在入口拒绝。
  if (Array.isArray(commandArray) && commandArray.length > 0 && shellKind(effectiveShell) !== 'posix') {
    throw new Error(t('err.commandArrayPosixOnly', { shell: effectiveShell }))
  }
  const commandText = Array.isArray(commandArray) && commandArray.length > 0
    ? quoteArgv(commandArray)
    : String(command ?? '')
  const body = commandText.endsWith('\n') ? commandText : `${commandText}\n`

  let inputScript = body
  let appliedSudo = 'none'
  if (sudoMode === 'wrap') {
    inputScript = `${buildSudoWrapCommand(commandText)}\n`
    appliedSudo = 'wrap'
  } else if (sudoMode === 'script') {
    inputScript = `${buildSudoScriptRunner({
      command: commandText,
      password: sudoPassword,
      token: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    })}\n`
    appliedSudo = 'script'
  } else if (sudoMode === 'prime' && typeof sudoPassword === 'string' && sudoPassword.length > 0) {
    inputScript = `${sudoPrelude(sudoPassword)}${body}`
    appliedSudo = 'prime'
  }

  const invocation = resolveShellInvocation(effectiveShell, inputScript, { login: loginShell === true })
  const args = buildSshArgs({
    record: effectiveRecord,
    knownHostsPath,
    connectTimeoutSec,
    sshConfigFile,
    bindAddress,
    remoteCommand: inputScript,
    shellInvocation: invocation,
  })
  const result = await runProcess(sshExecutable, args, {
    input: invocation.input,
    env: childEnv,
    timeoutMs,
    signal,
    maxOutputBytes,
    outputBase,
    onSpawn,
    onData,
  })
  const notes = [
    ...(Array.isArray(extraNotes) ? extraNotes : []),
    ...diagnose(result, { port: record.port, timeoutMs, bindAddress, authType: record.auth?.type }),
  ]
  // sudo 失败时给出可执行的归因；成功时不必多说，免得每条命令都背一段说明。
  if (appliedSudo !== 'none' && result.exitCode !== 0 && result.timedOut !== true) {
    notes.push(...sudoFailureNotes(result, record))
  }
  return {
    ...result,
    stderr: decodeOctalEscapes(result.stderr ?? ''),
    notes,
    category: diagnoseCategory(result, { port: record.port, timeoutMs, bindAddress, authType: record.auth?.type }),
    remoteShell: invocation.remoteShell,
    shellMode: invocation.mode,
    sudoMode: appliedSudo,
  }
}

/**
 * 把本机文件的权限位归一化成远端可用的三位八进制。
 *
 * 去掉 group/other 的写位：Windows 上 stat 出来的常见值是 666 或 777，原样搬到
 * Linux 会得到「谁都能改」的配置文件——一处复制换来一个可提权面，不值得。
 *
 * @param file - 本机路径。
 * @returns 形如 `644` 的权限串。
 */
async function localFileMode(file) {
  try {
    const info = await stat(file)
    return ((info.mode & 0o777) & ~0o022).toString(8).padStart(3, '0')
  } catch {
    return '644'
  }
}

/**
 * 粗判一段内容是不是二进制（前 8 KiB 内有 NUL 字节）。
 * @param buffer - 文件内容。
 * @returns 二进制时为 true。
 */
function looksBinary(buffer) {
  const limit = Math.min(buffer.length, 8192)
  for (let index = 0; index < limit; index += 1) if (buffer[index] === 0) return true
  return false
}

/** 校验并归一化显式给定的八进制权限。 */
function normalizeMode(mode) {
  if (typeof mode !== 'string') return undefined
  const trimmed = mode.trim().replace(/^0+/, '')
  return /^[0-7]{3,4}$/.test(trimmed) ? trimmed : undefined
}

/**
 * 在主机与本地之间传输文件。
 *
 * 普通路径就是一次 `scp`。加了 `sudo` 之后走「远端临时文件中转」，因为 scp 没有
 * 任何办法以 root 身份打开文件：先把受保护内容以 root 复制到 /tmp 并交给当前用户，
 * 再 scp，最后清理。上传方向反过来——先落到 /tmp，再用 `install` 以 root 搬到
 * 目标路径，顺带应用 mode/owner。
 *
 * @param options - 调用参数，含 sudo / normalizeEol / mode / owner / preserveMode。
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
  sudo = false,
  sudoPassword,
  normalizeEol = false,
  mode,
  owner,
  preserveMode = false,
  shell: shellOption,
  scpExecutable = 'scp',
  sshExecutable = 'ssh',
  env = process.env,
  onSpawn,
  onData,
}) {
  const notes = []
  const token = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  const stageRemote = `/tmp/.dsh-xfer-${token}`
  const q = shellQuote

  /** 在远端跑一段脚本；sudo 形态由调用点决定。 */
  const exec = (command, sudoMode = 'none') => runRemote({
    record,
    secret,
    command,
    shell: shellOption,
    askpassPath,
    knownHostsPath,
    connectTimeoutSec,
    timeoutMs,
    maxOutputBytes,
    signal,
    bindAddress,
    sshConfigFile,
    sudoMode,
    sudoPassword,
    sshExecutable,
    env,
  })

  /** 传输失败时统一收口：保留已产生的输出并把归因挂在 notes 上。 */
  const failWith = (result, extra) => ({
    ...result,
    stderr: decodeOctalEscapes(result.stderr ?? ''),
    notes: [...notes, ...(Array.isArray(result.notes) ? result.notes : []), ...(extra === undefined ? [] : [extra])],
    category: diagnoseCategory(result, { port: record.port, timeoutMs, bindAddress, authType: record.auth?.type }),
  })

  let effectiveLocal = local
  let tempLocal
  let effectiveRemote = remote
  let stageCreated = false
  let stagedForUpload = false

  try {
    // —— 上传前把 CRLF 规范成 LF ——
    // Windows 上写出来的 .sh 带 CRLF，远端 bash 会报 `$'\r': 未找到命令`，
    // 而报错行号指向的往往是空行，极难定位。
    if (normalizeEol === true && direction === 'upload' && recursive !== true) {
      try {
        const content = await readFile(local)
        if (looksBinary(content) === true) {
          notes.push(t('xfer.eolSkippedBinary', { remote }))
        } else {
          const text = content.toString('utf8')
          const converted = text.includes('\r\n') ? text.replace(/\r\n/g, '\n') : text
          if (converted !== text) {
            tempLocal = path.join(tmpdir(), `dsh-xfer-${token}`)
            await writeFile(tempLocal, converted, 'utf8')
            effectiveLocal = tempLocal
            notes.push(t('xfer.eolNormalized', { remote }))
          }
        }
      } catch {
        // 本地文件读不出来时交给 scp 自己报错，不在这一层抢答。
      }
    }

    // —— sudo：远端临时文件中转 ——
    if (sudo === true) {
      if (recursive === true) {
        throw new Error(t('xfer.sudoFailed'))
      }
      if (direction === 'download') {
        // 这段脚本是以 root 跑的：`$(id -un)` 在这里求值出来就是 root，暂存文件会变成
        // root:root 600，随后**以登录账号身份**运行的 scp 根本打不开（remote open: Permission denied）。
        // 所以必须显式 chown 给连接账号，而不是当前（root）身份。
        const staged = await exec(
          `cat -- ${q(remote)} > ${q(stageRemote)} && chown ${q(record.username)}:$(id -gn ${q(record.username)}) ${q(stageRemote)} && chmod 600 ${q(stageRemote)}`,
          'script',
        )
        if (staged.exitCode !== 0) return failWith(staged, t('xfer.sudoFailed'))
        effectiveRemote = stageRemote
        stageCreated = true
        notes.push(t('xfer.sudoReadStaged', { remote }))
      } else {
        effectiveRemote = stageRemote
        stagedForUpload = true
        notes.push(t('xfer.sudoWriteStaged', { remote }))
      }
    }

    // —— 权限与属主 ——
    const wantOwner = typeof owner === 'string' && owner.trim().length > 0 ? owner.trim() : undefined
    let wantMode = normalizeMode(mode)
    if (wantMode === undefined && preserveMode === true && direction === 'upload' && recursive !== true) {
      wantMode = await localFileMode(effectiveLocal)
    }

    // —— scp ——
    const args = buildScpArgs({
      record, direction, local: effectiveLocal, remote: effectiveRemote, recursive, knownHostsPath, connectTimeoutSec, sshConfigFile, bindAddress,
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
    notes.push(...diagnose(result, { port: record.port, timeoutMs, bindAddress, authType: record.auth?.type }))
    // 连接层面的错误优先。`No such file or directory` 在同一次失败里可能只是连接中断的连带
    // 结果，此时再提示"路径不存在"会把排查引向外层——先给出传输层结论就够了。
    const transportBroken = /Connection (reset|closed|refused|timed out)|kex_exchange_identification|No route to host/i.test(err)
    if (transportBroken !== true && /No such file or directory|没有那个文件或目录/i.test(err)) {
      notes.push(t('ssh.transferPathMissing'))
    }

    // —— 上传落位 / 权限属主收尾 ——
    if (result.exitCode === 0 && direction === 'upload') {
      if (stagedForUpload === true) {
        const install = ['install']
        if (wantMode !== undefined) install.push('-m', wantMode)
        if (wantOwner !== undefined) {
          const [user, group] = wantOwner.split(':')
          install.push('-o', user)
          if (typeof group === 'string' && group.length > 0) install.push('-g', group)
        }
        install.push(q(stageRemote), q(remote))
        const placed = await exec(`${install.join(' ')} && rm -f ${q(stageRemote)}`, 'script')
        if (placed.exitCode !== 0) return failWith(placed, t('xfer.sudoFailed'))
        stageCreated = false
        if (wantMode !== undefined) notes.push(t('xfer.modeApplied', { mode: wantMode }))
        if (wantOwner !== undefined) notes.push(t('xfer.ownerApplied', { owner: wantOwner }))
      } else if (wantMode !== undefined || wantOwner !== undefined) {
        const post = []
        if (wantMode !== undefined) post.push(`chmod ${wantMode} ${q(remote)}`)
        if (wantOwner !== undefined) post.push(`chown ${q(wantOwner)} ${q(remote)}`)
        const adjusted = await exec(post.join(' && '), 'none')
        if (adjusted.exitCode === 0) {
          if (wantMode !== undefined) notes.push(t('xfer.modeApplied', { mode: wantMode }))
          if (wantOwner !== undefined) notes.push(t('xfer.ownerApplied', { owner: wantOwner }))
        } else {
          notes.push(t('xfer.sudoFailed'))
        }
      }
    }

    return {
      ...result,
      stderr: err,
      notes,
      category: diagnoseCategory(result, { port: record.port, timeoutMs, bindAddress, authType: record.auth?.type }),
    }
  } finally {
    // 中转文件无论成败都不留在远端 /tmp 里。
    if (stageCreated === true) await exec(`rm -f ${q(stageRemote)}`, 'none').catch(() => undefined)
    if (tempLocal !== undefined) await rm(tempLocal, { force: true }).catch(() => undefined)
  }
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

/**
 * 把工具输出包成终端样式的 Markdown 代码块。
 *
 * `presentCall` / `presentResult` 才是官方的「终端卡片」契约，但它们在本机安装里
 * 找不到消费方——只在各工具包中被定义、被 `defineTool` 包装，没有任何代码调用它们，
 * 因此不能作为插件可依赖的路径。内置 pwsh 工具在后台任务那条路上返回的正是这种
 * ```console 代码块，所以它一定会被渲染。
 *
 * @param text - 工具的展示文本。
 * @returns 带 console 语言标记的围栏代码块。
 */
export function renderTerminalBlock(text) {
  return `\`\`\`console\n${String(text).replace(/\n+$/, '')}\n\`\`\``
}

/**
 * 一句话开头是常见命令名时，即使带中文参数也仍按命令处理。
 *
 * 判据只能靠启发式：`echo 你好` 和「帮我看看磁盘」都含中文、都没有元字符。用白名单
 * 认命令的开头是唯一能拉开两者的办法。漏判的方向是安全的——漏掉一条命令只会多跑一次
 * shell 并报语法错；误判成自然语言则会让一条本该执行的命令被静默拦下。
 */
const COMMON_COMMAND_HEAD = /^(?:sudo|doas|su|apt|apt-get|apk|dnf|yum|pacman|zypper|snap|ls|ll|la|cat|tac|cd|pwd|cp|mv|rm|rmdir|mkdir|touch|chmod|chown|chgrp|ln|echo|printf|grep|egrep|find|locate|awk|sed|sort|uniq|head|tail|wc|cut|tr|xargs|tee|du|df|free|ps|pgrep|pkill|kill|killall|top|htop|systemctl|service|journalctl|dmesg|ip|ifconfig|ss|netstat|ping|traceroute|dig|nslookup|curl|wget|tar|zip|unzip|gzip|gunzip|python|python3|pip|pip3|node|npm|pnpm|yarn|git|docker|podman|kubectl|helm|mysql|psql|redis-cli|vim|vi|nano|emacs|date|hostname|whoami|id|groups|uname|uptime|hostnamectl|mount|umount|lsblk|blkid|fdisk|ufw|iptables|firewall-cmd|useradd|userdel|usermod|groupadd|passwd|ssh|scp|sftp|rsync|bash|sh|zsh|fish|env|export|source|which|whereis|type|file|stat|readlink|md5sum|sha1sum|sha256sum|openssl|crontab|at|watch|nohup|screen|tmux|reboot|shutdown|sleep|yes|seq|basename|dirname|realpath|test|expr)\b/i

/**
 * 判断一段文字看起来是自然语言，而不是 shell 命令。
 *
 * 先看是不是明确的命令形态：shell 元字符、路径前缀、或常见命令名开头——三者任一命中
 * 就是命令，哪怕参数里带中文。都不命中且含中日韩文字时，才认为是在让模型做事。
 *
 * 用在 `/hosts 别名; …` 的后半段上：命令的产出不会回流给模型，所以识别出自然语言时
 * 只能停下并交还给用户，不能硬当成命令执行。
 *
 * @param text - 分号之后的内容。
 * @returns 看起来是自然语言时为 true。
 */
export function looksLikeNaturalLanguage(text) {
  const trimmed = String(text ?? '').trim()
  if (trimmed.length === 0) return false
  // shell 元字符，或者以路径开头：就是命令，哪怕参数里带中文。
  if (/[|&<>$()`]/.test(trimmed)) return false
  if (/^(?:\.{0,2}\/|~\/)/.test(trimmed)) return false
  // 以常见命令名开头：也是命令，例如 `echo 你好`。
  if (COMMON_COMMAND_HEAD.test(trimmed)) return false
  return /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(trimmed)
}

/** 一次 SSH 调用的超时上限，防止误配置导致永久挂起。 */
export const MAX_TIMEOUT_MS = 30 * 60 * 1000
