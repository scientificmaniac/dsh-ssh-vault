/**
 * 单元回归：本地端口转发引擎。
 *
 * 覆盖三个层次：
 *   1. 纯函数——转发规则解析、ssh 参数构造、sshd 策略解析与修复建议（任何环境都能跑）；
 *   2. 真实网络栈——用 net 起一个 server 占住端口，验证启动前的占用预检；
 *   3. 假子进程——用 EventEmitter 模拟 ssh，验证 stderr 拒绝、意外退出后的指数退避重连、
 *      以及 onEvent 抛错不影响状态机。
 *
 * 不需要真实 SSH 服务器，也不联网；「隧道是否真的通」只能由 live 测试回答。
 *
 * 运行：node test/tunnel-unit.mjs
 */
import { EventEmitter } from 'node:events'
import net from 'node:net'
import { PassThrough } from 'node:stream'
import {
  TunnelManager,
  buildSshdProbeCommand,
  buildTunnelArgs,
  diagnoseForwarding,
  parseForward,
  parseSshdForwarding,
  probeLocalPort,
} from '../lib/tunnel.js'

let passed = 0
const failures = []

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

/** 取出所有 `-L` 的取值。 */
function forwardOptions(args) {
  const values = []
  for (let i = 0; i < args.length - 1; i += 1) {
    if (args[i] === '-L') values.push(args[i + 1])
  }
  return values
}

/** 断言某个调用会抛错，并把错误返回出来（不抛时返回 undefined）。 */
function expectThrow(fn) {
  try {
    fn()
    return undefined
  } catch (error) {
    return error
  }
}

/** 等待若干毫秒。 */
function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/** 轮询等待条件成立（比固定 sleep 稳）。 */
async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await wait(10)
  }
  return predicate()
}

/** 拿一个此刻空闲的本地端口。 */
async function freePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen({ port: 0, host: '127.0.0.1', exclusive: true }, resolve)
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  await new Promise((resolve) => {
    server.close(resolve)
  })
  return port
}

/** 假子进程：只实现隧道引擎用到的那部分 child_process 接口。 */
class FakeChild extends EventEmitter {
  constructor(pid) {
    super()
    this.pid = pid
    this.exitCode = null
    this.signalCode = null
    this.killed = false
    this.stdout = new PassThrough()
    this.stderr = new PassThrough()
    this.stdin = new PassThrough()
  }

  /** 人为结束，模拟 ssh 自己退出。 */
  finish(code, signal = null) {
    if (this.exitCode !== null || this.signalCode !== null) return
    this.exitCode = code
    this.signalCode = signal
    this.emit('exit', code, signal)
  }

  /** 模拟被 kill：SIGKILL 也走同一条退出路径。 */
  kill(signal = 'SIGTERM') {
    if (this.exitCode !== null || this.signalCode !== null) return false
    this.killed = true
    this.finish(0, signal === 'SIGKILL' ? 'SIGKILL' : null)
    return true
  }
}

const record = {
  alias: 'demo',
  host: '192.0.2.10',
  port: 2222,
  username: 'root',
  auth: { type: 'password', password: 'secret' },
  shell: 'bash',
}
const knownHostsPath = 'C:\\vault\\known_hosts'

