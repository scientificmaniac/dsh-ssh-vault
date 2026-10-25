/**
 * 单元回归：平台支持声明。
 *
 * 这个插件只在 Windows 上工作（DPAPI 保护数据密钥 + Windows askpass 包装器），
 * 所以这里把三件事钉死：
 * 1. 只有 `win32` 受支持；
 * 2. 不受支持的平台必须抛错，而不是返回 false 让调用方继续跑；
 * 3. `package.json` 的 `os` 字段与代码里的声明一致，安装阶段就能挡住非 Windows。
 *
 * Windows 上也能验证「非 Windows 行为」：`process.platform` 可配置，测试会临时改写成
 * linux / darwin 跑真实调用路径，再恢复。
 *
 * 运行：node test/platform.mjs
 */
import { readFileSync } from 'node:fs'
import { apply } from '../index.js'
import {
  SUPPORTED_PLATFORMS,
  assertSupportedPlatform,
  isSupportedPlatform,
  platformLabel,
} from '../lib/platform.js'
import { Vault } from '../lib/vault.js'

let passed = 0
const failures = []
function check(name, condition, detail) {
  if (condition) {
    passed += 1
    return
  }
  failures.push(`${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

/**
 * 临时改写 `process.platform`，用于在 Windows 上验证非 Windows 路径。
 * @param platform - 目标平台值。
 * @param run - 在该平台下执行的函数。
 * @returns `run` 的返回值。
 */
function withPlatform(platform, run) {
  const original = process.platform
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  try {
    return run()
  } finally {
    Object.defineProperty(process, 'platform', { value: original, configurable: true })
  }
}

// —— 1. 唯一的支持平台 ——
check('支持平台只有 win32', SUPPORTED_PLATFORMS.length === 1 && SUPPORTED_PLATFORMS[0] === 'win32', JSON.stringify(SUPPORTED_PLATFORMS))
check('win32 受支持', isSupportedPlatform('win32') === true)
check('linux 不受支持', isSupportedPlatform('linux') === false)
check('darwin 不受支持', isSupportedPlatform('darwin') === false)
check('未知平台不受支持', isSupportedPlatform('plan9') === false)

// —— 2. 平台显示名 ——
check('win32 显示为 Windows', platformLabel('win32') === 'Windows', platformLabel('win32'))
check('darwin 显示为 macOS', platformLabel('darwin') === 'macOS', platformLabel('darwin'))
check('linux 显示为 Linux', platformLabel('linux') === 'Linux', platformLabel('linux'))
check('未知平台原样显示', platformLabel('plan9') === 'plan9', platformLabel('plan9'))
check('默认参数可用', typeof platformLabel() === 'string' && platformLabel().length > 0, platformLabel())

// —— 3. 断言：受支持平台通过，不受支持平台报错 ——
let supportedError
try {
  assertSupportedPlatform('win32')
  supportedError = undefined
} catch (error) {
  supportedError = error
}
check('win32 通过断言', supportedError === undefined, supportedError === undefined ? undefined : String(supportedError))

for (const platform of ['linux', 'darwin']) {
  let error
  try {
    assertSupportedPlatform(platform)
  } catch (caught) {
    error = caught
  }
  check(`${platform} 被拒绝`, error instanceof Error, error === undefined ? '没有抛错' : undefined)
  check(`${platform} 的错误信息点名 Windows`, error instanceof Error && /Windows|Windows only|仅支持 Windows/.test(error.message), String(error?.message))
  check(`${platform} 的错误信息带平台名`, error instanceof Error && error.message.includes(platformLabel(platform)), String(error?.message))
}

// —— 4. package.json 的 os 字段与代码一致 ——
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
check('package.json 声明 os: ["win32"]',
  Array.isArray(manifest.os) && manifest.os.length === 1 && manifest.os[0] === 'win32',
  JSON.stringify(manifest.os))
check('package.json 主版本号已升到 2+', Number(String(manifest.version).split('.')[0]) >= 2, String(manifest.version))

// —— 5. 真实调用路径在非 Windows 上必须失败 ——
check('默认断言在伪造的 linux 上抛错', (() => {
  try {
    withPlatform('linux', () => assertSupportedPlatform())
    return false
  } catch (error) {
    return error instanceof Error && /Windows|Windows only|仅支持 Windows/.test(error.message)
  }
})())
check('默认断言在伪造的 darwin 上抛错', (() => {
  try {
    withPlatform('darwin', () => assertSupportedPlatform())
    return false
  } catch {
    return true
  }
})())
check('Vault 在非 Windows 上拒绝构造', (() => {
  try {
    withPlatform('linux', () => new Vault({ dir: process.cwd() }))
    return false
  } catch (error) {
    return error instanceof Error && /Windows|Windows only|仅支持 Windows/.test(error.message)
  }
})())
check('apply 在非 Windows 上拒绝加载', (() => {
  try {
    withPlatform('linux', () => apply({}, {}))
    return false
  } catch (error) {
    return error instanceof Error && /Windows|Windows only|仅支持 Windows/.test(error.message)
  }
})())
if (process.platform === 'win32') {
  check('伪造平台恢复后仍可正常构造', (() => {
    try {
      new Vault({ dir: process.cwd() })
      return true
    } catch {
      return false
    }
  })())
}

// —— 汇总 ——
console.log(`${passed} 项通过，${failures.length} 项失败`)
for (const failure of failures) console.error(`FAIL: ${failure}`)
if (failures.length > 0) process.exit(1)
console.log('全部通过')
