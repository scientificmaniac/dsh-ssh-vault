# dsh-ssh-vault

**English** | [简体中文](README.zh-CN.md)

> Encrypted SSH host vault for the DeepSeek Harness: the agent works with host **aliases**, while the
> address, port, account, and password stay in an AES-256-GCM vault whose key is wrapped by Windows DPAPI.

A Host plugin for the DeepSeek Harness that lets an agent drive SSH without ever holding the credentials.
The model sees `vm-centos`; it never sees `192.0.2.10`, and it cannot read the password back out of the vault.

Typical setup: a Windows machine managing local Linux VMs, out-of-band management interfaces, and
Windows targets.

- **Zero runtime dependencies** — it drives the system OpenSSH client and nothing else.
- **A plaintext password never reaches the disk.** It is decrypted in memory, handed to `ssh` through
  `SSH_ASKPASS`, and dropped when the connection ends.
- **Failure attribution that names the layer** — local key problem / public key not installed / wrong
  password / firewall drop are reported as separate conclusions.
- **Long tasks that do not hold a tool call** — remote detach (`detach`) and condition waiting (`wait_for`),
  so an ssh call stops being a poller.

> **Note on language:** tool descriptions and the configuration surface are English. The diagnostic notes the
> plugin prints at runtime are currently Chinese; internationalising them is tracked work.

## Tools

| Tool | Purpose |
| --- | --- |
| `ssh_hosts` | Manage vault entries: `list` / `show` / `add` / `update` / `remove` |
| `ssh_run` | Run a command; supports `sudo`, `run_in_background`, `detach`, `wait_for`, `bindAddress` |
| `ssh_transfer` | Upload and download over SCP, with the same `bindAddress` support |
| `ssh_probe` | Connectivity self-check that adapts its commands to the target's shell |

## Install

Package name `dsh-ssh-vault`, bundle row id `ssh-vault`.

### Requirements

- **Windows 10 1809+ / Windows 11** with the **OpenSSH Client** enabled.
  Check with `ssh -V` — it should print `OpenSSH_for_Windows_9.x`.
  If missing: Settings → System → Optional features → Add a feature → **OpenSSH Client**.
- **DSH Desktop** with `dsh.bundle.patch` support (the 0.2.0-rc series is verified).

### Option A — install from a directory (recommended)

1. Copy the package directory to the target machine, for example `D:\dsh-plugins\dsh-ssh-vault`.
2. Install it, by asking the agent or through the plugin manager UI:

```
plugin_manager  action=install_bundle  target="D:\dsh-plugins\dsh-ssh-vault"
```

3. Ask the agent to run `ssh_hosts action=list`; a result means the plugin is live.

### Option B — install from an archive

Copy `dsh-ssh-vault-<version>.tgz` (or `.zip`) over, unpack it, then follow Option A.
The tgz can sometimes be used directly as the install target; if it is rejected, unpack it first.

### Local development

The profile links to this directory, so reinstall after changing files:

```
plugin_manager  action=install_bundle  target="<path to this checkout>"
```

> **Restart DSH Desktop after editing the source.** The profile's `patchReload` is `live`, so changing only
> `config` in `cordis.patch.yml` takes effect immediately. But `index.js` and `lib/*.js` are loaded
> JavaScript modules: reinstalling the bundle — even removing and installing it again — does **not** replace
> the module generation in memory.

## Security model

### What is on disk

The vault lives in `%DSH_HOME%\ssh-vault`:

| File | Contents | Plaintext secrets? |
| --- | --- | --- |
| `vault.json` | Host inventory ciphertext (AES-256-GCM: `iv` / `tag` / `data`) | No |
| `key.json` | The 32-byte data key, wrapped by Windows DPAPI for the current user | No |
| `known_hosts` | Host public keys; host names are hashed via `HashKnownHosts` | No |
| `askpass.cmd` / `askpass.js` | Password-injection helper; fixed content | No |

Address, port, account, and password all live inside the `vault.json` ciphertext. The data key is wrapped
again by DPAPI, so **copying the directory to another machine or another Windows user does not let anyone
decrypt it**.

### Key protection

Chosen by `keyProtection` when the vault is first created and recorded in `key.json`:

