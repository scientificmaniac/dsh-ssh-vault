/**
 * client.js 冒烟测试：不开浏览器、不装 React，用假宿主把 factory 跑一遍。
 *
 * 覆盖范围：
 *   · apply 不抛错，inject 仍只声明 slots；
 *   · 中英字典经 locale 注册，两边的键齐全，新增的硬编码中文已进字典；
 *   · settings.section 带 `locale: 'ssh-vault'`，label() 跟随当前语言；
 *   · 三个 tool.call.toolview key 与 conversation.chat.commandview 都注册且带 locale；
 *   · 首条消息前的 /hosts 结果 dock 注册、hook 注入与显示条件（空白会话才显示）；
 *   · withLocale 把宿主注入的 t 放进 LocaleContext，没注入时退回 fallbackT；
 *   · 老宿主（没有 locale / sessions / uiConversation 服务）下 apply 依旧可用；
 *   · client.js 里「执行中… / （无输出） / 有失败 / 'shell'」只剩字典那一份。
 *
 * 运行：node test/client-smoke.mjs
 */
import { readFileSync } from 'node:fs'

let passed = 0
const failures = []

/**
 * 记录一条断言。
 * @param name - 断言名。
 * @param condition - 是否通过。
 * @param detail - 失败时附带的细节。
 */
