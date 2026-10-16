/**
 * 设置界面的 HTTP API —— 让 Web 设置页能够管理保险库。
 *
 * 这条通道与模型面向的 `ssh_hosts` 工具有两点本质差别，也正是它的价值所在：
 *
 * 1. 口令经 HTTP body 提交，**不进入会话日志**；工具参数则会。
 * 2. 私钥可以整份上传，由 Host 写进保险库目录并收紧权限，用户不必自己处理文件 ACL。
 *
 * 路由挂在 Web 服务器的 `/ssh-vault/` 前缀下，客户端用同源、document-relative 的
 * `fetch('ssh-vault/list', ...)` 提交 JSON，响应统一是 `{ ok, value }` / `{ ok, error }`。
 *
 * @module dsh-ssh-vault/vault-api
 */

import { execFile } from 'node:child_process'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { maskHost, maskUser } from './vault.js'

/** 路由前缀（Web 服务器侧，带前导斜杠）。 */
export const API_PREFIX = '/ssh-vault/'
/** 请求体上限：私钥经 base64 上传，留出足够余量。 */
const MAX_BODY_BYTES = 512 * 1024
/** 私钥副本的存放子目录。 */
const KEYS_DIR = 'keys'

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
}

/**
 * 写一个 JSON 响应。
 * @param res - HTTP 响应对象。
 * @param status - 状态码。
 * @param body - 可序列化的响应体。
 */
function writeJson(res, status, body) {
  res.writeHead(status, JSON_HEADERS)
  res.end(JSON.stringify(body))
}

/** 写一个成功 envelope。 */
const ok = (res, value) => writeJson(res, 200, { ok: true, value })

/** 写一个失败 envelope。 */
const fail = (res, code, message, status = 200) => writeJson(res, status, { ok: false, error: { code, message } })

