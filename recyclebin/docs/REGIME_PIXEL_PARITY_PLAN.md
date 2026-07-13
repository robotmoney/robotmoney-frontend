# Regime view — pixel-perfect parity plan

## Context

The buildless Alpine.js + Chart.js SPA (`frontend/public/`) ports the original
Next.js `robotmoney-site`. The `/regime` view is the most divergent page: the
port renders a fraction of the original `RegimeDashboard`. Target baseline is the
captured screenshot `frontend/test/fixtures/screenshots/original/regime.png`
(fullPage, 1440×900, deviceScaleFactor 1).

Goal: make `/regime` pixel-perfect with the original — hero, summary cards,
full-history regime-band chart, per-indicator sparklines, 3 panels (macro,
on-chain, **factor**), predictive-power table, 3 backtest equity-curve cards,
methodology footer.

Decisions (user): **full pixel parity** + **extend backend analytics** (live
endpoint serves the rich shape, not a static file vendored into the frontend).
To make pixel-diff meaningful, the DB is populated from the exact dataset behind
the screenshot (`robotmoney-site/public/data/regime-eq-snapshot.json`: 3 panels,
3 backtests, correlations, extras, 26 indicators, 2964 history rows, asof
2026-06-25). feat/12 (`analytics-port-original-backtest-predictive`) is a bare
worktree today — no code to build on; keep the store write-seam so its future
computed pipeline can replace the seed source with zero frontend change.

## Architecture facts (verified)

- `scripts/sync-contract.ts` copies ONLY `contract/src/routes.js`. Editing
  `contract/src/dashboards.d.ts` is invisible to `check-contract`; only
  `typecheck` (`tsc --noEmit`) validates it. No new route → no routes.js change.
- `backend/src/db/migrate.ts` applies `backend/migrations/*.sql` sorted, once,
  tracked in `schema_migrations`, idempotent on boot. Next file = `0010_*.sql`.
- Endpoint `GET /api/dashboards/regime-snapshots` → `fetchRegimeSnapshots(range)`
  (`backend/src/analytics/report/projections.ts`) → `SELECT *` on
  `regime_snapshots` → `rowToSnapshot`. Returns `{ latest, history }` of flat
  per-date rows. Blobs (backtest/correlations/extras/panels/bucket_thresholds)
  belong ONLY on the asof/latest row; history rows stay blob-free.
- Fonts + `--color-*` tokens already match the original (Space Grotesk /
  Instrument Serif / JetBrains Mono).

## Phase 1 — Backend plumbing (contract → DTO → store → schema)

- `contract/src/dashboards.d.ts`: add `RegimePricePoint`, `RegimeCorrelationCell`,
  `RegimeBacktestStrategy`, `RegimeBacktest = Record<string,Record<string,…>>`,
  `RegimeCorrelations = { forward, concurrent }`. Add OPTIONAL fields to
  `RegimeSnapshot` (populated on `latest` only): `panels`, `bucketThresholds`,
  `backtest`, `correlations`, `extras`. Blobs are typed pass-through with
  snake_case preserved inside (precedent: `indicators[].panel_weight`).
- `backend/src/analytics/report/projections.ts` `rowToSnapshot`: project the five
  new columns (`?? null`).
- `backend/src/analytics/store/regime-store.ts`: extend `RegimeSnapshotRow`,
  `upsertSnapshot` INSERT+VALUES+`ON CONFLICT DO UPDATE`, and `loadRegimeSnapshot`
  read-back for the five jsonb columns (`sql.json(...)`).
- `backend/migrations/0010_regime_dashboard_extras.sql`: `ALTER TABLE
  regime_snapshots ADD COLUMN IF NOT EXISTS {panels,bucket_thresholds,backtest,
  correlations,extras} jsonb;`
- Verify: `bun run typecheck`, `bun run check-contract`, `bun run test`.

## Phase 2 — Data population

- Vendor `robotmoney-site/public/data/regime-eq-snapshot.json` gzipped to
  `backend/tests/fixtures/regime/regime-eq-snapshot.json.gz` (self-contained; no
  sibling-repo runtime dependency).
- Shared pure mapper `backend/src/analytics/report/regime-eq-map.ts` exporting
  `mapEqSnapshotToDto(snap) => { latest, history }` and
  `eqSnapshotToRows(snap) => RegimeSnapshotRow[]` (flat history rows +
  one enriched asof row: `indicators`=26 rich objects, panel indices/percentiles,
  `panelWeights`, and the five blobs). Used by BOTH the importer and the
  Playwright stub → byte-identical DTOs.
