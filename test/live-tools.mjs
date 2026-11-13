/**
 * 真实环境端到端回归：模型工具层（`ssh_run` / `ssh_transfer` 的 execute）。
 *
 * `test/live-centos.mjs` 直接调 `lib/ssh.js`，覆盖不到 `index.js` 里的胶水：
 * 参数透传、结果渲染（`[exit code: -1]`、截断标记、完整日志路径）、执行前提示与
 * 目录传输的默认语义。这里用假 Host 上下文跑一遍真实的工具定义，其余全部走真实 SSH。
 *
 * 凭据全部来自加密保险库（DPAPI）：
 *   $env:DSH_SSH_TEST_ALIAS='centos'    # 默认 centos，可指向另一台 CentOS 靶机
 *   node test/live-tools.mjs
 *
 * 约定：
 * - 假上下文只提供 settings，不提供 commands——避免 `/hosts` 的后台体检抢占连接。
 * - 所有 SSH 调用严格串行；结束时清理远端 /tmp/dsh-tools-* 与本地临时目录。
 */

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'
import { defaultVaultDir } from '../lib/vault.js'

/** 目标主机的保险库别名。 */
const ALIAS = process.env.DSH_SSH_TEST_ALIAS ?? 'centos'
/** 本次创建的远端临时目录前缀。 */
const REMOTE_PREFIX = `/tmp/dsh-tools-${Date.now().toString(36)}`

let passed = 0
const failures = []

/**
 * 记录一条断言。
 * @param name - 用例名。
 * @param ok - 是否通过。
 * @param detail - 失败时的定位信息。
 */
function check(name, ok, detail) {
  if (ok) {
    passed += 1
    console.log(`PASS  ${name}`)
    return
  }
  failures.push(`${name}${detail === undefined ? '' : ` — ${detail}`}`)
  console.log(`FAIL  ${name}${detail === undefined ? '' : `\n      ${detail}`}`)
}

/**
 * 造一个够用的假 Host 上下文：注册工具，只提供 settings。
 * 不提供 commands，是为了不启动 `/hosts` 的后台体检（它会并发连接真实主机）。
 */
function harness() {
  const state = { tools: [], cleanups: [] }
  const services = {
    settings: {
      describe: () => [{ ns: 'locale', value: { preference: 'zh' } }],
    },
  }
  const makeCtx = (extra = {}) => ({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    effect(factory, label) {
      const dispose = factory()
      if (typeof dispose === 'function') state.cleanups.push(dispose)
      return () => {}
    },
    inject(names, callback) {
      const picked = {}
      for (const name of names) {
        if (services[name] === undefined) return
        picked[name] = services[name]
      }
      callback(makeCtx({ ...picked, on: () => () => {}, get: () => undefined }))
    },
    on() { return () => {} },
    get() { return undefined },
    tools: {
      register: (definition) => {
        state.tools.push(definition)
        return () => {}
      },
    },
    ...extra,
  })
  return {
    state,
    ctx: makeCtx(),
    dispose() {
      while (state.cleanups.length > 0) {
        try {
          state.cleanups.pop()()
        } catch {
          // 清理失败不影响结论。
        }
      }
    },
  }
}

const vaultDir = defaultVaultDir()
const host = harness()
// maxOutputBytes 调小，便于在真机上低成本验证截断；其余配置用默认值。
apply(host.ctx, { vaultDir, keyProtection: 'dpapi', maxOutputBytes: 4000, connectTimeoutSec: 15, defaultTimeoutMs: 60000 })

/** 取注册的工具定义。 */
const tool = (name) => host.state.tools.find((item) => item.name === name)
/** 以真实参数执行一次工具。 */
const runTool = (name, args) => tool(name).execute(args, { signal: undefined })
/** 远端临时路径。 */
const remote = (suffix) => `${REMOTE_PREFIX}-${suffix}`

const localDir = await mkdtemp(path.join(os.tmpdir(), 'dsh-live-tools-'))

