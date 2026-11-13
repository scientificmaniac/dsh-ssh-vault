# Changelog

**English** | [简体中文](CHANGELOG.zh-CN.md)

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to
[Semantic Versioning](https://semver.org/).



## [2.3.0] - 2026-11-13

### Added

- **An error log you can switch on and off**: a new “Error log” card at the bottom of the settings page. It is **off by default**; once enabled, tool failures, `/hosts` command exceptions, tunnel events and vault/settings warnings are written to `<vault>/logs/diagnostics.log` with their source and stack. The file rotates to `.1` past 512 KiB, and anything shaped like `password=…` is replaced by `***` before it lands on disk. The switch itself lives in `diagnostics.json` beside it, so a restart does not silently turn logging back off. The same card opens the log folder, clears the log, and shows the last 40 entries. `logging: true` or `logging: { enabled, dir, maxBytes }` sets the same thing from configuration.
- Four new settings-route actions: `/ssh-vault/diagnostics`, `setDiagnostics`, `clearDiagnostics`, `openLogs`.

### Changed

- The plugin no longer writes to the host logger unconditionally: all of its logging goes through the switch above, and nothing at all is written while it is off.

### Fixed

- **POSIX commands no longer put the command text in the remote argv**: the old `bash --norc -c '<command>'` made every `pkill -f` / `pgrep -f` / `ps aux | grep <word>` pattern match the shell carrying the command, killing the session (the symptom was no output plus exit code `-1`). The remote invocation is now the fixed `bash --norc -c 'eval "$(cat)"'`; the script arrives over stdin and is evaluated inside that shell, so the command text never appears in argv — and there is no temp file to leak or clean up. `sudoMode: "prime"` passwords, which used to travel in that argv too, no longer do.
- **A real session kill is still diagnosed**: killing sshd, restarting it or bouncing the network still produces `[exit code: -1]` with the raw `0xFFFFFFFF` value named and a connection-layer classification; the old "`pkill -f` may have killed itself" warning was removed because it is no longer true.
- **Timeouts and cancellations now label their output as incomplete**: the result starts with a localised `⚠ 输出不完整 / INCOMPLETE OUTPUT` notice, keeps the partial output, and is classified as `timeout` instead of a generic failure. This prevents a half-finished listing (for example a partially printed version table) from being read as a complete result.
- **`detach` no longer puts the command text in argv**: the detached command is base64-decoded into a 0600 command file under `/tmp` and executed from that file; the fixed `setsid sh -c` wrapper only sees the file path.

## [2.2.0] - 2026-11-07

### Added

- **`ssh_run`'s `workdir`**: run the command in a remote directory on POSIX and PowerShell targets. A `cd` or `Set-Location` is inserted into the same script; with `sudo` it happens **inside** the elevated context, so root-only directories work. A failed `cd` aborts the command instead of silently running in the login directory. cmd targets reject it with an explanation: Windows sshd wraps the command in another `cmd.exe /c "..."` layer, which tears the quotes out of a quoted `cd`.
- **`ssh_transfer`'s `flatten`** (default `true`): recursive copies move the source directory's **contents** into the target. Uploading `src/` to an existing `/root/app` now lands in `/root/app/*` instead of `/root/app/src/*`; downloads behave the same way, so the `cp -f src/* . && rm -rf src` cleanup is no longer needed. `flatten: false` keeps raw scp nesting.
- **Self-kill diagnosis**: a command that kills its own SSH session (for example `pkill -f` matching the shell that carries the command text) is now explained. Negative local exit codes render as `[exit code: -1]` instead of `[exit code: 4294967295]`, the raw `0xFFFFFFFF` value is named, the failure is classified as connection-layer, and the empty-output case gets a dedicated explanation with `pkill -x` / script-file advice. Commands containing `pkill -f` / `killall -f` also get a warning before they run.
- `test/live-tools.mjs`: a live regression for the model-facing tools (`ssh_run` / `ssh_transfer`) that executes the real tool definitions against a vault host; `npm run test:live:tools`.

### Changed

- **Truncated output keeps head and tail**: the in-memory excerpt is split between the beginning and the end of the stream, the omitted character count is printed in the middle, and the full stream is still written under `outputs/` with its absolute path. The output-saved note now reports characters, not bytes.
- **A `flatten` value without `recursive: true` fails loudly** instead of silently transferring a single file.

### Fixed

- **Windows exit codes were printed unsigned**: a remote `-1` surfaced as `4294967295`. Exit codes are normalised to signed 32-bit values everywhere, and the terminal card's status parser accepts negative codes.

## [2.1.1] - 2026-11-01

### Fixed

- **The cmd invocation was wrong (pre-existing defect)**: `cmd.exe /Q` enters interactive mode, mixing the Windows banner and the `DESKTOP-xxx C:\...>` prompt into stdout and corrupting every structured output. It now runs as `cmd.exe /Q /D /C <script>` — `/D` disables AutoRun, `/Q` disables echo, and the script travels as an argument instead of over stdin.
- **CRLF output made probe facts vanish silently**: `^##key##(.*)$` never matched on Windows targets, because the JS regex `.` does not match `\r` while cmd and PowerShell emit CRLF. Newlines are normalized before parsing; the helper moved to `lib/ssh.js` and is exported so the behaviour is pinned by unit tests.
- **`command_array` produced a wrong command on non-POSIX targets**: per-element single quoting is a POSIX rule; cmd does not accept single quotes and PowerShell treats `'x'` as a string literal. It is now rejected at the entry point with a hint to use the `command` string.

### Added

- **One host can declare several terminals (comma-separated)**: the `shell` field accepts values like `powershell,cmd` straight from the Settings form. Each call selects one with the new `shell` parameter (`ssh_run`, `ssh_probe`, `ssh_transfer` and `ssh_tunnel` all honour it) and defaults to the first; an explicitly requested shell that was not declared fails loudly instead of silently falling back — cmd and PowerShell share no syntax, so a silent fallback only produces harder-to-diagnose failures.
- `test/live-windows.mjs`: a full live regression against win10 (**68 cases**) covering PowerShell common commands and multi-line syntax, cmd common commands, exit codes, CJK and encoding, output truncation, timeout partial output, probe facts, the `command_array` rejection, multi-shell selection, and file upload/download. Adds `npm run test:live:windows`.
- The Linux side was re-verified as well: the POSIX `bash --norc -c` default wrapper, `command_array`, LF probe-fact parsing, `loginShell` and CJK output all behave unchanged.

### Known limitations

- **The command line on a cmd target cannot contain non-ASCII characters**: cmd parses the command line ssh hands it using the **system code page**, and `chcp 65001` only affects output produced afterwards, so CJK text in the command itself is already folded to `?` before it runs. Use a PowerShell target for CJK, or encode the payload as ASCII (PowerShell's `-EncodedCommand`).

## [2.1.0] - 2026-11-01

### Added

- **`ssh_tunnel` tool**: maintains local port forwards (`ssh -L`) with `start` / `list` / `stop`. Before opening a tunnel it reads the remote `sshd -T` policy and, when `AllowTcpForwarding no`, hands back a paste-ready per-user snippet (`Match User` + `AllowTcpForwarding local`) plus the `PermitOpen` explanation instead of making the caller hit `administratively prohibited`. Includes local port precheck, drop events, exponential-backoff reconnect, and cleanup on plugin unload. Adds `lib/tunnel.js` and `test/tunnel-unit.mjs` (133 assertions)
- **`ssh_run`'s `command_array`**: pass program and arguments as an array; each element is quoted so the remote shell performs no word splitting, globbing or variable expansion
- **`ssh_run`'s `login_shell`**: opt into a login shell (`bash -lc`); the default is the non-login `bash --norc -c`
- **`ssh_transfer`'s `sudo` / `normalize_eol` / `mode` / `owner` / `preserve_mode`**: move root-only files (remote staging plus cleanup), convert CRLF to LF before upload (binaries skipped), set remote permissions and ownership
- **`ssh_probe` records host metadata**: sudo capability, sshd forwarding policy, common tools, disk and memory, reused by `ssh_run`'s automatic sudo choice and by `ssh_tunnel`'s precheck; `ssh_hosts show` displays the summary
- **Error categories and large output on disk**: failures carry a category label (connection / auth / sudo / remote command / truncated); past the cap the full stream is written under `outputs/` in the vault directory and the absolute path is attached

### Changed

- **POSIX targets now use explicit shell wrapping**: `bash --norc -c '<command>'`. The command is parsed exactly once by bash and is no longer reinterpreted by the remote login shell (fish/zsh); `remoteShell` in the result states the actual form. `--norc` suppresses the stderr noise produced when RHEL/CentOS bash sources `~/.bashrc` inside an SSH session
- **`sudo` went from a single "prime" step to three forms**: `wrap` (`sudo -n bash -c '...'`), `script` (a temporary script executed as root, safe for heredocs, pipelines, background jobs and multi-line flows; the password reaches `sudo -S` through a base64 pipe and is invisible to both command lines and the remote `ps`), and `prime` (the previous behaviour, kept for compatibility). `sudo: true` picks automatically; `sudo_mode` forces one
- **sudo failure attribution**: distinguishes a needed password, not being in sudoers, and having no sudo, each with its fix
- **`ssh_transfer`'s sudo download now chowns the staged file to the connection account**: `$(id -un)` used to evaluate to root inside the root script, leaving a 600 root:root staging file that the following scp could not open
- **scp's `remote open: Permission denied` is no longer misreported as "wrong account or password"**

### Fixed

- The backticks in `buildDetachScript`'s hint line were executed by the remote shell as command substitution (actually creating the `.done` file and eating the hint text)
- `sudo -S` read the base64-decoded password without a trailing newline, so sudo 1.8.23 (CentOS 7) reported `sudo: no password was provided` and failed
- The RHEL/CentOS bash `SSH_SOURCE_BASHRC` patch added a `~/.bashrc` error line to the stderr of every command, which could derail failure diagnosis

### Documentation

- Both READMEs describe the contracts above and record that the Windows OpenSSH client does not support `ControlMaster` / `ControlPersist` (observed as `getsockname failed: Not a socket`), so connections cannot be reused



## [2.0.0] - 2026-10-25

### Removed

- **Linux and macOS support is gone — by declaration and by code.** The vault data key relies on
  Windows DPAPI and the `SSH_ASKPASS` helper is a Windows `.cmd`; off Windows the previous code
  silently wrote the data key to `key.json` as plaintext. That is a security downgrade, not support.
  The package now declares `os: ["win32"]`, so installation is rejected elsewhere, and both
  `apply()` and the `Vault` constructor refuse to run.

### Changed

- **Everything says Windows only**: `package.json` description and `meta`, `locale/{en,zh}.json`,
  the marketplace entry, and both READMEs (overview, requirements, limitations, FAQ).
- The new `lib/platform.js` owns the supported-platform list, friendly platform names, and the
  refusal message; `test/platform.mjs` pins the declaration to `package.json`.
- `test/host-apply.mjs` exercises the refusal path when the suite runs on a non-Windows host.
- Regression cover for the settings-route fence: the settings-API suite checks 401/403 bodies and
  no-store headers, that rejection happens **before** method and body handling, that a rejected
  request never writes to the vault, and that the integration wiring passes the host `connection`
  service through (`test/vault-api.mjs`, `test/host-apply.mjs`). 321 tests total.
- The marketplace entry points at the v2.0.0 tarball.

### Fixed

- **The README promised Linux/macOS while the implementation could only degrade there.** The
  documentation/code mismatch is closed in the honest direction: no plaintext fallback exists on
  any platform, and unsupported platforms fail loudly at install and at load.
- **The settings routes now cross the Host Connection trust fence.** Every `/ssh-vault/*` request
  first asks `ctx.connection.requestRejection(req)` — the same Host/Origin check and browser-
  session authentication used by `/api` — before it looks at the method, the body or the vault.
  Rejected requests get `401`/`403` and cannot read host data, trigger a probe, or even learn
  whether an action exists. A vault-and-credential endpoint should not rely solely on the
  surrounding server, as the review pointed out.
- **Re-uploading a private key for an existing host no longer fails on Windows.** The previous
  upload's copy is hardened with `icacls` into a user-read-only ACL, which also denies the write
  needed to overwrite it. The save path now resets the file's ACL (`icacls /reset` on Windows,
  chmod 0600 elsewhere) before rewriting, so the second upload lands.

## [1.15.0] - 2026-10-24

### Added

- **The plugin follows the DSH interface language.** With DSH switched to English, the
  Settings page, the `/` menu entries, the in-conversation SSH cards, `/hosts` results,
  transport diagnostics and Settings-API errors are English too; switching back changes them
  immediately, with no page reload or restart.
  - The Client half registers an `ssh-vault` dictionary with the host's locale service, so
    slot-rendered copy tracks the active locale.
  - The Host half reads `locale.preference` from the host settings document (the value the
    language picker persists) and follows `settings/document-updated`; `Accept-Language` is
    used only when no explicit preference exists.
  - Model-facing definitions — tool names, descriptions and parameter schemas — stay in
    English, because they are part of the model interface rather than the UI.
- `test/i18n.mjs`, `test/host-apply.mjs` and `test/client-smoke.mjs` cover dictionary
  completeness (placeholder parity, no untranslated English entries), the host activation and
  locale-switch path, and the client slot/dictionary wiring.

### Changed

- Host-side copy moved into `lib/i18n.js` plus `lib/locales/ssh.js`; the Chinese values are
  byte-for-byte the previous strings, so existing behaviour and tests are unchanged.
- **`/hosts` is re-registered only when the interface language changes.** The command's
  `description` and `input.hint` are static strings captured at registration; timers never
  touch the definition (that was the historical cause of a composer losing its command
  context mid-typing), but a locale switch is a deliberate Settings action with no command
  being typed, so replacing the definition there is safe.
- The `/hosts` hint now says that pressing Enter again lists the hosts, which makes the
  two-step menu-pick behaviour explicit.

### Fixed

- **A bare `/hosts` no longer appears to hang.** On a cold health cache the command used to
  probe every host sequentially with the 15s settings timeout, so five unreachable hosts meant
  up to 75 seconds of no visible result — and the result then landed above a message the user
  had sent in the meantime. Probes now run in parallel with a 4s budget for the list form.
- **`/hosts` results are visible before the first message.** DSH classifies a transcript
  containing only command rows as an inactive view, so in a brand-new conversation the command
  ran and logged its result but nothing rendered; the cards only appeared (above the new
  message) once the first prompt was sent. The plugin now mirrors those command nodes —
  including the running state — in the composer dock while the session is still blank, and
  steps aside as soon as the transcript has real content.

## [1.14.2] - 2026-10-19

### Fixed

- **PowerShell error output is plain text again.** -OutputFormat Text governs stdout only:
  powershell.exe still serialized the error stream as CLIXML onto stderr and echoed the
  entire script back as error context, burying real messages under XML. The script now merges
  the error stream into stdout itself and flattens each ErrorRecord to a single
  [error] … line, with Out-String -Stream keeping object and table output intact.

## [1.14.1] - 2026-10-19

### Fixed

- **PowerShell no longer floods stderr with CLIXML.** Once the script moved to
  `-EncodedCommand`, PowerShell serialized its progress stream into CLIXML and wrote that to
  stderr, burying real errors under a wall of XML. The script now sets
  `\Continue = 'SilentlyContinue'` and the invocation passes -OutputFormat Text.

## [1.14.0] - 2026-10-19

### Fixed

- **Multi-line PowerShell no longer fails silently.** `-Command -` reads stdin line by line,
  so a here-string (`@'…'@`) or a `foreach (…) {…}` block was split apart mid-parse. The
  resulting syntax errors did not come back as a non-zero exit, so the caller was told the
  command had run when it had not. PowerShell targets now receive the whole script through
  `-EncodedCommand` (Base64 UTF-16LE) and are parsed in one pass; `[Console]::OutputEncoding`
  is fixed at the head of the script so non-ASCII output stays readable.
- **`ssh_transfer` no longer misattributes a broken connection.** The path hint fired even
  when the transfer died on a connection reset, sending diagnosis toward the wrong layer.
- **Account lock is now a named cause.** Windows OpenSSH disconnects a locked account outright
  instead of returning `Permission denied`, so "port open, banner fine, still cannot connect"
  previously pointed only at firewalls. It now names account lock as a candidate and says how
  to check it (`net user` on Windows, `faillock` on Linux).

### Added

- **Connections to the same host are serialised.** Every call opens a fresh SSH connection; a
  burst of them, especially concurrent `scp`, trips sshd's connection limits and accumulates
  failed-auth counters toward an account lock. Background jobs stay outside the queue so a
  long task cannot block that host for everything else.
- `ssh_transfer` creates the local parent directory before a download.
- A warning before commands that change account state or lockout policy, since locking the
  management account also kills key-based login.

### Changed

- `shellArgv` takes the script and returns `-EncodedCommand` for PowerShell; POSIX and `cmd`
  targets still receive their script over stdin.

## [1.13.0] - 2026-10-17

### Added

- **`/hosts` distinguishes commands from prose.** Text after the semicolon that reads as
  natural language is no longer executed as shell; the command stops and hands the sentence
  back to the conversation, because command output never reaches the model.
- `scripts/dhcp-reserve-kali.ps1`, an idempotent helper that pins a VM's MAC to a fixed
  address in VMware's DHCP configuration.

### Changed

- **Documentation rewritten.** Both READMEs are now reference documents rather than a
  narrative of the build-out, with badges, a Mermaid data-flow diagram, and sections for
  architecture, extension points, lifecycle, limits and the security boundary.
- **English is the primary language for every top-level document.** `CHANGELOG`,
  `CONTRIBUTING` and `SECURITY` used to carry Chinese in the unsuffixed `.md` with English in
  an `.en.md`; all three now match the README convention — bare name is English, the
  translation carries the `.zh-CN` suffix.

## [1.12.3] - 2026-10-17

### Fixed

- The section label in a `/hosts` card is centred, instead of lining up with a failure badge
  on the right.

## [1.12.2] - 2026-10-17

### Fixed

- **Each `/hosts` card lights its own status.** Both cards previously read one flag derived
  from the whole command, so a reachable host with a failing command turned the connectivity
  card red as well.

## [1.12.1] - 2026-10-17

### Added

- `/hosts` output splits into two cards: reachability and command execution.

## [1.12.0] - 2026-10-17

### Added

- **The text after the semicolon is executed on every reachable host.** `/hosts kali; apt
  update` probes kali and then runs the command there. A command starting with `sudo` primes
  the sudo cache from the vault first, so a non-interactive session does not wait for a
  password until the timeout.

## [1.11.1] - 2026-10-17

### Fixed

- The full-width comma `，` separates host aliases, alongside the ASCII one.

## [1.11.0] - 2026-10-17

### Added

- **A connection can be renamed from the settings form.** Credentials, private-key path,
  note and tags move with it. The host writes the new record before removing the old one, so
  a failure in between leaves a duplicate rather than a lost configuration.

## [1.10.1] - 2026-10-17

### Changed

- The `/hosts` output is plain text again, and a single dot in the card header carries the
  outcome. Emoji circles duplicated what that dot already said, and read worse.

## [1.10.0] - 2026-10-17

### Added

- **`/hosts` has its own terminal row**, taken from the `conversation.chat.commandview` slot.
  The generic command card folded its output into an unstyled `<pre>` and hid it behind a
  disclosure.
- The full-width semicolon `；` ends the argument list, alongside the ASCII one.

## [1.9.6] - 2026-10-17

### Changed

- `/hosts` output uses coloured dots rather than check, cross and question marks, which read
  as verdicts instead of status.

## [1.9.5] - 2026-10-17

### Fixed

- **Arguments are parsed as comma-separated aliases ending at a semicolon.** Splitting on
  whitespace turned every word after the alias into a host lookup, so a trailing note
  produced several failed lookups and repeated the same error.
- Unknown aliases are resolved against the vault first and reported once, instead of being
  folded in with real connection failures.

## [1.9.4] - 2026-10-17

### Changed

- **The `/ssh` command is now `/hosts`.** The composer is a Lexical editor whose plain text
  nodes are subject to browser spellcheck; `ssh` is not a dictionary word and got underlined,
  while `hosts` is.

## [1.9.3] - 2026-10-17

### Fixed

- **The command is registered once and never re-registered.** Re-registering disposes the
  current definition, and the composer holds it while the user types arguments — swapping it
  out broke input (backspace stopped working) and needed a UI restart.

## [1.9.2] - 2026-10-17

### Fixed

- **The health dot follows every test.** The card's "Test connection" button updated only the
  detail area and never the dot, so a successful test left it red; editing a connection did
  not re-test it either, because the automatic sweep keyed off the alias list, which a change
  of address does not alter.

## [1.9.1] - 2026-10-17

### Fixed

- **The settings probe times out at 15 seconds, not 8.** A probe really connects over SSH, and
  a host that is up without a listening `sshd` burns the whole window in TCP connect.
- A timeout is reported as a timeout, naming the two likely causes (port closed, address
  changed) instead of surfacing as a bare `(no output)` that looks like a plugin failure.

## [1.9.0] - 2026-10-17

### Added

- The `/ssh` input hint lists the hosts that answered the last health check, and running it
  with no arguments prints the hosts split into online and offline.

## [1.8.0] - 2026-10-17

### Added

- **Each connection is probed when its card appears**, and the card carries a status dot:
  grey before the check, yellow while it runs, green on success, red on failure. Checks run
  serially so a batch of concurrent SSH connections cannot pile onto one unreachable host.

## [1.7.1] - 2026-10-17

### Fixed

- The terminal header shows the exit status. A non-zero remote exit is a normal return for
  these tools rather than an error, so a failed command looked identical to a successful one.

## [1.7.0] - 2026-10-17

### Added

- **SSH tool calls render as a scrollable terminal in the conversation**, registered on
  `tool.call.toolview` for `ssh_run`, `ssh_probe` and `ssh_transfer`. None of those key names
  were occupied, so nothing shipped is shadowed.

## [1.6.9] - 2026-10-17

### Fixed

- Tool output falls back to a `console`-fenced code block. `presentCall` / `presentResult` —
  the documented terminal-card hooks — turned out to have no consumer anywhere in the
  installed tree, so they cannot be the sole presentation path.

## [1.6.8] - 2026-10-17

### Added

- `presentCall` / `presentResult` hooks on the three terminal-style tools. See 1.6.9 and
  1.7.0: these hooks have no consumer in this DSH version, and real presentation arrived
  through a slot.

## [1.6.7] - 2026-10-17

### Added

- **Uploaded private keys are restricted and pre-checked.** The browser inspects the chosen
  file before uploading anything and rejects a public key, a PuTTY `.ppk`, a file without a
  PEM header, or an implausibly large file. The host requires an actual PEM header instead of
  merely containing the words `PRIVATE KEY`.
- The key form gained a passphrase field, for a key that is itself encrypted.

## [1.6.6] - 2026-10-17

### Fixed

- The result of "Open in file manager" is reported beside the button. The failure message used
  to appear only at the top of the page, so pressing the button looked like it did nothing.

## [1.6.5] - 2026-10-17

### Fixed

- The edit form expands under its own card instead of at the top of the page, which used to
  push the card being edited out of view.

## [1.6.4] - 2026-10-17

### Added

- The vault path sits on its own line with an "Open in file manager" button, backed by an
  `openVault` route that accepts no path argument at all — it can only open the plugin's own
  vault directory.

## [1.6.3] - 2026-10-17

### Fixed

- The vault metadata line no longer wraps at its full-width separators.
- The plugin version is read per request rather than cached, so a client-only change cannot
  leave the displayed version one release behind.

## [1.6.2] - 2026-10-17

### Fixed

- **The settings route is registered at `/ssh-vault` without a trailing slash.**
  `kind: 'prefix'` matches the registered path or that path plus a slash, so registering
  `/ssh-vault/` meant `/ssh-vault/list` matched neither and every request fell through to the
  fallback handler.

## [1.6.1] - 2026-10-17

### Fixed

- Secondary buttons use the host's own button tokens. The earlier version guessed at token
  semantics and produced light-on-light buttons in the dark theme.

## [1.6.0] - 2026-10-17

### Added

- **Connection management in Settings**: list, add, edit and delete hosts, with password or
  private-key authentication and a one-click connection test. A password entered there travels
  in a same-origin POST body and never enters the session log.
- **The `/ssh` command**: list hosts, or probe one or several by alias.
- `test/vault-api.mjs`, pinning the settings API's validation, masking and response shape.

## [1.5.0] - 2026-10-16

### Added

- Encrypted SSH host vault: AES-256-GCM with the data key protected by DPAPI on Windows or
  derived from a master passphrase via scrypt elsewhere.
- Model-facing tools `ssh_hosts`, `ssh_run`, `ssh_transfer` and `ssh_probe`, all addressing
  hosts by alias only.
- Background job support for commands that outlive one tool call.
- A private `known_hosts` inside the vault directory with `HashKnownHosts` enabled, so the
  user's `~/.ssh` is never touched.
- Offline password entry through `scripts/set-secret.mjs`.

### Security

- A password reaches the local ssh client only through `SSH_ASKPASS`, and a remote `sudo` is
  primed over stdin; neither appears on a command line or in a process list.
