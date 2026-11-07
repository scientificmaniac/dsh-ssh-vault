/**
 * 真实环境端到端回归：保险库中的 centos 主机（CentOS 7.9 / OpenSSH 7.4p1）。
 *
 * 凭据全部来自加密保险库（Windows DPAPI 保护），源码不含目标地址与 root 口令：
 *   - 主机记录：`vault.list()` 里 alias=centos 的记录；
 *   - root 口令：`record.auth.password`，只经 askpass 注入子进程环境，不进命令行；
 *   - askpass：`ensureAskpass(vault.dir)`；known_hosts：`vault.knownHostsPath`。
 *
 * 运行（需先准备靶场，步骤见下方 TEST_USER_PASS 注释）：
 *   $env:DSH_CENTOS_TEST_PASS='<临时测试账号口令>'
 *   $env:DSH_CENTOS_ALIAS='centos'   # 可选：默认 centos，可指向同构的 CentOS 靶机
 *   node test/live-centos.mjs
 *
 * 覆盖范围：
 *   1. 基线行为（改造前即成立）：口令登录、显式 bash 包装、known_hosts 哈希、错误口令归因、
 *      超时保留输出、上传/下载回环、CRLF 观测、root-only 文件权限模型、detach + wait_for、
 *      自检命令、大输出截断、非 root 用户的 sudo 三态基线。
 *   2. 改造后新功能（lib 层 API）：默认 `bash -c` 非登录包装、`loginShell` 显式登录环境、
 *      双层引号安全、command_array 逐元素引号、sudo 的 wrap/script/prime 三态、sudo 失败
 *      分类、transfer 的 sudo 读写 root-only 路径、normalize_eol、mode/owner、临时文件清理。
 *   3. SSH 隧道（lib/tunnel.js）：sshd 转发策略探测、转发建议、本地端口预检、真实 -L 转发、
 *      stop 后端口释放、dispose 清理与生命周期事件。
 *   4. 环境观察（不计入 PASS/FAIL）：绕过壳包装时远端登录 shell、远端临时文件清理情况。
 *
 * 约定：
 * - 基线用例逐项打印 PASS/FAIL，末尾给出「N 项通过，M 项失败」；退出码非零表示有失败项。
 * - 所有 SSH 调用严格串行。本机 OpenSSH 9.5p2 不支持 ControlMaster（实测
 *   `getsockname failed: Not a socket`），同一主机并发连接只会让结果更难归因。
 * - 无论成功还是异常，结束时都清理远端 /tmp/dsh-* 临时文件与本地临时目录。
 * - 失败项一律打印 exit code、stdout/stderr 前 200 字符与 notes，便于直接定位。
 */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import {
  buildDetachScript,
  buildSshArgs,
  buildSudoProbeCommand,
  buildWaitScript,
  classifySudoFailure,
  ensureAskpass,
  parseSudoProbe,
  probeCommand,
  quoteArgv,
  runProcess,
  runRemote,
  transferFile,
} from '../lib/ssh.js'
import {
  TunnelManager,
  buildSshdProbeCommand,
  diagnoseForwarding,
  parseForward,
  parseSshdForwarding,
} from '../lib/tunnel.js'
import { Vault, defaultVaultDir, maskHost } from '../lib/vault.js'

/** 目标主机的保险库别名；可用 DSH_CENTOS_ALIAS 指向同构的另一台 CentOS 靶机。 */
const TARGET_ALIAS = process.env.DSH_CENTOS_ALIAS ?? 'centos'
/** 临时测试账号：uid 1000、wheel 组、shell bash，sudo 需要密码。 */
const TEST_USER = 'dshtest'
/**
 * 临时测试账号口令：**只从环境变量读取**，仓库里不保存任何口令。
 * root 口令来自保险库；这个账号不在保险库里，所以由运行者提供。
 */
const TEST_USER_PASS = process.env.DSH_CENTOS_TEST_PASS
/** root:root 600 的测试文件，内容固定为 TOP-SECRET=42。 */
const ROOT_ONLY_FILE = '/etc/dsh-regress/env'
const ROOT_ONLY_EXPECT = 'TOP-SECRET=42'
/** root-only 目录，用于验证 sudo 上传落位与 mode/owner。 */
const ROOT_ONLY_DIR = '/etc/dsh-regress'
const SUDO_UPLOADMENT = `${ROOT_ONLY_DIR}/uploaded-regress.txt`
/** 目录传输用例的远端目标。 */
const REMOTE_DIR_MERGE = '/tmp/dsh-centos-dir-merge'
const REMOTE_DIR_NEST = '/tmp/dsh-centos-dir-nest'
/** 本脚本在远端创建的全部临时文件，结束时要删干净（含 API 内部中转文件）。 */
const REMOTE_TEMP_FILES = [
  '/tmp/dsh-centos-roundtrip.txt',
  '/tmp/dsh-centos-crlf.txt',
  '/tmp/dsh-centos-eol-raw.txt',
  '/tmp/dsh-centos-eol-norm.txt',
  '/tmp/dsh-centos-bin.bin',
  '/tmp/dsh-centos-mode.txt',
  '/tmp/dsh-centos-detach-done',
  SUDO_UPLOADMENT,
  '/tmp/.dsh-ssh-centosregress.log',
  '/tmp/.dsh-ssh-centosregress.pid',
  '/tmp/.dsh-ssh-centosregress.log.done',
]

// 临时测试账号的靶场前置条件（脚本不代为创建，避免在目标机上留下账号）：
//   useradd -m -G wheel -s /bin/bash dshtest
//   printf '%s\n' "$DSH_CENTOS_TEST_PASS" | passwd --stdin dshtest
//   mkdir -p /etc/dsh-regress
//   printf 'TOP-SECRET=42\n' > /etc/dsh-regress/env
//   chmod 600 /etc/dsh-regress/env && chown root:root /etc/dsh-regress/env
if (typeof TEST_USER_PASS !== 'string' || TEST_USER_PASS.length === 0) {
  console.error('缺少 DSH_CENTOS_TEST_PASS：需提供临时测试账号 dshtest 的口令（靶场准备步骤见文件头注释）。')
  process.exit(2)
}

// —— 读取保险库：地址、端口、账号、口令全部从记录里取 ——
const vault = new Vault({ dir: defaultVaultDir(), keyProtection: 'dpapi' })
await vault.ensureDir()
const rootRecord = (await vault.list()).find((item) => item.alias === TARGET_ALIAS)
if (rootRecord === undefined) {
  console.error(`保险库里找不到别名为 ${TARGET_ALIAS} 的主机，无法回归。`)
  process.exit(2)
}
if (rootRecord.auth?.type !== 'password' || typeof rootRecord.auth.password !== 'string') {
  console.error(`${TARGET_ALIAS} 记录不是口令认证或缺少口令，无法回归。`)
  process.exit(2)
}
// dshtest 没有独立的保险库记录：地址/端口沿用 centos 记录，口令是靶场给定的临时账号口令。
const testUserRecord = {
  ...rootRecord,
  alias: `${TARGET_ALIAS}-${TEST_USER}`,
  username: TEST_USER,
  auth: { type: 'password', password: TEST_USER_PASS },
  shell: 'bash',
}
const secret = rootRecord.auth.password
const askpassPath = await ensureAskpass(vault.dir)
const knownHostsPath = vault.knownHostsPath

