<!-- Keep it short. Reviewers read the diff anyway. -->

## What changed

## Why

## How it was verified

<!--
`npm test` output, plus which live target you used if the change touches a real connection path.
-->

## Checklist

- [ ] `npm test` passes
- [ ] No credential, private key, or real host address in the diff (CI enforces this too)
- [ ] New behaviour is pinned by at least one unit case
- [ ] README / CHANGELOG updated when the behaviour is user-visible

## Red-line impact

<!-- CONTRIBUTING.md section 1. Delete what does not apply. -->

- [ ] No new execution path: a password still never reaches a command line, a remote `ps`, or the session log
- [ ] No new runtime dependency
- [ ] Does not touch the user's profile, `%DSH_HOME%\.credentials.yaml`, or `~/.ssh`
- [ ] Vault format unchanged — or: version bumped with a migration path for existing vaults

## Session-log impact

<!-- Does any new tool parameter carry sensitive data into the session record? -->
