/**
 * 开发自测：确认连接选项会让 OpenSSH 自动写出哈希化的 known_hosts（地址不落明文）。
 *
 * 需要一台可用的 SSH 主机，通过环境变量提供：
 *   SSHVault_TEST_HOST / SSHVault_TEST_USER / SSHVault_TEST_PASS
 *   SSHVault_TEST_PORT（可选，默认 22）
 *
 * 运行：node test/verify-hash.mjs
 */
import { readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ensureAskpass, runRemote } from '../lib/ssh.js'
import { Vault } from '../lib/vault.js'

const HOST = process.env.SSHVAULT_TEST_HOST
const USER = process.env.SSHVAULT_TEST_USER
const PASS = process.env.SSHVAULT_TEST_PASS
const PORT = Number(process.env.SSHVAULT_TEST_PORT ?? 22)

if (!HOST || !USER || !PASS) {
  console.error('缺少测试目标。请先设置 SSHVault_TEST_HOST / SSHVault_TEST_USER / SSHVault_TEST_PASS。')
  process.exit(2)
}

const dir = path.join(os.tmpdir(), `sshvault-hash-${Date.now()}`)
const vault = new Vault({ dir, keyProtection: 'file' })
await vault.put({
  alias: 'probe',
  host: HOST,
  port: PORT,
  username: USER,
  auth: { type: 'password', password: PASS },
  shell: 'bash',
})

const record = await vault.get('probe')
const result = await runRemote({
  record,
  secret: record.auth.password,
  command: 'echo HASH_CHECK_OK',
  askpassPath: await ensureAskpass(dir),
  knownHostsPath: vault.knownHostsPath,
  connectTimeoutSec: 10,
  timeoutMs: 30000,
  maxOutputBytes: 10000,
})
console.log('exit =', result.exitCode, '| stdout =', JSON.stringify(result.stdout))

const known = await readFile(vault.knownHostsPath, 'utf8')
console.log('known_hosts =', JSON.stringify(known.trim()))
console.log('starts with hash marker:', known.startsWith('|1|'))
console.log('contains literal address:', known.includes(HOST))

await rm(dir, { recursive: true, force: true })
