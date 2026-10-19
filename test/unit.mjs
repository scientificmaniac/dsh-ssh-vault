/**
 * 单元回归：ssh/scp 参数构造，以及“中断/超时仍保留已产生输出”。
 *
 * 参数构造部分在任何环境下都能跑；进程类用例需要能 spawn 子进程，
 * 受限沙箱下会自动跳过并明确报告。
 *
 * 运行：node test/unit.mjs
 */
import { buildDetachScript, buildScpArgs, buildSshArgs, buildWaitScript, looksLikeNaturalLanguage, parseExitStatus, renderTerminalBlock, runProcess, sudoPrelude } from '../lib/ssh.js'

let passed = 0
const failures = []
const skipped = []

function check(name, condition, detail) {
  if (condition) {
    passed += 1
    return
  }
  failures.push(`${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

/** 取 `-flag value` 形式选项的值。 */
function optionValue(args, flag) {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : undefined
}

/** 取 `-o Key=Value` 形式的选项值。 */
function optionEntry(args, key) {
  for (let i = 0; i < args.length - 1; i += 1) {
    if (args[i] === '-o' && typeof args[i + 1] === 'string' && args[i + 1].startsWith(`${key}=`)) {
      return args[i + 1].slice(key.length + 1)
    }
  }
  return undefined
}

const passwordRecord = {
  alias: 'demo',
  host: '192.0.2.10',
  port: 2222,
  username: 'root',
  auth: { type: 'password', password: 'secret' },
  shell: 'bash',
}
const keyRecord = {
  ...passwordRecord,
  auth: { type: 'key', privateKeyPath: 'C:\\keys\\id_rsa' },
}
const knownHostsPath = 'C:\\vault\\known_hosts'

// —— ssh 参数 ——
const sshArgs = buildSshArgs({ record: passwordRecord, knownHostsPath, connectTimeoutSec: 10 })
check('ssh 端口', optionValue(sshArgs, '-p') === '2222', sshArgs.join(' '))
check('ssh 无终端', sshArgs.includes('-T'))
check('ssh 目标', sshArgs.includes('root@192.0.2.10'), sshArgs.join(' '))
check('ssh 私钥 known_hosts', optionEntry(sshArgs, 'UserKnownHostsFile') === knownHostsPath, sshArgs.join(' '))
check('ssh 哈希主机名', optionEntry(sshArgs, 'HashKnownHosts') === 'yes')
check('ssh 保活', optionEntry(sshArgs, 'ServerAliveInterval') === '30')
check('ssh 连接超时', optionEntry(sshArgs, 'ConnectTimeout') === '10')
check('ssh 口令认证', optionEntry(sshArgs, 'PreferredAuthentications') === 'password,keyboard-interactive')
check('ssh 关闭公钥', optionEntry(sshArgs, 'PubkeyAuthentication') === 'no')
check('ssh 默认 shell', sshArgs.slice(-2).join(' ') === 'bash -s', sshArgs.slice(-3).join(' '))
check('ssh 默认不绑定源地址', !sshArgs.includes('-b'))

const boundArgs = buildSshArgs({ record: passwordRecord, knownHostsPath, connectTimeoutSec: 10, bindAddress: '192.0.2.150' })
check('ssh 绑定源地址', optionValue(boundArgs, '-b') === '192.0.2.150', boundArgs.join(' '))
check('ssh 源地址在目标之前', boundArgs.indexOf('-b') < boundArgs.indexOf('root@192.0.2.10'))

const winArgs = buildSshArgs({ record: { ...passwordRecord, shell: 'cmd' }, knownHostsPath, connectTimeoutSec: 10 })
check('ssh cmd shell', winArgs.slice(-2).join(' ') === 'cmd.exe /Q', winArgs.slice(-2).join(' '))
const psScript = "foreach ($j in @('a','b')) { Write-Output $j }\nWrite-Output 'done'\n"
const psArgs = buildSshArgs({
  record: { ...passwordRecord, shell: 'powershell' }, knownHostsPath, connectTimeoutSec: 10, remoteCommand: psScript,
})
check('ssh powershell 用 EncodedCommand',
  psArgs.slice(-5, -1).join(' ') === 'powershell -NoProfile -NonInteractive -EncodedCommand',
  psArgs.slice(-5, -1).join(' '))
check('ssh powershell 不再依赖 stdin 的 -Command -',
  !psArgs.includes('-Command'), psArgs.join(' '))

// 编码后的内容必须能原样解回：多行块、here-string、数组字面量一个字都不能少。
const psEncoded = psArgs[psArgs.length - 1]
const psDecoded = Buffer.from(psEncoded, 'base64').toString('utf16le')
check('powershell 脚本完整回环', psDecoded.includes(psScript.trimEnd()), JSON.stringify(psDecoded))
check('powershell 输出编码已固定', psDecoded.startsWith('[Console]::OutputEncoding'), JSON.stringify(psDecoded.slice(0, 60)))
// error 流必须在脚本内部就并入 stdout，否则 powershell.exe 会把整段脚本当成错误上下文
// 序列化成 CLIXML 写进 stderr。
check('powershell 合并 error 流', psDecoded.includes('} 2>&1 | ForEach-Object'), JSON.stringify(psDecoded.slice(-160)))
check('powershell 压平 ErrorRecord', psDecoded.includes('[error] '), JSON.stringify(psDecoded.slice(-160)))
check('powershell 关闭进度条', psDecoded.includes('$ProgressPreference'), JSON.stringify(psDecoded.slice(0, 120)))

// 对照：POSIX 与 cmd 仍走 stdin，不应把脚本塞进参数。
const posixArgs = buildSshArgs({
  record: passwordRecord, knownHostsPath, connectTimeoutSec: 10, remoteCommand: 'echo hi\n',
})
check('posix 仍用 -s 走 stdin', posixArgs.slice(-2).join(' ') === 'bash -s', posixArgs.slice(-2).join(' '))
const cmdArgs = buildSshArgs({
  record: { ...passwordRecord, shell: 'cmd' }, knownHostsPath, connectTimeoutSec: 10, remoteCommand: 'dir\n',
})
check('cmd 不被编码进参数', cmdArgs.slice(-2).join(' ') === 'cmd.exe /Q', cmdArgs.slice(-2).join(' '))

const keyArgs = buildSshArgs({ record: keyRecord, knownHostsPath, connectTimeoutSec: 10 })
check('ssh 密钥文件', optionValue(keyArgs, '-i') === 'C:\\keys\\id_rsa', keyArgs.join(' '))
check('ssh 只用指定密钥', optionEntry(keyArgs, 'IdentitiesOnly') === 'yes')

const configArgs = buildSshArgs({ record: passwordRecord, knownHostsPath, connectTimeoutSec: 10, sshConfigFile: 'C:\\vault\\ssh_config' })
check('ssh 自定义配置文件', optionValue(configArgs, '-F') === 'C:\\vault\\ssh_config', configArgs.join(' '))

// —— scp 参数 ——
const upload = buildScpArgs({ record: passwordRecord, direction: 'upload', local: 'C:\\tmp\\a.txt', remote: '/tmp/a.txt', knownHostsPath, connectTimeoutSec: 10 })
check('scp 大写端口', optionValue(upload, '-P') === '2222', upload.join(' '))
check('scp 上传顺序', upload.slice(-2).join(' ') === 'C:\\tmp\\a.txt root@192.0.2.10:/tmp/a.txt', upload.slice(-2).join(' '))
const download = buildScpArgs({ record: passwordRecord, direction: 'download', local: 'C:\\tmp\\a.txt', remote: '/tmp/a.txt', knownHostsPath, connectTimeoutSec: 10 })
check('scp 下载顺序', download.slice(-2).join(' ') === 'root@192.0.2.10:/tmp/a.txt C:\\tmp\\a.txt', download.slice(-2).join(' '))
const boundUpload = buildScpArgs({ record: passwordRecord, direction: 'upload', local: 'a', remote: 'b', knownHostsPath, connectTimeoutSec: 10, bindAddress: '192.0.2.150' })
check('scp 绑定源地址', optionEntry(boundUpload, 'BindAddress') === '192.0.2.150', boundUpload.join(' '))
const recursiveUpload = buildScpArgs({ record: passwordRecord, direction: 'upload', local: 'a', remote: 'b', recursive: true, knownHostsPath, connectTimeoutSec: 10 })
check('scp 递归', recursiveUpload.includes('-r'))

// —— 进程类用例：超时与取消都不能丢掉已收到的输出 ——
const probeEnv = process.env
let spawnable = true
try {
  await runProcess(process.execPath, ['-e', 'process.exit(0)'], { env: probeEnv, timeoutMs: 15000, maxOutputBytes: 1000 })
} catch (error) {
  spawnable = false
  skipped.push(`进程类用例已跳过（无法启动子进程：${error?.code ?? error?.message}）`)
}

if (spawnable) {
  const emitThenHang = (text, stream = 'stdout') => [
    '-e',
    `process.${stream}.write(${JSON.stringify(`${text}\n`)}); setTimeout(() => {}, 60000)`,
  ]

  const timedOut = await runProcess(process.execPath, emitThenHang('BEFORE_SLEEP'), {
    env: probeEnv, timeoutMs: 3000, maxOutputBytes: 10000,
  })
  check('超时仍保留 stdout', timedOut.timedOut === true && timedOut.stdout.includes('BEFORE_SLEEP'), JSON.stringify(timedOut))
  check('超时标记 timedOut', timedOut.timedOut === true)

  const timedOutErr = await runProcess(process.execPath, emitThenHang('ERR_BEFORE', 'stderr'), {
    env: probeEnv, timeoutMs: 3000, maxOutputBytes: 10000,
  })
  check('超时仍保留 stderr', timedOutErr.stderr.includes('ERR_BEFORE'), JSON.stringify(timedOutErr))

  const controller = new AbortController()
  setTimeout(() => controller.abort(), 800)
  const cancelled = await runProcess(process.execPath, emitThenHang('BEFORE_ABORT'), {
    env: probeEnv, timeoutMs: 30000, maxOutputBytes: 10000, signal: controller.signal,
  })
  check('取消仍保留 stdout', cancelled.aborted === true && cancelled.stdout.includes('BEFORE_ABORT'), JSON.stringify(cancelled))

  const chunks = []
  const streamed = await runProcess(process.execPath, emitThenHang('LIVE_CHUNK'), {
    env: probeEnv, timeoutMs: 3000, maxOutputBytes: 10000,
    onData: (chunk, channel) => chunks.push([channel, chunk]),
  })
  check('实时回调收到分段输出', chunks.some(([channel, chunk]) => channel === 'stdout' && chunk.includes('LIVE_CHUNK')), JSON.stringify(chunks))

  const noLimit = await runProcess(process.execPath, ['-e', 'process.stdout.write("QUICK")'], {
    env: probeEnv, timeoutMs: 0, maxOutputBytes: 1000,
  })
  check('timeoutMs=0 表示不限时', noLimit.timedOut === false && noLimit.stdout === 'QUICK', JSON.stringify(noLimit))
}

// —— sudo 预热：口令只进脚本，不进命令行 ——
const prelude = sudoPrelude('example-pw')
check('sudo 预热调用 sudo -S -v', prelude.includes("sudo -S -p '' -v"), prelude)
check('sudo 预热把口令写成单引号字面量', prelude.includes("'example-pw'"), prelude)
check('sudo 预热失败即退出', prelude.includes('exit 1'), prelude)
check('sudo 预热不含 -S 之外的命令行口令', !prelude.includes('sudo -S example-pw'), prelude)
const quotedPrelude = sudoPrelude("pa'ss word")
check('sudo 预热转义单引号与空格', quotedPrelude.includes(`'pa'\\''ss word'`), quotedPrelude)
const sshArgsForSudo = buildSshArgs({ record: passwordRecord, knownHostsPath, connectTimeoutSec: 10 })
check('ssh 参数里永远不含口令', !sshArgsForSudo.join(' ').includes('secret'), sshArgsForSudo.join(' '))

// —— wait_for / detach 远端脚本 ——
const waitScript = buildWaitScript({ path: '/var/log/kali-upgrade.log', regex: 'Upgrade complete', timeoutMs: 600000, intervalMs: 3000 })
check('wait 脚本含目标路径', waitScript.includes("'/var/log/kali-upgrade.log'"), waitScript)
check('wait 脚本含正则', waitScript.includes("'Upgrade complete'"), waitScript)
check('wait 脚本用 grep -qE 检测', waitScript.includes('grep -qE'), waitScript)
check('wait 脚本超时退出 124', waitScript.includes('exit 124'), waitScript)
check('wait 脚本含轮询间隔', waitScript.includes('sleep 3'), waitScript)
const waitNoRegex = buildWaitScript({ path: '/tmp/done' })
check('wait 省略正则时只等文件出现', !waitNoRegex.includes('DSH_PATTERN') && waitNoRegex.includes('exit 0'), waitNoRegex)
check('wait 脚本带默认超时 600s', waitNoRegex.includes('+ 600'), waitNoRegex)

const detachScript = buildDetachScript({ command: 'apt -y full-upgrade', token: 'tok123' })
check('detach 用 setsid 脱离会话', detachScript.includes('setsid sh -c'), detachScript)
check('detach 重定向输出到日志', detachScript.includes('> "$DSH_LOG" 2>&1'), detachScript)
check('detach 写 pid 文件', detachScript.includes('echo $! > "$DSH_PID"'), detachScript)
check('detach 安全引用命令', detachScript.includes("'apt -y full-upgrade'"), detachScript)
check('detach 告知存活查询方式', detachScript.includes('ALIVE'), detachScript)

// —— 对话里的终端卡片：从展示文本中取出退出状态 ——
{
  check('没有状态标记时退出码为 0', parseExitStatus('just output').exitCode === 0)

  const ok = parseExitStatus('hello\nworld\n[exit code: 0]')
  check('取出零退出码', ok.exitCode === 0, JSON.stringify(ok))
  check('正文不含状态标记', ok.body === 'hello\nworld', JSON.stringify(ok.body))
  check('取出非零退出码', parseExitStatus('boom\n[exit code: 255]').exitCode === 255)

  // 我们的渲染在退出码之后还会跟诊断建议，所以匹配不能要求它位于全文末尾——
  // 这与内置 shell 工具的实现有意不同。
  const withNotes = parseExitStatus('out\n[exit code: 3]\n提示：检查 known_hosts')
  check('退出码后仍有建议时也能取出', withNotes.exitCode === 3, JSON.stringify(withNotes))
  check('建议文本被保留', withNotes.body.includes('检查 known_hosts'), JSON.stringify(withNotes))

  const killed = parseExitStatus('partial\n[killed by signal: SIGKILL]')
  check('识别终止信号', killed.signal === 'SIGKILL' && killed.exitCode === undefined, JSON.stringify(killed))
  check('终止信号标记被移除', !killed.body.includes('killed by signal'), JSON.stringify(killed.body))
}

// —— 终端样式渲染：ssh 工具的结果包成 console 代码块 ——
{
  check('渲染成 console 围栏', renderTerminalBlock('hello\nworld') === '```console\nhello\nworld\n```', JSON.stringify(renderTerminalBlock('hello\nworld')))
  check('结尾多余换行被去掉', renderTerminalBlock('out\n\n\n') === '```console\nout\n```', JSON.stringify(renderTerminalBlock('out\n\n\n')))
  check('空输出不留空白行', renderTerminalBlock('') === '```console\n\n```', JSON.stringify(renderTerminalBlock('')))
  check('非字符串输入也能渲染', renderTerminalBlock(42).includes('42'), JSON.stringify(renderTerminalBlock(42)))
}

// —— 分号后是命令还是自然语言 ——
{
  // 中文句子：应当交还给用户，不能当成 shell 命令硬跑。
  check('中文短句算自然语言', looksLikeNaturalLanguage('帮我看看磁盘空间'), '中文短句')
  check('中英混排也算自然语言', looksLikeNaturalLanguage('查一下 docker 状态'), '中英混排')

  // 明确的 shell 命令不因为带中文参数就被误判。
  check('带中文参数的 echo 仍是命令', !looksLikeNaturalLanguage('echo 你好'), 'echo 中文参数')
  check('管道仍是命令', !looksLikeNaturalLanguage('cat /etc/passwd | grep 中文'), '管道')
  check('重定向仍是命令', !looksLikeNaturalLanguage('ls > 清单.txt'), '重定向')
  check('路径前缀仍是命令', !looksLikeNaturalLanguage('./中文脚本.sh'), '路径')
  check('纯 ASCII 命令不是自然语言', !looksLikeNaturalLanguage('apt update'), 'apt update')
  check('空串不算自然语言', !looksLikeNaturalLanguage('   '), '空白')
}

console.log(`${passed} 项通过，${failures.length} 项失败`)
for (const note of skipped) console.log(`SKIP: ${note}`)
for (const failure of failures) console.error(`FAIL: ${failure}`)
if (failures.length > 0) process.exit(1)
console.log('全部通过')
