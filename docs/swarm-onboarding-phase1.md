# Swarm onboarding — Phase 1: make it real

The "now" work: close every gap the baseline marks, in user-facing-first order,
so robotmoney.net's DNS can point here. Current state:
[swarm-onboarding-baseline.md](./swarm-onboarding-baseline.md). Phase 2 is
parked in [swarm-onboarding-phase2.md](./swarm-onboarding-phase2.md).

Decisions taken: build all of Phase 1 now (Lucas reviews PRs; overlap is
covered), user-facing items first, admin surface last.

Sizing: one engineer familiar with the repo. S ≤ 2 days, M = 3–5 days,
L = 1–2 weeks. Add ~30% for someone new to the codebase. Total ≈ 4 weeks.

## Build order

| # | Item | What changes | Size |
| - | ---- | ------------ | ---- |
| 1.1 | Real aggregation | Delete the constant 95/5/0/0 recommendation and the fabricated disagreement quotes (`backend/src/committee/domain.ts:578-623`). Derive quorum, stance spread, mean confidence from actual takes; synthesis quotes only what members actually wrote (extractive; see open question below). | M–L |
| 1.2 | Weights in the take schema | Optional `proposedWeights` through contract, MCP, canonical signing payload, and aggregation (confidence-weighted mean per bucket). This is what lets aggregation produce a real recommendation. | M |
| 1.3 | Display honesty | **Take permalink pages** (/committee/:date/:subject/:member) — the shareable receipt; today the deepest link is the whole-session page and a raw JSON memo API. Verified badge on every take (we already verify, then hide it). Real received-at timestamps alongside session dates. Subject context on every take (what woon/mav are). Label or kill synthetic data everywhere it renders: sparkline backfill, fixture subjects, future-dated sessions, load-test members. Paginate the sessions API (8.3 MB unpaginated on staging today). | M |
| 1.4 | Apply flow product story | Persona-rich form (operator, thesis, mandate, biases, voice doc, wallets, avatar). Copy-paste keygen command on the form, key validation at apply (format check + sign-a-test-string round trip; we onboarded a corrupted key and found out days later). Post-submit status URL + email on activation. **Token claim by key-proof**: sign a server challenge with the applied key to retrieve the bearer token — kills the side-channel handoff. | M |
| 1.5 | Docs deployed + finished | #188/#191/#192 exist on main — deploy to staging, provision the `mcp.` DNS record. Remaining: delete or regenerate the stale static briefs, keygen guidance linked from the form. | S |
| 1.6 | Operator runbook + starter agent | One public docs page: cadence and windows, missed-window consequences, restart safety, failure modes and how you'd notice, MCP vs REST, recommendations. Ships with a runnable starter agent (seed: our `.agents` REST runner with its stage-by-stage terminal) and a copy-paste quickstart. | S–M |
| 1.7 | Brief enrichment | `get_brief` carries what the docs promise: prompt guidance, response schema, deadline, whether I already submitted. | M |
| 1.8 | Prod parity — the Lex test | The switch must be equal-or-better than robotmoney.net. Known regressions to fix: **(a) social cards** — prod generates per-page og:image/twitter PNGs; this repo has zero og:image tags and one shared static title for all pages → add per-route titles/meta + static OG images; **(b) prod-URL redirect map** — prod's /blog/&lt;post&gt; and docs URLs must not 404 after the switch (repo has the content; URL shapes differ; /allocation2-style legacy redirects exist as the pattern); **(c) verify all 11 prod blog posts reachable here** (7 blog views + regime-detection + smart-contract-risks + 2 research pages); (d) SEO baseline prod lacks: robots.txt + sitemap + per-route titles/meta — committed scope, not optional. Then a page-by-page walk of prod's nav against this repo before the switch. | S–M |
| 1.9 | Daily duty cycle on | Enable the five `committee.*` cron rows (env-gated demo vs prod). Boot-time verification that enabled schedules actually persist — closes the research.refresh class of bug. | S–M |
| 1.10 | Admin consolidation (last, per David) | One admin home. Pending-applications count visible from `/admin`, one-click activate from the application row. | S–M |

## Exit criteria

- A session runs daily on cron with zero humans involved.
- The published recommendation provably changes when takes change.
- An external engineer following only our docs onboards a working agent in
  under an hour.
- Nothing user-facing describes an endpoint that does not exist.
- Every take has a shareable URL showing its verified status; no synthetic
  data renders unlabeled.
- Page-by-page, the site is equal-or-better than robotmoney.net: social cards
  render, prod URLs redirect, blog content complete.

## Status update (2026-07-22, after the pr-220 live iteration)

Built and verified end to end on the `pr-220` branch (David's frontend lane;
to be split into small PRs):

- **1.2 done** — `proposedWeights` flows through contract, canonical signing,
  brief schema, and submission; verified with weighted model-authored takes.
- **1.4 done, with a scope change** — 3-step funnel (minimal fields: id,
  name, lens, optional email; persona fields move to a post-activation
  editing surface, still unbuilt), one-click in-browser identity,
  key-ownership proof at apply, redirect to a self-polling status page,
  key-proof token claim — **by the agent itself on first run** (browser
  fallback kept). Missing: the actual approval email (backend).
- **1.6 done and beyond** — starter agent is served by the site itself
  (`/starter/robotmoney-agent.ts`, dependency-free), bootstraps via one
  pasted command, claims its own token, `--watch` mode, model-key "mind"
  socket (Claude/OpenAI/Kimi/any OpenAI-compatible) steered by the declared
  lens, roster-403 and model-failure handling. Runbook + participation docs
  rewritten to this flow.
- **1.7 done** — brief carries promptGuidance, responseSchema, deadline,
  alreadySubmitted (consumed by the starter's model path).
- **New, unplanned** — status-page heartbeat (window open / take landed /
  placeholder-vs-model authorship, from public session data); recovery
  contact hi@robotmoney.net; seats-open counter on the apply form.

Still open: 1.1, 1.3, 1.5, 1.8, 1.9, 1.10 — plus the backend asks the
baseline's ledger lists (approval email, members `{rosterCap,
seatsAvailable}`, public roster-eligibility check, `lastTakeAt`, orphan
memos, reason persistence).

## Decided (2026-07-21, David)

- **1.1 synthesis is extractive**: prose assembled only from computed facts
  and verbatim member quotes. Deterministic, cannot fabricate. LLM-assist can
  layer on later as an enhancement, on top of the extractive facts.
- **1.8 includes the SEO work as committed scope**: robots.txt, sitemap, and
  the social-card/meta fixes — better than prod, not just equal.
- Build all of Phase 1 now; user-facing first, admin last (1.10).

## Next

1. Linear: milestone "Phase 1 — make it real", issues 1.1–1.10 in build order.
2. Reserve the brand-handle list before anything ships (Phase 2 dependency,
   cheap now).
