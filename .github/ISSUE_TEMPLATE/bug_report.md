---
name: Bug report
about: Something does not work as documented
title: ''
labels: bug
assignees: ''

---

<!--
Do NOT paste passwords, private keys, credential files, or real host addresses.
Use documentation addresses instead: 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24.
Issues containing credentials will be redacted and closed.
-->

## What happened

<!-- The exact tool call and the result you got. Redact credentials and addresses. -->

## What you expected

## Steps to reproduce

1.
2.

## Environment

| | |
| --- | --- |
| DSH Desktop version | |
| Plugin version (from `package.json`) | |
| Host OS | |
| Remote target | Linux / Windows / both |
| `ssh -V` on the machine running DSH | |
| Vault key protection | `dpapi` / `file` / `passphrase` |

## Diagnostics

<!--
`ssh_probe` output plus the tool's own diagnosis lines are the most useful thing you can attach:
they already mask addresses and accounts, and they name the layer that failed
(local key / server authentication / transport).
-->
