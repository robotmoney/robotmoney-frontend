# Judge/swarm divergence: `main` vs `releases-0.5.x` (2026-09-21)

## Status

Research only. No behavior has been ported yet. This document exists to make the
reconciliation decisions explicit before any code moves, because the central
conflict below is a product decision, not a merge conflict a tool can resolve.

## Context

`fusion/certificates-integration` (formerly `releases-0.6.x`) already merged into
`main` via PR #1006 on 2026-09-18. That closed out issue #1005 and issue #971. It
did **not** touch `releases-0.5.x`, which is a separate, older branch that was
never landed. As of this document, merge base `2605199a` (2026-09-17):

- `main` has 5 commits `releases-0.5.x` doesn't.
- `releases-0.5.x` has 51 commits `main` doesn't, including one from **today**
  (`ebbfc0bb`, authored by Lucas, not the stage agent).

Per direction from Lucas: treat `releases-0.5.x` as the last branch where judge
functionality was actually tested end-to-end (the v0.5.0 rollout rehearsals), and
scope this reconciliation to the judge/swarm commits only — not the full 51.

## 1. The fallback question — needs a decision, not a merge

Both branches independently redesigned what happens when the judge fails, reacting
to the same underlying incident: a misconfigured/unfunded judge was silently
signing template prose into consensus receipts as if it were a real model opinion.

