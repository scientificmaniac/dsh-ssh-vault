/**
 * 与 `dsh-vm-control` 兼容层的双语文案。
 *
 * 这些句子同时出现在三处读者面前：设置页的状态行、`POST ssh-vault/vmStatus` 的
 * 结构化结果、以及 `POST ssh-vault/vmImport` 失败时的错误消息。键名统一为 `compat.*`
 * 与 `api.vm*`，由 `lib/i18n.js` 合并进主字典。
 *
 * 写作原则：每条错误都要说清「发生了什么、影响是什么、还能怎么继续」。兼容层的失败
 * 从不阻止用户手工添加主机，所以降级路径必须写在文案里，而不是留给读者猜。
 *
 * @module dsh-ssh-vault/locales/compat
 */

/** 兼容层双语文案；`{name}` 为插值占位符。 */
export const COMPAT_MESSAGES = {
  // —— 状态摘要（一句话） ——
  'compat.state.ready': {
    zh: '已识别 {name} v{version}（{dir}），虚拟机 SSH 导入接口可用。',
    en: 'Recognized {name} v{version} ({dir}); the VM-to-SSH import interface is available.',
  },
  'compat.state.degraded': {
    zh: '已识别 {name} v{version}，但有 {count} 条警告；导入接口仍然可用，请按警告逐条处理。',
    en: 'Recognized {name} v{version} with {count} warning(s); the import interface still works, but review the warnings.',
  },
  'compat.state.unavailable': {
    zh: '未在 {dirs} 找到 {name}。兼容层保持休眠：原有 SSH 功能不受影响，导入接口返回明确的不可用错误。',
    en: '{name} was not found in {dirs}. The compatibility layer stays dormant: the existing SSH features are unaffected and the import interface returns an explicit unavailable error.',
  },
  'compat.state.unavailable.reason': {
    zh: '未找到可用的 {name}：{reason} 兼容层保持休眠，原有 SSH 功能不受影响。',
    en: 'No usable {name} was found: {reason} The compatibility layer stays dormant and the existing SSH features are unaffected.',
  },
  'compat.state.incompatible': {
    zh: '找到了 {name}{version}，但它不满足本插件的兼容契约（{reason}）。为避免注册冲突，本插件不会加载它。',
    en: 'Found {name}{version}, but it does not satisfy this plugin\'s compatibility contract ({reason}). To avoid registration conflicts this plugin will not load it.',
  },
  'compat.state.disabled': {
    zh: '与 {name} 的兼容层已由配置关闭；原有 SSH 功能不受影响。',
    en: 'Compatibility with {name} is disabled by configuration; the existing SSH features are unaffected.',
  },

  // —— 发现与契约检查 ——
  'compat.issue.not-found': {
    zh: '未找到插件目录。已检查：{dirs}。',
    en: 'No plugin directory was found. Checked: {dirs}.',
  },
  'compat.issue.dir-missing': {
    zh: '配置的目录 {path} 不存在或不可读。',
    en: 'The configured directory {path} does not exist or is not readable.',
  },
  'compat.issue.manifest-unreadable': {
    zh: '{path} 无法读取或不是合法 JSON：{message}',
    en: '{path} cannot be read or is not valid JSON: {message}',
  },
  'compat.issue.manifest-invalid': {
    zh: '{path} 缺少 name / version，或不是对象形态的 package.json。',
    en: '{path} is missing name / version, or is not an object-shaped package.json.',
  },
  'compat.issue.name-mismatch': {
    zh: '{path} 的包名是 {actual}，不是 {expected}；不会把它当作目标插件。',
    en: 'The package at {path} is named {actual}, not {expected}; it is not treated as the target plugin.',
  },
  'compat.issue.version-unsupported': {
    zh: '插件版本 {version} 不在兼容范围 {range} 内。契约可能已变化，本插件拒绝自动对接。',
    en: 'Plugin version {version} is outside the supported range {range}. The contract may have changed, so this plugin refuses to adapt automatically.',
  },
  'compat.issue.entry-missing': {
    zh: '入口文件 {path} 不存在。',
    en: 'The entry file {path} does not exist.',
  },
  'compat.issue.not-esm': {
    zh: '{path} 声明为 CommonJS（package.json 的 type 不是 module），与宿主插件的 ESM 加载方式不一致。',
    en: '{path} is declared as CommonJS (package.json type is not module), which does not match the host\'s ESM plugin loading.',
  },
  'compat.issue.node-unsupported': {
    zh: '插件要求 Node {required}，当前是 {current}。',
    en: 'The plugin requires Node {required}; the current version is {current}.',
  },
  'compat.issue.module-load-failed': {
    zh: '入口模块加载失败：{message}。常见原因是缺少依赖，或入口里有 import 期的副作用。',
    en: 'Loading the entry module failed: {message}. A missing dependency or an import-time side effect in the entry are the usual causes.',
  },
  'compat.issue.missing-apply': {
    zh: '入口模块没有导出 apply(ctx, config) 函数，不是可加载的 DSH 插件。',
    en: 'The entry module does not export apply(ctx, config), so it is not a loadable DSH plugin.',
  },
  'compat.issue.missing-tools-inject': {
    zh: '入口模块没有声明 inject = [\'tools\']；它的工具无法注册到宿主工具表。',
    en: 'The entry module does not declare inject = [\'tools\']; its tools cannot be registered in the host tool registry.',
  },
  'compat.issue.duplicate-install': {
    zh: '发现同一插件的多份副本：{dirs}。当前使用 {chosen}。多份副本被宿主同时加载会让工具名与路由重复注册，请只保留一份。',
    en: 'Multiple copies of the same plugin were found: {dirs}. Using {chosen}. Loading more than one copy makes the host register duplicate tool names and routes; keep a single copy.',
  },
  'compat.issue.service-missing': {
    zh: '宿主没有 {service} 服务：{impact}',
    en: 'The host has no {service} service: {impact}',
  },
  'compat.issue.service-missing.tools': {
    zh: '插件无法注册任何工具。',
    en: 'the plugin cannot register any tools.',
  },
  'compat.issue.service-missing.webServer': {
    zh: '虚拟机插件的设置页接口不会注册，设置页里不会出现它的面板。',
    en: 'the VM plugin\'s settings API will not be registered, so its settings panel will not appear.',
  },
  'compat.issue.service-missing.commands': {
    zh: '/vm 命令不会注册，其余能力不受影响。',
    en: 'the /vm command will not be registered; everything else is unaffected.',
  },
  'compat.issue.service-missing.settings': {
    zh: '虚拟机插件无法跟随界面语言，文案退回它自己的默认语言。',
    en: 'the VM plugin cannot follow the UI language and falls back to its own default.',
  },

  // —— 导入失败 ——
  'compat.error.disabled': {
    zh: '与 {name} 的兼容层已关闭（vmControl.enabled=false），导入接口不可用。你仍可以在设置页手工添加主机。',
    en: 'Compatibility with {name} is disabled (vmControl.enabled=false), so the import interface is unavailable. You can still add the host manually in the settings page.',
  },
  'compat.error.unavailable': {
    zh: '未找到 {name}，无法校验导入数据。已检查：{dirs}。降级方式：在 SSH 设置页手工添加主机，或把虚拟机的 ssh 命令复制出来手工执行。',
    en: '{name} was not found, so the import payload cannot be verified. Checked: {dirs}. Fallback: add the host manually in the SSH settings page, or copy the VM\'s ssh command and run it yourself.',
  },
  'compat.error.incompatible': {
    zh: '{name} 存在但接口不兼容（{reason}）。降级方式：在 SSH 设置页手工添加主机；原有的保存接口 ssh-vault/save 不受影响。',
    en: '{name} exists but its interface is incompatible ({reason}). Fallback: add the host manually in the SSH settings page; the existing ssh-vault/save endpoint is unaffected.',
  },
  'compat.error.alias-conflict': {
    zh: '别名 {alias} 已被{owner}占用，本次导入没有写入任何内容。可选：换一个别名（建议 {suggestions}），或显式使用 aliasPolicy=overwrite 并带 confirm=true 覆盖它。',
    en: 'Alias {alias} is already used by {owner}; nothing was written. Either pick another alias (suggested: {suggestions}), or pass aliasPolicy=overwrite with confirm=true to replace it.',
  },
  'compat.error.alias-conflict.manual': {
    zh: '一台手工维护的主机',
    en: 'a manually maintained host',
  },
  'compat.error.alias-conflict.other-vm': {
    zh: '另一台虚拟机（{ref}）的导入记录',
    en: 'an import record for another VM ({ref})',
  },
  'compat.error.alias-conflict.vm-record': {
    zh: '一条来自 dsh-vm-control 的导入记录（未记录 vmx）',
    en: 'an import record from dsh-vm-control (no vmx recorded)',
  },
  'compat.error.already-imported': {
    zh: '这台虚拟机（{ref}）已作为 {alias} 导入过，本次没有重复创建。要更新它，用同一个别名再导入一次；要换别名，先在 SSH 设置页删除旧记录。',
    en: 'This VM ({ref}) was already imported as {alias}; nothing new was created. Re-import with the same alias to update it, or delete the old record in the SSH settings page first.',
  },
  'compat.error.store-failed': {
    zh: '写入 SSH 保险库失败：{message}',
    en: 'Writing to the SSH vault failed: {message}',
  },
  'compat.error.bad-policy': {
    zh: 'aliasPolicy 只能是 reuse / suffix / overwrite，收到的是 {policy}。',
    en: 'aliasPolicy must be reuse / suffix / overwrite; received {policy}.',
  },
  'compat.error.alias-invalid': {
    zh: '别名 {alias} 不合法：只允许字母、数字、点、下划线与连字符。',
    en: 'Alias {alias} is invalid: only letters, digits, dots, underscores and hyphens are allowed.',
  },
  'compat.error.host-required': {
    zh: '缺少主机地址（host）。虚拟机侧应给出地址，或由用户在设置页补填。',
    en: 'The host address is missing. The VM side should provide it, or the user can fill it in on the settings page.',
  },
  'compat.error.username-required': {
    zh: '缺少登录账号（username）。',
    en: 'The login user (username) is missing.',
  },
  'compat.error.port-invalid': {
    zh: '端口 {port} 不合法：应为 1 到 65535 的整数。',
    en: 'Port {port} is invalid: it must be an integer between 1 and 65535.',
  },
  'compat.error.password-required': {
    zh: '口令认证但没有提供口令。为避免把另一台主机的口令用到这台机器上，覆盖导入不允许沿用旧口令。',
    en: 'Password authentication was requested without a password. To avoid reusing another host\'s password on this machine, an overwriting import never inherits the old password.',
  },
  'compat.error.key-required': {
    zh: '私钥认证但没有提供 privateKeyPath。',
    en: 'Key authentication was requested without a privateKeyPath.',
  },
  'compat.error.password-on-key-host': {
    zh: '这台虚拟机在保险库里是按私钥认证保存的；本次请求既没有口令也没有私钥路径，未做修改。',
    en: 'This VM is stored with key authentication, and the request carried neither a password nor a key path, so nothing was changed.',
  },

  // —— 导入成功时的补充说明 ——
  'compat.warn.overwrote-foreign': {
    zh: '别名 {alias} 原本属于{owner}，已按 aliasPolicy=overwrite + confirm=true 覆盖。旧记录的绑定地址、sudo 口令与凭据引用没有被沿用。',
    en: 'Alias {alias} belonged to {owner} and was replaced under aliasPolicy=overwrite + confirm=true. The old binding address, sudo password and credential reference were not carried over.',
  },
  'compat.warn.suffixed': {
    zh: '别名 {alias} 已被占用，按 aliasPolicy=suffix 改用 {chosen}。',
    en: 'Alias {alias} was taken, so aliasPolicy=suffix used {chosen} instead.',
  },
  'compat.warn.degraded': {
    zh: '兼容层当前处于降级状态（{count} 条警告），本次导入已写入，但建议按状态里的警告处理。',
    en: 'The compatibility layer is degraded ({count} warning(s)). This import was written, but review the warnings in its status.',
  },
  'compat.warn.password-inherited': {
    zh: '本次未提供新口令，沿用了该主机上次保存的口令。',
    en: 'No new password was provided, so the password previously stored for this host was kept.',
  },
  'compat.warn.replaced-source': {
    zh: '这台虚拟机原来导入为 {old}；本次覆盖到 {alias} 后，旧记录已删除，避免同一台机器出现两个别名。',
    en: 'This VM was previously imported as {old}; after overwriting {alias} the old record was removed so the same machine has only one alias.',
  },

  // —— 设置页 ——
  'compat.ui.label': {
    zh: '虚拟机联动',
    en: 'VM integration',
  },
  'compat.ui.ready': {
    zh: '{name} v{version} · 导入可用',
    en: '{name} v{version} · import available',
  },
  'compat.ui.unavailable': {
    zh: '{name} 未安装 · 手动添加不受影响',
    en: '{name} not installed · manual setup unaffected',
  },
  'compat.ui.incompatible': {
    zh: '{name} 版本或接口不兼容 · 已拒绝自动对接',
    en: '{name} version or interface incompatible · automatic adaptation refused',
  },
  'compat.ui.degraded': {
    zh: '{name} v{version} · {count} 条警告',
    en: '{name} v{version} · {count} warning(s)',
  },
  'compat.ui.disabled': {
    zh: '已由配置关闭',
    en: 'disabled by configuration',
  },
  'compat.ui.recheck': {
    zh: '重新检查',
    en: 'Re-check',
  },
  'compat.ui.checking': {
    zh: '检查中…',
    en: 'Checking…',
  },

  // —— 设置接口的兜底错误 ——
  'api.vmCompatUnavailable': {
    zh: '当前组合没有启用虚拟机兼容层。',
    en: 'The VM compatibility layer is not enabled in this composition.',
  },
}
