/**
 * 真实环境端到端回归：Kali（口令认证）与 Windows（密钥认证）。
 *
 * 凭据全部由环境变量提供，源码不含任何地址或口令：
 *   LIVE_KALI_HOST / LIVE_KALI_PORT / LIVE_KALI_USER / LIVE_KALI_PASS
 *   LIVE_WIN_HOST  / LIVE_WIN_PORT  / LIVE_WIN_USER  / LIVE_WIN_KEY
 *
 * 运行：node test/live.mjs
 */
import { readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { registerSshJob } from '../lib/background.js'
import { buildDetachScript, buildWaitScript, ensureAskpass, probeCommand, runRemote, transferFile } from '../lib/ssh.js'
import { Vault } from '../lib/vault.js'

const env = process.env
const KALI = {
  host: env.LIVE_KALI_HOST,
  port: Number(env.LIVE_KALI_PORT ?? 22),
  user: env.LIVE_KALI_USER,
  pass: env.LIVE_KALI_PASS,
}
const WIN = {
  host: env.LIVE_WIN_HOST,
  port: Number(env.LIVE_WIN_PORT ?? 22),
  user: env.LIVE_WIN_USER,
  key: env.LIVE_WIN_KEY,
}

if (!KALI.host || !KALI.user || !KALI.pass) {
  console.error('缺少 LIVE_KALI_HOST / LIVE_KALI_USER / LIVE_KALI_PASS。')
  process.exit(2)
}

const dir = path.join(os.tmpdir(), `sshvault-live-${Date.now()}`)
const vault = new Vault({ dir, keyProtection: 'file' })
await vault.ensureDir()
const askpassPath = await ensureAskpass(dir)
const knownHostsPath = vault.knownHostsPath

let passed = 0
let failed = 0
function report(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `\n      ${detail}`}`)
  if (ok) passed += 1
  else failed += 1
}

const call = (record, command, extra = {}) => runRemote({
  record,
  secret: record.auth?.password,
  command,
  askpassPath,
  knownHostsPath,
  connectTimeoutSec: 10,
  timeoutMs: 60000,
  maxOutputBytes: 100000,
  ...extra,
})

const transfer = (record, extra) => transferFile({
  record,
  secret: record.auth?.password,
  askpassPath,
  knownHostsPath,
  connectTimeoutSec: 10,
  timeoutMs: 60000,
  maxOutputBytes: 100000,
  ...extra,
})

const kaliRecord = {
  alias: 'kali',
  host: KALI.host,
  port: KALI.port,
  username: KALI.user,
  auth: { type: 'password', password: KALI.pass },
  shell: 'bash',
}

// —— 1. 口令登录 ——
const probe = await call(kaliRecord, 'id -un; hostname; uname -sr')
report('Kali 口令登录', probe.exitCode === 0 && probe.stdout.includes(KALI.user),
  `exit=${probe.exitCode} out=${JSON.stringify(probe.stdout.trim())} notes=${JSON.stringify(probe.notes)}`)

// —— 2. 主机密钥哈希化 ——
const known = await readFile(knownHostsPath, 'utf8').catch(() => '')
report('known_hosts 已哈希且无明文地址', known.startsWith('|1|') && !known.includes(KALI.host),
  JSON.stringify(known.trim().slice(0, 80)))

// —— 3. 错误口令的归因 ——
const wrong = await call({ ...kaliRecord, auth: { type: 'password', password: 'definitely-wrong' } }, 'echo SHOULD_NOT_RUN')
report('错误口令归因为口令问题', wrong.exitCode !== 0 && wrong.notes.some((n) => n.includes('账号或口令不正确')),
  `exit=${wrong.exitCode} notes=${JSON.stringify(wrong.notes)}`)

// —— 4. 超时仍保留已产生输出 ——
const slow = await call(kaliRecord, 'echo BEFORE_SLEEP; sleep 30; echo AFTER_SLEEP', { timeoutMs: 6000 })
report('超时保留已收到输出', slow.timedOut === true && slow.stdout.includes('BEFORE_SLEEP'),
  `timedOut=${slow.timedOut} stdout=${JSON.stringify(slow.stdout)}`)

// —— 5. 源地址绑定确实传给了 ssh ——
const badBind = await call(kaliRecord, 'echo SHOULD_NOT_RUN', { timeoutMs: 20000, bindAddress: '203.0.113.7' })
report('源地址绑定生效（本机不存在的地址应失败）', badBind.exitCode !== 0,
  `exit=${badBind.exitCode} stderr=${JSON.stringify(badBind.stderr.slice(0, 160))}`)

// —— 6. 上传与回读 ——
const localFile = path.join(dir, 'roundtrip.txt')
await writeFile(localFile, 'from windows host\n', 'utf8')
const upload = await transfer(kaliRecord, { direction: 'upload', local: localFile, remote: '/tmp/dsh-live.txt' })
report('上传到 Kali', upload.exitCode === 0, `exit=${upload.exitCode} notes=${JSON.stringify(upload.notes)}`)
const readBack = await call(kaliRecord, 'cat /tmp/dsh-live.txt; rm -f /tmp/dsh-live.txt')
report('远端内容与本地一致', readBack.stdout.includes('from windows host'), JSON.stringify(readBack.stdout.trim()))

// —— 7. 自检命令在真实目标上可执行 ——
const kaliSelfCheck = await call(kaliRecord, probeCommand('bash'))
report('Kali 自检命令可执行', kaliSelfCheck.exitCode === 0 && kaliSelfCheck.stdout.includes('##identity##'),
  `exit=${kaliSelfCheck.exitCode} out=${JSON.stringify(kaliSelfCheck.stdout.trim().slice(0, 160))}`)

// —— 8. 后台任务：真实 SSH 的流式输出与结算 ——
const streamed = []
let backgroundHooks
const fakeRegistry = {
  start(spec) {
    const job = { append: (text, options) => streamed.push([options?.channel ?? 'stdout', text]) }
    backgroundHooks = spec.run(job)
    return 'ssh-1'
  },
}
const backgroundLabel = []
const registryWithLabel = {
  start(spec) {
    backgroundLabel.push(spec.label)
    return fakeRegistry.start(spec)
  },
}
const jobId = registerSshJob(registryWithLabel, {
  record: kaliRecord,
  secret: KALI.pass,
  command: 'for i in 1 2 3; do echo tick-$i; sleep 1; done',
  askpassPath,
  knownHostsPath,
  connectTimeoutSec: 10,
  maxOutputBytes: 100000,
})
const backgroundOutcome = await backgroundHooks.done
const streamedText = streamed.map(([, text]) => text).join('')
report('后台任务签发 id 并流式收到输出',
  jobId === 'ssh-1' && streamedText.includes('tick-1') && streamedText.includes('tick-3'),
  `id=${jobId} chunks=${streamed.length} text=${JSON.stringify(streamedText.trim())}`)
report('后台任务结算为 completed', backgroundOutcome.status === 'completed', JSON.stringify(backgroundOutcome))
report('后台任务 label 含别名与命令', backgroundLabel[0]?.startsWith('kali: for i in 1 2 3'), JSON.stringify(backgroundLabel))

// —— 9. sudo：口令只进脚本，不进命令行，也不进远端进程列表 ——
const sudoRun = await call(kaliRecord, 'sudo whoami; echo "==="; sudo -n true && echo SUDO_CACHED', { sudoPassword: KALI.pass })
report('sudo 预热后免密执行',
  sudoRun.exitCode === 0 && /^root$/m.test(sudoRun.stdout) && sudoRun.stdout.includes('SUDO_CACHED'),
  `exit=${sudoRun.exitCode} out=${JSON.stringify(sudoRun.stdout.trim())} err=${JSON.stringify(sudoRun.stderr.trim().slice(0, 200))}`)

// 检查口令不会出现在远端进程列表里：把口令从环境变量拼进 grep，源码本身不含口令。
const quotedPass = `'${String(KALI.pass).replace(/'/g, `'\\''`)}'`
const sudoLeak = await call(kaliRecord, `ps -eo args | grep -F ${quotedPass} | grep -v grep | wc -l`, { sudoPassword: KALI.pass })
report('口令不出现在远端进程列表', sudoLeak.stdout.trim() === '0', JSON.stringify(sudoLeak.stdout.trim()))