**`main`** (issue #969, the "D-A7" split, `backend/src/swarm/judge.ts:18-53`) splits
judge failure into two classes:
- **Never really asked** (no model/credential, disallowed model, `credit_exhausted`,
  `credential_rejected`, `model_not_supported`, `launcher_unavailable`) — throws
  `JudgeUnavailableError`, no row written. (`judge.ts:1217-1229`, `1260-1261`)
- **Asked, and the model misbehaved** (timeout, malformed/unparsable output, a
  response that tried to smuggle weights) — writes `source: "fallback"`,
  `templateOpinion()`, a bounded `fallbackReason`. Call sites `judge.ts:1265-1266`
  and `judge.ts:1289-1295`, via `fallbackOutcome()` at `judge.ts:211-232`.

**`releases-0.5.x`** (`a42d6c5a`, "there is no fallback — a judgement is a model's
opinion or it does not exist") deletes the second class entirely. `judge()`
(`judge.ts:775-874` on that branch) has exactly one success exit
(`source: "model"`, line 869); every other path throws `JudgeUnavailable`.
`templateOpinion()` is fully dead code there — kept only as a shape
`consensus-receipt.ts` must still recognize on historical rows, because the
judgements table is append-only.

**This is not main lagging behind a fix.** Main's redesign is a narrower,
survivable-failure carve-out of the same incident 0.5.x reacted to by removing
fallback outright. One material fact that weakens (but doesn't settle) the case
for main's position: fallback provenance is **not** laundered into the signed
receipt. `consensus-receipt.ts` types the judge block's `source` as
`"model" | "fallback"` (line 88), copies it verbatim when assembling a receipt
(line 402), and normalizes it on load (line 819) — so a fallback-produced receipt
is cryptographically distinguishable from a real one on `main` today. Whether
that distinguishability is enough to justify keeping a fallback path at all is
the actual decision.

**Decision needed before any judge.ts code moves:** keep main's narrower fallback
(survives a reachable-but-misbehaving model), or adopt 0.5.x's zero-fallback
stance (a judgement is a model's opinion or it doesn't exist, full stop). This
determines which of the two `judge.ts` implementations is the reconciliation base
— not "merge both," since they encode opposite answers to the same question.

## 2. Additive on `main` only — no conflict with either fallback policy

- **`judge-launcher.ts`** (issue #1012): every judge model call now routes through
  a short-lived container via `agent-launcher`, the same rail a member agent uses.
  Does not exist on `releases-0.5.x` at all.
- **`judge-fault-injection.ts`**: a triple-gated (DB row + process flag +
  acceptance-path opt-in), test-only lever that forces the fallback path
  (`fallback_reason: "malformed_output"`) to give AC-E2E-06 a repeatable
  demonstration. **Depends on a fallback path existing** — if the zero-fallback
  stance from §1 is adopted, this test needs a different mechanism.
- **`judge-model-policy.ts`**: blocks free-tier/keyless models, pins the judge to
  `deepseek-v4-flash` in prod. Orthogonal to §1. Safe to keep under either
  fallback policy.

## 3. Fixes only on `releases-0.5.x` — real, but check against `main`'s newer architecture before porting

`67edc611` ("the in-house judge now runs real inference and publishes real
certificates") fixed five independent breaks, found because the twin had never
once produced a real consensus receipt:

1. `swarm_judge_config.mode` ships `off`; a twin restores production, so judging
   was always off on twin boots. Fixed by `enableTwinJudge()` forcing `enforce`,
   twin-only.
2. `OPENCODE_API_KEY` stopped reaching the judge's process — a `.env`-leak fix
   (`2a480390`) happened to close the hole that was carrying it too. Fixed by
   `judgeCredentialEnv()` passing it deliberately.
3. A twin adopting production's in-flight session hit `planWindowWait`'s
   abort-on-long-deadline path before ever reaching the judge job. Fixed by
   closing adopted windows against the boot's own seat file instead.
4. Zen's REST API 401s on the provider-qualified model id
   (`opencode/deepseek-v4-flash`) though the bare id works. Fixed by
   `wireModelId()` translating for the wire only, while the qualified id stays in
   the record.
5. `9b8e1331` (auto-publish the consensus receipt on the cadence) had landed on
   `releases-0.6.x` and never made it back to this branch — cherry-picked here.
   **This one needs no action**: it's already on `main` via PR #1006.

Breaks 2 and 4 were about getting a call through to Zen **directly**. `main`'s
`judge-launcher.ts` changed that path entirely since these fixes were written —
every call now goes through a container, not an in-process Zen client. Those two
fixes need re-verification against the container-routed path, not a blind port;
they may already be moot, or may need a container-side equivalent. Breaks 1 and 3
look twin-lifecycle-scoped rather than `judge.ts`-internal and are more likely
portable as-is — not yet verified against `main`'s current twin harness.

Also noted in `a42d6c5a`'s commit body as a still-open, release-blocking gap at
that point: migration 0051 reverted two subjects to `bucket_weights`, but nothing
authored member weights, so sessions published a null vector. That gap is closed
by `ebbfc0bb` below.

## 4. `ebbfc0bb` (today, Lucas, `releases-0.5.x` only) — swarm session lifecycle, independent of §1

- `closeWindow` commits the `collecting → window_closed` transition independent
  of absence telemetry. Previously a telemetry failure could roll back the close,
  exhaust job attempts, and wedge a session in `collecting` forever — blocking
  `getOpenSession` and 409-rejecting member submissions.
- The API pool gains `statement_timeout` and `idle_in_transaction_session_timeout`
  (matching the worker pool), so a leaked transaction can't starve the
  10-connection pool into nginx 502s that block subsequent session creation.
- `createSessionAdmin`'s reschedule uses `ON CONFLICT DO UPDATE` instead of
  `DO NOTHING`, so a rescheduled session's lifecycle jobs actually re-arm instead
  of silently staying on the old timeline.
- `smoke-main` runs `verify-live tier=full` only on twin boots; demo boots use
  `tier=readonly`, since twin-only legs (twin-roster, judge receipt) fail against
  a simulation roster with deliberate no-shows and fixtures.
- Member takes now carry proposed weights over the four canonical vault buckets —
  this is what closes the null-vector gap noted in §3.

None of this touches judge.ts's fallback logic. These look independently portable
to `main` regardless of how §1 resolves. Not yet checked for whether `main` has
already hit, or independently fixed, any of these same symptoms.

## Open questions for Lucas

1. Fallback policy (§1): keep main's narrower survivable-failure fallback, or
   adopt 0.5.x's zero-fallback stance?
2. If zero-fallback wins, what replaces `judge-fault-injection.ts`'s mechanism for
   AC-E2E-06 (§2)?
3. Confirm before porting §3 items 2 and 4: do they still apply now that every
   judge call is container-routed, or does `judge-launcher.ts`/`agent-launcher.ts`
   already carry the API key and handle wire-id translation on its own path?

## Recommendation

Branch this work off `main`, not `releases-0.5.x`. Main's architecture (container-
routed judge calls, model policy, fault injection) is the newer generation and
already supersedes part of what 0.5.x's fixes were responding to — rebasing onto
0.5.x would mean re-deriving those features from scratch. Land the fixes that
don't touch the fallback question first (§4, and whichever half of §3 survives
re-verification), then resolve §1 as its own explicit, reviewed change.
