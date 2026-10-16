# dsh-ssh-vault · SSH 保险库

[English](README.md) | **简体中文**

> Encrypted SSH host vault for the DeepSeek Harness: the agent works with host **aliases**,
> while the address, port, account, and password stay in an AES-256-GCM vault whose key is
> wrapped by Windows DPAPI.

给 DeepSeek Harness 的 Host 插件：让智能体通过**别名**操作 SSH 主机，而把主机地址、端口、账号、口令
全部锁在一个加密保险库里。模型只看到 `vm-centos`，看不到 `192.0.2.10`，也永远拿不到口令。

典型场景：Windows 宿主机通过 SSH 管理本机虚拟机、带外管理机与 Windows 靶机。

- 零运行时依赖，只调用系统 OpenSSH 客户端
- 明文口令从不落盘：用时在内存解密，经 askpass 交给 `ssh`，用完即弃
- 失败归因分清「本地密钥问题 / 公钥未装机 / 口令错误 / 防火墙丢包」
- 长任务可远端脱离（`detach`）与条件等待（`wait_for`），不必拿 ssh 调用当轮询器

## 能力

| 工具 | 用途 |
| --- | --- |
| `ssh_hosts` | 管理保险库里的主机：`list` / `show` / `add` / `update` / `remove` |
| `ssh_run` | 在主机上执行命令；支持 `run_in_background` 后台运行与 `bindAddress` 指定出口源地址 |
| `ssh_transfer` | 通过 SCP 上传、下载文件，同样支持 `bindAddress` |
| `ssh_probe` | 连接自检，按目标的 shell 自动切换 Linux / Windows 探测命令 |

设计取向：

- **别名寻址** —— 地址、端口、账号、口令只存在于保险库中，日常调用只用别名。
- **中断不失明** —— 超时或被取消时，已经收到的输出照常返回，并说明远端可能仍在运行。
- **长命令有归宿** —— `run_in_background` 把命令交给通用后台任务，输出实时可读、随时可停。
- **失败能定位** —— 本地密钥问题、公钥未装机、口令错误、算法不兼容、防火墙丢包分别给出结论。

## 安装

包名 `dsh-ssh-vault`，bundle 行 id `ssh-vault`，装好后提供上表的 4 个工具。

### 目标机器前提

- **Windows 10 1809+ / Windows 11**，并已启用 **OpenSSH 客户端**。
  自检：`ssh -V` 应输出 `OpenSSH_for_Windows_9.x`。
  若缺失：设置 → 系统 → 可选功能 → 添加可选功能 → **OpenSSH 客户端**。
- **DSH Desktop**：需支持 `dsh.bundle.patch` 的版本（0.2.0-rc 系列已验证）。

### 方式 A：目录安装（推荐）

1. 把整个包目录拷到目标机器，例如 `D:\dsh-plugins\dsh-ssh-vault`；
2. 让智能体执行安装，或通过插件管理界面安装：

```
plugin_manager  action=install_bundle  target="D:\dsh-plugins\dsh-ssh-vault"
```

3. 让智能体执行 `ssh_hosts action=list`，能列出主机即安装成功。

### 方式 B：压缩包安装

把 `dist/` 下的 `dsh-ssh-vault-1.1.0.tgz`（或 `.zip`）拷过去，解压得到包目录后按方式 A 安装。
tgz 也可直接作为安装目标；若被拒绝，解压后用目录方式即可。

### 本机开发迭代

profile 通过 `link:` 指向本目录，改动后重新安装：

```
plugin_manager  action=install_bundle  target="E:\ai project\ssh插件"
```

> **修改源码后必须重启 DSH Desktop。** profile 的 `patchReload` 是 `live`，所以只改
> `cordis.patch.yml` 中的 `config` 会实时生效；但 `index.js` 与 `lib/*.js` 属于已加载的
> JavaScript 模块，重装 bundle（含先移除再安装）都不会替换内存中的模块代。

## 安全模型

