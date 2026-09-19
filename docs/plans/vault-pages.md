# Plan: the four vaults on /allocation, /vault/:slug and the vault subject

**Branch:** `david/vault-pages` (frontend only). **Written:** 2026-09-17, revised 2026-09-19.

## Decisions

1. **The stack.** A PortfolioRouter plus four leg vaults, one per sleeve: rmUSDC (Conservative DeFi Yield), rmAGENT (Agent Tokens), rmPROTO (Protocol Tokens), rmRWA (Real World Assets). No vaults of vaults. The router routes new deposits by its applied weights and holds no funds. The stack runs on the staging devnet only (chain 918453, test USDC, resets); production stays rmUSDC alone on Base until the mainnet decision.
2. **/allocation** is where the recommendation meets execution. A Vaults section lists the four vaults with Recommended (the latest published robotmoney-allocation recommendation), Applied (the router's effective weights), Actual (each vault's share of the four vaults' TVL) and the two gaps, plus combined TVL, tracking error and freshness. Each row links to `/vault/:slug`. The meta row's Contract becomes Router. Asset-level holdings live on the vault pages only: /allocation keeps each sleeve's target constituents (the recipe).
3. **/vault/:slug** (`rmusdc`, `rmagent`, `rmproto`, `rmrwa`, never an address) is the per-vault factsheet: header, facts, holdings, allocation for this vault, history, activity, mechanics and risk, deposit. noindex until the production launch review. Bare `/vault` goes to `/allocation#vaults`; the old `#vault` anchor stays valid. Never a yield promise, never "principal-protected".
4. **The vault swarm subject** (`/swarm/subjects/robotmoney-vault`) shows one combined Holdings section grouped by vault. Its total is the sum of the four vaults. "Read from" lists the router (no value) and the four vaults with sleeve and value. The ring shows each vault's actual weight against the weights in force; a vault opens its positions. The chart stacks the four vaults in their sleeve hues with the target drawn over them.
5. **Data.** No backend exists yet for the four vaults. The pages run on fixtures (below) and code against the documented DTO, so the endpoint drops in. Additive fields only, no migrations.
6. **One switch** between the production-like state and the four-vault devnet fixtures, applying to all three pages alike. Devnet figures always carry "Devnet test data"; a production-like host never shows them.

## Code

- `frontend/public/assets/js/app/lib/vault-data.js`: pure. The four identities (`VAULTS`; each vault's hue is `CATEGORICAL[i]`, the same as its sleeve's everywhere), `SLEEVE_NOTE`, the drift maths (`normalizeOverview`), the Base-feed mapping (`legacyRaw`, `withRecommendation`), formatters, `isLocalHost`, `canDeposit`.
- `frontend/public/assets/js/app/lib/vault-source.js`: the switch and every read (`loadVaultOverview`, `loadVaultDetail`, `loadLatestRecommendation`, `loadVaultSubjectFixture`). Its header comment documents the switch.
- `loadAllocationDto(hostname)` in `lib/allocation-framework.js`: the allocation DTO, with the shipped manifest as a fallback on local hosts only.
- Tests: `scripts/tests/unit/vault-data.test.ts` runs both modules against the shipped fixtures and archive.
- The pages are built from the `.rr-*` research-record components in `views.css` (not `.alp__tbl` or `.rm-stats`, and no vault stylesheet of their own).

## Local preview

The switch is a query parameter kept per tab in sessionStorage (`rm.vaults`), so it survives clicks between the three pages. It acts only on a local host: `localhost`, `*.localhost`, `127.0.0.1`, `[::1]` and `stage.robotmoney-labs.dev`. Every other host is production-like, ignores the parameter and never reads a fixture, the saved snapshot or the archive.

- `/allocation?vaults=devnet`
- `/vault/rmagent?vaults=devnet`
- `/swarm/subjects/robotmoney-vault?vaults=devnet`
- `/allocation?vaults=devnet-unreadable`, and likewise `devnet-no-recommendation`, `devnet-stale`, `devnet-paused`
- `?vaults=base` switches back (the default).

Base mode reads, in order: `GET /api/dashboards/robotmoney-vaults`; if that route is absent (404, or the SPA shell answering), `GET /api/dashboards/vault-economics` with the latest published robotmoney-allocation recommendation laid over it; if a read fails otherwise, the saved Base snapshot on a local host ("Saved Base snapshot"), "Vault data unavailable" elsewhere. On the static preview every `/api` call fails, so base mode shows the saved snapshot and the archive's 2026-06-24 recommendation (95/3/0/2).

## Fixtures

All under `frontend/public/data/vaults/`, synthetic: no addresses, no prices of real tokens, no return claims. They ship publicly with the site, and only a local host reads them.

- `devnet/overview.json`: the overview DTO for the four-vault stack. Combined $100,000; Recommended 65/15/15/5, Applied 70/10/15/5, Actual 72/9/14/5; tracking error 700 bps.
- `devnet/{rmusdc,rmagent,rmproto,rmrwa}.json`: detail DTOs (holdings, 15 daily TVL readings, 11 to 14 activity rows, router weights, recommendation receipts). Each vault has its own share price and its own events. Token holdings are labelled as `/allocation` names the constituent (BTC, Gold) and carry the held token as `symbol` (WBTC, GOLD); they have no balance or price, since the fixtures price no real token.
- `devnet/subject.json`: the vault subject's devnet book: the router and four vault wallets, and 15 daily snapshots whose positions carry `vault`.
- `base/vault-economics.json`: the saved Base snapshot, verbatim from `goldens/api-goldens.json` (Jul 30, 2026, TVL $199.70).

Each fixture carries the server-computed fields too; the unit test checks that `normalizeOverview` recomputes exactly those values.

## Drift maths

Weights in basis points; null is never 0.

- Recommended: the latest published robotmoney-allocation recommendation, per bucket. None published gives null (shown as "—"), never 0. A layer that does not have all four weights summing to 10000 is null for every vault, never rescaled.
- Applied: the router's effective weights.
- Actual: a vault's TVL over the four vaults' TVL. A vault confirmed absent from the network counts as 0; an unreadable or missing one makes every actual null.
- Governance gap = applied − recommended. Flow gap = actual − applied. Gap = actual − recommended. Tracking error = ½ Σ |actual − recommended|.
- A recommendation counts as applied only if a router weight recorded after it equals it.

On Base today, Applied is null (no router on Base), so /allocation and each vault page show Recommended, Actual and one Gap instead of three layers and two gaps; Actual is rmUSDC 100% and 0% for the three vaults not on Base. The three-layer layout returns as soon as the source reports a complete Applied layer (the devnet now, the backend later).

## Data contract (for Lucas)

`GET /api/dashboards/robotmoney-vaults` and `/api/dashboards/robotmoney-vaults/:slug`, same origin. The path is `VAULTS_ENDPOINT` in `vault-data.js`, deliberately not in contract ROUTES until the route exists.

```
overview: { asOf, network:{chainId, label, testData}, freshness:{blockNumber, indexedAt, stale},
  combined:{tvlUsd, vaultsLive}, trackingErrorBps,
  router:{address, availability, appliedAt},
  recommendation:{sessionId, publishedAt, releasedOnChain|null}|null,
  vaults:[{slug, symbol, name, bucket, availability:"live"|"not_on_network"|"unavailable",
    status, address, tvlUsd, sharePrice, exitFeeBps,
    recommendedBps|null, appliedBps|null, actualBps|null, gaps:{governance, flow, total}}] }

detail = the overview row plus:
  network, holdingsAsOf, flags:{depositsPaused, withdrawalsPaused, shutdown},
  caps:{tvlCap, perDepositCap, utilizationBps}|null, apy|null, depositors|null, guards|null, auditStatus|null,
  contracts:{vault, router, registry}, mechanics:{redeemOnly, maxSlippageBps, venues[]},
  holdings:[{kind:"adapter"|"token"|"idle", label, symbol, venueType?, address, balance, valueUsd,
    weightBps, targetBps|null, priceSource|null, note|null}],
  history:{tvl:[{t, tvlUsd}], sharePrice:[{t, value}], weights:[{t, appliedBps, kind}],
    receipts:[{sessionId, t, recommendedBps, applied}]},
  activity:[{t, kind, assets, shares, tx}]
```

Additive fields beyond the 2026-09-17 draft (no migrations):

- overview `router: { address, availability, appliedAt }`;
- detail `auditStatus`; holdings `symbol`, `venueType`, `note`;
- subject snapshot positions `vault` (a slug);
- subject wallets `kind: "router" | "vault"`, `vault` (slug) and `sleeve` (bucket id). The robotmoney-vault manifest's wallet now carries them.

The frontend recomputes actual, the gaps, combined TVL and tracking error from the inputs, so the server's own values for those are ignored. Detail reads are checked against the requested slug and the overview's chain.

Handoff facts:

- The browser never calls the explorer API directly. On production (no explorer), the endpoint serves rmUSDC from vault-economics and marks the other three `not_on_network`.
- The Base feed carries no router weights and no recommendation provenance; the frontend adds the latest published recommendation itself.
- APY is not shown: the feed does not establish the net-of-fee treatment. Inception and admin or timelock facts are not in the DTO yet.
- No address or explorer URL is invented for staging. Only a well-formed Base address gets a BaseScan link.
- Empty history stays empty. Fewer than seven readings draw as points; a line never bridges more than three days.
- Before production: server-rendered data, the agent mirrors, sitemap inclusion and the vault pages' indexing need an integration review.
- Core asks still open: holdings snapshots; tvl cap and pause flags on the vault read; fixed-interval snapshots with share price; router weight `kind` and effective weights, with governance indexed on staging; per-vault depositors and flows.

## The vault subject

The Holdings target is the weights in force: the router's applied weights when the overview carries a complete Applied layer (the devnet now, the backend later), otherwise the framework target in force on that date. The ring names which ("applied 70%", "target 95%") and prints no delta of its own, since #latest already gives the gap; the chart legend says "Applied" or "Target" the same way. Positions carry the names their vault page gives them. The subject's own latest recommendation stays in its Latest section; #latest and the history keep measuring real sessions against the real book, in both modes, and #latest drops its "vs book" deltas while the devnet book is on, since the book below is then a different one. The page's lede states the subject; the manifest's `thesis_blurb`, which agents read as session context, is unchanged.

## Open questions for David

1. Which subject's published recommendation does the router apply: robotmoney-allocation (the Recommended column on /allocation and /vault/:slug) or robotmoney-vault (its own latest recommendation)?
2. /allocation's donut and ledger read the framework in force (seeded 95/5/0/0, in force since Jun 2, 2026), while the Vaults table's Recommended reads the latest published recommendation (95/3/0/2). Does the donut and ledger baseline move to the latest published recommendation (RM-115)? On the devnet the gap is wider: the Vaults table reads Applied 70/10/15/5 while the donut, ledger and sleeve cards still read 95/5/0/0. Should the recipe follow the router's applied weights once the router is live (as the vault subject's target already does)?
4. The rmUSDC lede, shared with the /allocation sleeve card, ends "aimed at capital preservation", which now sits above a deposit link. Keep it, or cut it to "Lending USDC. The lowest-volatility sleeve."?
3. The devnet fixtures ship publicly under `/data/vaults/devnet/`, though no page on a production host reads them. Keep them, or exclude them from the production static assembly?
