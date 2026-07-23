# Documentation Alignment Review — 2026-07-21

## 1. Scope and pinned snapshot

- **Repository:** git@github.com:robotmoney/robotmoney-frontend.git
- **Branch:** adhoc/20260721-190555-docs-cleanup
- **Commit:** c42c47a526b618ed08a26db406c059df9f1646be
- **Reviewed:** 2026-07-21 UTC
- **Snapshot:** the review intentionally covers the uncommitted docs-cleanup
  worktree, not only the committed tree. Before either artifact was created,
  git diff HEAD --binary had SHA-256
  96af0c4611dd596aca70b291698f11d56d1f3923a9772194f0626b2c4a132045.
  The only then-untracked files were
  docs/archive/allocation-data-root-causes.md and docs/archive/index.md.
- **Scope:** canonical architecture and accepted decisions; runbooks; the GitHub
  Plan and relevant open issues; public Investment Committee documentation;
  route/DTO contracts; migrations, configuration, implementation, source
  back-links, tests, and CI that substantiate documented runtime claims.
- **Exclusions:** product-requirement alignment could not be reviewed because no
  PRD exists. Running production/staging infrastructure and branch-protection
  settings were not inspected.
- **Repository instructions:** no repository-local AGENTS.md was present. The
  supplied Superfield global instructions, review-docs execution contract, review
  contract, review-tests method, and test-coverage policy governed this review.

## 2. Headline verdict

**The implementation has several sound boundaries, but the canonical
documentation is not safe as an agent-development guide.** The 3,227-line
architecture file is a concatenation of current-state architecture, copied
feature specifications, implementation plans, acceptance criteria, and a second
Architecture document. It contains mutually exclusive claims and describes
unimplemented behavior as present. Public committee documentation, the
deployment runbook, source back-links, and the GitHub Plan then point at
different generations of those contracts.

The result is not merely excessive length: an agent following the current
documents can choose the wrong route family, lifecycle model, data source,
credential set, health semantics, or deployment procedure while remaining
locally consistent with one section.

## 3. Severity summary

| Severity | Count | Finding IDs |
|---|---:|---|
| high | 8 | 002, 003, 005, 006, 013, 014, 016, 017 |
| medium | 9 | 004, 007, 008, 009, 010, 011, 012, 015, 018 |
| low | 1 | 001 |
| **total** | **18** | |

The JSON artifact is the deterministic finding list.

## 4. Methodology

Three independent workers mapped canonical documents, implementation/contracts,
and tests/CI. This synthesis re-read primary evidence and adversarially rejected
or merged overlaps:

- The goldens problem is one TEST_CI_SURFACE_MISSING finding, rather than a
  duplicate stale-doc finding: the normative promise is a blocking CI check and
  the missing execution surface is the durable defect.
- Committee lifecycle scheduling is separate from the queued-versus-synchronous
  admin decision. The former is an observed implementation gap tracked by issue
  #208; the latter is explicitly unresolved in the Plan despite shipped code.
- Demo-source contradictions were retained only where canonical sections make
  mutually exclusive claims; implementation and CI clearly select the live path.
- Deployment workflow, TLS termination, and accepted D13/D18 topology were
  consolidated because they share one missing operational implementation.
- Missing tests were not reported when the underlying behavior itself is absent
  or contradicts the requirement. Those cases are GAP_IMPL findings instead.

The review built a bidirectional map among docs/architecture.md,
docs/decisions.md, docs/runbooks, contract/src, backend migrations and source,
frontend public docs, scripts, workflows, tests, GitHub Plan issue #15, and
relevant open issues. The prior maintainability review was checked; the still-open
goldens finding retains review-maintainability-033 as related evidence.

For test honesty, the committed HEAD's successful GitHub runs were inspected:

- integration run 29858449577 executed 141 root tests and 462 backend tests,
  with 15 explicitly gated live-provider tests skipped in that job;
- e2e run 29858449567 executed 24 MCP tests and 56 Playwright tests;
- Postgres is provisioned by the backend preload and fails loudly if unavailable;
  no relevant continue-on-error or swallowed test command was found;
- live-provider suites have separate scheduled execution guards.

Those CI logs validate the committed HEAD, not the dirty documentation snapshot;
that distinction is recorded under limitations.

## 5. Findings

### 001 — STALE_HEADER — low

