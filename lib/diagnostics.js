/**
 * 可开关的诊断日志。
 *
 * 插件默认**不写任何日志**：开关关着的时候，`log()` 在第一行就返回，既不进内存也不碰磁盘，
 * 所以「关掉日志」是真的安静，而不是把日志写得少一点。开关打开之后：
 *
 * - 错误与事件写进 `<dir>/diagnostics.log`（单一文件，超过上限自动轮转到 `.1`）；
 * - 同一份内容镜像到宿主 logger，方便在 DSH 的日志里一起看；
 * - 最近若干条留在内存里，设置页可以直接读出来，不用去找文件。
 *
 * 开关本身落在 `<dir>/diagnostics.json`，重启后保持——用户点了一次「开启」，不该在下一次
 * 启动时又悄悄变回关闭。文件与目录都在保险库目录之下，不散落到别处。
 *
 * 日志里出现口令是比没有日志更糟的事故，因此每条内容都过一遍 `redactSecrets`，并且调用方
 * **从不把工具参数整份传进来**。
 *
 * @module dsh-ssh-vault/diagnostics
 */

import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** 默认的单个日志文件上限（字节）。 */
export const DEFAULT_MAX_BYTES = 512 * 1024
/** 内存里保留的最近条目数。 */
const DEFAULT_MAX_ENTRIES = 200
/** 设置页一次最多回显多少条。 */
export const READ_ENTRIES = 40
/** 开关状态文件与日志文件名。 */
const STATE_FILE = 'diagnostics.json'
const LOG_FILE = 'diagnostics.log'
/** 轮转后的归档后缀。 */
const ARCHIVE_SUFFIX = '.1'

/** 日志级别，数值越大越啰嗦。 */
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 }

/**
 * 抹掉文本里看起来像口令的东西。
 *
 * 覆盖两种真实来源：错误消息里回显的 `password=...`、以及命令文本里手写的 `sudo -S <口令>`。
 * 这不是完备的 DLP，只是把最常见的两条泄漏路径堵上。
 *
 * @param text - 任意要写进日志的文本。
 * @returns 处理后的文本。
 */
export function redactSecrets(text) {
  return String(text ?? '')
    .replace(/(\b(?:password|passwd|passphrase|secret|token|sudoPassword)\b\s*[=:]\s*)\S+/gi, '$1***')
    .replace(/(sudo\s+-S\s*)\S+/g, '$1***')
}

/**
 * 把一个错误整理成一行消息。
 * @param error - 抛出的东西，通常是 Error。
 * @returns 消息文本。
 */
function messageOf(error) {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

/**
 * 把上下文对象拍平成 `key=value` 单行，空值直接丢掉。
 * @param context - 上下文对象。
 * @returns 形如 `host=kali action=add` 的单行；没有可用字段时为空串。
 */
function contextLine(context) {
  if (context === undefined || context === null || typeof context !== 'object') return ''
  return Object.entries(context)
    .filter(([, value]) => value !== undefined && value !== null && String(value).length > 0)
    .map(([key, value]) => `${key}=${redactSecrets(String(value))}`)
    .join(' ')
}

/**
 * 生成一条日志块：首行是元信息，其余行缩进，便于在纯文本里辨认。
 * @param at - ISO 时间。
 * @param level - 级别名。
 * @param scope - 来源，如 `tool:ssh_run`。
 * @param message - 摘要。
 * @param detail - 可选的详情（堆栈等）。
 * @returns 日志块文本。
 */
function formatEntry(at, level, scope, message, detail) {
  const head = `[${at}] ${level.toUpperCase()} ${scope} — ${redactSecrets(message)}`
  // detail 的形状由调用方决定（字符串、undefined，偶尔是事件对象）：这里一律降级成文本，
  // 日志本身永远不该成为新的错误来源。
  const text = typeof detail === 'string'
    ? detail
    : detail === undefined || detail === null ? '' : String(detail)
  const body = text.trim().length > 0
    ? text.split(/\r?\n/).map((line) => `    ${redactSecrets(line)}`).join('\n')
    : ''
  return body.length > 0 ? `${head}\n${body}` : head
}

/**
 * 判断一行是不是一条日志的首行。
 * @param line - 待判断的行。
 * @returns 是否为条目起始行。
 */
function isEntryHead(line) {
  return /^\[\d{4}-\d{2}-\d{2}T[^\]]*\] (?:ERROR|WARN|INFO|DEBUG) /.test(line)
}

