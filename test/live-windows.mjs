/**
 * 真实环境端到端回归：保险库中的 win10 主机（Windows 10，密钥认证）。
 *
 * 凭据全部来自加密保险库（Windows DPAPI 保护），源码不含目标地址与密钥路径：
 *   - 主机记录：`vault.list()` 里 alias=win10 的记录（密钥认证）；
 *   - askpass：`ensureAskpass(vault.dir)`；known_hosts：`vault.knownHostsPath`。
 *
 * 运行：node test/live-windows.mjs
 *
 * 覆盖范围：
 *   1. 两条 Windows 执行路径的基础形态：PowerShell 走 `-EncodedCommand`，cmd 走
 *      `cmd.exe /Q /D /C <script>`（`/Q` 关回显、`/D` 关 AutoRun，脚本作为参数传入）。
 *   2. PowerShell 常用命令：输出/变量/插值/管道/过滤/排序/计数/文件与目录/复制移动删除/
 *      系统信息/日期/环境变量/JSON/try-catch。
 *   3. PowerShell 语法：单双引号、here-string、foreach 多行、if/else、哈希表、管道链。
 *   4. PowerShell 输出与退出码：exit 0/7、中文、超长截断、超时保留已产生输出。
 *   5. cmd 常用命令：echo/set/dir/type/copy/move/del/mkdir/rmdir/findstr/where/ver/
 *      whoami/hostname/管道/重定向/exit /b。
 *   6. 跨 shell 与插件契约：探测 facts 在 CRLF 下可解析、command_array 对 Windows 明确报错、
 *      多行脚本、文件上传/回读/下载。
 *
 * 约定：
 * - 逐项打印 PASS/FAIL，末尾给出「N 项通过，M 项失败」；退出码非零表示有失败项。
 * - 所有 SSH 调用严格串行（本机 OpenSSH 不支持 ControlMaster）。
 * - 无论成功还是异常，结束时都清理远端临时目录与本地临时目录。
 * - 失败项打印 exit code、stdout/stderr 前 200 字符与 notes。
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ensureAskpass, parseProbeFacts, probeCommand, runRemote, transferFile } from '../lib/ssh.js'
import { Vault, defaultVaultDir } from '../lib/vault.js'

/** 目标主机的保险库别名。 */
const ALIAS = 'win10'

let passed = 0
const failures = []
const observes = []

/**
 * 记录一条断言。
 * @param name - 用例名。
 * @param ok - 是否通过。
 * @param detail - 失败时的定位信息。
 */
function report(name, ok, detail) {
  if (ok) {
    passed += 1
    console.log(`PASS  ${name}`)
    return
  }
  failures.push(`${name}${detail === undefined ? '' : ` — ${detail}`}`)
  console.log(`FAIL  ${name}${detail === undefined ? '' : `\n      ${detail}`}`)
}