Source back-links no longer identify stable canonical sections. The e2e workflow
points to deleted docs/demo-spec.md; migration 0017 says architecture section 5
although the concatenated file has several unrelated section-5 headings; admin
and frontend module headers use labels such as US-A2 and section 4 that are
ambiguous after the fold.

**Evidence:** .github/workflows/e2e.yml:98;
backend/migrations/0017_admin_surface.sql:1;
backend/src/admin/overview.ts:1-18;
frontend/public/assets/js/app/alpine/views/admin/committee-subject.js:1-3.

**Impact:** automated and human traceability from behavior to canonical intent is
broken precisely where the architecture rewrite needs it most.

**Recommendation:** give the concise architecture stable named anchors and update
module-level back-links in one mechanical pass; link detailed contracts to
contract files or tests rather than volatile numeric sections.

### 002 — INCONSISTENT — high

The shared dashboard DTO contract no longer describes the dashboard API it is
supposed to own. AllocationFramework in contract/src/dashboards.d.ts has
asof/vaultContract/weighted buckets, while the implementation returns
strategy/buckets/asOf/source/managed. VaultEconomics omits the implemented
source and adapter configured fields; wallet provenance omits seed; and the
contract defines no DTOs for buybacks, token metrics, or wallet sleeves.
Competing interfaces now live in backend modules and browser tests.

**Evidence:** contract/src/dashboards.d.ts:43-88;
backend/src/chain/allocation-framework.ts:27-33;
backend/src/chain/vault-economics.ts:16-43;
backend/src/chain/buyback-logs.ts:32-49;
backend/src/chain/token-metrics.ts:43-53;
backend/src/chain/wallet-sleeves.ts:47-69;
frontend/test/browser/allocation-view.spec.ts:31-73.

**Impact:** an agent can satisfy the declared cross-boundary contract while
breaking the real wire shape. Type checking and check-contract do not catch it
because scripts/sync-contract.ts copies only routes.js.

**Recommendation:** move all six shipped response shapes and provenance unions
into contract/src/dashboards.d.ts, import those types in backend/tests, and add an
executed DTO-conformance check rather than redeclaring browser-local interfaces.

### 003 — STALE — high

docs/architecture.md is structurally a bundle of old documents, not one
current-state architecture. It has a second H1 at line 986, restarts numbered
sections repeatedly, includes an implementation checklist, a demo specification,
an admin implementation plan and definition of done, a preview specification
with an open decision, and a topology document. Its own documentation map says
mutable roadmaps, task checklists, and phase ordering do not belong in docs.

**Evidence:** docs/architecture.md:1;
docs/architecture.md:986;
docs/architecture.md:1289-1312;
docs/architecture.md:1831-1855;
docs/architecture.md:2690-2723;
docs/architecture.md:2846-2856;
docs/architecture.md:3202-3218.

**Impact:** headings and back-links are ambiguous, temporal requirements appear
canonical after implementation has diverged, and agents cannot distinguish
guardrails from delivery history.

**Recommendation:** replace the file with a short current-state guide organized
by guardrails, boundaries, runtime components, trust/data flows, environments,
and an agent change map. Keep exact DTOs in contract, schema in migrations,
operations in runbooks, tests in tests, decisions in decisions.md, and execution
status in the GitHub Plan.

### 004 — TEST_CI_SURFACE_MISSING — medium

Architecture and CONTRIBUTING promise a CI drift gate that blocks stale goldens,
but the same architecture later says the gate is not wired, the capture script
warns that nothing blocks drift, and no workflow invokes a shape comparison.
The existing goldens-header test only asserts that the source comment admits the
gap.

**Evidence:** docs/architecture.md:197-201;
CONTRIBUTING.md:38-43;
docs/architecture.md:2800-2820;
scripts/update-goldens.ts:6-13;
scripts/tests/goldens-header.test.ts:1-30;
.github/workflows/integration.yml:60-74.

**Impact:** preview and Playwright can replay the same stale fixture and pass,
while contributors are told CI certifies its shape.

**Recommendation:** either implement the documented contract/field-shape gate
with nonzero executed assertions or remove every blocking-gate claim and record
golden recapture as an unaudited author responsibility. Related:
review-maintainability-033.

### 005 — INCONSISTENT — high

