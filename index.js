/**
 * SSH 保险库插件 —— 让智能体通过别名使用 SSH，同时把主机地址、端口、账号与口令
 * 全部保存在加密保险库中。
 *
 * 暴露四个模型面向工具：
 * - `ssh_hosts`    管理保险库里的主机（列出 / 查看 / 新增 / 修改 / 删除）
 * - `ssh_run`      在已保存主机上执行命令，可选后台运行
 * - `ssh_transfer` 在本地与主机之间传文件
 * - `ssh_probe`    连接自检并回读远端系统信息
 *
 * @module dsh-ssh-vault
 */

import { readFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { registerSshJob } from './lib/background.js'
import { MAX_TIMEOUT_MS, buildDetachScript, buildWaitScript, ensureAskpass, parseExitStatus, probeCommand, renderTerminalBlock, runRemote, shellKind, transferFile } from './lib/ssh.js'
import { API_PREFIX, SETTINGS_PROBE_TIMEOUT_MS, createVaultApi } from './lib/vault-api.js'
import { Vault, defaultVaultDir, maskHost, maskUser } from './lib/vault.js'

/** 插件名（同时是 Loader 行的 id）。 */
export const name = 'ssh-vault'
/** 依赖的 Host 服务：没有工具注册表就无法工作。 */
export const inject = ['tools']

/** 默认单次命令超时。 */
const DEFAULT_TIMEOUT_MS = 120000
/** 默认保留的输出上限（字符）。 */
const DEFAULT_MAX_OUTPUT = 200000

/**
 * 把一个字符串结果包装成最小可用的工具定义。
 * @param options - 工具名、描述、参数与执行函数。
 * @returns 可直接注册的工具定义。
 */
function textTool({ name: toolName, description, parameters, execute, terminal, presentCall, presentResult }) {
  return {
    name: toolName,
    description,
    parameters,
    output: {
      schema: { type: 'string' },
      render: (_args, value) => {
        const text = typeof value === 'string' ? value : String(value)
        return [{ type: 'text', text: terminal === true ? renderTerminalBlock(text) : text }]
      },
    },
    execute,
    ...(presentCall !== undefined ? { presentCall } : {}),
    ...(presentResult !== undefined ? { presentResult } : {}),
  }
}

/**
 * 把一个工具的文本结果渲染成对话里的终端卡片。
 *
 * 用的是内置 shell 工具同一种卡片，所以在对话里呈现为「命令行 + 输出 + 退出码状态」。
 * 形状不符时返回 `undefined`，交回通用渲染。
 *
 * @param result - 工具结果，`content` 为展示块。
 * @returns 终端卡片视图，或 `undefined`。
 */
function terminalResult(result) {
  const block = Array.isArray(result?.content) && result.content.length === 1 ? result.content[0] : undefined
  if (block === undefined || block.type !== 'text') return undefined
  const { body, ...exit } = parseExitStatus(block.text)
  return { card: 'terminal', output: body, ...exit }
}

/**
 * 一次 SSH 调用的调用中卡片：标题是命令行本身，副标题标明走的是哪台主机。
 * @param args - 工具参数。
 * @param label - 用于副标题的动作前缀。
 * @returns 终端卡片视图。
 */
function terminalCall(title, host) {
  return { card: 'terminal', title, description: `ssh ${host ?? ''}` }
}

/**
 * 在录入前检查私钥文件，把公钥、PPK、路径不可读等问题挡在连接之前。
 * @param keyPath - 模型给出的私钥路径。
 * @returns 问题描述；可用时返回 `undefined`。
 */
async function inspectPrivateKey(keyPath) {
  const target = typeof keyPath === 'string' ? keyPath.trim() : ''
  if (target.length === 0) return 'privateKeyPath 不能为空。'
  if (/\.pub$/i.test(target)) {
    return `${target} 以 .pub 结尾，是公钥文件。公钥不能用于登录，请提供配套的私钥文件（如 id_rsa）。`
  }
  let content
  try {
    content = await readFile(target, 'utf8')
  } catch (error) {
    return `无法读取 ${target}：${error instanceof Error ? error.message : String(error)}`
  }
  const firstLine = (content.split(/\r?\n/, 1)[0] ?? '').trim()
  if (/^(ssh-rsa|ssh-ed25519|ssh-dss|ecdsa-sha2-|sk-ssh-|sk-ecdsa-)\b/.test(firstLine)) {
    return `${target} 的内容是公钥（以 ${firstLine.split(/\s+/)[0]} 开头），不能用于登录。`
  }
  if (/^PuTTY-User-Key-File/.test(firstLine)) {
    return `${target} 是 PuTTY 的 .ppk 格式，OpenSSH 无法直接使用；请先用 puttygen 导出 OpenSSH 私钥。`
  }
  if (!/PRIVATE KEY/.test(content.slice(0, 8192))) {
    return `${target} 看起来不是 OpenSSH/PEM 私钥文件。`
  }
  return undefined
}

/**
 * 列出主机时的单行摘要。
 * @param record - 主机记录。
 * @param reveal - 是否显示完整地址与账号。
 * @returns 面向模型的摘要行。
 */
function describeHost(record, reveal) {
  const endpoint = reveal ? `${record.host}:${record.port}` : `${maskHost(record.host)}:${record.port}`
  const account = reveal ? record.username : maskUser(record.username)
  const auth = record.auth?.type ?? 'agent'
  const source = typeof record.bindAddress === 'string' && record.bindAddress.length > 0 ? ` via ${record.bindAddress}` : ''
  const tags = Array.isArray(record.tags) && record.tags.length > 0 ? `  [${record.tags.join(', ')}]` : ''
  const note = typeof record.description === 'string' && record.description.length > 0 ? `  — ${record.description}` : ''
  return `- ${record.alias}  (${endpoint}, ${account}, ${auth}${source})${tags}${note}`
}

/**
 * 把一次远程执行的结果整理成模型可见的文本，保持与内置 shell 工具一致的标记风格。
 *
 * 无论是正常结束、超时还是被取消，已收到的输出都会照常呈现——中断不等于失明。
 *
 * @param result - 执行结果。
 * @returns 面向模型的文本。
 */
function renderRun(result) {
  const parts = []
  const out = result.stdout ?? ''
  const err = result.stderr ?? ''
  if (out.length > 0) parts.push(out.replace(/\n+$/, ''))
  if (err.length > 0) parts.push(`[stderr]\n${err.replace(/\n+$/, '')}`)
  if (parts.length === 0) parts.push('(no output)')
  let body = parts.join('\n')
  if (result.stdoutTruncated === true || result.stderrTruncated === true) {
    body += '\n[output truncated]'
  }
  const markers = []
  if (result.timedOut === true) markers.push('[本地客户端已按时限中断]')
  if (result.aborted === true) markers.push('[调用被取消]')
  if (result.exitCode !== 0 && result.exitCode !== null) markers.push(`[exit code: ${result.exitCode}]`)
  if (Array.isArray(result.notes)) markers.push(...result.notes)
  if (markers.length > 0) body += `\n${markers.join('\n')}`
  return body
}

/**
 * 插件入口。
 * @param ctx - 插件上下文。
 * @param config - Loader 行中的配置。
 */
export function apply(ctx, config = {}) {
  const vaultDir = typeof config.vaultDir === 'string' && config.vaultDir.length > 0
    ? config.vaultDir
    : defaultVaultDir()
  const keyProtection = config.keyProtection ?? 'dpapi'
  const connectTimeoutSec = Number.isFinite(config.connectTimeoutSec) ? config.connectTimeoutSec : 10
  const defaultTimeoutMs = Number.isFinite(config.defaultTimeoutMs) ? config.defaultTimeoutMs : DEFAULT_TIMEOUT_MS
  const maxOutputBytes = Number.isFinite(config.maxOutputBytes) ? config.maxOutputBytes : DEFAULT_MAX_OUTPUT
  const sshExecutable = config.sshExecutable ?? 'ssh'
  const scpExecutable = config.scpExecutable ?? 'scp'
  const sshConfigFile = typeof config.sshConfigFile === 'string' && config.sshConfigFile.length > 0
    ? config.sshConfigFile
    : undefined
  const revealByDefault = config.maskHostAddress === false

  const vault = new Vault({
    dir: vaultDir,
    keyProtection,
    masterPassword: config.masterPassword,
    logger: ctx.logger,
  })

  // known_hosts 默认落在保险库目录里，因此永不触碰用户的 ~/.ssh。
  const knownHostsPath = typeof config.knownHostsFile === 'string' && config.knownHostsFile.length > 0
    ? config.knownHostsFile
    : vault.knownHostsPath

  /** 本次插件实例内缓存的 askpass 路径。 */
  let askpassPath
  /** 串行化 askpass 文件的准备过程。 */
  let askpassReady

  /**
   * 惰性准备保险库目录与 askpass 辅助脚本。
   * @returns askpass 包装器的绝对路径。
   */
  const prepare = () => {
    if (askpassReady === undefined) {
      askpassReady = vault.ensureDir().then((dir) => ensureAskpass(dir)).then((p) => {
        askpassPath = p
        return p
      })
    }
    return askpassReady
  }

  /**
   * 解析一次连接需要的口令：优先使用 DSH 凭据服务中的引用，其次使用保险库内密文。
   * @param record - 主机记录。
   * @returns 口令；使用密钥或 ssh-agent 时为 `undefined`。
   */
  const resolveSecret = async (record) => {
    const storedPassword = record.auth?.type === 'password'
      && typeof record.auth.password === 'string' && record.auth.password.length > 0
      ? record.auth.password
      : undefined
    if (typeof record.credentialRef === 'string' && record.credentialRef.length > 0) {
      const credentials = ctx.get('credentials')
      if (credentials !== undefined) {
        const resolved = await credentials.resolve(record.credentialRef)
        if (resolved !== undefined) return { value: resolved.value }
      }
      // 凭据引用不可用属于「环境问题」，不该让整台主机连坐。保险库里还有口令就回退，
      // 并把回退这件事写进结果——否则它会被误读成认证失败，掩盖真正的原因。
      if (storedPassword !== undefined) {
        return {
          value: storedPassword,
          note: `主机 ${record.alias} 配置了 credentialRef=${record.credentialRef}，但该引用当前不可用`
            + (credentials === undefined ? '（当前组合没有凭据服务）' : '（尚未配置，或写入凭据文件后未重启 DSH Desktop）')
            + '；本次已回退使用保险库中保存的口令。',
        }
      }
      throw new Error(
        `主机 ${record.alias} 引用的凭据 ${record.credentialRef} 当前不可用，且保险库中没有可回退的口令。`
        + '请在 Harness 中配置该引用（新增引用需要重启 DSH Desktop），'
        + `或用 scripts/set-secret.mjs ${record.alias} 把口令写入保险库。`,
      )
    }
    if (record.auth?.type === 'password') {
      if (storedPassword === undefined) {
        throw new Error(`主机 ${record.alias} 未保存口令，且没有可用的 credentialRef。`)
      }
      return { value: storedPassword }
    }
    if (record.auth?.type === 'key' && typeof record.auth.passphrase === 'string' && record.auth.passphrase.length > 0) {
      return { value: record.auth.passphrase }
    }
    return { value: undefined }
  }

  /**
   * 解析一次 sudo 需要的口令：优先主机记录里的 sudoPassword，其次复用登录口令。
   * @param record - 主机记录。
   * @returns 口令；缺失时为 `undefined`。
   */
  const resolveSudoPassword = async (record) => {
    if (typeof record.sudoPassword === 'string' && record.sudoPassword.length > 0) return { value: record.sudoPassword }
    try {
      return await resolveSecret(record)
    } catch {
      return { value: undefined }
    }
  }

  /**
   * 取出主机记录，不存在时给出可操作的提示。
   * @param alias - 主机别名。
   * @returns 主机记录。
   */
  const requireHost = async (alias) => {
    if (typeof alias !== 'string' || alias.trim().length === 0) {
      throw new Error('必须提供主机别名 alias。')
    }
    const record = await vault.get(alias)
    if (record === undefined) {
      const known = (await vault.list()).map((h) => h.alias)
      throw new Error(
        `保险库中没有名为 ${alias} 的主机。`
        + (known.length > 0 ? `现有主机：${known.join(', ')}。` : '当前保险库为空，请先用 ssh_hosts 的 add 动作添加主机。'),
      )
    }
    return record
  }

  /**
   * 组装一次连接所需的公共参数。
   * @param record - 主机记录。
   * @param timeoutMs - 本次调用的超时；`0` 表示不限时。
   * @param bindAddress - 本次调用覆盖的出口源地址。
   * @returns 传给执行层的参数。
   */
  const connectionFor = async (record, timeoutMs, bindAddress, extraNotes) => {
    const askpass = await prepare()
    const { value: secret, note: secretNote } = await resolveSecret(record)
    return {
      record,
      secret,
      askpassPath: askpass,
      knownHostsPath,
      connectTimeoutSec,
      timeoutMs: timeoutMs === 0 ? 0 : Math.min(timeoutMs, MAX_TIMEOUT_MS),
      maxOutputBytes,
      bindAddress: bindAddress ?? record.bindAddress,
      sshConfigFile,
      sshExecutable,
      scpExecutable,
      extraNotes: [
        ...(secretNote !== undefined ? [secretNote] : []),
        ...(Array.isArray(extraNotes) ? extraNotes : []),
      ],
    }
  }

  /** 把调用方给的超时收敛到合法范围。 */
  const normalizeTimeout = (value) => {
    if (!Number.isFinite(value) || value <= 0) return defaultTimeoutMs
    return Math.min(value, MAX_TIMEOUT_MS)
  }

  /**
   * 前台执行一次命令，并在调用被取消时仍然交回已收到的输出。
   * @param spec - 连接与命令参数。
   * @param signal - 工具调用的取消信号。
   * @returns 面向模型的文本。
   */
  const runForeground = async (spec, signal) => {
    const result = await runRemote({ ...spec, signal })
    if (result.aborted) {
      const error = new Error(
        '工具调用被取消；本地 ssh 客户端已结束，但远端命令可能仍在运行。\n'
        + `取消前已收到的输出：\n${renderRun(result)}`,
      )
      error.name = 'AbortError'
      throw error
    }
    return renderRun(result)
  }

  ctx.effect(() => ctx.tools.register(textTool({
    name: 'ssh_hosts',
    description: 'Manage the encrypted SSH vault that stores host address, port, account, and password. '
      + 'Actions: list, show, add, update, remove. Passwords are never returned; addresses and accounts are '
      + 'masked unless reveal is true. Work with host aliases everywhere else — the vault is what makes them resolvable.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'show', 'add', 'update', 'remove'],
          description: 'list returns every saved host; show details one host; add creates one; update changes fields of an existing one; remove deletes it.',
        },
        alias: {
          type: 'string',
          description: 'Short name other SSH tools use to address this host. Required for show, add, update, and remove.',
        },
        host: {
          type: 'string',
          description: 'Address the SSH client connects to, such as 192.0.2.10 or a hostname. Required by add.',
        },
        port: {
          type: 'integer',
          description: 'SSH port. Defaults to 22 when omitted on add.',
        },
        username: {
          type: 'string',
          description: 'Account used to sign in. Required by add.',
        },
        password: {
          type: 'string',
          description: 'Password to store. Prefer credentialRef when the user has not already written the password in this '
            + 'conversation: a password passed here is recorded in the session log before it is encrypted. Omit for key or agent authentication.',
        },
        privateKeyPath: {
          type: 'string',
          description: 'Absolute path to a private key file on this machine. Use instead of password for key authentication. '
            + 'A .pub file or a PuTTY .ppk is rejected at save time.',
        },
        passphrase: {
          type: 'string',
          description: 'Passphrase protecting privateKeyPath, when that key is encrypted.',
        },
        credentialRef: {
          type: 'string',
          description: 'Name of a credential already configured in the Harness credential store; the password is then read from '
            + 'there at connect time and never enters the conversation. Takes precedence over password.',
        },
        sudoPassword: {
          type: 'string',
          description: 'Password used to prime sudo when a command runs with sudo=true. Set it only when the sudo password '
            + 'differs from the login password. Stored encrypted and never returned.',
        },
        shell: {
          type: 'string',
          description: 'Remote shell used to run commands: bash by default, /bin/sh for Linux hosts without bash, '
            + 'cmd or powershell for Windows targets.',
        },
        bindAddress: {
          type: 'string',
          description: 'Local address to connect from, for a host with several routes or for out-of-band management. '
            + 'Applies to every later command and transfer on this host unless a call overrides it.',
        },
        description: {
          type: 'string',
          description: 'Short human-readable note about this host, shown in list output.',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Free-form labels used to group hosts.',
        },
        reveal: {
          type: 'boolean',
          description: 'On list and show, return the full address and account instead of a mask. Passwords are never returned either way.',
        },
      },
      required: ['action'],
    },
    execute: async (args) => {
      const action = typeof args.action === 'string' ? args.action : 'list'
      const reveal = args.reveal === true || (args.reveal === undefined && revealByDefault)
      if (action === 'list') {
        const hosts = await vault.list()
        if (hosts.length === 0) {
          return `SSH vault is empty (${vaultDir}). Add a host with ssh_hosts action=add.`
        }
        return [
          `Saved SSH hosts (${hosts.length}) — credentials stay encrypted; key protection: ${await vaultKeyMode(vault)}`,
          ...hosts.map((record) => describeHost(record, reveal)),
        ].join('\n')
      }
      if (action === 'show') {
        const record = await requireHost(args.alias)
        const lines = [
          `alias: ${record.alias}`,
          `address: ${reveal ? `${record.host}:${record.port}` : `${maskHost(record.host)}:${record.port}`}`,
          `account: ${reveal ? record.username : maskUser(record.username)}`,
          `auth: ${record.auth?.type ?? 'agent'}`,
          ...(record.auth?.type === 'key' ? [`privateKey: ${record.auth.privateKeyPath}`, `keyPassphrase: ${record.auth.passphrase ? 'set' : 'none'}`] : []),
          ...(record.auth?.type === 'password' ? [`password: ${record.auth.password ? 'set (stored encrypted)' : 'missing'}`] : []),
          ...(record.credentialRef ? [`credentialRef: ${record.credentialRef}`] : []),
          ...(record.sudoPassword ? ['sudoPassword: set (stored encrypted)'] : []),
          `shell: ${record.shell ?? 'bash'}`,
          ...(record.bindAddress ? [`bindAddress: ${record.bindAddress}`] : []),
          ...(record.description ? [`description: ${record.description}`] : []),
          ...(Array.isArray(record.tags) && record.tags.length > 0 ? [`tags: ${record.tags.join(', ')}`] : []),
          `updatedAt: ${record.updatedAt ?? '(unknown)'}`,
        ]
        return lines.join('\n')
      }
      if (action === 'remove') {
        const removed = await vault.remove(args.alias)
        return removed
          ? `Removed ${args.alias} from the SSH vault. The known_hosts entry stays; delete it only if the host was rebuilt.`
          : `No host named ${args.alias} exists in the vault.`
      }
      if (action === 'add' || action === 'update') {
        if (typeof args.alias !== 'string' || args.alias.trim().length === 0) {
          throw new Error('alias is required for add and update.')
        }
        const existing = await vault.get(args.alias)
        if (action === 'add' && existing !== undefined) {
          throw new Error(`Host ${args.alias} already exists. Use action=update to change it, or pick another alias.`)
        }
        if (action === 'update' && existing === undefined) {
          throw new Error(`Host ${args.alias} does not exist. Use action=add to create it.`)
        }
        const base = existing ?? {
          alias: args.alias,
          host: undefined,
          port: 22,
          username: undefined,
          auth: { type: 'agent' },
          shell: 'bash',
        }
        const next = {
          ...base,
          alias: args.alias,
          host: args.host ?? base.host,
          port: Number.isFinite(args.port) ? args.port : base.port,
          username: args.username ?? base.username,
          shell: args.shell ?? base.shell,
          ...(args.description !== undefined ? { description: args.description } : {}),
          ...(args.tags !== undefined ? { tags: args.tags } : {}),
          ...(args.bindAddress !== undefined ? { bindAddress: args.bindAddress } : {}),
        }
        if (args.credentialRef !== undefined && args.credentialRef !== null) {
          next.credentialRef = args.credentialRef
          // 改由凭据存储提供口令后，保险库里不再保留口令副本。
          if (next.auth?.type === 'password' && next.auth.password !== undefined) {
            next.auth = { type: 'password' }
          }
        }
        if (args.sudoPassword !== undefined && args.sudoPassword !== null) {
          next.sudoPassword = args.sudoPassword
        }
        if (args.privateKeyPath !== undefined && args.privateKeyPath !== null) {
          const problem = await inspectPrivateKey(args.privateKeyPath)
          if (problem !== undefined) throw new Error(problem)
          next.auth = { type: 'key', privateKeyPath: args.privateKeyPath, ...(args.passphrase !== undefined ? { passphrase: args.passphrase } : {}) }
          delete next.credentialRef
        } else if (args.password !== undefined && args.password !== null) {
          next.auth = { type: 'password', password: args.password }
          delete next.credentialRef
        } else if (existing === undefined && args.credentialRef !== undefined) {
          next.auth = { type: 'password' }
        }
        if (typeof next.host !== 'string' || next.host.length === 0) {
          throw new Error('host is required when creating a host.')
        }
        if (typeof next.username !== 'string' || next.username.length === 0) {
          throw new Error('username is required when creating a host.')
        }
        const saved = await vault.put(next)
        return [
          `${action === 'add' ? 'Added' : 'Updated'} ${saved.alias} in the encrypted vault (key protection: ${await vaultKeyMode(vault)}).`,
          describeHost(saved, reveal),
          saved.auth?.type === 'password' && saved.auth.password === undefined && saved.credentialRef === undefined
            ? 'Warning: no password and no credentialRef is stored, so authentication will fall back to ssh-agent or a key.'
            : '',
        ].filter((line) => line.length > 0).join('\n')
      }
      throw new Error(`Unknown action ${action}.`)
    },
  })))

  ctx.effect(() => ctx.tools.register(textTool({
    name: 'ssh_run',
    terminal: true,
    presentCall: (args) => terminalCall(args.command, args.host),
    presentResult: (_args, result) => terminalResult(result),
    description: 'Run a shell command on a saved SSH host and return its stdout and stderr. '
      + 'The command runs through the remote shell named in the host record (bash by default, cmd or powershell for '
      + 'Windows targets). The connection address, account, and password come from the encrypted vault, so refer to the '
      + 'host by alias only. A non-zero remote exit is reported as an [exit code: N] marker rather than an error. '
      + 'Output received before a timeout or a cancelled call is still returned.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        host: {
          type: 'string',
          description: 'Alias of a host saved in the SSH vault.',
        },
        command: {
          type: 'string',
          description: 'Shell command to run on the remote host, written for that host\'s shell.',
        },
        run_in_background: {
          type: 'boolean',
          description: 'Run the command as a background job and return its job id immediately; read output with job_output '
            + 'and stop it with job_kill. Use this for anything that may outlive one call — firewall changes, installs, '
            + 'long scans — so an interrupted call cannot lose the result. No timeout applies.',
        },
        sudo: {
          type: 'boolean',
          description: 'Prime the remote sudo credential cache with the password stored in the vault before running the command, '
            + 'so the command can use plain `sudo ...`. The password then never enters this conversation, the command text, '
            + 'the local or remote command line, or the remote process list. Needs a stored password on the host record '
            + '(sudoPassword, or the login password). POSIX shells only.',
        },
        bindAddress: {
          type: 'string',
          description: 'Local address to connect from for this call, overriding the host record. Use it when a rule change '
            + 'may cut the default management path.',
        },
        timeoutMs: {
          type: 'number',
          description: `Timeout in milliseconds before the connection is interrupted. Defaults to ${defaultTimeoutMs}.`,
        },
        wait_for: {
          type: 'object',
          additionalProperties: false,
          required: ['path'],
          description: 'Wait for a remote condition instead of returning immediately: one call waits until the path exists, or until '
            + 'its content matches regex, then reports the matched line. Replaces `sleep` + read-the-log polling. Combine with '
            + 'run_in_background so the wait itself costs no foreground call. When wait_for is given, command may be omitted.',
          properties: {
            path: {
              type: 'string',
              description: 'Remote path to wait for.',
            },
            regex: {
              type: 'string',
              description: 'Extended regular expression the file content must match. Omit to wait only for the file to exist.',
            },
            timeoutMs: {
              type: 'number',
              description: 'How long to keep waiting, in milliseconds. Defaults to 600000.',
            },
            intervalMs: {
              type: 'number',
              description: 'Polling interval in milliseconds. Defaults to 3000.',
            },
          },
        },
        detach: {
          type: 'boolean',
          description: 'Run the command on the remote host under setsid, detached from this SSH session, with output redirected to a '
            + 'file under /tmp; returns the pid and log path immediately. Use it for upgrades, disk work, or scans that outlive one '
            + 'connection: the remote process survives a dropped link or a cancelled call, and you can inspect it later.',
        },
      },
      required: ['host'],
    },
    execute: async (args, exec) => {
      const wantsWait = args.wait_for !== undefined && args.wait_for !== null
      if (!wantsWait && (typeof args.command !== 'string' || args.command.trim().length === 0)) {
        throw new Error('command must be a non-empty string, unless wait_for is given.')
      }
      const record = await requireHost(args.host)
      const notes = []

      // 手写 `sudo -S`：提醒一次，口令其实不必进命令文本。
      if (args.sudo !== true && typeof args.command === 'string' && /sudo\s+-S/.test(args.command)) {
        notes.push('提示：命令里出现了 `sudo -S` 手写口令。改用 ssh_run 的 sudo: true——插件会从保险库取口令预置 sudo 缓存，'
          + '口令不进命令文本、不进两端命令行，也不会出现在远端 ps 里。')
      }

      let sudoPassword
      if (args.sudo === true) {
        if (shellKind(record.shell) !== 'posix') {
          throw new Error(
            `主机 ${record.alias} 的远端 shell 是 ${record.shell}，没有 sudo。`
            + 'Windows 目标请改用管理员凭据或计划任务执行特权操作。',
          )
        }
        const resolvedSudo = await resolveSudoPassword(record)
        sudoPassword = resolvedSudo.value
        if (resolvedSudo.note !== undefined) notes.push(resolvedSudo.note)
        if (typeof sudoPassword !== 'string' || sudoPassword.length === 0) {
          throw new Error(
            `主机 ${record.alias} 没有可用于 sudo 的口令：可用 ssh_hosts 的 update 传 sudoPassword，`
            + `或用 scripts/set-secret.mjs ${record.alias} --sudo 从终端录入，`
            + '也可以让该主机使用口令认证（保险库里的登录口令会被复用）。',
          )
        }
      }

      // 等待条件与远端脱离都只是「换一段远端脚本」，其余流程完全一致。
      let command = args.command
      let callTimeoutMs = normalizeTimeout(args.timeoutMs)
      if (wantsWait) {
        const waitTimeoutMs = Number.isFinite(args.wait_for.timeoutMs) ? args.wait_for.timeoutMs : 600000
        command = buildWaitScript({
          path: args.wait_for.path,
          regex: args.wait_for.regex,
          timeoutMs: waitTimeoutMs,
          intervalMs: args.wait_for.intervalMs,
        })
        // 别让调用自身的超时先于等待条件生效。
        callTimeoutMs = Math.min(waitTimeoutMs + 15000, MAX_TIMEOUT_MS)
      } else if (args.detach === true) {
        command = buildDetachScript({
          command: args.command,
          token: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
        })
      }

      if (args.run_in_background === true) {
        const registry = ctx.get('jobs')
        if (registry === undefined) {
          throw new Error(
            '后台执行不可用：当前组合没有 jobs 服务（需要 @deepseek-ai/dsh-jobs 与 @deepseek-ai/dsh-tool-jobs）。'
            + '去掉 run_in_background 并提高 timeoutMs 也能得到中断前的全部输出。',
          )
        }
        const connection = await connectionFor(record, 0, args.bindAddress, notes)
        let jobId
        try {
          jobId = registerSshJob(registry, { ...connection, command, sudoPassword }, { owner: exec.agent?.id })
        } catch (error) {
          throw new Error(
            `后台任务注册失败：${error instanceof Error ? error.message : String(error)}。`
            + '可以去掉 run_in_background 并为该命令提高 timeoutMs。',
          )
        }
        return `started background job ${jobId}\n`
          + `The command keeps running on ${record.alias}. Read newer output with job_output and stop it with job_kill.`
      }
      const connection = await connectionFor(record, callTimeoutMs, args.bindAddress, notes)
      return runForeground({ ...connection, command, sudoPassword }, exec.signal)
    },
  })))

  ctx.effect(() => ctx.tools.register(textTool({
    name: 'ssh_transfer',
    terminal: true,
    presentCall: (args) => terminalCall(
      `scp ${args.direction === 'upload' ? `${args.local} → ${args.remote}` : `${args.remote} → ${args.local}`}`,
      args.host,
    ),
    presentResult: (_args, result) => terminalResult(result),
    description: 'Copy files between this machine and a saved SSH host over SCP. '
      + 'Relative local paths resolve against the session working directory. The host is addressed by vault alias, '
      + 'and the connection address, account, and password come from the encrypted vault.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        host: {
          type: 'string',
          description: 'Alias of a host saved in the SSH vault.',
        },
        direction: {
          type: 'string',
          enum: ['upload', 'download'],
          description: 'upload sends the local path to the host; download fetches the remote path to this machine.',
        },
        local: {
          type: 'string',
          description: 'Path on this machine, absolute or relative to the session working directory.',
        },
        remote: {
          type: 'string',
          description: 'Path on the remote host, using its own path form.',
        },
        recursive: {
          type: 'boolean',
          description: 'Copy directories recursively. Required for a directory on either side.',
        },
        bindAddress: {
          type: 'string',
          description: 'Local address to connect from for this transfer, overriding the host record.',
        },
        timeoutMs: {
          type: 'number',
          description: `Timeout in milliseconds for the whole transfer. Defaults to ${defaultTimeoutMs}.`,
        },
      },
      required: ['host', 'direction', 'local', 'remote'],
    },
    execute: async (args, exec) => {
      const record = await requireHost(args.host)
      const cwd = exec.agent?.session?.header?.cwd
      const local = isAbsolute(args.local) || cwd === undefined ? args.local : resolve(cwd, args.local)
      const connection = await connectionFor(record, normalizeTimeout(args.timeoutMs), args.bindAddress)
      const result = await transferFile({
        ...connection,
        direction: args.direction,
        local,
        remote: args.remote,
        recursive: args.recursive === true,
        signal: exec.signal,
      })
      if (result.aborted) {
        throw new Error(`传输被取消；远端可能已收到部分文件。\n${result.stderr?.trim() ?? ''}`)
      }
      const verb = args.direction === 'upload' ? 'Uploaded to' : 'Downloaded from'
      const head = result.exitCode === 0
        ? `${verb} ${record.alias}: ${args.direction === 'upload' ? `${local} -> ${args.remote}` : `${args.remote} -> ${local}`}`
        : `Transfer to ${record.alias} failed`
      const detail = result.stderr?.trim()
      const notes = Array.isArray(result.notes) ? result.notes : []
      return [head, detail, ...notes].filter((line) => typeof line === 'string' && line.length > 0).join('\n')
        + (result.exitCode === 0 ? '' : `\n[exit code: ${result.exitCode}]`)
    },
  })))

  ctx.effect(() => ctx.tools.register(textTool({
    name: 'ssh_probe',
    terminal: true,
    presentCall: (args) => terminalCall(`ssh_probe ${args.host}`, args.host),
    presentResult: (_args, result) => terminalResult(result),
    description: 'Check that a saved SSH host is reachable and report what the remote system is. '
      + 'It adapts to the host record\'s shell, so it works for both Linux and Windows targets. '
      + 'Use it before the first real command on a host, or when a command fails in a way that suggests connectivity or authentication problems.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        host: {
          type: 'string',
          description: 'Alias of a host saved in the SSH vault.',
        },
        bindAddress: {
          type: 'string',
          description: 'Local address to connect from for this probe, overriding the host record.',
        },
        timeoutMs: {
          type: 'number',
          description: `Timeout in milliseconds. Defaults to ${defaultTimeoutMs}.`,
        },
      },
      required: ['host'],
    },
    execute: async (args, exec) => {
      const record = await requireHost(args.host)
      const connection = await connectionFor(record, normalizeTimeout(args.timeoutMs), args.bindAddress)
      const result = await runRemote({ ...connection, command: probeCommand(record.shell), signal: exec.signal })
      if (result.aborted) throw new Error(`探测被取消。\n${renderRun(result)}`)
      const reachable = result.exitCode === 0
      const endpoint = revealByDefault ? `${record.host}:${record.port}` : `${maskHost(record.host)}:${record.port}`
      const account = revealByDefault ? record.username : maskUser(record.username)
      const header = reachable
        ? `Connected to ${record.alias} (${endpoint}, ${account}, ${record.auth?.type ?? 'agent'}, shell ${record.shell ?? 'bash'}; vault key protection: ${await vaultKeyMode(vault)})`
        : `Could not verify ${record.alias}`
      const facts = (result.stdout ?? '')
        .split('\n')
        .map((line) => line.replace(/^##(\w+)##\s*/, (_m, key) => `${key}: `))
        .map((line) => line.replace(/^(\w+):\s*$/, ''))
        .filter((line) => line.trim().length > 0)
      return reachable
        ? [header, ...facts].join('\n')
        : [header, renderRun(result)].join('\n')
    },
  })))

  /**
   * 一次连接自检，供设置界面的「测试连接」、卡片自动体检与对话里的 `/ssh` 复用。
   * @param alias - 主机别名。
   * @param timeoutMs - 可选超时；设置页体检会传入一个短值，避免一台不通的主机挂很久。
   * @returns 归一化的探测结果。
   */
  const probeHost = async (alias, timeoutMs) => {
    try {
      const record = await requireHost(alias)
      const connection = await connectionFor(record, normalizeTimeout(timeoutMs), undefined)
      const result = await runRemote({ ...connection, command: probeCommand(record.shell) })
      if (result.exitCode === 0) {
        const facts = (result.stdout ?? '')
          .split('\n')
          .map((line) => line.replace(/^##(\w+)##\s*/, (_m, key) => `${key}: `))
          .map((line) => line.replace(/^(\w+):\s*$/, ''))
          .filter((line) => line.trim().length > 0)
        return { ok: true, detail: facts.join('\n'), notes: result.notes ?? [], exitCode: 0 }
      }
      return {
        ok: false,
        // 超时常常意味着"主机活着但 SSH 端口不通"或"地址变了"，而不是命令本身失败；
        // 退回一句 (no output) 会把这个区别抹掉，让人以为是插件的问题。
        detail: (result.stderr ?? '').trim() || (result.timedOut === true
          ? `连接在 ${normalizeTimeout(timeoutMs)}ms 内未建立：主机可能在线但 SSH 端口不通，或地址已变`
          : '(no output)'),
        notes: result.notes ?? [],
        exitCode: result.exitCode,
      }
    } catch (error) {
      return {
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
        notes: [],
        exitCode: null,
      }
    }
  }

  // —— 连通性缓存 ——
  //
  // 一次探测要真连 SSH，不能在用户敲命令时现测。缓存结果、后台定期刷新，
  // `/ssh` 的输入提示与无参输出都读这份缓存。
  /** alias -> { ok, at } */
  const healthCache = new Map()
  /** 后台体检间隔。 */
  const HEALTH_REFRESH_MS = 5 * 60 * 1000

  /**
   * 体检全部主机并写入缓存。
   * @returns 是否拿到了结果。
   */
  const refreshHealth = async () => {
    try {
      const hosts = await vault.list()
      for (const host of hosts) {
        const result = await probeHost(host.alias, SETTINGS_PROBE_TIMEOUT_MS)
        healthCache.set(host.alias, { ok: result.ok === true, at: Date.now() })
      }
      const live = new Set(hosts.map((host) => host.alias))
      for (const alias of [...healthCache.keys()]) {
        if (!live.has(alias)) healthCache.delete(alias)
      }
      return true
    } catch {
      return false
    }
  }

  // —— 设置界面的管理接口：口令经 HTTP body 提交，不进入会话日志 ——
  ctx.inject(['webServer'], (webCtx) => {
    const api = createVaultApi({ vault, vaultDir, probe: probeHost, logger: ctx.logger })
    webCtx.effect(() => webCtx.webServer.register({ kind: 'prefix', path: API_PREFIX, handler: api }))
  })

  // —— 对话里的 `/ssh <别名>` 快捷调用 ——
  ctx.inject(['commands'], (cmdCtx) => {
    /** 当前 `/hosts` 的注销句柄。 */
    let disposeSshCommand

    /**
     * 注册 `/hosts`。
     *
     * **只注册一次，绝不重注册。** `commands.register` 的 disposer 会销毁当前定义，而用户
     * 很可能正在输入这个命令的参数；定义一换，输入框手里的命令上下文就失效了——退格失灵、
     * 输入状态错乱，只能重启界面恢复。
     *
     * 代价是 `input.hint` 只能是静态文案（它没有 thunk 形态）。在线主机因此改到无参执行时
     * 列出，而不是塞进提示里。
     *
     * 命令名用 `hosts` 而不是 `ssh`：输入框是 Lexical 编辑器，普通文本节点仍受浏览器拼写
     * 检查约束，`ssh` 会被标红，而 `hosts` 是词典里的词。
     */
    disposeSshCommand = cmdCtx.commands.register({
      name: 'hosts',
      description: '列出已配置的 SSH 主机与在线状态，或探测指定主机以确认可用',
      input: { hint: '别名,别名;（逗号分隔多台，分号后内容忽略）' },
      handler: async (invocation) => {
        // 参数只认「逗号分隔 + 分号结尾」。分号之后的都是用户自己的话，直接丢弃——
        // 这样 `/hosts kali,win10; 试一下 apt update` 不会把后面的词当成主机名。
        // 中英文分号都认：中文输入法下打出来的是全角「；」。
        const head = invocation.rawInput.split(/[;；]/)[0]
        const names = head.split(',').map((part) => part.trim()).filter((part) => part.length > 0)
        const usage = '用法：`/hosts 别名,别名;备注` —— 逗号分隔多台，分号之后的内容会被忽略。'
        // 连通状态用色点表示，比 ✅❌❓ 这类勾叉问号轻，也更像状态灯。
        const dot = { ok: '🟢', fail: '🔴', unknown: '🟠' }
        try {
          if (names.length === 0) {
            const hosts = await vault.list()
            if (hosts.length === 0) {
              return { kind: 'success', text: 'SSH 保险库为空。可在「设置 → SSH 连接」中添加主机。' }
            }
            // 还没有体检结果就现测一遍；已有结果就直接用，别让无参调用白等一轮探测。
            if (healthCache.size === 0) await refreshHealth()
            const online = []
            const offline = []
            for (const record of hosts) {
              const line = `${record.alias}（${maskHost(record.host)}:${record.port}，`
                + `${maskUser(record.username)}，${record.auth?.type ?? 'agent'}）`
              const entry = healthCache.get(record.alias)
              if (entry !== undefined && entry.ok === true) online.push(dot.ok + ' ' + line)
              else offline.push(dot.fail + ' ' + line)
            }
            const sections = [online.length > 0
              ? `在线 ${online.length} 台：\n${online.join('\n')}`
              : '当前没有可达主机。']
            if (offline.length > 0) sections.push(`离线 ${offline.length} 台：\n${offline.join('\n')}`)
            sections.push(usage)
            return { kind: 'success', text: sections.join('\n\n') }
          }

          // 先剔掉不存在的别名，免得把「找不到」混进连接失败里。
          const known = new Set((await vault.list()).map((host) => host.alias))
          const unknown = names.filter((alias) => !known.has(alias))
          const lines = []
          for (const alias of names) {
            if (!known.has(alias)) continue
            const result = await probeHost(alias, SETTINGS_PROBE_TIMEOUT_MS)
            healthCache.set(alias, { ok: result.ok === true, at: Date.now() })
            if (result.ok) {
              // 多行 facts 压成一行：一台机器不该把整段对话撑满。
              const facts = result.detail.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
              lines.push(`${dot.ok} ${alias}${facts.length > 0 ? ` — ${facts.join(' · ')}` : ''}`)
            } else {
              lines.push(`${dot.fail} ${alias} — ${result.detail.split('\n')[0].trim() || '连接失败'}`)
            }
          }
          if (unknown.length > 0) lines.push(`${dot.unknown} 未找到：${unknown.join('、')}（${usage}）`)
          return { kind: 'success', text: lines.join('\n') }
        } catch (error) {
          return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
        }
      },
    })

    // 后台只刷新连通性缓存，不动命令定义。
    cmdCtx.effect(() => {
      let stopped = false
      const tick = async () => {
        if (stopped) return
        await refreshHealth()
      }
      // 首次延后几秒：别让插件激活时的启动过程被一串 SSH 握手拖住。
      const warmup = setTimeout(tick, 3000)
      const timer = setInterval(tick, HEALTH_REFRESH_MS)
      return () => {
        stopped = true
        clearTimeout(warmup)
        clearInterval(timer)
        disposeSshCommand?.()
      }
    })
  })
}

/**
 * 读取保险库当前的数据密钥保护方式，用于在结果里说明安全边界。
 * @param vault - 保险库实例。
 * @returns 保护方式名称。
 */
async function vaultKeyMode(vault) {
  try {
    await vault.list()
    return vault.keyMode ?? 'unknown'
  } catch {
    return 'unavailable'
  }
}
