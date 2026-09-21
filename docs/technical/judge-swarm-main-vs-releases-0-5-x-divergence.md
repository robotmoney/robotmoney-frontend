# Judge/swarm divergence: `main` vs `releases-0.5.x` (2026-09-21)

## Status

Research only. No behavior has been ported yet. Every claim below was verified
directly against both branches at the revisions named in "Revisions verified".

The headline conclusion is **not** "0.5.x is the tested branch, port from it."
Each branch is ahead of the other in different places, sometimes inside the same
commit. Porting 0.5.x wholesale would regress `main` in at least two areas.

## Revisions verified

| | revision | note |
|---|---|---|
| `main` | `a9f2008b` | unchanged during this analysis |
| `releases-0.5.x` | `f2c21a56` | **moved during analysis**, was `ebbfc0bb` |

Merge base `2605199a` (2026-09-17). `main` is 5 ahead, `releases-0.5.x` is 52
ahead. Scope per Lucas: judge/swarm commits only, not all 52.

`fusion/certificates-integration` (formerly `releases-0.6.x`) already landed on
`main` via PR #1006 on 2026-09-18, closing issues #1005 and #971. It never
touched `releases-0.5.x`, which is a separate, older, never-landed branch.

## 1. The fallback question — a genuine either/or, not a merge

Both branches independently redesigned judge failure handling, reacting to the
same incident: a misconfigured judge silently signing template prose into
consensus receipts as if a model had written it.