- `dpapi` (default) — the data key is protected by DPAPI; the boundary is "the current Windows user".
- `file` — the data key is stored as base64 in `key.json`; the boundary degrades to filesystem permissions.
- `passphrase` — the data key is derived from `masterPassword` with scrypt; no key material is stored.

If DPAPI is unavailable (for example a restricted sandbox that forbids child processes), the plugin falls
back to `file` and says so, rather than failing silently.

### How the password reaches ssh

Windows OpenSSH 9.x supports `SSH_ASKPASS_REQUIRE=force`: with no terminal it asks the program named by
`SSH_ASKPASS`. The plugin generates `askpass.cmd`, which writes the password to stdout. The password
therefore exists only in that one `ssh` child process's environment — never on a command line (so it cannot
be seen in a process list) and never on disk.

### Explicit boundaries

- **Not protected against:** a malicious process already running as the current Windows user. It can read
  the DPAPI key and the process environment alike. That is the inherent limit of a local threat model.
- **Session log:** tool arguments are written to the session record. The `password` parameter of
  `ssh_hosts` therefore enters the log *before* it is encrypted. To avoid that entirely, use the offline
  entry script or `credentialRef` — and read the trade-offs below, because `credentialRef` is not free.
- The `host` argument of `ssh_hosts add` likewise enters the session log; recording a host cannot avoid
  that. Everyday calls afterwards use the alias only.

## Settings UI

**Settings → SSH Connections** manages the vault without going through the conversation at all:

- Lists every saved host with a masked address and account, its authentication type, shell, and whether a
  password and a sudo password are stored.
- **Add, edit, and delete** connections. A password typed here travels in a same-origin POST body, so it
  **never enters the session log** — unlike `ssh_hosts add password=...`.
- **Password or private key** authentication. Pick the radio, then either type the password or upload the
  private key file; an uploaded key is written into the vault directory and its permissions tightened
  automatically, so you never have to fight file ACLs. A `.pub` file or a non-key file is rejected on the
  spot.
- **Test connection** runs the same probe as `ssh_probe` and shows the result inline, including the failure
  attribution.

## `/ssh` in the conversation

```
/ssh                 list every configured host
/ssh kali            probe one host and show the result
/ssh kali win10      probe several at once
```

The command runs on the host and its outcome lands in the session as a command node, so the model sees
which environment you just activated without being told.

## Usage

```
# Record a host (the password enters the session log here, then is encrypted)
ssh_hosts  action=add  alias=vm-centos  host=192.0.2.10  port=22
           username=root  password=...  description="Local CentOS VM"  tags=["vm","centos"]

# Everyday use — alias only
ssh_probe  host=vm-centos
ssh_run    host=vm-centos  command="systemctl status sshd"
ssh_transfer  host=vm-centos  direction=upload  local=./dist/app.tar  remote=/tmp/app.tar
```

`ssh_hosts list` masks addresses and accounts by default (`192.0.*.*`, `r***`); pass `reveal=true` to see
the full values. The password is never returned under any circumstances — `show` only reports
`set (stored encrypted)`.

### Long tasks: remote detach + condition waiting

For anything measured in minutes — upgrades, disk work, scans — use `detach` to run the command **on the
remote host**, detached from the SSH session:

```
ssh_run  host=kali  command="apt -y full-upgrade"  sudo=true  detach=true
→ [dsh-ssh-vault] started in the background on the remote host: pid=6676
  [dsh-ssh-vault] log: /tmp/.dsh-ssh-<token>.log
  [dsh-ssh-vault] liveness: ps -p 6676 >/dev/null 2>&1 && echo ALIVE || echo GONE
```

The local call returns in about a second, and the remote process is independent of it: a dropped link, a
cancelled call, or a proxy timeout all leave it running. This is more reliable than a long-lived local
connection — the pid and the log stay on the remote host, ready to inspect later.

Then **do not poll with `sleep`**; wait once with `wait_for`:

```
ssh_run  host=kali  wait_for={path: "/tmp/dsh-upgrade.log", regex: "Upgrade complete", timeoutMs: 900000}
```

On success it returns the matching line; on timeout it exits `124` and says so. The wait can itself go to
the background:

```
ssh_run  host=kali  wait_for={path: "/var/log/upgrade.log", regex: "complete"}  run_in_background=true
```

