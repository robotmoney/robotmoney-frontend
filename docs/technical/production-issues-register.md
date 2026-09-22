# Production issues register

**Purpose:** a living record of issues observed against **production (`rm_prod`,
DO managed Postgres)** during the 0.5.x cutover work. One row per issue, with
severity, current status, the evidence it rests on, and the next action.

**How to use:** add issues at the top of the relevant section; never rewrite a
resolved entry's history — append a dated note. Items marked **⟳ verify** rest
on a value observed earlier in the session and need a fresh production read to
confirm current state (production reads are operator-gated).

**Legend — status:** 🔴 open · 🟡 contained (occurred, no longer active, may
have residue) · 🟢 resolved · ⚪ background/prior.
**Severity:** S1 (data loss / integrity) · S2 (wrong data or spend on prod) ·
S3 (availability blip) · S4 (hygiene / latent risk).

## Summary

| ID | Title | Sev | Status |
|----|-------|-----|--------|
| P-01 | Stray simulation takes/memos written to prod by wrong-scenario driver | S2 | 🔴 |
| P-02 | Judge not producing judgements (config `off` / no model) | S3 | 🔴 |
| P-03 | No confirmed operator path to change judge config | S4 | 🔴 |
| P-04 | `shadow` still selectable as a judge mode | S4 | 🔴 (spec'd) |
| P-05 | Correct roster driver not yet running on prod | S3 | 🔴 |
| P-06 | Wrong-scenario cutover (`smoke:stage` vs `smoke:archive`) | S2 | 🟡 |
| P-07 | Parallel stack (`rm_inspect`) exhausted DB connections | S2 | 🟡 |
| P-08 | Brief downtime on in-place stack recreate (port 48787) | S3 | 🟡 |
| P-09 | `doadmin` password printed to terminal | S4 | 🟡 |
| P-10 | Schema-migration ledger drift (out-of-band 0053/0062) | S2 | 🟢 |
| P-11 | `provision-db-role-taxonomy.sh` — 5 defects | S3 | 🟢 |
| P-12 | `doadmin` used at runtime / stored in `.env` | S4 | 🟢 |
| P-13 | Judge signed template prose as real opinions (fallback) | S2 | 🟢 |
| P-14 | 502s on client UI during boot warm-up | S3 | 🟢 |
| P-00 | Prod DB overwritten with demo-stack data (2026-08-07) | S1 | ⚪ |

---

## 🔴 Open

### P-01 — Stray simulation takes/memos on prod (S2)
The mis-fired `smoke:stage` run (see P-06) wrote simulation-scenario
takes/memos — observed as sessions **720–722** — into the production database.
These are invented demo content sitting in real tables.
- **Evidence:** session notes from the wrong-driver run; the driver was killed
  after they landed. **⟳ verify** the exact ids/rows still present.
- **Next:** decide cleanup path. Per policy (*no direct postgres writes*), this
  is **not** hand-written SQL — use the app's own cancel/close/delete code paths
  or a migration/seeder. First a read to enumerate exactly what landed.

### P-02 — Judge produces no judgements (S3)
`swarm_judge_config` ships `mode='off'`, `model=NULL`. With `a42d6c5a`
("no fallback"), a judge with no model **throws `model_unconfigured` and writes
nothing** — so every session publishes **unjudged** (honest, but no judge block).
- **Evidence:** `0039:44` (mode default `off`), `judge.ts` `if (!transport)
  refuse("model_unconfigured")`. `OPENCODE_API_KEY` **is** present in
  `rm_prod-worker-swarm-1` and `rm_prod-api-1` (67 chars). **⟳ verify** the live
  config row.
- **Next:** to enable — `POST /api/swarm/admin/judge` with `mode:"enforce"` +
  a valid `model` id. Requires P-03. Note `third_party_enabled=false` is the
  *correct* default and does **not** gate the built-in worker judge.

### P-03 — No confirmed operator path to change judge config (S4)
Operator reports being unsure any admin change to the judge is possible via API
or UI. The admin surface (`isPrivileged`/`hasAutomationRole`) needs an
`X-Admin-Token` (session/credential) or `ADMIN_TOKEN`/`AUTOMATION_TOKEN` env.
- **Evidence:** `swarm-admin.ts:67`, `auth.ts`, `config.ts:736-737`.
- **Next:** confirm whether `ADMIN_TOKEN`/`AUTOMATION_TOKEN` is set in
  `rm_prod-api-1`. If neither, and insecure mode is off, there is **no**
  authorized runtime path to flip the judge — by design — and one must be
  provisioned before P-02 is actionable.

### P-04 — `shadow` still a selectable judge mode (S4)
`shadow` computes a real model opinion and withholds it — the same
compute-and-hide half-measure `a42d6c5a` removed on the fallback side. Design
intent is a binary `off | enforce` judge.
- **Evidence / plan:** see `docs/technical/judge-shadow-removal-spec.md`.
- **Next:** sign-off on the spec's open questions (reverses a 2026-09-21
  decision; branch target; driver rewrite), then implement.

