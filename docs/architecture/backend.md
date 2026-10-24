# Backend

> **Referrals:** [Referral specification](../technical/referrals-spec.md) (accepted
> 2026-10-19, implemented by issue 1371). Shipped surfaces:
>
> - `GET /api/referrals/codes/:code` (`api/routes/referrals.ts`, answer in
>   `referrals/lookup.ts`): public, one code per request, the exact §6 bodies,
>   uniform 404, `Cache-Control: public, max-age=60` on 200 and 404, its own
>   instance of `api/rate-limit.ts` at 100 requests per 60 s per trusted client ip
>   (`api/client-ip.ts`), 429 and 503 `no-store`. One database read: the member row
>   by primary key through a registered `rm_app` query. No chain read.
> - `GET /api/admin/referrals/corrections` (`api/routes/admin.ts`): privileged,
>   read-only view of the correction log with its signature, nonce, expiry and code
>   checks (EIP-1271 costs one `eth_call` through the shared transport).
> - `AdminMember.referral` on every admin member response (`swarm/admin.ts`
>   `toMemberAdmin`), from the registry file; no public member DTO carries it.
> - The operator report CLI `backend/scripts/referrals-report.ts` (`scan`,
>   `explain`, `verify`): finalized cutoff by number and hash, bounded log ranges
>   with a local checkpoint file, evidence through `ethGetBlockHeader`,
>   `ethGetTransactionReceiptBatch`, `ethGetTransactionByHashBatch` and
>   `ethGetBlockHeaderBatch` in `chain/base-rpc-client.ts`, canonical payload and
>   digest via `analytics/run-ledger.ts`, private JSON/CSV/provenance/receipt
>   artifacts. It opens no database and is run by an agent from the control
>   machine (D61). Release revisions are recorded by
>   `backend/scripts/referrals-accept-revision.ts`.
>
> No request path scans the chain. The existing boundaries below remain authoritative.

Part of the [architecture](README.md). Split out of the former single `docs/architecture.md` on 2026-09-23; section numbering inside is unchanged so old citations still resolve.

## 5. Backend

A small server on **Bun** using `Bun.serve` — no framework, no build (Bun runs the
TypeScript sources directly).