/** 记录一条不计入通过率的观察。 */
function observe(name, detail) {
  observes.push(`${name}${detail === undefined ? '' : ` — ${detail}`}`)
  console.log(`OBS   ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

/** 把 CRLF 归一成 LF，方便断言。 */
const lf = (text) => String(text ?? '').replace(/\r\n/g, '\n')

/** 失败时打印的简短形状。 */
const brief = (result) => `exit=${result.exitCode} timedOut=${result.timedOut === true} `
  + `stdout=${JSON.stringify(lf(result.stdout).slice(0, 200))} `
  + `stderr=${JSON.stringify(lf(result.stderr).slice(0, 200))} `
  + `notes=${JSON.stringify(result.notes ?? [])}`

// —— 读取保险库与连接参数 ——
const vault = new Vault({ dir: defaultVaultDir(), keyProtection: 'dpapi' })
await vault.ensureDir()
const record = (await vault.list()).find((item) => item.alias === ALIAS)
if (record === undefined) {
  console.error(`保险库里找不到别名为 ${ALIAS} 的主机，无法回归。`)
  process.exit(2)
}
if (record.auth?.type !== 'key') {
  console.error(`${ALIAS} 不是密钥认证（实际 ${record.auth?.type}），本脚本按密钥认证编写。`)
  process.exit(2)
}
const askpassPath = await ensureAskpass(vault.dir)

/** 本地临时目录，用于溢出日志与传输用例。 */
const local = await mkdtemp(path.join(os.tmpdir(), 'dsh-win-'))

const base = {
  record,
  secret: record.auth?.passphrase,
  askpassPath,
  knownHostsPath: vault.knownHostsPath,
  connectTimeoutSec: 15,
  timeoutMs: 90000,
  maxOutputBytes: 200000,
  outputBase: path.join(local, 'dump'),
}

/** 溢出落盘前缀序号：每次调用用不同前缀，避免互相覆盖。 */
let dumpSeq = 0

/** 用指定 shell 执行一条命令。 */
const run = (shell, command, extra = {}) => runRemote({
  ...base,
  record: { ...record, shell },
  command,
  outputBase: path.join(local, `dump-${++dumpSeq}`),
  ...extra,
})

const remoteBase = `C:/Users/${record.username}/AppData/Local/Temp`
const remoteDir = `${remoteBase}/dsh-win-regress`
const remoteFile = `${remoteDir}/sample.txt`
const remoteCopy = `${remoteDir}/copy.txt`
const remoteMoved = `${remoteDir}/moved.txt`
const remoteCmdFile = `${remoteDir}/cmd-echo.txt`
const remoteBig = `${remoteDir}/big.txt`
/** cmd 的 type / copy / 重定向不认正斜杠路径，单独准备一份反斜杠形式。 */
const cmdDirPath = remoteDir.replace(/\//g, '\\')
const cmdFilePath = remoteFile.replace(/\//g, '\\')
const cmdEchoPath = remoteCmdFile.replace(/\//g, '\\')
const cmdCopyPath = remoteCopy.replace(/\//g, '\\')

try {
  // ============================================================
  // A. 两条执行路径的基础形态
  // ============================================================
  const psHello = await run('powershell', 'Write-Output "ps-hello"')
  report('PowerShell 基本输出', psHello.exitCode === 0 && lf(psHello.stdout).includes('ps-hello'), brief(psHello))
  report('PowerShell 走 EncodedCommand', psHello.shellMode === 'encoded' && /encoded/.test(psHello.remoteShell ?? ''), JSON.stringify({ shellMode: psHello.shellMode, remoteShell: psHello.remoteShell }))

  const cmdHello = await run('cmd', 'echo cmd-hello')
  report('cmd 基本输出', cmdHello.exitCode === 0 && lf(cmdHello.stdout).includes('cmd-hello'), brief(cmdHello))
  report('cmd 不再出现交互 banner', !lf(cmdHello.stdout).includes('Microsoft Windows [Version'), brief(cmdHello))
  report('cmd 不再出现提示符', !/C:\\Users\\[^>]*>/.test(lf(cmdHello.stdout)), brief(cmdHello))
  report('cmd 走 /Q /D /C 参数模式', cmdHello.shellMode === 'argument' && /\/Q \/D \/C/.test(cmdHello.remoteShell ?? ''), JSON.stringify({ shellMode: cmdHello.shellMode, remoteShell: cmdHello.remoteShell }))

  // ============================================================
  // B. PowerShell 常用命令
  // ============================================================
  const psExpr = await run('powershell', '$a = 2; $b = 3; Write-Output ("sum=" + ($a + $b))')
  report('PowerShell 变量与表达式', psExpr.exitCode === 0 && lf(psExpr.stdout).includes('sum=5'), brief(psExpr))

  const psInterp = await run('powershell', 'Write-Output "user=$env:USERNAME"')
  report('PowerShell 字符串插值', psInterp.exitCode === 0 && lf(psInterp.stdout).includes(`user=${record.username}`), brief(psInterp))

  const psSingle = await run('powershell', "Write-Output 'literal=$env:USERNAME'")
  report('PowerShell 单引号不展开变量', psSingle.exitCode === 0 && lf(psSingle.stdout).includes('literal=$env:USERNAME'), brief(psSingle))

  const psPipe = await run('powershell', 'Get-Process | Select-Object -First 3 -ExpandProperty ProcessName')
  report('PowerShell 管道 + Select-Object', psPipe.exitCode === 0 && lf(psPipe.stdout).trim().split('\n').length >= 3, brief(psPipe))

  const psWhere = await run('powershell', 'Get-ChildItem C:\\Windows\\System32\\drivers\\etc | Where-Object { $_.Name -like "hosts*" } | Select-Object -ExpandProperty Name')
  report('PowerShell Where-Object 过滤', psWhere.exitCode === 0 && lf(psWhere.stdout).includes('hosts'), brief(psWhere))

  const psSort = await run('powershell', '@(3,1,2) | Sort-Object | ForEach-Object { Write-Output $_ }')
  report('PowerShell Sort-Object + ForEach-Object', psSort.exitCode === 0 && lf(psSort.stdout).replace(/\s/g, '') === '123', brief(psSort))

  const psMeasure = await run('powershell', '@(1,2,3) | Measure-Object -Sum | Select-Object -ExpandProperty Sum')
  report('PowerShell Measure-Object', psMeasure.exitCode === 0 && lf(psMeasure.stdout).includes('6'), brief(psMeasure))

  const psDir = await run('powershell', `New-Item -ItemType Directory -Force -Path "${remoteDir}" | Out-Null; Test-Path "${remoteDir}"`)
  report('PowerShell New-Item 建目录 + Test-Path', psDir.exitCode === 0 && lf(psDir.stdout).includes('True'), brief(psDir))

  const psWrite = await run('powershell', `Set-Content -Path "${remoteFile}" -Value "line1" -Encoding UTF8; Get-Content -Path "${remoteFile}"`)
  report('PowerShell Set-Content/Get-Content', psWrite.exitCode === 0 && lf(psWrite.stdout).includes('line1'), brief(psWrite))

  const psAppend = await run('powershell', `Add-Content -Path "${remoteFile}" -Value "line2" -Encoding UTF8; (Get-Content -Path "${remoteFile}").Count`)
  report('PowerShell Add-Content 追加', psAppend.exitCode === 0 && lf(psAppend.stdout).trim() === '2', brief(psAppend))

  const psCopy = await run('powershell', `Copy-Item -Path "${remoteFile}" -Destination "${remoteCopy}" -Force; Test-Path "${remoteCopy}"`)
  report('PowerShell Copy-Item', psCopy.exitCode === 0 && lf(psCopy.stdout).includes('True'), brief(psCopy))

  const psMove = await run('powershell', `Move-Item -Path "${remoteCopy}" -Destination "${remoteMoved}" -Force; Test-Path "${remoteMoved}"`)
  report('PowerShell Move-Item', psMove.exitCode === 0 && lf(psMove.stdout).includes('True'), brief(psMove))

  const psList = await run('powershell', `(Get-ChildItem -Path "${remoteDir}").Count`)
  report('PowerShell Get-ChildItem 计数', psList.exitCode === 0 && Number(lf(psList.stdout).trim()) >= 2, brief(psList))

  const psRemove = await run('powershell', `Remove-Item -Path "${remoteMoved}" -Force; Test-Path "${remoteMoved}"`)
  report('PowerShell Remove-Item', psRemove.exitCode === 0 && lf(psRemove.stdout).includes('False'), brief(psRemove))

  const psOs = await run('powershell', '(Get-CimInstance Win32_OperatingSystem).Caption')
  report('PowerShell Get-CimInstance 系统信息', psOs.exitCode === 0 && /Windows/i.test(lf(psOs.stdout)), brief(psOs))

  const psDate = await run('powershell', 'Get-Date -Format "yyyy-MM-dd"')
  report('PowerShell Get-Date 格式化', psDate.exitCode === 0 && /^\d{4}-\d{2}-\d{2}$/.test(lf(psDate.stdout).trim()), brief(psDate))

  const psEnv = await run('powershell', 'Write-Output ($env:PATH.Length -gt 0)')
  report('PowerShell 环境变量可读', psEnv.exitCode === 0 && lf(psEnv.stdout).includes('True'), brief(psEnv))

  const psJson = await run('powershell', '$o = @{name="dsh";n=2} | ConvertTo-Json -Compress; $b = $o | ConvertFrom-Json; Write-Output ("$($b.name)-$($b.n)")')
  report('PowerShell ConvertTo/From-Json', psJson.exitCode === 0 && lf(psJson.stdout).includes('dsh-2'), brief(psJson))

  const psTry = await run('powershell', 'try { Get-Item "C:\\definitely-not-here-xyz" -ErrorAction Stop } catch { Write-Output "caught" }')
  report('PowerShell try/catch 捕获错误', psTry.exitCode === 0 && lf(psTry.stdout).includes('caught'), brief(psTry))

  const psGetCommand = await run('powershell', 'if (Get-Command "powershell.exe" -ErrorAction SilentlyContinue) { Write-Output "found" }')
  report('PowerShell Get-Command 存在性判断', psGetCommand.exitCode === 0 && lf(psGetCommand.stdout).includes('found'), brief(psGetCommand))

  // ============================================================
  // C. PowerShell 多行与 here-string
  // ============================================================
  const psHereSingle = await run('powershell', 'Write-Output @\'\nline-a\nline-b\n\'@')
  report('PowerShell 单引号 here-string', psHereSingle.exitCode === 0 && lf(psHereSingle.stdout).includes('line-a') && lf(psHereSingle.stdout).includes('line-b'), brief(psHereSingle))

  const psHereDouble = await run('powershell', 'Write-Output @"\nuser=$env:USERNAME\n"@')
  report('PowerShell 双引号 here-string 展开', psHereDouble.exitCode === 0 && lf(psHereDouble.stdout).includes(`user=${record.username}`), brief(psHereDouble))

  const psForeach = await run('powershell', 'foreach ($i in @(1,2,3)) {\n  Write-Output "item-$i"\n}')
  report('PowerShell foreach 多行块', psForeach.exitCode === 0 && lf(psForeach.stdout).includes('item-1') && lf(psForeach.stdout).includes('item-3'), brief(psForeach))

  const psIfElse = await run('powershell', 'if (1 -eq 1) {\n  Write-Output "yes"\n} else {\n  Write-Output "no"\n}')
  report('PowerShell if/else 多行块', psIfElse.exitCode === 0 && lf(psIfElse.stdout).includes('yes'), brief(psIfElse))

  const psHash = await run('powershell', '$h = @{ a = 1; b = 2 }\nWrite-Output ("keys=" + $h.Count)')
  report('PowerShell 哈希表字面量', psHash.exitCode === 0 && lf(psHash.stdout).includes('keys=2'), brief(psHash))

  const psChain = await run('powershell', 'Get-ChildItem C:\\Windows | Where-Object { $_.PSIsContainer } | Select-Object -First 2 | ForEach-Object { Write-Output $_.Name }')
  report('PowerShell 多段管道链', psChain.exitCode === 0 && lf(psChain.stdout).trim().length > 0, brief(psChain))

  const psBacktick = await run('powershell', 'Write-Output "tab`there"')
  report('PowerShell 反引号转义', psBacktick.exitCode === 0 && lf(psBacktick.stdout).includes('tab\there'), brief(psBacktick))

  const psDollar = await run('powershell', "Write-Output '$(1+1) stays literal'")
  report('PowerShell 单引号内 $() 保持字面', psDollar.exitCode === 0 && lf(psDollar.stdout).includes('$(1+1)'), brief(psDollar))

  // ============================================================
  // D. PowerShell 输出与退出码
  // ============================================================
  const psExit0 = await run('powershell', 'Write-Output "ok"; exit 0')
  report('PowerShell exit 0', psExit0.exitCode === 0, brief(psExit0))

  const psExit7 = await run('powershell', 'Write-Output "before"; exit 7')
  report('PowerShell exit 7 回传退出码', psExit7.exitCode === 7 && lf(psExit7.stdout).includes('before'), brief(psExit7))

  const psChinese = await run('powershell', 'Write-Output "中文输出测试"')
  report('PowerShell 中文输出', psChinese.exitCode === 0 && lf(psChinese.stdout).includes('中文输出测试'), brief(psChinese))

  const psBig = await run('powershell', '1..20000 | ForEach-Object { $_ }', { maxOutputBytes: 2000 })
  report('PowerShell 超长输出被截断', psBig.stdoutTruncated === true && psBig.stdout.length <= 2000, `truncated=${psBig.stdoutTruncated} len=${psBig.stdout.length}`)
  report('PowerShell 超长输出给出落盘路径', typeof psBig.stdoutPath === 'string' && psBig.stdoutPath.endsWith('.stdout.log'), String(psBig.stdoutPath))

  const psSlow = await run('powershell', 'Write-Output "BEFORE-SLEEP"; Start-Sleep -Seconds 30; Write-Output "AFTER-SLEEP"', { timeoutMs: 8000 })
  report('PowerShell 超时保留已产生输出', psSlow.timedOut === true && lf(psSlow.stdout).includes('BEFORE-SLEEP'), brief(psSlow))

  // ============================================================
  // E. cmd 常用命令
  // ============================================================
  const cmdMkdir = await run('cmd', `if not exist "${cmdDirPath}" mkdir "${cmdDirPath}" & echo made`)
  report('cmd mkdir 建目录', cmdMkdir.exitCode === 0 && lf(cmdMkdir.stdout).includes('made'), brief(cmdMkdir))

  const cmdEchoFile = await run('cmd', `echo cmd-content> "${cmdEchoPath}" & type "${cmdEchoPath}"`)
  report('cmd 重定向写文件 + type 读回', cmdEchoFile.exitCode === 0 && lf(cmdEchoFile.stdout).includes('cmd-content'), brief(cmdEchoFile))

  const cmdSet = await run('cmd', 'echo %USERNAME%')
  report('cmd set 变量 %USERNAME%', cmdSet.exitCode === 0 && lf(cmdSet.stdout).includes(record.username), brief(cmdSet))

  const cmdDirList = await run('cmd', `dir /b "${cmdDirPath}"`)
  report('cmd dir /b 列出目录', cmdDirList.exitCode === 0 && lf(cmdDirList.stdout).includes('cmd-echo.txt'), brief(cmdDirList))

  const cmdCopy = await run('cmd', `copy /y "${cmdFilePath}" "${cmdCopyPath}" & if exist "${cmdCopyPath}" echo copied`)
  report('cmd copy 复制文件', cmdCopy.exitCode === 0 && lf(cmdCopy.stdout).includes('copied'), brief(cmdCopy))

  const cmdFindstr = await run('cmd', `type "${cmdFilePath}" | findstr /c:"line1"`)
  report('cmd 管道 + findstr 过滤', cmdFindstr.exitCode === 0 && lf(cmdFindstr.stdout).includes('line1'), brief(cmdFindstr))

  const cmdWhere = await run('cmd', 'where powershell.exe')
  report('cmd where 定位可执行文件', cmdWhere.exitCode === 0 && /powershell\.exe/i.test(lf(cmdWhere.stdout)), brief(cmdWhere))

  const cmdVer = await run('cmd', 'ver')
  report('cmd ver 系统版本', cmdVer.exitCode === 0 && /Windows \[Version/i.test(lf(cmdVer.stdout)), brief(cmdVer))

  const cmdWhoami = await run('cmd', 'whoami')
  report('cmd whoami', cmdWhoami.exitCode === 0 && lf(cmdWhoami.stdout).trim().length > 0, brief(cmdWhoami))

  const cmdHostname = await run('cmd', 'hostname')
  report('cmd hostname', cmdHostname.exitCode === 0 && lf(cmdHostname.stdout).trim().length > 0, brief(cmdHostname))

  const cmdMulti = await run('cmd', 'echo first & echo second')
  report('cmd 多命令 & 串联', cmdMulti.exitCode === 0 && lf(cmdMulti.stdout).includes('first') && lf(cmdMulti.stdout).includes('second'), brief(cmdMulti))

  const cmdExit7 = await run('cmd', 'echo before & exit /b 7')
  report('cmd exit /b 回传退出码', cmdExit7.exitCode === 7 && lf(cmdExit7.stdout).includes('before'), brief(cmdExit7))

  // cmd 的中文限制：ssh 传来的命令行由 cmd 按**系统代码页**解析，`chcp 65001` 只影响它
  // 之后的输出，命令行里的中文在解析阶段就已经被折成 `?`。这不是插件能修的。
  const cmdChinese = await run('cmd', 'chcp 65001 >nul & echo 中文测试')
  observe('cmd 命令行中文受系统代码页限制', `stdout=${JSON.stringify(lf(cmdChinese.stdout).trim())}`)
  report('cmd 可切换代码页', cmdChinese.exitCode === 0, brief(cmdChinese))

  // 正确姿势：把中文编码进纯 ASCII 的载荷（PowerShell 的 -EncodedCommand 就是），
  // 命令行本身不含非 ASCII 字节，也就绕开了代码页解析。注意载荷里必须自己固定输出编码——
  // 插件的 powershellArgv 会加 `[Console]::OutputEncoding=UTF8`，但这里是我们手工调 powershell，
  // 不设置的话它按系统代码页输出，ssh 按 UTF-8 解码就会得到乱码。
  const chineseScript = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8\n'
    + '$ProgressPreference="SilentlyContinue"\n'
    + 'Write-Output "中文测试"'
  const chinesePayload = Buffer.from(chineseScript, 'utf16le').toString('base64')
  const cmdViaPs = await run('cmd', `powershell -NoProfile -NonInteractive -EncodedCommand ${chinesePayload}`)
  report('cmd 内嵌 PowerShell 输出中文（ASCII 载荷）',
    cmdViaPs.exitCode === 0 && lf(cmdViaPs.stdout).includes('中文测试'), brief(cmdViaPs))

  const cmdDel = await run('cmd', `del /q "${cmdCopyPath}" & if not exist "${cmdCopyPath}" echo deleted`)
  report('cmd del 删除文件', cmdDel.exitCode === 0 && lf(cmdDel.stdout).includes('deleted'), brief(cmdDel))

  // ============================================================
  // F. 探测 facts 与跨 shell 契约
  // ============================================================
  const psProbe = await run('powershell', probeCommand('powershell'))
  const psFacts = parseProbeFacts(psProbe.stdout)
  report('PowerShell 探测命令可执行', psProbe.exitCode === 0 && Boolean(psFacts.identity), brief(psProbe))
  report('PowerShell 探测 facts 可解析（CRLF）', Boolean(psFacts.kernel) || Boolean(psFacts.os), JSON.stringify(psFacts))

  const cmdProbe = await run('cmd', probeCommand('cmd'))
  const cmdFacts = parseProbeFacts(cmdProbe.stdout)
  report('cmd 探测命令可执行', cmdProbe.exitCode === 0 && Boolean(cmdFacts.identity), brief(cmdProbe))
  report('cmd 探测 facts 可解析（无 banner 污染）', Boolean(cmdFacts.identity) && !/C:\\Users\\[^>]*>/.test(cmdFacts.identity ?? ''), JSON.stringify(cmdFacts))

  // command_array 只对 POSIX 有意义：Windows 目标必须在入口拒绝，而不是拼出一条错误命令。
  let arrayError
  try {
    await run('powershell', undefined, { commandArray: ['Get-Date'] })
  } catch (error) {
    arrayError = error
  }
  report('command_array 在 PowerShell 目标上明确报错',
    arrayError instanceof Error && /POSIX/.test(arrayError.message),
    arrayError === undefined ? '没有抛错' : arrayError.message)

  // ============================================================
  // F2. 多 shell 声明：同一台主机 record.shell = 'powershell,cmd'
  // ============================================================
  const multiRecord = { ...record, shell: 'powershell,cmd' }
  const runMulti = (command, extra = {}) => runRemote({
    ...base,
    record: multiRecord,
    command,
    outputBase: path.join(local, `dump-${++dumpSeq}`),
    ...extra,
  })

  const multiDefault = await runMulti('Write-Output "multi-default"')
  report('多 shell：省略 shell 时用主 shell（powershell）',
    multiDefault.exitCode === 0 && multiDefault.shellMode === 'encoded' && lf(multiDefault.stdout).includes('multi-default'),
    JSON.stringify({ shellMode: multiDefault.shellMode, remoteShell: multiDefault.remoteShell, out: lf(multiDefault.stdout).trim() }))

  const multiCmdPick = await runMulti('echo multi-cmd', { shell: 'cmd' })
  report('多 shell：shell=cmd 走 cmd 路径',
    multiCmdPick.exitCode === 0 && multiCmdPick.shellMode === 'argument' && lf(multiCmdPick.stdout).includes('multi-cmd'),
    brief(multiCmdPick))

  const multiPsPick = await runMulti('Write-Output "multi-ps"', { shell: 'powershell' })
  report('多 shell：shell=powershell 走 powershell 路径',
    multiPsPick.exitCode === 0 && multiPsPick.shellMode === 'encoded' && lf(multiPsPick.stdout).includes('multi-ps'),
    brief(multiPsPick))

  let multiBadShell
  try {
    await runMulti('echo x', { shell: 'bash' })
  } catch (error) {
    multiBadShell = error
  }
  report('多 shell：未声明的 shell 明确报错',
    multiBadShell instanceof Error && /bash/i.test(multiBadShell.message),
    multiBadShell === undefined ? '没有抛错' : multiBadShell.message)

  // 多行脚本（超过单行长度）仍应完整执行：powershell 走 EncodedCommand 不受命令行长度限制。
  const manyLines = Array.from({ length: 40 }, (_, index) => `Write-Output "row-${index}"`).join('\n')
  const psMultiLine = await run('powershell', manyLines)
  const rowCount = lf(psMultiLine.stdout).split('\n').filter((line) => line.startsWith('row-')).length
  report('PowerShell 40 行脚本完整执行', psMultiLine.exitCode === 0 && rowCount === 40, `rows=${rowCount} ${brief(psMultiLine)}`)

  // ============================================================
  // F3. workdir：PowerShell 可用；cmd 明确拒绝（外层 sshd 会再包一层 cmd /c "..."，cd 的引号会被拆开）
  // ============================================================
  const psWorkdir = await run('powershell', 'Write-Output (Get-Location).Path', { workdir: 'C:\\Windows\\System32' })
  report('PowerShell workdir 生效',
    psWorkdir.exitCode === 0 && lf(psWorkdir.stdout).includes('C:\\Windows\\System32'), brief(psWorkdir))

  const psBadWorkdir = await run('powershell', 'Write-Output "SHOULD_NOT_RUN"', { workdir: 'C:\\no\\such\\dir' })
  report('PowerShell workdir 不存在时失败且不执行命令',
    psBadWorkdir.exitCode !== 0 && !lf(psBadWorkdir.stdout).includes('SHOULD_NOT_RUN'), brief(psBadWorkdir))

  let cmdWorkdirError
  try {
    await run('cmd', 'cd', { workdir: 'C:\\Windows' })
  } catch (error) {
    cmdWorkdirError = error
  }
  report('cmd 目标 workdir 明确拒绝（不静默跑错目录）',
    cmdWorkdirError instanceof Error && /workdir/.test(cmdWorkdirError.message) && /PowerShell/.test(cmdWorkdirError.message),
    cmdWorkdirError === undefined ? '没有抛错' : cmdWorkdirError.message)

  // ============================================================
  // G. 文件传输
  // ============================================================
  const localUpload = path.join(local, 'upload.txt')
  await writeFile(localUpload, 'from-windows-host\n中文内容\n', 'utf8')
  const upload = await transferFile({ ...base, direction: 'upload', local: localUpload, remote: `${remoteDir}/upload.txt` })
  report('上传到 win10', upload.exitCode === 0, brief(upload))

  const readBack = await run('powershell', `Get-Content -Path "${remoteDir}/upload.txt" -Encoding UTF8`)
  report('远端内容与本地一致（含中文）',
    readBack.exitCode === 0 && lf(readBack.stdout).includes('from-windows-host') && lf(readBack.stdout).includes('中文内容'),
    brief(readBack))

  const localDownload = path.join(local, 'download.txt')
  const download = await transferFile({ ...base, direction: 'download', local: localDownload, remote: `${remoteDir}/upload.txt` })
  const downloaded = download.exitCode === 0 ? await readFile(localDownload, 'utf8') : ''
  report('从 win10 下载', download.exitCode === 0 && downloaded.includes('from-windows-host'), brief(download))
} finally {
  // 远端清理：先试 powershell，失败再试 cmd，最后都失败也不影响结论。
  for (const shell of ['powershell', 'cmd']) {
    try {
      const command = shell === 'powershell'
        ? `if (Test-Path "${remoteDir}") { Remove-Item -Path "${remoteDir}" -Recurse -Force }; Write-Output "cleaned"`
        : `if exist "${remoteDir.replace(/\//g, '\\')}" rmdir /s /q "${remoteDir.replace(/\//g, '\\')}" & echo cleaned`
      const result = await run(shell, command, { timeoutMs: 60000 })
      if (lf(result.stdout).includes('cleaned')) break
    } catch {
      // 清理失败只记录，不改变通过率。
    }
  }
  await rm(local, { recursive: true, force: true }).catch(() => undefined)
}

console.log(`\n${passed} 项通过，${failures.length} 项失败`)
if (observes.length > 0) console.log(`观察（不计入通过率）：\n${observes.map((item) => `  - ${item}`).join('\n')}`)
for (const failure of failures) console.error(`FAIL: ${failure}`)
process.exit(failures.length > 0 ? 1 : 0)