### P-05 — Correct roster driver not running on prod (S3)
Target roster — **Athena, Noop, Robot Money Analyst** — should run under the
archive-scenario driver (`smoke:archive`). After P-06 the wrong driver was
killed and no correct driver was started; the three agents are seated but no
session-lifecycle loop is driving them.
- **Next:** cut over with `SMOKE_PROJECT=rm_prod bun run smoke:archive --
  --no-tui` (confirm before running; one wrong cutover already occurred). This
  is independent of P-02/P-04.

---

## 🟡 Contained (occurred; residue noted)

### P-06 — Wrong-scenario cutover (S2)
`smoke:stage` (simulation scenario) was deployed against prod instead of
`smoke:archive` (archive scenario). It ran the wrong swarm lifecycle:
onboarding evals spawned member-agent containers (**real inference spend**),
produced roster-full 409s, and wrote the stray takes now tracked as **P-01**.
Driver was killed once identified.
- **Root cause:** scenario selection — `smoke:archive` = `--smoke --static-port
  --db external --seed`; `smoke:stage` omits `--smoke` (simulation). Easy to
  confuse.
- **Residue:** P-01. **Follow-up:** guardrail so a prod cutover can't select the
  simulation scenario by omission.

### P-07 — Parallel stack connection exhaustion (S2)
A parallel inspection stack (`rm_inspect`) against the shared DO Postgres hit
"too many clients" / "remaining connection slots reserved for SUPERUSER". Torn
down before prod traffic was affected.
- **Lesson:** DO managed PG connection ceiling is shared; a second full stack
  can starve prod. Don't boot a parallel stack against the prod cluster —
  use the twin (dump-derived local copy) instead.

### P-08 — Brief downtime on in-place recreate (S3)
An in-place `smoke:stage` recreate failed its port precheck because the old
`website-server` still held **48787** (the cloudflared tunnel origin), forcing a
`docker compose down` of the old stack first — a short gap in service.
- **Lesson:** in-place recreate on the tunnel port isn't zero-downtime; sequence
  or use a fresh port + tunnel re-point.

### P-09 — `doadmin` password printed to terminal (S4)
A debug check (`${pw:-ABSENT}`) echoed the `doadmin` password to the terminal.
Rotated afterward; `doadmin` later removed from `.env` entirely.
- **Lesson:** never interpolate a secret into a shell default for a presence
  check; test with `[ -n "$var" ]` and print only length.

---

## 🟢 Resolved this cycle

### P-10 — Schema-migration ledger drift (S2)
Production's `schema_migrations` had drifted: `0053`/`0062` were applied
out-of-band via `psql` (the old provisioning script) and **never recorded** —
the exact mechanism that lets the ledger disagree with the schema.
- **Fix:** `0062` applied via the new recorded runner and recorded; ledger
  reconciled (73/73 files, 0 pending as of the fix). The standalone
  `bun run migrate` tool now **replaces** the provisioning script so every
  migration it applies is recorded. **⟳ verify** count on a fresh read.

### P-11 — `provision-db-role-taxonomy.sh` defects (S3)
Five defects in the role-taxonomy provisioning script; fixed and validated
against a throwaway Postgres. Superseded going forward by `bun run migrate`
(P-10). Slated for retirement.

### P-12 — `doadmin` at runtime / in `.env` (S4)
`doadmin` (cloud bootstrap login, CREATEROLE) must be bootstrap-only. It was
present in `.env` and reachable by runtime paths.
- **Fix:** removed from `.env`; `config.ts` refuses `doadmin` as `DATABASE_URL`
  when `RM_ENV=prod`; the migrate tool prompts for the password interactively
  (never stored) and runtime services run as `rm_app`/`rm_worker`.

### P-13 — Judge signed template prose as real opinions (S2)
Before `a42d6c5a`, a judge that couldn't reach a model recorded the aggregator's
own sentences as the judge's opinion and **signed them into a consensus
certificate**. On this branch the stage twin's judgements were 100% fallback and
every one published clean.
- **Fix:** `a42d6c5a` — every failure throws `JudgeUnavailable` and writes
  nothing; `source` is the literal `"model"`; `templateOpinion()` is unreachable
  from the judging path (test-only). In the deployed `releases-0.5.x`.

### P-14 — 502s on client UI during boot (S3)
Client UI showed no data / 502 during a down→up. Traced to a boot-warmup
transient (connections releasing during the swap), not a capacity limit — data
endpoints returned 200 once warm. (An earlier "max_connections=25" alarm was a
misread of a pooled figure; ~36 connections coexist fine.)

---

## ⚪ Background / prior incidents

### P-00 — Prod DB overwritten with demo-stack data (2026-08-07) (S1)
Hosted DO Postgres was wiped and replaced with demo-stack data. A verified
rollback dump exists at `/root/db-backups/2026-08-07/`. Recorded here for
continuity; it frames why the ledger-drift (P-10) and no-direct-writes
disciplines exist.

---

## Standing operating constraints (context for every entry above)

- No agent-executed write/admin SQL against the prod primary — hand exact
  commands to the operator.
- No hand-written SQL to fix data — migrations, seeders, or the app's own code
  paths only.
- No heavy Docker builds / full stack boots on the prod API host — use the
  dedicated staging host / twin.
- Fetch/rebase before every push (concurrent sessions share this branch).
