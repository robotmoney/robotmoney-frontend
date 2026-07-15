# Maintainability Review — 2026-07-14

## 1. Scope and pinned commit

- **Repository**: https://github.com/robotmoney/robotmoney-frontend.git
- **Branch / commit**: `main` @ `4fc1236661251002d0b6956314884eff6507dc79`
- **Reviewed**: 2026-07-14, in worktree `adhoc-20260714-031351-maintainability-review-cleanliness`
- **Scope**: complete repository, weighted toward surfaces changed by the recent
  cross-cutting PRs — #112 (baked-data removal / live APIs), #119 (Multicall3
  wallet balances + 429 retry), #117 (admin jobs dashboard), #122 (committee
  inference bounding), #103 (EDGAR/demo hardening).
- **Dimensions**: duplicated semantics & coupling; dead paths & obsolete
  compatibility; hot files, hidden state, config & naming; test seams & CI
  execution honesty.
- Repository instructions: no `AGENTS.md`/`CLAUDE.md` in-repo; `CONTRIBUTING.md`
  conventions (buildless SPA, goldens ownership) were honored as normative.
- No prior artifacts under `docs/code-review/` (first review of this kind here).

## 2. Headline verdict

**The core seams are well designed, but each has 1–2 uncontrolled bypasses
accumulating, and two high-churn shared files are re-growing the exact
collision pattern that caused prior regressions.** The single-RPC-transport,
contract-routes, demo/live-selection, and loud-skip-test invariants all exist
and are mostly honored — the maintenance risk is concentrated in the
exceptions: one hand-rolled RPC path, a three-way regime-threshold fork, the
committee URL/casing surface outside the contract, and `views.js`/`views.css`
as collision magnets.

## 3. Severity summary

