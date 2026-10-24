/**
 * 加密保险库（vault）—— 用 AES-256-GCM 保护 SSH 主机清单。
 *
 * 设计要点：
 * - 主机地址、端口、账号、口令全部位于密文内部，磁盘上只留下 `vault.json` 的
 *   `iv` / `tag` / `data` 三段 base64，不出现任何明文。
 * - 数据密钥（DEK）为 32 字节随机数，其保护方式由 `keyProtection` 决定：
 *     · `dpapi`（默认）—— 用 Windows DPAPI 以当前用户身份加密后写入 `key.json`，
 *       文件被复制到其他机器或其他用户下都无法解开；
 *     · `file` —— 直接写入 `key.json`，安全边界等同于文件系统权限；
 *     · `passphrase` —— 由用户主口令经 scrypt 派生，磁盘上不保存密钥材料。
 * - GCM 的附加认证数据（AAD）绑定格式版本，避免密文被降级重放。
 *
 * @module dsh-ssh-vault/vault
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { t } from './i18n.js'

/** 保险库格式版本；同时参与 AAD 计算。 */
export const VAULT_VERSION = 1
/** AES-256 密钥长度（字节）。 */
const KEY_BYTES = 32
/** GCM 推荐 IV 长度（字节）。 */
const IV_BYTES = 12
/** scrypt 盐长度（字节）。 */
const SALT_BYTES = 16
/** GCM 认证标签长度（字节）。 */
const TAG_BYTES = 16
/** 绑定到密文的附加认证数据。 */
const AAD = Buffer.from('dsh-ssh-vault:v1', 'utf8')
/** scrypt 参数：约 32 MiB 内存开销，兼顾强度与启动延迟。 */
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }

/** 默认保险库目录：优先使用 DSH_HOME，保持与 Harness 其他私有数据同处一地。 */
export function defaultVaultDir() {
  const home = process.env.DSH_HOME ?? path.join(homedir(), '.dsh')
  return path.join(home, 'ssh-vault')
}

/**
 * 用 Windows DPAPI 保护一段数据（仅当前用户可解密）。
 * @param data - 待保护的原始字节。
 * @returns base64 形式的受保护数据。
 */
async function dpapiProtect(data) {
  return runPowerShell(
    "Add-Type -AssemblyName System.Security;"
    + "$in=[Console]::In.ReadToEnd().Trim();"
    + "$b=[Convert]::FromBase64String($in);"
    + "$p=[System.Security.Cryptography.ProtectedData]::Protect($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);"
    + "[Console]::Out.Write([Convert]::ToBase64String($p))",
    data.toString('base64'),
  )
}

/**
 * 解除 DPAPI 保护。
 * @param payload - base64 形式的受保护数据。
 * @returns 原始字节。
 */
async function dpapiUnprotect(payload) {
  const out = await runPowerShell(
    "Add-Type -AssemblyName System.Security;"
    + "$in=[Console]::In.ReadToEnd().Trim();"
    + "$b=[Convert]::FromBase64String($in);"
    + "$p=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);"
    + "[Console]::Out.Write([Convert]::ToBase64String($p))",
    payload,
  )
  return Buffer.from(out.trim(), 'base64')
}

/**
 * 通过 stdin 传入数据并执行一段 Windows PowerShell，避免任何命令行转义问题。
 * @param script - PowerShell 脚本，从 stdin 读取输入。
 * @param input - 写入子进程 stdin 的文本。
 * @returns 子进程的标准输出。
 */
function runPowerShell(script, input) {
  return new Promise((resolve, reject) => {
    const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
    const exe = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const child = spawn(exe, ['-NoProfile', '-NonInteractive', '-Command', script], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(t('vault.dpapiTimeout')))
    }, 15000)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0 && stdout.trim().length > 0) resolve(stdout)
      else reject(new Error(t('vault.dpapiFailed', { code, output: stderr.trim() || t('vault.noOutput') })))
    })
    child.stdin.end(input)
  })
}

/**
 * 对主机地址做脱敏，只保留网络前缀。
 * @param host - 原始地址。
 * @returns 形如 `192.168.*.*` 的掩码。
 */
export function maskHost(host) {
  if (typeof host !== 'string' || host.length === 0) return '(unknown)'
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    const parts = host.split('.')
    return `${parts[0]}.${parts[1]}.*.*`
  }
  const dot = host.indexOf('.')
  if (dot > 0) return `${host.slice(0, dot)}.${'*'.repeat(Math.max(1, host.length - dot - 1))}`
  return `${host.slice(0, 2)}${'*'.repeat(Math.max(1, host.length - 2))}`
}

