/**
 * 单元回归：Host 侧双语字典与 locale 解析。
 *
 * 覆盖三件容易悄悄坏掉的事：
 * 1. 每条文案的 zh/en 都在、占位符集合一致、英文里没有漏译的中文；
 * 2. locale 的来源优先级——显式偏好 > Accept-Language > 默认中文；
 * 3. 从 settings.describe() 读 `locale.preference` 的形状。
 *
 * 运行：node test/i18n.mjs
 */
import {
  DEFAULT_LOCALE,
  LOCALE_SETTINGS_NAMESPACE,
  applyPreference,
  getLocale,
  hasExplicitPreference,
  hasMessage,
  learnLocaleFromHeader,
  localeFromHeader,
  messageKeys,
  normalizeLocale,
  onLocaleChange,
  readLocalePreference,
  resetLocaleForTests,
  setLocale,
  t,
} from '../lib/i18n.js'

let passed = 0
const failures = []
function check(name, condition, detail) {
  if (condition) {
    passed += 1
    return
  }
  failures.push(`${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

/** 取出一条文案的两种语言。 */
function entryOf(key) {
  const zh = t(key, {}, 'zh')
  const en = t(key, {}, 'en')
  return { zh, en }
}

// —— 1. 字典完整性 ——
const keys = messageKeys()
check('字典非空', keys.length > 90, String(keys.length))
check('含有 ssh 诊断键', keys.some((key) => key.startsWith('ssh.')), String(keys.length))
check('含有 /hosts 命令键', keys.includes('hosts.description') && keys.includes('hosts.hint'))

const missing = []
const placeholderMismatch = []
const untranslated = []
const emptyValues = []
for (const key of keys) {
  const { zh, en } = entryOf(key)
  if (zh === key || en === key) missing.push(key)
  if (zh.length === 0 || en.length === 0) emptyValues.push(key)
  const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort().join(',')
  if (placeholders(zh) !== placeholders(en)) placeholderMismatch.push(`${key}: zh={${placeholders(zh)}} en={${placeholders(en)}}`)
  // 英文条目里出现 CJK 只可能是漏译（`%程序目录%` 之类的反例不存在）。
  if (/[\u4e00-\u9fff]/.test(en)) untranslated.push(key)
}
check('没有缺失的键', missing.length === 0, missing.join(', '))
check('没有空文案', emptyValues.length === 0, emptyValues.join(', '))
check('中英占位符一致', placeholderMismatch.length === 0, placeholderMismatch.slice(0, 5).join(' | '))
check('英文条目没有漏译中文', untranslated.length === 0, untranslated.slice(0, 5).join(', '))

// —— 2. 关键文案现场 ——
check('默认语言为 zh', DEFAULT_LOCALE === 'zh', DEFAULT_LOCALE)
const online = t('hosts.onlineCount', { n: 3 }, 'en')
check('英文插值', online === 'Online (3):', online)
const naturalEn = t('hosts.notNatural', { text: 'check the disk', alias: 'kali' }, 'en')
check('英文自然语言提示提到 /hosts', naturalEn.includes('`/hosts kali; <shell command>`'), naturalEn.slice(0, 120))
check('英文自然语言提示不含中文', !/[\u4e00-\u9fff]/.test(naturalEn))
const listLine = t('hosts.listLine', { alias: 'kali', host: '192.0.*.*', port: 22, user: 'r***', auth: 'key' }, 'en')
check('英文主机行用半角括号', listLine === 'kali (192.0.*.*:22, r***, key)', listLine)
check('英文截断标记为英文', !/[\u4e00-\u9fff]/.test(t('hosts.outputTruncated', {}, 'en')), t('hosts.outputTruncated', {}, 'en'))
check('未知键原样回退', t('hosts.not-a-key') === 'hosts.not-a-key', t('hosts.not-a-key'))
check('hasMessage 认识已知键', hasMessage('hosts.description') === true && hasMessage('ssh.authFailed') === true)
check('hasMessage 拒绝未知键', hasMessage('hosts.nope') === false)

// 设置页 API 与 /hosts 之外的用户可见面也抽查一条。
check('设置接口错误有英文', t('api.aliasTaken', { alias: 'demo' }, 'en').includes('demo'), t('api.aliasTaken', { alias: 'demo' }, 'en'))
check('后台任务状态有英文', t('bg.remoteExit', { code: 3 }, 'en') === 'Remote exit code 3', t('bg.remoteExit', { code: 3 }, 'en'))

// —— 3. locale 解析 ——
resetLocaleForTests()
check('初始为默认中文', getLocale() === 'zh', getLocale())
check('归一化 zh-CN', normalizeLocale('zh-CN') === 'zh', normalizeLocale('zh-CN'))
check('归一化 en-US', normalizeLocale('en-US') === 'en', normalizeLocale('en-US'))
check('未支持语言回退英文', normalizeLocale('ja') === 'en', normalizeLocale('ja'))

check('头解析取首个英文', localeFromHeader('en-US,en;q=0.9,zh;q=0.8') === 'en', String(localeFromHeader('en-US,en;q=0.9,zh;q=0.8')))
check('头解析按 q 值排序', localeFromHeader('zh;q=0.5,en;q=0.9') === 'en', String(localeFromHeader('zh;q=0.5,en;q=0.9')))
check('头解析忽略零权重', localeFromHeader('en;q=0,zh') === 'zh', String(localeFromHeader('en;q=0,zh')))
check('头解析空值返回 undefined', localeFromHeader(undefined) === undefined)
check('头解析无支持语言返回 undefined', localeFromHeader('fr-FR,de;q=0.8') === undefined)

// 显式偏好压过浏览器头，且只通知一次。
resetLocaleForTests()
const seen = []
const off = onLocaleChange((locale) => seen.push(locale))
applyPreference('en')
check('显式偏好生效', getLocale() === 'en' && hasExplicitPreference() === true, getLocale())
check('locale 变化通知一次', seen.join(',') === 'en', seen.join(','))
const learned = learnLocaleFromHeader('zh-CN,zh;q=0.9')
check('显式偏好不被请求头覆盖', learned === 'en' && getLocale() === 'en', `${learned}/${getLocale()}`)
off()

// 没有显式偏好时，请求头可以定语言。
resetLocaleForTests()
learnLocaleFromHeader('en-GB,en;q=0.9')
check('无偏好时按请求头切英文', getLocale() === 'en', getLocale())
learnLocaleFromHeader('zh-CN')
check('无偏好时按请求头切回中文', getLocale() === 'zh', getLocale())

// —— 4. 从 DSH 设置读偏好 ——
resetLocaleForTests()
const fakeSettings = (rows) => ({ describe: () => rows })
check(
  '从 describe 读 preference',
  readLocalePreference(fakeSettings([{ ns: 'theme', value: { preference: 'dark' } }, { ns: LOCALE_SETTINGS_NAMESPACE, value: { preference: 'en' } }])) === 'en',
)
check('没有 locale 条目返回 undefined', readLocalePreference(fakeSettings([{ ns: 'theme', value: {} }])) === undefined)
check('locale 条目为空返回 undefined', readLocalePreference(fakeSettings([{ ns: "locale", value: {} }])) === undefined)
check('settings 缺失时安全返回', readLocalePreference(undefined) === undefined)
check('describe 抛错时向上抛出（由调用方兜底）', (() => {
  try {
    readLocalePreference({ describe: () => { throw new Error('not ready') } })
    return false
  } catch {
    return true
  }
})())

resetLocaleForTests()
check('未支持的外部语言按英文处理', (() => {
  setLocale('klingon')
  return getLocale() === 'en'
})(), getLocale())

// —— 收尾 ——
resetLocaleForTests()
console.log(`${passed} 项通过，${failures.length} 项失败`)
for (const failure of failures) console.error(`FAIL: ${failure}`)
if (failures.length > 0) process.exit(1)
console.log('全部通过')
