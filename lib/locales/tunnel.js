/**
 * `lib/tunnel.js` 端口转发功能的双语文案。
 *
 * 键名统一为 `tunnel.*` 与 `probe.*`，由 `lib/i18n.js` 合并进主字典。
 * 这些句子出现在隧道建立 / 断开 / 重连的状态回执，以及 sshd 转发能力的探测结论里；
 * 中文是面向中文用户的可执行技术说明，英文按同等信息量重写，不做逐字直译。
 *
 * 约定：`{name}` 为调用方传入的插值占位符，两语言占位符集合必须一致；
 * 涉及服务端拒绝的条目（AllowTcpForwarding / PermitOpen）要给出能直接照着改的修复方向，
 * 而不是只抛一句失败原因。
 *
 * @module dsh-ssh-vault/locales/tunnel
 */

/** 隧道与转发表双语文案；`{name}` 为插值占位符。 */
export const TUNNEL_MESSAGES = {
  // 服务端关闭转发：给按用户放行 LocalForwarding 的 sshd_config 片段。
  'tunnel.forwardingDisabled': {
    zh: '服务端关闭了 TCP 转发（AllowTcpForwarding 为 no），隧道被拒绝。需要按用户放行本地转发时，'
      + '在 /etc/ssh/sshd_config 末尾追加：\n'
      + 'Match User {user}\n'
      + '    AllowTcpForwarding local\n'
      + '保存后用 sshd -t 校验并重载 sshd。这只给该账号放开 LocalForwarding（-L 本地转发），'
      + '不要全局改成 AllowTcpForwarding yes——那会对所有用户放宽转发。',
    en: 'The server has TCP forwarding disabled (AllowTcpForwarding is no), so the tunnel was refused. '
      + 'To allow local forwarding for this account only, append to the end of /etc/ssh/sshd_config:\n'
      + 'Match User {user}\n'
      + '    AllowTcpForwarding local\n'
      + 'then validate with sshd -t and reload sshd. This opens LocalForwarding (-L tunnels) for that account only; '
      + 'do not set AllowTcpForwarding yes globally, which would relax forwarding for every user.',
  },
  // 目标地址被 PermitOpen 限制。
  'tunnel.permitOpenDenied': {
    zh: '服务端用 PermitOpen 限制了转发目标（当前允许 {permitOpen}），本次目标地址不在其中。'
      + '请让管理员把需要的 destination（形如 host:port）加入 sshd_config 的 PermitOpen，或改用已有目标。',
    en: 'The server restricts forwarding targets with PermitOpen (currently allowed: {permitOpen}), and this destination is not among them. '
      + 'Ask the administrator to add the needed destination (host:port form) to the PermitOpen rule in sshd_config, or forward to an allowed target.',
  },
  // 本地监听端口被占用。
  'tunnel.portBusy': {
    zh: '本地端口 {port} 已被占用，隧道无法绑定。换一个空闲端口，或先停掉占用该端口的进程'
      + '（Windows: netstat -ano | findstr :{port}，Linux: ss -lntp | grep :{port}）。',
    en: 'Local port {port} is already in use, so the tunnel cannot bind. Pick a free port, or stop the process holding it '
      + '(Windows: netstat -ano | findstr :{port}; Linux: ss -lntp | grep :{port}).',
  },
  // 隧道建立成功。
  'tunnel.started': {
    zh: '隧道 {id} 已建立：{summary}，可从本机通过该地址访问。',
    en: 'Tunnel {id} is up: {summary}; it can be reached from this machine at that address.',
  },
  // 隧道已停止。
  'tunnel.stopped': {
    zh: '隧道 {id} 已停止，本地监听端口随之释放。',
    en: 'Tunnel {id} was stopped and its local listening port was released.',
  },
  // 没有任何隧道。
  'tunnel.none': {
    zh: '当前没有运行中的隧道。',
    en: 'No tunnels are running right now.',
  },
  // 连接断开，随后会重连。
  'tunnel.dropped': {
    zh: '隧道 {id} 的连接已断开：{detail}。插件会尝试重连；若反复断开，'
      + '检查服务端 AllowTcpForwarding / ClientAliveInterval 与中间网络设备。',
    en: 'The connection for tunnel {id} dropped: {detail}. The plugin will retry; if it keeps dropping, '
      + 'check AllowTcpForwarding / ClientAliveInterval on the server and any intermediate network devices.',
  },
  // 正在重连。
  'tunnel.reconnecting': {
    zh: '隧道 {id} 正在重连（第 {attempt} 次尝试）。',
    en: 'Tunnel {id} is reconnecting (attempt {attempt}).',
  },
  // ssh stderr 中的 administratively prohibited。
  'tunnel.adminProhibited': {
    zh: 'ssh stderr 出现 administratively prohibited：服务端主动拒绝转发，'
      + '通常是 AllowTcpForwarding 关闭或 PermitOpen 未包含目标，而不是网络不通。'
      + '按前述转发配置修复后重试。',
    en: 'ssh stderr shows "administratively prohibited": the server itself refused the forwarding, '
      + 'which usually means AllowTcpForwarding is off or PermitOpen does not include the target — not a network problem. '
      + 'Fix the forwarding configuration as described and retry.',
  },
  // 读不到 sshd 配置时的探测降级说明。
  'tunnel.probeUnavailable': {
    zh: '读不到 sshd -T 或 sshd_config（非 root、无 sudo 或文件不可读），无法预判转发是否允许。'
      + '直接尝试建立隧道，再按实际报错判断。',
    en: 'sshd -T and sshd_config could not be read (not root, no sudo, or the file is unreadable), so forwarding cannot be pre-checked. '
      + 'Try the tunnel directly and judge from the actual error.',
  },
  // 相同转发已存在。
  'tunnel.duplicate': {
    zh: '相同转发已存在（隧道 {id}），没有重复创建；用该 id 停止或复用它。',
    en: 'An identical forward already exists (tunnel {id}); nothing new was created. Stop it or reuse it by that id.',
  },

  // —— 转发能力探测 ——
  // 探测结果已写入主机元数据。
  'probe.metaSaved': {
    zh: '探测结果已写入主机 {alias} 的元数据。',
    en: 'The probe result was saved into the metadata of host {alias}.',
  },
  // 转发可用的结论。
  'probe.forwardingOn': {
    zh: 'sshd 允许 TCP 转发（AllowTcpForwarding 为 yes 或 all），隧道具备基本前提。',
    en: 'sshd allows TCP forwarding (AllowTcpForwarding is yes or all), so tunnels have their basic precondition.',
  },
  // 转发被关闭的结论。
  'probe.forwardingOff': {
    zh: 'sshd 已关闭 TCP 转发（AllowTcpForwarding 为 no），隧道会被拒绝。',
    en: 'sshd has TCP forwarding disabled (AllowTcpForwarding is no), so tunnels will be refused.',
  },
  // 无法读取 sshd 配置时的未知态。
  'probe.sshdUnavailable': {
    zh: '无法读取 sshd 配置（非 root 且没有可用的 sudo），转发能力记为未知。',
    en: 'The sshd configuration could not be read (not root and no usable sudo), so forwarding capability is recorded as unknown.',
  },
}