const sudoWrong = await call(kaliRecord, 'sudo whoami', { sudoPassword: 'definitely-wrong' })
report('sudo 口令错误时明确报错',
  sudoWrong.exitCode !== 0 && sudoWrong.stderr.includes('sudo 凭据校验失败'),
  `exit=${sudoWrong.exitCode} err=${JSON.stringify(sudoWrong.stderr.trim().slice(0, 200))}`)

// —— 10. wait_for：一次调用等到远端条件成立 ——
await call(kaliRecord, 'rm -f /tmp/dsh-wait-probe; (sleep 6; echo "JOB COMPLETE at $(date +%T)" > /tmp/dsh-wait-probe) & echo started')
const waited = await call(kaliRecord, buildWaitScript({
  path: '/tmp/dsh-wait-probe', regex: 'COMPLETE', timeoutMs: 40000, intervalMs: 1000,
}))
report('wait_for 等到条件成立',
  waited.exitCode === 0 && waited.stdout.includes('条件满足') && waited.stdout.includes('JOB COMPLETE'),
  `exit=${waited.exitCode} out=${JSON.stringify(waited.stdout.trim())}`)

const waitTimedOut = await call(kaliRecord, buildWaitScript({
  path: '/tmp/dsh-never-appears', timeoutMs: 4000, intervalMs: 1000,
}))
report('wait_for 超时以 124 退出且不吞掉说明',
  waitTimedOut.exitCode === 124 && waitTimedOut.stderr.includes('等待超时'),
  `exit=${waitTimedOut.exitCode} err=${JSON.stringify(waitTimedOut.stderr.trim())}`)

