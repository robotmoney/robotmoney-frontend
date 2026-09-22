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
| P-04 | `shadow` still selectable as a judge mode | S4 | 🔴 (accepted) |
| P-05 | Correct roster driver not yet running on prod | S3 | 🔴 |
| P-15 | No admin UX to control judge parameters (API-only today) | S4 | 🔴 |
| P-16 | Parallel unmerged judge docs duplicate ours and keep `shadow` | S4 | 🔴 |
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
- **Evidence:** `swarm-admin.ts:67`, `auth.ts`, `config.ts:736-737`. Note the
  frontend **does** have an admin login gate (`ADMIN_TOKEN` password or a
  passkey → `X-Admin-Token`, `admin/shared.js`), so the auth *mechanism* exists;
  the unknown is whether a valid credential is provisioned for `rm_prod`, not
  whether a login path exists.
- **Next:** confirm whether `ADMIN_TOKEN`/`AUTOMATION_TOKEN` (or an
  `admin_credential` row / passkey) is set for `rm_prod-api-1`. If none, and
  insecure mode is off, there is **no** authorized path to flip the judge — by
  design — and one must be provisioned before P-02 and the P-15 UI are usable.

### P-04 — `shadow` still a selectable judge mode (S4)
`shadow` computes a real model opinion and withholds it — the same
compute-and-hide half-measure `a42d6c5a` removed on the fallback side. Design
intent is a binary `off | enforce` judge.
- **Evidence / plan:** see `docs/technical/judge-shadow-removal-spec.md`
  (status: **accepted** 2026-09-22 — the judge is binary `off | enforce`).
- **Branch target: `releases-0.5.x`** (decided 2026-09-22) — the branch
  production runs. No backport scope.
- **Next:** logistics only — verify replay covers the soak (hard prerequisite),
  reconcile with the in-flight work in **P-16** (which builds *on* shadow), loop
  David on the reversal, rewrite the driver's per-session flip, then implement.

### P-05 — Correct roster driver not running on prod (S3)
Target roster — **Athena, Noop, Robot Money Analyst** — should run under the
archive-scenario driver (`smoke:archive`). After P-06 the wrong driver was
killed and no correct driver was started; the three agents are seated but no
session-lifecycle loop is driving them.
- **Next:** cut over with `SMOKE_PROJECT=rm_prod bun run smoke:archive --
  --no-tui` (confirm before running; one wrong cutover already occurred). This
  is independent of P-02/P-04.

### P-15 — No admin UX to control judge parameters (S4)
The judge is configurable **only** through a raw authenticated call to
`POST /api/swarm/admin/judge` (mode, minTakes, model, thirdPartyEnabled). There
is no operator-facing UI, so enabling/tuning the judge means hand-crafting an
HTTP request with an admin token — which is also why P-03 (can an operator even
authenticate?) surfaced. An admin who should be able to turn the judge on and
pick its model currently cannot do so through any screen.
- **Requirement — the panel surfaces the four controls the API already exposes:**
  - **Mode** — `off` / `enforce`, **two-way — decided 2026-09-22**. No `shadow`
    selector (P-04); the UI ships binary from the start.
  - **Model** — a model id the OpenCode key serves, or clear (`null`). Make
    "no model ⇒ the judge produces nothing (`model_unconfigured`)" legible.
  - **Min takes** — integer ≥ 1 (thinly-supported threshold).
  - **Third-party judging** — on/off; ships **off**, should stay off (postflight
    asserts it). Present as an advanced switch, not a casual toggle.
- **Read-back / "will it actually run?"** — the panel must show current live
  config AND whether the judge can actually reach a model (is `OPENCODE_API_KEY`
  present in `worker-swarm`?). Otherwise an operator sets `enforce` + a model and
  silently gets `model_unconfigured`. This likely needs a small backend
  health/readiness field, since the key is container env, not a DB row.
