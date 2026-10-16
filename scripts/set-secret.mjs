#!/usr/bin/env node
/**
 * 离线口令录入通道。
 *
 * 为什么需要它：插件把口令加密保存，但**录入**这一步原本必须经过工具参数，
 * 于是口令会进入会话日志；改走 credentialRef 虽然避开了对话，落盘却是明文 YAML。
 * 这个脚本让口令从你自己的终端直接进入加密保险库——不经过 DSH、不经过模型、
 * 不进会话日志，也不在任何地方留下明文文件。
 *
 * 用法（在包目录下运行）：
 *   node scripts/set-secret.mjs <alias>            # 交互式录入登录口令（不回显）
 *   node scripts/set-secret.mjs <alias> --sudo     # 录入 sudo 专用口令
 *   node scripts/set-secret.mjs <alias> --show     # 只看状态，不修改
 *
 * 自检 DSH_HOME 与 Harness 不一致时（例如自定义数据目录），可在前面加
 *   DSH_HOME=<path>（PowerShell: $env:DSH_HOME='<path>'）。
 *
 * @module dsh-ssh-vault/set-secret
 */

import { Vault, defaultVaultDir } from '../lib/vault.js'

const argv = process.argv.slice(2)
const alias = argv.find((arg) => !arg.startsWith('--'))
const forSudo = argv.includes('--sudo')
const showOnly = argv.includes('--show')

if (alias === undefined) {
  console.error('用法: node scripts/set-secret.mjs <alias> [--sudo] [--show]')
  process.exit(2)
}

const dir = defaultVaultDir()
const vault = new Vault({ dir })
const record = await vault.get(alias)

if (record === undefined) {
  const known = (await vault.list()).map((host) => host.alias)
  console.error(`保险库中没有名为 ${alias} 的主机。${known.length > 0 ? `现有：${known.join(', ')}` : ''}`)
  console.error(`保险库位置：${dir}`)
  process.exit(1)
}

if (showOnly) {
  console.log(`alias:         ${alias}`)
  console.log(`vault:         ${dir}`)
  console.log(`auth:          ${record.auth?.type ?? 'agent'}`)
  console.log(`password:      ${record.auth?.type === 'password' && record.auth.password ? 'set' : 'missing'}`)
  console.log(`sudoPassword:  ${record.sudoPassword ? 'set' : 'missing'}`)
  console.log(`credentialRef: ${record.credentialRef ? record.credentialRef : '(none)'}`)
  if (record.credentialRef) {
    console.log('提示：该主机配置了 credentialRef，连接时会优先使用它；要改用保险库口令，')
    console.log('      可让智能体执行 ssh_hosts action=update alias=' + alias + ' credentialRef="" 。')
  }
  process.exit(0)
}

const secret = await readSecret(`请输入 ${alias} 的${forSudo ? ' sudo ' : '登录'}口令（不回显，回车确认）：`)

if (secret.length === 0) {
  console.error('口令为空，未做任何修改。')
  process.exit(1)
}

if (forSudo) {
  await vault.patch(alias, { sudoPassword: secret })
  console.log(`已把 ${alias} 的 sudo 口令加密写入保险库：${dir}`)
} else {
  await vault.patch(alias, { auth: { type: 'password', password: secret } })
  console.log(`已把 ${alias} 的登录口令加密写入保险库：${dir}`)
  if (record.credentialRef) {
    console.log(`注意：该主机仍配置了 credentialRef=${record.credentialRef}，连接时会优先使用它。`)
    console.log(`      要改用保险库口令，请让智能体执行 ssh_hosts action=update alias=${alias} credentialRef="" 。`)
  }
}

/**
 * 读取一段口令：终端下关闭回显，管道下读第一行。
 * @param question - 显示的提示语。
 * @returns 用户输入的口令。
 */
async function readSecret(question) {
  if (process.stdin.isTTY === true && typeof process.stdin.setRawMode === 'function') {
    return readHidden(question)
  }
  process.stdout.write(question)
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk
  return (raw.split(/\r?\n/)[0] ?? '').trim()
}

/**
 * 关闭回显地读一行，避免口令留在终端回滚缓冲里。
 * @param question - 显示的提示语。
 * @returns 输入的口令。
 */
function readHidden(question) {
  process.stdout.write(question)
  const stdin = process.stdin
  stdin.setRawMode(true)
  stdin.resume()
  return new Promise((resolve) => {
    let value = ''
    const onData = (chunk) => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\r' || char === '\n') {
          stdin.setRawMode(false)
          stdin.pause()
          stdin.off('data', onData)
          process.stdout.write('\n')
          resolve(value)
          return
        }
        if (char === '\u0003') {
          process.stdout.write('\n')
          process.exit(130)
        }
        if (char === '\u007f' || char === '\b') {
          value = value.slice(0, -1)
          continue
        }
        value += char
      }
    }
    stdin.on('data', onData)
  })
}