// —— 11. detach：远端脱离会话运行，本地立即返回 ——
await call(kaliRecord, 'rm -f /tmp/dsh-detach-done /tmp/.dsh-ssh-livetest.log /tmp/.dsh-ssh-livetest.pid')
const detachStarted = Date.now()
const detached = await call(kaliRecord, buildDetachScript({
  command: 'sleep 4; echo DETACH_DONE > /tmp/dsh-detach-done',
  token: 'livetest',
}))
const detachElapsed = Date.now() - detachStarted
report('detach 立即返回并给出 pid 与日志',
  detached.exitCode === 0 && detached.stdout.includes('已在远端后台启动') && detached.stdout.includes('.dsh-ssh-livetest.log'),
  `耗时=${detachElapsed}ms out=${JSON.stringify(detached.stdout.trim().slice(0, 200))}`)
report('detach 不阻塞等待命令结束', detachElapsed < 3500, `耗时=${detachElapsed}ms`)

const detachWait = await call(kaliRecord, buildWaitScript({
  path: '/tmp/dsh-detach-done', timeoutMs: 30000, intervalMs: 1000,
}))
report('detach 的远端进程在本地返回后继续跑完',
  detachWait.exitCode === 0 && detachWait.stdout.includes('目标已出现'),
  `exit=${detachWait.exitCode} out=${JSON.stringify(detachWait.stdout.trim())}`)
await call(kaliRecord, 'rm -f /tmp/dsh-detach-done /tmp/dsh-wait-probe /tmp/.dsh-ssh-livetest.log /tmp/.dsh-ssh-livetest.pid')

// —— 12. Windows 密钥认证 ——
if (WIN.host && WIN.user && WIN.key) {
  const winRecord = {
    alias: 'win10',
    host: WIN.host,
    port: WIN.port,
    username: WIN.user,
    auth: { type: 'key', privateKeyPath: WIN.key },
    shell: 'cmd',
  }
  const winProbe = await call(winRecord, 'whoami & hostname')
  report('Win10 密钥登录（cmd shell）', winProbe.exitCode === 0,
    `exit=${winProbe.exitCode} out=${JSON.stringify(winProbe.stdout.trim())} err=${JSON.stringify(winProbe.stderr.trim())}\n      notes=${JSON.stringify(winProbe.notes)}`)

  // cmd 自检
  const winCmdCheck = await call(winRecord, probeCommand('cmd'))
  report('Win10 cmd 自检命令可执行', winCmdCheck.exitCode === 0 && /identity/i.test(winCmdCheck.stdout),
    `exit=${winCmdCheck.exitCode} out=${JSON.stringify(winCmdCheck.stdout.trim().slice(0, 200))}`)

  // powershell 作为远端 shell
  const psRecord = { ...winRecord, shell: 'powershell' }
  const winPsCheck = await call(psRecord, probeCommand('powershell'))
  report('Win10 powershell 自检命令可执行', winPsCheck.exitCode === 0 && winPsCheck.stdout.includes('identity'),
    `exit=${winPsCheck.exitCode} out=${JSON.stringify(winPsCheck.stdout.trim().slice(0, 200))} err=${JSON.stringify(winPsCheck.stderr.trim().slice(0, 200))}`)

  const winPsCmd = await call(psRecord, 'Write-Output "PS_SHELL_OK $($PSVersionTable.PSVersion.ToString())"')
  report('Win10 powershell 执行任意命令', winPsCmd.exitCode === 0 && winPsCmd.stdout.includes('PS_SHELL_OK'),
    `out=${JSON.stringify(winPsCmd.stdout.trim())} err=${JSON.stringify(winPsCmd.stderr.trim().slice(0, 200))}`)

  // Windows 文件传输
  const winLocal = path.join(dir, 'win-roundtrip.txt')
  await writeFile(winLocal, 'to windows\n', 'utf8')
  const winRemote = `C:/Users/${WIN.user}/AppData/Local/Temp/dsh-live.txt`
  const winUpload = await transfer(winRecord, { direction: 'upload', local: winLocal, remote: winRemote })
  report('上传到 Win10', winUpload.exitCode === 0,
    `exit=${winUpload.exitCode} stderr=${JSON.stringify(winUpload.stderr.trim().slice(0, 200))} notes=${JSON.stringify(winUpload.notes)}`)
  const winRead = await call(winRecord, `type C:\\Users\\${WIN.user}\\AppData\\Local\\Temp\\dsh-live.txt`)
  report('Win10 远端内容一致', winRead.stdout.includes('to windows'), JSON.stringify(winRead.stdout.trim()))
  await call(winRecord, `del C:\\Users\\${WIN.user}\\AppData\\Local\\Temp\\dsh-live.txt`)
} else {
  console.log('SKIP  Win10 用例（未设置 LIVE_WIN_* ）')
}

console.log(`\n${passed} 项通过，${failed} 项失败`)
process.exit(failed > 0 ? 1 : 0)
