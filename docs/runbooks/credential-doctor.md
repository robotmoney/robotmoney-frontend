# Credential Doctor

Audits, configures, and revokes credentials for the Robot Money GitOps deployment
across **staging** and **production** environments. Implements the credential
inventory defined in [deployment.md](./deployment.md).

## Problem

Deploying to staging and production requires ~15 secrets and ~6 variables per
environment — Cloudflare API tokens, DigitalOcean tokens, SSH keys, database URLs,
Origin CA certificates, and application tokens — stored as **GitHub Environment
secrets**. Without a credential tool, provisioning an environment from scratch
means:

1. Manually generating or collecting each secret from the vendor dashboard.
2. Validating each token against its API.
3. Encrypting and uploading each value to GitHub via its public-key API.
4. Ensuring staging and production have isolated credentials.

The credential doctor automates all four steps while never printing secret values
to stdout.

## Architecture

```
┌──────────────────────────────────────────────────────┐
│               Credential Doctor                       │
│                                                       │
│  ┌─────────────────┐                                 │
│  │  Encrypted vault │  ~/.config/robotmoney/gitops/   │
│  │  (sodium secretbox│  credentials.enc.json          │
│  │   + Argon2id)    │                                 │
│  └────────┬────────┘                                 │
│           │ read/write                                │
│  ┌────────▼────────┐     ┌─────────────────────┐     │
│  │  Menu / Router   │────▶│  GitHub API         │     │
│  │                  │     │  (secrets + vars)   │     │
│  │  1. Admin keys   │     └─────────────────────┘     │
│  │  2. Deploy keys  │     ┌─────────────────────┐     │
│  │  3. Publish      │────▶│  Cloudflare API     │     │
│  │  4. Full pipeline│     │  (token mint +      │     │
│  │  5. Audit        │     │   origin cert)      │     │
│  │  6. Revoke       │     └─────────────────────┘     │
│  └─────────────────┘     ┌─────────────────────┐     │
│                          │  DigitalOcean API   │     │
│                          │  (Spaces keys)      │     │
│                          └─────────────────────┘     │
└──────────────────────────────────────────────────────┘
```

Credentials flow through three layers:

- **Local vault** (`~/.config/robotmoney/gitops/credentials.enc.json`) — an
  encrypted JSON file holding both admin bootstrap keys and deployment
  credentials. Encrypted with **libsodium secretbox** using a key derived from
  your passphrase via **Argon2id**. The vault lives outside the repository.
- **Admin bootstrap keys** (`vault.admin`) — long-lived tokens that are stored
  **only in the local vault** and never uploaded to GitHub. These are used to
  mint scoped deployment tokens via vendor APIs (Cloudflare, DigitalOcean).
- **Deployment credentials** (`vault.deployment[environment]`) — the actual
  secrets and variables pushed to GitHub Environment secrets. Each environment
  (staging, production) gets its own complete set.

## Credential inventory

### Admin bootstrap keys (local vault only — never uploaded)

| Key | Purpose |
|-----|---------|
| `GITHUB_ADMIN_TOKEN` | Manages repo Environments, secrets, and variables via the GitHub API. |
| `CF_BOOTSTRAP_TOKEN` | Mints environment-scoped Cloudflare API tokens and provisions Origin CA certificates. |
| `DO_BOOTSTRAP_TOKEN` | Creates bucket-scoped DigitalOcean Spaces keys. Optional — only needed if you want automated Spaces key creation. |

### Deployment secrets (pushed to GitHub)

| Secret | Source | Validated |
|--------|--------|-----------|
| `ADMIN_TOKEN` | Generated (64-char hex) | ≥32 chars |
| `ANALYTICS_TOKEN` | Generated (64-char hex) | ≥32 chars |
| `SSH_PRIVATE_KEY` | Generated (ed25519 keypair) | OpenSSH format |
| `CF_API_TOKEN` | Minter from `CF_BOOTSTRAP_TOKEN` or manual entry | Cloudflare `/verify` |
| `CF_ORIGIN_CERT` | Provisioned from Cloudflare Origin CA or file | PEM certificate |
| `CF_ORIGIN_KEY` | Generated alongside the Origin CA cert | PEM private key |
| `DO_API_TOKEN` | Manual entry | DigitalOcean `/account` |
| `DO_SPACES_KEY` | Created via DO API from `DO_API_TOKEN` or manual | ≥16 chars |
| `DO_SPACES_SECRET` | Created alongside `DO_SPACES_KEY` or manual | ≥32 chars |
| `DATABASE_URL` | Manual entry | Postgres URL + `sslmode=require` |
| `DO_DB_CA_CERT` (optional) | File | PEM certificate |
| `FRED_API_KEY` (optional) | Manual entry | 32-char format + live FRED API check |