// —— 转发规则解析 ——
{
  const three = parseForward('18787:127.0.0.1:8787')
  check('parseForward 3 段：本地端口', three.localPort === 18787, JSON.stringify(three))
  check('parseForward 3 段：默认本地地址 127.0.0.1', three.localHost === '127.0.0.1', JSON.stringify(three))
  check('parseForward 3 段：远端目标', three.remoteHost === '127.0.0.1' && three.remotePort === 8787, JSON.stringify(three))

  const four = parseForward('0.0.0.0:18787:127.0.0.1:8787')
  check('parseForward 4 段：自定义本地地址', four.localHost === '0.0.0.0' && four.localPort === 18787, JSON.stringify(four))
  check('parseForward 4 段：远端目标不变', four.remoteHost === '127.0.0.1' && four.remotePort === 8787, JSON.stringify(four))

  check('parseForward 去掉首尾空白', parseForward(' 18787:127.0.0.1:8787 ').localPort === 18787)
  const hostName = parseForward('8080:db.internal:5432')
  check('parseForward 支持主机名', hostName.remoteHost === 'db.internal' && hostName.remotePort === 5432, JSON.stringify(hostName))

  const twoSegments = expectThrow(() => parseForward('18787:8787'))
  check('parseForward 2 段抛错', twoSegments instanceof Error, String(twoSegments))
  check('parseForward 2 段错误信息含格式说明', /格式不正确/.test(twoSegments?.message ?? ''), twoSegments?.message)
  const fiveSegments = expectThrow(() => parseForward('1:2:3:4:5'))
  check('parseForward 5 段抛错', fiveSegments instanceof Error, String(fiveSegments))
  const emptySpec = expectThrow(() => parseForward(''))
  check('parseForward 空串抛错', emptySpec instanceof Error, String(emptySpec))
  check('parseForward 空串错误信息是中文说明', /转发规则/.test(emptySpec?.message ?? ''), emptySpec?.message)
  const nonString = expectThrow(() => parseForward(undefined))
  check('parseForward 非字符串抛错', nonString instanceof Error, String(nonString))

  const nonNumeric = expectThrow(() => parseForward('abc:127.0.0.1:8787'))
  check('parseForward 非数字端口抛错', nonNumeric instanceof Error && /整数/.test(nonNumeric.message), nonNumeric?.message)
  const zeroPort = expectThrow(() => parseForward('0:127.0.0.1:8787'))
  check('parseForward 本地端口 0 越界', zeroPort instanceof Error && /1 到 65535/.test(zeroPort.message), zeroPort?.message)
  const bigPort = expectThrow(() => parseForward('70000:127.0.0.1:8787'))
  check('parseForward 本地端口 >65535 越界', bigPort instanceof Error, bigPort?.message)
  const bigRemotePort = expectThrow(() => parseForward('18787:127.0.0.1:70000'))
  check('parseForward 远端端口越界', bigRemotePort instanceof Error && /远端端口/.test(bigRemotePort.message), bigRemotePort?.message)
  const emptyHost = expectThrow(() => parseForward('18787::8787'))
  check('parseForward 远端主机为空抛错', emptyHost instanceof Error, emptyHost?.message)
  const ipv6 = expectThrow(() => parseForward('[::1]:18787:127.0.0.1:8787'))
  check('parseForward IPv6 字面量给出明确报错', ipv6 instanceof Error && /IPv6/.test(ipv6.message), ipv6?.message)
}