Architecture states that worker analytics isolation is backed by the restricted
rm_worker database role. In runtime configuration, WORKER_DATABASE_URL is
optional and falls back to the unrestricted DATABASE_URL; docker-compose and
.env.example describe the restriction as optional, and the deployment runbook
does not require or provision the worker credential.

**Evidence:** docs/architecture.md:253-264;
docs/architecture.md:448-466;
backend/src/db/worker-client.ts:1-22;
docker-compose.yml:37-57;
backend/migrations/0016_worker_role.sql:10-16;
docs/runbooks/deployment.md:144-160.

**Impact:** a production deployment can satisfy its documentation while lacking
the database permission boundary presented as an invariant. Source-level import
tests do not replace runtime least privilege.

**Recommendation:** decide whether rm_worker is mandatory outside ephemeral
environments. If mandatory, fail boot without WORKER_DATABASE_URL and document
credential provisioning; if optional, downgrade the architecture language from
invariant to optional hardening.

### 006 — INCONSISTENT — high

The production configuration inventory is self-contradictory. Architecture says
DATABASE_URL is the only required environment variable, while the worker refuses
to boot in demo/prod without ANALYTICS_TOKEN and production project pipelines
fail closed without PROJECTS_SOURCE=live. The runbook includes PROJECTS_SOURCE
but omits ANALYTICS_TOKEN/ANALYTICS_API_URL/ADMIN_TOKEN/WORKER_DATABASE_URL and
still names RPC_URL instead of the implemented BASE_RPC_URL.

**Evidence:** docs/architecture.md:569-584;
backend/src/analytics/api-client.ts:34-47;
backend/src/projects/access/select.ts:13-29;
docker-compose.yml:37-57;
docs/runbooks/deployment.md:144-160;
docs/runbooks/deployment.md:218-225.

**Impact:** a by-the-book production deployment can fail at worker boot, leave
privileged routes unusable, or configure a variable the code never reads.

**Recommendation:** make one generated or tested production environment
inventory authoritative, including purpose, consumer, default, secret status,
and fail-closed behavior; link architecture to it instead of repeating values.

### 007 — INCONSISTENT — medium

The same architecture defines two persisted committee lifecycles. Early and demo
sections include brief_published; the admin specification says explicitly that
brief_published is not persisted. Migration, contract, and implementation use
scheduled → collecting directly.

**Evidence:** docs/architecture.md:612-620;
docs/architecture.md:683-698;
docs/architecture.md:1354-1357;
docs/architecture.md:1869-1873;
contract/src/committee.d.ts:169-172;
backend/src/committee/domain.ts:461-474.

**Impact:** state-machine changes and tests derived from one section cannot agree
with the database or the other canonical section.

**Recommendation:** document only the six persisted states and describe brief
publication as the scheduled-to-collecting transition/action, not a state.

### 008 — GAP_IMPL — medium

Architecture says committee lifecycle cron jobs autonomously orchestrate the
session chain and that demo schedules allow no-intervention progress. All five
committee schedules are seeded disabled; source comments call cron triggering a
future addition. Open issue #208 is the current plan to make them configurable.

**Evidence:** docs/architecture.md:683-698;
docs/architecture.md:1486-1495;
backend/src/db/seed.ts:23-30;
backend/src/db/seed.ts:65-72;
https://github.com/robotmoney/robotmoney-frontend/issues/208.

**Impact:** a non-demo installation never opens or advances committee sessions
without an external/manual driver, contrary to the architecture's operating
model.

**Recommendation:** until #208 lands, state that committee scheduling is
disabled and demo-driven. After implementation, document only the resolved
environment contract and durable orchestration invariant.

### 009 — TEST_CLAIM_MISMATCH — medium

Architecture says the committee E2E asserts no-show absence, out-of-window
rejection, cross-role denial, and published real takes. The harness marks/logs
absent members without asserting the published absence set, has no out-of-window
submission, and logs member attempts against regime/admin routes without
asserting their statuses. A token/member mismatch is asserted, but that is not
the full cross-role matrix claimed.

**Evidence:** docs/architecture.md:746-755;
mcp/src/e2e.ts:318-376;
mcp/src/e2e.ts:495-521.

**Impact:** documentation overstates executed system coverage; regressions in
three named safety behaviors can remain green.

**Recommendation:** add explicit throws/assertions for the published no-show,
post-close submission, member-to-analytics denial, and member-to-admin denial,
or narrow the architecture claim to what the harness really asserts.

