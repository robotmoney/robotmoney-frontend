# Findings: consensus judge & 0.5.x production cutover

**Date:** 2026-09-22 · **Scope:** `rm_prod` (DO managed Postgres), `releases-0.5.x`.
**Backing detail:** [`production-issues-register.md`](./production-issues-register.md)
(every issue, P-nn) · [`judge-shadow-removal-spec.md`](./judge-shadow-removal-spec.md)
(the shadow change).

This is the single consolidated read of what we found and decided. It
summarizes; the two documents above carry the row-level detail and the
implementation spec.

---

## Executive summary

- **The judge is honest but silent.** The template/fallback path was removed
  (`a42d6c5a`): a judge with no model **throws and writes nothing** rather than
  signing template prose as an opinion. In production it currently produces
  **no judgements** because no model is configured — sessions publish unjudged,
  which is the intended honest state, not a bug.
- **The one hard blocker to turning it on is already cleared.**
  `OPENCODE_API_KEY` is present in both `worker-swarm` and `api`. Enabling the
  judge is now a live config change (`mode=enforce` + a `model` id), no
  redeploy.
- **`third_party_enabled=false` was a red herring** — it gates *third-party*
  judging only, is the correct default, and does **not** affect the built-in
  worker judge.
- **Decision: the judge is binary — `off | enforce`. `shadow` is removed.** A
  mode that computes a real opinion and withholds it is the same half-measure
  the fallback removal rejected; replay covers the soak it provided.
- **An admin UI to control the judge is a slot-in, not a build.** The admin SPA,
  its auth, and even the contract route already exist; only the panel is
  missing.
- **We left residue on prod from a wrong-scenario cutover** (simulation instead
  of archive): stray takes/memos and real inference spend. Cleanup is pending
  and must go through app code paths, not raw SQL.

---

## 1. What the judge actually does now

- `judge()` has exactly two outcomes: return a model-authored opinion
  (`source: "model"`), or throw `JudgeUnavailable` and write nothing. There is
  no third "template" answer (`a42d6c5a`, in the deployed branch).
- `templateOpinion()` still exists but is **unreachable from the judging path** —
  its only callers are two test files. Residual `shadow`/`fallback` mentions in
  `judge.ts` are historical comments and read-only type fields for old rows.
- **Consequence:** with no model, every judge job throws `model_unconfigured`;
  the session publishes without a judge block. Nothing dishonest is produced,
  but nothing is judged either.

## 2. Why it isn't running, and what turning it on takes

Three levers, all required for a real judgement:

| Lever | Default | Prod state | Where |
|---|---|---|---|
| `swarm_judge_config.mode` | `off` | ⟳ verify (expect `off`) | DB row, admin API |
| `swarm_judge_config.model` | `NULL` | ⟳ verify (expect `NULL`) | DB row, admin API |
| `OPENCODE_API_KEY` | unset | **present (67 chars)** in `worker-swarm` + `api` | container env |

To enable: `POST /api/swarm/admin/judge` with `mode:"enforce"` + a valid `model`.
No restart. The only open dependency is **admin access** (§4).

## 3. The `shadow` decision

- **Accepted 2026-09-22:** remove `shadow`; the judge is `off | enforce`.
- **Rationale:** shadow writes *real* judgement rows into an **append-only**
  ledger and withholds them — artifacts that exist to be invisible, the exact
  shape `a42d6c5a` rejected on the fallback side.
- **Replacement for the soak:** `swarm-judge-replay.ts` re-runs the judge
  against real recorded inputs and writes nothing — cleaner than live shadow.
- **Hard prerequisite:** confirm replay covers that soak **before** code drops
  shadow, or observe-before-enforce is lost with no verified replacement.
- **Preserved:** historical `shadow` rows and signed receipts stay readable; only
  the go-forward switch is narrowed. Full plan in the removal spec.

## 4. Admin access & the judge-control UI

- **Auth mechanism exists:** the admin SPA has a login gate (`ADMIN_TOKEN`
  password or passkey → `X-Admin-Token`, `admin/shared.js`). The open question is
  only whether a valid credential is **provisioned for `rm_prod`** — not whether
  a login path exists.
- **The route is declared but unused:** `judgeConfig = "/api/swarm/admin/judge"`
  sits in `contract/routes.js:226`, consumed by no view. Its comment predates
  `model`/`thirdPartyEnabled`.
- **The UI is a slot-in:** a new **"Judge" tab in `/admin/swarm`** (buildless
  Alpine.js), surfacing four controls — **Mode** (`off/enforce`, two-way),
  **Model** (id or clear), **Min takes** (≥1), **Third-party** (advanced, ships
  off) — plus a **"will it actually run?"** read-back showing `OPENCODE_API_KEY`
  presence so nobody sets `enforce` + model and silently gets
  `model_unconfigured`.

## 5. Production incidents & residue

- **Wrong-scenario cutover:** `smoke:stage` (simulation) was deployed instead of
  `smoke:archive` (archive), running the wrong swarm lifecycle — onboarding
  evals spawned agent containers (real spend), roster-full 409s, and **stray
  takes/memos (sessions ~720–722)** written to prod. Driver killed; **cleanup
  pending** via app code paths, not SQL.
- **Contained:** a parallel inspection stack exhausted DB connections
  (torn down before prod impact); an in-place recreate caused brief downtime on
  the tunnel port; the `doadmin` password was once echoed to a terminal
  (rotated, then removed from `.env`).
- **Resolved this cycle:** schema-migration **ledger drift** (0053/0062 applied
  out-of-band, never recorded) reconciled and the recorded `bun run migrate`
  tool now replaces the provisioning script; `doadmin` removed from runtime;
  judge fallback dishonesty removed; boot-time 502s traced to warm-up, not
  capacity.

## 6. Open actions (see the register for detail)

| # | Action | Blocked on |
|---|--------|-----------|
| P-05 | Cut over prod to the correct roster driver (`smoke:archive`) | operator confirm (one wrong cutover already occurred) |
| P-01 | Clean up stray simulation takes 720–722 | a prod read to enumerate; app code path |
| P-03 | Confirm an admin credential is provisioned for `rm_prod` | operator |
| P-02 | Enable the judge (`enforce` + model) | P-03 |
| P-15 | Build the judge-control admin tab (two-way) | UX spec / go-ahead |
| P-04 | Remove `shadow` (binary judge) | replay-covers-soak prerequisite; David loop; branch |

---

## Standing constraints

No agent-executed write/admin SQL on the prod primary (hand commands to the
operator); no hand-written SQL to fix data (migrations/seeders/app paths only);
no heavy Docker builds on the prod API host; fetch/rebase before every push.