- Importer `backend/src/db/import-regime-eq.ts`: gunzip+parse fixture,
  `saveRegimeSnapshots(eqSnapshotToRows(snap))`, CLI entrypoint. NOT folded into
  `seed.ts` (which runs on every boot). Explicitly invoked for demo/test.
- Verify (Track B): migrate + import against test DB, assert
  `latest.backtest.eth.composite.equity_curve.length>0`,
  `latest.correlations.forward.composite`, `latest.extras.spx`,
  `latest.panels` includes `factor`; history rows carry no blobs.

## Phase 3 — Frontend restructure

- `frontend/public/views/regime.html`: full top-to-bottom layout — hero (p5 art
  child `x-data`), 4 summary cards (regime + macro/onchain/factor index cards
  with position bars), full-history `<canvas>` + toggle chips, 3 panel tables
  (name · 24mo inline-SVG sparkline · last · signed pct · weight), predictive
  table, 3 backtest cards (metrics table + log-scale equity `<canvas>` + StatePie
  glyphs), methodology footer.
- `frontend/public/assets/js/app/alpine/views.js` `regimeView()`: multi-dataset
  `drawHistory()` (composite/macro/onchain/factor + SPX/ETH log overlays) with an
  inline `regimeBandsPlugin` (paints risk-on/neutral/risk-off bands from
  `history[i].regime`), `drawBacktests()` (log-scale equity curves + bands),
  `sparklineSvg()`, `statePie()`, `toggle()/isVisible()`, `fmtRho()`; generalize
  panel helpers to include `factor`; store `_charts[]`, destroy all. All charts
  `animation:false`.
- `frontend/public/assets/css/views.css`: add `rv__hero*`, `rv__posbar*`,
  `rv__chips/chip`, `rv__spark`, `rv__table/tr/td`, `rv__corr*`, `rv__bt*`,
  `rv__statepie`, `rv__method`. Reuse tokens + `regime-pill--*`.

## Exact chart/color spec

See the component spec captured in the planning notes (Chart.js configs, hex
colors, regime-band plugin, sparkline SVG, backtest log axis). Key literals:
composite `#00e5ff` (fill `rgba(0,229,255,0.10)`), macro `#7e889e`/`#e8a640`
(history line amber), on-chain `#e8a640`, factor `#a374e0`, SPX overlay
`#5fb3a1`, ETH overlay `#a374e0`. Bands: risk_off `rgba(232,166,64,0.10)`,
risk_on `rgba(0,229,255,0.08)`, neutral transparent. Grid `rgba(34,42,56,0.4)`,
tick text `#4a5268`, legend text `#7e889e`, tooltip bg `rgba(11,14,20,0.95)`.
Sparkline stroke: last≥0.5 → `#00e5ff` else `#ff6644`; mid dashed line at 0.5.
Backtest equity y-axis `type:"logarithmic"`, tick `{v}×`.

## Phase 4 — Pixel-diff harness

- `frontend/test/browser/regime-visual.spec.ts`: stub
  `**/api/dashboards/regime-snapshots*` with `mapEqSnapshotToDto(eqSnapshot)`,
  fulfill vendor CDN scripts from `node_modules`, 1440×900 viewport, navigate
  `/regime`, `await document.fonts.ready`, `toHaveScreenshot('regime-full.png',
  { fullPage:true, animations:'disabled', mask:[.rv__hero-art],
  maxDiffPixelRatio:0.01 })`.
- `playwright.config.ts`: add `expect.toHaveScreenshot` defaults.
- Non-gating `pixelmatch` iteration script vs `original/regime.png` (foreign
  renderer → not a hard gate; drives visual convergence, hero masked).
- Determinism: mask+freeze p5 hero, `animation:false` charts,
  `animations:'disabled'`, await fonts, static data.

## Phase 5 — Iterate to parity

Run pixelmatch vs original, tune CSS/spacing/colors on the masked non-hero diff
until under threshold; re-baseline `toHaveScreenshot`. Final gate:
`bun run typecheck && bun run check-contract && bun run test && bun run test:browser`.

## Risks

- Screenshot data mismatch: only the factor-inclusive eq-snapshot matches; the
  existing gz fixture lacks `factor_*`. Vendor the eq-snapshot explicitly.
- Non-deterministic p5 hero → mask + freeze.
- Foreign-renderer parity ceiling → gate on the port's own baseline, use
  pixelmatch-vs-original only as an iteration signal.
- Migration is forward-only; a botched DDL needs a new file, not an edit.
