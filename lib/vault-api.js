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

import { execFile, spawn } from 'node:child_process'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { learnLocaleFromHeader, t } from './i18n.js'
import { maskHost, maskUser } from './vault.js'

/**
 * 路由前缀。
 *
 * **不要带尾斜杠**：Web 服务器的 `kind: 'prefix'` 按「`path` 或 `path + '/'`」匹配，
 * 注册 `/ssh-vault/` 时 `/ssh-vault/list` 两者都不命中，请求会落到 fallback 而不是这里。
 * 官方插件注册的是 `/git`，这里与它保持一致。
 */
export const API_PREFIX = '/ssh-vault'
/** 请求体上限：私钥经 base64 上传，留出足够余量。 */
const MAX_BODY_BYTES = 512 * 1024
/** 私钥副本的存放子目录。 */
const KEYS_DIR = 'keys'
/**
 * 设置页自动体检的超时。
 *
 * 卡片一出来就会各自摸一次连接，用默认的两分钟会让一台不通的主机把整个页面拖成"一直转圈"。
 * 八秒足够越过一次正常握手，也短到能接受。
 */
export const SETTINGS_PROBE_TIMEOUT_MS = 15000

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
 * 恢复一个文件被 hardenFilePermissions 收紧过的权限：Windows 用 `icacls /reset`
 * 回到继承 ACL，其余平台 chmod 回 0600。收紧成用户只读的副本连写带删都会被
 * 拒绝（EPERM），覆盖写回或删除前必须先恢复。文件不存在或失败都安静地返回 false。
 * @param filePath - 目标文件。
 * @returns 是否成功恢复。
 */