Having the command write its own completion marker makes the condition most reliable:
`command="...; echo DONE > /tmp/job.done"` followed by `wait_for={path: "/tmp/job.done"}`. A full
"start + wait" flow is then two calls instead of a dozen sleeps.

### Privileged work: sudo without the conversation

Do not write `echo <password> | sudo -S` — that puts the password into the tool arguments, the session log,
and the remote `ps`. Use `sudo: true` instead:

```
ssh_run  host=kali  command="apt update && apt -y full-upgrade"  sudo=true
```

The plugin takes the password from the vault and primes the sudo credential cache **through SSH's standard
input**. The password therefore does not appear in:

- tool arguments or the session log (the call only says `sudo: true`);
- the local command line or the `ssh` process arguments;
- the remote command line or the remote `ps` output (it travels on stdin and is never written down).

When the host has no separate password, the login password is reused. When the sudo password differs, store
it with `ssh_hosts action=update sudoPassword=...`. A failed prime reports "the stored password may not be
this account's sudo password, or sudoers requires a tty" rather than leaving you guessing.

> If a command writes `sudo -S` while `sudo: true` is not set, the result carries a hint.
> When sudo fails to obtain a password (`a terminal is required`), the diagnosis names it — and warns about
> the **pipeline trap**: the exit code of `sudo ... | grep ...` comes from the last stage, so a failed sudo
> can still return 0 and look like "empty output".

### Passwords that never pass through the model: offline entry (recommended)

`ssh_hosts add password=...` writes the password into the session log. `credentialRef` avoids the
conversation but puts the password into a **plaintext** YAML file. **You do not have to choose.** Enter it
from your own terminal, straight into the encrypted vault:

```powershell
cd <package directory>
node scripts/set-secret.mjs kali          # interactive, no echo
node scripts/set-secret.mjs kali --sudo   # set a separate sudo password
node scripts/set-secret.mjs kali --show   # inspect state only
```

Where the plaintext exists along this path:

| Stage | Where the plaintext is |
| --- | --- |
| Entry | Only in your terminal (no echo); never through DSH, the model, or the session log |
| At rest | `vault.json` ciphertext (AES-256-GCM); the data key is wrapped by DPAPI |
| In use | Decrypted in **memory**, handed to `ssh` via askpass, discarded afterwards |

So there is **no need** to "write it to disk and encrypt it back later": the plugin already decrypts only
when needed. Introducing a temporary plaintext file would add an exposure window, not remove one.

Set `$env:DSH_HOME` before running the script if the harness uses a custom data directory, otherwise it
will look in `~/.dsh`.

### Passwords that never pass through the conversation: credentialRef

Keep only the **credential name** in the host record and let the Harness credential store supply the value:

```
# 1) Add a line under refs in %DSH_HOME%\.credentials.yaml (or use the Harness credentials UI).
#    Quote the value: a bare number is parsed as an integer by YAML, and : # @ need quoting anyway.
refs:
  KALI_SSH_PASSWORD: "<password>"

# 2) Keep only the reference in the host record; setting it clears the vault's own copy
ssh_hosts  action=update  alias=kali  credentialRef=KALI_SSH_PASSWORD
```

The model and the conversation never see the password; `ssh_hosts show` reports only `credentialRef: ...`
and `password: missing`.

> **Two limits worth knowing**
>
> 1. **That file is plaintext YAML.** `%DSH_HOME%\.credentials.yaml` sits next to `DEEPSEEK_API_KEY`
>    unencrypted. So `credentialRef` buys "no password in the conversation", **not** "encrypted at rest" —
>    the two are mutually exclusive here: the vault's own `password` is ciphertext but passes through the
>    conversation on entry; `credentialRef` avoids the conversation but lands in plaintext. The offline
>    entry script satisfies both.
> 2. **The provider reads credentials at startup.** After adding or editing `refs` you must **restart DSH
>    Desktop**; until then the host reports the reference as unavailable.
>
> **A stale reference does not brick the host.** If `credentialRef` is unavailable but the vault still holds
> a password, the plugin **falls back** to it and says so in the result: "…is currently unavailable; this
> call fell back to the password stored in the vault." An environment problem therefore no longer looks
> like an authentication failure, and a running background task is not interrupted. It only errors when
> there is no password to fall back to either.

### Out-of-band management: binding the source address