console.log(
  `dsh-ssh-vault 现场回归 · 目标 ${rootRecord.alias}（${maskHost(rootRecord.host)}:${rootRecord.port}）`
  + ` · 用户 ${rootRecord.username} · 记录 shell=${rootRecord.shell} · node ${process.version}`,
)

let passed = 0
let failed = 0

/**
 * 打印一项 PASS/FAIL 并计数。
 * @param name - 用例名。
 * @param ok - 是否通过。
 * @param detail - 附加说明（失败时必带可定位信息）。
 */
function report(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (detail !== undefined && detail !== '') console.log(`      ${detail}`)
  if (ok) passed += 1
  else failed += 1
}

/**
 * 汇总一次调用的定位信息：退出码、stdout/stderr 片段、notes、截断与超时。
 * @param result - runRemote / transferFile 的返回值。
 * @param max - stdout/stderr 各自截取的字符数。
 * @returns 单行摘要。
 */
function brief(result, max = 200) {
  return [
    `exit=${result.exitCode}`,
    `timedOut=${result.timedOut === true}`,
    `stdout=${JSON.stringify(String(result.stdout ?? '').slice(0, max))}`,
    `stderr=${JSON.stringify(String(result.stderr ?? '').slice(0, max))}`,
    `notes=${JSON.stringify(result.notes ?? [])}`,
  ].join(' ')
}

/**
 * 把文本安全地包成 POSIX 单引号字面量。
 * @param text - 任意文本。
 * @returns 可直接嵌入 shell 脚本的字面量。
 */
function quotePosix(text) {
  return `'${String(text).replace(/'/g, `'\\''`)}'`
}

/** 新建进程级公共连接参数。 */
const baseOptions = { connectTimeoutSec: 15, timeoutMs: 60000, maxOutputBytes: 100000 }

/**
 * 在指定主机记录上执行一次远端命令（串行，口令经 askpass 注入）。
 * @param record - 主机记录。
 * @param command - 远端 shell 脚本。
 * @param extra - 覆盖默认参数。
 * @returns runRemote 的结果。
 */
const runFor = (record, command, extra = {}) => runRemote({
  record,
  secret: record.auth.password,
  command,
  askpassPath,
  knownHostsPath,
  ...baseOptions,
  ...extra,
})

/** 以 centos（root）身份执行命令。 */
const call = (command, extra = {}) => runFor(rootRecord, command, extra)

/**
 * 在指定主机记录上传输一个文件。
 * @param record - 主机记录。
 * @param extra - 方向、本地与远端路径，以及 sudo/normalizeEol/mode/owner 等选项。
 * @returns transferFile 的结果。
 */
const transferFor = (record, extra) => transferFile({
  record,
  secret: record.auth.password,
  askpassPath,
  knownHostsPath,
  ...baseOptions,
  ...extra,
})

/** 以 centos（root）身份传输文件。 */
const transfer = (extra) => transferFor(rootRecord, extra)

/**
 * 删除远端本脚本产生的临时文件，并核对是否还有残留。
 */
async function cleanupRemote() {
  const script = [
    `rm -f ${REMOTE_TEMP_FILES.map(quotePosix).join(' ')}`,
    `rm -rf ${[REMOTE_DIR_MERGE, REMOTE_DIR_NEST].map(quotePosix).join(' ')}`,
    'rm -f /tmp/.dsh-xfer-* /tmp/.dsh-ssh-sudo-*.sh 2>/dev/null',
    'echo "##cleanup##ok"',
  ].join('\n')
  try {
    const result = await call(script, { timeoutMs: 20000 })
    console.log(`OBSERVE  远端临时文件清理：exit=${result.exitCode} ${JSON.stringify(result.stdout.trim().slice(0, 120))}`)
    const leftover = await call('ls -d /tmp/dsh-centos-* 2>/dev/null | wc -l', { timeoutMs: 20000 })
    console.log(`OBSERVE  残留 dsh-centos 临时文件数：${leftover.stdout.trim()}`)
  } catch (error) {
    console.log(`OBSERVE  远端临时文件清理失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * 在 127.0.0.1 上找一个空闲端口（listen 0 让内核分配，再立刻释放）。
 * @returns 可用端口号。
 */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

/**
 * 尝试占用 127.0.0.1:port，用于判断端口是否已释放。
 * @param port - 端口号。
 * @returns 能监听时为 true。
 */
function tryListen(port) {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.listen({ host: '127.0.0.1', port }, () => server.close(() => resolve(true)))
  })
}

/**
 * 轮询等待本地端口释放（隧道进程退出与端口回收之间可能有短暂延迟）。
 * @param port - 端口号。
 * @param timeoutMs - 最长等待时间。
 * @returns 端口已释放时为 true。
 */
async function waitPortFree(port, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await tryListen(port)) return true
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return false
}

/**
 * 从本地端口读一行 SSH banner，验证转发链路真的通到了远端 sshd。
 * @param port - 本地监听端口。
 * @param timeoutMs - 等待超时。
 * @returns 读到的文本。
 */
function readBanner(port, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port })
    let text = ''
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`等待本地 ${port} 的 SSH banner 超时`))
    }, timeoutMs)
    socket.setEncoding('utf8')
    socket.on('data', (chunk) => {
      text += chunk
      if (text.includes('\n')) {
        clearTimeout(timer)
        socket.end()
        resolve(text)
      }
    })
    socket.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

const localDir = await mkdtemp(path.join(os.tmpdir(), 'dsh-centos-live-'))

