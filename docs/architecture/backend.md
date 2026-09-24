# Backend

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
- `src/db/` — connection pools (`client.ts` for the API/migrations;
  `worker-client.ts` for the worker's queue-scoped access, honoring
  `WORKER_DATABASE_URL` → the restricted `rm_worker` role of migration
  `0016_worker_role.sql`) and the migration runner (`migrate.ts`).
- `src/lib/` — small helpers (e.g. `keys.ts`, sha256 access-key hashing).
- `migrations/` — forward-only numbered `*.sql`, applied once each, tracked in
  `schema_migrations`. In production a migration is its own operator step
  (`bun run migrate`, with the `rm_owner` password typed at the terminal and
  receipted), never part of a boot; the `--migrate` flag is a rehearsal-only
  convenience for stage, test and CI. See
  [smoke-production-spec §8.5](../technical/smoke-production-spec.md#85---migrate-and-production-upgrades)
  and [§9](../technical/smoke-production-spec.md#9-production).
  All database access under the adopted design goes through one registered
  query interface that declares `(role, object, privilege)` at the call site
  ([smoke-production-spec §7.1](../technical/smoke-production-spec.md#71-registry-enforced-structurally));
  the roles are `rm_owner` (schema owner, `LOGIN`, migration only), `rm_app`,
  `rm_worker` and `rm_readonly`, and there is no `rm_migrator`
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
  participant's bearer (in its entry) and three service tokens — scheduler,
  analytics producer and operator admin — which are per-instance files whose
  hashes and rights sit in the API's token store. Database role passwords are
  held at runtime by `api` and the pipeline worker. Model keys are held by the
  agents and judges that call a model. `system-scheduler` holds only its
  service token. No secret or env file lives in repository source. See
  [system-scheduler-spec §7](../technical/system-scheduler-spec.md#7-credentials)
  and [smoke-production-spec §3](../technical/smoke-production-spec.md#3-roles-and-credentials).
  The pipeline worker's `rm_worker` role is governed by smoke spec §7.2.
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
  token (scheduler spec §7), the public reads only — enforced in the API layer
  (`src/api/auth.ts` holds the shared constant-time credential checks). The
  worker's own database role is restricted too: migration `0016_worker_role.sql`
  provisions `rm_worker`, which can run the queue lifecycle and the non-analytics
  samplers but is DENIED insert/update/delete on the analytics data tables, so
  the API boundary is backed by database permissions. Migration
  `0007_committee_rls_stub.sql` documents deferred Postgres RLS; it is
  intentionally not active until requests use transaction-scoped database roles.

---