// —— ssh 参数构造 ——
{
  const args = buildTunnelArgs({
    record,
    forwards: ['18787:127.0.0.1:8787', '0.0.0.0:9999:192.0.2.5:3306'],
    knownHostsPath,
    connectTimeoutSec: 10,
  })
  check('隧道参数含 -N（不执行远端命令）', args.includes('-N'), args.join(' '))
  check('隧道参数含 -T', args.includes('-T'), args.join(' '))
  check('每个转发规则一个 -L', forwardOptions(args).length === 2, args.join(' '))
  check('3 段规则补全本地地址', forwardOptions(args)[0] === '127.0.0.1:18787:127.0.0.1:8787', forwardOptions(args).join(' '))
  check('4 段规则原样保留本地地址', forwardOptions(args)[1] === '0.0.0.0:9999:192.0.2.5:3306', forwardOptions(args).join(' '))
  check('转发规则里的端口与目标正确', forwardOptions(args)[0].includes(':8787') && forwardOptions(args)[1].includes('192.0.2.5:3306'), forwardOptions(args).join(' '))
  check('转发失败即退出（ExitOnForwardFailure=yes）', optionEntry(args, 'ExitOnForwardFailure') === 'yes', args.join(' '))
  check('隧道保活 ServerAliveInterval', optionEntry(args, 'ServerAliveInterval') === '30', args.join(' '))
  check('隧道连接超时', optionEntry(args, 'ConnectTimeout') === '10', args.join(' '))
  check('隧道端口用 -p', optionValue(args, '-p') === '2222', args.join(' '))
  check('隧道目标在参数末尾', args[args.length - 1] === 'root@192.0.2.10', args.slice(-2).join(' '))
  check('-L 在目标主机之前', args.indexOf('-L') < args.lastIndexOf('root@192.0.2.10'), args.join(' '))
  check('known_hosts 指向保险库私有文件', optionEntry(args, 'UserKnownHostsFile') === knownHostsPath, args.join(' '))
  check('口令认证选项', optionEntry(args, 'PreferredAuthentications') === 'password,keyboard-interactive', args.join(' '))
  check('参数里不含口令', !args.join(' ').includes('secret'), args.join(' '))

  const bound = buildTunnelArgs({
    record,
    forwards: ['18787:127.0.0.1:8787'],
    knownHostsPath,
    connectTimeoutSec: 10,
    bindAddress: '192.0.2.150',
    sshConfigFile: 'C:\\vault\\ssh_config',
  })
  check('隧道绑定源地址', optionValue(bound, '-b') === '192.0.2.150', bound.join(' '))
  check('隧道自定义配置文件', optionValue(bound, '-F') === 'C:\\vault\\ssh_config', bound.join(' '))

  const keyArgs = buildTunnelArgs({
    record: { ...record, auth: { type: 'key', privateKeyPath: 'C:\\keys\\id_rsa' } },
    forwards: ['18787:127.0.0.1:8787'],
    knownHostsPath,
    connectTimeoutSec: 10,
  })
  check('隧道密钥认证带 -i', optionValue(keyArgs, '-i') === 'C:\\keys\\id_rsa', keyArgs.join(' '))
  check('隧道只用指定密钥', optionEntry(keyArgs, 'IdentitiesOnly') === 'yes', keyArgs.join(' '))

  const noForward = expectThrow(() => buildTunnelArgs({ record, forwards: [], knownHostsPath, connectTimeoutSec: 10 }))
  check('隧道至少需要一条转发规则', noForward instanceof Error && /至少/.test(noForward.message), noForward?.message)
}