try {
  // ============================================================
  // 一、基线用例（改造前即成立的行为）
  // ============================================================

  // —— 1. 口令登录：记录原样（shell=bash），真实登录 shell 是 zsh ——
  const login = await call('id -un; hostname; uname -sr')
  report(
    '口令登录并在记录声明 shell=bash 下执行 id/hostname/uname',
    login.exitCode === 0 && login.stdout.includes('root') && login.stdout.includes('Linux'),
    `${brief(login)} remoteShell=${login.remoteShell}`,
  )

  // —— 2. 显式 bash 包装的基线证据：远端实际解释器是不是 bash ——
  // 登录 shell 是 zsh，但插件必须显式指定 bash 解析命令，否则 `grep '^\[login\]'` 这类
  // 写法在不同登录 shell 下含义不同。这里记录 $0 与 $BASH_VERSION 作为证据。
  const shellEvidence = await call('echo "##shell0##$0"; echo "##bashver##$BASH_VERSION"; echo "##loginpasswd##$(getent passwd root | cut -d: -f7)"')
  const shell0 = /##shell0##([^\n]*)/.exec(shellEvidence.stdout)?.[1]?.trim() ?? ''
  const bashVersion = /##bashver##([^\n]*)/.exec(shellEvidence.stdout)?.[1]?.trim() ?? ''
  const passwdShell = /##loginpasswd##([^\n]*)/.exec(shellEvidence.stdout)?.[1]?.trim() ?? ''
  report(
    '远端命令由 bash 执行（$0 与 BASH_VERSION 基线证据）',
    shellEvidence.exitCode === 0 && /bash/i.test(shell0) && bashVersion.length > 0,
    `$0=${JSON.stringify(shell0)} BASH_VERSION=${JSON.stringify(bashVersion)} `
    + `passwd登录shell=${JSON.stringify(passwdShell)} ${brief(shellEvidence)}`,
  )

  // —— 3. known_hosts 哈希化：全部 |1| 前缀，且不含明文地址 ——
  const known = await readFile(knownHostsPath, 'utf8').catch(() => '')
  const knownLines = known.split(/\r?\n/).filter((line) => line.trim().length > 0)
  report(
    'known_hosts 全部哈希（|1| 前缀）且不含明文地址',
    knownLines.length > 0
    && knownLines.every((line) => line.startsWith('|1|'))
    && !known.includes(rootRecord.host),
    `行数=${knownLines.length} 首行前缀=${JSON.stringify(knownLines[0]?.slice(0, 12))} `
    + `含明文地址=${known.includes(rootRecord.host)}`,
  )

  // —— 4. 错误口令归因 ——
  const wrong = await runFor(
    { ...rootRecord, auth: { type: 'password', password: 'definitely-wrong-password' } },
    'echo SHOULD_NOT_RUN',
    { secret: 'definitely-wrong-password' },
  )
  report(
    '错误口令归因为账号或口令不正确',
    wrong.exitCode !== 0 && wrong.notes.some((note) => note.includes('账号或口令不正确')),
    brief(wrong),
  )

  // —— 5. 超时仍保留已产生的输出（中断不等于失明）——
  const slow = await call('echo BEFORE_SLEEP_MARK; sleep 30; echo AFTER_SLEEP_MARK', { timeoutMs: 6000 })
  report(
    '超时（6s）仍保留已产生输出',
    slow.timedOut === true && slow.stdout.includes('BEFORE_SLEEP_MARK'),
    brief(slow),
  )

  // —— 6/7/8. 上传 / 回读 / 下载回环 ——
  const localFile = path.join(localDir, 'roundtrip.txt')
  const roundtripContent = `from-windows-${Date.now()}\nline2-中文内容\n`
  await writeFile(localFile, roundtripContent, 'utf8')
  const remoteFile = '/tmp/dsh-centos-roundtrip.txt'
  const upload = await transfer({ direction: 'upload', local: localFile, remote: remoteFile })
  report('上传本地文件到 centos 的 /tmp', upload.exitCode === 0, brief(upload))
  const readBack = await call(`cat ${remoteFile}`)
  report(
    '远端 cat 回读内容与本地一致（含中文）',
    readBack.exitCode === 0
    && readBack.stdout.includes('from-windows')
    && readBack.stdout.includes('line2-中文内容'),
    brief(readBack),
  )
  const localDownload = path.join(localDir, 'downloaded.txt')
  const download = await transfer({ direction: 'download', local: localDownload, remote: remoteFile })
  const downloadedText = await readFile(localDownload, 'utf8').catch(() => '')
  report(
    '下载回本地内容与远端一致',
    download.exitCode === 0 && downloadedText === roundtripContent,
    `${brief(download)} 本地内容=${JSON.stringify(downloadedText.slice(0, 120))}`,
  )

  // —— 9. CRLF 上传行为观测（基线不强制，只记录当前行为）——
  // 改造前 scp 原样传输；改造后 normalize_eol 才会改写，见后面的新功能用例。
  const crlfLocal = path.join(localDir, 'crlf.txt')
  const crlfRemote = '/tmp/dsh-centos-crlf.txt'
  await writeFile(crlfLocal, 'alpha\r\nbeta\r\n', 'utf8')
  const crlfUpload = await transfer({ direction: 'upload', local: crlfLocal, remote: crlfRemote })
  const crlfOd = await call(`od -An -c ${crlfRemote}`)
  const crlfKept = /\\r/.test(crlfOd.stdout)
  report(
    'CRLF 文件上传行为观测（基线不强制，仅记录）',
    crlfUpload.exitCode === 0 && crlfOd.exitCode === 0,
    `CRLF保留=${crlfKept} od=${JSON.stringify(crlfOd.stdout.trim().slice(0, 160))} ${brief(crlfUpload)}`,
  )

  // —— 10. root 可读 root-only 文件（验证靶场权限模型）——
  const rootRead = await call(`cat ${ROOT_ONLY_FILE}`)
  report(
    `root 直接读取 ${ROOT_ONLY_FILE} 得到 ${ROOT_ONLY_EXPECT}`,
    rootRead.exitCode === 0 && rootRead.stdout.includes(ROOT_ONLY_EXPECT),
    brief(rootRead),
  )

  // —— 11. dshtest 读不到 root-only 文件（验证靶场有效）——
  const denied = await call(`su - ${TEST_USER} -c ${quotePosix(`cat ${ROOT_ONLY_FILE}`)} 2>&1; echo "##denied_exit##$?"`)
  const deniedExit = /##denied_exit##(\d+)/.exec(denied.stdout)?.[1] ?? ''
  report(
    `${TEST_USER} 无法读取 ${ROOT_ONLY_FILE}`,
    denied.exitCode === 0
    && deniedExit !== '' && deniedExit !== '0'
    && /Permission denied|权限不够|拒绝/.test(denied.stdout),
    `内部退出码=${deniedExit} ${brief(denied)}`,
  )

  // —— 12/13. detach + wait_for：远端后台进程在本地返回后继续跑完 ——
  await call(`rm -f /tmp/dsh-centos-detach-done /tmp/.dsh-ssh-centosregress.log /tmp/.dsh-ssh-centosregress.pid`)
  const detachStarted = Date.now()
  const detached = await call(buildDetachScript({
    command: 'sleep 4; echo DETACH_DONE > /tmp/dsh-centos-detach-done',
    token: 'centosregress',
  }))
  const detachElapsed = Date.now() - detachStarted
  report(
    'detach 立即返回并给出 pid 与日志路径',
    detached.exitCode === 0
    && detached.stdout.includes('已在远端后台启动')
    && detached.stdout.includes('.dsh-ssh-centosregress.log'),
    `耗时=${detachElapsed}ms ${brief(detached)}`,
  )
  const waited = await call(buildWaitScript({
    path: '/tmp/dsh-centos-detach-done',
    regex: 'DETACH_DONE',
    timeoutMs: 30000,
    intervalMs: 500,
  }))
  report(
    'wait_for 等到 detach 写入的结束标记',
    waited.exitCode === 0 && waited.stdout.includes('条件满足') && waited.stdout.includes('DETACH_DONE'),
    `耗时=${Date.now() - detachStarted}ms ${brief(waited)}`,
  )

  // —— 14. probeCommand('bash') 自检命令可执行 ——
  const selfCheck = await call(probeCommand('bash'))
  report(
    'probeCommand(bash) 输出含 ##identity##',
    selfCheck.exitCode === 0
    && selfCheck.stdout.includes('##identity##')
    && selfCheck.stdout.includes('##kernel##'),
    brief(selfCheck),
  )

  // —— 15. 大输出按 maxOutputBytes 截断，并保留开头与结尾 ——
  const bigDumpBase = path.join(localDir, 'bigdump')
  const big = await call('seq 1 200000', { maxOutputBytes: 10000, outputBase: bigDumpBase })
  const bigDump = await readFile(`${bigDumpBase}.stdout.log`, 'utf8').catch(() => '')
  report(
    '大输出（seq 1 200000）按 maxOutputBytes=10000 截断且保留头尾',
    big.stdoutTruncated === true
    && big.stdout.startsWith('1\n2\n')
    && big.stdout.includes('\n199999\n200000')
    && big.stdout.includes('characters omitted')
    && big.stdoutTotal > 10000
    && big.stdoutOmitted > 0,
    `stdoutTruncated=${big.stdoutTruncated === true} 长度=${big.stdout.length} total=${big.stdoutTotal} `
    + `omitted=${big.stdoutOmitted} 尾部=${JSON.stringify(big.stdout.slice(-60))} ${brief(big, 80)}`,
  )
  report(
    '截断时完整输出落盘且字符数等于原始输出',
    bigDump.length === 1288895,
    `dumpLength=${bigDump.length} ${JSON.stringify(bigDump.slice(-20))}`,
  )

  // —— 16/17. 非 root 用户的 sudo 三态基线：-n 需要密码、-S 可用 ——
  const nopass = await call(`su - ${TEST_USER} -c ${quotePosix('sudo -n true')} 2>&1; echo "##nopass_exit##$?"`)
  const nopassExit = /##nopass_exit##(\d+)/.exec(nopass.stdout)?.[1] ?? ''
  report(
    `${TEST_USER} 的 sudo -n 需要密码（三态基线：needPassword）`,
    nopass.exitCode === 0 && nopassExit !== '' && nopassExit !== '0',
    `内部退出码=${nopassExit} ${brief(nopass)}`,
  )
  const sudoPass = await call(
    `printf '%s\\n' ${quotePosix(TEST_USER_PASS)} | su - ${TEST_USER} -c ${quotePosix('sudo -S -p "" -v')} 2>&1; echo "##sudopass_exit##$?"`,
  )
  const sudoPassExit = /##sudopass_exit##(\d+)/.exec(sudoPass.stdout)?.[1] ?? ''
  report(
    `${TEST_USER} 的 sudo -S 用口令预热成功`,
    sudoPassExit === '0',
    `内部退出码=${sudoPassExit} ${brief(sudoPass)}`,
  )

  // —— 18. 附加：记录声明为 zsh 时包装成 zsh 也能工作（额外覆盖，主用例仍用记录原样）——
  const zshRun = await runFor({ ...rootRecord, shell: 'zsh' }, 'echo "##z0##$0"; echo "##zver##$ZSH_VERSION"; id -un')
  const zsh0 = /##z0##([^\n]*)/.exec(zshRun.stdout)?.[1]?.trim() ?? ''
  const zshVersion = /##zver##([^\n]*)/.exec(zshRun.stdout)?.[1]?.trim() ?? ''
  report(
    '记录声明 shell=zsh 时命令可执行（附加覆盖）',
    zshRun.exitCode === 0 && /zsh/i.test(zsh0) && zshVersion.length > 0,
    `$0=${JSON.stringify(zsh0)} ZSH_VERSION=${JSON.stringify(zshVersion)} remoteShell=${zshRun.remoteShell} ${brief(zshRun)}`,
  )

  // ============================================================
  // 二、改造后新功能（lib/ssh.js 层 API）
  // ============================================================

  // —— 19. 默认包装是 bash --norc -c（非登录）：不加载 profile，stderr 干净 ——
  // RHEL/CentOS 的 bash 带 SSH_SOURCE_BASHRC 补丁：环境里有 SSH_CLIENT/SSH_CONNECTION 时，
  // **非交互** bash 也会 source ~/.bashrc。centos 的 /root/.bashrc 第 16 行 source 了不存在的
  // clashctl 脚本，于是每条命令的 stderr 都会被塞一行报错。外层加 `--norc` 才能彻底干净。
  // 登录 shell 是 zsh、记录写 bash；默认非登录包装既固定解析器，又不把用户 profile 的
  // 提示/报错混进 stderr。
  const defaultShell = await call('echo "##s0##$0"; echo "##ver##$BASH_VERSION"')
  report(
    '默认包装为 bash --norc -c（非登录、不加载 profile）',
    defaultShell.exitCode === 0
    && defaultShell.remoteShell === 'bash --norc -c'
    && defaultShell.shellMode === 'argument'
    && /##s0##bash/.test(defaultShell.stdout)
    && !/\.bashrc|\.bash_profile|profile/.test(defaultShell.stderr),
    `remoteShell=${defaultShell.remoteShell} shellMode=${defaultShell.shellMode} ${brief(defaultShell)}`,
  )

  // —— 20. loginShell:true 时显式走 bash -lc（需要 profile 里的 PATH 等环境时使用）——
  // 这条路径按设计会加载 /etc/profile 与 ~/.bash_profile，本机 root 的坏 .bashrc 会带来
  // 噪声——那是「要登录环境」的预期代价，这里只断言包装方式与命令本身成功，不断言 stderr。
  const loginShellRun = await call('echo "##s0##$0"; echo "##home##$HOME"', { loginShell: true })
  report(
    'loginShell:true 时显式走 bash -lc',
    loginShellRun.exitCode === 0
    && loginShellRun.remoteShell === 'bash -lc'
    && loginShellRun.shellMode === 'argument'
    && /##s0##bash/.test(loginShellRun.stdout)
    && /##home##\/root/.test(loginShellRun.stdout),
    `remoteShell=${loginShellRun.remoteShell} shellMode=${loginShellRun.shellMode} ${brief(loginShellRun)}`,
  )

  // —— 21. 双层引号安全：脚本经远端登录 shell（zsh）转交 bash 时不被改写 ——
  const quoting = await call(`echo '##literal##$HOME 和 $(id -un)'; echo "##expanded##$HOME"`)
  report(
    'bash -c 双层引号安全：单引号内容不被外层登录 shell 改写',
    quoting.exitCode === 0
    && quoting.stdout.includes('##literal##$HOME 和 $(id -un)')
    && /##expanded##\/root/.test(quoting.stdout),
    brief(quoting),
  )

  // —— 22/23. command_array：逐元素引号，末端用户控制的分词/通配/展开全部失效 ——
  const argvExpected = "[a b][$HOME][*][it's][$(id -un)]"
  const argvRun = await runRemote({
    record: rootRecord,
    secret,
    commandArray: ['printf', '[%s]', 'a b', '$HOME', '*', "it's", '$(id -un)'],
    askpassPath,
    knownHostsPath,
    ...baseOptions,
  })
  report(
    'command_array 每个元素独立引号、无分词/通配/展开',
    argvRun.exitCode === 0 && argvRun.stdout.trim() === argvExpected,
    `期望=${JSON.stringify(argvExpected)} 实际=${JSON.stringify(argvRun.stdout.trim())} ${brief(argvRun)}`,
  )
  let argvEmptyError = ''
  try { quoteArgv([]) } catch (error) { argvEmptyError = error instanceof Error ? error.message : String(error) }
  let argvElementError = ''
  try { quoteArgv(['ok', '']) } catch (error) { argvElementError = error instanceof Error ? error.message : String(error) }
  report(
    'command_array 空数组/空元素被拒绝并给中文说明',
    argvEmptyError.length > 0 && argvElementError.length > 0,
    `empty=${JSON.stringify(argvEmptyError)} badElement=${JSON.stringify(argvElementError)}`,
  )

  // —— 24/25/26. root 上的 sudo 三态：wrap（免密）/ script（临时脚本）/ prime（预热）——
  const rootWrap = await call('id -un', { sudoMode: 'wrap' })
  report(
    'root + sudoMode=wrap（免密 sudo 包装，stderr 无 profile 噪声）',
    rootWrap.exitCode === 0
    && rootWrap.stdout.trim() === 'root'
    && rootWrap.sudoMode === 'wrap'
    // wrap 模式用 `sudo -n bash -c`，不加载 /etc/profile 与 ~/.bash_profile，
    // 因此 root 家目录里坏掉的 .bashrc 不会把报错混进 stderr。
    && !/\.bashrc|\.bash_profile|\/etc\/profile/.test(rootWrap.stderr),
    brief(rootWrap),
  )
  const rootScript = await call('id -un; echo "##six##$((6*7))"', { sudoMode: 'script', sudoPassword: secret })
  report(
    'root + sudoMode=script（临时脚本 root 执行）',
    rootScript.exitCode === 0
    && /^root$/m.test(rootScript.stdout)
    && rootScript.stdout.includes('##six##42')
    && rootScript.sudoMode === 'script',
    brief(rootScript),
  )
  const rootPrime = await call('sudo -n true && echo PRIMED', { sudoMode: 'prime', sudoPassword: secret })
  report(
    'root + sudoMode=prime（预热后命令内自己写 sudo）',
    rootPrime.exitCode === 0 && rootPrime.stdout.includes('PRIMED') && rootPrime.sudoMode === 'prime',
    brief(rootPrime),
  )

  // —— 27. dshtest 的 sudo 探测结论应是 password ——
  const sudoProbe = await runFor(testUserRecord, buildSudoProbeCommand())
  const sudoState = parseSudoProbe(sudoProbe.stdout)
  report(
    `${TEST_USER} sudo 探测结论 = password`,
    sudoProbe.exitCode === 0 && sudoState === 'password',
    `state=${sudoState} ${brief(sudoProbe)}`,
  )

  // —— 28. dshtest + wrap 但保险库无 sudo 口令 → 失败并归因 needPassword ——
  const dsWrap = await runFor(testUserRecord, 'id -un', { sudoMode: 'wrap' })
  report(
    `${TEST_USER} + wrap 无 sudo 口令 → 失败并归因 needPassword`,
    dsWrap.exitCode !== 0
    && dsWrap.category === 'sudo'
    && /需要密码|password is required/i.test(dsWrap.stderr)
    && dsWrap.notes.some((note) => note.includes('sudoPassword')),
    `category=${dsWrap.category} ${brief(dsWrap)}`,
  )

  // —— 29. dshtest + script + 口令 → 以 root 执行并读到 root-only 文件 ——
  const dsScript = await runFor(testUserRecord, 'id -un; cat /etc/dsh-regress/env', {
    sudoMode: 'script',
    sudoPassword: TEST_USER_PASS,
  })
  report(
    `${TEST_USER} + script + 口令 → 以 root 执行并读到 root-only 文件`,
    dsScript.exitCode === 0
    && /^root$/m.test(dsScript.stdout)
    && dsScript.stdout.includes(ROOT_ONLY_EXPECT)
    && dsScript.sudoMode === 'script',
    brief(dsScript),
  )

  // —— 30. sudo 临时脚本执行后不留在远端 ——
  const sudoLeftover = await call('ls /tmp/.dsh-ssh-sudo-*.sh 2>/dev/null | wc -l')
  report(
    'sudo 临时脚本执行后已清理',
    sudoLeftover.exitCode === 0 && sudoLeftover.stdout.trim() === '0',
    brief(sudoLeftover),
  )

  // —— 31. dshtest + prime + 口令 → 缓存预热后命令内 sudo 可用 ——
  const dsPrime = await runFor(testUserRecord, 'sudo -n true && echo PRIMED && sudo whoami', {
    sudoMode: 'prime',
    sudoPassword: TEST_USER_PASS,
  })
  report(
    `${TEST_USER} + prime + 口令 → 预热后命令内 sudo 可用`,
    dsPrime.exitCode === 0
    && dsPrime.stdout.includes('PRIMED')
    && /^root$/m.test(dsPrime.stdout)
    && dsPrime.sudoMode === 'prime',
    brief(dsPrime),
  )

  // —— 32. sudo 失败分类纯函数：need-password / not-in-sudoers ——
  const clsNeedPassword = classifySudoFailure('sudo: 需要密码')
  const clsNotInSudoers = classifySudoFailure(`${TEST_USER} is not in the sudoers file.  This incident will be reported.`)
  report(
    'sudo 失败分类：need-password 与 not-in-sudoers 均可识别',
    clsNeedPassword.kind === 'need-password' && clsNotInSudoers.kind === 'not-in-sudoers',
    `needPassword=${JSON.stringify(clsNeedPassword)} notInSudoers=${JSON.stringify(clsNotInSudoers)}`,
  )

  // —— 33/34. transfer 的 sudo 读 root-only 文件（dshtest 身份）——
  const noSudoLocal = path.join(localDir, 'env-nosudo.txt')
  const noSudo = await transferFor(testUserRecord, {
    direction: 'download',
    local: noSudoLocal,
    remote: ROOT_ONLY_FILE,
  })
  report(
    `${TEST_USER} 普通下载 ${ROOT_ONLY_FILE} 应失败`,
    noSudo.exitCode !== 0,
    brief(noSudo),
  )
  const sudoDownLocal = path.join(localDir, 'env-sudo.txt')
  const sudoDown = await transferFor(testUserRecord, {
    direction: 'download',
    local: sudoDownLocal,
    remote: ROOT_ONLY_FILE,
    sudo: true,
    sudoPassword: TEST_USER_PASS,
  })
  const sudoDownContent = await readFile(sudoDownLocal, 'utf8').catch(() => '')
  report(
    `${TEST_USER} + transfer sudo 下载 root-only 文件成功`,
    sudoDown.exitCode === 0
    && sudoDownContent.includes(ROOT_ONLY_EXPECT)
    && sudoDown.notes.some((note) => note.includes('sudo') || note.includes('临时文件')),
    `内容=${JSON.stringify(sudoDownContent)} ${brief(sudoDown)}`,
  )

  // —— 35/36. normalize_eol：文本 CRLF → LF；二进制跳过 ——
  const rawUp = await transfer({ direction: 'upload', local: crlfLocal, remote: '/tmp/dsh-centos-eol-raw.txt' })
  const rawOd = await call('od -An -c /tmp/dsh-centos-eol-raw.txt')
  const normUp = await transfer({
    direction: 'upload',
    local: crlfLocal,
    remote: '/tmp/dsh-centos-eol-norm.txt',
    normalizeEol: true,
  })
  const normOd = await call('od -An -c /tmp/dsh-centos-eol-norm.txt')
  report(
    'normalize_eol=true 上传后远端无 \\r（对照组保留 \\r）',
    rawUp.exitCode === 0
    && normUp.exitCode === 0
    && /\\r/.test(rawOd.stdout)
    && !/\\r/.test(normOd.stdout)
    && normUp.notes.some((note) => note.includes('CRLF') || note.includes('规范化')),
    `rawOd=${JSON.stringify(rawOd.stdout.trim())} normOd=${JSON.stringify(normOd.stdout.trim())} notes=${JSON.stringify(normUp.notes)}`,
  )
  const binaryLocal = path.join(localDir, 'binary.bin')
  await writeFile(binaryLocal, Buffer.from([0x41, 0x00, 0x42, 0x0d, 0x0a]))
  const binaryUp = await transfer({
    direction: 'upload',
    local: binaryLocal,
    remote: '/tmp/dsh-centos-bin.bin',
    normalizeEol: true,
  })
  const binaryOd = await call('od -An -tx1 /tmp/dsh-centos-bin.bin')
  report(
    'normalize_eol 对疑似二进制跳过规范化（NUL 原样保留）',
    binaryUp.exitCode === 0
    && binaryUp.notes.some((note) => note.includes('二进制') || note.includes('binary'))
    && /00/.test(binaryOd.stdout),
    `od=${JSON.stringify(binaryOd.stdout.trim())} notes=${JSON.stringify(binaryUp.notes)} ${brief(binaryUp, 80)}`,
  )

  // —— 37. 普通上传应用 mode ——
  const modeLocal = path.join(localDir, 'mode.txt')
  await writeFile(modeLocal, 'mode-test\n', 'utf8')
  const modeUp = await transfer({ direction: 'upload', local: modeLocal, remote: '/tmp/dsh-centos-mode.txt', mode: '600' })
  const modeStat = await call("stat -c '%a' /tmp/dsh-centos-mode.txt")
  report(
    '普通上传应用 mode=600',
    modeUp.exitCode === 0
    && modeStat.stdout.trim() === '600'
    && modeUp.notes.some((note) => note.includes('权限')),
    `stat=${JSON.stringify(modeStat.stdout.trim())} ${brief(modeUp)}`,
  )

  // —— 38. dshtest + sudo 上传到 root-only 目录，并应用 mode/owner ——
  const ownerUp = await transferFor(testUserRecord, {
    direction: 'upload',
    local: modeLocal,
    remote: SUDO_UPLOADMENT,
    sudo: true,
    sudoPassword: TEST_USER_PASS,
    mode: '640',
    owner: 'root:root',
  })
  const ownerStat = await call(`stat -c '%a %U:%G' ${SUDO_UPLOADMENT}; cat ${SUDO_UPLOADMENT}`)
  report(
    `${TEST_USER} + sudo 上传到 root-only 目录并应用 mode/owner`,
    ownerUp.exitCode === 0
    && ownerStat.stdout.includes('640 root:root')
    && ownerStat.stdout.includes('mode-test')
    && ownerUp.notes.some((note) => note.includes('属主'))
    && ownerUp.notes.some((note) => note.includes('权限')),
    `stat=${JSON.stringify(ownerStat.stdout)} ${brief(ownerUp)}`,
  )

  // ============================================================
  // 三、SSH 隧道能力（lib/tunnel.js）
  // ============================================================

  // —— 39. 纯函数：parseForward 支持 3/4 段，非法输入给中文说明 ——
  const forward3 = parseForward('18787:127.0.0.1:8787')
  const forward4 = parseForward('0.0.0.0:18788:127.0.0.1:8787')
  let forwardError = ''
  try { parseForward('18787:127.0.0.1') } catch (error) { forwardError = error instanceof Error ? error.message : String(error) }
  report(
    'parseForward 支持 3/4 段并拒绝非法规则（中文说明）',
    forward3.localHost === '127.0.0.1'
    && forward3.localPort === 18787
    && forward3.remoteHost === '127.0.0.1'
    && forward3.remotePort === 8787
    && forward4.localHost === '0.0.0.0'
    && forward4.localPort === 18788
    && forwardError.length > 0,
    `3段=${JSON.stringify(forward3)} 4段=${JSON.stringify(forward4)} 非法=${JSON.stringify(forwardError)}`,
  )

  // —— 40. 远端 sshd 生效配置探测（root 可直接 sshd -T）——
  const forwardProbe = await call(buildSshdProbeCommand())
  const forwarding = parseSshdForwarding(forwardProbe.stdout)
  report(
    'sshd 转发策略探测：AllowTcpForwarding 允许、来源 sshd -T',
    forwardProbe.exitCode === 0
    && ['yes', 'all'].includes(forwarding.allowTcpForwarding)
    && forwarding.source === 'sshd-T',
    `parsed=${JSON.stringify(forwarding)} ${brief(forwardProbe)}`,
  )

  // —— 41. 纯函数：sshd 拒绝转发时给 Match User 精确建议（不真改远端 sshd）——
  const forwardingAdvice = diagnoseForwarding({ allowTcpForwarding: 'no', permitOpen: ['any'], user: 'root' })
  const forwardingAdviceText = forwardingAdvice.join('\n')
  report(
    'sshd 关闭转发时给出 Match User/LocalForwarding/PermitOpen 建议',
    forwardingAdvice.length > 0
    && /Match User/.test(forwardingAdviceText)
    && /LocalForwarding/.test(forwardingAdviceText)
    && /PermitOpen/.test(forwardingAdviceText),
    JSON.stringify(forwardingAdvice),
  )

  // —— 42~46. TunnelManager：端口预检、真实 -L 转发、stop 释放、dispose 清理 ——
  const tunnelEvents = []
  const manager = new TunnelManager({ onEvent: (event) => tunnelEvents.push(event) })
  let tunnelPort = 0
  try {
    // 42. 本地端口被占用时，start 必须在 spawn 之前拦下（否则 bind 失败容易被误判成服务器问题）。
    const busyPort = await findFreePort()
    const busyServer = net.createServer()
    await new Promise((resolve, reject) => {
      busyServer.once('error', reject)
      busyServer.listen({ host: '127.0.0.1', port: busyPort }, resolve)
    })
    let busyError
    try {
      await manager.start({
        record: rootRecord,
        secret,
        askpassPath,
        knownHostsPath,
        connectTimeoutSec: 15,
        forwards: [`${busyPort}:127.0.0.1:22`],
        label: 'centos-busy-port',
      })
    } catch (error) {
      busyError = error
    }
    await new Promise((resolve) => busyServer.close(resolve))
    report(
      '隧道启动前预检本地端口占用（EADDRINUSE，中文提示）',
      busyError?.code === 'EADDRINUSE' && /已被占用/.test(busyError.message),
      `code=${busyError?.code} message=${JSON.stringify(busyError?.message)}`,
    )

    // 43. 真实 -L 转发：本地端口 → centos 的 127.0.0.1:22，从 Windows 侧连接读 SSH banner。
    tunnelPort = await findFreePort()
    const started = await manager.start({
      record: rootRecord,
      secret,
      askpassPath,
      knownHostsPath,
      connectTimeoutSec: 15,
      forwards: [`${tunnelPort}:127.0.0.1:22`],
      label: 'centos-regress',
    })
    report(
      'TunnelManager.start 返回 id/forwards/localUrls/pid',
      typeof started.id === 'string'
      && started.forwards[0] === `127.0.0.1:${tunnelPort}:127.0.0.1:22`
      && started.localUrls[0] === `tcp://127.0.0.1:${tunnelPort}`
      && Number.isInteger(started.pid),
      JSON.stringify(started),
    )
    const banner = await readBanner(tunnelPort)
    report(
      '本地 -L 转发真实连通远端 sshd（读到 SSH banner）',
      /^SSH-2\.0-OpenSSH_/.test(banner.trim()),
      `banner=${JSON.stringify(banner.trim().slice(0, 80))}`,
    )
    const listed = manager.list().find((item) => item.id === started.id)
    report(
      'TunnelManager.list 报告 running 状态',
      listed?.status === 'running' && listed?.attempts === 0,
      JSON.stringify(listed),
    )

    // 44. stop 后端口必须释放，list 不再包含该隧道。
    const stopResult = await manager.stop({ id: started.id })
    const released = await waitPortFree(tunnelPort)
    report(
      'TunnelManager.stop 后本地端口释放且 list 清空',
      stopResult.stopped === true && released && manager.list().every((item) => item.id !== started.id),
      `stop=${JSON.stringify(stopResult)} released=${released} list=${JSON.stringify(manager.list())}`,
    )

    // 45. dispose 一次性清理：再起一条隧道，dispose 应返回清理条数并释放端口。
    const secondPort = await findFreePort()
    await manager.start({
      record: rootRecord,
      secret,
      askpassPath,
      knownHostsPath,
      connectTimeoutSec: 15,
      forwards: [`${secondPort}:127.0.0.1:22`],
      label: 'centos-dispose',
    })
    const disposed = await manager.dispose()
    const disposedReleased = await waitPortFree(secondPort)
    report(
      'TunnelManager.dispose 清理全部隧道并释放端口',
      disposed === 1 && disposedReleased && manager.list().length === 0,
      `disposed=${disposed} released=${disposedReleased} events=${JSON.stringify(tunnelEvents.map((event) => event.type))}`,
    )
  } finally {
    // 兜底：任何失败都不能留下 ssh 子进程。
    await manager.dispose().catch(() => undefined)
  }

  // —— 46. 隧道正常生命周期内不应出现掉线/重连事件 ——
  report(
    '隧道正常生命周期内无 dropped/reconnecting 事件',
    !tunnelEvents.some((event) => event.type === 'dropped' || event.type === 'reconnecting'),
    `events=${JSON.stringify(tunnelEvents)}`,
  )

  // ============================================================
  // 四、用户报告问题的回归（真实主机）
  // ============================================================

  // —— 47~49. 会话自伤：pkill -f 的模式串出现在命令文本里，先匹配到承载它的 shell ——
  // 这是用户现场的真实成因：`bash -lc "<整段命令>"` 的 cmdline 里含模式串，pkill -f 把会话杀掉。
  const SELF_KILL_MARK = 'DSH_SELFKILL_DEMO_20261107'
  const selfKill = await call(`pkill -f ${SELF_KILL_MARK}; echo AFTER_SELFKILL`)
  report(
    'pkill -f 自伤：退出码归一化为 -1（不再是 4294967295）',
    selfKill.exitCode === -1,
    brief(selfKill),
  )
  report(
    'pkill -f 自伤：分类为连接层而不是远端命令层',
    selfKill.category === 'connection',
    `category=${selfKill.category} ${brief(selfKill)}`,
  )
  report(
    'pkill -f 自伤：无输出时给出「杀死了承载自己的会话」与 pkill -x / 脚本文件改法',
    selfKill.stdout.length === 0
    && selfKill.notes.some((note) => note.includes('自己的 SSH 会话'))
    && selfKill.notes.some((note) => note.includes('pkill -x'))
    && selfKill.notes.some((note) => note.includes('bash 文件')),
    `stdout=${JSON.stringify(selfKill.stdout)} notes=${JSON.stringify(selfKill.notes)}`,
  )
  // 对照：`pkill -x` 按进程名匹配，不会命中承载命令的 bash。
  const noSelfMatch = await call('pkill -x no-such-proc-20261107; echo RC=$?')
  report(
    '对照：pkill -x 不匹配任何进程时正常返回（RC=1，整体退出 0）',
    noSelfMatch.exitCode === 0 && noSelfMatch.stdout.includes('RC=1'),
    brief(noSelfMatch),
  )
  // 普通远端退出码不能被归一化逻辑误伤。
  const exitSeven = await call('echo BEFORE_EXIT; exit 7')
  report(
    '普通远端退出码 7 原样保留',
    exitSeven.exitCode === 7 && exitSeven.stdout.includes('BEFORE_EXIT'),
    brief(exitSeven),
  )

  // —— 50~53. workdir：进入指定目录再执行，失败即停，且 cd 在提权边界之内 ——
  const inTmp = await call('pwd', { workdir: '/tmp' })
  report(
    'workdir=/tmp 时命令在 /tmp 执行',
    inTmp.exitCode === 0 && inTmp.stdout.trim() === '/tmp',
    brief(inTmp),
  )
  const badWorkdir = await call('echo SHOULD_NOT_RUN', { workdir: '/no/such/dir-dsh-20261107' })
  report(
    'workdir 不存在时明确失败且不执行命令（不悄悄落在登录目录）',
    badWorkdir.exitCode !== 0
    && !badWorkdir.stdout.includes('SHOULD_NOT_RUN')
    && badWorkdir.stderr.includes('无法进入工作目录'),
    brief(badWorkdir),
  )
  const argvWorkdir = await runRemote({
    record: rootRecord,
    secret,
    commandArray: ['pwd'],
    workdir: '/var/log',
    askpassPath,
    knownHostsPath,
    ...baseOptions,
  })
  report(
    'workdir 与 command_array 组合生效',
    argvWorkdir.exitCode === 0 && argvWorkdir.stdout.trim() === '/var/log',
    brief(argvWorkdir),
  )
  // root-only 目录：dshtest 身份直接 cd 会失败，只有「先提权再 cd」才能成功。
  await call(`chmod 700 ${ROOT_ONLY_DIR}`)
  const dsSudoWorkdir = await runFor(testUserRecord, 'pwd; id -un', {
    workdir: ROOT_ONLY_DIR,
    sudoMode: 'script',
    sudoPassword: TEST_USER_PASS,
  })
  report(
    'workdir 在 sudo 边界内生效（先提权再 cd，root-only 目录也能进）',
    dsSudoWorkdir.exitCode === 0
    && dsSudoWorkdir.stdout.includes(ROOT_ONLY_DIR)
    && /^root$/m.test(dsSudoWorkdir.stdout),
    brief(dsSudoWorkdir),
  )

  // —— 54~57. 目录传输：默认合并「目录内容」，flatten:false 保留 scp 嵌套 ——
  const srcDir = path.join(localDir, 'proj')
  await mkdir(path.join(srcDir, 'sub'), { recursive: true })
  await writeFile(path.join(srcDir, 'a.txt'), 'A-LOCAL\n', 'utf8')
  await writeFile(path.join(srcDir, 'sub', 'b.txt'), 'B-LOCAL\n', 'utf8')

  await call(`rm -rf ${REMOTE_DIR_MERGE}; mkdir -p ${REMOTE_DIR_MERGE}; echo KEEP > ${REMOTE_DIR_MERGE}/keep.txt`)
  const mergeUp = await transfer({ direction: 'upload', local: srcDir, remote: REMOTE_DIR_MERGE, recursive: true })
  const mergeList = await call(`find ${REMOTE_DIR_MERGE} -mindepth 1 -printf '%P\\n' | sort`)
  report(
    '目录上传默认把内容合并进已存在的目标（不再多一层 proj/）',
    mergeUp.exitCode === 0
    && mergeList.stdout.includes('a.txt')
    && mergeList.stdout.includes('sub/b.txt')
    && !mergeList.stdout.includes('proj/')
    && mergeList.stdout.includes('keep.txt'),
    `listing=${JSON.stringify(mergeList.stdout)} ${brief(mergeUp)}`,
  )

  await call(`rm -rf ${REMOTE_DIR_NEST}; mkdir -p ${REMOTE_DIR_NEST}`)
  const nestUp = await transfer({ direction: 'upload', local: srcDir, remote: REMOTE_DIR_NEST, recursive: true, flatten: false })
  const nestList = await call(`find ${REMOTE_DIR_NEST} -mindepth 1 -printf '%P\\n' | sort`)
  report(
    'flatten:false 保留 scp 的嵌套语义（目标下出现 proj/）',
    nestUp.exitCode === 0 && nestList.stdout.includes('proj/a.txt') && nestList.stdout.includes('proj/sub/b.txt'),
    `listing=${JSON.stringify(nestList.stdout)} ${brief(nestUp)}`,
  )

  const dlMerge = path.join(localDir, 'dl-merge')
  await mkdir(dlMerge, { recursive: true })
  await writeFile(path.join(dlMerge, 'local-only.txt'), 'LOCAL\n', 'utf8')
  const mergeDown = await transfer({ direction: 'download', local: dlMerge, remote: REMOTE_DIR_MERGE, recursive: true })
  const mergedA = await readFile(path.join(dlMerge, 'a.txt'), 'utf8').catch(() => '')
  const mergedB = await readFile(path.join(dlMerge, 'sub', 'b.txt'), 'utf8').catch(() => '')
  const mergedKeep = await readFile(path.join(dlMerge, 'local-only.txt'), 'utf8').catch(() => '')
  const dlMergeFiles = await readdir(dlMerge).catch(() => [])
  report(
    '目录下载默认把内容合并进已存在的本地目录（不再多一层 proj/，本地文件保留）',
    mergeDown.exitCode === 0
    && mergedA === 'A-LOCAL\n'
    && mergedB === 'B-LOCAL\n'
    && mergedKeep === 'LOCAL\n'
    && dlMergeFiles.includes('a.txt')
    && !dlMergeFiles.includes('proj'),
    `a=${JSON.stringify(mergedA)} b=${JSON.stringify(mergedB)} local=${JSON.stringify(mergedKeep)} `
    + `files=${JSON.stringify(dlMergeFiles)} ${brief(mergeDown)}`,
  )

  const dlNewDir = path.join(localDir, 'dl-new')
  const newDown = await transfer({ direction: 'download', local: dlNewDir, remote: REMOTE_DIR_MERGE, recursive: true })
  const dlNewFiles = await readdir(dlNewDir).catch(() => [])
  report(
    '目录下载到不存在的本地路径时直接建成该目录并放入内容',
    newDown.exitCode === 0 && dlNewFiles.includes('a.txt') && dlNewFiles.includes('sub'),
    `files=${JSON.stringify(dlNewFiles)} ${brief(newDown)}`,
  )

  // ============================================================
  // 五、环境观察（不计入 PASS/FAIL）
  // ============================================================

  // 绕过壳包装，把命令直接交给远端登录 shell：确认登录 shell 是 zsh，
  // 从而证明上面的 bash 包装确实是「显式指定解析器」，不是巧合。
  try {
    const probeArgs = buildSshArgs({ record: rootRecord, knownHostsPath, connectTimeoutSec: 15 })
    const separator = probeArgs.indexOf('--')
    const rawArgs = [
      ...probeArgs.slice(0, separator + 2),
      'echo "##login0##$0"; echo "##login_shell##$(getent passwd root | cut -d: -f7)"',
    ]
    const raw = await runProcess('ssh', rawArgs, {
      env: {
        ...process.env,
        SSH_ASKPASS: askpassPath,
        SSH_ASKPASS_REQUIRE: 'force',
        DSH_SSH_ASKPASS_SECRET: secret,
      },
      timeoutMs: 30000,
      maxOutputBytes: 10000,
    })
    const login0 = /##login0##([^\n]*)/.exec(raw.stdout)?.[1]?.trim() ?? ''
    const loginShell = /##login_shell##([^\n]*)/.exec(raw.stdout)?.[1]?.trim() ?? ''
    console.log(
      `OBSERVE  绕过壳包装时登录 shell：$0=${JSON.stringify(login0)} `
      + `passwd登录shell=${JSON.stringify(loginShell)} exit=${raw.exitCode}`,
    )
  } catch (error) {
    console.log(`OBSERVE  登录 shell 观察失败：${error instanceof Error ? error.message : String(error)}`)
  }
} catch (error) {
  // 意外异常（例如本机 ssh 不可执行）也要记为失败，并保留现场。
  report('脚本执行中出现未捕获异常', false, error instanceof Error ? (error.stack ?? error.message) : String(error))
} finally {
  await cleanupRemote()
  await rm(localDir, { recursive: true, force: true }).catch(() => {})
}

console.log(`\n${passed} 项通过，${failed} 项失败`)
process.exit(failed > 0 ? 1 : 0)