### 磁盘上保存了什么

保险库默认位于 `%DSH_HOME%\ssh-vault`：

| 文件 | 内容 | 是否含明文机密 |
| --- | --- | --- |
| `vault.json` | 主机清单密文（AES-256-GCM，`iv` / `tag` / `data`） | 否 |
| `key.json` | 32 字节数据密钥，由 Windows DPAPI 以当前用户身份保护 | 否 |
| `known_hosts` | 主机公钥；主机名经 `HashKnownHosts` 哈希 | 否 |
| `askpass.cmd` / `askpass.js` | 口令注入辅助脚本，内容固定 | 否 |

主机地址、端口、账号、口令都在 `vault.json` 的密文里。数据密钥本身又被 DPAPI 包了一层，
因此把整个目录复制到别的机器或别的 Windows 用户下都**无法解密**。

### 密钥保护方式

由 `keyProtection` 决定，首次创建保险库时生效并在 `key.json` 中记录：

- `dpapi`（默认）—— 数据密钥由 DPAPI 保护，安全边界是「当前 Windows 用户」；
- `file` —— 数据密钥以 base64 明文写入 `key.json`，安全边界退化为文件系统权限；
- `passphrase` —— 数据密钥由 `masterPassword` 经 scrypt 派生，磁盘上不保存任何密钥材料。

若 DPAPI 不可用（例如受限沙箱禁止启动子进程），插件会降级到 `file` 并打印告警，不会静默失败。

### 口令如何到达 ssh

Windows OpenSSH 9.x 支持 `SSH_ASKPASS_REQUIRE=force`：没有终端时改用 `SSH_ASKPASS` 指定的程序索取口令。
插件据此生成 `askpass.cmd`，它把口令写到标准输出交给 `ssh`。口令**只存在于本次 `ssh` 子进程的环境变量**中，
既不出现在命令行（不会被进程列表窥见），也不落盘。

### 明确的边界

- **不防**：已经以当前 Windows 用户身份运行的恶意进程。它既能读 DPAPI 密钥，也能读进程环境。
  这是本机威胁模型的固有上限。
- **会话日志**：工具参数会写入会话记录。`ssh_hosts` 的 `password` 参数因此会在加密前先进入日志。
  若不想让口令进入对话，见上文「口令不经过对话：credentialRef」——注意那里的明文落盘代价。
- `ssh_hosts add` 的 `host` 参数同样会进入会话日志——录入动作无法回避这一点；之后的日常调用都只用别名。

## 使用

```
# 录入（口令会先进入会话日志，再加密落盘）
ssh_hosts  action=add  alias=vm-centos  host=192.0.2.10  port=22
           username=root  password=...  description="本机 CentOS 虚拟机"  tags=["vm","centos"]

# 日常：只用别名
ssh_probe  host=vm-centos
ssh_run    host=vm-centos  command="systemctl status sshd"
ssh_transfer  host=vm-centos  direction=upload  local=./dist/app.tar  remote=/tmp/app.tar
```

`ssh_hosts list` 默认对地址和账号打码（`192.168.*.*`、`r***`），只有显式 `reveal=true` 才显示完整值；
口令在任何情况下都不会被回显，`show` 只报告 `set (stored encrypted)`。

### 长命令：交给后台任务

改防火墙、装软件、跑扫描这类可能超过一次调用寿命的命令，用 `run_in_background`：

```
ssh_run  host=kali  command="iptables-restore < /root/rules.v4"  run_in_background=true
→ started background job ssh-3

job_output  job_id=ssh-3      # 读增量输出
job_kill    job_id=ssh-3      # 需要时终止
```

进程独立于工具调用运行，输出边跑边进任务缓冲。**即使调用被取消、会话被中断，或规则把当前管理连接切断，
都不会丢掉已经产生的输出**，也不会不知道远端是否还在跑。

不做后台时，前台调用即使超时或被取消，也会把已收到的输出一并返回，并注明远端可能仍在运行。

