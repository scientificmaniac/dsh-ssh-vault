/**
 * 单元回归：可开关的诊断日志。
 *
 * 这个开关的全部价值在于「关着的时候真的什么都不做」和「开着的时候留下能用的证据」，
 * 于是用例同时盯两头：
 * 1. 关闭时不建目录、不写文件、不碰宿主 logger；
 * 2. 开启后落盘、带来源与堆栈、口令被抹掉、超限会轮转、重启后开关与内容都还在。
 *
 * 运行：node test/diagnostics.mjs
 */
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Diagnostics, READ_ENTRIES, redactSecrets } from '../lib/diagnostics.js'

let passed = 0
const failures = []
function check(name, condition, detail) {
  if (condition) {
    passed += 1
    return
  }
  failures.push(`${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

/** 文件是否存在。 */
async function exists(filePath) {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

/** 造一个会记录调用的假宿主 logger。 */
function spyLogger() {
  const calls = []
  const record = (level) => (message) => calls.push({ level, message: String(message) })
  return { calls, error: record('error'), warn: record('warn'), info: record('info'), debug: record('debug') }
}

const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-ssh-vault-diag-'))

try {
  // —— 1. 默认关闭：不建目录、不写文件、不镜像 ——
  {
    const dir = path.join(root, 'off')
    const mirror = spyLogger()
    const log = new Diagnostics({ dir, mirror })
    await log.ready()
    check('默认关闭', log.enabled === false)
    log.error('tool:ssh_run', new Error('boom'), { host: 'demo' })
    log.info('tunnel', 'started')
    await log.recent()
    check('关闭时没有日志目录', await exists(dir) === false)
    check('关闭时不写文件', await exists(log.logPath) === false)
    check('关闭时不碰宿主 logger', mirror.calls.length === 0, String(mirror.calls.length))
    const status = await log.status()
    check('关闭时状态为空', status.enabled === false && status.entries.length === 0, JSON.stringify(status))
  }

  // —— 2. 开启：落盘、镜像、带来源 ——
  {
    const dir = path.join(root, 'on')
    const mirror = spyLogger()
    const log = new Diagnostics({ dir, mirror })
    await log.setEnabled(true)
    check('开启后状态为真', log.enabled === true)
    check('开关状态被持久化', await exists(log.statePath) === true)

    log.error('tool:ssh_run', new Error('connection refused'), { host: 'kali', action: 'run' })
    // 开启动作本身也留了一条，所以这里看的是最后一条。
    const entries = await log.recent()
    const last = entries[entries.length - 1]
    check('记录进入内存缓冲', entries.length === 2, JSON.stringify(entries))
    check('首行带级别与来源', last.includes('ERROR tool:ssh_run'), last)
    check('上下文进日志', last.includes('host=kali') && last.includes('action=run'), last)
    check('错误消息进日志', last.includes('connection refused'), last)

    const file = await readFile(log.logPath, 'utf8')
    check('日志写入文件', file.includes('ERROR tool:ssh_run'), file)
    check('日志带堆栈', file.includes('at '), file.slice(0, 200))
    const errorCalls = mirror.calls.filter((call) => call.level === 'error')
    check('镜像到宿主 logger', errorCalls.length === 1, JSON.stringify(mirror.calls))
    check('镜像内容带插件前缀', errorCalls[0].message.startsWith('[ssh-vault] '), errorCalls[0].message)

    // 开启这个动作本身也留一条，方便确认「从哪一刻开始有日志」。
    check('开关动作留下记录', file.includes('logging enabled'), file)

    const status = await log.status()
    check('状态报告路径与大小', status.enabled === true && status.path === log.logPath && status.bytes > 0, JSON.stringify({ ...status, entries: undefined }))
    check('状态带最近条目', status.entries.length >= 1, String(status.entries.length))
  }

  // —— 3. 口令脱敏 ——
  {
    const dir = path.join(root, 'redact')
    const log = new Diagnostics({ dir })
    await log.setEnabled(true)
    log.error('tool:ssh_run', new Error("command failed: mysql --password=hunter2 and password:topsecret"), { alias: 'db', note: 'token=abc123' })
    log.warn('tool:ssh_run', "sudo -S hunter2 whoami")
    await log.recent()
    const file = await readFile(log.logPath, 'utf8')
    check('password= 被抹掉', !file.includes('hunter2'), file)
    check('password: 被抹掉', !/password:topsecret/.test(file), file)
    check('token= 被抹掉', !file.includes('abc123'), file)
    check('sudo -S 口令被抹掉', !/sudo -S hunter2/.test(file), file)
    check('保留脱敏标记', file.includes('***'), file)
    check('直接调用脱敏函数也可用', redactSecrets('passphrase=keypass left') === 'passphrase=*** left', redactSecrets('passphrase=keypass left'))
  }

  // —— 4. 轮转与条数上限 ——
  {
    const dir = path.join(root, 'rotate')
    const log = new Diagnostics({ dir, maxBytes: 200, maxEntries: 5 })
    await log.setEnabled(true)
    for (let index = 0; index < 30; index += 1) log.info('probe', `entry ${index}`)
    const entries = await log.recent(100)
    check('内存条目受上限约束', entries.length === 5, String(entries.length))
    check('内存保留最新条目', entries[entries.length - 1].includes('entry 29'), entries[entries.length - 1])
    check('超限产生归档文件', await exists(`${log.logPath}.1`) === true)
    const current = await readFile(log.logPath, 'utf8').catch(() => '')
    check('归档后仍在写新文件', current.includes('entry'), current.slice(0, 120))
  }

  // —— 5. 重启后保持开关与内容 ——
  {
    const dir = path.join(root, 'persist')
    const first = new Diagnostics({ dir })
    await first.setEnabled(true)
    first.info('plugin', 'before restart')
    await first.recent()

    const second = new Diagnostics({ dir })
    check('新实例构造时仍按默认值', second.enabled === false)
    await second.ready()
    check('读取状态文件后开关恢复', second.enabled === true)
    const entries = await second.recent()
    check('空缓冲时从文件回读', entries.length >= 1 && entries.some((entry) => entry.includes('before restart')), JSON.stringify(entries))
    check('回读条目数量受限', entries.length <= READ_ENTRIES, String(entries.length))
  }

  // —— 6. 关闭后停止记录 ——
  {
    const dir = path.join(root, 'toggle')
    const mirror = spyLogger()
    const log = new Diagnostics({ dir, mirror })
    await log.setEnabled(true)
    log.info('plugin', 'first')
    await log.recent()
    const before = mirror.calls.length
    await log.setEnabled(false)
    log.error('tool:ssh_run', new Error('after off'))
    await log.recent()
    const file = await readFile(log.logPath, 'utf8')
    check('关闭后不再写入', !file.includes('after off'), file)
    check('关闭后不再镜像到错误级别', mirror.calls.slice(before).every((call) => call.level !== 'error'), JSON.stringify(mirror.calls))
  }

  // —— 7. 清空 ——
  {
    const dir = path.join(root, 'clear')
    const log = new Diagnostics({ dir })
    await log.setEnabled(true)
    log.error('tool:ssh_probe', new Error('timeout'))
    await log.recent()
    await log.clear()
    check('清空后内存为空', (await log.recent()).length === 0)
    check('清空后文件被删除', await exists(log.logPath) === false)
    const status = await log.status()
    check('清空后大小归零', status.bytes === 0, String(status.bytes))
  }

  // —— 8. logger 外观：映射级别且同样受开关控制 ——
  {
    const dir = path.join(root, 'logger')
    const mirror = spyLogger()
    const log = new Diagnostics({ dir, mirror })
    log.logger.warn('dpapi unavailable')
    await log.recent()
    check('关闭时 logger 外观静默', mirror.calls.length === 0, JSON.stringify(mirror.calls))
    await log.setEnabled(true)
    log.logger.warn('dpapi unavailable')
    const entries = await log.recent()
    check('开启后 logger 外观可用', entries.some((entry) => entry.includes('WARN host') && entry.includes('dpapi unavailable')), JSON.stringify(entries))
  }
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log(`${passed} 项通过，${failures.length} 项失败`)
for (const failure of failures) console.error(`FAIL: ${failure}`)
if (failures.length > 0) process.exit(1)
console.log('全部通过')