// —— sshd 转发策略解析 ——
{
  const sshdT = parseSshdForwarding('allowtcpforwarding yes\npermitopen any\ngatewayports no\n')
  check('sshd -T：AllowTcpForwarding yes', sshdT.allowTcpForwarding === 'yes', JSON.stringify(sshdT))
  check('sshd -T：permitopen any 不限制', sshdT.permitOpen.join(',') === 'any', JSON.stringify(sshdT))
  check('sshd -T：来源判定', sshdT.source === 'sshd-T', JSON.stringify(sshdT))

  check('no 值被识别', parseSshdForwarding('allowtcpforwarding no').allowTcpForwarding === 'no')
  check('local 值被识别', parseSshdForwarding('allowtcpforwarding local').allowTcpForwarding === 'local')
  check('remote 值被识别', parseSshdForwarding('allowtcpforwarding remote').allowTcpForwarding === 'remote')
  check('all 值被识别', parseSshdForwarding('allowtcpforwarding all').allowTcpForwarding === 'all')

  const config = parseSshdForwarding('AllowTcpForwarding no\nPermitOpen 192.0.2.1:22\n')
  check('配置文件的大写指令被识别（回退路径）', config.allowTcpForwarding === 'no', JSON.stringify(config))
  check('配置文件来源判定为 config', config.source === 'config', JSON.stringify(config))
  check('配置文件 PermitOpen 被识别', config.permitOpen.join(',') === '192.0.2.1:22', JSON.stringify(config))

  const multi = parseSshdForwarding('permitopen 192.0.2.1:22 192.0.2.2:80\npermitopen db.internal:5432\n')
  check('permitopen 一行多个值', multi.permitOpen.length === 3, JSON.stringify(multi))
  check('permitopen 多行合并去重', multi.permitOpen.includes('db.internal:5432') && multi.permitOpen.includes('192.0.2.2:80'), JSON.stringify(multi))

  const spaced = parseSshdForwarding('   ALLOWTCPFORWARDING   NO  \n')
  check('大小写与前导空白不敏感', spaced.allowTcpForwarding === 'no', JSON.stringify(spaced))

  // CentOS 7 的 sshd_config 默认把 AllowTcpForwarding 注释掉——不能因此编造 yes。
  const commented = parseSshdForwarding('#AllowTcpForwarding yes\n#PermitOpen any\n')
  check('注释掉的指令按 unknown 处理', commented.allowTcpForwarding === 'unknown', JSON.stringify(commented))
  check('只有注释时来源是 unknown', commented.source === 'unknown', JSON.stringify(commented))

  const marked = parseSshdForwarding('##source##config\n##allowtcpforwarding##no\n##permitopen##db.internal:5432\n##gatewayports##\n##note##回退读取配置文件')
  check('探针标记行可解析', marked.allowTcpForwarding === 'no', JSON.stringify(marked))
  check('探针标记来源是 config', marked.source === 'config', JSON.stringify(marked))
  check('探针标记 permitopen 可解析', marked.permitOpen.join(',') === 'db.internal:5432', JSON.stringify(marked))

  const markedT = parseSshdForwarding('##source##sshd-T\n##allowtcpforwarding##local\n##permitopen##any')
  check('探针标记来源是 sshd-T', markedT.source === 'sshd-T', JSON.stringify(markedT))
  check('探针标记里 local 被识别', markedT.allowTcpForwarding === 'local', JSON.stringify(markedT))

  check('空文本按 unknown 处理', parseSshdForwarding('').allowTcpForwarding === 'unknown')
  check('空文本 permitOpen 是空数组', Array.isArray(parseSshdForwarding('').permitOpen) && parseSshdForwarding('').permitOpen.length === 0)
  check('非字符串输入不抛错', parseSshdForwarding(undefined).allowTcpForwarding === 'unknown')
  check('非法取值按 unknown 处理', parseSshdForwarding('allowtcpforwarding maybe').allowTcpForwarding === 'unknown')
}

// —— 修复建议 ——
{
  const blocked = diagnoseForwarding({ allowTcpForwarding: 'no', source: 'config', user: 'deploy' })
  const blockedText = blocked.join('\n')
  check('禁止本地转发时给出建议', blocked.length > 0, blockedText)
  check('no 的建议提到 Match User', /match user/i.test(blockedText), blockedText)
  check('no 的建议提到 LocalForwarding', /localforwarding/i.test(blockedText), blockedText)
  check('no 的建议提到 PermitOpen', /permitopen/i.test(blockedText), blockedText)
  check('no 的建议点明不要全局改', /不要全局/.test(blockedText), blockedText)
  check('no 的建议带上具体账号', blockedText.includes('deploy'), blockedText)
  check('no 的建议提醒 reload', /reload/i.test(blockedText), blockedText)

  const remoteOnly = diagnoseForwarding({ allowTcpForwarding: 'remote' })
  check('remote 同样视为拒绝本地转发', remoteOnly.length > 0 && /match user/i.test(remoteOnly.join('\n')), remoteOnly.join('\n'))

  check('local 允许本地转发时不返回阻断建议', diagnoseForwarding({ allowTcpForwarding: 'local' }).length === 0)
  check('yes 时不返回阻断建议', diagnoseForwarding({ allowTcpForwarding: 'yes' }).length === 0)
  check('all 时不返回阻断建议', diagnoseForwarding({ allowTcpForwarding: 'all' }).length === 0)

  const unknown = diagnoseForwarding({ allowTcpForwarding: 'unknown' })
  check('unknown 给出核实建议', unknown.length > 0 && /sshd -T/.test(unknown.join('\n')), unknown.join('\n'))
  check('unknown 不编造结论', !/已允许/.test(unknown.join('\n')), unknown.join('\n'))

  const restricted = diagnoseForwarding({ allowTcpForwarding: 'yes', permitOpen: ['db.internal:5432'] })
  check('PermitOpen 限制被单独提示', restricted.length > 0 && /permitopen/i.test(restricted.join('\n')), restricted.join('\n'))
  check('PermitOpen any 不算限制', diagnoseForwarding({ allowTcpForwarding: 'yes', permitOpen: ['any'] }).length === 0)
  check('空配置也能给建议而不抛错', diagnoseForwarding().length > 0)
}