**`main`** (issue #969, the "D-A7" split, `backend/src/swarm/judge.ts:18-53`)
splits failure into two classes:
- **Never really asked** — no model/credential, disallowed model,
  `credit_exhausted`, `credential_rejected`, `model_not_supported`,
  `launcher_unavailable`. Throws `JudgeUnavailableError`, writes no row
  (`judge.ts:1260-1261`).
- **Asked, and the model misbehaved** — timeout, unparsable output, or a
  response smuggling weights. Writes `source: "fallback"` with
  `templateOpinion()` prose and a bounded reason. Call sites `judge.ts:1266`,
  `judge.ts:1280` (fault lever), `judge.ts:1295`, all via `fallbackOutcome()`
  at `judge.ts:211-232`.

**`releases-0.5.x`** (`a42d6c5a`) deletes the second class outright. `judge()`
has exactly one success exit (`source: "model"`, `judge.ts:869`); every other
path throws `JudgeUnavailable` (`judge.ts:819`). `templateOpinion()` survives at
`judge.ts:400` but is **called from nowhere** — verified, only comment
references remain. It is kept solely as a shape the receipt layer must still
recognize on historical append-only rows.

### The sharper half: what happens at publish time

This is the part that makes the decision concrete, and it is where the two
branches differ most.

- **`releases-0.5.x` refuses to publish at all.** `consensus-receipt.ts:120`
  defines a refusal reason `judgement_not_authored`, enforced at
  `consensus-receipt.ts:624-627`: if the adopted judgement has
  `source !== "model"`, receipt assembly refuses. Its comment: *"A receipt is a
  claim about authorship, so this is a refusal and not a warning."*
- **`main` has no such guard.** `judgement_not_authored` does not exist anywhere
  in `backend/src/` on `main` — verified by repo-wide grep. A fallback
  judgement gets a receipt, with `source` carried honestly into the signed bytes
  (`consensus-receipt.ts:88` types it, `:402` copies it verbatim into the
  assembled receipt, `:819` normalizes it on load).

So `main`'s position is "publish it, but mark it"; 0.5.x's is "refuse it". Main
does **not** launder the provenance — that is real and verified — but it also
does not stop a template-authored certificate from existing.

**Decision needed before any `judge.ts` code moves:** keep main's narrower
fallback, or adopt 0.5.x's zero-fallback stance. These encode opposite answers;
there is no merge that satisfies both.

## 2. Receipt refusal reasons — diverge *additively*, safe to union

Comparing the full `ConsensusReceiptRefusalReason` unions:

- **18 reasons shared.**
- **Only on `main`:** `weights_absent_for_bucket_weights_subject`,
  `weights_not_authored_by_every_take`. Both are wired into
  `TERMINAL_RECEIPT_REFUSALS` at `backend/src/worker/handlers/swarm.ts:262-265`.
- **Only on `releases-0.5.x`:** `judgement_not_authored` (see §1).

Nothing here contradicts. Unlike `judge.ts`, this layer can take the union.

Note the dependency: `judgement_not_authored` stays useful on `main` **even if
main's narrower fallback is kept**, because the judgements table is append-only
and historical `source='fallback'` rows exist regardless. Porting it is safe
under either outcome of §1 — which makes it the one judge-adjacent change that
does not have to wait for that decision.

## 3. Additive on `main` only — no conflict

- **`judge-launcher.ts`** (issue #1012): every judge model call now routes
  through a short-lived container via `agent-launcher`, the same rail a member
  agent uses. Absent from `releases-0.5.x` entirely.
- **`judge-fault-injection.ts`**: triple-gated (DB row + process flag +
  acceptance opt-in), test-only lever that forces the fallback path to give
  AC-E2E-06 a repeatable demonstration. **Depends on a fallback path existing**
  — if §1 resolves toward zero-fallback, this needs a replacement mechanism.
- **`judge-model-policy.ts`**: blocks free-tier/keyless models, pins prod to one
  model. Orthogonal to §1, safe under either outcome.

## 4. Fixes only on `releases-0.5.x` — verified genuinely absent from `main`

All three confirmed by direct comparison, all portable, none touching §1:

- **`closeWindow` telemetry rollback.** `main`'s `domain.ts:2031` wraps the
  state transition and the absence-telemetry inserts in one `sql.begin`, so a
  telemetry failure rolls back the close; the worker retries, exhausts attempts,
  and the session wedges in `collecting` forever — 409-rejecting every member
  submission for that subject. 0.5.x decouples them: the UPDATE commits alone,
  telemetry failures come back as `telemetryWarnings`.
- **API pool timeouts.** `main` sets `statement_timeout` and
  `idle_in_transaction_session_timeout` only in `db/worker-client.ts:40-41`, not
  in `db/client.ts` (the API pool). 0.5.x sets both on the API pool too
  (`db/client.ts:22-23`), so a leaked transaction cannot starve the pool into
  502s that block session creation.
- **Rescheduled lifecycle jobs never re-arm.** Same statement, same place in
  both: `main`'s `admin.ts:990` is `ON CONFLICT (dedupe_key) … DO NOTHING`;
  0.5.x's `admin.ts:992` is `DO UPDATE SET run_after = EXCLUDED.run_after,
  status = 'pending', attempts = 0, locked_at = NULL, …`. Without it a
  rescheduled session silently stays on its old timeline.

## 5. Where `main` is AHEAD — do not port these

Two corrections to the assumption that 0.5.x is uniformly the tested branch.

- **Take weights parsing.** `ebbfc0bb`'s weights half adds `parseWeightsClause()`
  to `scripts/lib/swarm/inference.ts` on 0.5.x. `main` already has the same
  capability, more developed, as `parseWeightsFromBody()`
  (`scripts/lib/swarm/inference.ts:205`) with `TAKE_WEIGHTS_LEAD_IN` (`:156`)
  and `TAKE_WEIGHT_BUCKETS` (`:162`). Main's version derives the bucket list
  from the contract constant `RECEIPT_CANONICAL_BUCKET_ORDER` so prompt, parser
  and receipt cannot drift; tolerates markdown decoration (`**WEIGHTS:**`, bullet
  prefixes, trailing periods) after that strictness was found to drop sessions
  below quorum over formatting; and refuses a line mixing percentage and
  fraction notation, a documented forgery vector that previously normalized to
  an allocation nobody wrote. **Porting 0.5.x's version would regress `main`.**
- **`9b8e1331` auto-publish is already on `main`.** `git merge-base
  --is-ancestor` reports NO, but that is misleading: fusion was squash-merged as
  `21f4465b`, so the original SHA is not an ancestor. The behavior is present —
  `publishSession()` calls `publishConsensusReceiptAdmin(sessionId, "worker")`
  at `backend/src/worker/handlers/swarm.ts:270`. No action needed.

## 6. Where `main` is missing a whole capability

`scripts/verify-live.ts` **does not exist on `main`** and is invoked nowhere in
`scripts/` or `.github/` — verified. On `releases-0.5.x` it exists and
`smoke-main.ts:1266-1277` runs it as a product-invariant gate, with `tier=full`
on twin boots and `tier=readonly` on demo boots (twin-only legs fail against a
simulation roster with deliberate no-shows).

This traces to `0ac4d0cc` ("product verification as a separate process, reusing
the CI legs"). It is larger than the judge scope and is called out here only so
it is not mistaken for a small tiering tweak when reading `ebbfc0bb`.

## 7. Not yet analyzed

`f2c21a56`, the newest commit on `releases-0.5.x` (landed during this analysis),
is judge-related and in scope but not yet assessed: it makes the e2e driver wait
on the `swarm.judge` job's own row via a new `GET /api/admin/jobs?id=` filter
instead of a wall clock, and makes the publish wait lane-aware so it survives a
judge still holding the single-concurrency swarm lane. Touches
`scripts/lib/swarm/session.ts`, `backend/src/api/routes/admin.ts` and three test
files.

## 8. Also carried over from `67edc611` — re-verify, do not blind-port

Its five breaks, with current status:

1. `swarm_judge_config.mode` ships `off` and a twin restores production, so
   judging was always off on twin boots — `enableTwinJudge()` forces `enforce`,
   twin-only. Lifecycle-scoped, likely portable.
2. `OPENCODE_API_KEY` stopped reaching the judge after a `.env`-leak fix closed
   the hole carrying it. **Re-verify**: main now routes every call through a
   container, so this may be moot or may need a launcher-side equivalent.
3. A twin adopting production's in-flight session aborted before reaching the
   judge job. Lifecycle-scoped, likely portable.
4. Zen 401s on the provider-qualified model id though the bare id works —
   `wireModelId()` translates for the wire only. **Re-verify** against the
   container-routed path.
5. `9b8e1331` cherry-pick — already on `main`, see §5.

## Open questions for Lucas

1. **Fallback policy (§1):** keep main's narrower fallback, or adopt 0.5.x's
   zero-fallback stance? Note this is really two questions — whether `judge()`
   may return a non-model opinion, and whether such an opinion may be published
   as a signed receipt. 0.5.x answers no to both; main answers yes to both.
2. If zero-fallback wins, what replaces `judge-fault-injection.ts`'s mechanism
   for AC-E2E-06 (§3)?
3. Is `scripts/verify-live.ts` (§6) in scope for this reconciliation, or its own
   piece of work?

## Recommendation

Branch off `main`. Its architecture — container-routed judge calls, model
policy, the more developed weights parser — is the newer generation and already
supersedes part of what 0.5.x's fixes were reacting to.

Suggested order, smallest risk first:

1. **Port §4's three lifecycle fixes.** Genuinely absent from `main`, verified,
   independent of every open question above.
2. **Port `judgement_not_authored` (§2).** Safe under either answer to §1.
3. **Re-verify §8's items 2 and 4** against the container-routed path before
   touching them.
4. **Resolve §1 as its own reviewed change**, once decided.

Do not port `ebbfc0bb` as a unit — its lifecycle fixes are wanted and its
weights half is a regression (§5). Split it.
