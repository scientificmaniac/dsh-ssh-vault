/**
 * 单元回归：shell 翻译、八进制转义解码与失败归因。不需要真实主机。
 * 运行：node test/diagnose.mjs
 */
import { decodeOctalEscapes, diagnose, shellArgv } from '../lib/ssh.js'

let passed = 0
const failures = []

function check(name, condition, detail) {
  if (condition) {
    passed += 1
    return
  }
  failures.push(`${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

const notesFor = (stderr, timedOut = false, target = {}) => diagnose(
  { stderr, timedOut, exitCode: timedOut ? null : 255 },
  { port: 22, timeoutMs: 1000, ...target },
).join('\n')

// —— shell 翻译 ——
check('shell 默认 bash', shellArgv(undefined).join(' ') === 'bash -s', shellArgv(undefined).join(' '))
check('shell cmd', shellArgv('cmd').join(' ') === 'cmd.exe /Q', shellArgv('cmd').join(' '))
check('shell cmd.exe', shellArgv('cmd.exe').join(' ') === 'cmd.exe /Q')
check('shell powershell', shellArgv('powershell').join(' ').startsWith('powershell -NoProfile'), shellArgv('powershell').join(' '))
check('shell pwsh', shellArgv('pwsh').join(' ').startsWith('pwsh -NoProfile'))
check('shell /bin/sh', shellArgv('/bin/sh').join(' ') === '/bin/sh -s')
check('shell 自定义路径', shellArgv('/usr/bin/zsh').join(' ') === '/usr/bin/zsh -s')

// —— 八进制转义解码 ——
const escaped = String.raw`E:\\ai project\\\346\223\215\344\275\234\\id_rsa`
check('八进制还原中文', decodeOctalEscapes(escaped).includes('操作'), JSON.stringify(decodeOctalEscapes(escaped)))
const asciiPath = String.raw`C:\Windows\System32\cmd.exe`
check('八进制不动纯 ASCII', decodeOctalEscapes(asciiPath) === asciiPath)
check('八进制不动可打印转义', decodeOctalEscapes(String.raw`\101\102`) === String.raw`\101\102`)
check('八进制无转义原样', decodeOctalEscapes('plain text') === 'plain text')

// —— 本地密钥问题必须最优先 ——
const keyPermission = notesFor(
  'Warning: UNPROTECTED PRIVATE KEY FILE!\n'
  + "Permissions for 'C:\\x\\id_rsa' are too open.\n"
  + 'This private key will be ignored.\n'
  + 'root@host: Permission denied (publickey,password).',
)
check('归因 私钥权限最优先', keyPermission.split('\n')[0].includes('权限过宽'), keyPermission)
check('归因 私钥权限不误报口令', !keyPermission.includes('账号或口令不正确'))

const pubAsKey = notesFor('Load key "C:\\x\\id_rsa.pub": invalid format\nroot@host: Permission denied (publickey).')
check('归因 误用公钥', pubAsKey.includes('公钥'), pubAsKey)

// 本地密钥根本没被加载时，不应再对服务器侧下公钥结论（真实环境踩到过）。
const keyUnloaded = notesFor(
  'WARNING: UNPROTECTED PRIVATE KEY FILE!\n'
  + "Permissions for 'C:\\x\\id_rsa' are too open.\n"
  + 'This private key will be ignored.\n'
  + 'user@192.0.2.10: Permission denied (publickey,keyboard-interactive).',
  false,
  { authType: 'key' },
)
check('归因 本地密钥未加载时不误判服务器公钥', !keyUnloaded.includes('administrators_authorized_keys'), keyUnloaded)

// —— 服务器侧：区分“列举认证方式”与“公钥被拒” ——
const multiMethod = notesFor(
  'user@192.0.2.11: Permission denied (publickey,password,keyboard-interactive).',
  false,
  { authType: 'password' },
)
check('归因 多方式被拒不误报公钥', !multiMethod.includes('administrators_authorized_keys'), multiMethod)
check('归因 多方式被拒落到认证失败', multiMethod.includes('账号或口令不正确'), multiMethod)

const publickeyOnly = notesFor('root@192.0.2.10: Permission denied (publickey).', false, { authType: 'password' })
check('归因 仅 publickey 判为公钥未装', publickeyOnly.includes('administrators_authorized_keys'), publickeyOnly)

const keyDenied = notesFor(
  'user@192.0.2.10: Permission denied (publickey,keyboard-interactive).',
  false,
  { authType: 'key' },
)
check('归因 密钥认证被拒判为公钥未装', keyDenied.includes('administrators_authorized_keys'), keyDenied)

const wrongPassword = notesFor('root@192.0.2.10: Permission denied, please try again.')
check('归因 口令错误', wrongPassword.includes('账号或口令不正确'), wrongPassword)

const tooMany = notesFor('Received disconnect from 192.0.2.10: Too many authentication failures')
check('归因 尝试次数过多', tooMany.includes('IdentitiesOnly'), tooMany)

// —— 传输层 ——
const bindFailure = notesFor(
  'bind 203.0.113.7: Unknown error\nssh: connect to host 192.0.2.11 port 22: failure',
  false,
  { bindAddress: '203.0.113.7' },
)
check('归因 源地址在本机不可用', bindFailure.includes('源地址在本机不可用'), bindFailure)

const refused = notesFor('ssh: connect to host 192.0.2.10 port 2222: Connection refused')
check('归因 端口拒绝', refused.includes('拒绝连接'), refused)

const unroutable = notesFor('ssh: connect to host 192.0.2.10 port 22: Network is unreachable', false, { bindAddress: '192.0.2.150' })
check('归因 网络不可达带上源地址', unroutable.includes('192.0.2.150'), unroutable)

const reset = notesFor('kex_exchange_identification: Connection closed by remote host')
check('归因 握手被切断', reset.includes('防火墙'), reset)

const changed = notesFor('@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@')
check('归因 主机密钥变更', changed.includes('known_hosts'), changed)

const missingShell = notesFor('bash: line 1: cmd.exe: command not found')
check('归因 缺少 shell 指向 cmd/powershell', missingShell.includes('powershell'), missingShell)

// —— sudo 未取到口令：本地问题，不是认证失败 ——
const sudoNoTty = notesFor(
  "sudo: a terminal is required to read the password; either use ssh's -t option or configure an askpass helper\nsudo: 需要密码",
  false,
  { authType: 'password' },
)
check('归因 sudo 未取到口令', sudoNoTty.includes('sudo 没有取到口令'), sudoNoTty)
check('归因 sudo 指出管道退出码陷阱', sudoNoTty.includes('退出码取决于管道最后一段'), sudoNoTty)
check('归因 sudo 建议 sudo:true', sudoNoTty.includes('sudo: true'), sudoNoTty)

const timedOut = notesFor('', true)
check('归因 超时指向后台执行', timedOut.includes('run_in_background'), timedOut)

console.log(`${passed} 项通过，${failures.length} 项失败`)
for (const failure of failures) console.error(`FAIL: ${failure}`)
if (failures.length > 0) process.exit(1)
console.log('全部通过')