### 特权操作：sudo 不经过对话

不要写成 `echo <password> | sudo -S`——那会把口令写进工具参数、会话日志，还会出现在远端 `ps` 里。
改用 `sudo: true`：

```
ssh_run  host=kali  command="apt update && apt -y full-upgrade"  sudo=true
```

插件从保险库取出该主机的口令，通过 SSH 的**标准输入**送去预热 sudo 凭据缓存，
随后命令里的 `sudo ...` 在时间戳窗口内免密。口令因此不出现在：

- 工具参数与会话日志（调用里只有 `sudo: true`）；
- 本地命令行与 `ssh` 进程参数；
- 远程命令行与远端 `ps` 输出（口令走 stdin，不落盘）。

主机记录没有单独口令时复用登录口令；sudo 口令与登录口令不同时，用
`ssh_hosts action=update sudoPassword=...` 单独保存。预热失败会明确报出
「口令可能不是该账户的 sudo 口令，或 sudoers 要求 tty」，而不是让你猜。

> 命令里手写了 `sudo -S` 而没用 `sudo: true` 时，结果里会出现一条提示。
> 当 sudo 因拿不到口令而失败时（`a terminal is required` / `需要密码`），诊断会直接点名
> 「sudo 没有取到口令，相关命令并未执行」，并提醒**管道陷阱**——`sudo ... | grep ...` 的退出码
> 取决于管道最后一段，sudo 失败时整条命令仍可能返回 0，看起来像"输出为空"。

### 口令不经过模型：离线录入（推荐）

`ssh_hosts add password=...` 会把口令写进会话日志；`credentialRef` 避开了对话，却把口令放进明文
`%DSH_HOME%\.credentials.yaml`。**这两个代价不必二选一**——口令可以从你自己的终端直接进入加密保险库：

```powershell
cd <包目录>
node scripts/set-secret.mjs kali          # 交互式录入登录口令（不回显）
node scripts/set-secret.mjs kali --sudo   # 单独设置 sudo 口令
node scripts/set-secret.mjs kali --show   # 只看状态，不修改
```

这条通道各环节的明文位置：

| 环节 | 明文出现在哪里 |
| --- | --- |
| 录入 | 只在你自己的终端（不回显）；不经过 DSH、不经过模型、不进会话日志 |
| 存储 | `vault.json` 密文（AES-256-GCM），数据密钥由 DPAPI 保护 |
| 使用 | 连接时在**内存**解密，经 askpass 交给 `ssh`，用完即弃 |

所以**不需要**"先落到硬盘、用完再加密回去"：插件本来就是用时才解密到内存，
磁盘上任何时刻都只有密文。引入临时明文文件反而多开一个泄露窗口。

Harness 用了自定义数据目录时，运行脚本前先设 `$env:DSH_HOME`，否则脚本会去找默认的 `~/.dsh`。

### 口令不经过对话：credentialRef

让主机记录只保存**凭据名**，实际口令在连接那一刻才从 Harness 凭据存储读取：

```
# 1) 在 %DSH_HOME%\.credentials.yaml 的 refs 下加一行（或用 Harness 的凭据界面设置）
#    值务必用引号包起来：纯数字口令会被 YAML 解析成整数，含 : # @ 等字符时更是必须
refs:
  KALI_SSH_PASSWORD: "<password>"

# 2) 主机记录只留引用名；设置引用时会自动清空保险库里的口令副本
ssh_hosts  action=update  alias=kali  credentialRef=KALI_SSH_PASSWORD
```

之后模型与对话全程看不到口令，`ssh_hosts show` 只会显示 `credentialRef: ...` 与 `password: missing`。