try {
  // —— 0. 参数 schema 已暴露新参数 ——
  check('ssh_run 暴露 workdir 参数', typeof tool('ssh_run')?.parameters?.properties?.workdir?.description === 'string')
  check('ssh_transfer 暴露 flatten 参数', tool('ssh_transfer')?.parameters?.properties?.flatten?.type === 'boolean')

  // —— 1. workdir 生效，失败时明确报错 ——
  const inTmp = await runTool('ssh_run', { host: ALIAS, command: 'pwd', workdir: '/tmp' })
  check('ssh_run workdir=/tmp 时命令在 /tmp 执行', inTmp.trim() === '/tmp', JSON.stringify(inTmp.slice(0, 120)))

  const badWorkdir = await runTool('ssh_run', { host: ALIAS, command: 'echo SHOULD_NOT_RUN', workdir: '/no/such/dir' })
  check(
    'workdir 不存在时工具层给出明确失败（未执行命令）',
    badWorkdir.includes('无法进入工作目录')
    && badWorkdir.includes('[exit code: 1]')
    && !badWorkdir.includes('\nSHOULD_NOT_RUN'),
    JSON.stringify(badWorkdir.slice(0, 200)),
  )

  // —— 2. 命令文本不进 argv：pkill -f 不再误杀；真正的会话终止仍渲染为 -1 ——
  const selfKillMark = 'DSH_TOOLKILL_DEMO_20261113'
  const selfKill = await runTool('ssh_run', { host: ALIAS, command: `pkill -f ${selfKillMark}; echo AFTER` })
  check(
    '命令文本不进 argv：pkill -f 正常返回、没有退出码 -1',
    selfKill.includes('AFTER') && !selfKill.includes('[exit code: -1]'),
    JSON.stringify(selfKill.slice(0, 200)),
  )
  check('不再出现 pkill -f 自伤警告', !selfKill.includes('命令里用了 `pkill -f`'), JSON.stringify(selfKill.slice(0, 120)))

  // 真正的会话终止：沿进程树杀掉最近的 sshd 祖先，渲染层仍应给出 -1、连接层与原因。
  const sessionKill = await runTool('ssh_run', {
    host: ALIAS,
    command: 'P=$$; while [ "$P" -gt 1 ]; do '
      + 'C=$(tr "\\0" " " < /proc/$P/cmdline 2>/dev/null); '
      + 'case "$C" in sshd*) kill -9 "$P"; exit 0;; esac; '
      + 'P=$(awk \'{print $4}\' /proc/$P/stat 2>/dev/null); done; exit 1',
  })
  check(
    '真正终止 SSH 会话时渲染为 [exit code: -1]',
    sessionKill.includes('[exit code: -1]') && !sessionKill.includes('[exit code: 4294967295]'),
    JSON.stringify(sessionKill.slice(-200)),
  )
  check('会话终止归因到连接层并说明原因', sessionKill.includes('连接层') && sessionKill.includes('SSH 会话'))
  check('不再把 pkill -f 当作会话终止的原因', !sessionKill.includes('pkill -f <模式>'))

  // —— 2b. 超时：结果第一行必须明确标记输出不完整 ——
  const partial = await runTool('ssh_run', {
    host: ALIAS,
    command: 'echo BEFORE_TIMEOUT; sleep 30; echo AFTER_TIMEOUT',
    // 每次调用都新建连接：3s 在这台虚拟机上偶尔还没完成握手（前一次计时过紧），
    // 这里留足连接+首条输出的时间，让断言只验证「部分输出 + 不完整标记」。
    timeoutMs: 8000,
  })
  check(
    '超时结果首行标出「输出不完整」',
    partial.startsWith('⚠ 输出不完整') && partial.includes('BEFORE_TIMEOUT'),
    JSON.stringify(partial.slice(0, 160)),
  )
  check(
    '超时分类为执行超时，且不包含未执行到的输出',
    partial.includes('执行超时') && !partial.includes('AFTER_TIMEOUT'),
    JSON.stringify(partial.slice(-200)),
  )

  const noMatch = await runTool('ssh_run', { host: ALIAS, command: 'pkill -x no-such-proc-20261113; echo RC=$?' })
  check('对照：pkill -x 正常返回', noMatch.includes('RC=1'), JSON.stringify(noMatch.slice(0, 120)))

  // —— 3. 截断：工具层保留头尾、给出省略数与落盘路径 ——
  const big = await runTool('ssh_run', { host: ALIAS, command: 'seq 1 2000' })
  check(
    '工具层大输出保留开头与结尾，并标出省略字符数',
    big.startsWith('1\n2\n') && big.includes('\n1999\n2000') && big.includes('characters omitted'),
    JSON.stringify(big.slice(0, 120)),
  )
  check(
    '工具层大输出给出完整日志路径（outputs 目录）',
    big.includes('完整内容已落盘到') && big.includes('outputs'),
    JSON.stringify(big.slice(-300)),
  )

  // —— 4. 目录传输：工具层默认合并内容（flatten），显式 false 回到 scp 嵌套 ——
  const srcDir = path.join(localDir, 'proj')
  await mkdir(path.join(srcDir, 'sub'), { recursive: true })
  await writeFile(path.join(srcDir, 'a.txt'), 'A-LOCAL\n', 'utf8')
  await writeFile(path.join(srcDir, 'sub', 'b.txt'), 'B-LOCAL\n', 'utf8')

  const mergeRemote = remote('merge')
  const nestRemote = remote('nest')
  await runTool('ssh_run', { host: ALIAS, command: `rm -rf ${mergeRemote} ${nestRemote}; mkdir -p ${mergeRemote} ${nestRemote}; echo KEEP > ${mergeRemote}/keep.txt` })

  const mergeUp = await runTool('ssh_transfer', { host: ALIAS, direction: 'upload', local: srcDir, remote: mergeRemote, recursive: true })
  const mergeList = await runTool('ssh_run', { host: ALIAS, command: `find ${mergeRemote} -mindepth 1 -printf '%P\\n' | sort` })
  check(
    'ssh_transfer 目录上传默认把内容合并进已存在目标（不多一层 proj/）',
    mergeUp.includes('Uploaded to')
    && mergeList.includes('a.txt')
    && mergeList.includes('sub/b.txt')
    && mergeList.includes('keep.txt')
    && !mergeList.includes('proj/'),
    JSON.stringify(mergeList),
  )

  const nestUp = await runTool('ssh_transfer', { host: ALIAS, direction: 'upload', local: srcDir, remote: nestRemote, recursive: true, flatten: false })
  const nestList = await runTool('ssh_run', { host: ALIAS, command: `find ${nestRemote} -mindepth 1 -printf '%P\\n' | sort` })
  check(
    'ssh_transfer flatten:false 保留 scp 嵌套（目标下出现 proj/）',
    nestUp.includes('Uploaded to') && nestList.includes('proj/a.txt'),
    JSON.stringify(nestList),
  )

  const dlMerge = path.join(localDir, 'dl-merge')
  await mkdir(dlMerge, { recursive: true })
  await writeFile(path.join(dlMerge, 'local-only.txt'), 'LOCAL\n', 'utf8')
  const mergeDown = await runTool('ssh_transfer', { host: ALIAS, direction: 'download', local: dlMerge, remote: mergeRemote, recursive: true })
  const dlFiles = await readdir(dlMerge)
  const dlA = await readFile(path.join(dlMerge, 'a.txt'), 'utf8').catch(() => '')
  const dlKeep = await readFile(path.join(dlMerge, 'local-only.txt'), 'utf8').catch(() => '')
  check(
    'ssh_transfer 目录下载默认把内容合并进已存在本地目录（本地文件保留）',
    mergeDown.includes('Downloaded from')
    && dlA === 'A-LOCAL\n'
    && dlKeep === 'LOCAL\n'
    && !dlFiles.includes('proj'),
    `files=${JSON.stringify(dlFiles)} a=${JSON.stringify(dlA)}`,
  )

  // —— 5. flatten 缺少 recursive 时必须报错，而不是静默无视 ——
  let flattenError
  try {
    await runTool('ssh_transfer', { host: ALIAS, direction: 'upload', local: srcDir, remote: mergeRemote, flatten: true })
  } catch (error) {
    flattenError = error
  }
  check(
    'flatten 缺少 recursive 时明确报错',
    flattenError instanceof Error && flattenError.message.includes('flatten 只对目录传输有意义'),
    flattenError === undefined ? '没有抛错' : flattenError.message,
  )
} catch (error) {
  check('脚本执行中出现未捕获异常', false, error instanceof Error ? (error.stack ?? error.message) : String(error))
} finally {
  try {
    await runTool('ssh_run', { host: ALIAS, command: `rm -rf ${REMOTE_PREFIX}-*` })
  } catch {
    // 清理失败不影响结论。
  }
  await rm(localDir, { recursive: true, force: true }).catch(() => undefined)
  host.dispose()
}

console.log(`\n${passed} 项通过，${failures.length} 项失败`)
for (const failure of failures) console.error(`FAIL: ${failure}`)
process.exit(failures.length > 0 ? 1 : 0)
