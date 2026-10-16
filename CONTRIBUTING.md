# 贡献指南

[English](CONTRIBUTING.en.md) | **简体中文**

这个插件会**保管别人的口令**，还要在**别人的机器上执行命令**。所以它的门槛比一般小工具高：
下面第一节的红线不是风格偏好，破了就是真实泄露或真实事故。

## 一、红线（违反即拒绝）

### 1. 绝不提交凭据、私钥与真实环境信息

不要提交：私钥、口令、API key、`%DSH_HOME%` 下的任何文件、真实内网地址、真实主机名、
真实账号名、会话日志。

需要真实主机的测试**一律走环境变量**，源码里不得出现字面值：

```js
// 正确
const KALI = { host: env.LIVE_KALI_HOST, user: env.LIVE_KALI_USER, pass: env.LIVE_KALI_PASS }

// 错误
const KALI = { host: '198.51.100.7', user: 'root', pass: '123456' }
```

示例、测试数据、文档一律使用**文档专用地址**：`192.0.2.0/24`、`198.51.100.0/24`、`203.0.113.0/24`。

按下提交键之前自查：

```powershell
git status --short                 # 确认没有 id_rsa / id_rsa.pub / dist / .env
git diff --cached                  # 逐眼过一遍，尤其看有没有 IP、账号、口令
```

`.gitignore` 已排除常见项，**但那不是保证**——它挡不住一个叫 `config.local.js` 的新文件。

### 2. 口令不得进入命令行、日志或对话

这是本项目的核心设计约束。任何改动都必须维持：

| 位置 | 要求 |
| --- | --- |
| 本地 `ssh` 命令行 | 口令只能经 `SSH_ASKPASS` 环境变量传递 |
| 远端命令行与 `ps` | 口令只能走标准输入 |
| 会话日志 | 工具参数里不得出现口令，只能出现 `sudo: true` 这类开关 |
| 磁盘 | 只有 AES-256-GCM 密文；明文只允许存在于内存 |

改完执行路径后，必须能通过 `test/live.mjs` 中的「口令不出现在远端进程列表」一项。

### 3. 保持零运行时依赖

不要引入 npm 依赖。插件只调用系统 OpenSSH 客户端（`ssh` / `scp`）与 Node 内置模块。
`package.json` 里不应出现 `dependencies`。

### 4. 不擅自改动用户的 profile 或保险库

运行时只读写自己的保险库目录（`%DSH_HOME%\ssh-vault`）。
不要写 `%DSH_HOME%\.credentials.yaml`、profile 的 `package.json` 或 `cordis.patch.yml`，
也不要碰用户的 `~/.ssh`。

## 二、开发环境

- Node.js >= 20（见 `package.json` 的 `engines`）
- Windows 10 1809+ 且启用 OpenSSH 客户端（`ssh -V` 能输出版本）；Linux / macOS 原生可用
- **不需要 `npm install`**——项目零依赖

## 三、测试

### 提交前必须跑

```powershell
npm test
```

它依次执行三个**免主机**回归，CI 跑的是同一组：

```powershell
node test/diagnose.mjs     # shell 翻译、八进制解码、失败归因
node test/unit.mjs         # 参数构造、超时/取消保留输出、wait_for / detach 脚本
node test/background.mjs   # 后台任务注册契约
```

### 需要真实主机时

```powershell
$env:LIVE_KALI_HOST = '<host>'
$env:LIVE_KALI_USER = '<user>'
$env:LIVE_KALI_PASS = '<password>'
$env:LIVE_WIN_HOST  = '<host>'
$env:LIVE_WIN_USER  = '<user>'
$env:LIVE_WIN_KEY   = '<private key path>'
node test/live.mjs
node test/selftest.mjs
```

### 硬性要求

- 改动 `lib/ssh.js` 的参数构造或诊断 → **必须**补 `test/unit.mjs` / `test/diagnose.mjs` 用例
- 改动后台任务 → **必须**补 `test/background.mjs`
- 新增面向模型的行为 → 至少一条单元用例把它钉住
- **不许为了让测试通过而放宽断言**。如果新用例要求改旧断言，先在 PR 里说明旧断言为什么是错的

## 四、代码风格

格式由 [`.editorconfig`](.editorconfig) 约束，另有以下约定：

- ESM（`import` / `export`），`"type": "module"`
- 2 空格缩进、单引号、**行尾不加分号**、行宽约 120
- 导出的函数写 JSDoc（`@param` / `@returns`）；**注释用中文，标识符用英文**
- 纯函数优先：参数构造（`buildSshArgs`）、脚本生成（`buildWaitScript`、`buildDetachScript`）、
  归因（`diagnose`）都保持无副作用，这样才测得动
- 错误信息面向使用者：说清**发生了什么**与**怎么恢复**，不要只把底层错误抛出去

## 五、提交信息

采用 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/)：

```
<type>: <简短描述>

<可选正文：为什么这么改>
```

`type` 取 `feat` / `fix` / `docs` / `refactor` / `test` / `chore`。
标题用英文祈使句，正文中英文皆可。**一次提交只做一件事。**

## 六、Pull Request

1. 行为变更先开 issue 讨论，尤其是涉及权限、执行路径、存储格式的
2. 分支名 `feat/...`、`fix/...`、`docs/...`
3. PR 描述写清三件事：**改了什么、为什么、怎么验证的**
4. 命中以下任一项时，必须在描述里单独说明：
   - 新增了执行路径（口令会经过哪里）
   - 保险库格式变化（是否需要迁移，旧数据怎么办）
   - 新增工具参数（它会不会进入会话日志）
5. `npm test` 通过，且 `git diff` 里没有凭据

## 七、设计约束（架构层面）

动代码前先确认没有破坏这些：

- **别名寻址**：模型只见别名，地址与凭据由保险库提供。
  不要新增需要模型传主机名、账号或口令的参数。
- **中断不等于失明**：任何执行路径在超时或被取消时，都必须回传已经收到的输出。
- **失败要说清归因**：本地密钥问题、公钥未装机、口令错误、防火墙丢包必须能区分；
  「账号或口令不正确」只能在前几项都排除之后出现。
- **长任务不占用工具调用**：优先用 `detach`（远端脱离）与 `wait_for`（条件等待），
  不要把 `sleep` 轮询写进工具实现。
- **会话日志是唯一真相**：不新增自定义会话事件；插件状态要么能从日志重建，
  要么放进保险库或存储服务。
- **存储格式带版本号**：改动 `vault.json` / `key.json` 结构时必须升版本并能读旧数据。

## 八、项目结构

| 路径 | 职责 |
| --- | --- |
| `index.js` | 插件入口、四个模型面向工具、配置解析、凭据解析 |
| `lib/vault.js` | 加密保险库（AES-256-GCM + DPAPI / scrypt） |
| `lib/ssh.js` | OpenSSH 驱动：参数构造、askpass 注入、失败归因、等待与脱离脚本 |
| `lib/background.js` | `ctx.jobs` 后台任务适配 |
| `scripts/set-secret.mjs` | 离线口令录入（不经过 DSH，也不经过模型） |
| `test/` | 回归；前三个免主机，后三个需要真实目标 |

## 九、许可

提交贡献即表示同意以 [MIT](LICENSE) 授权。