When a rule change would cut the management path, preset a source address on the host, or override it per
call:

```
ssh_hosts  action=update  alias=kali  bindAddress=192.0.2.150
ssh_run    host=kali  command="ip addr add 192.0.2.150/24 dev eth0"  bindAddress=192.0.2.150
```

`ssh` uses `-b`; `scp` uses `-o BindAddress=`.

## Windows targets and restricted environments

### Set the shell to cmd or powershell

Windows' login shell is `cmd.exe`, where POSIX commands and multi-line scripts do not work:

```
ssh_hosts  action=update  alias=win-box  shell=powershell
```

The plugin then feeds the command through `powershell -NoProfile -NonInteractive -Command -` on standard
input, and `ssh_probe` switches to `whoami` / version / boot time instead of failing on `uname`.

> **Observed:** `cmd` echoes its version banner and prompt (`Microsoft Windows [Version ...]`,
> `C:\Users\...>`) when reading commands from a pipe. It works, but the output is noisy. **Use `powershell`
> when you want clean output** — its self-check reads like `identity: user@WIN10` /
> `os: Microsoft Windows 10 Enterprise LTSC`.

For real work, upload a `.ps1` and run it with `powershell -File`, treating `ssh_run` as the transport. Two
known encoding traps:

- A `.ps1` containing non-ASCII text must be **UTF-8 with BOM**, or PowerShell 5.1 parses it as ANSI and
  reports `Unexpected token`.
- If console output is garbled, set `[Console]::OutputEncoding = [Text.Encoding]::UTF8` and `chcp 65001` at
  the top of the script.

### Private keys: a public key cannot log in, and permissions must be tight

- `privateKeyPath` is validated **at save time**: a `.pub` file, a PuTTY `.ppk`, or a file that is not a key
  at all is rejected immediately, instead of surfacing later as an authentication failure.
- `UNPROTECTED PRIVATE KEY FILE` / `Permissions for ... are too open` means the ssh client **refused to load
  the key itself** — it has nothing to do with the account or password on the server. The plugin reports it
  as the first conclusion rather than blaming the password.
- Where a restricted sandbox forbids changing ACLs, copy the key into the vault directory
  (`%DSH_HOME%\ssh-vault`) and point the host record at the copy.

### Where Windows administrators' authorized_keys live

Windows OpenSSH applies `Match Group administrators`:

```
__PROGRAMDATA__/ssh/administrators_authorized_keys
```

For an administrator account the public key must go in that file (which must be readable only by
Administrators and SYSTEM). Putting it in the user profile's `.ssh\authorized_keys` has no effect. The
plugin states this explicitly when it receives `Permission denied (publickey...)`.

### Readable error paths

ssh escapes non-ASCII paths into forms like `E:\\ai project\\\346\223\215\344\275\234\\id_rsa`. The plugin
decodes those octal escapes back to UTF-8, so the message is readable.

### known_hosts and user configuration

The plugin always uses `known_hosts` inside the vault directory (with `HashKnownHosts` on) and **never
writes `~/.ssh`**, so the sandbox error `Could not create directory 'C:\Users\...\.ssh'` cannot come from
it. Use `knownHostsFile` to relocate it, or `sshConfigFile` to point at — or (`none`) to suppress — the
user-level ssh configuration.

### Pipelines that hide output

Output from `ssh ... | grep -v ...` stays in the remote pipeline buffer; while the command hangs, nothing
comes back. Workarounds:

- use `detach` for long commands;
- add `stdbuf -oL` on the remote side when you need filtered output live
  (`stdbuf -oL journalctl -f | grep -v cron`);
- split into smaller commands, one call each, or write results to a remote file and read it back.

## Configuration

Override the `ssh-vault` row's `config` in the profile's `cordis.patch.yml` (`config` is replaced wholesale,
not deep-merged):

```yaml
- id: ssh-vault
  config:
    keyProtection: dpapi        # dpapi | file | passphrase
    masterPassword: ''          # only for passphrase mode
    vaultDir: ''                # defaults to %DSH_HOME%\ssh-vault
    knownHostsFile: ''          # defaults to <vaultDir>\known_hosts
    sshConfigFile: ''           # passed to ssh -F
    sshExecutable: ssh
    scpExecutable: scp
    connectTimeoutSec: 10
    defaultTimeoutMs: 120000
    maxOutputBytes: 200000
    maskHostAddress: true       # false makes list/show reveal addresses by default
```