/**
 * 读取有界的 JSON 请求体。
 * @param req - HTTP 请求对象。
 * @returns 解析后的对象；为空、超限或非法 JSON 时返回 `undefined`。
 */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) {
      req.destroy()
      return undefined
    }
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim().length === 0) return {}
  try {
    const parsed = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * 收紧一个文件的权限，尽力而为：Windows 用 icacls，其余平台用 chmod 0600。
 * @param filePath - 目标文件。
 * @returns 是否成功收紧。
 */
async function hardenFilePermissions(filePath) {
  try {
    if (process.platform !== 'win32') {
      await chmod(filePath, 0o600)
      return true
    }
    const who = `${process.env.USERDOMAIN ?? ''}\\${process.env.USERNAME ?? ''}`.replace(/^\\/, '')
    await new Promise((resolve, reject) => {
      execFile('icacls', [filePath, '/inheritance:r', '/grant:r', `${who}:(R)`], { windowsHide: true }, (error) => {
        if (error) reject(error)
        else resolve()
      })
    })
    return true
  } catch {
    return false
  }
}

/**
 * 插件版本，读一次即缓存。设置页把它显示出来，用于确认浏览器加载的是哪一版代码——
 * client bundle 不随 Host 重装而自动换代，这个标记能立刻区分「样式还没生效」和「样式写得不对」。
 * @returns 版本号，读取失败时为 `unknown`。
 */
let cachedVersion
async function pluginVersion() {
  if (cachedVersion === undefined) {
    try {
      cachedVersion = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version ?? 'unknown'
    } catch {
      cachedVersion = 'unknown'
    }
  }
  return cachedVersion
}

/**
 * 把一条主机记录整理成设置界面需要的形状（地址与账号脱敏，永不返回口令）。
 * @param record - 保险库中的主机记录。
 * @returns 可安全送到浏览器的视图对象。
 */
function hostView(record) {
  return {
    alias: record.alias,
    host: maskHost(record.host),
    port: record.port,
    username: maskUser(record.username),
    authType: record.auth?.type ?? 'agent',
    shell: record.shell ?? 'bash',
    description: record.description ?? '',
    tags: Array.isArray(record.tags) ? record.tags : [],
    bindAddress: record.bindAddress ?? '',
    credentialRef: record.credentialRef ?? '',
    privateKeyPath: record.auth?.type === 'key' ? record.auth.privateKeyPath : '',
    hasPassword: record.auth?.type === 'password' && typeof record.auth.password === 'string' && record.auth.password.length > 0,
    hasSudoPassword: typeof record.sudoPassword === 'string' && record.sudoPassword.length > 0,
    updatedAt: record.updatedAt ?? '',
  }
}

/**
 * 构造路由处理器。
 *
 * @param options - 依赖注入。
 * @param options.vault - 保险库实例。
 * @param options.vaultDir - 保险库目录（私钥副本落在其下的 keys/）。
 * @param options.probe - 连接自检回调 `(alias) => Promise<{ ok, detail, notes }>`。
 * @param options.logger - 可选日志接口。
 * @returns `(req, res) => Promise<void>` 形式的处理器。
 */
export function createVaultApi({ vault, vaultDir, probe, logger }) {
  /**
   * 保存一条主机记录。
   * @param body - 浏览器提交的表单数据。
   * @returns 面向浏览器的结果。
   */
  const saveHost = async (body) => {
    const alias = typeof body.alias === 'string' ? body.alias.trim() : ''
    if (alias.length === 0) return { error: '别名不能为空。' }
    if (!/^[A-Za-z0-9._-]+$/.test(alias)) return { error: '别名只能包含字母、数字、点、下划线和连字符。' }

    const existing = await vault.get(alias)
    const host = typeof body.host === 'string' ? body.host.trim() : ''
    const username = typeof body.username === 'string' ? body.username.trim() : ''
    if (host.length === 0) return { error: '主机地址不能为空。' }
    if (username.length === 0) return { error: '账号不能为空。' }

    const port = Number.isFinite(body.port) ? Number(body.port) : 22
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: '端口必须在 1 到 65535 之间。' }

    const authType = body.authType === 'key' ? 'key' : 'password'
    const next = {
      ...(existing ?? {}),
      alias,
      host,
      port,
      username,
      shell: typeof body.shell === 'string' && body.shell.trim().length > 0 ? body.shell.trim() : 'bash',
      description: typeof body.description === 'string' ? body.description : '',
      tags: Array.isArray(body.tags) ? body.tags.filter((tag) => typeof tag === 'string' && tag.length > 0) : [],
      bindAddress: typeof body.bindAddress === 'string' ? body.bindAddress.trim() : '',
    }

    if (authType === 'key') {
      let keyPath = typeof body.privateKeyPath === 'string' ? body.privateKeyPath.trim() : ''
      const upload = body.privateKeyFile
      if (upload !== undefined && upload !== null) {
        if (typeof upload.base64 !== 'string' || upload.base64.length === 0) return { error: '私钥内容为空。' }
        if (upload.base64.length > MAX_BODY_BYTES) return { error: '私钥文件过大。' }
        let bytes
        try {
          bytes = Buffer.from(upload.base64, 'base64')
        } catch {
          return { error: '私钥内容不是合法的 base64。' }
        }
        const text = bytes.toString('utf8')
        // 先判公钥：它的诊断比笼统的「不是私钥」更有用。
        if (/^(ssh-rsa|ssh-ed25519|ssh-dss|ecdsa-sha2-|sk-ssh-|sk-ecdsa-)/m.test(text.split(/\r?\n/, 1)[0] ?? '')) {
          return { error: '上传的是公钥，不是私钥。请选择不带 .pub 后缀的私钥文件。' }
        }
        if (!/PRIVATE KEY/.test(text.slice(0, 8192))) {
          return { error: '上传的文件看起来不是 OpenSSH/PEM 私钥（未找到 PRIVATE KEY 标记）。' }
        }
        const keyDir = path.join(vaultDir, KEYS_DIR)
        await mkdir(keyDir, { recursive: true })
        const target = path.join(keyDir, `${alias.replace(/[^A-Za-z0-9._-]/g, '_')}_id`)
        await writeFile(target, bytes, { mode: 0o600 })
        const hardened = await hardenFilePermissions(target)
        keyPath = target
        logger?.info?.(`ssh-vault: 已把上传的私钥保存到 ${target}（权限收紧：${hardened ? '是' : '否'}）`)
      }
      if (keyPath.length === 0) return { error: '密钥认证需要提供私钥：上传文件或填写私钥路径。' }
      next.auth = { type: 'key', privateKeyPath: keyPath }
      delete next.credentialRef
    } else {
      const password = typeof body.password === 'string' ? body.password : ''
      if (password.length > 0) {
        next.auth = { type: 'password', password }
        delete next.credentialRef
      } else if (existing?.auth?.type === 'password' && typeof existing.auth.password === 'string' && existing.auth.password.length > 0) {
        // 留空表示沿用已保存的口令。
        next.auth = { type: 'password', password: existing.auth.password }
      } else {
        return { error: '口令认证需要输入密码（编辑时留空表示保持原密码）。' }
      }
    }

    if (typeof body.sudoPassword === 'string' && body.sudoPassword.length > 0) next.sudoPassword = body.sudoPassword
    if (typeof body.credentialRef === 'string' && body.credentialRef.trim().length > 0) next.credentialRef = body.credentialRef.trim()

    await vault.put(next)
    return { value: { alias, created: existing === undefined } }
  }

  /**
   * 分发一次 API 调用。
   * @param action - 路由末段。
   * @param body - 已解析的请求体。
   * @returns `{ value }` 或 `{ error }`。
   */
  const dispatch = async (action, body) => {
    if (action === 'list') {
      const hosts = await vault.list()
      return { value: { hosts: hosts.map(hostView), keyMode: vault.keyMode ?? 'unknown', vaultDir, version: await pluginVersion() } }
    }
    if (action === 'save') return saveHost(body)
    if (action === 'remove') {
      const alias = typeof body.alias === 'string' ? body.alias.trim() : ''
      if (alias.length === 0) return { error: '缺少别名。' }
      const removed = await vault.remove(alias)
      return removed ? { value: { alias } } : { error: `保险库中没有名为 ${alias} 的主机。` }
    }
    if (action === 'test') {
      const alias = typeof body.alias === 'string' ? body.alias.trim() : ''
      if (alias.length === 0) return { error: '缺少别名。' }
      const record = await vault.get(alias)
      if (record === undefined) return { error: `保险库中没有名为 ${alias} 的主机。` }
      const result = await probe(alias)
      return { value: result }
    }
    if (action === 'reveal') {
      const alias = typeof body.alias === 'string' ? body.alias.trim() : ''
      const record = await vault.get(alias)
      if (record === undefined) return { error: `保险库中没有名为 ${alias} 的主机。` }
      return { value: { alias, host: record.host, port: record.port, username: record.username } }
    }
    return { error: `未知操作：${action}` }
  }

  /**
   * 一次 HTTP 请求的处理入口。
   * @param req - HTTP 请求。
   * @param res - HTTP 响应。
   */
  return async function handle(req, res) {
    try {
      if (req.method !== 'POST') {
        fail(res, 'method-not-allowed', '只接受 POST。', 405)
        return
      }
      const url = new URL(req.url ?? '/', 'http://localhost')
      const action = url.pathname.startsWith(API_PREFIX) ? url.pathname.slice(API_PREFIX.length) : ''
      if (action.length === 0 || action.includes('/')) {
        fail(res, 'not-found', '未知路由。', 404)
        return
      }
      const body = await readJsonBody(req)
      if (body === undefined) {
        fail(res, 'bad-request', '请求体不是合法 JSON 或超出大小限制。', 400)
        return
      }
      const outcome = await dispatch(action, body)
      if (outcome.error !== undefined) fail(res, 'request-failed', outcome.error)
      else ok(res, outcome.value)
    } catch (error) {
      logger?.warn?.(`ssh-vault: 设置接口处理失败：${error instanceof Error ? error.stack ?? error.message : String(error)}`)
      fail(res, 'internal', error instanceof Error ? error.message : String(error), 500)
    }
  }
}
