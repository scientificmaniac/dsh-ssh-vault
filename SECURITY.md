# Security Policy

**English** | [简体中文](SECURITY.zh-CN.md)

## Reporting a vulnerability

Please do **not** open a public issue. Use **Security → Report a vulnerability** on the GitHub repository and
include reproduction steps and impact. Confirmed reports are fixed as quickly as possible and credited in the
CHANGELOG.

## What this plugin protects

In one sentence: it protects **credentials at rest**, not a machine that has already been compromised.

| Protected | Not protected |
| --- | --- |
| Address, port, account, and password are stored as AES-256-GCM ciphertext | A malicious process already running as the current Windows user |
| The data key is bound to the current user by Windows DPAPI; another machine or user cannot decrypt it | A password you typed into the conversation — that enters the session log |
| The password reaches `ssh` through an askpass environment variable, never a command line or the remote `ps` | The remote host's own logs, auditing, and process environment |
| Host names in `known_hosts` are hashed, so addresses are not written in the clear | Anything that happens after the target is fully controlled |
| Private keys are validated on entry (`.pub`, PPK and non-key files are rejected) | The permissions on the key file itself — that is the operating system's job |

## Known trade-offs

- **Windows only, by construction.** The data key depends on Windows DPAPI and the askpass helper is a
  Windows `.cmd`; there is no non-Windows key store, and the plugin refuses to load elsewhere instead of
  falling back to a plaintext key file.
- **`credentialRef` points at a plaintext file.** `%DSH_HOME%\.credentials.yaml` is not encrypted. It buys
  "no password in the conversation", not "encrypted at rest". To get both, use the offline entry channel
  `scripts/set-secret.mjs`.
- **The remote host keeps artifacts.** `detach` and background tasks write log files under `/tmp`
  (`.dsh-ssh-*.log`) that may contain command output. Judge the target's accessibility accordingly and clean
  up after the task.
- **`known_hosts` uses `accept-new`.** The first connection trusts and records the host key; later changes
  are rejected. That defends against a later man-in-the-middle, not one present at first contact. Use
  `sshConfigFile` if you need strict mode.
- **A timeout is not a stop.** When the local client is interrupted the remote command may still be running.
  The plugin says so explicitly; prefer `detach` where the conditions allow.

## Dependency surface

Zero runtime dependencies. It only drives the system OpenSSH client (`ssh` / `scp`).