- `src/api/index.ts` — the `Bun.serve` entry: a `/health` check and the API routes
  (`comments`, `dashboards`, `swarm`, `projects`, `admin`, `analytics`), using
  `postgres` (postgres.js) with raw SQL. This process ships **no static-serving
  code at all** (issue #892) — see `website-server/` below.
- `src/worker/` — the always-on task-queue worker (see §7).

**`website-server/`** — a plain `nginx:alpine` image (`website-server/Dockerfile`
+ `website-server/nginx.conf`), split out of the api image (issue #892). Serves
the assembled `_static/` (bind-mounted, never baked into the image) with a
`try_files` fallback rule replicating the old `routeShell()`'s order
(`<route>/index.html` → `_shell.html` → `index.html`), and proxies `/api/` +
`/health` through to the `api` service so the pair still present as one
same-origin surface (no CORS, no client change) wherever nothing else fronts
them — this repo's own local dev/smoke/e2e harness included.
- `src/db/` — connection pools (`client.ts` for the API and migrations) and
  the migration runner (`migrate.ts`). The api is the only process holding a
  database credential ([D75](../decisions.md#d75)): the pipeline worker
  claims, renews and settles jobs and reads and writes its data through
  `/api/pipeline/**` (`src/api/routes/pipeline.ts`, the stores under
  `src/pipeline/`), with the pipeline-worker service token, an
  `Idempotency-Key` on every write and its lease `(jobId, workerId, attempt)`
  as a fence. Those routes run on the batch pool behind a per-token admission
  gate (`PIPELINE_TOKEN_CONCURRENCY`, default 2) and refuse a write above
  1,000 rows or 1 MiB with 413.
  At boot the api derives its connection budget from the server's
  `max_connections` minus the reserved slots and a headroom
  (`connection-budget.ts`), and refuses to start when an override does not
  fit. It then runs three pools: a **request** pool for public, member and
  admin routes, whose statement, lock, idle-in-transaction and connect timeouts
  sit below the 10 s request deadline; a **batch** pool for the analytics
  provider's bulk routes, with the long bulk timeouts; and one connection for
  the `/health` probe, so health never waits behind a busy pool. Each pool has
  an admission gate (`pool-gate.ts`): a query that finds no free connection
  within `PG_ADMISSION_WAIT_MS` is answered `503 db_saturated` with
  `Retry-After`, a statement or lock timeout is answered `503 db_timeout`, and
  `/health` reports each pool's counts under `db_pool` (issue 1034).
- `src/lib/` — small helpers (e.g. `keys.ts`, sha256 access-key hashing).
- `migrations/` — forward-only numbered `*.sql`, applied once each, tracked in
  `schema_migrations`. In production a migration is its own operator step
  (`bun run migrate --confirm-target <host:port/database>`, with the `rm_owner`
  password read from `~/.env` and receipted, [D61](../decisions.md#d61)), never part of a boot; the `--migrate` flag is a rehearsal-only
  convenience for stage, test and CI. See
  [smoke-production-spec §8.5](../technical/smoke-production-spec.md#85---migrate-and-production-upgrades)
  and [§9](../technical/smoke-production-spec.md#9-production).
  All database access under the adopted design goes through one registered
  query interface that declares `(role, object, privilege)` at the call site
  ([smoke-production-spec §7.1](../technical/smoke-production-spec.md#71-registry-enforced-structurally));
  the roles are `rm_owner` (schema owner, `LOGIN`, migration only), `rm_app`
  and `rm_readonly` (`rm_worker` still exists but holds nothing since 0127,
  [D75](../decisions.md#d75)), and there is no separate migration role
  ([§3](../technical/smoke-production-spec.md#3-roles-and-credentials)).

### Authentication & authorization

Four distinctions, kept deliberately separate:

- **Transport/identity vs authorship.** *Identity* answers "who is calling";
  *authorship* answers "whose data this is." They are independent checks — an
  authenticated caller still must prove a write is genuinely theirs.
- **One identity mechanism.** The **REST API** (browser/dashboards, plus the
  submit/onboarding endpoints — the only transport since D21 retired the MCP
  surface's OAuth 2.1 authorization server) uses the sha256 **access-key** hash
  (`keys.ts`). Public reads need neither.
- **Authorship = member signature.** Recommendations carry a signature the member
  produces **on their own side**; the backend only **verifies** it against the
  member's registered public key. The API never holds a member's signing key.
  (This is the on-chain seam: later only the signature is anchored.)
- **Four credential kinds.** Signing keys (Ed25519) are held by participants
  only, each in its own `credential.json` entry. API bearer tokens are each
  participant's bearer (in its entry) and four service tokens — scheduler,
  analytics producer, operator admin and pipeline worker — which are
  per-instance files whose hashes and rights sit in the API's token store.
  Database role passwords are held at runtime by `api` alone. Model keys are
  held by the agents and judges that call a model. `system-scheduler` and the
  pipeline worker hold only their service tokens. No secret or env file lives in repository source. See
  [system-scheduler-spec §7](../technical/system-scheduler-spec.md#7-credentials)
  and [smoke-production-spec §3](../technical/smoke-production-spec.md#3-roles-and-credentials).
  The pipeline worker's startup check is governed by smoke spec §7.2.
- **Credential exchange and membership are separate.** Active members exchange
  their member ID and bearer credential by signing a server-issued key-proof
  challenge (`token-claim/challenge` → `token-claim`, issue #205). Swarm
  membership starts with `apply` (metadata + public key), followed by an
  administrator-controlled `applied → active` transition.
- **Scoped roles.** Every write is authorized to a role: members write only their
  own recommendations, the analytics provider only analytics data (the regime
  recompute + the typed `/api/analytics/*` ingestion routes, the analytics
  service token — the admin service token and member bearers are never
  substitutes),
  `system-scheduler` only session lifecycle transitions under its automation
  token (scheduler spec §7), the pipeline worker only `/api/pipeline/**`
  under its own token, whose operations are a fixed table
  (`src/pipeline/ops.ts`) that names values, never a statement, the public
  reads only — enforced in the API layer (`src/api/auth.ts` holds the shared
  constant-time credential checks). Migration
  `0007_committee_rls_stub.sql` documents deferred Postgres RLS; it is
  intentionally not active until requests use transaction-scoped database roles.
- **Raw analytics reads are public** (D58, issue #1095). Raw indicator history,
  asset prices, data vintages and overwrite events are readable without a
  credential under `/api/public/analytics/`, a prefix of its own (not under
  `/api/analytics/`, which stays analytics-provider-only and credentialed). The
  routes are GET only, rate limited per client ip per process, cacheable, gzip
  over 256 KB; regime outputs stay on
  `GET /api/dashboards/regime-snapshots`, which states its `source`. Reading
  `analytics_overwrite_events` as `rm_app` is migration 0112's one grant. The
  write side is unchanged: only the analytics provider writes this data.
  Raw keys are never deleted, but a value is revised in place when a fetched
  value differs beyond its source's D56 tolerance; each revision lands in
  `analytics_overwrite_events` and `source_value_versions`.
  `regime_snapshots` is a current view; the ledger (from 2026-09-21, migrations
  0058/0059) is the record of what was published. Regime ledger runs are idempotent
  per `run_key`; vintages per (run_id, tool_id). Restoring missed as-of days is tracked in #1162.

---
