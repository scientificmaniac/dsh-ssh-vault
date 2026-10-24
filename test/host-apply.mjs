/**
 * 集成回归：`apply()` 在假 Host 上下文中能否完成注册，并跟随 DSH 的界面语言。
 *
 * 覆盖三件在真实界面里最容易失效、但单测模块单独跑不到的事：
 * 1. 插件激活时把 4 个工具、1 个命令、设置接口都注册上；
 * 2. `/hosts` 的 description / input.hint 在**注册那一刻**取自 DSH 的 locale 偏好；
 * 3. 用户在设置里切语言后，命令被换一份定义，结果正文也跟着换语言。
 *
 * 运行：node test/host-apply.mjs
 */
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'
import { applyPreference, resetLocaleForTests, t } from '../lib/i18n.js'

let passed = 0
const failures = []
function check(name, condition, detail) {
  if (condition) {
    passed += 1
    return
  }
  failures.push(`${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

const vaultDir = await mkdtemp(path.join(os.tmpdir(), 'dsh-ssh-vault-apply-'))

/**
 * 造一个够用的假 Host 上下文：记录注册项，并允许测试主动触发设置文档更新。
 * @param initialPreference - `locale.preference` 的初始值。
 */
function harness(initialPreference) {
  const state = {
    preference: initialPreference,
    tools: [],
    commands: [],
    settingsListeners: [],
    labels: [],
  }
  const cleanups = []
  const emitSettingsUpdate = (namespace) => {
    for (const listener of [...state.settingsListeners]) listener(namespace)
  }
  const makeCtx = (extra = {}) => ({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    effect(factory, label) {
      state.labels.push(label ?? '')
      const dispose = factory()
      if (typeof dispose === 'function') cleanups.push(dispose)
      return () => {}
    },
    inject(names, callback) {
      const services = {}
      for (const name of names) {
        if (name === 'settings') {
          services.settings = {
            describe: () => [{ ns: 'locale', value: { preference: state.preference } }],
          }
        } else if (name === 'webServer') {
          services.webServer = { register: () => () => {} }
        } else if (name === 'commands') {
          services.commands = {
            register: (definition) => {
              state.commands.push(definition)
              return () => {
                const index = state.commands.indexOf(definition)
                if (index >= 0) state.commands.splice(index, 1)
              }
            },
          }
        }
      }
      callback(makeCtx({ ...services, on: this.on, get: this.get }))
    },
    on(event, listener) {
      if (event !== 'settings/document-updated') return () => {}
      state.settingsListeners.push(listener)
      return () => {
        const index = state.settingsListeners.indexOf(listener)
        if (index >= 0) state.settingsListeners.splice(index, 1)
      }
    },
    get() {
      return undefined
    },
    tools: {
      register: (definition) => {
        state.tools.push(definition)
        return () => {}
      },
    },
    ...extra,
  })
  return {
    state,
    ctx: makeCtx(),
    emitSettingsUpdate,
    dispose() {
      while (cleanups.length > 0) {
        try {
          cleanups.pop()()
        } catch {
          // 清理失败不影响结论。
        }
      }
    },
  }
}

try {
  // —— 中文界面：注册项与结果正文都是中文 ——
  resetLocaleForTests()
  const zh = harness('zh')
  apply(zh.ctx, { vaultDir, keyProtection: 'file' })

  check('注册 4 个工具', zh.state.tools.length === 4, String(zh.state.tools.length))
  check('注册 /hosts 命令', zh.state.commands.length === 1, String(zh.state.commands.length))
  const zhCommand = zh.state.commands[0]
  check('中文界面下命令描述为中文', zhCommand?.description === t('hosts.description', {}, 'zh'), zhCommand?.description)
  check('中文界面下输入提示为中文', zhCommand?.input?.hint === t('hosts.hint', {}, 'zh'), zhCommand?.input?.hint)

  const zhNatural = await zhCommand.handler({ rawInput: 'kali; 帮我看看磁盘空间' })
  check('中文界面下自然语言提示为中文', zhNatural.text.includes('看起来是自然语言'), zhNatural.text.slice(0, 80))

  const zhEmpty = await zhCommand.handler({ rawInput: '' })
  check('中文界面下空保险库提示为中文', zhEmpty.text.includes('SSH 保险库为空'), zhEmpty.text)

  // —— 切到英文：命令定义被换掉，结果正文也换 ——
  zh.state.preference = 'en'
  zh.emitSettingsUpdate('locale')

  check('切换语言后命令仍只有一个', zh.state.commands.length === 1, String(zh.state.commands.length))
  const enCommand = zh.state.commands[0]
  check('切换语言后命令是新的定义对象', enCommand !== zhCommand)
  check('英文界面下命令描述为英文', enCommand?.description === t('hosts.description', {}, 'en'), enCommand?.description)
  check('英文界面下输入提示为英文', enCommand?.input?.hint === t('hosts.hint', {}, 'en'), enCommand?.input?.hint)

  const enNatural = await enCommand.handler({ rawInput: 'kali; 帮我看看磁盘空间' })
  check('英文界面下自然语言提示为英文', enNatural.text.includes('looks like natural language'), enNatural.text.slice(0, 80))
  // 用户原句会被原样引用，所以先摘掉它再检查模板本身没有残留中文。
  check('英文结果模板里没有残留中文', !/[\u4e00-\u9fff]/.test(enNatural.text.replace('帮我看看磁盘空间', '')), enNatural.text)

  const enEmpty = await enCommand.handler({ rawInput: '' })
  check('英文界面下空保险库提示为英文', enEmpty.text.includes('SSH vault is empty'), enEmpty.text)

  // 只指定不存在的别名：不触发真实 SSH，用来验证分节标题与「未找到」也换语言。
  const enUnknown = await enCommand.handler({ rawInput: 'ghost' })
  check('英文界面下分节标题为英文', enUnknown.text.includes('─── Connection:fail ───'), enUnknown.text)
  check('英文界面下未找到提示为英文', enUnknown.text.includes('Not found: ghost'), enUnknown.text)

  // —— 没有显式偏好时保持中文默认 ——
  resetLocaleForTests()
  const fallback = harness(undefined)
  apply(fallback.ctx, { vaultDir, keyProtection: 'file' })
  check('无显式偏好时默认中文', fallback.state.commands[0]?.description === t('hosts.description', {}, 'zh'), fallback.state.commands[0]?.description)

  fallback.dispose()
  zh.dispose()
  // 显式偏好保持到进程结束也无妨；这里恢复默认，便于未来追加用例。
  resetLocaleForTests()
  applyPreference('zh')
} finally {
  await rm(vaultDir, { recursive: true, force: true })
}

console.log(`${passed} 项通过，${failures.length} 项失败`)
for (const failure of failures) console.error(`FAIL: ${failure}`)
if (failures.length > 0) process.exit(1)
console.log('全部通过')
