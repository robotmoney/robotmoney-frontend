# review-docs — 2026-07-23 — claude

## Scope and pinned commit

- **Repository:** `git@github.com:robotmoney/robotmoney-frontend.git`
- **Branch:** `adhoc/20260721-190555-docs-cleanup`
- **Commit:** `6e5cfb49d87c5c00086433c97dec7153781de805`
- **Reviewed:** 2026-07-23
- **Scope:** documentation corpus: `docs/**`, `CONTRIBUTING.md`, `README.md`,
  `frontend/public/views/docs/**`, doc back-links across
  backend/frontend/contract/scripts/CI, Plan issue #15.
- **Prior artifact reconciled:** `docs/code-review/20260721-review-docs-codex.{md,json}`
  (dirty snapshot on base c42c47a; this HEAD is that consolidation committed on
  top of 11 newer main commits including #222/#224/#226/#229).

Paired JSON summary: `docs/code-review/20260723-review-docs-claude.json`.

## Headline verdict

Consolidation was content-lossless but mechanical: no normative text was
dropped from the five folded specs, yet section-numbering collisions poison
25+ §-references across backend/frontend/scripts/decisions, the canonical doc
contradicts itself in at least four places (session states, committee crons,
hermetic mode, admin baseline), and dated evidence records were retro-edited.

## Severity summary

| Severity | Count |
|----------|------:|
| critical | 0 |
| high     | 12 |
| medium   | 15 |
| low      | 6 |
| info     | 1 |
| **total**| **34** |

High findings split into three clusters: self-contradictions inside
`docs/architecture.md` (012, 013, 019, 020, plus the structural root cause
015), misdirected durable references (002, 031), and re-confirmed
docs↔implementation gaps carried from the prior review (005, 006, 007, 009,
029).

## Methodology

Four concurrent reviewers, each producing raw findings that were deduplicated
and merged into this report:

1. **Cross-doc consistency** — internal contradictions across
   `docs/architecture.md`, `docs/decisions.md`, runbooks, CONTRIBUTING, README.
2. **Back-link and anchor audit** — every `§`-bearing or path-bearing doc
   citation in backend/frontend/contract/scripts/SQL/CI, resolved first-match
   against the concatenated architecture doc; executable doc guards run.
3. **Docs ↔ implementation + test evidence** — canonical claims vs shipped
   routes, schema, config, and public IC docs pages; `bun test scripts/tests`
   (163 pass / 0 fail / 27 files), `check-docs-analytics.sh`, `lint-docs.sh`
   executed; Plan issue #15 inspected.
4. **Prior-review reconciliation** — disposition of review-docs-001..018
   against HEAD, consolidation completeness (five folded specs byte-diffed),
   and archive/recyclebin integrity.

Findings were adversarially refuted before retention (the back-link audit
explicitly refuted four candidate path misses as non-findings). Every finding
cites `path:line` evidence at the pinned commit; 17 citations were
independently re-verified against the worktree during synthesis.

## Findings

IDs are new for this artifact, ordered by primary evidence path/line; prior
artifact IDs appear in `related_findings` in the JSON.

### High

- **002 — STALE_COMMENT — backend back-links keep old plan/spec section numbers.**
  `backend/migrations/0017_admin_surface.sql:1` cites “docs/architecture.md §5”
  (first match = “Backend”; intended `docs/architecture.md:2209`);
  `0017_admin_surface.sql:146` (§2), `0018_research_telemetry.sql:11` (§5.2,
  collides with the preview spec), `backend/src/admin/overview.ts:17-18` (§3
  quote actually at `docs/architecture.md:1923-1924`),
  `backend/src/admin/audit.ts:2,51-53`, `backend/src/chain/wallet-sleeves.ts:78`,
  `wallet-valuation.ts:54-55`, `backend/src/committee/admin.ts:334,507`, and two
  backend tests. Comments now actively misdirect to unrelated sections 1000+
  lines away. *(re-confirms review-docs-001, narrowed)*
- **005 — GAP_IMPL — committee lifecycle domain diverges from spec.**
  `backend/src/committee/domain.ts:639-640` (openSession rewinds via
  `ON CONFLICT … SET state='scheduled'`), `645-687` (publishBrief unguarded),
  `742-770` (closeWindow reports success on zero-row update), `925-929`/`899-905`
  (unbounded reads), `backend/src/committee/admin.ts:573-575` (reopen without
  new close time or job cancel/recreate) vs `docs/architecture.md:2572-2577`.
  *(re-reports review-docs-014; closeWindow guard is the one improved sub-item)*
- **006 — INCONSISTENT — worker DB boundary documented as invariant, optional at runtime.**
  `backend/src/db/worker-client.ts:20` falls back to `config.databaseUrl`;
  `docker-compose.yml:40-48` calls rm_worker optional;
  `docs/runbooks/deployment.md:144-160` omits `WORKER_DATABASE_URL`;
  `docs/architecture.md:228,260,462` present it as enforced.
  *(re-reports review-docs-005)*
- **007 — INCONSISTENT — dashboard DTO contract drift.**
  `contract/src/dashboards.d.ts:44-48` (`{asof, vaultContract, buckets}`) vs
  `backend/src/chain/allocation-framework.ts:27-33`
  (`{strategy, buckets, asOf, source, managed}`); zero
  Buyback/TokenMetrics/WalletSleeves DTOs; `scripts/sync-contract.ts:8-10`
  copies only routes.js. *(re-reports review-docs-002)*
- **009 — GAP_IMPL — goldens CI drift gate asserted but unwired.**
  `docs/architecture.md:200-201`, `CONTRIBUTING.md:42-43`,
  `docs/decisions.md:253` all claim a blocking gate; the same doc says
  “not yet wired” (`docs/architecture.md:2743-2744,2821`);
  `scripts/tests/goldens-header.test.ts:2-7` confirms; zero goldens references
  in `.github/workflows/`. *(re-confirms review-docs-004)*
- **012 — INCONSISTENT — phantom `brief_published` state.**
  Lifecycle chains at `docs/architecture.md:618,687,1377,1493,1591` include a
  state the same document forbids (`docs/architecture.md:1889-1892`), the
  migration excludes (`backend/migrations/0017_admin_surface.sql:147-150`), and
  the code never sets (`backend/src/committee/domain.ts:683`).
  *(re-confirms review-docs-007)*
- **013 — INCONSISTENT — committee crons: enabled contract vs forbidden bullets.**
  `docs/architecture.md:702-709` documents the shipped #208/#229 contract
  (production enables); `docs/architecture.md:1902-1906,2066-2067` say the
  schedules “remain disabled … must not be enabled”; smoke-spec §2
  (`docs/architecture.md:1515-1516`) claims a no-intervention run progresses;
  `backend/src/db/seed.ts:28-32` header contradicts `seed.ts:66-71` below it.
  *(review-docs-008 itself is RESOLVED by #229; this is the residual stale text)*
- **015 — INCONSISTENT — concatenation structure is the root cause.**
  Two `# Architecture` H1s (`docs/architecture.md:1,1007`), a stray `+` diff
  character (`:1008`), six independent `## 1.` restarts
  (`:13,1064,1488,1858,2746,2921`), a mis-directed “(§10 below)” (`:1621`),
  §7b ordered before §7a (`:1633` vs `:1671`). Every bare `§N` reference is
  ambiguous (§2 ×6, §3 ×5, §5 ×5, §7 ×5, §9 ×4). *(re-confirms review-docs-003,
  now committed)*
- **019 — STALE — admin-surface spec presents shipped work as future.**
  `docs/architecture.md:1911-1913` names deleted `admin-jobs.js` as baseline;
  `:2211` says “Add … 0017_admin_surface.sql” (exists); `:2232-2252` vs shipped
  `0018_research_telemetry.sql`; `:1914-1916` “read-only” vs
  `backend/src/api/routes/admin.ts:187-483`; `:368-370` “until that lands”
  (landed). *(re-confirms half of review-docs-013)*
- **020 — STALE — admin route/DTO tables diverge from shipped API.**
  Spec telemetry write path of four endpoints (`docs/architecture.md:2404-2408`)
  vs single `POST /api/analytics/telemetry`; `series/:indicator` vs
  `raw-series/:indicator` (`backend/src/api/routes/admin.ts:508`);
  `signals/:key/:date` vs `signals/:key?from=&to=` (`:530`); `runs` vs `rerun`
  (`:557`); `/api/admin/committee/*` PATCH tables vs `/api/committee/admin/*`
  POST-dispatch (`contract/src/routes.js:67-73`); three dead `analytics_*`
  tables from 0017 with zero backend references. *(re-confirms the other half
  of review-docs-013)*
- **029 — INCONSISTENT — how-it-works.html describes the retired GitHub-as-DB architecture.**
  `frontend/public/views/docs/investment-committee/how-it-works.html:59,113`
  (23:30 UTC fixed cadence), `:91` (briefs as repo JSON under `today/`),
  `:107-110` (“five consecutive misses auto-deactivates” — canonical doc
  disclaims exactly this at `docs/architecture.md:718-719`), `:115-118` (reads
  takes “from disk”), `:148` (nonexistent `scripts/committee/select-subject.js`).
  *(re-reports review-docs-017)*
- **031 — INCONSISTENT — dated evidence records were retro-edited.**
  `recyclebin/MANIFEST.md:22-25,10-12` (2026-07-10 verification list and
  reasons now cite `docs/architecture.md`, which was not the target at that
  date) and `docs/code-review/20260714-review-maintainability-claude.json`
  (finding 022 evidence and finding 033 requirement rewritten, destroying
  their points). Falsifies history and breaks reconciliation.

### Medium

- **003 — GAP_IMPL — `/health` returns 200 with db down**
  (`backend/src/api/index.ts:80-84`; MCP health never probes the backend,
  `mcp/src/server.ts:214`; smoke readiness certifies on any 200,
  `scripts/lib/smoke-main.ts:280-296`). *(re-reports review-docs-015)*
- **004 — GAP_IMPL — rerun reason validation divergence**
  (`backend/src/api/routes/admin.ts:575-577` accepts any non-empty ≤500 chars,
  bypassing the shared 10..500 validator at `:118-122`; full reason stored in
  worker-visible payload at `:583-584` vs `docs/architecture.md:2033-2050`).
  *(re-reports review-docs-012)*
- **008 — INCONSISTENT — eleven anchor-less self-links** inside
  `docs/architecture.md` (`:7,35,90,177,206,223,556,592,825,2874,3233` plus
  `:367`), and three decisions.md links that lost their distinct targets
  (`docs/decisions.md:188,267-268,392`).
- **010 — STALE — §6 lists dropped tables** `committee_takes`/
  `committee_submissions` (`docs/architecture.md:275-281`; dropped by
  `backend/migrations/0006_committee_reconcile.sql:7-8`); §9.8 presents done
  reconciliation work as pending (`:795-800`).
- **011 — STALE — hermetic/FetcherProvider remnants.**
  `docs/architecture.md:387-389` and `.env.example:105-106` call hermetic “the
  smoke default”; `docs/architecture.md:1499` blesses the removed
  FetcherProvider; the same doc says there is no hermetic smoke mode
  (`:1617-1623,1675-1684`); `scripts/lib/smoke-env.ts:54` defaults live.
  *(re-reports review-docs-010, expanded)*
- **014 — GAP_DOC — §9.5 REST surface incomplete plus phantom route.**
  `docs/architecture.md:731` names `apply/unlock` (zero hits in code); shipped
  but undocumented: #226 token-claim flow, take receipts, REST memos,
  verify-token, open-session; notification env (`.env.example:76-83`) absent
  from doc and deploy checklist; `api-reference.html` is ahead of the canonical doc.
- **021 — UNRESOLVED_DECISION — 202 `{jobId}` spec vs synchronous 200/201**
  (`docs/architecture.md:2561-2562` vs
  `backend/src/api/routes/committee-admin.ts:38,70-182`; no ratifying ADR).
  *(re-reports review-docs-011)*
- **024 — STALE — D18/deployment §-references keep topology numbering**
  (`docs/decisions.md:425,427,446`; `docs/runbooks/deployment.md:98`; contrast
  the correct anchor at `deployment.md:61`).
- **025 — GAP_IMPL — GitOps deploy pipeline is aspirational**
  (`docs/runbooks/deployment.md:17-28` vs eight CI-only workflows;
  `scripts/gitops-credentials.ts:1278` says so itself; no TLS/cert options for
  the documented Origin CA design). *(re-reports review-docs-016, narrowed)*
- **026 — INCONSISTENT — secrets inventories disagree with code and each other.**
  Runbook requires `ANTHROPIC_API_KEY`/`FRED_API_KEY`/`RPC_URL`
  (`docs/runbooks/deployment.md:150,219`; echoed at
  `docs/architecture.md:583`); the backend reads only `BASE_RPC_URL`
  (`backend/src/config.ts:462`); the credential doctor manages
  `ADMIN_TOKEN`/`ANALYTICS_TOKEN` the runbook omits and skips items it
  requires (`docs/runbooks/credential-doctor.md:74-92`,
  `scripts/gitops-credentials.ts:151,157,222`). Misprovisioned RPC reproduces
  the public-endpoint 429 class. *(re-reports review-docs-006)*
- **027 — STALE_COMMENT — phantom “US-Q2” anchor**
  (`frontend/public/assets/js/app/alpine/views/admin-surface.js:18,66,266`,
  `frontend/test/browser/admin-surface.spec.ts:5`; never existed even in the
  deleted plan; the behavior is US-Q1's acceptance at
  `docs/architecture.md:2065-2066,2447`).
- **028 — STALE_COMMENT — frontend/contract back-links misdirect**
  (`frontend/public/views/admin.html:3`, `admin-surface.js:3`, both synced
  copies of `routes.js:159` (§7.1 first-matches the analytics pipeline — the
  worst case), four `admin/committee-*.js` headers, `participation.html:534`).
- **030 — TEST_CLAIM_MISMATCH — mcp/src/e2e.ts logs instead of asserting**
  the no-show absent set (`mcp/src/e2e.ts:413`), cross-role denials
  (`:559-577`, “insecure mode — gate open”), and never attempts a post-close
  submission, vs the claims at `docs/architecture.md:772-775`.
  *(re-reports review-docs-009)*
- **032 — TEST_COVERAGE_MISSING — every drifted claim sits outside the doc-guard suite.**
  The guard tier genuinely executes (163 pass / 0 fail), but
  `scripts/check-docs-analytics.sh` is presence-only (passed with finding 011's
  stale lines) and no guard binds the state list, hermetic defaults, runbook
  secret names, admin route tables, or how-it-works.html to code.
- **033 — STALE_COMMENT — scripts/tests citations keep old numbering**
  (`scripts/tests/goldens-header.test.ts:4,26`,
  `scripts/tests/frontend-routes.test.ts:75`).

### Low / info

- **001 (info) — STALE — CONTRIBUTING placement map and lint glob** cover only
  `docs/*.md`, excluding `docs/runbooks/` and `docs/archive/`
  (`CONTRIBUTING.md:99`, `scripts/lint-docs.sh:26-27`).
- **016 — STALE — live-data section names** `allocation.ts` and
  `00XX_buyback_swaps.sql` (`docs/architecture.md:1245,1312`) for files shipped
  under other names.
- **017 — STALE — misc cluster:** `/api/committee/sessions/:id` spelling
  (`docs/architecture.md:1554`), “06:00–08:00” vs actual 06:00–10:00 defaults
  (`:706`, `.env.example:92`, `backend/src/config.ts:395-399`), `robotmonet`
  hostname typo (`docs/archive/allocation-data-root-causes.md:4`).
- **018 — GAP_DOC — smoke-plan.md silently dropped:** the commit message claims
  it was folded in, but none of its 282 lines survive anywhere; one retargeted
  citation silently changed referent (`docs/architecture.md:1781`).
- **022 — STALE — documentation map keeps its docs-index framing**
  (“this directory”, “sections below”, self-link;
  `docs/architecture.md:3223-3239`).
- **023 — GAP_DOC — archive index lists zero entries**
  (`docs/archive/index.md:1-8`); rename provenance of the sole archived file is
  recorded nowhere.
- **034 — STALE — Plan issue #15 cites deleted/moved/never-created doc paths**
  (preview-server-spec ×7, plan-admin-surface ×5, prd.md ×8, etc.).
  *(re-reports review-docs-018; the #206 portion is obsolete — closed via #224)*

### Prior-review disposition

Of the 18 prior findings: **008 RESOLVED** (issue #208 landed via #229;
residual stale text re-reported as 013). **001, 003, 004, 013, 017 narrowed or
restated** in merged findings (002/028/033, 015, 009, 019+020, 029).
**002, 005, 006, 009, 010, 011, 012, 014, 015, 016, 018 still open**,
re-reported with fresh HEAD evidence (007→012 as well). No prior finding was
found to have been fixed silently without trace.

## Clean areas

- Consolidation was content-lossless: all five folded specs are verbatim
  carries (only H1→H2 smoketion, whitespace, separators, link retargets).
- Zero references to the seven deleted docs or old runbook paths remain
  outside point-in-time review artifacts; all inbound runbook links updated.
- All relative file links in canonical docs resolve, including anchored links.
- D1–D18 all present with a consistent supersession chain.
- Hostname/subdomain/port map consistent across topology, D13/D18,
  deployment.md, README, compose, and config; MCP endpoints test-guarded.
- Cron values, env vars, removal claims, and migration references all verified
  docs↔code; smoke-spec MCP tool table exactly matches server registrations.
- participation.html and api-reference.html match `contract/src/routes.js`
  with executed consistency coverage.
- Doc guards green post-consolidation: 163 pass / 0 fail;
  `check-docs-analytics.sh` and `lint-docs.sh` exit 0.
- recyclebin manifest entries match contents; the archived investigation is
  byte-identical; no archived document is cited as live.

## Recommended actions

1. **Restructure first (015):** delete the `:1007-1008` merge artifact,
   renumber the six absorbed specs into one hierarchy, then re-run the
   back-link repoint emitting unique numbers or heading anchors — this
   collapses findings 002, 024, 028, 033 into one mechanical pass.
2. **Resolve the four self-contradictions (012, 013, 011, 019/020):** rewrite
   lifecycle chains to persisted states, mark the schedules-disabled bullets
   superseded by #208, fix the hermetic-default lines, and convert the
   admin-surface baseline to present tense with as-built route tables.
3. **Revert the retro-edits (031)** in `recyclebin/MANIFEST.md` and
   `docs/code-review/20260714-review-maintainability-claude.json`; append
   dated addenda instead.
4. **Fix the operator-facing inventory (026, 006):** `BASE_RPC_URL`, drop
   unconsumed keys, reconcile doctor↔runbook, document
   `WORKER_DATABASE_URL`.
5. **Rewrite how-it-works.html (029)** against §9.4/§9.4.1 and extend the
   committee-docs consistency test to it.
6. **Add the missing doc guards (032)** per the four concrete extensions listed
   in the finding.
7. **Ratify or delete** the 202-queued-actions spec (021) and decide the
   goldens-gate question (009).

## Documentation changes

All owner=architecture/decision findings above are documentation changes; no
canonical documents were modified by this review (reporting only, per
contract). The single suggested non-doc doc change: record smoke-plan.md's
intentional drop in `docs/archive/index.md` (018, 023).

## Unresolved decisions

1. Are admin committee lifecycle actions intentionally synchronous 200/201 or
   required to be queued and return 202?
2. Is D13/D18 deployed current state, accepted target state, or external
   infrastructure whose automation lives elsewhere?
3. Is `WORKER_DATABASE_URL` mandatory outside ephemeral environments?
4. Does the repository need a separate PRD, or should the Plan stop requiring
   one?
5. Which goldens oracle is accepted: live-cluster shape comparison or offline
   contract conformance?

## Limitations and unreviewed surfaces

**Limitations:** anchor slugs verified manually, not via a renderer; runtime
behavior, live infrastructure, and branch protection not observable from the
repo; backend/mcp/Playwright suites not executed by reviewers (they run in the
required integration job); external claims (MCP Registry, Cloudflare ports,
rmpc releases URL) unverified; GitHub inspection limited to issue #15, #206,
and open lists; the prior review covered a dirty snapshot — dispositions
compare claims against HEAD rather than byte-diffing it; the 20260714
maintainability artifact was skimmed for doc findings only; all line numbers
cite commit 6e5cfb4.

**Unreviewed surfaces:** public documentation outside the Investment Committee
pages; deep frontend copy outside implicated views; public-symbol comments
outside implicated modules; generated API documentation outside contract/src;
docs/archive content beyond provenance checks; brand-assets; recyclebin
content beyond manifest reconciliation; specialist security/economics/
reliability/maintainability concerns not implicated by documentation claims.