/**
 * 对账号名做脱敏，保留首字符。
 * @param user - 原始账号。
 * @returns 掩码后的账号。
 */
export function maskUser(user) {
  if (typeof user !== 'string' || user.length === 0) return '(unknown)'
  if (user.length <= 2) return `${user[0]}*`
  return `${user[0]}${'*'.repeat(Math.min(user.length - 1, 4))}`
}

/**
 * 加密保险库。所有主机记录都以密文形式保存在一个文件中，读取时才在内存解密。
 */
export class Vault {
  #dir
  #keyProtection
  #masterPassword
  #logger
  #key = null
  #mode = null
  #hosts = null
  #chain = Promise.resolve()

  /**
   * @param options - 保险库配置。
   * @param options.dir - 保险库目录。
   * @param options.keyProtection - 数据密钥的保护方式。
   * @param options.masterPassword - `passphrase` 模式下的主口令。
   * @param options.logger - 可选的日志接口。
   */
  constructor({ dir, keyProtection = 'dpapi', masterPassword, logger } = {}) {
    this.#dir = dir ?? defaultVaultDir()
    this.#keyProtection = keyProtection
    this.#masterPassword = masterPassword
    this.#logger = logger
  }

  /** 保险库目录（其中包含密文、密钥与 askpass 辅助脚本）。 */
  get dir() {
    return this.#dir
  }

  /** 当前数据密钥的保护方式，初始化后可用。 */
  get keyMode() {
    return this.#mode
  }

  #file(name) {
    return path.join(this.#dir, name)
  }

  async #ensureDir() {
    await mkdir(this.#dir, { recursive: true })
  }

  /** 载入或首次创建数据密钥。 */
  async #loadKey() {
    if (this.#key !== null) return
    await this.#ensureDir()
    const keyPath = this.#file('key.json')
    if (existsSync(keyPath)) {
      const stored = JSON.parse(await readFile(keyPath, 'utf8'))
      if (stored.mode === 'passphrase') {
        if (typeof this.#masterPassword !== 'string' || this.#masterPassword.length === 0) {
          throw new Error(t('vault.masterPasswordMissing'))
        }
        this.#key = scryptSync(this.#masterPassword, Buffer.from(stored.salt, 'base64'), KEY_BYTES, SCRYPT)
      } else if (stored.mode === 'dpapi') {
        try {
          this.#key = await dpapiUnprotect(stored.payload)
        } catch (error) {
          throw new Error(t('vault.dpapiUnwrapFailed', {
            message: error instanceof Error ? error.message : String(error),
          }))
        }
      } else {
        this.#key = Buffer.from(stored.payload, 'base64')
      }
      this.#mode = stored.mode
      return
    }
    // 首次运行：生成数据密钥并按既定方式保护。
    const key = randomBytes(KEY_BYTES)
    let record
    if (this.#keyProtection === 'passphrase') {
      if (typeof this.#masterPassword !== 'string' || this.#masterPassword.length === 0) {
        throw new Error(t('vault.masterPasswordRequired'))
      }
      const salt = randomBytes(SALT_BYTES)
      record = { version: VAULT_VERSION, mode: 'passphrase', salt: salt.toString('base64') }
      await writeFile(keyPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
      this.#key = scryptSync(this.#masterPassword, salt, KEY_BYTES, SCRYPT)
      this.#mode = 'passphrase'
      return
    }
    if (this.#keyProtection === 'dpapi') {
      try {
        const payload = await dpapiProtect(key)
        record = { version: VAULT_VERSION, mode: 'dpapi', payload }
        await writeFile(keyPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
        this.#key = key
        this.#mode = 'dpapi'
        return
      } catch (error) {
        // DPAPI 不可用时降级为明文密钥文件，并明确告知使用者当前安全边界。
        this.#logger?.warn?.(t('vault.dpapiUnavailable', {
          message: error instanceof Error ? error.message : String(error),
        }))
      }
    }
    record = { version: VAULT_VERSION, mode: 'file', payload: key.toString('base64') }
    await writeFile(keyPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
    this.#key = key
    this.#mode = 'file'
  }