> **两个必须知道的限制**
>
> 1. **该文件是明文 YAML。** `%DSH_HOME%\.credentials.yaml` 与 `DEEPSEEK_API_KEY` 同处，未经加密。
>    所以 credentialRef 换来的是「口令不进对话」，**不是**「口令加密落盘」——这两者互斥：
>    - 保险库 `password`：磁盘密文（AES-256-GCM + DPAPI），但录入时会经过对话；
>    - `credentialRef`：不进对话，但磁盘明文。
> 2. **provider 在启动时读取凭据。** 新增或修改 `refs` 后必须**重启 DSH Desktop** 才生效；
>    未重启时该引用不可用。
>
> **引用失效不会锁死主机。** 如果 `credentialRef` 当前不可用、而保险库里还留着口令，插件会**回退**
> 到那份口令，并在结果里明确写出「配置了 credentialRef=…，但该引用当前不可用；本次已回退使用保险库
> 中保存的口令」。这样"环境问题"不会被误读成"认证失败"，正在跑的后台任务也不会因此中断。
> 只有连可回退的口令都没有时才报错，并给出两条恢复路径。

### 长任务：远端脱离 + 条件等待

升级、扩容、扫描这类十几分钟起步的任务，用 `detach` 让命令在**远端**脱离 SSH 会话独立运行：

```
ssh_run  host=kali  command="apt -y full-upgrade"  sudo=true  detach=true
→ [dsh-ssh-vault] 已在远端后台启动：pid=6676
  [dsh-ssh-vault] 日志：/tmp/.dsh-ssh-<token>.log
  [dsh-ssh-vault] 存活查询：ps -p 6676 >/dev/null 2>&1 && echo ALIVE || echo GONE
```

本地调用一秒左右就返回，远端进程与本地连接无关——链路断开、调用被取消、代理超时，它都继续跑。
这比"本地长连接式后台"更可靠：pid 与日志留在远端，随时能回去查。

然后**不要 sleep 轮询**，用 `wait_for` 一次等到位：

```
ssh_run  host=kali  wait_for={path: "/tmp/dsh-upgrade.log", regex: "Upgrade complete", timeoutMs: 900000}
```

满足时回传匹配到的最后一行；超时以 `exit 124` 结束并说明原因。等待本身也可以丢进后台：

```
ssh_run  host=kali  wait_for={path: "/var/log/upgrade.log", regex: "complete"}  run_in_background=true
```

推荐让命令自己写结束标记，等待条件最可靠：
`command="...; echo DONE > /tmp/job.done"`，然后 `wait_for={path: "/tmp/job.done"}`。
这样「启动 + 等待」的完整流程只要两次调用，不再拿 ssh 调用当轮询器。

### 带外管理：绑定源地址

当一条规则会切断默认管理路径时，可以给主机预设一个源地址，或用调用参数临时覆盖：

```
ssh_hosts  action=update  alias=kali  bindAddress=192.0.2.150
ssh_run    host=kali  command="ip addr add 192.0.2.150/24 dev eth0"  bindAddress=192.0.2.150
```

`ssh` 走 `-b`，`scp` 走 `-o BindAddress=`。

## Windows 目标与受限环境

这一节对应用户实测踩到的坑，插件的对应行为都在这里。

### Windows 靶机把 shell 设为 cmd 或 powershell

Windows 的登录 shell 是 `cmd.exe`，POSIX 命令与多行脚本都不可用：

```
ssh_hosts  action=update  alias=win-box  shell=powershell
```

插件据此把命令经 `powershell -NoProfile -NonInteractive -Command -` 送进标准输入，`ssh_probe`
也会自动换成 `whoami` / 版本 / 启动时长这类 Windows 命令，不再对 Windows 目标误报失败。

> 实测提示：`cmd` 从管道读命令时会回显版本横幅与提示符（`Microsoft Windows [Version ...]`、
> `C:\Users\...>`），功能正确但输出偏脏；**追求干净输出请用 `powershell`**，它的自检结果
> 形如 `identity: user@WIN10` / `os: Microsoft Windows 10 Enterprise LTSC`，可直接阅读。

仍建议：**多行 PowerShell 写成 `.ps1` 上传后 `powershell -File` 执行**，把 `ssh_run` 当作传输与触发通道。
两个已知的编码坑：

