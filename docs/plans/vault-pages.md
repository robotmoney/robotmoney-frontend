# Plan: vaults on /allocation, and a detail page per vault (/vault/:slug)

**Status:** planned, design not started. **Written:** 2026-09-17.

**Based on:**
- frontend `origin/main` and `releases-0.5.x`;
- core `releases-0.4.x` (v0.4.0-rc.11);
- live staging explorer and production APIs.

**On approval:** save this plan to `docs/plans/vault-pages.md`.

## Context

David is designing how the vaults appear on the website:
- every vault with its holdings;
- TVL per vault and combined;
- how far holdings are from the latest allocation recommendation;
- the usual vault stats.

Decisions made:
- **Where:** `/allocation` lists the four vaults, and each vault opens its own detail page.
- **Data:** designed for the four-vault model (rmUSDC, rmPROTO, rmAGENT, rmRWA). Staging comes first.
- **Drift:** show all three layers: recommended, applied, actual.

What we have today:
- **`/allocation` knows only one vault.** It hardcodes rmUSDC (`allocation.js:50,55`), and its "Vaults X of 4" only counts defi-yield.
  - Its drift compares against the **seeded policy** (the single `allocation_framework` row, 95/5/0/0 as of 2026-06-02). The swarm's receipt plays no part.
  - The "Weights" chip always reads "seeded".
- **Real vault data comes from two unconnected sources:**
  - `/api/dashboards/vault-economics`: v0 rmUSDC on **Base mainnet**. It has TVL, share price, 7-day APY and adapter balances, sampled hourly. There's no history route, even though `vault_share_price_history` exists.
  - Core's explorer API: all four vaults, **staging devnet only** (chain 918453). Its addresses reset on every QA run.
