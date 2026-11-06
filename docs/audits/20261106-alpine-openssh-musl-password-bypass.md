# Alpine images vs. the OpenSSH musl password-bypass (OpenSSH 10.6p2)

**Date:** 2026-11-06
**Base:** `main` @ `e8207c0f`
**Scope:** every Alpine Linux image this repo builds or runs. The `postgres:16-alpine` and `python:3-alpine` images that `robotmoney-core`'s dapp testnet compose file uses are included for the same org.
**Verdict:** **Not exposed.** No Alpine image here runs `sshd`. The flaw is reachable only through a running `sshd`.

---

## The flaw

Source: The Hacker News, "OpenSSH issues emergency fix for flaw", 2026-11-05
(<https://thehackernews.com/2026/11/openssh-issues-emergency-fix-for-flaw.html>).
The upstream references are the Alpine advisory
(<https://alpinelinux.org/posts/2026-11-05-openssh-password-authentication-bypass/>)
and the OpenSSH 10.6p2 release notes. No CVE had been assigned when this audit was written.

- **Component:** `sshd` (server) only. The client is not affected.
- **Platform:** musl-based Linux only, such as Alpine. glibc distros, non-Linux systems and PAM-based password checks are not affected.
- **Mechanism:** without PAM, `sshd` hashes the password with another account's salt for an account whose password field is `*`. musl's `crypt()` returns `*` for `$5$`/`$6$` input longer than 256 bytes. That `*` matches the stored `*`.
- **Preconditions (all required):** `openssh-server` built without PAM (or `openssh-server-pam` with `UsePAM no`). `PasswordAuthentication yes`, the default. A target account with `*` as its password. At least one other account with a `$5$`/`$6$` hash. Network reach to `sshd`.
- **Fix:** OpenSSH 10.6p2. Alpine point releases 3.21.10, 3.22.8, 3.23.8 and 3.24.4. A running `sshd` must be restarted after `apk upgrade`.

## Inventory and evidence

Each image was pulled on 2026-11-06 and run with a script that prints `/etc/alpine-release`, runs `apk info -e openssh-server openssh-server-pam openssh-client`, and runs `command -v sshd`.

| Image | Where | Alpine | `sshd` / openssh pkgs | Exposed |
| --- | --- | --- | --- | --- |
| `nginx:1.27-alpine` | `website-server/Dockerfile` (prod website-server, `stacks/robotmoney-swarm/containers/website/build.sh`) | 3.21.3 | none | No |
| `postgres:17-alpine` | `docker-compose.yml` (smoke / demo stack) | 3.24.4 | none | No |
| `postgres:16-alpine@sha256:7218…` | `robotmoney-core` `testing/ethereum-testnet/config/docker-compose.dapp.yaml` | 3.24.2 | none | No |
| `python:3-alpine@sha256:f6a5…` | same `robotmoney-core` compose file | 3.24.2 | none | No |

Also checked:

- `backend/Dockerfile` (api, producer) is `oven/bun:1.4.4`, which is Debian/glibc. It is out of scope.
- No `Dockerfile`, compose file or stack manifest in this repo installs `openssh-server` or starts `sshd`.
- The images are pulled from upstream and nothing adds a user with a password, so the account preconditions are not met either.

## Follow-ups (hygiene, not exposure)

- `nginx:1.27-alpine` is on Alpine 3.21.3, which is below the 3.21.10 fix. It ships no `sshd`, so this is not exposure. Moving to a current `nginx:*-alpine` tag clears scanner noise once a CVE is published.
- The two `robotmoney-core` images are pinned by digest to Alpine 3.24.2. Re-pin them on the next routine digest bump.
- `postgres:17-alpine` is unpinned. It already resolves to the fixed 3.24.4.
- If a future image adds `openssh-server` on Alpine, set `PasswordAuthentication no` in it.