| Severity | Count | Findings |
|----------|-------|----------|
| high     | 4     | 002 (regime thresholds ×3, diverged), 015 (RPC transport bypass), 023 (views.css duplicate selector blocks — #80 pattern recurrence), 025 (views.js 12-view hot file) |
| medium   | 14    | 001, 007, 008, 009, 010, 011, 016, 017, 019, 020, 024, 026, 031, 032, 033 |
| low      | 11    | 003, 005, 006, 012, 014, 018, 021, 022, 027, 029, 030 |
| info     | 2     | 004, 013 |

(Full machine-readable list: `20260714-review-maintainability-claude.json`.)

## 4. Methodology

Four concurrent review workers, one per dimension, each instructed to
adversarially refute candidates before keeping them; coordinator deduplicated
cross-worker overlaps (the `PROVIDER` chain was found independently twice; the
committee-casing finding was reconciled with the discovery that
`committee-archive.js` is itself dead code) and spot-re-verified all four
high-severity findings directly against the pinned tree. Hot-file analysis used
`git log --since=2026-05-01` churn counts. Dead-code claims required a stated
zero-reference grep. The `review-tests` method was applied to the
recently-changed behavior surfaces. No code was executed except
`scripts/check-docs-analytics.sh`; no tests were run (backend preload
provisions Docker Postgres — outside budget).

## 5. Findings

IDs, classifications, severities, evidence, and recommendations are canonical
in the JSON artifact; this section narrates them in priority order.

### High

- **002 · MAINTAINABILITY_DUPLICATED_SEMANTICS — regime thresholds implemented three times, already diverged.**
  Canonical classifier `backend/src/analytics/analyze/regime.ts:9-10` uses
  0.33/0.67; `backend/src/committee/domain.ts:243-244` and `mcp/src/memo.ts:40`
  use 0.45/0.55. A composite of 0.60 is "neutral" to the classifier but
  "risk_on" to the committee layer. Worse, `backfillRegimeHistory`
  (domain.ts:271-286) inserts synthetic rows labeled with the divergent rule
  into the classifier-owned `regime_snapshots` table on the **live**
  aggregation path (fires whenever <8 rows exist), so one table can mix two
  classification semantics. → Export one classifier/threshold module; backfill
  must read stored labels, never re-derive.

- **015 · MAINTAINABILITY_DUPLICATED_SEMANTICS — the "single RPC transport" invariant has a bypass.**
  `backend/src/chain/base-rpc-client.ts:11-16` says "do NOT hand-roll a fetch
  to the RPC elsewhere", yet `backend/src/projects/access/live-source.ts:45-55`
  hand-rolls `eth_call` with its own selector table. The bypass gets none of
  the #119 rate-limit machinery: no concurrency-gate participation, no
  429/Retry-After retry, no User-Agent (the public Base node 403s bare POSTs
  per the client's own comment), different timeout. The vault-TVL cron shares
  the same public RPC that the wallet feed just got 429'd on. → Route through
  `base-rpc-client`; delete the local `SEL` table.

- **023 · MAINTAINABILITY_COMPLEXITY — views.css same-selector duplicate blocks have re-accumulated (the #80 regression pattern).**
  `.cv__context-grid`/`.cv__discussion`/`.cv__portfolio-grid` are styled by two
  base blocks (`views.css:145`, `:246/:262`) and two identical
  `@media(min-width:768px)` blocks (`:310`, `:345-346`) with conflicting values
  — line 310's `repeat(2, …)` is silently overridden by line 346's
  `0.75fr 1.25fr`. Editing the first block is a no-op; a merge that drops or
  reorders one block changes layout with no nearby diff noise. Second
  recurrence of this pattern → consolidate AND add a duplicate-selector CI lint.

- **025 · MAINTAINABILITY_HOT_FILE — views.js is a 12-view, 1350-line collision magnet.**
  Twelve unrelated Alpine view factories share one file
  (`frontend/public/assets/js/app/alpine/views.js`), the highest-churn code
  file in the repo (20 commits since May; touched by #112, #117, #119, #122).
  Same shared-file collision failure mode as #80. → One module per factory +
  a `registerViews(Alpine)` barrel; boot-time registration is unaffected.

### Medium

- **007** — wallet-sleeves copies wallet-balances' per-asset valuation
  semantics and has already drifted: `wallet-sleeves.ts:82` cites
  `readAmount()`, deleted by #119, and still fans out unbatched eth_calls.
  Extract one shared valuation module; batch sleeves via Multicall3.
- **008** — roster cap, no-show rule, and stance ladder maintained as
  comment-enforced mirrors across backend/mcp/scripts; `@robotmoney/contract`
  is already the sanctioned shared channel — move them there.
- **009** — demo fixture generation and synthetic regime backfill live inside
  the production committee domain and run on the live path; templated
  synthesis hardcodes the 95/5/0/0 mandate that is admin-editable in
  `allocation_framework`. Separate rollup math from narrative/demo enrichment
  (also the seam #77 real-inference needs).
- **010** — ~20 backend env knobs read deep in call stacks; ~56 of 66 env vars
  absent from `.env.example`. Centralize resolvers in `config.ts` + regenerate
  the example + CI grep.
- **011** — retired `PROVIDER` knob survives as a dead chain
  (`config.analyticsProvider` zero consumers; test-only `fetcher-provider.ts`
  in `src/` with comments pointing at a deleted module), name-colliding with
  the unrelated `analyticsProvider()` auth predicate in `committee.ts`.
- **016** — `PROJECTS_SOURCE` is **required** in prod (`select.ts:26` throws)
  but documented nowhere an operator looks; default-enabled cron schedules make
  a by-the-book prod deploy crash-loop on an undiscoverable var.
- **017** — nightly live-fetchers job has no execution-evidence guard: a gate
  env-var rename silently turns the whole suite into green skips (policy item
  2 violation, latent — wiring correct today).
- **019** — committee endpoints bypass `contract/src/routes.js` in both
  directions (~20 hardcoded path sites across backend, mcp, scripts);
  `check-contract` only diffs the vendored frontend copy so drift is invisible.
- **020** — `docs/FEATURE_PARITY_PLAN.md` presents completed work as "4/25
  pages, ready for Phase 0 kickoff"; `docs/screenshots/README.md` points at it
  as current.
- **024** — committee entities live in two casing dialects reconciled by
  hand-written normalizers; the load-bearing shapes are typed `unknown` in the
  contract, and `||` coalescing drops legitimate falsy values. This seam
  already shipped the subject_id/subjectId render bug.
- **026** — `committee-controllers.js`/`committee-archive.js` are dead in
  production (only `main.js` is loaded; sole referencer is a test), so
  `frontend-routes.test.ts` green-tests code no browser runs while the real
  archive path in `static-views.js` goes untested by it.
- **031** — `RM_ALLOW_INSECURE` has opposite default polarity in backend
  (opt-in insecure) vs `mcp/src/e2e.ts:500` (opt-out insecure) — a copied
  idiom away from a fail-open regression.
- **032** — `scripts/lib/demo-main.ts` (1131 lines, ≥9 concerns, global
  `process.env.ADMIN_TOKEN` mutation) inherited demo.ts's churn crown; every
  demo-visible feature edits it.
- **033** — the goldens CI drift gate is specified but unwired while
  `scripts/update-goldens.ts:11` claims it exists; Playwright stubs replay the
  goldens, so stale goldens self-certify.
- **001** — `.env.example` still calls the #112 adapter defaults
  "non-functional placeholders".

### Low / info

003 (transient-retry semantics re-derived per fetcher), 005 (no injectable
sleep/clock → wall-clock-coupled retry tests), 006 (TTL-cache pattern
hand-copied ×6 in chain/), 012 (config snapshot-vs-resolver duality;
`blockDateCache`), 013 (orphaned `import-regime-eq.ts` can overwrite live
regime snapshots if misused), 014 (`API_BASE` vs `BACKEND_URL`), 018
(`projects-fetchers-live.test.ts` missing the fallback assertion its three
siblings have), 021 (`REGIME_PIXEL_PARITY_PLAN.md` lacks a completed marker),
022 (doc filename convention drift — tracked #113), 027 (stance vocabulary
declared 5×, two frontend color maps), 029 (blog provenance comments point at
nonexistent legacy files), 030 (27 MB orphaned parity screenshots — needs
owner decision), 004 (fetch/semaphore test coupling — watch item).

## 6. Clean / adequately covered areas

- **Multicall3 + 429 retry** and **wallet-balances**: exemplary tests against
  the real transport, fetch mocked only at the process boundary; per-leg
  degradation and config-collision guard asserted both ways.
- **Committee inference bounding** (mcp): injectable binary/timeout seams;
  loud-skip contract and the grandchild-keeps-pipes-open worst case proven
  hermetically.
- **Loud-skip discipline**: DB preload throws without Postgres; CI executes
  tests on every surface (root, backend, mcp, Playwright, hermetic demo with
  live-leak guard); 3 of 4 live suites carry gate-off fallback assertions.
- **Frontend URL contract**: zero hardcoded `/api/` paths in browser code;
  vendored routes byte-identical and CI-guarded.
- **Demo/live seams**: no api→demo imports; `ProjectsDataSource` fail-closed
  selection; canonicalizeSubmission single-sourced in the contract; demo flag
  layering in `demo-env.ts` coherent and tested.
- **Not dead despite #112**: `frontend/public/data/committee/**` (live archive
  path), goldens route keys, compose env keys, all package scripts, all SPA
  views reachable.

## 7. Recommended actions (priority order)

1. Route `live-source.ts` through `base-rpc-client` (015) — closes the active
   rate-limit exposure re-introducing the #118 symptom class.
2. Single-source the regime classifier thresholds; stop live synthetic
   backfill re-labeling (002, with 009).
3. Consolidate `views.css` duplicate blocks + add a duplicate-selector lint;
   split `views.js` per-factory (023, 025) — removes the two collision magnets.
4. Document `PROJECTS_SOURCE` + fix the `.env.example` adapter block (016, 001)
   — cheap, prevents a prod crash-loop and operator confusion.
5. Delete the dead committee lib pair and re-point its test at the real path
   (026); delete the `PROVIDER` chain (011).
6. Contract completion: `ROUTES.committee`, typed `RegimeSummary` /
   `CommitteeRecommendation`, shared stance enum, shared demo constants
   (019, 024, 027, 008).
7. Test-honesty hardening: nightly `EXPECT_LIVE` guard, goldens drift gate or
   honest header, sleeves/balances shared valuation module (017, 033, 007).
8. Extract demo-main.ts concerns; align `RM_ALLOW_INSECURE` polarity;
   `BACKEND_URL` rename; env-knob inventory (032, 031, 014, 010).
9. Docs pass: FEATURE_PARITY/REGIME_PIXEL status banners, blog provenance
   comments, screenshots deletion decision (020, 021, 029, 030 — can ride the
   pending docs-gardening branch).

## 8. Documentation changes

Findings 001, 016, 020, 021, 029 are documentation corrections; finding 022 is
already tracked as issue #113. The uncommitted 2026-07-10 docs-gardening
worktree should be checked before opening new docs work.

## 9. Unresolved decisions

- Delete the 27 MB `frontend/test/fixtures/screenshots/original/`? README
  documents intended manual use; needs owner confirmation (030).
- Keep the seeded-degradation provider seam (`fetcher-provider.ts` +
  `providers.test.ts`) relocated under `tests/`, or delete outright (011)?

## 10. Limitations and unreviewed surfaces

Static review; no test suites executed (Docker-backed preload out of budget) —
bun's exit-0-on-all-skipped behavior asserted from semantics, not observed.
Branch-protection required-check list not visible in-repo. Env inventory was
regex-based. views.css scan was text-based (manually verified for the cited
selectors). No whole-backend ts-prune sweep. Churn window from 2026-05-01.
goldens content freshness vs the running backend not validated. Unreviewed:
analytics analyze/* internals beyond regime, heroes.js/chart internals,
mcp/src/server.ts OAuth, scripts/gitops-credentials.ts, deep docs-vs-code
alignment (belongs to review-docs), and the security/economics/reliability
dimensions (separate skills).
