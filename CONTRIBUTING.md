# Contributing

**English** | [简体中文](CONTRIBUTING.zh-CN.md)

This plugin **stores other people's passwords** and **runs commands on their machines**. Its bar is
therefore higher than a typical utility: the red lines in section 1 are not style preferences — breaking
one means a real leak or a real incident.

## 1. Red lines (a violation is grounds for rejection)

### 1.1 Never commit credentials, private keys, or real environment details

Do not commit: private keys, passwords, API keys, anything under `%DSH_HOME%`, real private addresses, real
host names, real account names, or session logs.

Tests that need a real host **always** take it from the environment; no literal values in the source:

```js
// Correct
const KALI = { host: env.LIVE_KALI_HOST, user: env.LIVE_KALI_USER, pass: env.LIVE_KALI_PASS }

// Wrong
const KALI = { host: '198.51.100.7', user: 'root', pass: '<password>' }
```

Examples, fixtures, and documentation use **documentation addresses only**: `192.0.2.0/24`,
`198.51.100.0/24`, `203.0.113.0/24`.

Before you press commit:

```powershell
git status --short                 # no id_rsa / id_rsa.pub / dist / .env
git diff --cached                  # read it, especially for addresses, accounts, passwords
```

`.gitignore` covers the common cases, **but that is not a guarantee** — it will not stop a new file named
`config.local.js`.

### 1.2 A password must never reach a command line, a log, or the conversation

This is the core design constraint of the project. Every change must preserve:

| Location | Requirement |
| --- | --- |
| Local `ssh` command line | The password may only travel through the `SSH_ASKPASS` environment variable |
| Remote command line and `ps` | The password may only travel on standard input |
| Session log | No tool parameter may contain a password; only switches such as `sudo: true` |
| Disk | Ciphertext only (AES-256-GCM); plaintext is allowed in memory only |

After changing an execution path, the "password does not appear in the remote process list" case in
`test/live.mjs` must still pass.

### 1.3 Stay dependency-free

Do not add npm dependencies. The plugin drives the system OpenSSH client (`ssh` / `scp`) and Node built-ins
only. `package.json` must not gain a `dependencies` block.

### 1.4 Do not touch the user's profile or vault

At runtime the plugin reads and writes only its own vault directory (`%DSH_HOME%\ssh-vault`). Do not write
`%DSH_HOME%\.credentials.yaml`, the profile's `package.json` or `cordis.patch.yml`, and do not touch the
user's `~/.ssh`.

## 2. Development environment

- Node.js >= 20 (see `engines` in `package.json`)
- Windows 10 1809+ with the OpenSSH Client enabled (`ssh -V` prints a version); Linux and macOS work natively
- **No `npm install` needed** — the project has no dependencies

## 3. Tests

### Required before every commit

```powershell
npm test
```

It runs three **host-free** suites in order, and CI runs exactly the same set:

```powershell
node test/diagnose.mjs     # shell translation, octal decoding, failure attribution
node test/unit.mjs         # argument construction, timeout/cancel output retention, wait/detach scripts
node test/background.mjs   # background job registration contract
```

### When a real host is involved

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

### Hard requirements

- Touching argument construction or attribution in `lib/ssh.js` → **must** add cases to `test/unit.mjs` /
  `test/diagnose.mjs`
- Touching background jobs → **must** add cases to `test/background.mjs`
- Adding model-facing behaviour → at least one unit case to pin it
- **Never loosen an assertion to make a suite pass.** If a new case requires changing an old assertion,
  explain in the pull request why the old assertion was wrong

## 4. Code style

Formatting is enforced by [`.editorconfig`](.editorconfig). Conventions on top of it:

- ESM (`import` / `export`), `"type": "module"`
- 2-space indent, single quotes, **no trailing semicolons**, ~120 column width
- JSDoc (`@param` / `@returns`) on exported functions; **comments in Chinese, identifiers in English**
- Prefer pure functions: argument construction (`buildSshArgs`), script generation (`buildWaitScript`,
  `buildDetachScript`) and attribution (`diagnose`) are side-effect free so they stay testable
- Error messages are written for the user: say **what happened** and **how to recover**, do not just re-throw
  the underlying error

## 5. Commit messages

[Conventional Commits](https://www.conventionalcommits.org/):

```
<type>: <short description>

<optional body: why>
```

`type` is one of `feat` / `fix` / `docs` / `refactor` / `test` / `chore`. Titles are English imperative
sentences; the body may be Chinese or English. **One commit does one thing.**

## 6. Pull requests

1. Open an issue first for behaviour changes, especially anything touching permissions, execution paths, or
   the storage format
2. Branch names: `feat/...`, `fix/...`, `docs/...`
3. Say three things in the description: **what changed, why, and how you verified it**
4. If any of the following applies, call it out explicitly:
   - a new execution path (where the password travels)
   - a vault format change (is a migration needed, what happens to existing data)
   - a new tool parameter (does it carry sensitive data into the session log)
5. `npm test` passes, and `git diff` contains no credentials

## 7. Architectural constraints

Confirm you have not broken these before changing code:

- **Alias addressing**: the model sees aliases only; addresses and credentials come from the vault. Do not add
  a parameter that makes the model pass a host name, account, or password.
- **An interrupted call is not a blind one**: every execution path must return the output it already received
  when it times out or is cancelled.
- **Failures must name the layer**: local key problems, a public key that is not installed, a wrong password,
  and a firewall drop must be distinguishable. "Wrong account or password" may only appear once the earlier
  causes are excluded.
- **Long tasks must not hold a tool call**: prefer `detach` (remote detach) and `wait_for` (condition
  waiting); do not write `sleep` polling into the implementation.
- **The session log is the only source of truth**: do not add custom session event types. Plugin state must
  either be reconstructable from the log or live in the vault / a storage service.
- **Version your storage format**: changing the shape of `vault.json` / `key.json` requires a version bump
  and the ability to read old data.

## 8. Project layout

| Path | Responsibility |
| --- | --- |
| `index.js` | Plugin entry, the four model-facing tools, config parsing, credential resolution |
| `lib/vault.js` | Encrypted vault (AES-256-GCM + DPAPI / scrypt) |
| `lib/ssh.js` | OpenSSH driver: argument construction, askpass injection, attribution, wait/detach scripts |
| `lib/background.js` | `ctx.jobs` background task adapter |
| `scripts/set-secret.mjs` | Offline password entry (neither DSH nor the model is involved) |
| `test/` | Regression; the first three need no host, the rest need a real target |

## 9. License

By contributing you agree to license your contribution under the [MIT license](LICENSE).