/**
 * 诊断日志：开关、落盘、镜像、回读。
 */
export class Diagnostics {
  #dir
  #mirror
  #maxBytes
  #maxEntries
  #enabled
  #entries = []
  #size = 0
  #loaded
  #queue = Promise.resolve()
  #logger

  /**
   * @param options - 配置。
   * @param options.dir - 日志目录。
   * @param options.enabled - 初始开关值；状态文件里的值优先。
   * @param options.mirror - 宿主 logger，开关打开时镜像一份过去。
   * @param options.maxBytes - 单个文件上限。
   * @param options.maxEntries - 内存里保留的条目数。
   */
  constructor({ dir, enabled = false, mirror, maxBytes, maxEntries } = {}) {
    if (typeof dir !== 'string' || dir.trim().length === 0) {
      throw new TypeError('Diagnostics requires a directory')
    }
    this.#dir = dir
    this.#enabled = enabled === true
    this.#mirror = mirror
    this.#maxBytes = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULT_MAX_BYTES
    this.#maxEntries = Number.isFinite(maxEntries) && maxEntries > 0 ? maxEntries : DEFAULT_MAX_ENTRIES
    this.#loaded = this.#load()
    // 同一个对象给 Vault 与设置接口用：它们的 logger 语义是「写进本插件日志」。
    this.#logger = {
      error: (message, detail) => this.error('host', message, undefined, detail),
      warn: (message) => this.warn('host', message),
      info: (message) => this.info('host', message),
      debug: (message) => this.debug('host', message),
    }
  }

  /** 日志目录。 */
  get dir() {
    return this.#dir
  }

  /** 日志文件路径。 */
  get logPath() {
    return join(this.#dir, LOG_FILE)
  }

  /** 开关状态文件路径。 */
  get statePath() {
    return join(this.#dir, STATE_FILE)
  }

  /** 当前开关状态（同步可读，用于热点路径判断）。 */
  get enabled() {
    return this.#enabled
  }

  /** 给 Vault / 设置接口使用的 logger 外观。 */
  get logger() {
    return this.#logger
  }

  /** 等待初始状态读取完成。 */
  async ready() {
    await this.#loaded
  }

  /** 确保日志目录存在（「打开日志目录」在从未开过日志时也能用）。 */
  async ensureDir() {
    await mkdir(this.#dir, { recursive: true })
  }

  /**
   * 读取持久化的开关与已有文件大小。
   */
  async #load() {
    try {
      const state = JSON.parse(await readFile(this.statePath, 'utf8'))
      if (typeof state?.enabled === 'boolean') this.#enabled = state.enabled
    } catch {
      // 首次运行、文件损坏、权限不足都退回构造时给的值。
    }
    try {
      this.#size = (await stat(this.logPath)).size
    } catch {
      this.#size = 0
    }
  }

  /**
   * 打开或关闭日志。
   * @param enabled - 目标状态。
   * @returns 生效后的状态。
   */
  async setEnabled(enabled) {
    await this.#loaded
    const next = enabled === true
    if (next !== this.#enabled) {
      this.#enabled = next
      if (next) this.info('diagnostics', 'logging enabled')
      else this.#mirror?.info?.('[ssh-vault] diagnostics log disabled')
    }
    try {
      await mkdir(this.#dir, { recursive: true })
      await writeFile(this.statePath, `${JSON.stringify({ enabled: this.#enabled, updatedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8')
    } catch {
      // 状态没存下来只是「下次启动回到初始值」，不该让这次切换失败。
    }
    return this.#enabled
  }

  /**
   * 记一条日志。开关关着时立即返回。
   * @param level - error / warn / info / debug。
   * @param scope - 来源。
   * @param message - 摘要。
   * @param detail - 可选详情。
   */
  log(level, scope, message, detail) {
    if (!this.#enabled) return
    const name = LEVELS[level] === undefined ? 'info' : level
    const entry = formatEntry(new Date().toISOString(), name, scope, message, detail)
    this.#entries.push(entry)
    if (this.#entries.length > this.#maxEntries) {
      this.#entries.splice(0, this.#entries.length - this.#maxEntries)
    }
    this.#mirrorEntry(name, entry)
    this.#queue = this.#queue.then(() => this.#append(entry)).catch(() => {})
  }

  /** 便利方法：记录一个错误，默认带上堆栈。 */
  error(scope, error, context, detail) {
    const stack = detail ?? (error instanceof Error ? error.stack : undefined)
    const extra = [contextLine(context), stack]
      .filter((part) => typeof part === 'string' && part.trim().length > 0)
      .join('\n')
    this.log('error', scope, messageOf(error), extra)
  }

  warn(scope, message, detail) {
    this.log('warn', scope, message, detail)
  }

  info(scope, message, detail) {
    this.log('info', scope, message, detail)
  }

  debug(scope, message, detail) {
    this.log('debug', scope, message, detail)
  }

  /**
   * 镜像到宿主 logger；宿主 logger 的形状不可控，任何异常都吞掉。
   * @param level - 级别名。
   * @param text - 已经格式化好的整块文本。
   */
  #mirrorEntry(level, text) {
    const target = this.#mirror
    if (target === undefined || target === null) return
    try {
      const sink = typeof target[level] === 'function' ? target[level] : target.info
      sink?.call(target, `[ssh-vault] ${text}`)
    } catch {
      // 镜像失败与本插件的日志无关。
    }
  }

  /**
   * 追加一条日志块，必要时先轮转。
   * @param entry - 已格式化的日志块。
   */
  async #append(entry) {
    await mkdir(this.#dir, { recursive: true })
    const bytes = Buffer.byteLength(entry, 'utf8') + 1
    if (this.#size > 0 && this.#size + bytes > this.#maxBytes) await this.#rotate()
    await appendFile(this.logPath, `${entry}\n`, 'utf8')
    this.#size += bytes
  }

  /** 把当前文件挪到 `.1`（覆盖更早的归档）。 */
  async #rotate() {
    try {
      await rm(`${this.logPath}${ARCHIVE_SUFFIX}`, { force: true })
      await rename(this.logPath, `${this.logPath}${ARCHIVE_SUFFIX}`)
    } catch {
      // 归档失败就继续往原文件追加：宁可超一点，也不要丢日志。
    }
    this.#size = 0
  }

  /**
   * 最近的日志条目。
   *
   * 优先用内存缓冲；进程刚启动、缓冲还是空的，就从文件尾部回读，免得「打开日志看到一片空白」。
   *
   * @param limit - 最多返回多少条。
   * @returns 条目文本数组，旧的在前。
   */
  async recent(limit = READ_ENTRIES) {
    await this.#loaded
    await this.#queue.catch(() => {})
    const max = Number.isFinite(limit) && limit > 0 ? limit : READ_ENTRIES
    if (this.#entries.length > 0) return this.#entries.slice(-max)
    let text = ''
    try {
      text = await readFile(this.logPath, 'utf8')
    } catch {
      return []
    }
    const blocks = []
    let current = null
    for (const line of text.split(/\r?\n/)) {
      if (isEntryHead(line)) {
        if (current !== null) blocks.push(current.join('\n'))
        current = [line]
      } else if (current !== null) {
        current.push(line)
      }
    }
    if (current !== null) blocks.push(current.join('\n').replace(/\n+$/, ''))
    return blocks.filter((block) => block.length > 0).slice(-max)
  }

  /**
   * 设置界面要的状态快照。
   * @returns 开关、路径、大小与最近条目。
   */
  async status() {
    await this.#loaded
    return {
      enabled: this.#enabled,
      dir: this.#dir,
      path: this.logPath,
      maxBytes: this.#maxBytes,
      bytes: this.#size,
      entries: await this.recent(),
    }
  }

  /** 清空日志（内存与磁盘）。 */
  async clear() {
    await this.#queue.catch(() => {})
    this.#entries = []
    this.#size = 0
    try {
      await rm(this.logPath, { force: true })
      await rm(`${this.logPath}${ARCHIVE_SUFFIX}`, { force: true })
    } catch {
      // 文件被别的进程占用时保留内容，比让按钮报错更有用。
    }
  }
}