- 含中文的 `.ps1` 必须是 **UTF-8 带 BOM**，否则 PowerShell 5.1 按 ANSI 解析会报 `Unexpected token`。
- 控制台中文回显乱码时，在脚本开头加 `[Console]::OutputEncoding = [Text.Encoding]::UTF8` 与 `chcp 65001`。

### 私钥：公钥不能登录，权限必须收紧

- `ssh_hosts add` 的 `privateKeyPath` 在保存时就会检查：`.pub` 公钥、PuTTY `.ppk`、非私钥文件都会**当场报错**，
  不会再让你在连接失败里猜。
- 若报 `UNPROTECTED PRIVATE KEY FILE` / `Permissions for ... are too open`，那是 ssh 客户端**自己拒绝加载密钥**，
  与服务器上的账号口令无关。插件现在会把它作为首要结论指出，而不是归因成「口令错误」。
- 受限沙箱不允许改 ACL 时，可以把私钥复制到保险库目录（`%DSH_HOME%\ssh-vault`）再指向新路径。

### Windows 管理员的 authorized_keys 位置

Windows OpenSSH 对管理员组使用 `Match Group administrators`：

```
__PROGRAMDATA__/ssh/administrators_authorized_keys
```

公钥必须装在这个文件里（且只保留 Administrators 与 SYSTEM 权限），放进用户目录的 `.ssh\authorized_keys`
不会生效。插件在收到 `Permission denied (publickey...)` 时会直接提示这一点。

### 错误信息与路径可读性

ssh 会把非 ASCII 路径转义成 `E:\\ai project\\\346\223\215\344\275\234\\id_rsa`。
插件会把这些八进制转义还原成 UTF-8，错误信息可直接阅读。

### known_hosts 与用户配置目录

插件始终使用保险库目录下的 `known_hosts`（`HashKnownHosts` 开启），**不会去写 `~/.ssh`**，
因此沙箱下不会出现 `Could not create directory 'C:\Users\...\.ssh'`。
需要时可用 `knownHostsFile` 换位置，或用 `sshConfigFile` 指定（甚至用 `none` 屏蔽）用户级 ssh 配置。

### 管道缓冲导致看不到输出

`ssh ... | grep -v ...` 这类命令的输出会留在远端管道缓冲里，命令挂起时一行都回不来。规避方式：

- 长命令改用 `run_in_background`；
- 需要实时看到过滤后的输出时，在远端加 `stdbuf -oL`（例如 `stdbuf -oL journalctl -f | grep -v cron`）；
- 拆小命令、每步一次调用，或把结果先落到远端文件再读回。

## 配置

在 profile 的 `cordis.patch.yml` 中覆盖 `ssh-vault` 行的 `config`（`config` 是整体替换，不是深合并）：

```yaml
- id: ssh-vault
  config:
    keyProtection: dpapi        # dpapi | file | passphrase
    masterPassword: ''          # 仅 passphrase 模式需要
    vaultDir: ''                # 默认 %DSH_HOME%\ssh-vault
    knownHostsFile: ''          # 默认 <vaultDir>\known_hosts
    sshConfigFile: ''           # 传给 ssh -F 的用户配置文件
    sshExecutable: ssh
    scpExecutable: scp
    connectTimeoutSec: 10
    defaultTimeoutMs: 120000
    maxOutputBytes: 200000
    maskHostAddress: true       # false 则 list/show 默认显示完整地址
```

## 故障排查

插件会把失败按**本地密钥 → 服务器认证 → 传输层**的顺序归因，只有都排除后才说「账号或口令不正确」。

- **本地私钥权限过宽 / 误用公钥 / PPK**：按上文「私钥」一节处理。
- **`Permission denied (publickey)`**：公钥没装到目标账户；Windows 管理员账户见上文。
- **`Permission denied, please try again.`**：口令错误，用 `ssh_hosts action=update` 更正。
- **`Too many authentication failures`**：客户端试了太多密钥，改用明确的口令或 `privateKeyPath`。
- **网络不可达 / 端口拒绝**：确认网段与防火墙；若设了 `bindAddress`，确认该源地址仍在网卡上
  （DHCP 续约后手工 `ip addr add` 的地址会丢）。
