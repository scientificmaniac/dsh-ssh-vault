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
}
