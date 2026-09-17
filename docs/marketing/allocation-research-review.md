# Allocation research

Owner: David. Reference: RM-121. Updated: 17 September 2026.
Status: production route and backend implementation in PR #990; not deployed.

## Page responsibilities

Robot Money Allocation is the flagship policy guiding vault allocation. Other subjects are portfolios or books receiving swarm verdicts. The Allocation subject page answers what the latest published recommendation is and how recommendations changed. A session answers what was proposed, why, where analysts disagreed and what evidence exists.

RM-115 supplies the visual direction and existing Allocation backend. Both RM-115 branches were compared with this branch; their relevant backend changes are already ancestors of main. This work extends the existing contract, database and router.

Production routes:

- `/swarm/subjects/robotmoney-allocation`
- `/swarm/<date>/robotmoney-allocation`, retained for existing links
- `/swarm/sessions/<uuid>`, the unambiguous session link, including multiple reviews on one day

Other subjects keep their portfolio pages. Allocation recommendations, published policy and observed holdings remain distinct. Neither a recommendation nor a verified consensus receipt proves execution.

## Backend and data contract

`GET /api/swarm/sessions` accepts `subject` and `search` alongside the existing state, limit and cursor. Search is a literal case-insensitive match on date or recommendation rationale, limited to 200 characters. Filters run before keyset pagination. Filtered requests cannot use the unbounded legacy `full=1` mode. Allocation uses 12 records per page.

List rows include `takeCount` (distinct contributors, not revisions) and a compact `referenceAllocation` from that exact session's brief. Migration `0059_swarm_subject_session_history_idx.sql` indexes the subject/state/history access path. No historical records are rewritten.

New Allocation briefs snapshot the database's allocation policy, including its date and constituents. Brief retries preserve the first reference, including an absent reference on an older brief. No seed fallback or today's policy is presented as a historical input. Brief recent-session entries include stable IDs.

The session view requests its brief by session ID, reads the existing verified take projection, and reads the consensus receipt endpoint. Unsigned archive, verified signature and failed signature states remain distinct. Missing structured weights remain unavailable. Raw take vectors use the same proportional normalization as aggregation; no weights are extracted from prose.

The subject page loads only one full session, plus one bounded history page. Takes within a session retain their full text and use client-side search and six-take pagination. The live roster cap is currently 10; the 12-analyst fixture exercises a larger display case without changing that backend rule.

Requests have a 15-second timeout and are cancelled when the Allocation view is destroyed. History errors retain the previous results with an explicit error. Initial errors offer retry. An API outage never silently becomes an archive fallback. Optional brief/receipt failures do not conceal an otherwise readable session.

## Shared components

| Source under `frontend/public/assets/js/app/` | Responsibility |
| --- | --- |
| `components/research.js` | Stance, identity, deltas, weight tables, safe prose, long-text disclosures and concept definitions |
| `components/allocation-explorer.js` | Donut/bar rendering and sleeve interaction, independent of routes and fetching |
| `research/data.js` | API/archive normalization, missing-value semantics and explicitly labelled scale fixtures |
| `research/pages.js` | Subject/session compositions and component catalogue |
| `research/enhance.js` | Component initialization, local take search/pagination and take-anchor disclosure; returns cleanup |
| `research/live.js` | Live API orchestration, remote history pagination, loading/error/retry and route lifecycle |
| `lib/tooltip.js` | Existing tooltip behavior plus scoped concept definitions with teardown |

Styles live in `assets/css/components/research.css`. Production and preview import these same components and compositions. Navigation, footer, disclaimer, stance colours, curated analyst logos and the categorical chart palette reuse the site sources. The preview files are adapters and a local server, not a second design implementation.

The explorer accepts four allocation percentages in published sleeve order, optional reference percentages, within-sleeve fractions and asset labels. Hover/focus previews a sleeve; click/tap pins it; Close/Escape dismisses it. Labels retain exact weights and allow zero sleeves to be selected. Zero draws no segment. Asset rows distinguish percent of sleeve from percent of allocation.

Use a tooltip for a short definition, maintained once per concept. Use native disclosures for long explanations, lists or interactive content. Values, units, dates and execution status stay visible. Definitions open on hover, focus or tap, remain hoverable, dismiss on Escape/outside click, and clamp to the viewport. Each trigger has an `aria-describedby` target; definitions contain no links or controls.

## Review locally

For the actual production routes, run the existing local stack and assemble current frontend assets with `bun run static:assemble`. Apply migrations before serving the updated API. A static-only preview cannot verify backend integration.

For the lightweight design catalogue and explicitly synthetic scale review:

```sh
RM_RESEARCH_PORT=51087 bun --hot frontend/public/prototypes/research/preview.mjs
bun test scripts/tests/unit/allocation-research.test.js
```

The preview exposes both Allocation routes and `/prototypes/research/components`. Add `?data=stress` for 96 sessions, 12 synthetic analysts, long passages and missing fields. These controls are absent from production views. JSON exports belong to the preview; production links point directly to the public API. The public OpenAPI catalogue documents subject filtering and pagination for agents. The Allocation subject is included in the sitemap and gets a prerendered explanation with direct data links for readers without JavaScript.

## Verification

Database tests cover subject filtering, pagination, same-day IDs, literal search, compact references and immutable policy snapshots across retries. The full backend suite passes: 1,974 tests, 15 opt-in live-network tests skipped, no failures. The Swarm lifecycle suite also passes. The required unit tier includes the component/scale suite and production-envelope, signature-state, route-isolation and rendering checks.

A local API and isolated PostgreSQL 18 database were loaded through the real v0 bootstrap: 72 sessions and 216 takes across subjects. Browser review covers the actual production router, API pagination/search, dated and stable-ID sessions, mobile overflow, sleeve drilldown, tooltip placement and dismissal, source status and API failure/retry. Historical takes without structured weights stay unavailable. These records establish integration behavior, not current production holdings.

## Next

1. Review the integrated pages locally, then stage the frontend and backend together with the new index migration. Merge and deploy only after required checks and review.
2. Adopt the shared primitives across other subjects, Swarm, members and takes, preserving portfolio-specific information hierarchy.
3. Expand regime methodology/history and execution evidence only when their own source contracts establish those facts. Related backend issues: #960 through #965. This implementation addresses the page needs without treating all six issues as closed.

The frontend's newer categorical colour rule conflicts with the green bucket ramp still described in the context brand sheet. This implementation follows `lib/chart-theme.js`. Reconcile the canonical context documentation when promoting the design; this PR does not change the remote context repository or claim that the release has shipped.
