/**
 * `lib/ssh.js` 诊断建议的双语文案。
 *
 * 这些句子是在 SSH/scp 失败后给用户和模型看的归因结论，键名统一为 `ssh.*`，
 * 由 `lib/i18n.js` 合并进主字典。中文与历史输出逐字一致（测试断言依赖这些用词），
 * 英文是按同样的判断顺序重写的技术说明。
 *
 * 约定：可选的补充成分（源地址、绑定地址）直接由调用方拼好再作为占位符传入，
 * 避免为标点差异再造一条键。
 *
 * @module dsh-ssh-vault/locales/ssh
 */

/** 诊断建议双语文案；`{name}` 为插值占位符。 */
export const SSH_MESSAGES = {
  'ssh.keyPermissionsTooOpen': {
    zh: '本地私钥文件权限过宽，ssh 客户端已拒绝加载它（即错误中的 UNPROTECTED PRIVATE KEY FILE），'
      + '这与服务器上的账号口令无关。Windows 下需把该文件 ACL 收紧到仅当前用户；'
      + '若所在环境不允许改 ACL，可把私钥复制到保险库目录（%DSH_HOME%\\ssh-vault）并用 ssh_hosts 的 update 指向新路径。',
    en: 'The local private key file is too permissive, so the ssh client refused to load it (the UNPROTECTED PRIVATE KEY FILE error); '
      + 'this is unrelated to the account or password on the server. On Windows, tighten the file ACL to the current user only; '
      + 'if ACL changes are not possible, copy the key into the vault directory (%DSH_HOME%\\ssh-vault) and point ssh_hosts update at the new path.',
  },
  'ssh.publicKeyAsPrivate': {
    zh: '该文件不是可用的私钥。`.pub` 是公钥，不能用于登录；'
      + '请提供不带 .pub 后缀的私钥文件（如 id_rsa）。PuTTY 的 .ppk 需先转换。',
    en: 'That file is not a usable private key. `.pub` files are public keys and cannot log in; '
      + 'provide the private key without the .pub suffix (for example id_rsa). PuTTY .ppk keys must be converted first.',
  },
  'ssh.keyUnavailable': {
    zh: '本地找不到可用的私钥或认证代理：请确认 privateKeyPath 指向的文件存在且可读。',
    en: 'No usable local private key or agent was found: check that the file privateKeyPath points at exists and is readable.',
  },
  'ssh.sudoNoPassword': {
    zh: 'sudo 没有取到口令，相关命令并未执行（错误里的 a terminal is required / 需要密码 即此）。'
      + '用 ssh_run 的 sudo: true 让插件从保险库取口令预置 sudo 缓存，不必手写 `echo <pw> | sudo -S`。'
      + '另注意管道陷阱：`sudo ... | grep ...` 的退出码取决于管道最后一段，sudo 失败时整条命令仍可能返回 0。',
    en: 'sudo did not obtain a password, so the affected commands did not run (this is the "a terminal is required" / password error). '
      + 'Use ssh_run with sudo: true so the plugin primes the sudo cache from the vault instead of writing `echo <pw> | sudo -S`. '
      + 'Watch the pipeline trap too: with `sudo ... | grep ...` the exit code comes from the last pipeline segment, so the whole command can still return 0 when sudo failed.',
  },
  'ssh.publicKeyNotInstalled': {
    zh: '服务器拒绝了公钥认证：公钥没有装到目标账户的 authorized_keys。'
      + '若目标是 Windows 且账号属于管理员组，公钥必须写入 %ProgramData%\\ssh\\administrators_authorized_keys，'
      + '而不是用户目录下的 .ssh\\authorized_keys；该文件还需仅保留 Administrators 与 SYSTEM 的权限。',
    en: 'The server rejected public-key authentication: the key is not installed in the target account\'s authorized_keys. '
      + 'On Windows, for an account in the Administrators group the key must go into %ProgramData%\\ssh\\administrators_authorized_keys '
      + 'rather than .ssh\\authorized_keys in the user profile; that file must also be restricted to Administrators and SYSTEM.',
  },
  'ssh.tooManyAuthAttempts': {
    zh: '认证尝试次数过多：客户端逐个试了太多密钥。改用明确的口令或 privateKeyPath 认证，'
      + '本插件对密钥认证已加 IdentitiesOnly=yes。',
    en: 'Too many authentication attempts: the client tried too many keys in turn. Use explicit password or privateKeyPath authentication; '
      + 'this plugin already sets IdentitiesOnly=yes for key authentication.',
  },
  'ssh.algorithmMismatch': {
    zh: '客户端与服务器没有共同的公钥签名算法（老服务器常见）。可改用口令认证。',
    en: 'The client and server share no public-key signature algorithm (common on older servers). Switch to password authentication.',
  },
  'ssh.accountLocked': {
    zh: '目标账户已被锁定。Windows 用 `net user <账号>` 查看 "Account active / Locked"，'
      + '由管理员解锁或等待锁定周期结束；Linux 用 `faillock --user <账号>` 查看与重置。'
      + '锁定期间任何凭据（含密钥）都无法登录。',
    en: 'The target account is locked. On Windows, check "Account active / Locked" with `net user <account>`, '
      + 'then have an administrator unlock it or wait for the lockout period to end; on Linux, inspect and reset it with `faillock --user <account>`. '
      + 'While locked, no credential (keys included) can log in.',
  },
  'ssh.bindUnavailable': {
    zh: '指定的源地址在本机不可用（bind 失败）{address}。请确认该地址仍在网卡上——DHCP 续约后手工 ip addr add 的地址会丢失。',
    en: 'The requested source address is not available locally (bind failed){address}. '
      + 'Check that the address is still on a network interface — an address added manually with ip addr add is lost after a DHCP renewal.',
  },
  'ssh.bindAddressSuffix': {
    zh: '：{address}',
    en: ': {address}',
  },
  'ssh.boundSuffix': {
    zh: '（当前绑定源地址 {address}）',
    en: ' (currently bound to source address {address})',
  },
  'ssh.portRefused': {
    zh: '目标端口拒绝连接：sshd 可能未运行，或端口不是 {port}。',
    en: 'The target port refused the connection: sshd may not be running, or the port is not {port}.',
  },
  'ssh.networkUnreachable': {
    zh: '网络不可达或连接被拦截：确认目标 IP 与出口网卡在同一网段{bound}，且中间设备与目标防火墙放行了该端口。',
    en: 'The network is unreachable or the connection is blocked: check that the target IP and the outbound interface are on the same subnet{bound}, '
      + 'and that intermediate devices and the target firewall allow that port.',
  },
  'ssh.handshakeClosed': {
    zh: '连接在握手阶段被对端关闭。除了防火墙或 sshd 限流，还有一种容易被漏掉的原因：'
      + '**目标账户已被锁定**——Windows OpenSSH 对锁定账号直接断开，不给认证阶段的错误。'
      + 'Windows 目标用 `net user <账号>` 看 "Account active / Locked"；Linux 用 `faillock --user <账号>`。'
      + '若近期有批量并发连接或反复失败的登录，锁定的可能性更高。',
    en: 'The peer closed the connection during the handshake. Besides a firewall or sshd rate limiting, one easily missed cause is an '
      + '**already locked target account** — Windows OpenSSH drops locked accounts without an authentication-stage error. '
      + 'On Windows, check "Account active / Locked" with `net user <account>`; on Linux use `faillock --user <account>`. '
      + 'Bulk concurrent connections or repeated failed logins make lockout more likely.',
  },
  'ssh.hostKeyChanged': {
    zh: '主机密钥与保险库中记录的不一致：可能是目标被重建。确认无误后删除保险库目录下 known_hosts 中的对应条目再重试。',
    en: 'The host key does not match the one recorded in the vault: the target may have been rebuilt. '
      + 'Once confirmed, delete the matching entry from known_hosts in the vault directory and retry.',
  },
  'ssh.hostKeyRejected': {
    zh: '主机密钥校验失败，连接已被拒绝。',
    en: 'Host key verification failed, so the connection was rejected.',
  },
  'ssh.shellMissing': {
    zh: '远端缺少指定的 shell。Linux 目标可用 /bin/sh；Windows 目标请把主机记录的 shell 设为 cmd 或 powershell。',
    en: 'The remote side lacks the configured shell. Linux targets can use /bin/sh; on Windows, set the host record\'s shell to cmd or powershell.',
  },
  'ssh.timeout': {
    zh: '连接或命令执行超过 {ms}ms 仍未结束，已中断本地客户端。'
      + '远端命令可能仍在运行——脚本类操作请改用 run_in_background，再用 job_output 读取结果。',
    en: 'The connection or command did not finish within {ms}ms, so the local client was interrupted. '
      + 'The remote command may still be running — for script-like work use run_in_background and read the result with job_output.',
  },
  'ssh.authFailed': {
    zh: '认证失败：账号或口令不正确，或该账号不允许所用认证方式。'
      + '可用 ssh_hosts 的 update 动作更正凭据。',
    en: 'Authentication failed: the account or password is wrong, or the account does not permit the authentication method used. '
      + 'Correct the credentials with ssh_hosts action "update".',
  },
  'ssh.transferPathMissing': {
    zh: '本地或远端路径不存在，或远端目录没有写权限。上传时远端父目录必须已存在；下载时本地父目录会被自动创建。',
    en: 'A local or remote path does not exist, or the remote directory is not writable. '
      + 'For uploads the remote parent directory must already exist; for downloads the local parent is created automatically.',
  },
  'ssh.sessionKilled': {
    zh: '本地 ssh 客户端以 {code} 退出（Windows 原始值 {raw}，即 0xFFFFFFFF）：它在收到远端退出状态之前就断开了。'
      + '最常见的原因是命令或外部操作终止了承载它的 SSH 会话进程——例如杀掉 sshd 会话、重启 sshd 或网络。'
      + '请先确认这条命令是否误伤了会话本身，再检查远端服务状态。',
    en: 'The local ssh client exited with {code} (raw value {raw} on Windows, i.e. 0xFFFFFFFF): it lost the connection before '
      + 'receiving a remote exit status. The most common cause is a command or an external action that killed the SSH session '
      + 'process — for example killing the sshd session, restarting sshd, or bouncing the network. Check whether this command '
      + 'hit the session itself, then check the remote service.',
  },
  'ssh.sessionKilledEmpty': {
    zh: '本次没有任何标准输出：会话在第一条产生输出的命令之前就被切断了，基本可以判定为「会话被终止」。'
      + '请检查命令里是否有 kill sshd、重启 sshd 或网络等动作；命令文本现在经 stdin 传入并 eval，不会出现在 argv 里，'
      + '`pkill -f` 也不会再误伤承载它的 shell。',
    en: 'There was no standard output at all: the session was cut before the first command that produced output, so the session '
      + 'was almost certainly terminated. Check whether the command kills sshd, restarts sshd, or bounces the network. The command '
      + 'text now arrives over stdin and is evaluated, never appearing in argv, so `pkill -f` can no longer match the shell carrying it.',
  },

  // —— sudo 提权 ——
  'sudo.needPassword': {
    zh: '主机 {alias} 的 sudo 需要密码，但保险库中没有可用的 sudo 口令，特权命令未执行。'
      + '用 ssh_hosts 的 update 动作补上 sudoPassword（口令只写入加密保险库），然后原样重试。',
    en: 'sudo on host {alias} needs a password, but the vault has no usable sudo password, so the privileged command did not run. '
      + 'Add sudoPassword with the ssh_hosts update action (it is written only to the encrypted vault), then retry the same call.',
  },
  'sudo.notInSudoers': {
    zh: '账号 {user} 不在主机 {alias} 的 sudoers 中，sudo 直接拒绝执行。'
      + '请让 root 执行 `usermod -aG wheel {user}`（Debian/Ubuntu 上换成 sudo 组），重新登录后组权限才生效。',
    en: 'Account {user} is not in the sudoers configuration on host {alias}, so sudo refused to run. '
      + 'As root, run `usermod -aG wheel {user}` (use the sudo group on Debian/Ubuntu); group membership takes effect only after a fresh login.',
  },
  'sudo.cacheExpired': {
    zh: 'sudo 缓存已失效（sudo -n 的凭证时间戳过期），本次没有以 root 执行。直接重试即可，插件会重新从保险库取口令预置缓存。',
    en: 'The sudo cache expired (the sudo -n credential timestamp is stale), so this call did not run as root. Just retry; the plugin primes the cache again from the vault password.',
  },
  'sudo.wrappedHint': {
    zh: 'sudo 已把整条命令包装成 `sudo -n bash -c \'<command>\'`，命令文本里不要再写 sudo，否则会变成 sudo sudo。',
    en: 'sudo wrapped the whole command as `sudo -n bash -c \'<command>\'`; do not add sudo inside the command text, or it becomes sudo sudo.',
  },
  'sudo.scriptMode': {
    zh: '命令含 heredoc、管道、后台任务或多行流程，已改用临时脚本以 root 执行（比 bash -c 包装更稳），执行结束后自动清理脚本。',
    en: 'The command uses a heredoc, pipeline, background job or multi-line flow, so it ran as root from a temporary script (more reliable than wrapping in bash -c); the script is cleaned up afterwards.',
  },
  'sudo.needPasswordHint': {
    zh: '修复命令：`ssh_hosts action=update alias={alias} sudoPassword=...`。口令只进加密保险库，不会出现在命令文本、两端命令行或远端 ps 里。',
    en: 'Fix it with: `ssh_hosts action=update alias={alias} sudoPassword=...`. The password goes only into the encrypted vault; it never appears in the command text, either command line, or the remote process list.',
  },
  'sudo.probeNopasswd': {
    zh: 'sudo -n 可以直接使用：该账号是 NOPASSWD，或当前会话本身就是 root，无需口令。',
    en: 'sudo -n works directly: the account is NOPASSWD, or the session is already root, so no password is needed.',
  },
  'sudo.probePassword': {
    zh: 'sudo 需要密码，保险库中的口令可用（存有 sudoPassword，或可复用登录口令）。',
    en: 'sudo requires a password, and the vault password works (a sudoPassword is stored, or the login password can be reused).',
  },
  'sudo.probeNone': {
    zh: '目标上没有 sudo，或当前账号无权使用 sudo，特权操作无法进行。',
    en: 'There is no sudo on the target, or the current account may not use it; privileged operations are unavailable.',
  },
  'sudo.nonPosix': {
    zh: '主机 {alias} 的远端 shell 是 {shell}，不是 POSIX shell（cmd/powershell），无法用 sudo 包装命令。'
      + 'Windows 目标请改用管理员凭据或计划任务执行特权操作。',
    en: 'Host {alias} runs {shell} remotely, which is not a POSIX shell (cmd/powershell), so sudo cannot wrap the command. '
      + 'On Windows, use administrator credentials or a scheduled task for privileged work.',
  },

  // —— 文件传输细节 ——
  'xfer.sudoReadStaged': {
    zh: '远端 {remote} 受权限保护：已用 sudo 把它复制到临时文件再下载，临时文件随后删除。',
    en: 'Remote {remote} is permission-protected: it was copied to a temporary file with sudo and then downloaded; the temporary file is removed afterwards.',
  },
  'xfer.sudoWriteStaged': {
    zh: '已先把文件上传到远端临时位置，再用 sudo 落到目标路径 {remote}，以免目标目录不可写。',
    en: 'The file was uploaded to a temporary remote location first and then moved into place at {remote} with sudo, so a non-writable target directory no longer blocks the transfer.',
  },
  'xfer.eolNormalized': {
    zh: '已把上传到 {remote} 的文本换行从 CRLF 规范化为 LF，避免远端脚本因多余的 \\r 报错。',
    en: 'Line endings uploaded to {remote} were normalized from CRLF to LF, so remote scripts will not fail on a stray \\r.',
  },
  'xfer.eolSkippedBinary': {
    zh: '{remote} 疑似二进制文件（含 NUL 字节），已跳过 CRLF→LF 规范化，字节内容保持原样。',
    en: '{remote} looks like a binary file (it contains NUL bytes), so CRLF-to-LF normalization was skipped and the bytes are left untouched.',
  },
  'xfer.modeApplied': {
    zh: '已把远端文件权限设为 {mode}（如 644 或 755）。',
    en: 'The remote file mode was set to {mode} (for example 644 or 755).',
  },
  'xfer.ownerApplied': {
    zh: '已把远端文件属主设为 {owner}（user:group）。',
    en: 'The remote file ownership was set to {owner} (user:group).',
  },
  'xfer.sudoFailed': {
    zh: 'sudo 中转失败：没能借 sudo 读写受保护路径，请检查 sudo 配置，或改为手动提权后重试。',
    en: 'The sudo staging step failed: the protected path could not be read or written through sudo; check the sudo configuration, or elevate manually and retry.',
  },
  'xfer.flattenNeedsRecursive': {
    zh: 'flatten 只对目录传输有意义：请同时传 recursive: true，否则只会上传或下载单个文件。',
    en: 'flatten only applies to directory transfers: pass recursive: true as well, otherwise a single file is transferred.',
  },
}
