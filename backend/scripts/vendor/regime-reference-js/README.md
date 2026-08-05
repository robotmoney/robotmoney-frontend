# Vendored original-JS regime reference (issue #447)

## What this is

This directory vendors the **original, independently-written JavaScript**
regime-analytics pipeline — verbatim, unmodified — so that
`regime-independent-reference-regenerate.ts` (one directory up) can
regenerate this repo's cross-implementation fidelity golden fixtures
(`backend/tests/fixtures/regime/regime-compute-reference.json.gz` and
`regime-backtest-correlations-reference.json.gz`) from a real independent
implementation, not this repo's own TS port.

**These files are vendored verbatim for offline regeneration of
independent-fidelity golden fixtures only — they are never imported by
production or runtime code.** `backend/tests/no-new-vendor.test.ts`-style
forbidden-host scanning does not apply to this directory; nothing here is
reachable from `src/`.

## Provenance

- **Source repo:** [`robotmoney/robotmoney-site`](https://github.com/robotmoney/robotmoney-site),
  a fork (same GitHub org as this repo) of the original
  [`agentjuno/robotmoney`](https://github.com/agentjuno/robotmoney). Verified
  2026-08-02 that both repos hold byte-identical blobs for every file listed
  below (`gh api repos/<owner>/<repo>/contents/<path> -q '.sha'` matches
  across both repos for each path).
- **Source paths** (all under `scripts/regime/` in the source repo):
  - `compute.js` → this directory's `compute.js` — blob sha
    `75cd2110b5db587efdb04c3531aed1ffa07b1624`
  - `lib/indicators.js` → `lib/indicators.js` — blob sha
    `a752928c673c20aef77cde81888183039b57e1ca`
  - `lib/transforms.js` → `lib/transforms.js` — blob sha
    `69228d18678fb5526e258f55573b818c08fba227`
  - `lib/utils.js` → `lib/utils.js` — blob sha
    `3ae7ea1859adfea0001506fcccc5322a8d6147e8`
  - `update.js` — NOT vendored wholesale (it pulls in live-fetcher
    dependencies this repo doesn't need). Its `computeCorrelations`,
    `computeBacktest`, and `stripDailyFromSnapshot` functions (plus their
    private helpers) are extracted **verbatim** — no logic changes, only
    lifted out of `update.js`'s file-writing/CLI orchestration so they're
    callable standalone — into this directory's `backtest-correlations.js`.
    Source blob sha for the whole file (identical in both repos):
    `aa51879cf7eea299871e1744a89ba9cdf13c0546`.
- **Date fetched/verified:** 2026-08-02.

## Why this exists (issue #447)

PR #444 (issue #400) claimed the original out-of-repo JS reference generator
was "permanently unavailable" and regenerated the two fidelity fixtures using
this repo's own TS pipeline instead — silently converting two "STRICT"
independent cross-implementation tests into mere self-consistency checks.
That claim was false: `robotmoney/robotmoney-site` is an active fork in the
same GitHub org and still holds the exact original code, byte-identical to
upstream `agentjuno/robotmoney` (verified above). This directory restores the
genuine independent reference so `regime-independent-reference-regenerate.ts`
can regenerate the two fixtures from it, rather than from this repo's own
port.

## Rules for this directory

- **Verbatim only.** No algorithmic changes, ever. If the upstream pipeline
  changes, re-fetch and re-verify blob shas rather than hand-editing.
- **Never imported by `src/`.** Only `regime-independent-reference-regenerate.ts`
  requires/imports these files, and only at regeneration time (an explicit,
  human-invoked `bun run` command, never CI, never demo boot, never
  production).
- **CommonJS**, as in the source repo — do not convert to ESM/TS; the point is
  to run the original code unmodified.