// —— 探针脚本 ——
{
  const probe = buildSshdProbeCommand()
  check('探针优先用 sshd -T', probe.includes('sshd -T'), probe)
  check('探针回退 sudo -n sshd -T', probe.includes('sudo -n sshd -T'), probe)
  check('探针回退读取 sshd_config', probe.includes('/etc/ssh/sshd_config'), probe)
  check('探针输出 allowtcpforwarding 标记', probe.includes('##allowtcpforwarding##'), probe)
  check('探针输出 permitopen 标记', probe.includes('##permitopen##'), probe)
  check('探针输出 gatewayports 标记', probe.includes('##gatewayports##'), probe)
  check('探针标注数据来源', probe.includes('##source##'), probe)
  check('探针脚本不依赖 bash 特性', !/\b(bash|BASH)\b/.test(probe), probe)
}

// —— 本地端口预检（真实网络栈） ——
{
  const occupied = net.createServer()
  await new Promise((resolve, reject) => {
    occupied.once('error', reject)
    occupied.listen({ port: 0, host: '127.0.0.1', exclusive: true }, resolve)
  })
  const busyPort = occupied.address().port
  const busy = await probeLocalPort('127.0.0.1', busyPort, 1000)
  check('被占用端口被识别为不可用', busy.available === false, JSON.stringify(busy))
  check('占用被识别为 EADDRINUSE', busy.code === 'EADDRINUSE', JSON.stringify(busy))

  // 启动前的预检必须拦住，并且绝不能走到 spawn ssh。
  let spawnCount = 0
  const guard = new TunnelManager({
    spawnProcess: () => {
      spawnCount += 1
      throw new Error('端口被占用时不应该启动 ssh')
    },
  })
  const occupiedError = await guard
    .start({ record, forwards: [`${busyPort}:127.0.0.1:8787`], knownHostsPath })
    .catch((error) => error)
  check('端口占用时 start 直接失败', occupiedError instanceof Error, String(occupiedError))
  check('端口占用错误是中文并指出占用', /占用/.test(occupiedError?.message ?? ''), occupiedError?.message)
  check('端口占用时不会启动 ssh', spawnCount === 0, String(spawnCount))
  await guard.dispose()
  await new Promise((resolve) => {
    occupied.close(resolve)
  })

  const free = await freePort()
  check('空闲端口预检通过', (await probeLocalPort('127.0.0.1', free, 1000)).available === true)
}

// —— 生命周期：初始空表、未知 id、dispose ——
{
  const manager = new TunnelManager({})
  check('新管理器 list 初始为空', Array.isArray(manager.list()) && manager.list().length === 0)
  const stopResult = await manager.stop({ id: 'nonexistent' })
  check('stop 未知 id 不抛异常', stopResult !== undefined && stopResult.stopped === false, JSON.stringify(stopResult))
  check('stop 未知 id 返回原 id', stopResult.id === 'nonexistent', JSON.stringify(stopResult))
  const disposed = await manager.dispose()
  check('空管理器 dispose 返回 0', disposed === 0, String(disposed))
  check('dispose 后 list 仍为空', manager.list().length === 0)
  const afterDispose = await manager
    .start({ record, forwards: ['18787:127.0.0.1:8787'], knownHostsPath })
    .catch((error) => error)
  check('dispose 后拒绝启动新隧道', afterDispose instanceof Error && /dispose/.test(afterDispose.message), String(afterDispose))
}

