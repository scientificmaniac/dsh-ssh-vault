/**
 * 平台支持声明。
 *
 * 本插件**只在 Windows 上工作**，这不是保守，而是代码事实：
 *
 * - 数据密钥的保护依赖 Windows DPAPI（`lib/vault.js`）。非 Windows 上原先会退化成
 *   明文 `key.json`——既不安全，也不该被一句「支持 Linux / macOS」掩盖。
 * - ssh 的口令注入依赖 Windows 的 `SSH_ASKPASS` `.cmd` 包装器（`lib/ssh.js`）。
 *
 * 所以这里做两件事：给出唯一的支持平台，以及在不受支持的平台上**拒绝加载**，
 * 而不是悄悄降级。`package.json` 的 `os: ["win32"]` 负责在安装阶段就挡住非 Windows；
 * 运行期再挡一次，覆盖从源码直接安装、pnpm 忽略兼容性检查等情形。
 *
 * @module dsh-ssh-vault/platform
 */

import { t } from './i18n.js'

/** 支持的操作系统，取值同 Node 的 `process.platform`。 */
export const SUPPORTED_PLATFORMS = Object.freeze(['win32'])

/** 平台显示名。 */
const PLATFORM_LABELS = Object.freeze({
  win32: 'Windows',
  darwin: 'macOS',
  linux: 'Linux',
  freebsd: 'FreeBSD',
  openbsd: 'OpenBSD',
  sunos: 'SunOS',
  aix: 'AIX',
  android: 'Android',
})

/**
 * 平台显示名。
 * @param platform - `process.platform` 取值。
 * @returns `Windows` / `macOS` / `Linux` 等；未知平台原样返回。
 */
export function platformLabel(platform = process.platform) {
  return PLATFORM_LABELS[platform] ?? String(platform)
}

/**
 * 该平台是否受支持。
 * @param platform - `process.platform` 取值。
 * @returns 受支持时为 true。
 */
export function isSupportedPlatform(platform = process.platform) {
  return SUPPORTED_PLATFORMS.includes(platform)
}

/**
 * 断言当前平台受支持，否则抛出一条可读的错误。
 *
 * 故意抛错而不是返回布尔值：加载路径上任何「继续跑」都会走到明文密钥或缺失的
 * askpass，比直接失败更难排查。
 *
 * @param platform - `process.platform` 取值；测试可显式传入。
 * @throws 平台不在 {@link SUPPORTED_PLATFORMS} 中时。
 */
export function assertSupportedPlatform(platform = process.platform) {
  if (isSupportedPlatform(platform)) return
  throw new Error(t('platform.unsupported', {
    platform: platformLabel(platform),
    raw: String(platform),
    supported: SUPPORTED_PLATFORMS.map((value) => platformLabel(value)).join(', '),
  }))
}