  /** 读取并解密主机清单。 */
  async #loadHosts() {
    if (this.#hosts !== null) return this.#hosts
    await this.#loadKey()
    const vaultPath = this.#file('vault.json')
    if (!existsSync(vaultPath)) {
      this.#hosts = { version: VAULT_VERSION, hosts: {} }
      return this.#hosts
    }
    const envelope = JSON.parse(await readFile(vaultPath, 'utf8'))
    const decipher = createDecipheriv('aes-256-gcm', this.#key, Buffer.from(envelope.iv, 'base64'))
    decipher.setAAD(AAD)
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'))
    let plain
    try {
      plain = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()])
    } catch {
      throw new Error(t('vault.decryptFailed'))
    }
    const parsed = JSON.parse(plain.toString('utf8'))
    this.#hosts = { version: VAULT_VERSION, hosts: parsed.hosts ?? {} }
    return this.#hosts
  }

  /** 原子地把主机清单加密落盘。 */
  async #storeHosts() {
    await this.#loadKey()
    const iv = randomBytes(IV_BYTES)
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv)
    cipher.setAAD(AAD)
    const plain = Buffer.from(JSON.stringify(this.#hosts), 'utf8')
    const data = Buffer.concat([cipher.update(plain), cipher.final()])
    const tag = cipher.getAuthTag()
    const envelope = {
      version: VAULT_VERSION,
      alg: 'aes-256-gcm',
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      data: data.toString('base64'),
    }
    const target = this.#file('vault.json')
    const temp = this.#file(`vault.json.${process.pid}.tmp`)
    await writeFile(temp, `${JSON.stringify(envelope)}\n`, 'utf8')
    await rename(temp, target)
  }

  /**
   * 在保险库锁内执行一次读改写，避免并发工具调用互相覆盖。
   * @param fn - 收到当前主机表并返回结果的操作。
   * @returns 操作结果。
   */
  #locked(fn) {
    const run = this.#chain.then(fn, fn)
    this.#chain = run.then(() => undefined, () => undefined)
    return run
  }

  /**
   * 列出全部主机记录（含明文，仅供插件内部使用，调用方负责脱敏）。
   * @returns 主机记录数组。
   */
  async list() {
    return this.#locked(async () => {
      const data = await this.#loadHosts()
      return Object.values(data.hosts).sort((a, b) => a.alias.localeCompare(b.alias))
    })
  }

  /**
   * 读取一台主机。
   * @param alias - 主机别名。
   * @returns 主机记录，不存在时为 `undefined`。
   */
  async get(alias) {
    return this.#locked(async () => {
      const data = await this.#loadHosts()
      return data.hosts[alias]
    })
  }

  /**
   * 新增或整体替换一台主机。
   * @param record - 完整的主机记录，至少包含 `alias`。
   * @returns 写入后的记录。
   */
  async put(record) {
    return this.#locked(async () => {
      const data = await this.#loadHosts()
      const now = new Date().toISOString()
      const previous = data.hosts[record.alias]
      const next = {
        ...record,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
      }
      data.hosts[record.alias] = next
      await this.#storeHosts()
      return next
    })
  }

  /**
   * 删除一台主机。
   * @param alias - 主机别名。
   * @returns 是否确实删除了记录。
   */
  async remove(alias) {
    return this.#locked(async () => {
      const data = await this.#loadHosts()
      if (data.hosts[alias] === undefined) return false
      delete data.hosts[alias]
      await this.#storeHosts()
      return true
    })
  }

  /**
   * 就地更新一台主机的部分字段（口令等敏感字段始终整体替换）。
   * @param alias - 主机别名。
   * @param patch - 需要覆盖的字段。
   * @returns 更新后的记录，主机不存在时为 `undefined`。
   */
  async patch(alias, patch) {
    return this.#locked(async () => {
      const data = await this.#loadHosts()
      const previous = data.hosts[alias]
      if (previous === undefined) return undefined
      const next = { ...previous, ...patch, alias, updatedAt: new Date().toISOString() }
      data.hosts[alias] = next
      await this.#storeHosts()
      return next
    })
  }

  /** 保险库中 `known_hosts` 文件的路径（OpenSSH 主机密钥记录）。 */
  get knownHostsPath() {
    return this.#file('known_hosts')
  }

  /** 等待目录就绪，供需要写入辅助脚本的调用方使用。 */
  async ensureDir() {
    await this.#ensureDir()
    return this.#dir
  }
}