// —— 生命周期：正常启动 → 列表 → 停止 ——
{
  const port = await freePort()
  const child = new FakeChild(4100)
  let spawned
  const manager = new TunnelManager({
    establishMs: 30,
    spawnProcess: (exe, args, options) => {
      spawned = { exe, args, options }
      return child
    },
  })
  const info = await manager.start({
    record,
    secret: 'askpass-secret',
    askpassPath: 'C:\\vault\\askpass.cmd',
    knownHostsPath,
    forwards: [`${port}:127.0.0.1:8787`],
    label: 'demo web',
  })
  check('start 返回隧道 id', typeof info.id === 'string' && info.id.length > 0, JSON.stringify(info))
  check('start 返回 pid', info.pid === 4100, JSON.stringify(info))
  check('start 返回格式化后的转发规则', info.forwards[0] === `127.0.0.1:${port}:127.0.0.1:8787`, JSON.stringify(info.forwards))
  check('start 返回本地访问地址', info.localUrls[0] === `tcp://127.0.0.1:${port}`, JSON.stringify(info.localUrls))
  check('spawn 用的是注入的 ssh 可执行文件', spawned?.exe === 'ssh', JSON.stringify(spawned?.exe))
  check('spawn 参数里有 -L', spawned?.args.includes('-L') === true, JSON.stringify(spawned?.args))
  check('askpass 环境变量就位', spawned?.options.env.SSH_ASKPASS === 'C:\\vault\\askpass.cmd'
    && spawned.options.env.SSH_ASKPASS_REQUIRE === 'force'
    && spawned.options.env.DSH_SSH_ASKPASS_SECRET === 'askpass-secret', JSON.stringify(spawned?.options.env?.SSH_ASKPASS))
  check('口令不进命令行', !spawned.args.join(' ').includes('askpass-secret'), spawned.args.join(' '))

  const rows = manager.list()
  check('list 反映运行中状态', rows.length === 1 && rows[0].status === 'running', JSON.stringify(rows))
  check('list 带 label', rows[0].label === 'demo web', JSON.stringify(rows))
  check('list 带转发规则', rows[0].forwards[0] === `127.0.0.1:${port}:127.0.0.1:8787`, JSON.stringify(rows))
  check('list 带 pid', rows[0].pid === 4100, JSON.stringify(rows))

  const stopped = await manager.stop({ id: info.id })
  check('stop 返回已停止', stopped.stopped === true, JSON.stringify(stopped))
  check('stop 后 list 为空', manager.list().length === 0, JSON.stringify(manager.list()))
  check('stop 确实杀掉了子进程', child.exitCode !== null || child.signalCode !== null, JSON.stringify({ code: child.exitCode, signal: child.signalCode }))
  await manager.dispose()
}

// —— stderr 表明转发被拒：立即失败、带出原文、不自动重试 ——
{
  const port = await freePort()
  const child = new FakeChild(4200)
  let spawnCalls = 0
  const manager = new TunnelManager({
    establishMs: 500,
    spawnProcess: () => {
      spawnCalls += 1
      setImmediate(() => {
        child.stderr.write('channel 3: open failed: administratively prohibited: open failed\n')
      })
      return child
    },
  })
  const error = await manager
    .start({ record, secret: 'secret-value', knownHostsPath, forwards: [`${port}:127.0.0.1:8787`] })
    .catch((caught) => caught)
  check('stderr 拒绝时 start 立即失败', error instanceof Error, String(error))
  check('失败信息带出 stderr 原文', /administratively prohibited/.test(error?.message ?? ''), error?.message)
  check('失败对象保留 stderr 字段', /administratively prohibited/.test(error?.stderr ?? ''), error?.stderr)
  check('失败时子进程被终止', child.killed === true || child.exitCode !== null, JSON.stringify({ killed: child.killed, code: child.exitCode }))
  check('失败的隧道不残留在表里', manager.list().length === 0, JSON.stringify(manager.list()))
  check('初始建立失败不会自动重试', spawnCalls === 1, String(spawnCalls))
  await manager.dispose()
}

