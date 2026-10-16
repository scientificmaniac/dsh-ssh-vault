/**
 * 单元回归：后台任务注册的契约形状（kind / owner / label / hooks / 输出通道 / 取消）。
 *
 * 用假注册表与假执行器驱动，不需要真实主机，也不需要在 Harness 内运行。
 * 运行：node test/background.mjs
 */
import { registerSshJob } from '../lib/background.js'

let passed = 0
const failures = []
function check(name, condition, detail) {
  if (condition) {
    passed += 1
    return
  }
  failures.push(`${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

/** 记录 spec、hooks 与 append 调用的假注册表。 */
function makeRegistry() {
  const started = []
  return {
    started,
    start(spec) {
      const appended = []
      const job = { append: (text, options) => appended.push([options?.channel ?? 'stdout', text]) }
      const hooks = spec.run(job)
      const record = { id: `ssh-${started.length + 1}`, spec, appended, hooks }
      started.push(record)
      return record.id
    },
  }
}

const record = { alias: 'demo', host: '192.0.2.10', port: 22, username: 'root', auth: { type: 'password' } }
const baseSpec = { record, command: '  echo   hello  ', timeoutMs: 12345 }

// —— 成功路径 ——
let capturedOptions
const okRunner = async (options) => {
  capturedOptions = options
  options.onData?.('hello\n', 'stdout')
  options.onData?.('warning\n', 'stderr')
  return { exitCode: 0, stdout: 'hello\n', stderr: 'warning\n', notes: [], timedOut: false, aborted: false }
}
const registry = makeRegistry()
const jobId = registerSshJob(registry, baseSpec, { owner: 'sess-1', runner: okRunner })
const started = registry.started[0]
check('返回注册表签发的 id', jobId === 'ssh-1', String(jobId))
check('kind 为 ssh', started.spec.kind === 'ssh', started.spec.kind)
check('owner 透传', started.spec.owner === 'sess-1', String(started.spec.owner))
check('label 含别名', started.spec.label.startsWith('demo:'), started.spec.label)
check('label 折叠空白', started.spec.label.includes('echo hello'), started.spec.label)
check('后台不限时', capturedOptions.timeoutMs === 0, String(capturedOptions.timeoutMs))
check('注入取消信号', capturedOptions.signal instanceof AbortSignal)
check('输出进 stdout 通道', started.appended.some(([channel, text]) => channel === 'stdout' && text.includes('hello')), JSON.stringify(started.appended))
check('输出进 stderr 通道', started.appended.some(([channel]) => channel === 'stderr'), JSON.stringify(started.appended))

const okOutcome = await started.hooks.done
check('成功结算为 completed', okOutcome.status === 'completed', JSON.stringify(okOutcome))

// —— 非零退出 ——
const failRegistry = makeRegistry()
const failRunner = async () => ({ exitCode: 3, stdout: '', stderr: 'boom', notes: ['网络不可达：…'], timedOut: false, aborted: false })
registerSshJob(failRegistry, baseSpec, { runner: failRunner })
const failOutcome = await failRegistry.started[0].hooks.done
check('非零退出结算为 failed', failOutcome.status === 'failed', JSON.stringify(failOutcome))
check('detail 带退出码', String(failOutcome.detail).includes('3'), String(failOutcome.detail))
check('诊断进 result', String(failOutcome.result).includes('网络不可达'), String(failOutcome.result))

// —— 执行器抛错 ——
const throwRegistry = makeRegistry()
const throwRunner = async () => { throw new Error('spawn EPERM') }
registerSshJob(throwRegistry, baseSpec, { runner: throwRunner })
const throwOutcome = await throwRegistry.started[0].hooks.done
check('执行器抛错结算为 failed', throwOutcome.status === 'failed', JSON.stringify(throwOutcome))
check('错误文本进 detail', String(throwOutcome.detail).includes('EPERM'), String(throwOutcome.detail))

// —— 取消 ——
let capturedSignal
const cancelRegistry = makeRegistry()
const cancelRunner = ({ signal, onSpawn }) => new Promise((resolve) => {
  capturedSignal = signal
  onSpawn?.({ kill: () => {} })
  signal.addEventListener('abort', () => resolve({
    exitCode: null, stdout: '', stderr: '', notes: [], timedOut: false, aborted: true,
  }))
})
registerSshJob(cancelRegistry, baseSpec, { runner: cancelRunner })
cancelRegistry.started[0].hooks.cancel('killed by request')
const cancelOutcome = await cancelRegistry.started[0].hooks.done
check('取消会 abort 信号', capturedSignal?.aborted === true)
check('取消结算为 killed', cancelOutcome.status === 'killed', JSON.stringify(cancelOutcome))

console.log(`${passed} 项通过，${failures.length} 项失败`)
for (const failure of failures) console.error(`FAIL: ${failure}`)
if (failures.length > 0) process.exit(1)
console.log('全部通过')