## Troubleshooting

The plugin attributes failures in order — **local key → server authentication → transport** — and only says
"wrong account or password" once the earlier causes are excluded.

- **Local key permissions / `.pub` used as a key / PPK**: see "Private keys" above.
- **`Permission denied (publickey)`**: the public key is not installed on the target; see the Windows
  administrator note above.
- **`Permission denied, please try again.`**: wrong password — fix it with `ssh_hosts action=update`.
- **`Too many authentication failures`**: the client tried too many keys; use an explicit password or
  `privateKeyPath`.
- **Network unreachable / connection refused**: check the subnet and firewall. If `bindAddress` is set,
  confirm the source address is still on an interface — an address added manually with `ip addr add` is lost
  on DHCP renewal.
- **Connection closed during handshake**: usually a firewall or security group dropping packets, not
  authentication.
- **Host key changed** (target rebuilt): delete its entry from the vault's `known_hosts` and reconnect.
- **Remote shell missing**: set `shell: /bin/sh` for Linux, or `cmd` / `powershell` for Windows.
- **`key.json` cannot be decrypted**: the key is bound to the Windows user that created it. If the inventory
  can be rebuilt, delete `key.json` and `vault.json` and re-enter the hosts.

## Tests

Four regression scripts live in `test/`; only two need a real target, and none of them contains a credential.

```powershell
npm test                   # the three host-free suites (this is what CI runs)

node test/diagnose.mjs     # shell translation, octal decoding, failure attribution
node test/unit.mjs         # ssh/scp argument construction, timeout/cancel output retention, wait/detach scripts
node test/background.mjs   # background job registration contract

# needs a real target
$env:LIVE_KALI_HOST = '<host>'
$env:LIVE_KALI_USER = '<user>'
$env:LIVE_KALI_PASS = '<password>'
$env:LIVE_WIN_HOST  = '<host>'
$env:LIVE_WIN_USER  = '<user>'
$env:LIVE_WIN_KEY   = '<private key path>'
node test/live.mjs
node test/selftest.mjs
```

The three host-free suites skip the cases that need to spawn a child process under a restricted sandbox
(`EPERM`) and report the skip; everything else still runs. Each script uses its own temporary directory and
never touches a real vault.

Current state: **89 host-free unit cases** plus **25 live end-to-end cases** against a Kali and a Windows 10
target.

## Package layout

```
package.json            bundle manifest (dsh.bundle.patch points at cordis.patch.yml)
cordis.patch.yml        Loader row definition (id: ssh-vault)
index.js                plugin entry and the four model-facing tools
client.js               browser half: the Settings → SSH Connections page and the /ssh command surface
lib/vault-api.js        same-origin JSON routes behind the settings page
lib/vault.js            AES-256-GCM vault + DPAPI / scrypt key protection
lib/ssh.js              OpenSSH driver: argument construction, askpass, attribution, wait/detach scripts
lib/background.js       ctx.jobs background task adapter
scripts/set-secret.mjs  offline password entry (neither DSH nor the model is involved)
locale/{zh,en}.json     plugin manager title and description
icon.svg                plugin card icon
README.md               this file (English)
README.zh-CN.md         中文说明
CHANGELOG.md            version history
CONTRIBUTING.md         red lines, code style, testing requirements
SECURITY.md             security boundaries and vulnerability reporting
LICENSE                 MIT
test/                   regression; the first three need no host, the rest need a real target (not shipped)
dist/                   build artifacts, tgz / zip (not shipped)
```

The published file list is the `files` allowlist in `package.json`. Repack after changing files:

```powershell
$env:npm_config_cache = "$PWD\.npm-cache"
npm pack --pack-destination dist
Remove-Item .npm-cache -Recurse -Force
```

## Contributing

Issues and pull requests are welcome. **Read [CONTRIBUTING.md](CONTRIBUTING.md) first** — this plugin stores
other people's passwords and runs commands on their machines, so that document defines the red lines and the
testing requirements.

```powershell
npm test
```

Version history is in [CHANGELOG.md](CHANGELOG.md); security boundaries and reporting are in
[SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