// —— 意外退出：上报 dropped/reconnecting 并指数退避重连 ——
{
  const port = await freePort()
  const children = []
  const events = []
  const manager = new TunnelManager({
    establishMs: 25,
    reconnectBaseMs: 10,
    maxReconnectAttempts: 2,
    spawnProcess: () => {
      const child = new FakeChild(4300 + children.length)
      children.push(child)
      return child
    },
    onEvent: (event) => events.push(event),
  })
  const info = await manager.start({ record, knownHostsPath, forwards: [`${port}:127.0.0.1:8787`] })
  check('掉线前隧道在运行', manager.list()[0]?.status === 'running', JSON.stringify(manager.list()))
  children[0].finish(255)
  check('掉线后重新拉起子进程', await waitFor(() => children.length === 2), `spawn=${children.length}`)
  check('上报 dropped 事件', events.some((event) => event.type === 'dropped' && event.id === info.id), JSON.stringify(events))
  check('上报 reconnecting 事件', events.some((event) => event.type === 'reconnecting' && event.id === info.id), JSON.stringify(events))
  check('重连后回到 running', await waitFor(() => manager.list()[0]?.status === 'running'), JSON.stringify(manager.list()))
  check('事件对象都带 id 与 detail', events.every((event) => typeof event.id === 'string' && typeof event.detail === 'string'), JSON.stringify(events))
  await manager.dispose()
  check('dispose 后表为空', manager.list().length === 0, JSON.stringify(manager.list()))
  check('dispose 杀掉了全部子进程', children.every((child) => child.exitCode !== null), JSON.stringify(children.map((child) => child.exitCode)))
}

// —— 重连次数用尽后放弃并上报 exited ——
{
  const port = await freePort()
  const children = []
  const events = []
  let spawns = 0
  const manager = new TunnelManager({
    establishMs: 20,
    reconnectBaseMs: 5,
    maxReconnectAttempts: 2,
    spawnProcess: () => {
      spawns += 1
      const child = new FakeChild(4400 + spawns)
      children.push(child)
      // 第一次建立成功；之后的每次重连都在观察窗内就退出。
      if (spawns > 1) setImmediate(() => child.finish(255))
      return child
    },
    onEvent: (event) => events.push(event),
  })
  await manager.start({ record, knownHostsPath, forwards: [`${port}:127.0.0.1:8787`] })
  children[0].finish(255)
  check('重连失败到上限后上报 exited', await waitFor(() => events.some((event) => event.type === 'exited'), 3000), JSON.stringify(events))
  check('重连次数不超过上限', spawns === 3, String(spawns))
  check('放弃后状态为 exited', manager.list()[0]?.status === 'exited', JSON.stringify(manager.list()))
  await manager.dispose()
}

// —— onEvent 抛错不能影响主流程 ——
{
  const port = await freePort()
  const children = []
  let spawns = 0
  const manager = new TunnelManager({
    establishMs: 15,
    reconnectBaseMs: 5,
    maxReconnectAttempts: 1,
    spawnProcess: () => {
      spawns += 1
      const child = new FakeChild(4500 + spawns)
      children.push(child)
      return child
    },
    onEvent: () => {
      throw new Error('onEvent 故意抛错')
    },
  })
  const info = await manager.start({ record, knownHostsPath, forwards: [`${port}:127.0.0.1:8787`] })
  check('onEvent 抛错不影响启动', typeof info.id === 'string', JSON.stringify(info))
  children[0].finish(1)
  // 如果抛错没被吞掉，这里会变成未捕获异常并让进程直接退出。
  check('onEvent 抛错时仍能完成重连', await waitFor(() => manager.list()[0]?.status === 'running' && spawns === 2, 2000), JSON.stringify(manager.list()))
  await manager.dispose()
}

console.log(`${passed} 项通过，${failures.length} 项失败`)
for (const failure of failures) console.error(`FAIL: ${failure}`)
if (failures.length > 0) process.exit(1)
console.log('全部通过')
