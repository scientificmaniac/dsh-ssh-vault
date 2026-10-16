# Changelog

**English** | [简体中文](CHANGELOG.md)

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to
[Semantic Versioning](https://semver.org/).

## [1.6.0] - 2026-10-17

### Added

- **Connection management in Settings** (`Settings → SSH Connections`): list, add, edit and delete hosts
  without going through the conversation at all. A password typed there travels in a same-origin POST body
  and **never enters the session log** — cleaner than having the model call
  `ssh_hosts add password=...`.
- **Two authentication modes**: password and private key. A key can be uploaded whole; the host writes it
  into the vault directory and tightens its permissions automatically, so you never have to handle file
  ACLs. Uploading a public key or a non-key file is rejected on the spot.
- **Test connection**: runs the same real probe as `ssh_probe` and shows the result inline, failure
  attribution included.
- **`/ssh` command in the conversation**: `/ssh` lists every host, `/ssh <alias>...` probes one or several,
  and the outcome lands in the session as a command node.
- Added `test/vault-api.mjs` (35 cases) covering the settings API's validation, masking and response shape.

### Changed

- The plugin gained a browser half, `client.js`: zero dependencies, zero build, hand-written React elements
  requiring only the host-provided `react`. `package.json` now declares `dsh.client` and a `./client` export.
- Added `lib/vault-api.js`: same-origin JSON routes under the `/ssh-vault/` prefix.
- `npm test` now includes the settings API regression.

## [1.5.0] - 2026-10-16

Verified against real targets: 25 end-to-end cases pass (Kali with password auth + Windows 10 with key auth).

### Added

- **`wait_for`** — wait for a remote file to appear, or for its content to match a regex, in a single call;
  returns the matching line, and exits `124` on timeout. Replaces `sleep` + read-the-log polling and works
  with `run_in_background`.
- **`detach`** — run the command under `setsid` on the **remote** host, detached from the SSH session, with
  output written to a `/tmp` log; returns the pid and log path immediately. A dropped link or a cancelled
  call does not affect the remote process, which can be inspected at any time afterwards.

### Changed

- **Fallback when a credential reference is unavailable**: if `credentialRef` cannot be resolved but the
  vault still holds a password, the plugin falls back to it and says so. An environment problem no longer
  presents itself as "host unavailable" or "authentication failed".
- **sudo diagnostics and hints**: `a terminal is required` / `需要密码` is recognised and named as "the
  command did not run", together with a warning about the pipeline exit-code trap. A command containing
  `sudo -S` without `sudo: true` produces a hint.
- **Background job exit-code semantics**: a local client exit code of 255 is labelled "SSH transport failed,
  remote state unknown", and a cancelled call is labelled "whether the remote command is still running
  cannot be determined from this machine" — no longer conflated with "the command failed".

### Engineering

- Added [`CONTRIBUTING.md`](CONTRIBUTING.md): the red lines (credentials, password paths, zero dependencies,
  never touching the user's environment), code style, commit convention, PR checklist and architectural
  constraints.
- Added [`.editorconfig`](.editorconfig) and a GitHub Actions CI job that runs the host-free regression and
  fails the build when a private address, private key or API key is committed.
- `npm test` runs every host-free suite in one command.
- All examples moved to RFC 5737 documentation addresses (`192.0.2.0/24`, `198.51.100.0/24`,
  `203.0.113.0/24`).
- Added GitHub issue and pull request templates: a bug report (with an environment table and a request for
  diagnostics), a feature request, and a PR checklist covering the red lines and session-log impact. Blank
  issues are disabled and security reports are routed to private advisories.
- English documentation completed: `README.md` is now the English main document with the Chinese version at
  `README.zh-CN.md`; `CONTRIBUTING`, `SECURITY` and `CHANGELOG` each gained an `.en.md` counterpart, and the
  pairs link to each other at the top.

## [1.4.0] - 2026-10-16

### Added

- **Offline entry channel `scripts/set-secret.mjs`**: a password goes from your own terminal straight into
  the encrypted vault — not through DSH, not through the model, not into the session log, without touching
  the disk in plaintext, and without echoing. This resolves the either/or between "encrypted" and "not in the
  conversation": both now hold at once.
- The published package now includes `scripts/`.

## [1.3.0] - 2026-10-16

### Changed

- **Switching to `credentialRef` is now cleaner**: setting the reference clears the vault's own copy of the
  password, so it has a single source.
- **More accurate diagnostics**: an unavailable credential explains that the provider reads credentials at
  startup and that a new reference needs a DSH Desktop restart, and offers a temporary recovery path.
- The documentation now states the cost of `credentialRef`: `%DSH_HOME%\.credentials.yaml` is **plaintext**
  YAML — it buys "not in the conversation", not "encrypted at rest".

## [1.2.0] - 2026-10-16

### Added

- **`ssh_run sudo=true`**: takes the password from the vault and primes the sudo credential cache through
  SSH's standard input, so privileged commands no longer need the password in the conversation or on a
  command line. Verified on a real target that the password does not appear in the remote process list.
- **`sudoPassword` on host records**: store a sudo password that differs from the login password separately;
  still ciphertext.

### Changed

- A failed prime now reports a definite conclusion (password mismatch / sudoers requires a tty) and unit
  cases pin that behaviour.

## [1.1.0] - 2026-10-16

Verified against real targets (Kali with password auth + Windows 10 LTSC with key auth): 17 end-to-end cases
pass, covering password login, key login, known_hosts hashing, wrong-password attribution, output retention
on timeout, source-address binding, upload and download, platform-adaptive self-checks, and background job
streaming and settlement.

### Added

- **Background execution**: `ssh_run run_in_background=true` integrates with the generic job system; output
  streams live and `job_kill` stops it. No timeout applies.
- **Source address binding**: host records gained `bindAddress`, and `ssh_run` / `ssh_transfer` / `ssh_probe`
  can override it per call — `ssh -b` and `scp -o BindAddress=`.
- **Windows targets**: `shell` accepts `cmd` / `powershell`, and `ssh_probe` switches its probe commands by
  platform.
- **Restricted environments**: new `knownHostsFile` / `sshConfigFile` settings, and an explicit warning when
  DPAPI is unavailable.
- Three host-free suites: `test/unit.mjs`, `test/background.mjs`, `test/diagnose.mjs`.

### Fixed

- **Failure attribution rewritten**: local key permissions, `.pub` misuse, PPK, a public key that is not
  installed (including Windows `administrators_authorized_keys`), too many authentication failures,
  algorithm mismatch, and firewall drops are now separate conclusions. "Wrong account or password" only
  appears once the rest are excluded.
- **An interrupted call no longer goes blind**: stdout / stderr received before a timeout or cancellation is
  preserved and returned.
- **Validation at entry**: a `privateKeyPath` pointing at a public key, a PPK, or a non-key file fails at save
  time.
- **Readability**: octal-escaped paths in ssh errors are decoded back to UTF-8.

## [1.0.0] - 2026-10-13

### Added

- First release: encrypted vault (AES-256-GCM + Windows DPAPI), the four model-facing tools
  (`ssh_hosts` / `ssh_run` / `ssh_transfer` / `ssh_probe`), and password injection through `SSH_ASKPASS`.