`FRED_API_KEY` is an application/data secret needed only for live macro
analytics series; the app runs seeded without it.

`ANALYTICS_TOKEN` is the analytics-provider bearer (issue #106): the **api**
process verifies it on `POST /api/swarm/regime` and every `/api/analytics/*`
route, and the **worker** presents the same value when its updater jobs submit
computed outputs through that boundary (`ANALYTICS_API_URL` points the worker at
the api; docker-compose defaults it to `http://api:8787`). The worker refuses to
boot in smoke/prod without it. It is never a substitute for `ADMIN_TOKEN` and
vice versa. Optionally, `WORKER_DATABASE_URL` points the worker's pool at the
restricted `rm_worker` role (migration `0016_worker_role.sql`; password set by
the operator, never baked in a migration) so database permissions also deny the
worker any analytics-table write.

### Deployment variables (pushed to GitHub, readable)

| Variable | Validation |
|----------|-----------|
| `CF_ACCOUNT_ID` | 32-char hex |
| `CF_ZONE_ID` | 32-char hex |
| `SPACES_BUCKET` | DNS-compatible bucket name |
| `SPACES_REGION` | e.g. `nyc3` |
| `SPACES_ENDPOINT` | HTTPS URL |

## Modes

### Interactive menu (`bun run credentials`)

Unlocks (or creates) the encrypted vault, migrates any legacy plaintext
credentials, and presents a menu:

1. **Configure admin bootstrap keys** — stage `GITHUB_ADMIN_TOKEN`,
   `CF_BOOTSTRAP_TOKEN`, and `DO_BOOTSTRAP_TOKEN` in the local vault. Validates
   each against its vendor API before storing.
2. **Collect/generate deployment credentials** — walks through every secret and
   variable for each environment. Automates token minting via Cloudflare and
   DigitalOcean when bootstrap keys are available; generates SSH keys and
   application tokens locally; prompts for the rest.
3. **Publish credentials to GitHub** — uploads vaulted credentials to GitHub
   Environment secrets using the GitHub public-key encryption API. Creates
   environments if they don't exist.
4. **Full pipeline (1 → 2 → 3)** — runs all three steps sequentially.
5. **Read-only audit** — checks GitHub for missing credentials without making
   changes.
6. **Revoke credentials** — deletes secrets from GitHub and revokes them at the
   vendor (Cloudflare token revocation, etc.). Removes from the vault.

### Read-only check (`bun run credentials:check`)

Non-interactive; suitable for CI or local pre-flight. Lists every required
secret and variable against what is actually stored on GitHub. Exits non-zero
when anything is missing.

## Security model

- **Secrets never printed.** All secret input uses a hidden prompt (no echo).
- **Encrypted at rest.** The local vault uses symmetric encryption with a
  passphrase-derived key. The passphrase is never stored.
- **Encrypted in transit.** GitHub secrets are encrypted with the repository's
  public key (`crypto_box_seal`) before upload. GitHub never returns secret
  values via the API, so the doctor can only prove existence, not correctness.
- **Admin/deployment separation.** Bootstrap tokens are never uploaded to
  GitHub. Deployment credentials are validated to be different from their
  admin counterpart (e.g. `DO_API_TOKEN` ≠ `DO_BOOTSTRAP_TOKEN`).
- **Environment isolation.** Each environment gets its own GitHub Environment
  with its own secrets. Credentials are never shared.
- **Validation before upload.** Vendor tokens are verified against their API
  (Cloudflare `/verify`, DigitalOcean `/account`, GitHub `/user`) before being
  stored. Application tokens are validated for length and format.

## Usage

```sh
# Interactive: audit both environments and configure missing values.
bun run credentials

# Read-only: suitable for local checks and CI.
bun run credentials:check

# Limit to one environment.
bun run credentials -- --environment staging

# Specify a custom vault path.
bun run credentials -- --vault /path/to/vault.enc.json

# Override the inferred GitHub repository.
bun run credentials -- --repo robotmoney/robotmoney-frontend
```

## Revocation

The revoke step (menu option 6) walks through every credential in the vault for
each environment, offering to delete each one from GitHub and revoke it at the
vendor. Cloudflare tokens are revoked via the API; DigitalOcean tokens and keys
are deleted from GitHub only (the doctor cannot revoke DO tokens via the API —
do that from the DO dashboard).