function check(name, condition, detail) {
  if (condition) {
    passed += 1
    return
  }
  failures.push(`${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

const SOURCE = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

/** 极简 React 替身：只实现 client.js 用到的入口。 */
function fakeReact() {
  /** 与 React.createElement 一样返回 { type, props }，children 收进 props。 */
  const createElement = (type, props, ...children) => ({
    type,
    props: {
      ...(props ?? {}),
      ...(children.length === 0 ? {} : { children: children.length === 1 ? children[0] : children }),
    },
  })
  const createContext = (defaultValue) => ({
    defaultValue,
    Provider: { displayName: 'LocaleContext.Provider' },
  })
  return {
    createElement,
    createContext,
    // 没有 Provider 时 React 返回默认值；冒烟测试不渲染组件树，够用即可。
    useContext: (context) => context.defaultValue ?? null,
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useRef: (initial) => ({ current: initial }),
  }
}

/**
 * 在 Node 里执行一遍 client.js，取出它交给 window.__ModuleLoader__ 的工厂产物。
 * @returns {{ definition: object, module: object }} 模块定义与 factory 返回的插件对象。
 */
function loadClient() {
  let captured = null
  const windowRef = { __ModuleLoader__: { load: (definition) => { captured = definition } } }
  const requireRef = (id) => {
    if (id !== 'react') throw new Error(`client.js 只该 require('react')，实际是 ${id}`)
    return fakeReact()
  }
  // 用 Function 隔离：不往真正的全局对象上塞 window。
  const run = new Function('window', 'require', SOURCE)
  run(windowRef, requireRef)
  if (captured === null) throw new Error('client.js 没有调用 window.__ModuleLoader__.load')
  return { definition: captured, module: captured.factory(requireRef) }
}

/**
 * 假 locale 服务：字典按命名空间存起来，bind() 返回按「当前语言」取词的函数。
 * @returns {{ locale: object, state: object }} 服务与可读写的状态。
 */
function createFakeLocale() {
  const state = { lang: 'zh', namespaces: new Map(), registered: [], binds: 0 }
  const locale = {
    register(ns, dicts) {
      state.namespaces.set(ns, dicts)
      state.registered.push(ns)
      return () => state.namespaces.delete(ns)
    },
    bind(ns) {
      state.binds += 1
      return (key, vars) => {
        const dicts = state.namespaces.get(ns)
        const template = dicts?.[state.lang]?.[key] ?? dicts?.zh?.[key] ?? key
        if (vars === undefined) return template
        return template.replace(/\{(\w+)\}/g, (match, name) => (name in vars ? String(vars[name]) : match))
      }
    },
  }
  return { locale, state }
}

/**
 * 假 Host 服务：`sessions` 与 `uiConversation` 的最小面，供输入框上方的 dock 面板接线。
 * @returns {{ services: object, state: object }} 服务与可读写的快照状态。
 */
function createFakeHostServices() {
  const state = {
    session: { blank: true },
    chat: { order: [], nodes: new Map() },
    activated: 0,
  }
  const sessionSource = {
    getSnapshot: () => state.session,
    subscribe: () => () => {},
  }
  const chatSource = {
    getSnapshot: () => state.chat,
    subscribe: (listener) => {
      state.activated += 1
      if (typeof listener === 'function') listener()
      return () => {}
    },
  }
  const binding = { session: sessionSource }
  const services = {
    sessions: { binding: (id) => (id === 'sess-1' ? binding : undefined) },
    uiConversation: { binding: () => ({ target: (target) => (target === 'chat' ? chatSource : undefined) }) },
  }
  return { services, state }
}

/**
 * 假 client ctx：slots.inject 立即执行回调（生成器则展开）、slots.register 记录并返回 disposer。
 * @param locale - 假 locale 服务；传 undefined 模拟老宿主。
 * @param extraServices - 额外的可选服务（sessions / uiConversation）。
 * @returns {{ ctx: object, effects: object[], registrations: object[], injected: string[] }} 环境与记录。
 */
function createFakeCtx(locale, extraServices = {}) {
  const effects = []
  const registrations = []
  const injected = []
  const ctx = {
    // 宿主用 ctx.get 做可选查找：没有服务时返回 undefined，不抛错。
    get: (name) => (name === 'locale' ? locale : extraServices[name]),
    // 参照宿主：只有依赖全部就绪才同步执行回调（回调拿到带这些服务属性的子 ctx）。
    inject: (names, callback) => {
      const ready = names.every((name) => extraServices[name] !== undefined)
      if (ready) callback({ ...ctx, ...Object.fromEntries(names.map((name) => [name, extraServices[name]])) })
    },
    effect: (callback, label) => {
      const dispose = callback()
      effects.push({ label, dispose })
      return () => { if (typeof dispose === 'function') dispose() }
    },
    slots: {
      inject: (name, callback) => {
        injected.push(name)
        const result = callback()
        // 参考宿主：回调可以返回普通 disposer，也可以是 yield disposer 的生成器（toolview 就是后者）。
        if (result !== null && typeof result === 'object' && typeof result[Symbol.iterator] === 'function') {
          const disposers = [...result]
          return () => {
            for (const dispose of disposers.reverse()) if (typeof dispose === 'function') dispose()
          }
        }
        return () => { if (typeof result === 'function') result() }
      },
      register: (options, component) => {
        registrations.push({ options, component })
        return () => {
          const index = registrations.findIndex((item) => item.options === options)
          if (index >= 0) registrations.splice(index, 1)
        }
      },
    },
  }
  return { ctx, effects, registrations, injected }
}

// —— 正常宿主：有 locale 服务 ——
const { module: plugin, definition } = loadClient()
check('模块 id 是 dsh-ssh-vault', definition.id === 'dsh-ssh-vault', definition.id)
check('inject 仍只有 slots', JSON.stringify(plugin.inject) === JSON.stringify(['slots']), JSON.stringify(plugin.inject))

const { locale, state: localeState } = createFakeLocale()
const { services: hostServices, state: hostState } = createFakeHostServices()
const env = createFakeCtx(locale, hostServices)
let applyError = null
try {
  plugin.apply(env.ctx)
} catch (error) {
  applyError = error
}
check('apply 不抛错', applyError === null, applyError === null ? undefined : String(applyError.stack ?? applyError))
check('字典注册走 ctx.effect', env.effects.some((effect) => effect.label === 'ssh-vault: dictionaries'))
check('注册 ssh-vault 命名空间', localeState.registered.includes('ssh-vault'), localeState.registered.join(','))

// —— 字典：中英键对齐 + 新增键的文案 ——
const dicts = localeState.namespaces.get('ssh-vault')
check('字典含 zh / en', typeof dicts?.zh === 'object' && typeof dicts?.en === 'object')
const zhOnly = Object.keys(dicts?.zh ?? {}).filter((key) => typeof dicts.en?.[key] !== 'string')
const enOnly = Object.keys(dicts?.en ?? {}).filter((key) => typeof dicts.zh?.[key] !== 'string')
check('字典中英键一一对齐', zhOnly.length === 0 && enOnly.length === 0, `仅 zh: ${zhOnly.join(',')}；仅 en: ${enOnly.join(',')}`)
check('running 文案', dicts?.zh?.running === '执行中…' && dicts?.en?.running === 'Running…')
check('noOutput 文案', dicts?.zh?.noOutput === '（无输出）' && dicts?.en?.noOutput === 'No output')
check('anyFailed 文案', dicts?.zh?.anyFailed === '有失败' && dicts?.en?.anyFailed === 'Failed')
check('shellLabel 文案', dicts?.zh?.shellLabel === 'shell' && dicts?.en?.shellLabel === 'shell')

// —— settings.section：注册参数与 label 跟随语言 ——
const settingsEntry = env.registrations.find((item) => item.options.name === 'settings.section')
check('注册 settings.section', settingsEntry !== undefined)
check('settings.section id', settingsEntry?.options.id === 'ssh-vault', settingsEntry?.options.id)
check('settings.section 带 locale', settingsEntry?.options.locale === 'ssh-vault', settingsEntry?.options.locale)
check('settings.section label 是函数', typeof settingsEntry?.options.label === 'function')
const zhLabel = settingsEntry?.options.label?.()
check('zh 下导航项是「SSH 连接」', zhLabel === 'SSH 连接', zhLabel)
localeState.lang = 'en'
const enLabel = settingsEntry?.options.label?.()
check('en 下导航项是「SSH Connections」', enLabel === 'SSH Connections', enLabel)
localeState.lang = 'zh'

// —— withLocale：宿主注入的 t 会进 LocaleContext ——
const injectedT = (key) => `t:${key}`
const provider = settingsEntry?.component?.({ t: injectedT })
check('withLocale 把 t 放进 Provider', provider?.props?.value === injectedT)
check('withLocale 渲染原组件', typeof provider?.props?.children?.type === 'function'
  && provider.props.children.props.t === injectedT)
const providerWithoutT = settingsEntry?.component?.({})
check('宿主没给 t 时退回 fallbackT', typeof providerWithoutT?.props?.value === 'function'
  && providerWithoutT.props.value('sectionTitle') === 'SSH Connections')

// —— 对话内卡片：三个 toolview key + commandview ——
const toolEntries = env.registrations.filter((item) => item.options.name === 'tool.call.toolview')
const toolKeys = toolEntries.map((item) => item.options.key)
for (const key of ['ssh_run', 'ssh_probe', 'ssh_transfer']) {
  check(`注册 tool.call.toolview:${key}`, toolKeys.includes(key), toolKeys.join(','))
}
check('toolview 都带 locale', toolEntries.every((item) => item.options.locale === 'ssh-vault'))
const commandEntry = env.registrations.find((item) => item.options.name === 'conversation.chat.commandview')
check('注册 conversation.chat.commandview:hosts', commandEntry !== undefined && commandEntry.options.key === 'hosts')
check('commandview 带 locale', commandEntry?.options.locale === 'ssh-vault', commandEntry?.options.locale)

// —— 首条消息前的 /hosts 结果 dock：注册、注入形状与显示条件 ——
const dockEntry = env.registrations.find((item) => item.options.name === 'conversation.input.dock')
check('注册 conversation.input.dock', dockEntry !== undefined)
check('dock id / order / locale', dockEntry?.options.id === 'ssh-vault-hosts-result'
  && dockEntry?.options.order === 5
  && dockEntry?.options.locale === 'ssh-vault', JSON.stringify(dockEntry?.options))
const dockInjected = dockEntry?.options.inject?.('sess-1')
check('dock 注入 session 与 chat hook',
  typeof dockInjected?.hooks?.sshHostsSession?.getSnapshot === 'function'
  && typeof dockInjected?.hooks?.sshHostsChat?.getSnapshot === 'function')
const missingBinding = dockEntry?.options.inject?.('unknown')
check('dock 绑定缺失时退回空源而不是抛错',
  missingBinding?.hooks?.sshHostsSession?.getSnapshot?.() === undefined
  && missingBinding?.hooks?.sshHostsChat?.getSnapshot?.() === undefined)

/** 直接调用 dock 里的真实组件函数，注入假 hooks 与取词函数。 */
function renderDock(t) {
  const root = dockEntry.component({ t })
  const child = root?.props?.children
  const selected = {
    useSshHostsSession: (selector) => selector(hostState.session),
    useSshHostsChat: (selector) => selector(hostState.chat),
  }
  return child.type({ ...child.props, ...selected })
}

check('dock 无命令时不渲染', renderDock(injectedT) === null)
hostState.session.blank = true
hostState.chat = {
  order: ['command'],
  nodes: new Map([['command', { kind: 'command', data: { name: 'hosts', outcome: null, commandId: 'c1' } }]]),
}
globalThis.document = { documentElement: { lang: 'zh-CN' } }
const runningDock = renderDock(injectedT)
delete globalThis.document
check('dock 有命令时渲染', runningDock !== null)
const dockHintText = runningDock?.props?.children?.[0]?.props?.children
check('dock 提示词跟随当前语言', dockHintText === '命令输出：发送第一条消息后并入对话记录', JSON.stringify(dockHintText))
check('dock 渲染命令卡片', runningDock?.props?.children?.length === 2)
hostState.chat = {
  order: ['message', 'command'],
  nodes: new Map([
    ['message', { kind: 'user', data: {} }],
    ['command', { kind: 'command', data: { name: 'hosts', outcome: null, commandId: 'c1' } }],
  ]),
}
check('对话区已有消息时 dock 让位', renderDock(injectedT) === null)
hostState.chat = {
  order: ['command'],
  nodes: new Map([['command', { kind: 'command', data: { name: 'hosts', outcome: null, commandId: 'c1' } }]]),
}
hostState.session.blank = false
check('会话不再空白时 dock 让位', renderDock(injectedT) === null)
hostState.session.blank = true
hostState.chat = { order: [], nodes: new Map() }

// —— 老宿主：既没有 locale 也没有 sessions/uiConversation ——
const legacy = loadClient()
const legacyEnv = createFakeCtx(undefined)
let legacyError = null
try {
  legacy.module.apply(legacyEnv.ctx)
} catch (error) {
  legacyError = error
}
check('老宿主下 apply 不抛错', legacyError === null, legacyError === null ? undefined : String(legacyError.stack ?? legacyError))
check('老宿主不注册字典', legacyEnv.effects.length === 0)
check('老宿主没有 sessions/uiConversation 时跳过 dock',
  legacyEnv.registrations.find((item) => item.options.name === 'conversation.input.dock') === undefined)
const legacySettings = legacyEnv.registrations.find((item) => item.options.name === 'settings.section')
check('老宿主下 slot 不带 locale', legacySettings?.options.locale === undefined)
// 老宿主没有 locale 服务，文案按 <html lang> 猜：没有 document 时按英文。
check('老宿主 label 走 fallbackT（默认英文）', legacySettings?.options.label?.() === 'SSH Connections')
globalThis.document = { documentElement: { lang: 'zh-CN' } }
check('老宿主 label 走 fallbackT（zh-CN 中文）', legacySettings?.options.label?.() === 'SSH 连接')
delete globalThis.document

// —— 源码兜底：硬编码中文只剩 DICT 里的那一份 ——
const dictStart = SOURCE.indexOf('const DICT = {')
const dictEnd = SOURCE.indexOf('const NS = ')
check('能定位 DICT 区间', dictStart >= 0 && dictEnd > dictStart)

/**
 * 数一个字面量在源码里出现的所有位置。
 * @param literal - 要搜索的字面量。
 * @returns 出现下标数组。
 */
function indexesOf(literal) {
  const found = []
  for (let at = SOURCE.indexOf(literal); at >= 0; at = SOURCE.indexOf(literal, at + literal.length)) found.push(at)
  return found
}

/**
 * 判断源码下标是否落在注释行里（行首是 `//`、`*` 或 `/*`）。
 * @param offset - 源码下标。
 * @returns 是注释行则 true。
 */
function isCommentOffset(offset) {
  const lineStart = SOURCE.lastIndexOf('\n', offset) + 1
  const prefix = SOURCE.slice(lineStart, offset).trimStart()
  return prefix.startsWith('//') || prefix.startsWith('*') || prefix.startsWith('/*')
}

/** 非注释行里还残留的中文行。 */
const strayChinese = []
for (let lineStart = 0; lineStart < SOURCE.length;) {
  const lineEnd = SOURCE.indexOf('\n', lineStart)
  const end = lineEnd < 0 ? SOURCE.length : lineEnd
  const line = SOURCE.slice(lineStart, end)
  const trimmed = line.trim()
  const isComment = trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')
  if (!isComment && /[\u4e00-\u9fff]/.test(line) && (lineStart < dictStart || lineStart > dictEnd)) {
    strayChinese.push(`${lineStart}: ${trimmed}`)
  }
  lineStart = end + 1
}
check('非注释中文只剩 DICT 里的文案', strayChinese.length === 0, strayChinese.slice(0, 5).join(' | '))

for (const literal of ['执行中…', '（无输出）', '有失败']) {
  const indexes = indexesOf(literal).filter((at) => !isCommentOffset(at))
  check(`硬编码「${literal}」只剩 DICT 一份`,
    indexes.length === 1 && indexes[0] > dictStart && indexes[0] < dictEnd,
    `非注释行出现 ${indexes.length} 次`)
}
check("kv 里的 'shell' 已换成 t('shellLabel')",
  SOURCE.includes("h('span', null, 'shell')") === false && SOURCE.includes("t('shellLabel')"))

// —— 汇总 ——
if (failures.length > 0) {
  console.error(`✗ ${failures.length} 项失败：`)
  for (const failure of failures) console.error(`  - ${failure}`)
  console.error(`${passed} 项通过，${failures.length} 项失败`)
  process.exitCode = 1
} else {
  console.log(`${passed} 项通过`)
}
