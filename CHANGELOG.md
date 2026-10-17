# Changelog

**English** | [简体中文](CHANGELOG.zh-CN.md)

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

Nothing pending.

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