### 010 — INCONSISTENT — medium

The demo specification allows a seeded provider for hermetic runs, while its
later hermeticity section and the actual resolver say every local and CI demo is
live and that no hermetic demo mode exists. The per-PR e2e workflow also declares
live external providers.

**Evidence:** docs/architecture.md:1469-1481;
docs/architecture.md:1594-1609;
scripts/lib/demo-env.ts:1-23;
.github/workflows/e2e.yml:86-104.

**Impact:** an agent cannot tell whether deterministic offline execution is a
supported demo contract or only a backend-unit-test source.

**Recommendation:** state one current rule: demo/e2e defaults are live;
ANALYTICS_SOURCE=hermetic is a local debugging/backend test override, not a
supported demo mode.

### 011 — UNRESOLVED_DECISION — medium

The embedded admin specification fixes lifecycle actions as queued operations
returning 202, but the shipped contract and route implementation execute
synchronously and return 200/201. GitHub Plan issue #15 explicitly records the
synchronous behavior as a tested de facto contract that was never formally
ratified.

**Evidence:** docs/architecture.md:1855-1864;
docs/architecture.md:2142-2150;
backend/src/api/routes/committee-admin.ts:35-38;
backend/src/api/routes/committee-admin.ts:125-150;
contract/src/admin.d.ts:406-425;
https://github.com/robotmoney/robotmoney-frontend/issues/15.

**Impact:** code, UI, contract, and implementation plan disagree on latency,
response envelopes, observability, and retry semantics.

**Recommendation:** formally choose synchronous domain transitions or queued
202 actions in decisions.md/Plan, then make architecture describe the accepted
choice and delete the rejected specification.

### 012 — GAP_IMPL — medium

The admin research-rerun contract requires a 10–500 character reason stored only
in audit data and excluded from worker payload/logs. The route accepts any
non-empty reason up to 500 characters and stores the full reason in the job
payload; the test explicitly expects that payload.

**Evidence:** docs/architecture.md:2011-2028;
backend/src/api/routes/admin.ts:550-588;
backend/tests/api/admin-research.test.ts:169-205.

**Impact:** short/non-actionable reasons pass, and human audit text is propagated
to worker-visible state contrary to the documented data-minimization boundary.

**Recommendation:** either enforce validateReason and write a linked audit
request id into the payload, or revise the canonical requirement and explain why
worker payload retention is intended.

### 013 — STALE — high

The embedded admin API table is not the shipped admin API. It places committee
routes under /api/admin/committee, specifies PATCH resources, list/detail routes
and queued action envelopes that do not exist, and names research routes that
differ from contract. The current contract deliberately documents the real
/api/committee/admin resources and synchronous responses.

**Evidence:** docs/architecture.md:2410-2449;
contract/src/routes.js:76-101;
contract/src/routes.js:125-145;
contract/src/admin.d.ts:208-236;
contract/src/admin.d.ts:297-325;
contract/src/admin.d.ts:406-425;
backend/src/api/routes/committee-admin.ts:20-38.

**Impact:** an agent implementing or calling the admin surface from architecture
will use nonexistent paths, methods, response envelopes, and DTO fields.

**Recommendation:** delete the route/DTO catalog from architecture. Treat
contract/src/routes.js and contract/src/admin.d.ts as canonical and summarize
only the trust boundary and domain ownership in architecture.

### 014 — GAP_IMPL — high

The admin specification's required committee-domain corrections have not landed
on the worker/demo domain path. openSession resets an existing session to
scheduled, publishBrief has no state/roster/active-subject/future-close guards
and reads unbounded latest regime plus exact-date signals, closeWindow reports
success after a zero-row update, aggregation reads the latest subject snapshot
without an at-or-before bound, and reopen only flips state without replacing
deadlines or rescheduling jobs.

**Evidence:** docs/architecture.md:2551-2583;
backend/src/committee/domain.ts:451-479;
backend/src/committee/domain.ts:593-603;
backend/src/committee/admin.ts:495-568;
backend/tests/committee-admin-surface.test.ts:286-363.

**Impact:** retries can rewind sessions, future data can leak into historical
briefs/aggregates, invalid transitions can be reported as successful, and the
documented reopen contract is not performed. Existing tests cover the simpler
admin guard matrix but do not execute the promised domain corrections or reopen.