- **连接在握手阶段被关闭**：通常是防火墙或安全组丢包，不是认证问题。
- **主机密钥变更**（目标被重建）：删除保险库目录下 `known_hosts` 后重连。
- **远端缺少 shell**：Linux 设 `shell: /bin/sh`；Windows 设 `cmd` 或 `powershell`。
- **`key.json` 无法解密**：该密钥只能由创建它的 Windows 用户解开。主机清单可重建时，
  删除 `key.json` 与 `vault.json` 后重新录入。

## 开发自测

四个回归脚本都在 `test/`，其中只有真实主机自测需要目标；源码中不含任何地址或口令。

```powershell
# 无需主机：shell 翻译、八进制解码、失败归因
node test/diagnose.mjs
# 无需主机：ssh/scp 参数构造 + 超时与取消仍保留输出
node test/unit.mjs
# 无需主机：后台任务注册契约（kind / owner / 输出通道 / 取消）
node test/background.mjs

# 需要一台真实主机
$env:SSHVAULT_TEST_HOST = '192.0.2.10'
$env:SSHVAULT_TEST_USER = 'root'
$env:SSHVAULT_TEST_PASS = '<password>'
node test/selftest.mjs      # 加密、持久化、真实执行、错误口令、超时保留输出、源地址绑定
node test/verify-hash.mjs   # known_hosts 是否自动哈希化
```

前三个脚本在受限沙箱下会把需要启动子进程的用例标为 `SKIP`（EPERM），其余照常执行。
所有脚本都用独立临时目录，不会触碰真实保险库。
`test/` 与 `dist/` 都在 `files` 白名单之外，不会进入发布包。

## 包结构

```
package.json            bundle 清单（dsh.bundle.patch 指向 cordis.patch.yml）
cordis.patch.yml        Loader 行定义（id: ssh-vault）
index.js                插件入口与 4 个模型面向工具
lib/vault.js            AES-256-GCM 保险库 + DPAPI / scrypt 密钥保护
lib/ssh.js              OpenSSH 驱动：参数构造、askpass 注入、失败归因、等待与脱离脚本
lib/background.js       ctx.jobs 后台任务适配
scripts/set-secret.mjs  离线口令录入（不经过 DSH，也不经过模型）
locale/{zh,en}.json     插件管理界面的标题与描述
icon.svg                插件卡片图标
README.md               使用与安全说明
CHANGELOG.md            版本历史
CONTRIBUTING.md         贡献红线、代码风格与测试要求
SECURITY.md             安全边界与漏洞报告
LICENSE                 MIT
test/                   回归（前三个免主机，后三个需真实目标；不随包分发）
dist/                   分发产物 tgz / zip（不随包分发）
```

发布清单由 `package.json` 的 `files` 白名单决定，改动文件后重新打包：

```powershell
$env:npm_config_cache = "$PWD\.npm-cache"
npm pack --pack-destination dist
Remove-Item .npm-cache -Recurse -Force
```

## 贡献

欢迎 issue 与 PR。**动手前请先读 [CONTRIBUTING.md](CONTRIBUTING.md)**——
这个插件保管别人的口令、在别人的机器上执行命令，那里写了不能破的红线与测试要求。

一条命令跑全部免主机回归（CI 跑的是同一组）：

```powershell
npm test
```

真实环境回归需要自备目标，凭据全部走环境变量、源码中不含任何字面值；
需要真实主机的用例清单见 CONTRIBUTING 的「测试」一节。

变更历史见 [CHANGELOG.md](CHANGELOG.md)；安全边界与漏洞报告见 [SECURITY.md](SECURITY.md)。

## 许可

[MIT](LICENSE)
