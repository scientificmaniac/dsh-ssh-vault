/**
 * dsh-ssh-vault-demo 的浏览器半边。
 *
 * 只为一件事存在：把 dsh-ssh-vault 的三个界面（工具终端卡片、设置页、`/hosts` 双卡片）
 * 用**虚构数据**渲染出来，供市场详情页截图。因此它：
 *   - 不发起任何请求，不读保险库，不连接任何主机；
 *   - 用 `demo_ssh_*` 与 `demo` 这些独立 key 注册，不会覆盖真插件的渲染器；
 *   - 样式逐字对齐真插件（同一套 token），这样截图与真实界面无法区分。
 *
 * 零依赖、零构建：只 require 宿主提供的 'react'。
 */
window.__ModuleLoader__.load({
  id: 'dsh-ssh-vault-demo',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState } = React

    return {
      inject: ['slots'],
      apply(ctx) {
        // —— 与真插件一致的 token 与样式 ——
        const C = {
          text: 'var(--dsw-alias-label-primary, currentColor)',
          textDim: 'var(--dsw-alias-label-secondary, currentColor)',
          textDimmed: 'var(--dsw-alias-label-dimmed, currentColor)',
          border: 'var(--dsw-alias-border-l3, rgba(127,127,127,0.45))',
          borderSubtle: 'var(--dsw-alias-border-l4, rgba(127,127,127,0.28))',
          inputBg: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.10))',
          radiusSm: 'var(--dsw-radius-sm, 6px)',
          radiusMd: 'var(--dsw-radius-md, 8px)',
          surface: 'rgba(127,127,127,0.08)',
          surfaceStrong: 'rgba(127,127,127,0.14)',
          ok: 'var(--dsw-alias-state-success-primary, #2e9e5b)',
          bad: 'var(--dsw-alias-state-error-primary, #d64545)',
        }
        const MONO = 'ui-monospace, SFMono-Regular, Consolas, "Courier New", monospace'

        const T = {
          card: { border: `0.5px solid ${C.border}`, borderRadius: C.radiusMd, overflow: 'hidden', background: 'rgba(0,0,0,0.14)' },
          head: {
            display: 'flex', alignItems: 'center', gap: '8px', padding: '5px 10px',
            borderBottom: `0.5px solid ${C.borderSubtle}`, color: C.textDim,
            fontFamily: MONO, fontSize: '11.5px', lineHeight: 1.5,
          },
          headText: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: C.text },
          pre: {
            margin: 0, padding: '8px 10px', maxHeight: '320px', overflow: 'auto',
            fontFamily: MONO, fontSize: '12px', lineHeight: 1.55,
            color: C.text, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          },
          statusBadge: {
            marginLeft: 'auto', flex: 'none', padding: '0 6px', borderRadius: '999px',
            border: `0.5px solid ${C.border}`, fontSize: '10.5px', color: C.textDim,
          },
          badgeCentered: {
            position: 'absolute', left: '50%', transform: 'translateX(-50%)',
            flex: 'none', padding: '0 6px', borderRadius: '999px',
            border: `0.5px solid ${C.border}`, fontSize: '10.5px', color: C.textDim,
          },
          dotOk: { width: '7px', height: '7px', borderRadius: '50%', flex: 'none', background: C.ok },
          dotRunning: { width: '7px', height: '7px', borderRadius: '50%', flex: 'none', background: 'var(--dsw-alias-state-business-primary, #4f7cff)' },
          dotError: { width: '7px', height: '7px', borderRadius: '50%', flex: 'none', background: C.bad },
          empty: { padding: '8px 10px', color: C.textDim, fontSize: '11.5px', fontFamily: MONO },
        }

        const S = {
          page: { display: 'flex', flexDirection: 'column', gap: '14px', color: C.text, fontSize: '13px', lineHeight: 1.6 },
          head: { display: 'flex', flexDirection: 'column', gap: '2px' },
          h: { margin: 0, fontSize: '15px', fontWeight: 600, color: C.text },
          intro: { margin: 0, color: C.textDim, maxWidth: '62ch' },
          meta: { marginTop: '6px', color: C.textDim, fontSize: '12px' },
          card: { border: `0.5px solid ${C.borderSubtle}`, borderRadius: C.radiusMd, background: C.surface, padding: '12px', display: 'flex', flexDirection: 'column', gap: '8px' },
          cardHead: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
          alias: { fontWeight: 600, fontSize: '13px' },
          badge: { border: `0.5px solid ${C.border}`, borderRadius: '999px', padding: '1px 8px', fontSize: '11px', color: C.textDim },
          kv: { display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 12px', color: C.textDim, fontSize: '12px' },
          row: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' },
          button: {
            appearance: 'none', boxSizing: 'border-box', display: 'inline-flex',
            alignItems: 'center', justifyContent: 'center', height: '28px', padding: '0 10px',
            border: `0.5px solid ${C.border}`, borderRadius: C.radiusSm,
            background: 'transparent', color: C.text,
            font: 'inherit', fontSize: '12px', lineHeight: '18px', whiteSpace: 'nowrap',
          },
          primary: { border: 'none', background: 'var(--dsw-alias-button-primary-fill, #4f7cff)', color: 'var(--dsw-alias-label-primary-foreground, #ffffff)' },
          dot: { width: '8px', height: '8px', borderRadius: '50%', flex: 'none' },
          footnote: { color: C.textDimmed, fontSize: '11px' },
        }

        /** 演示用的主机清单，与 Host 侧 index.js 的 HOSTS 保持一致。 */
        const DEMO_HOSTS = [
          { alias: 'analytics', address: '192.0.2.41', port: 22, user: 'ops', auth: '密钥', note: 'Debian 12 · 报表与批处理', tags: ['prod', 'batch'], online: true },
          { alias: 'staging', address: '192.0.2.42', port: 2222, user: 'deploy', auth: '口令', note: 'Ubuntu 22.04 · 预发布环境', tags: ['stage'], online: true },
          { alias: 'build-runner', address: '192.0.2.43', port: 22, user: 'ci', auth: '密钥', note: 'Alpine 3.19 · 构建节点', tags: ['ci'], online: true },
          { alias: 'archive', address: '198.51.100.7', port: 22, user: 'backup', auth: '密钥', note: 'Rocky 9 · 冷备存储', tags: ['cold'], online: false },
          { alias: 'win-sandbox', address: '203.0.113.24', port: 22, user: 'lab', auth: '密钥', note: 'Windows 10 · 隔离测试机', tags: ['vm', 'windows'], online: true },
        ]

        /** 剥掉 Host 侧输出的 ```console 围栏，得到纯正文。 */
        function stripFence(text) {
          const match = /^```console\r?\n([\s\S]*?)\r?\n?```\s*$/.exec(String(text ?? '').trim())
          return match === null ? String(text ?? '').trim() : match[1]
        }

        /** 从工具块里取出我们关心的名字、命令与输出。 */
        function demoCallOf(block) {
          if (block === null || typeof block !== 'object') return null
          const call = block.call ?? (Array.isArray(block.content) ? null : block)
          if (call === null || typeof call !== 'object') return null
          if (typeof call.name !== 'string' || !call.name.startsWith('demo_ssh_')) return null
          let args = call.args
          if (args === undefined && typeof call.argsRaw === 'string') {
            try { args = JSON.parse(call.argsRaw) } catch { args = undefined }
          }
          const settled = Array.isArray(block.content)
          const body = settled
            ? block.content.filter((part) => part?.type === 'text').map((part) => part.text).join('\n')
            : ''
          return { name: call.name, args: args ?? {}, settled, body: stripFence(body) }
        }

        /**
         * 工具调用卡片：与真插件的终端行同构。
         * @param props - toolview 运行时注入的阶段数据。
         * @returns 终端视图，形状不符时返回 null。
         */
        function DemoTerminalRow(props) {
          const call = demoCallOf(props?.block)
          if (call === null) return null
          const running = !call.settled
          const host = typeof call.args.host === 'string' ? call.args.host : ''
          const detail = call.name === 'demo_ssh_transfer'
            ? `${call.args.local ?? ''} ${call.args.direction === 'upload' ? '->' : '<-'} ${host}:${call.args.remote ?? ''}`
            : (call.args.command ?? '')
          const title = detail ? `${host} · ${detail}` : host
          return h('div', { style: T.card },
            h('div', { style: T.head },
              h('span', { style: running ? T.dotRunning : T.dotOk, 'aria-hidden': true }),
              h('span', { style: T.headText }, title)),
            call.body.length > 0
              ? h('pre', { style: T.pre }, call.body)
              : h('div', { style: T.empty }, running ? '执行中…' : '（无输出）'))
        }

        /**
         * 设置页：主机列表 + 状态点 + 表单预览。
         * @returns 设置区块。
         */
        function DemoSettingsSection() {
          const [editing, setEditing] = useState(false)
          return h('div', { style: S.page },
            h('div', { style: S.head },
              h('h3', { style: S.h }, 'SSH 连接'),
              h('p', { style: S.intro },
                '集中管理远程主机。地址、端口、账号与口令都保存在加密保险库中，对话里只用别名。'),
              h('div', { style: S.meta },
                `演示数据 · v0.1.0 · 密钥保护 dpapi · ${DEMO_HOSTS.length} 台主机`)),
            h('div', { style: S.row },
              h('button', { style: { ...S.button, ...S.primary }, onClick: () => setEditing((v) => !v) }, '添加连接'),
              h('button', { style: S.button }, '刷新状态'),
              h('button', { style: S.button }, '用资源管理器打开')),
            editing
              ? h('div', { style: { ...S.card, background: C.surfaceStrong } },
                  h('div', { style: S.cardHead }, h('span', { style: S.alias }, '新建连接')),
                  h('div', { style: S.kv },
                    h('span', null, '别名'), h('span', null, 'staging-2'),
                    h('span', null, '主机地址'), h('span', null, '192.0.2.50'),
                    h('span', null, '端口'), h('span', null, '22'),
                    h('span', null, '账号'), h('span', null, 'deploy'),
                    h('span', null, '认证方式'), h('span', null, '私钥'),
                    h('span', null, '备注'), h('span', null, '演示用，可以随时删除')),
                  h('div', { style: S.row },
                    h('button', { style: { ...S.button, ...S.primary } }, '保存'),
                    h('button', { style: S.button, onClick: () => setEditing(false) }, '取消')))
              : null,
            ...DEMO_HOSTS.map((host) => h('div', { key: host.alias, style: S.card },
              h('div', { style: S.cardHead },
                h('span', { style: { ...S.dot, background: host.online ? C.ok : C.bad }, 'aria-hidden': true }),
                h('span', { style: S.alias }, host.alias),
                h('span', { style: S.badge }, host.online ? '连通' : '不通'),
                ...host.tags.map((tag) => h('span', { key: tag, style: S.badge }, tag))),
              h('div', { style: S.kv },
                h('span', null, '地址'), h('span', { style: { fontFamily: MONO } }, `${host.address}:${host.port}`),
                h('span', null, '账号'), h('span', { style: { fontFamily: MONO } }, host.user),
                h('span', null, '认证'), h('span', null, host.auth),
                h('span', null, '备注'), h('span', null, host.note)),
              h('div', { style: S.row },
                h('button', { style: S.button }, '编辑'),
                h('button', { style: S.button }, '测试连接'),
                h('button', { style: S.button }, '删除')))),
            h('div', { style: S.footnote }, '演示插件：以上主机与地址均为虚构，不会发起任何连接。'))
        }

        /** 把 `/demo` 的输出按分节标记拆成若干段。 */
        const SECTION_RE = /^─── (.+?):(ok|fail) ───$/
        function splitSections(text) {
          const sections = []
          let current = null
          for (const line of String(text ?? '').split('\n')) {
            const match = SECTION_RE.exec(line)
            if (match !== null) {
              current = { title: match[1], failed: match[2] === 'fail', body: [] }
              sections.push(current)
              continue
            }
            if (current !== null) current.body.push(line)
          }
          return sections.map((section) => ({ ...section, body: section.body.join('\n').trim() }))
        }

        /**
         * `/demo` 命令的行：连接状态与命令执行各一张卡。
         * @param props - `{ node, compaction }`。
         * @returns 卡片视图。
         */
        function DemoCommandRow(props) {
          const node = props?.node ?? {}
          const text = node.text ?? node.result?.text ?? ''
          const sections = splitSections(text)
          if (sections.length === 0) return null
          return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
            ...sections.map((section, index) => h('div', { key: index, style: T.card },
              h('div', { style: { ...T.head, position: 'relative' } },
                h('span', { style: section.failed ? T.dotError : T.dotOk, 'aria-hidden': true }),
                h('span', { style: T.headText }, index === 0 ? '/demo' : section.title),
                index === 0 ? h('span', { style: T.badgeCentered }, section.title) : null,
                section.failed ? h('span', { style: T.statusBadge }, '有失败') : null),
              section.body.length > 0
                ? h('pre', { style: T.pre }, section.body)
                : h('div', { style: T.empty }, '（无输出）'))))
        }

        // —— 注册：key 全部独立，不与真插件冲突 ——
        ctx.slots.inject('tool.call.toolview', function* () {
          for (const key of ['demo_ssh_run', 'demo_ssh_probe', 'demo_ssh_transfer']) {
            yield ctx.slots.register({ name: 'tool.call.toolview', key }, DemoTerminalRow)
          }
        })
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'ssh-vault-demo',
          order: 21,
          label: () => 'SSH 连接（演示）',
        }, DemoSettingsSection))
        ctx.slots.inject('conversation.chat.commandview', () => ctx.slots.register({
          name: 'conversation.chat.commandview',
          key: 'demo',
        }, DemoCommandRow))
      },
    }
  },
})
