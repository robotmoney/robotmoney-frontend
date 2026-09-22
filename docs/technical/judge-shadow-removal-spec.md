# Spec: remove `shadow` as a go-forward judge mode

**Status:** **accepted** (product decision to remove `shadow` confirmed
2026-09-22) — not yet implemented. The design is settled: the judge is binary
`off | enforce`. Remaining items are logistics/prerequisites, not the decision
itself (see *Open questions*): the one hard prerequisite is that replay (§5)
must cover the soak before code drops shadow.
**Author:** engineering
**Related:** `a42d6c5a` (fallback removal), `#1017` (a judgement is a public record), `#752`/`#767`/`#797`/`#845` (the shadow soak), D22 (single model-selection signal).

## 1. Motivation

The judge already has one non-negotiable rule, set by `a42d6c5a`
("there is no fallback — a judgement is a model's opinion or it does not
exist"): a judge that cannot reach a model **throws and writes nothing**,
rather than recording the aggregator's own prose and signing it as an
opinion. The failure was invisible dishonesty inside a signed artifact.

`shadow` mode is the same shape of half-measure from the other side. In
`shadow` the judge reaches a real model, forms a **real** opinion, records
it — and then deliberately **withholds** it from the session
(`0039:41`, `consensus-receipt.ts:600`). It produces a genuine judgement
that, by design, changes nothing and reaches no reader on the live path.
That is coherent as a *rollout* device (soak the judge before it can gate
a release) but it leaves the system with three judge states where the
model's honest answer is "off, or a model's opinion that counts." A
computed-and-withheld opinion is a third thing that exists only to be
invisible.

**Decision:** the judge is binary. `off`, or `enforce`. There is no mode
whose defining property is that a real judgement reaches nobody.

## 2. Target design

- `JudgeMode` becomes `"off" | "enforce"`.
- `enforce` is unchanged and remains the sole on-mode: the judgement is
  applied to the session it judged and published in the consensus
  receipt. It can gate a release exactly as it does today. **We are not
  changing what `enforce` does** — only removing the mode next to it.
- The admin switch (`POST /api/swarm/admin/judge`) accepts `off` |
  `enforce`. A request for `shadow` is a `400`, same shape as any other
  invalid mode.
- The pairing constraint is unchanged: `enforce` still requires a
  configured `model` and a reachable `OPENCODE_API_KEY`, or `judge()`
  throws `model_unconfigured` and the session publishes unjudged.

### The one hard rule this spec inherits

This is done the way `a42d6c5a` did the fallback: **stop writing the
value going forward; preserve its historical footprint unchanged.** We do
NOT rewrite history, and we do NOT narrow any constraint that an existing
row could violate.

## 3. What is preserved (non-goals)

- **`swarm_session_judgements` is append-only (0040).** Historical rows
  recorded `mode='shadow'` (and, before `a42d6c5a`, `source='fallback'`)
  and MUST stay readable byte-for-byte. Their column CHECK
  (`mode IN ('shadow','enforce')`, `0039:66`) is **not** narrowed — there
  is nothing to gain and an append-only table forbids the rewrite anyway.
- **Signed consensus receipts are immutable.** A receipt's `judge_mode`
  lives in the signed bytes (`consensus-receipt.ts:415`). Old receipts
  that name `shadow` verify only if the type still admits the value.
  Reading types keep `"shadow" | "enforce"`; only the *write* path is
  narrowed so no NEW receipt is ever `shadow` (already true — only
  `enforce` is publishable, `#1017`).
- **The reason/telemetry vocabulary is untouched.** Nothing about how a
  live judgement is recorded, digested, or signed changes.

The net: `shadow` disappears as something an operator can *select* and as
something the system will ever *produce again*. It remains a value the
schema can *read* out of the past.

## 4. Blast radius

### 4.1 Code (go-forward path — must change)

| File | What changes |
|---|---|
| `backend/src/swarm/judge-session.ts:28` | `JudgeMode = "off" \| "enforce"` |
| `backend/src/swarm/judge-session.ts:73-74` | validator drops `shadow` from the accepted set + message |
| `backend/src/api/routes/swarm-admin.ts:248-251` | patch type + `400` validator drop `shadow` |
| `backend/src/swarm/consensus-receipt.ts` | assembler (`:740`) no longer maps a non-enforce judgement to `shadow`; a non-enforce judgement is not publishable, full stop |
| `scripts/lib/swarm/session.ts:1423` | **driver rewrite** — see §6 |
| `backend/src/worker/loop.ts:69`, `backend/src/swarm/admin.ts` | comments/paths that branch on `shadow` |

### 4.2 Reading types (keep `shadow`, read-only)

`consensus-receipt.ts:95` (`judge_mode: "shadow" \| "enforce"`) and any
DTO that surfaces a *historical* judgement's recorded mode keep the value
so old rows and old signed receipts still parse. These are the
append-only / signed surfaces from §3.

### 4.3 Database

- **New forward-only migration** (next number) narrows ONLY the operator
  switch:
  ```sql
  UPDATE swarm_judge_config SET mode = 'off' WHERE mode = 'shadow';
  ALTER TABLE swarm_judge_config DROP CONSTRAINT IF EXISTS <mode_check>;
  ALTER TABLE swarm_judge_config ADD  CONSTRAINT <mode_check>
    CHECK (mode IN ('off', 'enforce'));
  ```
  It is a one-row table, so the `UPDATE` touches at most one row. This is
  a **config** row, not append-only, so narrowing it is legal.
- **`swarm_session_judgements.mode` CHECK is NOT touched** (§3): it is
  append-only and may hold historical `shadow` rows — including any this
  branch's own mis-fired `smoke:stage` run wrote against prod. Narrowing
  it would require rewriting history, which the guard forbids and this
  spec refuses.
- **`swarm_consensus_receipts.judge_mode` CHECK is NOT touched**:
  immutable signed rows.

### 4.4 Tests (~30 files)

Categories, all mechanical once §4.1 lands:
- Admin-surface tests asserting `shadow` is accepted → assert it is now a
  `400` (`swarm-admin-surface.test.ts`, `api/admin-swarm.test.ts`).
- Judge/receipt tests that drive `mode: "shadow"` to exercise the
  record-and-withhold path → either delete (the path is gone) or convert
  to a *historical-row* fixture that inserts the legacy value directly.
- Smoke/driver unit tests keyed on the driver's `setJudgeMode("shadow")`
  (`scripts/tests/unit/swarm-session-judge-step.test.ts`,
  `smoke-judge-role-coverage.test.ts`) → track §6.

## 5. Replacing what `shadow` was *for*

`shadow` existed so an operator could soak the judge on live sessions and
read its opinions before letting them gate a release (`judge.ts:122`).
Removing the mode must not remove that ability, only the dishonest way it
provided it.

**Replacement: `backend/scripts/swarm-judge-replay.ts`.** It already
re-runs `judge()` against recorded session inputs and reports the opinion
**without touching any session** — the same "observe before you enforce"
outcome shadow gave, but as an out-of-band tool rather than a live mode
that writes withheld rows into the append-only ledger. The soak becomes:
replay against real recorded inputs (or a twin), read the opinions, then
flip `off → enforce` once satisfied. The spec's implementation step
should confirm replay covers the inputs an operator wants to soak; if it
has a gap, closing that gap is a prerequisite, not a follow-up.

## 6. Interaction with the archive/roster driver (blocking for cutover)

`scripts/lib/swarm/session.ts:1423` flips the judge `off → shadow` for
each session it runs (issue #845), then reads back the rows shadow
recorded. **This is the driver `smoke:archive` uses**, i.e. the one that
seats Athena / Noop / Robot Money Analyst on a live stack. Removing
`shadow` requires deciding what that flip becomes:

- **`enforce`** — the driver runs the judge for real and its opinions
  reach the sessions. Only valid when a model + `OPENCODE_API_KEY` are
  configured; otherwise every session throws `model_unconfigured`.
- **`off`** — the driver stops touching the judge; the roster runs
  unjudged (today's honest default when no model is set).

**Recommendation:** the driver reads `swarm_judge_config` as shipped and
leaves it alone — no per-session flip at all. Whether the judge runs
becomes purely the operator's `off`/`enforce` decision on the config row,
not something the driver forces per session. This also removes the
`#845` save/restore dance (`session.ts:1420-1424`).

> **Consequence for the live goal:** getting Athena / Noop / Robot Money
> onto prod does **not** require this spec. Today, `smoke:archive` works
> because `shadow` exists. Under this spec the driver is rewritten per
> above. So either cut the roster over first on the current driver and do
> this refactor after, or land this first and cut over on the rewritten
> driver — this is the sequencing question the spec does not decide.

## 7. Open questions (need sign-off before implementation)

1. **This reverses a decision "agreed with David on 2026-09-21"** (`#1017`
   body) that names `shadow` the documented rollout mode. The product owner has
   made the call to remove shadow (2026-09-22); this remains here as the
   coordination fact — David should be looped on the reversal before/around the
   code landing — not as an open design question.
1a. **Prerequisite (hard):** verify `swarm-judge-replay.ts` covers the
   observe-before-enforce soak on real recorded inputs BEFORE the code removes
   shadow, or the capability is lost with no verified replacement (§5).
2. **Branch target.** Verified 2026-09-22: **`releases-0.5.x` is 83 commits
   AHEAD of `main`; `main` has only 9 commits we lack** (an earlier draft of
   this spec had the direction backwards). Both branches still define `shadow`
   identically, so the removal applies to each. Note `main` is *actively
   building on* shadow (`#1014`-era judge work; the branch
   `chore/reconcile-judge-swarm-releases-0-5-x` ships a filter "in shadow
   first"), so the removal must be coordinated with that work rather than
   landed underneath it. Undecided.
3. **Driver §6:** confirm "driver reads config, never flips" is the
   intended behavior, and that replay (§5) covers the soak inputs before
   the live mode is removed.
4. **Sequencing vs the roster cutover** (§6 consequence): cut over first
   on the current driver, or land this first.

## 8. Out of scope

- Any change to what `enforce` *does* (apply + publish + gate). This spec
  removes a mode; it does not re-open enforce's semantics. A separate
  question — whether an "on" judge should ever gate a release at all vs.
  only publish a public record — is explicitly deferred.
- Rewriting or purging historical `shadow` / `fallback` rows or receipts.