export async function resetFilePermissions(filePath) {
  try {
    if (process.platform !== 'win32') {
      await chmod(filePath, 0o600)
      return true
    }
    await new Promise((resolve, reject) => {
      execFile('icacls', [filePath, '/reset'], { windowsHide: true }, (error) => {
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
 * 插件版本。**故意不缓存**：这个字段的唯一用途就是让设置页显示「当前跑的是哪一版代码」，
 * 一个滞后的版本号比没有更糟。package.json 很小，每次列主机时读一次的开销可以忽略。
 * @returns 版本号，读取失败时为 `unknown`。
 */
async function pluginVersion() {
  try {
    return JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version ?? 'unknown'
  } catch {
    return 'unknown'
  }
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
 * 用系统文件管理器打开一个目录。
 *
 * 只被内部以插件自己的 `vaultDir` 调用，**从不接受请求方传入的路径**——否则这就成了
 * 一个「按需启动本机程序」的接口。
 *
 * @param target - 要打开的目录。
 */
function defaultOpenFolder(target) {
  const [command, args] = process.platform === 'win32'
    ? ['explorer.exe', [target]]
    : process.platform === 'darwin'
      ? ['open', [target]]
      : ['xdg-open', [target]]
  return new Promise((resolve, reject) => {
    // 用 spawn 而不是 execFile：文件管理器是 GUI 程序，没有理由等它退出，
    // 而 explorer.exe 又可能长期驻留——等下去只会把这条请求挂住。
    const child = spawn(command, args, { detached: true, stdio: 'ignore' })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

/**
 * 构造路由处理器。
 *
 * @param options - 依赖注入。
 * @param options.vault - 保险库实例。
 * @param options.vaultDir - 保险库目录（私钥副本落在其下的 keys/）。
 * @param options.probe - 连接自检回调 `(alias, timeoutMs) => Promise<{ ok, detail, notes }>`。
 * @param options.openFolder - 打开目录的实现，默认交给系统文件管理器；测试可替换。
 * @param options.requestRejection - 可选：把请求交给宿主的 Connection 信任栅栏
 *   （Host/Origin 校验 + 浏览器认证），返回 401 / 403 / undefined。
 * @param options.logger - 可选日志接口。
 * @returns `(req, res) => Promise<void>` 形式的处理器。
 */
export function createVaultApi({ vault, vaultDir, probe, openFolder, requestRejection, logger }) {
  /**
   * 保存一条主机记录。
   * @param body - 浏览器提交的表单数据。
   * @returns 面向浏览器的结果。
   */
  const saveHost = async (body) => {
    const alias = typeof body.alias === 'string' ? body.alias.trim() : ''
    if (alias.length === 0) return { error: t('api.aliasRequired') }
    if (!/^[A-Za-z0-9._-]+$/.test(alias)) return { error: t('api.aliasInvalid') }

    // 改名：编辑表单会带上它开始编辑时的旧别名。凭据、私钥路径、备注都随记录一起搬过去。
    const renameFrom = typeof body.renameFrom === 'string' ? body.renameFrom.trim() : ''
    const sourceAlias = renameFrom.length > 0 && renameFrom !== alias ? renameFrom : alias
    const renaming = sourceAlias !== alias
    const existing = await vault.get(sourceAlias)
    if (renaming) {
      if (existing === undefined) return { error: t('api.renameSourceMissing', { alias: sourceAlias }) }
      if ((await vault.get(alias)) !== undefined) return { error: t('api.aliasTaken', { alias }) }
    }

    const host = typeof body.host === 'string' ? body.host.trim() : ''
    const username = typeof body.username === 'string' ? body.username.trim() : ''
    if (host.length === 0) return { error: t('api.hostRequired') }
    if (username.length === 0) return { error: t('api.usernameRequired') }

    const port = Number.isFinite(body.port) ? Number(body.port) : 22
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: t('api.portInvalid') }

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
        if (typeof upload.base64 !== 'string' || upload.base64.length === 0) return { error: t('api.keyEmpty') }
        if (upload.base64.length > MAX_BODY_BYTES) return { error: t('api.keyTooLarge') }
        let bytes
        try {
          bytes = Buffer.from(upload.base64, 'base64')
        } catch {
          return { error: t('api.keyBadBase64') }
        }
        const text = bytes.toString('utf8')
        const head = text.slice(0, 8192)
        // 诊断顺序：公钥 → PuTTY → 根本不是密钥。越具体的结论越先给。
        if (/^(ssh-rsa|ssh-ed25519|ssh-dss|ecdsa-sha2-|sk-ssh-|sk-ecdsa-)/m.test(head.split(/\r?\n/, 1)[0] ?? '')) {
          return { error: t('api.keyPublic') }
        }
        if (/^PuTTY-User-Key-File-/m.test(head)) {
          return { error: t('api.keyPpk') }
        }
        // 要求真正的私钥封装头。只搜 "PRIVATE KEY" 字样不够——任意文本里出现这几个词就能混过去。
        if (!/^-----BEGIN (?:OPENSSH |RSA |DSA |EC |ENCRYPTED )?PRIVATE KEY-----/m.test(head)) {
          return { error: t('api.keyNotPrivate') }
        }
        const keyDir = path.join(vaultDir, KEYS_DIR)
        await mkdir(keyDir, { recursive: true })
        const target = path.join(keyDir, `${alias.replace(/[^A-Za-z0-9._-]/g, '_')}_id`)
        // 上一次上传留下的同名副本已被收紧成只读 ACL，直接覆盖会被拒；先恢复再写。
        await resetFilePermissions(target)
        await writeFile(target, bytes, { mode: 0o600 })
        const hardened = await hardenFilePermissions(target)
        keyPath = target
        logger?.info?.(`ssh-vault: 已把上传的私钥保存到 ${target}（权限收紧：${hardened ? '是' : '否'}）`)
      }
      if (keyPath.length === 0) return { error: t('api.keyRequired') }
      next.auth = {
        type: 'key',
        privateKeyPath: keyPath,
        ...(typeof body.passphrase === 'string' && body.passphrase.length > 0 ? { passphrase: body.passphrase } : {}),
      }
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
        return { error: t('api.passwordRequired') }
      }
    }

    if (typeof body.sudoPassword === 'string' && body.sudoPassword.length > 0) next.sudoPassword = body.sudoPassword
    if (typeof body.credentialRef === 'string' && body.credentialRef.trim().length > 0) next.credentialRef = body.credentialRef.trim()

    await vault.put(next)
    // 先写新记录再删旧的：即使删除失败，最坏也只是多出一条副本，不会丢配置。
    if (renaming) await vault.remove(sourceAlias)
    return { value: { alias, created: existing === undefined, renamedFrom: renaming ? sourceAlias : undefined } }
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
      if (alias.length === 0) return { error: t('api.removeAliasRequired') }
      const removed = await vault.remove(alias)
      return removed ? { value: { alias } } : { error: t('api.hostNotFound', { alias }) }
    }
    if (action === 'test') {
      const alias = typeof body.alias === 'string' ? body.alias.trim() : ''
      if (alias.length === 0) return { error: t('api.removeAliasRequired') }
      const record = await vault.get(alias)
      if (record === undefined) return { error: t('api.hostNotFound', { alias }) }
      const result = await probe(alias, SETTINGS_PROBE_TIMEOUT_MS)
      return { value: result }
    }
    if (action === 'openVault') {
      // 路径来自插件自身，不接受请求体里的任何路径。
      try {
        await (openFolder ?? defaultOpenFolder)(vaultDir)
        return { value: { opened: true, path: vaultDir } }
      } catch (error) {
        return { error: t('api.openFolderFailed', { message: error instanceof Error ? error.message : String(error) }) }
      }
    }
    if (action === 'reveal') {
      const alias = typeof body.alias === 'string' ? body.alias.trim() : ''
      const record = await vault.get(alias)
      if (record === undefined) return { error: t('api.hostNotFound', { alias }) }
      return { value: { alias, host: record.host, port: record.port, username: record.username } }
    }
    return { error: t('api.unknownAction', { action }) }
  }

  /**
   * 一次 HTTP 请求的处理入口。
   * @param req - HTTP 请求。
   * @param res - HTTP 响应。
   */
  return async function handle(req, res) {
    try {
      // 信任栅栏先于一切：这条路由能读写凭据与私钥，未认证/跨站请求不该有机会
      // 读请求体、改进程内语言、或探测动作是否存在。宿主 Connection 的
      // requestRejection 负责 Host/Origin 校验与浏览器登录 cookie 认证，
      // 与 /api 及 open-in-app 等内置路由使用同一套判定。
      const rejection = typeof requestRejection === 'function' ? requestRejection(req) : undefined
      if (rejection !== undefined) {
        res.writeHead(rejection, {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        })
        res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
        return
      }
      // 最后一道语言信号：没有显式偏好时，浏览器的 Accept-Language 与 DSH 未设置偏好时
      // 派生出的界面语言一致。显式偏好优先级更高，`learnLocaleFromHeader` 会忽略它。
      try {
        learnLocaleFromHeader(req?.headers?.['accept-language'])
      } catch {
        // 头缺失或形状异常都不影响请求本身。
      }
      if (req.method !== 'POST') {
        fail(res, 'method-not-allowed', t('api.methodPostOnly'), 405)
        return
      }
      const url = new URL(req.url ?? '/', 'http://localhost')
      const rest = url.pathname.startsWith(API_PREFIX) ? url.pathname.slice(API_PREFIX.length) : ''
      const action = rest.startsWith('/') ? rest.slice(1) : rest
      if (action.length === 0 || action.includes('/')) {
        fail(res, 'not-found', t('api.routeUnknown'), 404)
        return
      }
      const body = await readJsonBody(req)
      if (body === undefined) {
        fail(res, 'bad-request', t('api.bodyInvalid'), 400)
        return
      }
      const outcome = await dispatch(action, body)
      if (outcome.error !== undefined) fail(res, 'request-failed', outcome.error)
      else ok(res, outcome.value)
    } catch (error) {
      logger?.warn?.(`ssh-vault: settings request failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
      fail(res, 'internal', error instanceof Error ? error.message : String(error), 500)
    }
  }
}
