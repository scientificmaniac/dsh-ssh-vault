/**
 * 开发自测：验证保险库加解密、持久化、真实 SSH 执行与错误口令诊断。
 *
 * 需要一台可用的 SSH 主机，通过环境变量提供（不写入源码）：
 *   SSHVault_TEST_HOST / SSHVault_TEST_USER / SSHVault_TEST_PASS
 *   SSHVault_TEST_PORT（可选，默认 22）
 *
 * 运行：node test/selftest.mjs
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

const dir = path.join(os.tmpdir(), `sshvault-selftest-${Date.now()}`)
const vault = new Vault({ dir, keyProtection: 'dpapi', logger: console })
const saved = await vault.put({
  alias: 'selftest-host',
  host: HOST,
  port: PORT,
  username: USER,
  auth: { type: 'password', password: PASS },
  description: '自测目标',
  shell: 'bash',
})
console.log('[1] saved alias =', saved.alias, '| keyMode =', vault.keyMode)

console.log('[2] reopen with a fresh instance ->', (await new Vault({ dir }).list()).length, 'host(s)')

const rawVault = await readFile(path.join(dir, 'vault.json'), 'utf8')
const rawKey = await readFile(path.join(dir, 'key.json'), 'utf8')
for (const needle of [HOST, PASS, USER]) {
  console.log(`[3] plaintext "${needle}" in vault.json:`, rawVault.includes(needle))
}
console.log('[3] key.json mode:', JSON.parse(rawKey).mode)

const askpass = await ensureAskpass(dir)
console.log('[4] askpass =', askpass)

const record = await vault.get('selftest-host')
const result = await runRemote({
  record,
  secret: record.auth.password,
  command: 'echo SELFTEST_OK; hostname; id -un',
  askpassPath: askpass,
  knownHostsPath: vault.knownHostsPath,
  connectTimeoutSec: 10,
  timeoutMs: 30000,
  maxOutputBytes: 100000,
})
console.log('[5] exit =', result.exitCode, '| stdout =', JSON.stringify(result.stdout), '| notes =', result.notes)

// 连接失败时 known_hosts 可能尚未生成，测试不应因此崩溃。
const known = await readFile(vault.knownHostsPath, 'utf8').catch(() => '')
console.log('[6] known_hosts hashed =', known.startsWith('|1|'), '| leaks address =', known.includes(HOST))

const failed = await runRemote({
  record: { ...record, auth: { type: 'password', password: 'wrong-password' } },
  secret: 'wrong-password',
  command: 'echo SHOULD_NOT_RUN',
  askpassPath: askpass,
  knownHostsPath: vault.knownHostsPath,
  connectTimeoutSec: 10,
  timeoutMs: 30000,
  maxOutputBytes: 100000,
})
console.log('[7] wrong password exit =', failed.exitCode, '| notes =', failed.notes)

// 超时后必须仍然交回已经收到的输出——中断不等于失明。
const partial = await runRemote({
  record,
  secret: record.auth.password,
  command: 'echo BEFORE_SLEEP; sleep 30; echo AFTER_SLEEP',
  askpassPath: askpass,
  knownHostsPath: vault.knownHostsPath,
  connectTimeoutSec: 10,
  timeoutMs: 5000,
  maxOutputBytes: 100000,
})
console.log('[8] timed out =', partial.timedOut, '| kept stdout =', JSON.stringify(partial.stdout))

// 绑定一个本机不存在的源地址：应当失败，以此确认 -b 真的传给了 ssh。
const badBind = await runRemote({
  record,
  secret: record.auth.password,
  command: 'echo SHOULD_NOT_RUN',
  askpassPath: askpass,
  knownHostsPath: vault.knownHostsPath,
  connectTimeoutSec: 5,
  timeoutMs: 20000,
  maxOutputBytes: 20000,
  bindAddress: '203.0.113.7',
})
console.log('[9] bad bindAddress exit =', badBind.exitCode, '| stderr =', JSON.stringify(badBind.stderr.slice(0, 160)))

const fileMode = path.join(dir, 'file-mode')
const vault2 = new Vault({ dir: fileMode, keyProtection: 'file' })
await vault2.put({ alias: 'x', host: HOST, port: PORT, username: USER, auth: { type: 'password', password: PASS } })
console.log('[10] file-protection mode =', vault2.keyMode, '| hosts =', (await vault2.list()).length)

await rm(dir, { recursive: true, force: true })
console.log('[11] cleaned up', dir)
