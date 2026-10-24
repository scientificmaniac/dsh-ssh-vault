/**
 * dsh-ssh-vault-demo —— 给 dsh-ssh-vault 拍店面截图用的伴生插件。
 *
 * 它注册四个 `demo_ssh_*` 工具和一条 `/demo` 命令，返回的是**固定的虚构数据**：主机名、
 * 地址、账号全是编的（地址用 RFC 5737 文档段），既不连网也不读保险库。这样市场详情页
 * 的截图里不会出现任何真实内网地址或账号。
 *
 * 工具名与 section id 都与真插件错开，因此两者可以同时安装、互不覆盖：
 *   - 真插件：ssh_run / ssh_probe / ssh_transfer，section id `ssh-vault`
 *   - 本插件：demo_ssh_run / demo_ssh_probe / demo_ssh_transfer，section id `ssh-vault-demo`
 *
 * 不参与分发：`private: true`，也不在真插件的 `files` 清单里。
 */

/** 插件名（同时是 Loader 行的 id）。 */
export const name = 'ssh-vault-demo'

/** 只需要工具能力；命令单独用 ctx.inject 可选加载。 */
export const inject = ['tools']

/** 驱动这份输出的是纯虚构数据，改这里即可换演示内容。 */
const HOSTS = [
  {
    alias: 'analytics',
    address: '192.0.2.41',
    port: 22,
    user: 'ops',
    auth: 'key',
    note: 'Debian 12 · 报表与批处理',
    tags: ['prod', 'batch'],
    online: true,
  },
  {
    alias: 'staging',
    address: '192.0.2.42',
    port: 2222,
    user: 'deploy',
    auth: 'password',
    note: 'Ubuntu 22.04 · 预发布环境',
    tags: ['stage'],
    online: true,
  },
  {
    alias: 'build-runner',
    address: '192.0.2.43',
    port: 22,
    user: 'ci',
    auth: 'key',
    note: 'Alpine 3.19 · 构建节点',
    tags: ['ci'],
    online: true,
  },
  {
    alias: 'archive',
    address: '198.51.100.7',
    port: 22,
    user: 'backup',
    auth: 'key',
    note: 'Rocky 9 · 冷备存储',
    tags: ['cold'],
    online: false,
  },
  {
    alias: 'win-sandbox',
    address: '203.0.113.24',
    port: 22,
    user: 'lab',
    auth: 'key',
    note: 'Windows 10 · 隔离测试机',
    tags: ['vm', 'windows'],
    online: true,
  },
]

const PROBE_SECTION = '连接状态'
const EXEC_SECTION = '命令执行'

/** 与真插件同格式的分节标记，客户端据此把输出拆成两张卡片。 */
const sectionMark = (title, failed) => `─── ${title}:${failed ? 'fail' : 'ok'} ───`

/** 与真插件一致的终端围栏，客户端按 `console` 代码块渲染。 */
const fence = (text) => '```console\n' + text.replace(/\n+$/, '') + '\n```'

/**
 * 把一个字符串结果包装成最小可用的工具定义。
 * @param options - 工具名、描述、参数与执行函数。
 * @returns 可直接注册的工具定义。
 */
function textTool({ name: toolName, description, parameters, execute }) {
  return {
    name: toolName,
    description,
    parameters,
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    execute,
  }
}

/** 虚构的探测输出，形状对齐真插件的 probe 结果。 */
function probeText(host) {
  return fence([
    `Connected to ${host.alias} (${host.address}:${host.port}, ${host.user}, ${host.auth === 'key' ? 'key' : 'password'}; vault key protection: dpapi)`,
    `identity: ${host.user}@${host.alias}`,
    'kernel: Linux 6.1.0-18-amd64',
    'os: Debian GNU/Linux 12 (bookworm)',
    'uptime: up 12 days, 4 hours',
    `cwd: /home/${host.user}`,
  ].join('\n'))
}

/** 虚构的命令执行输出。 */
function runText(host, command) {
  const body = command.includes('uptime')
    ? ' 16:42:07 up 12 days,  4:11,  2 users,  load average: 0.18, 0.24, 0.31'
    : command.includes('df')
      ? [
          'Filesystem      Size  Used Avail Use% Mounted on',
          '/dev/sda1        48G   31G   15G  68% /',
          '/dev/sdb1       192G  104G   79G  57% /data',
        ].join('\n')
      : command.includes('systemctl')
        ? [
            '● nginx.service - A high performance web server',
            '     Loaded: loaded (/lib/systemd/system/nginx.service; enabled)',
            '     Active: active (running) since Mon 2026-10-12 08:14:03 UTC; 12 days ago',
            '   Main PID: 842 (nginx)',
            '      Tasks: 3 (limit: 4660)',
          ].join('\n')
        : `> ${command}\n(demo output)`

  return fence([`${host.alias}  $ ${command}`, body, '[exit code: 0]'].join('\n'))
}