**Recommendation:** resolve whether these remain product requirements. If yes,
implement them in the single domain path used by worker and admin and add
adversarial timestamp/state/reopen tests; if not, remove them from canonical
architecture and Plan.

### 015 — GAP_IMPL — medium

Architecture defines a shared dependency-aware /health contract for every
surface. The API always returns HTTP 200 with status ok even when its DB probe
says down; MCP returns ok without probing the backend; demo readiness accepts any
successful HTTP response.

**Evidence:** docs/architecture.md:3053-3063;
backend/src/api/index.ts:79-84;
mcp/src/server.ts:206-214;
scripts/lib/demo-main.ts:1006-1019.

**Impact:** Cloudflare/demo readiness can certify a surface whose required
dependency is unavailable, defeating the documented keystone health contract.

**Recommendation:** define one small health DTO in contract, return non-2xx or a
distinct readiness endpoint when required dependencies fail, make MCP probe API,
and execute negative dependency tests in CI.

### 016 — GAP_IMPL — high

Accepted D13/D18 and the deployment runbook describe CI-applied Cloudflare/
DigitalOcean infrastructure, Origin CA TLS at API/MCP origins, firewalls, Spaces
CDN, and managed Postgres. The repository has no deploy/GitOps/release workflow;
the credential doctor itself warns that credentials are not consumed. API and
MCP start plain Bun HTTP servers with no TLS options, and compose publishes HTTP
ports without a TLS terminator.

**Evidence:** docs/decisions.md:184-215;
docs/decisions.md:420-450;
docs/runbooks/deployment.md:15-37;
docs/runbooks/deployment.md:91-100;
backend/src/api/index.ts:48-50;
mcp/src/server.ts:206-209;
docker-compose.yml:76-107;
scripts/gitops-credentials.ts:1270-1279.

**Impact:** the accepted production topology is not reproducible from the repo,
and the stated no-proxy design has no component that presents the Origin CA
certificate.

**Recommendation:** either implement and test the deployment/TLS path or label
D13/D18 as target-state decisions and rewrite the runbook as a design checklist,
not an active GitOps procedure. External infrastructure was not inspected, so
this finding is limited to repository-owned implementation.

### 017 — STALE — high

The public How it works page describes a fixed daily schedule, disk-written
briefs/snapshots, an absent scripts/committee/select-subject.js selector,
five-miss auto-deactivation, a disk-reading session generator, Claude synthesis,
and static JSON publication. The adjacent participation guide says timing is
operator-controlled and dynamically discovered through open-session; current
architecture says RM generates no member content; schedules are disabled; and
the live API/Postgres implementation is the operational path.

**Evidence:**
frontend/public/views/docs/investment-committee/how-it-works.html:57-125;
frontend/public/views/docs/investment-committee/how-it-works.html:145-158;
frontend/public/views/docs/investment-committee/how-it-works.html:301-327;
frontend/public/views/docs/investment-committee/participation.html:284-300;
frontend/public/views/docs/investment-committee/participation.html:374-381;
docs/architecture.md:603-610;
backend/src/db/seed.ts:65-72.

**Impact:** this is a prominently linked public operational guide. Prospective
agent developers can schedule against nonexistent times/files/scripts and infer
host-generated content that the protocol explicitly forbids.

**Recommendation:** rewrite it from the current API/worker model, or clearly mark
the static data as a historical archive. Add a route/claim consistency test like
the participation/API-reference guard.

### 018 — STALE — medium

The GitHub Plan and open issues still declare deleted docs/plan-admin-surface.md
and docs/demo-spec.md, plus nonexistent docs/prd.md, as canonical sources.
Issue #206 currently names the deleted admin plan as canonical, and Plan metadata
retains old expected touchpoints. No PRD is tracked anywhere in the snapshot.

**Evidence:** https://github.com/robotmoney/robotmoney-frontend/issues/15;
https://github.com/robotmoney/robotmoney-frontend/issues/206;
docs/architecture.md:3202-3218;
docs/prd.md (absent at the reviewed snapshot).

**Impact:** Superfield workers cannot resolve the promised product authority and
may follow deleted source documents or treat architecture's copied plan text as
the replacement without an explicit decision.

**Recommendation:** update Plan issue metadata and open issue canonical-doc
lists to surviving authorities. Create a PRD if product requirements need a
separate canonical owner; otherwise explicitly designate architecture plus
public protocol docs and stop referencing docs/prd.md.

