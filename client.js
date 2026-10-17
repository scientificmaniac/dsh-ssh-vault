/**
 * SSH 保险库的浏览器半边：设置界面的连接管理页。
 *
 * 与 Host 侧一样保持零依赖、零构建——这里手写 React 元素，只 require 宿主提供的 'react'。
 * 数据经同源、document-relative 的 POST 走 `/ssh-vault/*`（见 lib/vault-api.js）。
 *
 * 安全性上值得注意的一点：口令通过 HTTP body 提交，**不进入会话日志**，
 * 这比让模型调用 `ssh_hosts add password=...` 更干净。
 */
window.__ModuleLoader__.load({
  id: 'dsh-ssh-vault',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useState } = React

    // —— 文案：按浏览器语言在中英之间选择，避免为一个设置页引入完整的 i18n 依赖 ——
    const DICT = {
      zh: {
        sectionTitle: 'SSH 连接',
        heading: 'SSH 连接',
        intro: '集中管理远程主机。地址、端口、账号与口令都保存在加密保险库中，对话里只用别名。',
        keyMode: '密钥保护',
        vaultDir: '保险库位置',
        add: '添加连接',
        empty: '还没有配置任何主机。点「添加连接」开始。',
        loading: '加载中…',
        alias: '别名',
        host: '主机地址',
        port: '端口',
        username: '账号',
        authType: '认证方式',
        authPassword: '口令认证',
        authKey: '密钥认证',
        password: '密码',
        passwordKeep: '留空表示保持已保存的密码',
        keyUpload: '上传私钥文件',
        keyUploadHint: '私钥会保存到保险库目录并自动收紧权限，无需自己处理文件 ACL',
        keyUploaded: '已选择',
        keyPath: '或填写私钥路径（运行 DSH 的机器上的绝对路径）',
        shell: '远程 shell',
        description: '备注',
        tags: '标签（逗号分隔）',
        save: '保存',
        cancel: '取消',
        edit: '编辑',
        remove: '删除',
        test: '测试连接',
        testing: '测试中…',
        testOk: '连接正常',
        testFail: '连接失败',
        confirmRemove: '确定要删除 {alias} 吗？保险库中的凭据会一并移除。',
        noHostsForTest: '请先添加主机。',
        saved: '已保存',
        errorRequired: '请填写必填项。',
        transportError: '无法连接到宿主：路由不可用。',
        routeMissing: '宿主没有注册设置接口：插件文件已更新，但宿主进程仍在运行旧代码。请重启 DSH Desktop。',
        notAuthorized: '请求被宿主拒绝（未认证）。请刷新页面后重试。',
        chooseFile: '选择文件',
        noFileChosen: '未选择任何文件',
        usernameKeyHint: '密钥认证同样需要账号——SSH 连接的是 user@host。',
        openVault: '用资源管理器打开',
        openWorking: '正在打开…',
        openDone: '已打开',
        keyAcceptHint: '支持 OpenSSH（id_rsa / id_ed25519，通常没有扩展名）与 PEM（.pem / .key）。'
          + '若文件选择器里看不到你的私钥，把类型切到「所有文件」即可。',
        keyIsPublic: '这是公钥，不能用于登录。请选择不带 .pub 后缀的私钥文件。',
        keyIsPpk: '这是 PuTTY 的 .ppk 私钥，OpenSSH 无法直接使用；请先用 puttygen 转换。',
        keyNotPrivate: '这不是 OpenSSH/PEM 私钥（缺少 BEGIN … PRIVATE KEY 头）。',
        keyTooLarge: '文件过大，不像是私钥。',
        keyReadError: '无法读取该文件。',
        passphrase: '私钥口令（可选）',
        passphraseHint: '私钥本身带密码时填写；留空表示私钥未加密。',
        passwordBadge: '已存密码',
        noPasswordBadge: '无密码',
        sudoBadge: 'sudo 口令',
        keyBadge: '密钥',
        agentBadge: 'agent',
        bindAddress: '出口源地址（可选）',
        updatedAt: '更新于',
      },
      en: {
        sectionTitle: 'SSH Connections',
        heading: 'SSH Connections',
        intro: 'Manage remote hosts in one place. Address, port, account and password live in an encrypted vault; the conversation only uses aliases.',
        keyMode: 'Key protection',
        vaultDir: 'Vault location',
        add: 'Add connection',
        empty: 'No hosts configured yet. Start with “Add connection”.',
        loading: 'Loading…',
        alias: 'Alias',
        host: 'Host address',
        port: 'Port',
        username: 'Account',
        authType: 'Authentication',
        authPassword: 'Password',
        authKey: 'Private key',
        password: 'Password',
        passwordKeep: 'Leave blank to keep the stored password',
        keyUpload: 'Upload private key file',
        keyUploadHint: 'The key is stored in the vault directory with its permissions tightened for you',
        keyUploaded: 'selected',
        keyPath: 'Or give a private key path (absolute, on the machine running DSH)',
        shell: 'Remote shell',
        description: 'Note',
        tags: 'Tags (comma separated)',
        save: 'Save',
        cancel: 'Cancel',
        edit: 'Edit',
        remove: 'Delete',
        test: 'Test connection',
        testing: 'Testing…',
        testOk: 'Connection OK',
        testFail: 'Connection failed',
        confirmRemove: 'Delete {alias}? Its credentials are removed from the vault too.',
        noHostsForTest: 'Add a host first.',
        saved: 'Saved',
        errorRequired: 'Fill in the required fields.',
        transportError: 'Cannot reach the host: route unavailable.',
        routeMissing: 'The host has no settings route: the plugin files are updated but the host process is still running the old code. Restart DSH Desktop.',
        notAuthorized: 'The host rejected the request (not authenticated). Refresh the page and try again.',
        chooseFile: 'Choose file',
        noFileChosen: 'No file chosen',
        usernameKeyHint: 'Key authentication still needs the account — SSH connects as user@host.',
        openVault: 'Open in file manager',
        openWorking: 'Opening…',
        openDone: 'Opened',
        keyAcceptHint: 'OpenSSH keys (id_rsa / id_ed25519, usually without an extension) and PEM keys (.pem / .key) '
          + 'are accepted. If your key is not listed, switch the file type filter to “All files”.',
        keyIsPublic: 'This is a public key; it cannot be used to log in. Choose the private key without the .pub suffix.',
        keyIsPpk: 'This is a PuTTY .ppk key, which OpenSSH cannot use directly. Convert it with puttygen first.',
        keyNotPrivate: 'This is not an OpenSSH/PEM private key (no BEGIN … PRIVATE KEY header).',
        keyTooLarge: 'The file is too large to be a private key.',
        keyReadError: 'Could not read that file.',
        passphrase: 'Key passphrase (optional)',
        passphraseHint: 'Fill in when the key itself is encrypted; leave blank for an unencrypted key.',
        passwordBadge: 'password stored',
        noPasswordBadge: 'no password',
        sudoBadge: 'sudo password',
        keyBadge: 'key',
        agentBadge: 'agent',
        bindAddress: 'Source address (optional)',
        updatedAt: 'updated',
      },
    }
    const LANG = String((typeof navigator !== 'undefined' && navigator.language) || 'zh').toLowerCase().startsWith('zh') ? 'zh' : 'en'
    const t = (key) => DICT[LANG][key] ?? DICT.zh[key] ?? key

    // —— 配色：照搬宿主 primitives 的真实定义 ——
    //
    // 下面每个值都取自 @deepseek-ai/dsh-client-ui-primitives 的 Button.module.css 与
    // Input.module.css，不再凭 token 名字猜语义。之前的两处错误正是猜出来的：
    //   · 副按钮拿 `bg-layer-1` 当底色——宿主按钮其实是「透明底 + border-l3 描边」；
    //   · 主按钮用 `brand-primary` 配写死的白字——宿主用的是
    //     `button-primary-fill` 配 `label-primary-foreground`。
    // 表面色保留中性半透明回退，token 缺失时也不会落成看不清的底色。
    const C = {
      text: 'var(--dsw-alias-label-primary, currentColor)',
      textDim: 'var(--dsw-alias-label-secondary, currentColor)',
      textDimmed: 'var(--dsw-alias-label-dimmed, currentColor)',
      border: 'var(--dsw-alias-border-l3, rgba(127,127,127,0.45))',
      borderSubtle: 'var(--dsw-alias-border-l4, rgba(127,127,127,0.28))',
      inputBg: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.10))',
      primaryFill: 'var(--dsw-alias-button-primary-fill, #4f7cff)',
      primaryText: 'var(--dsw-alias-label-primary-foreground, #ffffff)',
      radiusSm: 'var(--dsw-radius-sm, 6px)',
      radiusMd: 'var(--dsw-radius-md, 8px)',
      surface: 'rgba(127,127,127,0.08)',
      surfaceStrong: 'rgba(127,127,127,0.14)',
      ok: 'var(--dsw-alias-state-success-primary, #2e9e5b)',
      bad: 'var(--dsw-alias-state-error-primary, #d64545)',
    }

    const S = {
      page: { display: 'flex', flexDirection: 'column', gap: '14px', color: C.text, fontSize: '13px', lineHeight: 1.6 },
      head: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px' },
      h: { margin: 0, fontSize: '15px', fontWeight: 600, color: C.text },
      titleRow: { display: 'flex', alignItems: 'center', gap: '8px' },
      titleIcon: { flex: 'none', color: C.text },
      intro: { margin: '4px 0 0', color: C.textDim, maxWidth: '62ch' },
      meta: {
        marginTop: '6px', color: C.textDim, fontSize: '12px',
        // 第一行（版本 + 密钥保护）保持单行；全角空格也是可换行点，必须显式禁掉。
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      },
      metaBlock: { display: 'flex', flexDirection: 'column', minWidth: 0 },
      metaRow: { display: 'flex', alignItems: 'center', gap: '8px', marginTop: '2px', color: C.textDim, fontSize: '12px', minWidth: 0 },
      metaPath: { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 },
      miniButton: {
        appearance: 'none', WebkitAppearance: 'none', boxSizing: 'border-box', flex: 'none',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        height: '22px', padding: '0 8px',
        border: `0.5px solid ${C.border}`, borderRadius: C.radiusSm,
        background: 'transparent', color: C.text,
        font: 'inherit', fontSize: '11px', lineHeight: '16px', cursor: 'pointer', whiteSpace: 'nowrap',
      },
      button: {
        // 与宿主 .button / .outline 对齐：透明底、0.5px 描边、继承的文字色。
        appearance: 'none', WebkitAppearance: 'none', boxSizing: 'border-box',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '4px',
        height: '28px', padding: '0 10px',
        border: `0.5px solid ${C.border}`, borderRadius: C.radiusSm,
        background: 'transparent', color: C.text,
        font: 'inherit', fontSize: '12px', lineHeight: '18px', cursor: 'pointer', whiteSpace: 'nowrap',
      },
      primary: {
        // 与宿主 .primary 对齐：专用填充色与专用前景色，都不写死。
        border: 'none', background: C.primaryFill, color: C.primaryText,
      },
      danger: { borderColor: C.bad, color: C.bad },
      card: { border: `0.5px solid ${C.borderSubtle}`, borderRadius: C.radiusMd, background: C.surface, padding: '12px', display: 'flex', flexDirection: 'column', gap: '8px' },
      hostBlock: { display: 'flex', flexDirection: 'column', gap: '8px' },
      cardHead: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      alias: { fontWeight: 600, fontSize: '13px' },
      badge: { border: `0.5px solid ${C.border}`, borderRadius: '999px', padding: '1px 8px', fontSize: '11px', color: C.textDim },
      kv: { display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 12px', color: C.textDim, fontSize: '12px' },
      row: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' },
      form: { border: `0.5px solid ${C.border}`, borderRadius: C.radiusMd, background: C.surfaceStrong, padding: '12px', display: 'flex', flexDirection: 'column', gap: '10px' },
      fields: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: '10px' },
      field: { display: 'flex', flexDirection: 'column', gap: '3px' },
      label: { fontSize: '12px', color: C.textDim },
      input: {
        // 与宿主 .wrap / .input 对齐：bg-layer-1 底、border-l4 描边、label-primary 字。
        boxSizing: 'border-box', height: '28px', width: '100%', padding: '0 8px',
        border: `0.5px solid ${C.borderSubtle}`, borderRadius: C.radiusSm,
        background: C.inputBg, color: C.text, font: 'inherit', fontSize: '12px',
      },
      hint: { fontSize: '11px', color: C.textDim },
      error: { color: C.bad, fontSize: '12px' },
      okText: { color: C.ok, fontSize: '12px', fontWeight: 600 },
      badText: { color: C.bad, fontSize: '12px', fontWeight: 600 },
      pre: {
        margin: 0, padding: '8px', borderRadius: C.radiusSm, background: C.inputBg, border: `0.5px solid ${C.borderSubtle}`,
        fontSize: '11.5px', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: '200px', overflow: 'auto', fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
      },
      footer: { color: C.textDimmed, fontSize: '11px' },
    }

    // inline style 表达不了的状态。选择器与宿主的 hover / active / disabled 行为对齐：
    // 主按钮用 data-variant 排除，改走宿主自己的 button-primary-hover。
    const SCOPE = 'dsh-ssh-vault'
    const CSS = [
      `.${SCOPE} button { transition: background-color .12s ease, border-color .12s ease; }`,
      `.${SCOPE} button:not([data-variant="primary"]):hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.12)); }`,
      `.${SCOPE} button:not([data-variant="primary"]):active:not(:disabled) { background: var(--dsw-alias-interactive-bg-active, rgba(127,127,127,0.18)); }`,
      `.${SCOPE} button[data-variant="primary"]:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover, var(--dsw-alias-button-primary-fill, #4f7cff)); }`,
      `.${SCOPE} button:disabled { opacity: .4; cursor: not-allowed; }`,
      `.${SCOPE} button:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary, currentColor); outline-offset: 1px; }`,
      `.${SCOPE} input::placeholder { color: var(--dsw-alias-label-dimmed, currentColor); }`,
    ].join('\n')

    /**
     * 调一次宿主路由。
     * @param action - 路由末段。
     * @param payload - JSON 请求体。
     * @returns `{ ok: true, value }` 或 `{ ok: false, error }`。
     */
    async function call(action, payload) {
      let response
      try {
        // document-relative：页面用 <base href="./">，绝对路径会逃出部署前缀。
        response = await fetch(`ssh-vault/${action}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload ?? {}),
        })
      } catch {
        return { ok: false, error: t('transportError') }
      }
      // 404 与 401/403 的含义完全不同：前者是宿主根本没注册路由（进程跑的还是旧代码），
      // 后者只是这次请求没被信任。混成一句话会把排查引向错误方向。
      if (response.status === 404) return { ok: false, error: t('routeMissing') }
      if (response.status === 401 || response.status === 403) return { ok: false, error: t('notAuthorized') }
      if (!response.ok) return { ok: false, error: `${t('transportError')} (HTTP ${response.status})` }
      try {
        const envelope = await response.json()
        if (envelope && envelope.ok === true) return { ok: true, value: envelope.value }
        const message = envelope && envelope.error && envelope.error.message ? envelope.error.message : t('transportError')
        return { ok: false, error: message }
      } catch {
        return { ok: false, error: t('transportError') }
      }
    }

    /** 把一个文件读成 base64（去掉 data URL 前缀）。 */
    function readAsBase64(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => {
          const text = String(reader.result ?? '')
          const comma = text.indexOf(',')
          resolve(comma >= 0 ? text.slice(comma + 1) : text)
        }
        reader.onerror = () => reject(reader.error ?? new Error('read failed'))
        reader.readAsDataURL(file)
      })
    }

    /**
     * 先在本机看一眼选中的文件到底是不是私钥。
     *
     * 这才是真正管用的限制：`accept` 只能按扩展名过滤，而最常见的私钥
     * （`id_rsa`、`id_ed25519`）恰恰没有扩展名——只靠扩展名会把主用途挡在门外。
     * 内容检查既拦得住无关文件，也不会误伤它们。
     *
     * @param file - 用户选中的文件。
     * @returns 问题描述；看起来是私钥时返回 `null`。
     */
    async function inspectKeyFile(file) {
      if (file.size > 64 * 1024) return t('keyTooLarge')
      let text
      try {
        text = (await file.text()).slice(0, 8192)
      } catch {
        return t('keyReadError')
      }
      const first = (text.split(/\r?\n/, 1)[0] ?? '').trim()
      if (/^(ssh-rsa|ssh-ed25519|ssh-dss|ecdsa-sha2-|sk-ssh-|sk-ecdsa-)/.test(first)) return t('keyIsPublic')
      if (/^PuTTY-User-Key-File-/.test(first)) return t('keyIsPpk')
      if (!/^-----BEGIN (?:OPENSSH |RSA |DSA |EC |ENCRYPTED )?PRIVATE KEY-----/m.test(text)) return t('keyNotPrivate')
      return null
    }

    /** 一行表单字段。 */
    function Field(props) {
      return h('label', { style: S.field },
        h('span', { style: S.label }, props.label),
        props.children,
        props.hint ? h('span', { style: S.hint }, props.hint) : null)
    }

    /** 认证方式徽章。 */
    function authBadges(host) {
      const badges = []
      if (host.authType === 'key') badges.push(t('keyBadge'))
      else if (host.hasPassword) badges.push(t('passwordBadge'))
      else badges.push(t('noPasswordBadge'))
      if (host.hasSudoPassword) badges.push(t('sudoBadge'))
      if (host.credentialRef) badges.push(`credentialRef: ${host.credentialRef}`)
      return badges
    }

    /** 新增／编辑表单。 */
    function HostForm(props) {
      const existing = props.record
      const [alias, setAlias] = useState(existing ? existing.alias : '')
      const [host, setHost] = useState('')
      const [port, setPort] = useState('22')
      const [username, setUsername] = useState('')
      const [authType, setAuthType] = useState(existing ? existing.authType : 'password')
      const [password, setPassword] = useState('')
      const [keyPath, setKeyPath] = useState(existing && existing.privateKeyPath ? existing.privateKeyPath : '')
      const [keyFile, setKeyFile] = useState(null)
      const [keyFileError, setKeyFileError] = useState('')
      const [passphrase, setPassphrase] = useState('')
      const [shell, setShell] = useState(existing ? existing.shell : 'bash')
      const [description, setDescription] = useState(existing ? existing.description : '')
      const [tags, setTags] = useState(existing && existing.tags.length > 0 ? existing.tags.join(', ') : '')
      const [bindAddress, setBindAddress] = useState(existing ? existing.bindAddress : '')
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)

      // 编辑一台已存在的主机时，地址与账号需要先向宿主索取（列表里是脱敏值）。
      useEffect(() => {
        if (!existing) return
        let alive = true
        call('reveal', { alias: existing.alias }).then((result) => {
          if (!alive || !result.ok) return
          setHost(result.value.host ?? '')
          setPort(String(result.value.port ?? 22))
          setUsername(result.value.username ?? '')
        })
        return () => { alive = false }
      }, [existing])

      const submit = async () => {
        setError('')
        if (alias.trim().length === 0 || host.trim().length === 0 || username.trim().length === 0) {
          setError(t('errorRequired'))
          return
        }
        if (authType === 'password' && password.length === 0 && !(existing && existing.hasPassword)) {
          setError(t('errorRequired'))
          return
        }
        setBusy(true)
        const payload = {
          alias: alias.trim(),
          host: host.trim(),
          port: Number(port),
          username: username.trim(),
          authType,
          shell,
          description,
          tags: tags.split(',').map((tag) => tag.trim()).filter((tag) => tag.length > 0),
          bindAddress,
        }
        if (authType === 'password') payload.password = password
        else {
          payload.privateKeyPath = keyPath.trim()
          if (passphrase.length > 0) payload.passphrase = passphrase
          if (keyFile) {
            try {
              payload.privateKeyFile = { name: keyFile.name, base64: await readAsBase64(keyFile) }
            } catch {
              setBusy(false)
              setError(t('transportError'))
              return
            }
          }
        }
        const result = await call('save', payload)
        setBusy(false)
        if (!result.ok) {
          setError(result.error)
          return
        }
        props.onDone()
      }

      return h('div', { style: S.form },
        h('div', { style: S.fields },
          h(Field, { label: t('alias') },
            h('input', { style: S.input, value: alias, disabled: existing !== null, onChange: (e) => setAlias(e.target.value) })),
          h(Field, { label: t('host') },
            h('input', { style: S.input, value: host, placeholder: '192.0.2.10', onChange: (e) => setHost(e.target.value) })),
          h(Field, { label: t('port') },
            h('input', { style: S.input, value: port, inputMode: 'numeric', onChange: (e) => setPort(e.target.value) })),
          h(Field, { label: t('username'), hint: authType === 'key' ? t('usernameKeyHint') : undefined },
            h('input', { style: S.input, value: username, onChange: (e) => setUsername(e.target.value) }))),

        h('div', { style: S.row },
          h('span', { style: S.label }, t('authType')),
          h('label', { style: S.row },
            h('input', { type: 'radio', checked: authType === 'password', onChange: () => setAuthType('password') }),
            t('authPassword')),
          h('label', { style: S.row },
            h('input', { type: 'radio', checked: authType === 'key', onChange: () => setAuthType('key') }),
            t('authKey'))),

        authType === 'password'
          ? h(Field, { label: t('password'), hint: existing && existing.hasPassword ? t('passwordKeep') : undefined },
            h('input', { style: S.input, type: 'password', value: password, autoComplete: 'new-password', onChange: (e) => setPassword(e.target.value) }))
          : h('div', { style: S.fields },
            h(Field, { label: t('keyUpload'), hint: `${t('keyUploadHint')}　${t('keyAcceptHint')}` },
              // 原生 file input 自带边框与内边距，塞进 28px 的输入框里就会像截图那样错位。
              // 隐藏它、用自己的按钮当触发器，高度与圆角便与其它控件一致。
              h('label', { style: { ...S.button, alignSelf: 'flex-start' } },
                t('chooseFile'),
                h('input', {
                  type: 'file',
                  // accept 只是给文件选择器的建议：无扩展名的 id_rsa 仍需切到「所有文件」，
                  // 真正的把关在 inspectKeyFile（本机预检）与 Host 侧的内容校验。
                  accept: '.pem,.key,.ppk,.openssh,application/x-pem-file',
                  style: { display: 'none' },
                  onChange: async (e) => {
                    const picked = e.target.files && e.target.files[0] ? e.target.files[0] : null
                    setKeyFileError('')
                    if (picked === null) {
                      setKeyFile(null)
                      return
                    }
                    const problem = await inspectKeyFile(picked)
                    if (problem !== null) {
                      // 选错就地拒绝并清空，免得把无关文件传上去再被 Host 退回来。
                      setKeyFile(null)
                      setKeyFileError(problem)
                      e.target.value = ''
                      return
                    }
                    setKeyFile(picked)
                  },
                })),
              h('span', { style: keyFileError.length > 0 ? S.badText : S.hint },
                keyFileError.length > 0
                  ? keyFileError
                  : keyFile ? `${t('keyUploaded')}: ${keyFile.name}` : t('noFileChosen'))),
            h(Field, { label: t('keyPath') },
              h('input', { style: S.input, value: keyPath, placeholder: 'C:\\keys\\id_rsa', onChange: (e) => setKeyPath(e.target.value) })),
            h(Field, { label: t('passphrase'), hint: t('passphraseHint') },
              h('input', { style: S.input, type: 'password', autoComplete: 'new-password', value: passphrase, onChange: (e) => setPassphrase(e.target.value) }))),

        h('div', { style: S.fields },
          h(Field, { label: t('shell') },
            h('input', { style: S.input, value: shell, placeholder: 'bash', onChange: (e) => setShell(e.target.value) })),
          h(Field, { label: t('bindAddress') },
            h('input', { style: S.input, value: bindAddress, onChange: (e) => setBindAddress(e.target.value) })),
          h(Field, { label: t('description') },
            h('input', { style: S.input, value: description, onChange: (e) => setDescription(e.target.value) })),
          h(Field, { label: t('tags') },
            h('input', { style: S.input, value: tags, onChange: (e) => setTags(e.target.value) }))),

        error.length > 0 ? h('div', { style: S.error }, error) : null,
        h('div', { style: S.row },
          h('button', { 'data-variant': 'primary', style: { ...S.button, ...S.primary }, disabled: busy, onClick: submit }, t('save')),
          h('button', { style: S.button, disabled: busy, onClick: props.onCancel }, t('cancel'))))
    }

    /** 设置页主体。 */
    function SshVaultSettings() {
      const [state, setState] = useState({ status: 'loading', hosts: [], error: '', keyMode: '', vaultDir: '', version: '' })
      const [form, setForm] = useState(null)
      const [tests, setTests] = useState({})
      // 打开按钮的反馈必须留在按钮旁边：失败信息若只出现在页顶，点按钮的人看不到。
      const [openState, setOpenState] = useState({ status: 'idle', detail: '' })

      const load = useCallback(async () => {
        const result = await call('list')
        if (result.ok) {
          setState({
            status: 'ready',
            hosts: result.value.hosts,
            error: '',
            keyMode: result.value.keyMode,
            vaultDir: result.value.vaultDir,
            version: result.value.version ?? '',
          })
        } else {
          setState({ status: 'ready', hosts: [], error: result.error, keyMode: '', vaultDir: '', version: '' })
        }
      }, [])

      useEffect(() => { load() }, [load])

      const runTest = async (alias) => {
        setTests((map) => ({ ...map, [alias]: { status: 'running' } }))
        const result = await call('test', { alias })
        setTests((map) => ({
          ...map,
          [alias]: result.ok
            ? { status: result.value.ok ? 'ok' : 'fail', detail: result.value.detail, notes: result.value.notes ?? [] }
            : { status: 'fail', detail: result.error, notes: [] },
        }))
      }

      const removeHost = async (alias) => {
        if (typeof window !== 'undefined' && typeof window.confirm === 'function'
          && !window.confirm(t('confirmRemove').replace('{alias}', alias))) return
        const result = await call('remove', { alias })
        if (!result.ok) {
          setState((s) => ({ ...s, error: result.error }))
          return
        }
        await load()
      }

      // 终端图标：设置导航项的图标由 shell 按 section id 绘制，插件无法覆盖
      // （settings.section 的注册选项只有 id / order / label），所以在页面标题旁补一个。
      const terminalIcon = h('svg', {
        viewBox: '0 0 24 24', width: 18, height: 18, style: S.titleIcon, 'aria-hidden': true,
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
      },
      h('rect', { x: 2.5, y: 4.5, width: 19, height: 15, rx: 2.5 }),
      h('path', { d: 'M6.5 9.5l3 2.5-3 2.5' }),
      h('path', { d: 'M12.5 14.5h5' }))

      const openVault = async () => {
        setOpenState({ status: 'working', detail: '' })
        const result = await call('openVault')
        setOpenState(result.ok ? { status: 'ok', detail: '' } : { status: 'fail', detail: result.error })
      }

      const metaText = `dsh-ssh-vault v${state.version}　·　${t('keyMode')}: ${state.keyMode}`

      const header = h('div', { style: S.head },
        h('div', { style: { minWidth: 0 } },
          h('div', { style: S.titleRow }, terminalIcon, h('h3', { style: S.h }, t('heading'))),
          h('p', { style: S.intro }, t('intro')),
          state.status === 'ready' && state.error.length === 0
            ? h('div', { style: S.metaBlock },
              h('div', { style: S.meta, title: metaText }, metaText),
              h('div', { style: S.metaRow },
                h('span', { style: S.metaPath, title: state.vaultDir }, `${t('vaultDir')}: ${state.vaultDir}`),
                h('button', {
                  style: S.miniButton,
                  disabled: openState.status === 'working',
                  onClick: openVault,
                }, openState.status === 'working' ? t('openWorking') : t('openVault')),
                openState.status === 'ok' ? h('span', { key: 'open-ok', style: S.okText }, t('openDone')) : null,
                openState.status === 'fail'
                  ? h('span', {
                    key: 'open-fail',
                    title: openState.detail,
                    style: { ...S.badText, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                  }, openState.detail)
                  : null))
            : null),
        h('button', {
          'data-variant': 'primary',
          style: { ...S.button, ...S.primary },
          onClick: () => setForm({ mode: 'new', record: null }),
        }, t('add')))

      // 「添加」的表单出现在顶部；「编辑」的表单在**对应卡片下方**就地展开——
      // 表单原先渲染在列表之前，点编辑时会把视线和滚动位置一起拉到页面顶端。
      const formHandlers = {
        onDone: async () => { setForm(null); await load() },
        onCancel: () => setForm(null),
      }
      const isEditing = (host) => form !== null && form.mode === 'edit' && form.record !== null && form.record.alias === host.alias

      return h('div', { className: SCOPE, style: S.page },
        h('style', { key: 'scope-style' }, CSS),
        header,
        state.error.length > 0 ? h('div', { style: S.error }, state.error) : null,
        form !== null && form.mode === 'new'
          ? h(HostForm, { key: 'new-form', record: null, ...formHandlers })
          : null,
        state.status === 'loading'
          ? h('div', { style: { color: C.textDim } }, t('loading'))
          : state.hosts.length === 0 && form === null
            ? h('div', { style: { color: C.textDim } }, t('empty'))
            : state.hosts.map((host) => {
              const test = tests[host.alias]
              return h('div', { key: host.alias, style: S.hostBlock },
                h('div', { style: S.card },
                  h('div', { style: S.cardHead },
                    h('span', { style: S.alias }, host.alias),
                    ...authBadges(host).map((badge, index) => h('span', { key: index, style: S.badge }, badge)),
                    host.updatedAt ? h('span', { style: { ...S.badge, borderColor: 'transparent' } }, `${t('updatedAt')} ${String(host.updatedAt).slice(0, 19).replace('T', ' ')}`) : null),
                  h('div', { style: S.kv },
                    h('span', null, `${host.host}:${host.port}`),
                    h('span', null, host.username),
                    h('span', null, 'shell'),
                    h('span', null, host.shell),
                    ...(host.description ? [h('span', null, t('description')), h('span', null, host.description)] : []),
                    ...(host.tags.length > 0 ? [h('span', null, t('tags')), h('span', null, host.tags.join(', '))] : [])),
                  h('div', { style: S.row },
                    h('button', { style: S.button, disabled: test && test.status === 'running', onClick: () => runTest(host.alias) },
                      test && test.status === 'running' ? t('testing') : t('test')),
                    h('button', {
                      style: S.button,
                      onClick: () => setForm(isEditing(host) ? null : { mode: 'edit', record: host }),
                    }, isEditing(host) ? t('cancel') : t('edit')),
                    h('button', { style: { ...S.button, ...S.danger }, onClick: () => removeHost(host.alias) }, t('remove'))),
                  test && test.status !== 'running'
                    ? h('div', null,
                      h('div', { style: test.status === 'ok' ? S.okText : S.badText }, test.status === 'ok' ? t('testOk') : t('testFail')),
                      test.detail ? h('pre', { style: S.pre }, test.detail) : null,
                      test.notes && test.notes.length > 0 ? h('pre', { style: S.pre }, test.notes.join('\n')) : null)
                    : null),
                isEditing(host) ? h(HostForm, { record: host, ...formHandlers }) : null)
            }))
    }

    // —— SSH 工具的对话内终端视图 ——
    //
    // 注册点是 `tool.call.toolview`：按**工具名**分发，所以我们只影响自己注册的三个工具，
    // 不覆盖任何内置 UI（ssh_run / ssh_probe / ssh_transfer 都不在已占用列表里）。
    // 内置 bash 工具在同一槽位用的是宿主的 TerminalBlock；纯 JS 客户端拿不到宿主包
    // （builtins 只有 ctx / React / host / styles / console），所以这里自绘一个可滚动终端。

    /**
     * 从工具节点里取出这次调用的形状。
     *
     * 运行中时节点本身就是 call；已结算时挂在 `block.call` 上，结果在 `block.content`。
     *
     * @param block - 工具节点。
     * @returns 归一化的调用视图，或 null（交给通用行）。
     */
    function sshCallOf(block) {
      if (block === null || typeof block !== 'object') return null
      const settled = Object.prototype.hasOwnProperty.call(block, 'kind')
      const call = settled ? block.call : block
      if (call === null || typeof call !== 'object') return null
      let args = {}
      try {
        const parsed = JSON.parse(call.argsRaw)
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed
      } catch {
        args = {}
      }
      return {
        settled,
        name: typeof call.name === 'string' ? call.name : '',
        args,
        text: settled ? resultTextOf(block) : '',
        isError: block.isError === true,
      }
    }

    /**
     * 取结果里的唯一文本块，并剥掉 Host 侧包上的 console 围栏（围栏只是给通用行兜底用的）。
     * @param block - 已结算的工具节点。
     * @returns 输出文本。
     */
    function resultTextOf(block) {
      const content = block.content
      if (!Array.isArray(content) || content.length !== 1) return ''
      const only = content[0]
      if (only === null || typeof only !== 'object' || only.type !== 'text' || typeof only.text !== 'string') return ''
      const fenced = /^```[a-z]*\n([\s\S]*?)\n```$/.exec(only.text)
      return fenced === null ? only.text : fenced[1]
    }

    /**
     * 终端标题行：优先显示实际命令，其余工具给出一行等价描述。
     * @param call - 归一化的调用视图。
     * @returns 标题文本。
     */
    function sshHeadlineOf(call) {
      if (typeof call.args.command === 'string' && call.args.command.trim().length > 0) return call.args.command
      if (call.name === 'ssh_probe') return `ssh_probe ${String(call.args.host ?? '')}`
      if (call.name === 'ssh_transfer') {
        const arrow = call.args.direction === 'upload' ? '→' : '←'
        return `scp ${String(call.args.local ?? '')} ${arrow} ${String(call.args.remote ?? '')}`
      }
      return call.name
    }

    /**
     * 把输出拆成正文与退出状态。
     *
     * 标记约定与 Host 侧渲染一致：`[exit code: N]` / `[killed by signal: X]`。退出码要从
     * 正文里摘掉，否则同一次失败会既出现在文本里又出现在状态标签上。标记后面还可能跟着
     * 诊断建议，所以匹配不要求它位于整段文本的最末尾。
     *
     * @param text - 工具结果文本。
     * @returns 去掉标记的正文，以及退出码或终止信号。
     */
    function splitTerminalStatus(text) {
      const signal = /\n\[killed by signal: ([^\]\n]+)\](?:\n|$)/.exec(text)
      if (signal !== null) {
        return { body: text.replace(signal[0], '\n').replace(/\n+$/, ''), signal: signal[1], exitCode: undefined }
      }
      const exit = /\n\[exit code: (\d+)\](?:\n|$)/.exec(text)
      if (exit !== null) {
        return { body: text.replace(exit[0], '\n').replace(/\n+$/, ''), signal: undefined, exitCode: Number(exit[1]) }
      }
      return { body: text.replace(/\n+$/, ''), signal: undefined, exitCode: 0 }
    }

    const MONO = 'ui-monospace, SFMono-Regular, Consolas, "Courier New", monospace'
    const T = {
      card: {
        border: `0.5px solid ${C.border}`, borderRadius: C.radiusMd, overflow: 'hidden',
        // 中性半透明底：深色主题下变深、浅色主题下是淡灰，文字始终走 label-primary 保证对比。
        background: 'rgba(0,0,0,0.14)',
      },
      head: {
        display: 'flex', alignItems: 'center', gap: '8px', padding: '5px 10px',
        borderBottom: `0.5px solid ${C.borderSubtle}`, color: C.textDim,
        fontFamily: MONO, fontSize: '11.5px', lineHeight: 1.5,
      },
      dot: { width: '7px', height: '7px', borderRadius: '50%', flex: 'none', background: C.textDim },
      dotRunning: { width: '7px', height: '7px', borderRadius: '50%', flex: 'none', background: 'var(--dsw-alias-state-business-primary, #4f7cff)' },
      dotError: { width: '7px', height: '7px', borderRadius: '50%', flex: 'none', background: C.bad },
      headText: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: C.text },
      pre: {
        margin: 0, padding: '8px 10px', maxHeight: '320px', overflow: 'auto',
        fontFamily: MONO, fontSize: '12px', lineHeight: 1.55,
        color: C.text, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
      },
      empty: { padding: '8px 10px', color: C.textDim, fontSize: '11.5px', fontFamily: MONO },
      statusBadge: {
        marginLeft: 'auto', flex: 'none', padding: '0 6px', borderRadius: '999px',
        border: `0.5px solid ${C.border}`, fontSize: '10.5px', color: C.textDim,
      },
    }

    /**
     * 对话里的 SSH 终端行：标题显示命令与主机，下面是一个可滚动的输出区。
     * @param props - toolview 运行时注入的阶段数据。
     * @returns 终端视图。
     */
    function SshTerminalRow(props) {
      const call = sshCallOf(props?.block)
      if (call === null) return null
      const running = !call.settled
      const host = typeof call.args.host === 'string' ? call.args.host : ''
      const headline = sshHeadlineOf(call)
      const label = host === '' ? headline : `${host} · ${headline}`
      const status = splitTerminalStatus(call.text)
      // 非零退出码不算错误返回（工具按约定不抛错），但状态点必须反映它，否则失败看起来是成功的。
      const failed = call.isError || status.signal !== undefined
        || (status.exitCode !== undefined && status.exitCode !== 0)
      const badge = status.signal !== undefined
        ? status.signal
        : status.exitCode !== undefined && status.exitCode !== 0 ? `exit ${status.exitCode}` : null
      const body = status.body
      return h('div', { style: T.card },
        h('div', { style: T.head },
          h('span', { style: failed ? T.dotError : running ? T.dotRunning : T.dot, 'aria-hidden': true }),
          h('span', { style: T.headText, title: label }, label),
          badge !== null ? h('span', { style: T.statusBadge }, badge) : null),
        body.length > 0
          ? h('pre', { style: T.pre }, body)
          : h('div', { style: T.empty }, running ? '执行中…' : '（无输出）'))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'ssh-vault',
          order: 20,
          label: () => t('sectionTitle'),
        }, SshVaultSettings))
        // SSH 工具的对话内终端：按工具名分发，只占我们自己的三个名字。
        ctx.slots.inject('tool.call.toolview', function* () {
          for (const key of ['ssh_run', 'ssh_probe', 'ssh_transfer']) {
            yield ctx.slots.register({ name: 'tool.call.toolview', key }, SshTerminalRow)
          }
        })
      },
    }
  },
})