/**
 * 演示插件入口。
 * @param ctx - Cordis 上下文。
 * @param config - Loader 传入的配置，本插件不读取。
 */
export function apply(ctx, config = {}) {
  const findHost = (alias) => HOSTS.find((host) => host.alias === alias)

  ctx.effect(() => ctx.tools.register(textTool({
    name: 'demo_ssh_hosts',
    description: 'List the demo SSH hosts. Fabricated data for storefront screenshots; nothing is contacted.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async () => {
      const lines = HOSTS.map((host) => `- ${host.alias} (${host.address}:${host.port}, ${host.user}; ${host.auth}) [${host.tags.join(', ')}] — ${host.note}`)
      return fence(['Saved SSH hosts (5) — credentials stay encrypted; key protection: dpapi', ...lines].join('\n'))
    },
  })))

  ctx.effect(() => ctx.tools.register(textTool({
    name: 'demo_ssh_probe',
    description: 'Probe a demo host and return fabricated system facts. Makes no network connection.',
    parameters: {
      type: 'object',
      properties: { host: { type: 'string', description: 'Alias of the demo host.' } },
      required: ['host'],
      additionalProperties: false,
    },
    execute: async (args) => {
      const host = findHost(args.host)
      return host === undefined ? fence(`Could not verify ${args.host}\n(unknown demo host)`) : probeText(host)
    },
  })))

  ctx.effect(() => ctx.tools.register(textTool({
    name: 'demo_ssh_run',
    description: 'Run a command on a demo host and return fabricated output. Makes no network connection.',
    parameters: {
      type: 'object',
      properties: {
        host: { type: 'string', description: 'Alias of the demo host.' },
        command: { type: 'string', description: 'Command to render as if it had run.' },
      },
      required: ['host', 'command'],
      additionalProperties: false,
    },
    execute: async (args) => {
      const host = findHost(args.host)
      return host === undefined ? fence(`Could not verify ${args.host}`) : runText(host, args.command)
    },
  })))

  ctx.effect(() => ctx.tools.register(textTool({
    name: 'demo_ssh_transfer',
    description: 'Render a fabricated scp transfer. Makes no network connection and copies nothing.',
    parameters: {
      type: 'object',
      properties: {
        host: { type: 'string', description: 'Alias of the demo host.' },
        direction: { type: 'string', enum: ['upload', 'download'] },
        local: { type: 'string', description: 'Local path shown in the header.' },
        remote: { type: 'string', description: 'Remote path shown in the header.' },
      },
      required: ['host', 'direction', 'local', 'remote'],
      additionalProperties: false,
    },
    execute: async (args) => {
      const host = findHost(args.host)
      if (host === undefined) return fence(`Could not verify ${args.host}`)
      const arrow = args.direction === 'upload' ? '->' : '<-'
      return fence([
        `${args.local} ${arrow} ${host.alias}:${args.remote}`,
        'report.tar.gz                      42%   31MB  14.2MB/s   00:02 ETA',
        'report.tar.gz                     100%   74MB  16.1MB/s   00:04',
        '[exit code: 0]',
      ].join('\n'))
    },
  })))

  ctx.inject(['commands'], (cmdCtx) => {
    cmdCtx.effect(() => cmdCtx.commands.register({
      name: 'demo',
      description: 'Render the /hosts double card with fabricated hosts, for screenshots',
      input: { hint: '别名,别名; 命令（虚构数据，不连接任何主机）' },
      handler: async () => {
        const probed = HOSTS.filter((host) => host.online).slice(0, 2)
        const probeLines = probed.map((host) => `${host.alias} — ${host.user}@${host.alias} · Linux 6.1.0-18-amd64 · up 12 days, 4 hours`)
        const execHost = probed[0]
        const execLines = [
          `${execHost.alias}  $ df -h`,
          '/dev/sda1        48G   31G   15G  68% /',
          '/dev/sdb1       192G  104G   79G  57% /data',
          '[exit code: 0]',
        ]
        return {
          kind: 'success',
          text: `${sectionMark(PROBE_SECTION, false)}\n${probeLines.join('\n')}\n\n`
            + `${sectionMark(EXEC_SECTION, false)}\n${execLines.join('\n')}`,
        }
      },
    }))
  })
}
