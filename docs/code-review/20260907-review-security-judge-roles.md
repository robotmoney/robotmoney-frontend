# Security review — swarm judge/validator role subsystem

## Scope and pinned commit

- **Repository:** https://github.com/robotmoney/robotmoney-frontend.git
- **Branch:** `review/judge-security-audit` (tip of #922's branch, which stacks #918's commits on `main`)
- **Commit:** `7a34666d3334d87e43506cbebfc18dad5505beaa`
- **Reviewed at:** 2026-09-07 (UTC)
- **Scope:**
  - Judge role authentication/authorization: `backend/src/swarm/domain.ts` (`submitRecommendation`'s `judge_role_cannot_submit_takes` refusal, `memberIdForToken`), `backend/src/swarm/judge-session.ts` (`judgeSession()`'s active-status/role/take-conflict/`third_party_enabled` checks and #918's `operator='robotmoney'` exemption).
  - How an admin enables/grants an in-house validator/judge: `backend/src/swarm/admin.ts` (`setMemberRoleAdmin`, `judgeSessionAdmin`, `updateMemberAdmin`), `backend/src/swarm/roster-seed.ts` (`seedLiveRoster`, `pruneToLiveRoster`), and the self-service `updateMemberProfile()` path plus `validateMemberProfile()` (`backend/src/api/validation.ts`).
  - #922's exposure of `judgedBy`/`judgedByMemberId` through the admin API/panel.

## Headline verdict

**One medium-severity finding confirms and sharpens already-filed issue #925: the `operator` field self-service members can freely set doubles as the trust signal `judge-session.ts` uses to exempt "in-house" judges from the #796 third-party gate, with no restriction anywhere on who may write it or what value it holds.** The bypass requires a genuine admin action (granting `role: 'judge'`) to become live, which is the load-bearing prerequisite that keeps this at `medium` rather than `high` — but that admin action is the ordinary, expected way any graduated judge (in-house or third-party) is created, so the finding is not a hypothetical misuse of an unusual admin capability; it is a standing gap in the intended staged rollout. Two secondary findings (a completely untested take-conflict guard, and a self-service audit trail that records no field values) are `low`/`info`. Everything else examined in scope — the transaction/advisory-lock design around the 60s model call, the handle/id namespace collision guard, the append-only judgement record, and the admin-surface authorization gate — held up under adversarial pressure and is recorded as clean below.

## Methodology

Followed the Superfield `review-security` skill and the shared review contract: mapped assets/trust boundaries/entry points, enumerated the authority transitions (self-registered member → active member → graduated judge → in-house-exempt judge → admin), traced the relevant flows through validation → domain → admin → judge-session → judgement record, tested replay/race/TOCTOU/lifecycle/privilege-composition hypotheses (including an explicit n-order pass combining the self-service write surface with the judge-session exemption check), and adversarially refuted each candidate before reporting it. Evidence is cited by repository-relative `path:line`; findings are backed by reading the exact guard code, not inferred from comments or commit messages alone. Existing prior-review artifacts under `docs/code-review/` were checked for overlap (none found on this subsystem before this review); the already-filed GitHub issue #925 was confirmed against the code directly rather than trusted, and is cited as `related_findings`.

## Findings

### review-security-001 — Self-declarable `operator` field forges the in-house judge exemption from the third-party gate

- **Classification:** `SECURITY_TRUST_SIGNAL_FORGERY`
- **Severity:** `medium`
- **Confidence:** `high`

**Evidence.**
- `backend/src/api/validation.ts:396` — `operator` is a plain `PROFILE_KEYS` member, self-service-writable.
- `backend/src/api/validation.ts:468-472` — `validateMemberProfile()`'s only check on `operator` is "non-empty string, ≤200 chars"; no reserved-value refusal, no allowlist.
- `backend/src/swarm/domain.ts:2183-2231` (`updateMemberProfile`) — writes `patch.operator` verbatim to the caller's own row; the only authorization check is `tokenMemberId === memberId` (line 2211). No role check: a `judge`-role member can call this exactly like any other active member, at any time, including *after* being granted the role.
- `backend/src/swarm/judge-session.ts:242-272` — the exemption test is purely attribute-based: `if (member.operator !== "robotmoney")`, read **fresh inside the write transaction on every judging attempt** (not merely at role-grant time). This means a judge-role member can self-declare `operator: 'robotmoney'` immediately before a judging attempt and revert it immediately after, with the exemption applying every single time the value happens to read `'robotmoney'` at judgement time.
- `backend/src/swarm/admin.ts:470-498` (`setMemberRoleAdmin`) and `:430-465` (`reviewApplicationAdmin`) — neither reads, checks, nor even logs `operator` when granting `role: 'judge'`. Granting judge status and trusting the operator field are two completely disjoint code paths with no cross-check.
- `backend/migrations/0001_backends.sql:42` — `swarm_members.operator` is a bare `text` column with no `CHECK` constraint at the database level either.
- `backend/tests/swarm-member-profile.test.ts:57-78` — the repository's own test suite already demonstrates the unrestricted write: a self-service `PATCH` with `operator: "robotmoney"` is asserted to succeed with no refusal.
- Confirmed independently reachable and already filed as **issue #925** (open, unresolved) by the author of #918/#922; this review reproduces the same evidence from the code rather than taking the issue's word for it, and extends it (see "Going further" below).

**Exploitability / attack path.**
1. A member applies through the ordinary public `apply` flow (self-serve, needs only a keypair) and is activated by an admin — the routine, low-scrutiny onboarding path used for every ordinary member, not a special judge-vetting process.
2. At any point after becoming active, the member calls `POST /api/swarm/members/:id/profile` with `{"operator": "robotmoney"}` under its own bearer token. This succeeds unconditionally (validated above).
3. Separately, an admin grants this member `role: 'judge'` via `setMemberRoleAdmin` — the same action #812/#796 already document as the **normal, expected way an externally-operated graduated judge is created**, deliberately kept insufficient on its own by #796's `third_party_enabled` gate ("any active judge-role member could already author a judgement, with no admin control over whether third-party judging is permitted at all" — `backend/tests/swarm-judge-third-party-flag.test.ts:1-11`).
4. Because the exemption check is attribute-based and re-read fresh at judging time, this member's judgements are now treated as **in-house** and bypass `third_party_enabled` entirely — with no admin ever having flipped that flag, and with no visible distinction anywhere in the admin surface between "graduated judge whose in-house status was verified" and "graduated judge who typed `robotmoney` into a text field."

**Why this is not merely decoration on an admin-gated path.** The rubric instructs not to inflate severity when "requires an admin to also do X" is a real, load-bearing prerequisite — and it is real here (an attacker cannot self-grant `role: 'judge'`). But #796/#812's own design intent was that granting `role: 'judge'` should be **insufficient by itself** to permit judging for anyone outside the seeded in-house roster; that is the entire reason the `third_party_enabled` flag exists as a second, independent gate. This finding shows that the second gate is not actually independent: it collapses to a self-service string an ordinary member already controls. The admin action required is not an unusual mistake — it is the same action #796's test suite already treats as the normal path for a legitimate future third-party judge.

**Impact.** In `enforce` mode, an unvetted identity's model-authored `rationale`/`disagreements`/`release_safety` opinion is merged into `swarm_recommendation` (the field the public site and any downstream consumer reads as the swarm's consensus judgement) without the admin's separate, documented decision to allow third-party judging ever having been made. In `shadow` mode the same unvetted identity accumulates a judgement history that the admin panel and any future promotion decision may treat as evidence of trustworthy performance. The self-service `update_profile` audit row records no field values at all (see finding 003), so an admin investigating a suspected forgery after the fact has no record that `operator` was ever anything other than what it reads today — the forgery is stealthy by default, not merely theoretically possible.

**Adversarial refutation attempted.** Considered whether this is unreachable because (a) `operator` might be admin-only — refuted, `PROFILE_KEYS` includes it and the route test proves it; (b) the judge-session check might key off `id`/`handle` (i.e., literally require the row to be Themis) rather than the free-text `operator` column — refuted, `judge-session.ts:265` reads `member.operator`, not identity; the code comment at `judge-session.ts:256-260` explicitly generalizes to "everyone... whose member row carries that operator," which is the design as shipped, not a misreading; (c) whether the admin UI surfaces some out-of-band verification of "real" operator identity before a judge grant — no such mechanism exists anywhere in `swarm-admin.ts` or its route dispatcher. The finding survives.

**Missing/regression test.** No test in `backend/tests/` exercises a judge-role member that has self-declared `operator: 'robotmoney'` via `updateMemberProfile()` (as opposed to `roster-seed.ts`'s seeded rows). Add a test to `backend/tests/swarm-judge-third-party-flag.test.ts` (or a new file) that: grants a non-Themis member `role: 'judge'`, calls `updateMemberProfile()` (not `updateMemberAdmin`/`roster-seed`) to set `operator: 'robotmoney'`, leaves `thirdPartyEnabled: false`, and asserts `judgeSession()` for that member is refused `third_party_judging_disabled` — the test that would fail today and should pass only once a fix lands (per acceptance criteria already drafted in issue #925).

**Recommendation.** As issue #925 already frames it: either remove `operator` from self-service `PROFILE_KEYS` entirely (treat it like `handle`, admin-only), or refuse self-service writes of specific reserved values (at minimum `'robotmoney'`); and/or change `judge-session.ts`'s exemption to check literal membership in `LIVE_ROSTER_HANDLES`/a roster-seed-only boolean rather than the free-text `operator` column. Also strengthen the self-service `update_profile` audit row (finding 003) so a forgery attempt leaves forensic evidence even before the write path itself is fixed.

**Related findings:** GitHub issue #925 (open) — this review confirms, sharpens (the fresh-read means the field can be toggled at will rather than needing to be right only once), and extends its scope-check items with hard evidence.

---

### review-security-002 — The judge/take conflict-of-interest guard has zero test coverage

- **Classification:** `SECURITY_UNVERIFIED_GUARD`
- **Severity:** `low`
- **Confidence:** `high`

**Evidence.** `backend/src/swarm/judge-session.ts:273-277` refuses a judging attempt with `judge_member_has_take_in_session` (409) when the named judge already holds a take in the session it is about to judge. A repository-wide search (`grep -rn "judge_member_has_take_in_session|has_take_in_session" backend/tests backend/src`) finds this string **only at its own definition** — no test in `backend/tests/` ever exercises this refusal path, positively or negatively. `backend/tests/swarm-judge-role.test.ts` and `backend/tests/swarm-judge-third-party-flag.test.ts` cover the adjacent `judge_member_inactive` and `judge_role_required` refusals but not this one.

**Why this matters.** This guard is one of three checks #812 added specifically to keep "the quorum denominator and the author of the judge prose free of a market view" (docs/decisions.md). It is exactly the kind of one-line boolean condition (`if (take) { refusal = ...; throw ...}`) that a future refactor could silently invert, delete, or scope incorrectly (e.g., accidentally checking the wrong session id) with no red test anywhere to catch it — an assertion-integrity gap in waiting, not a currently-exploitable defect. On direct inspection the guard's logic is correct: it runs inside the same transaction as the judgement write, after the advisory lock, so it observes the true state at commit time.

**Adversarial refutation attempted.** Considered whether the guard is unreachable in practice because `submitRecommendation()` already refuses any `role='judge'` member from submitting a take at all (`domain.ts:638`) — true, but the guard is specifically for the case where a member submitted a take *while still a plain member* and was *promoted to judge afterward* (exactly what `swarm-judge-role.test.ts`'s "grant/revoke" test exercises for the *submission* side, but never for the *judging* side against that same session). That promotion path is real and already tested elsewhere, so the guard is reachable and worth a direct test. Considered whether a race could let a take land between the guard's `SELECT` and the transaction's `COMMIT` — refuted as immaterial: `submitRecommendation` already blocks any `role='judge'` member from submitting, so the only way a conflicting take can exist is if it was filed before the judge grant, which is a stable precondition already resolved by the time the guard's `SELECT` runs, not a live race.

**Missing/regression test.** Add a test that: has a member submit a take in session S while `role='member'`, promotes it to `role='judge'` via `setMemberRoleAdmin`, and then calls `judgeSession(S, { judgeMemberId })`, asserting `{ ok: false, status: 409, error: "judge_member_has_take_in_session" }` and that no `swarm_session_judgements` row is written.

---

### review-security-003 — Self-service profile audit row records no changed fields or values

- **Classification:** `SECURITY_INSUFFICIENT_AUDIT_TRAIL`
- **Severity:** `info`
- **Confidence:** `high`

**Evidence.** `backend/src/swarm/domain.ts:2229` — the `update_profile` audit row written by `updateMemberProfile()` carries only `{ memberId }` as its `scope`. Contrast with the admin counterpart, `backend/src/swarm/admin.ts:620-625` (`updateMemberAdminTx`), which logs `fields: Object.keys(patch)` and, for a handle change specifically, the old and new value — "the trail says what was edited and not only that an edit happened" (admin.ts:611-613's own comment).

**Impact.** Now that `operator` carries authorization significance (finding 001), an admin investigating a suspected forgery after the fact cannot reconstruct, from the audit log alone, whether or when a member's `operator` value was ever something other than its current value. This is a pure observability gap — it does not itself grant any capability — but it directly compounds finding 001's stealthiness.

**Missing/regression test.** A test asserting that `updateMemberProfile()`'s audit row's `scope` includes the changed field names (mirroring the assertion style already used for `updateMemberAdminTx` in the admin surface's own tests), at minimum for `operator`.

**Recommendation.** Log `fields: Object.keys(patch)` on the self-service audit row the same way the admin path already does.

## Clean / adequately covered areas

- **Admin route authorization is fail-closed and checked before any DB work.** `backend/src/api/routes/swarm-admin.ts:1-7` — every route under `/api/swarm/admin/*` checks `isPrivileged()` (`X-Admin-Token`) before parsing the request body or touching the database (issue #152 AC7), confirmed by direct reading of the dispatcher.
- **The 60-second model-call race window is correctly closed for status/role/third-party-flag.** `judge-session.ts:219-278` performs the active-status, role, and `third_party_enabled` checks *inside* the write transaction, *after* the model call returns, under a per-session `pg_advisory_xact_lock` — so an admin revocation or flag flip that commits while the model is "thinking" is observed before any judgement row can land. This is directly exercised by `backend/tests/swarm-judge-third-party-flag.test.ts`'s "read fresh inside the write transaction" test, which was run and traced against the actual code, not merely trusted from its name.
- **`judgeSessionAdmin`'s early, out-of-transaction resolution of Themis's id by handle is safe.** `admin.ts:1214-1227` resolves `getMember("themis")` before the transaction opens, but the transaction's own `SELECT ... FOR UPDATE` on that exact id (`judge-session.ts:242-243`) re-verifies status/role/operator fresh, so a concurrent admin revocation or deactivation between the two reads is caught by the second check with a specific, correctly-attributed refusal (`judge_member_inactive` / `judge_role_required` / `third_party_judging_disabled`), never a misleading generic error.
- **The take-conflict guard's transaction ordering is correct** (though untested — finding 002): the model call happens before the transaction opens, and the conflict `SELECT` runs inside the transaction, after the advisory lock — the design the file's own header comments describe holds up under direct reading.
- **Member handle/id namespace collision is robustly enforced at the database level.** Migration `0031_swarm_member_handle_namespace.sql` installs a symmetric `BEFORE INSERT OR UPDATE` trigger, `ENABLE ALWAYS` (so it survives `pg_restore --disable-triggers`/logical replication), refusing any write that would make a handle equal another member's id or vice versa. Self-service can never set `handle` at all (`validateMemberProfile()` explicitly refuses it), so a member cannot rename itself to `themis` to hijack `judgeSessionAdmin`'s handle-based resolution.
- **`applyOpinion()` never writes `weights`/`quorum`/`stances`.** `judge-session.ts:368-431` merges exactly `rationale`, `disagreements`, `release_safety`, and the `judge` fingerprint — confirmed by direct reading of the merge object literal — and this invariant is separately pinned by a dedicated test file per the module's own header comment (not independently re-verified in full by this review, but the code matches the documented invariant).
- **The append-only guard covers `swarm_session_judgements` and `swarm_members`.** `backend/src/db/append-only-guard.ts:212,221` lists both tables among the protected set.
- **`memberIdForToken()` correctly joins on `status = 'active'`,** so a rotated key against an inactive member cannot authenticate (issue #799's fix, `domain.ts:59-65`), and `submitRecommendation()` separately refuses any `role='judge'` member from submitting a take at all (`domain.ts:638`), which is the primary defense the take-conflict guard (finding 002) backs up for the narrower promoted-after-submission case.
- **`seedLiveRoster()`'s idempotent upsert correctly preserves an admin's later role grant/revocation** across re-seeds (commit `4c57cef3`, `role` written on `INSERT` only) while still refreshing `operator` from the manifest on every run for the three named seats — this is the mechanism that keeps Athena/Robot Money/Themis's `operator` value authoritative even though it is not itself a security-restricted column; the same idempotent-upsert design is not, and cannot be, a defense against a *different* member self-declaring the same value on its own row (finding 001).

## Recommended actions

1. Fix issue #925 before or alongside #918/#922 shipping to production: remove `operator` from self-service `PROFILE_KEYS` (or reserve `'robotmoney'`), and/or re-key `judge-session.ts`'s in-house exemption off `LIVE_ROSTER_HANDLES` membership rather than a free-text column. Add the regression test in finding 001.
2. Add the missing take-conflict regression test (finding 002) regardless of #925's resolution — it protects a different, currently-correct invariant that has no safety net today.
3. Bring the self-service profile audit row up to parity with the admin path's field-level logging (finding 003).

## Unresolved decisions

- Which of issue #925's two proposed fixes (remove `operator` from self-service entirely, vs. reserve specific values) is the intended direction — this review confirms the defect and its severity but does not prescribe the mechanism, per the issue's own "What to determine" checklist.
- Whether the public roster route's verbatim rendering of a self-declared `operator` (a cosmetic/reputational forgery surface noted in issue #925's own text — `GET /api/swarm/members`) needs its own remediation independent of the judge-gate fix; this review did not find any other backend authorization decision that reads `operator`, so this is display-only today, but is worth resolving explicitly rather than leaving implicit.

## Limitations and unreviewed surfaces

- `judge.ts`'s prompt construction and model-call transport were read only far enough to confirm the file-level "weights are never written" invariant by direct inspection of `applyOpinion()`; the full prompt-injection surface of take/brief content flowing into the judge's model call was not separately re-audited in this pass (out of the stated scope, which centers on role/authorization, not prompt safety).
- The frontend admin panel changes in #922 (`frontend/public/assets/js/app/alpine/views/admin/swarm-session.js`) were reviewed only for whether they introduce a new privileged-data exposure (they do not — same admin-gated surface as the rest of the page) and were not reviewed for XSS/rendering correctness.
- CORS and cross-origin implications of the public read routes (D43) were out of scope and not reviewed here.
- This review did not execute the test suite; all "no test exists" claims (findings 002, and the confirmation of #925's own reproduction) are based on `grep`-verified absence of the relevant assertions/error strings across `backend/tests/`, not on a red run.
- Did not independently review `worker/handlers/swarm.ts`'s full cron scheduling logic beyond confirming it calls the same `judgeSessionAdmin()` entry point audited above.