## 6. Clean or adequately covered areas

- Accepted decisions D1-D18 preserve useful rationale and supersession links;
  the main problem is current-state/implementation status, not absence of
  decision history.
- The browser/backend/MCP HTTP boundary is clear, and runtime route literals are
  centralized in contract/src/routes.js with a vendored-copy drift check.
- Analytics writes use the authenticated API boundary; tests cover token
  exclusivity, source-level worker isolation, and rm_worker write denial.
- Queue lanes, leases, natural-key idempotency, forward-only migrations, roster
  snapshots, recommendation signatures, and auth-before-SQL have substantive
  implementation tests.
- Current participation.html and api-reference.html agree on dynamic session
  discovery and the signing/submission routes; their route literals have a
  consistency test.
- CI executes nonzero root, backend, MCP, and browser test counts. Postgres
  provisioning is loud-fail, and the live nightly guards prevent an accidentally
  disabled live suite from appearing as coverage.

## 7. Recommended actions

1. Replace architecture.md with a concise current-state agent guide. Preserve
   only stable guardrails, ownership, boundaries, trust/data flows, runtime
   environments, and a change map.
2. Ratify the committee lifecycle transport decision (queued 202 versus
   synchronous 200/201) and resolve the domain-correction requirements before
   describing either as current architecture.
3. Repair the dashboard DTO contract and add executed wire-shape conformance.
4. Rewrite the public How it works page from the current dynamic API/session
   model.
5. Make the production environment inventory authoritative and decide whether
   restricted rm_worker credentials are mandatory.
6. Either implement D13/D18 deployment/TLS automation or relabel it honestly as
   target state.
7. Implement or remove the promised goldens gate and the overstated committee
   E2E assertions.
8. Update the GitHub Plan and source back-links only after stable architecture
   anchors exist.

## 8. Documentation changes

The concise architecture should not retain exact endpoint tables, DTO
definitions, SQL, cron expressions, demo choreography, acceptance criteria,
test matrices, issue histories, or delivery order. Canonical destinations:

| Information | Canonical owner |
|---|---|
| stable boundaries, trust, ownership, invariants | docs/architecture.md |
| rationale and supersession | docs/decisions.md |
| route paths and DTO shapes | contract/src |
| schema and durable constraints | backend/migrations |
| configuration and defaults | config source plus one tested operator inventory |
| deployment/credential procedure | docs/runbooks |
| product sequencing and open work | GitHub Plan |
| executable behavior claims | tests and CI |
| public committee participation protocol | frontend public docs |

The rewritten architecture should begin with guardrails, then system map,
repository ownership, runtime components, trust boundaries, domain flows,
environments, an agent change map, and canonical references. Named anchors must
replace numeric references before source back-links are repaired.

## 9. Unresolved decisions

- Are admin committee lifecycle actions intentionally synchronous 200/201, or
  must every action be queue-observable and return 202?
- Is D13/D18 the deployed current state, an accepted target state, or an external
  infrastructure state whose automation lives elsewhere?
- Is WORKER_DATABASE_URL mandatory outside ephemeral environments?
- Does the repository need a separate PRD, or should the Plan stop requiring one?
- Which goldens oracle is accepted: a live-cluster shape comparison or an
  offline contract conformance gate?

## 10. Limitations and unreviewed surfaces

- This is a review of a dirty, uncommitted snapshot identified by the recorded
  diff hash. The two review artifacts themselves are intentionally outside that
  pre-artifact hash.
- No PRD exists, so product-to-architecture traceability could not be established.
- Full local backend tests were not rerun because the required Postgres
  dependency was unavailable to the review worker. The cited GitHub runs execute
  committed HEAD c42c47a, not the dirty docs-cleanup changes.
- Branch-protection required-context configuration was not independently
  inspected; workflow definitions and run logs were inspected.
- Production/staging DNS, certificates, droplets, databases, and vendor
  dashboards were not observed. Deployment findings describe repository-owned
  evidence only.
- The GitHub Plan and relevant open issues were inspected, but merged issue/PR
  history was sampled rather than exhaustively replayed.
- Public docs outside the Investment Committee, deep frontend copy, generated
  API documentation, and public-symbol comments outside implicated modules were
  not exhaustively reviewed.
- Security, economics, reliability, and maintainability beyond their direct
  documentation claims remain separate specialist-review surfaces.