- **The recommendation is published by the frontend** as consensus receipt weights (`weights[{bucket, weight_bps}]`, 4 buckets). The bucket→vault map is `contract/src/__fixtures__/consensus-receipt.bucket-vault-map.json`.
- **Applied** = the router's weights (`/v1/router/weights`, or on-chain `getEffectiveWeights()`).
- **Actual** = each vault's `total_assets` as a share of the total.
- **Nothing computes drift.** The dapp's `computeAppliedState()` only checks for an exact match against the *current* weights.
- **The explorer lacks several things:**
  - holdings;
  - APY;
  - share price (it can be derived);
  - caps (stored but not returned; `deposit_cap` is a "0" placeholder);
  - pause flags;
  - per-vault depositors;
  - a correct risk label (#1434/#1438);
  - timestamped, regular snapshots.
- **Staging's indexer can't see governance.** It doesn't set `INDEXER_ROUTER_GOVERNANCE`, so governance events are never indexed.

## Information architecture

### `/allocation`: add a "Vaults" section (the overview)

**Summary strip:**
- combined TVL;
- vaults live (N of 4);
- tracking error (½ Σ |actual − recommended|, the formula already in `allocation.js:487-495`);
- latest recommendation (session and date, and whether it's released on chain);
- data freshness (block or indexed time);
- a network label ("Devnet test data" on staging, "Base" on production).

**Vault table** (one row per vault; the row links to `/vault/:slug`):

| Column | Meaning |
|---|---|
| Vault | Name, symbol, category dot |
| Sleeve | Which bucket it serves |
| TVL | Per-vault TVL |
| Recommended | Recommended weight |
| Applied | Applied weight |
| Actual | Actual share of TVL |
| Gap | Actual − recommended, in percentage points, with the glyph first |
| Status | Vault status |

**Three-layer figure:**
- For each vault, three aligned bars or ticks: recommended → applied → actual. They make the two gaps visible:
  - **governance gap** = applied − recommended;
  - **flow gap** = actual − applied.
- Required copy: gaps close by routing new deposits, not by rebalancing. The router never moves existing positions.

**Replace the baseline.** `/allocation` drift and "Target" read the latest receipt, not the seeded policy. The seeded policy is removed or labelled as the June policy. This is a decision for RM-115.

### `/vault/:slug` (detail)

- **Slugs:** `rmusdc`, `rmproto`, `rmagent`, `rmrwa`. Never addresses, because staging addresses reset.
- **Routing:** bare `/vault` goes to `/allocation#vaults` (`routes.js:171` today). Update the stale `AGENTS.md:146,152`.

Sections, in order:
1. **Header:**
   - name and symbol;
   - sleeve;
   - network label;
   - status: Active, Paused, Retired, or not live on this network;
   - asset (USDC);
   - contract address with an explorer link;
   - one-line strategy.
2. **Key stats:**
   - TVL, and share of all vaults;
   - share price (NAV per share);
   - APY (7-day and 30-day, net of fees, labelled as trailing and never promised);
   - TVL cap and utilization;
   - per-deposit cap;
   - exit fee;
   - depositors;
   - inception.
3. **Holdings:** one row per position, with a within-vault bar. Each row shows:
   - position: an adapter (Aave, Compound or Morpho for rmUSDC) or a token (baskets);
   - balance;
   - USD value;
   - % of vault;
   - target % (equal weights today);
   - price source (TWAP, Chronicle).

   Also show idle USDC and when the data was read.
4. **Allocation for this vault:**
   - recommended, applied and actual now;
   - history of router weight changes;
   - receipts that touched it, with an applied / not applied flag.
5. **History charts:** TVL, share price and trailing APY, with 30D, 90D and All toggles. Reuse the Chart.js line pattern from `dash-vault-profile.js`, restyled to the covenant.
6. **Activity:** deposits and withdrawals, rebalances and allocations, fee events, with transaction links.
7. **Mechanics and risk:**
   - how deposits and withdrawals work: baskets are redeem-only, with a slippage bound;
   - dependencies (protocols, pools, oracles);
   - guards: NAV deviation, stale oracle, pause states;
   - admin and timelock;
   - contracts;
   - audits (or "not audited", stated plainly).
8. **How to deposit:**
   - Production: the v0 skill, and only for rmUSDC.
   - Staging: the unlisted staging skill is not linked (see `docs/plans/staging-vault-deposits-peaq.md`).
   - Never a yield promise, never "principal-protected".

## Drift maths (one shared module, unit-tested)

For each vault *i* (all values in bps, summing to 10000):
- `recommended_i`:
  - from the latest **published** receipt, with bucket→vault taken from the fixture map;
  - show "released on chain: yes/no" from `/v1/consensus-receipts` next to it;
  - no receipt gives `null`, shown as a dash, never 0.
- `applied_i` = router effective weights, preferably read live with `getEffectiveWeights()`. `/v1/router/weights` mixes voted and default rows (core ask below).
- `actual_i` = `total_assets_i / Σ total_assets`. An unreadable vault (for example an RWA stale oracle) makes actual `null` for all vaults and shows "unavailable". Never renormalise silently.
- The gaps:
  - `governance_gap = applied − recommended`;
  - `flow_gap = actual − applied`;
  - `total_gap = actual − recommended`.
- `tracking_error = ½ Σ |total_gap_i|`.
- **Applied/not applied** for a receipt: some router weight row after `recorded_at` equals its weights. This fixes the dapp's current-weights-only check.
- **Where it lives:** extract a pure helper from `computeAppliedState` and the existing `weightDelta` (`lib/weight-change.js` on `david/swarm-subject-consistency`) into `contract/src/` or `frontend/public/assets/js/app/lib/`. The page and its tests share it.

## Data contract

**One same-origin backend endpoint.** The browser never calls the explorer directly: it's a different origin, and which network is configured differs per environment.

Backend (Lucas's lane; issue with proposed code): `GET /api/dashboards/robotmoney-vaults` and `/api/dashboards/robotmoney-vaults/:slug`. It avoids `/api/dashboards/vaults`, which is the third-party dashboard.
- It aggregates:
  - the explorer API at a new per-environment `EXPLORER_API_URL`;
  - the frontend's own receipts (`swarm_consensus_receipts`);
  - a live Multicall read against the chain RPC for holdings, caps and pauses, cached for 60s;
  - on production (no explorer), `vault-economics` for rmUSDC, with the other three marked `not_on_network`.
- Overview shape:
  ```
  { asOf, network:{chainId, label, testData}, freshness:{blockNumber, indexedAt, stale},
    combined:{tvlUsd, vaultsLive}, trackingErrorBps,
    recommendation:{sessionId, publishedAt, releasedOnChain|null}|null,
    vaults:[{slug, symbol, name, bucket, availability:"live"|"not_on_network"|"unavailable",
             status, address, tvlUsd, sharePrice, exitFeeBps,
             recommendedBps|null, appliedBps|null, actualBps|null,
             gaps:{governance, flow, total}}] }
  ```
- Detail shape adds:
  ```
  caps:{tvlCap, perDepositCap, utilizationBps}, flags:{depositsPaused, withdrawalsPaused, shutdown},
  holdings:[{kind:"adapter"|"token"|"idle", label, address, balance, valueUsd, weightBps, targetBps|null, priceSource}], holdingsAsOf,
  apy:{d7, d30}|null, depositors|null,
  history:{tvl:[{t, tvlUsd}], sharePrice:[{t, value}], weights:[{t, appliedBps, kind}], receipts:[{sessionId, t, recommendedBps, applied}]},
  activity:[{t, kind, assets, shares, tx}], guards:{navDeviationGuardBps, oracleFresh|null},
  mechanics:{redeemOnly, maxSlippageBps, venues[]}, contracts:{vault, router, registry}
  ```

**Where each field comes from today:**

| Field | Source now | Gap and fix |
|---|---|---|
| TVL, combined TVL | `/v1/vaults` `total_assets`; `/v1/stats` | Available now |
| Share price | Derived: `total_assets / total_supply` (snapshots) | Derive in the backend endpoint |
| Recommended | Frontend receipts + bucket map | Available now |
| Applied | `/v1/router/weights` (mixed rows) or `getEffectiveWeights()` | Read live now; core ask 4 |
| Actual | Derived from `/v1/vaults` | Available now |
| Holdings | None indexed | Multicall now: `getAdapterInfo(i)` for rmUSDC; `assets(i)` + `balanceOf` + `assetUsdcValue` for baskets. Core ask 1 for history |
| Caps, pause flags | `vault_snapshots.tvl_cap` and `paused` stored but not returned; `perDepositCap` not indexed | Multicall now; core ask 2 |
| TVL, share price and APY history | Sparse, event-driven snapshots keyed by indexing time | Core ask 3; until then, charts show a "sparse data" state |
| Activity | `/v1/vaults/:address` `deposit_withdrawal_log`, `adapter_allocation_history`, `fee_history` (500 rows each, no pagination) | Available now |
| Depositors per vault | Global count only, counts gateway deposits only (reads 0) | Core ask 5; hide until then |
| Risk label | Always STABLE_YIELD | Don't show until #1438 lands |
| Receipts released on chain | `/v1/consensus-receipts` (`released`, `recorded_at`) | Available now; empty on staging until G03 |

## Industry-standard vault stats (checklist for the design)

What Morpho, Yearn, Euler Earn, Enzyme and similar vault pages show consistently, and where each stands for us:
- **Identity:** name, asset, chain, contract, manager or curator (here the swarm recommends and governance applies), inception. Available.
- **Size:** TVL, share of total, cap and utilization. TVL now; caps via Multicall.
- **Performance:** share price, trailing APY 7d/30d, TVL and share-price history. Share price derived; APY and history need core ask 3.
- **Composition:** allocation by adapter, market or token, with % and targets. Multicall now.
- **Liquidity and exit:** instant or redeem-only, exit fee, slippage bound, withdrawable now. From contract views.
- **Fees:** exit fee now; state plainly that there's no management or performance fee (09-14 decision).
- **Risk:** dependencies, oracles, guards, pause and admin powers, timelock, audits. Mostly static copy plus flags.
- **Activity:** recent flows, rebalances, governance changes. Available now.
- **Users:** depositors. Core ask 5.

## States to design

- **Loading:** reserve space on a stable parent grid.
- **Stale:** freshness older than the threshold.
- **Devnet test data:** a label on every figure region on staging.
- **Not live on this network:** production shows rmPROTO, rmAGENT and rmRWA this way.
- **Recommendation states:** none published yet; published but not released; released but not applied.
- **Vault conditions:** Paused, Retired, deposits paused, shutdown.
- **Holdings unavailable:** for example, an RWA stale oracle reverts `totalAssets`.
- **Leg unavailable:** the router skips it.
- **Sparse history:** fewer than N points, so show points, not a line.
- **Staging reset:** empty history and no receipts.

## Design rules that apply

From `.impeccable.md` "Data figures, deltas and notes" and the brand covenant:
- **Colour:**
  - Vault identity is **categorical hue** (`lib/chart-theme.js` CATEGORICAL), and each vault keeps the **same hue** on `/allocation`, `/vault/:slug` and the swarm pages. The green ramp is for magnitude only.
  - Deltas: green up, `--color-warn` down, glyph first.
  - Cyan never touches a figure. Beacon only marks attention points.
- **Type and shape:** mono for figures, no rounded corners, no gradients, no decorative rails, no narrow `ch` caps on prose.
- **Copy:**
  - Never name a table, route or schema.
  - No yield promises.
  - Explain applied vs recommended in plain words.
- **Reuse:**
  - the donut (`allocation.js:123-136,693-765`);
  - `.alp__tbl`, `.alp__dft` and the drift glyph/label helpers (`allocation.js:387-395,507-521`);
  - `assetDot` and `subjectDot` (`views/shared.js`);
  - `.rm-stats` and `.rm-table` (`components.css`).

## Work breakdown and lanes

1. **Design (David, now).**
   - Wireframes for the `/allocation` Vaults section and `/vault/:slug`, covering every state above.
   - Build fixtures from real staging payloads (`/v1/vaults`, `/v1/vaults/:address`, `/v1/router/weights`) and production `vault-economics`.
   - Decide the RM-115 baseline swap.
   - Linear first: a `linear-rm` issue under the allocation project.
2. **Drift module and tests (David).** A pure function with unit tests:
   - bps sum;
   - null receipt;
   - one vault unavailable;
   - applied-after-`recorded_at`;
   - the tracking error formula.
3. **Backend endpoint (Lucas; issue with proposed code).** `robotmoney-vaults` overview and detail, `EXPLORER_API_URL` configuration, Multicall reads, and the production fallback to `vault-economics`.
4. **Frontend views (David).**
   - Replace the hardcoded single vault in `allocation.js`.
   - New `views/vault.html` and `alpine/views/vault.js`.
   - Routes in `routes.js`: `/vault/:slug`, with `/vault` → `/allocation#vaults`.
   - SEO entries in `seo.js`.
   - A sitemap entry per vault slug, production only after mainnet.
   - Playwright specs following `allocation-view.spec.ts` with stubbed APIs (see the browser-specs-without-stack pattern).
5. **Core asks (Lucas; public core issues, none security-sensitive):**
   1. Holdings snapshots: a `vault_holdings_snapshots` table, served as `holdings` on `/v1/vaults/:address`.
   2. Return `tvl_cap` and pause flags; index `perDepositCap`, deposit/withdraw pause and shutdown; stop writing `deposit_cap = 0`.
   3. Fixed-interval snapshots for every vault, joined to `blocks.timestamp`, plus `share_price` and trailing 7d/30d APY.
   4. Router weights: a `kind` field (voted, default, applied); index `VotedWeightsCleared`; return `effective_weights`; set `INDEXER_ROUTER_GOVERNANCE` on staging.
   5. `/v1/vaults/:address/stats`: holders with shares > 0, and 24h/7d/30d net flows.
   6. Merge #1438 (risk label) into releases-0.4.x.
   7. #1433 `shortlist()` on ProtocolAssetVault; #1435 RWA contract size.
6. **Ship path:** PRs to `main`, cherry-pick to `releases-0.5.x`, RC, staging (after Fusion G09, as in the staging-deposits plan). Production gets the rmUSDC v0 data plus "not live on this network" for the rest. The other three go live on production only after the mainnet decision (D9).

Recommended order: design and the drift module first. They unblock everything, and fixtures make the views testable without the stack. Then backend asks 3 and 5.1-5.2. Views follow. Charts and APY wait for core ask 5.3.

## Verification

- **Unit:** the drift module tests (above), plus `bun run test:unit`.
- **Browser:**
  - Playwright specs with stubbed API fixtures for each state: devnet, production not-on-network, no receipt, vault unavailable, sparse history.
  - Run the route and SEO tests (`frontend-routes`, `agent-surface`, `prerender-routes`).
- **Rendered colour check:** read back the Chart.js dataset colours, so each vault keeps one hue across the donut, the table dots and the charts (`getChart(canvas)`).
- **Staging, after the RC:**
  - `/allocation` shows 4 vaults, and combined TVL equals `/v1/stats.total_tvl`.
  - Actual weights match the `/v1/vaults` shares.
  - Applied matches `getEffectiveWeights()`.
  - After G08, applied reads 8167/667/833/333.
- **Production:**
  - rmUSDC matches `/api/dashboards/vault-economics`.
  - The other three show "not live on this network".
  - No devnet figures appear.

## Open questions

- **RM-115 baseline:** replace the seeded policy with the latest receipt, or show both? [Recommend: the receipt replaces it; keep the policy text as history.]
- **Which recommendation counts as "latest":** latest published, or latest released on chain? [Recommend: published, with a "released on chain" flag.]
- **Public `/vault/:slug` pages for vaults not on mainnet:** do they exist at all? [Recommend: yes, with an honest "not live on Base yet" state, and noindex until live.]
- **Holdings history:** a hard requirement for v1, or current holdings only? [Recommend: current only for v1.]

## Carried over from the 2026-09-16 plan



## Frontend implementation scope, 17 September

This workstream implements frontend pages, pure display calculations, and local fixtures only. Backend routes, contracts, history ingestion and deployment remain with Lucas. The local four-vault preview is synthetic; the Base preview uses the saved July snapshot. Neither is current chain data.

Defaults: use the latest published receipt, show release separately, current holdings for v1, keep all vault detail routes noindex until the production launch review. Bare /vault navigates to /allocation#vaults. The existing #vault anchor also remains valid.

Linear tracking needs follow-up: the Robot Money connection requires authentication; the other connected workspace is TNT Labs. No issue was created in that workspace.
