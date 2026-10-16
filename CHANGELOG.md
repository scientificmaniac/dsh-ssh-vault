# 变更记录

本文件记录所有值得注意的变更，格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [1.5.0] - 2026-10-16

真实环境验证：25 项端到端用例全通过（Kali 口令认证 + Windows 10 密钥认证）。

### 新增

- **`wait_for`**：等待远端文件出现、或内容匹配正则，一次调用等到位，命中回传匹配行，
  超时以 `exit 124` 结束。取代 `sleep + 读日志` 的轮询写法，也可配合 `run_in_background`。
- **`detach`**：用 `setsid` 让命令脱离 SSH 会话在**远端**独立运行，输出写入 `/tmp` 日志，
  立即返回 pid 与日志路径。本地断连、调用被取消都不影响远端进程，此后可随时查状态。

### 变更

- **凭据引用失效时回退**：`credentialRef` 不可用但保险库还留着口令时自动回退，并在结果里说明；
  不再让「环境问题」表现成「主机不可用」或「认证失败」。
- **sudo 诊断与提示**：识别 `a terminal is required` / `需要密码` 并点名「命令未执行」，
  同时提示管道退出码陷阱；命令里出现 `sudo -S` 而没用 `sudo: true` 时给出提示。
- **后台任务退出码语义**：本地客户端 255 明确标注为「连接层失败，远端状态不可知」，
  被取消时标注「远端是否仍在运行无法从本机判断」，不再与「命令失败」混为一谈。

### 工程化

- 新增 [`CONTRIBUTING.md`](CONTRIBUTING.md)：贡献红线（凭据、口令路径、零依赖、不碰用户环境）、
  代码风格、提交规范、PR 清单与架构约束。
- 新增 [`.editorconfig`](.editorconfig) 与 GitHub Actions CI：CI 跑免主机回归，
  并在提交里出现私网地址、私钥或 API key 时让构建直接失败。
- `npm test` 一条命令跑全部免主机回归。
- 全部示例改用 RFC 5737 文档专用地址（`192.0.2.0/24`、`198.51.100.0/24`、`203.0.113.0/24`）。

## [1.4.0] - 2026-10-16

### 新增

- **离线录入通道 `scripts/set-secret.mjs`**：口令从你自己的终端直接进入加密保险库，
  不经过 DSH、不经过模型、不进会话日志，明文不落盘，交互输入不回显。
  这解决了「口令加密」与「口令不进对话」二选一的问题——现在两个目标同时成立。
- 发布包开始包含 `scripts/`。

## [1.3.0] - 2026-10-16

### 变更

- **改用 `credentialRef` 更自然**：`ssh_hosts` 设置引用时自动清空保险库里的口令副本，让口令只有一个来源。
- **提示更准确**：凭据不可用时说明「provider 在启动时读取凭据，新增引用需要重启 DSH Desktop」，
  并给出临时恢复方式。
- 文档写明 `credentialRef` 的代价：`%DSH_HOME%\.credentials.yaml` 是**明文** YAML，
  它换来的是「不进对话」而不是「加密落盘」。

## [1.2.0] - 2026-10-16

### 新增

- **`ssh_run sudo=true`**：从保险库取口令，经 SSH 的标准输入预热 sudo 凭据缓存，
  让特权命令不再需要把口令写进对话或命令行。真实环境实测确认口令不出现在远端进程列表。
- **主机记录新增 `sudoPassword`**：sudo 口令与登录口令不同时单独保存，仍是密文。

### 变更

- 预热失败给出明确结论（口令不符 / sudoers 要求 tty），并新增单元用例锁定这些行为。

## [1.1.0] - 2026-10-16

真实环境验证（Kali 口令认证 + Windows 10 LTSC 密钥认证）：17 项端到端用例全部通过，
覆盖口令登录、密钥登录、known_hosts 哈希化、错误口令归因、超时保留输出、源地址绑定、
双向上传下载、平台自适应自检、后台任务流式输出与结算。

### 新增

- **后台执行**：`ssh_run run_in_background=true` 接入通用后台任务，输出实时可读、
  可用 `job_kill` 终止，不再限时。
- **源地址绑定**：主机记录新增 `bindAddress`，`ssh_run` / `ssh_transfer` / `ssh_probe` 均可按次覆盖，
  对应 `ssh -b` 与 `scp -o BindAddress=`。
- **Windows 目标**：`shell` 支持 `cmd` / `powershell`，`ssh_probe` 按平台切换探测命令。
- **受限环境**：新增 `knownHostsFile` / `sshConfigFile` 配置；DPAPI 不可用时明确降级告警。
- `test/unit.mjs`、`test/background.mjs`、`test/diagnose.mjs` 三个免主机回归。

### 修复

- **失败归因重写**：本地密钥权限过宽、`.pub` 误用、PPK、公钥未装机（含 Windows
  `administrators_authorized_keys`）、尝试次数过多、算法不兼容、防火墙丢包分别成条；
  「账号或口令不正确」只在排除以上原因后才出现。
- **中断不再失明**：超时或被取消时保留并返回已收到的 stdout / stderr。
- **录入即校验**：`privateKeyPath` 指向公钥、PPK 或非密钥文件时在保存阶段报错。
- **可读性**：ssh 错误里的八进制转义路径还原为 UTF-8。

## [1.0.0] - 2026-10-13

### 新增

- 首个版本：加密保险库（AES-256-GCM + Windows DPAPI）、
  `ssh_hosts` / `ssh_run` / `ssh_transfer` / `ssh_probe` 四个模型面向工具、
  基于 `SSH_ASKPASS` 的口令注入。