- **Depends on / relates to:** P-02 (what the control is *for*), P-03 (the auth
  path the UI needs), P-04 (whether Mode is two- or three-way). Optionally also
  *displays* judgements/receipts (#1017's public judgement routes) — scope TBD:
  config-only vs. config + view.
- **Current frontend surface (mapped):** a full admin SPA already exists —
  buildless **Alpine.js 3** under `frontend/public/`, with admin routes at
  `/admin/*`, including `/admin/swarm` (an overview with Topics/Members/Sessions
  tabs, `swarm-overview.js` + `views/admin/swarm.html`) and
  `/admin/swarm/sessions/:id` (`swarm-session.js`). **Auth is already solved:** a
  login gate takes the `ADMIN_TOKEN` (or a passkey) → stores `rm_admin_token` in
  sessionStorage → sends it as `X-Admin-Token`; shared `adminAuthState()`
  (`admin/shared.js`) gives every factory `_token()` / login / fail-closed 403
  handling. So this is a **slot-in, not a from-scratch build**.
- **The route is already declared but unused.**
  `ROUTES.swarm.admin.judgeConfig = "/api/swarm/admin/judge"`
  (`contract/routes.js:226`) exists and is referenced **only** in the contract —
  no view or factory consumes it. Its comment covers only `mode | minTakes` and
  must be extended for `model` / `thirdPartyEnabled` (the newer backend body).
- **Panel home:** a new **"Judge" tab in `/admin/swarm`** (page-level config,
  not session-specific). The per-session admin page (`swarm-session.js`) already
  renders a "Consensus judge" panel reading
  `/api/swarm/admin/sessions/:id/judgements` — the #767 read path — a natural
  secondary display. **Note (P-04 link):** that per-session panel is documented
  as the *shadow-soak read path*, so removing `shadow` also revisits what it
  shows.
- **Well-templated:** `api.adminGet(ROUTES.swarm.admin.judgeConfig, token)` →
  a `{mode, minTakes, model, thirdPartyEnabled}` form; save via `api.adminPost`;
  reuse the `adm-*` classes and the existing `validateXxx` / `showForm` /
  `submitting` form pattern.
- **Next:** short UX spec (states, validation, the "will it run?" read-back),
  then implement the tab — small and precedented.

### P-16 — Parallel unmerged judge docs duplicate ours and keep `shadow` (S4)
The branch `chore/reconcile-judge-swarm-releases-0-5-x` carries **7 commits,
all documentation** (`docs(swarm): …`), covering the **same subject matter as
our findings doc and shadow spec** — written by someone else, unmerged, and not
visible from this branch.

- **What's on it:**
  - `54f49b56` judge divergence between `main` and `releases-0.5.x` — *the same
    comparison we performed on 2026-09-22*
  - `1cf69d06` correct the divergence analysis against verified revisions
  - `31ddb6d9` state-machine specification for the session lifecycle and judge
  - `80ad2c5b` a judge failure never stops a session
  - `65b099b5` record the target judge design **as evaluator**
  - `8da7e38e` an unreasonable memo is dropped from the vector
  - `bd346b29` pin placeholder drop threshold, **ship the filter in shadow first**
- **Despite its name it is NOT based on our line:** its merge-base with `main`
  is `a9f2008b` (#1014), i.e. it branched off `main`, and it is 83 commits
  behind `releases-0.5.x`.
- **Two conflicts:**
  1. **Duplicated effort.** Its divergence analysis and judge-design docs
     overlap `consensus-judge-findings.md` and `judge-shadow-removal-spec.md`.
     Two doc sets describing one judge is how they drift.
  2. **Opposite stance on shadow.** Its tip ships a filter *"in shadow first"*,
     while P-04 records shadow's removal as accepted. One of the two is wrong.
  Also note `65b099b5` records a **target judge design ("as evaluator")** that
  may supersede assumptions in our docs.
- **Next:** read those 7 docs **before** writing more of ours; reconcile the
  shadow stance with their author; decide which doc set is canonical rather than
  maintaining both.

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
