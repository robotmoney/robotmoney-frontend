// Regenerates frontend/public/data/weighting-comparison.json — the
// /blog/honest-backtesting-weights research report. Ported from
// agentjuno/robotmoney scripts/regime/weighting-comparison.js (R1,
// docs/v0-v1-quant-platform-parity-report.md §8 Phase R / D5): that script
// had NO v1 implementation and v1 was serving a byte-frozen copy of v0's
// last publication (asof 2026-05-14) that nothing in this repo could
// regenerate.
//
// Inputs, matching v0's exact contract (weighting-comparison.js:48-59,159-171):
//   - the raw (pre-transform) indicator floor
//   - regime-snapshot.json's `asof` and `extras.eth` / `extras.spx`
//     chart-overlay price series (the walk-forward backtest's risky-asset legs)
//
// v1's pipeline does not yet persist `extras` on regime_snapshots (parity
// report 8.5, Phase 2 item 10) — until it does, this script sources both
// inputs from the same committed regime fidelity fixtures the rest of the
// regime suite already trusts (backend/tests/fixtures/regime/). The pure
// computation (analyze/weighting-comparison.ts) takes both as explicit
// arguments and has no opinion on where they came from.
//
// Usage: bun run scripts/weighting-comparison-regenerate.ts
import { gunzipSync } from "node:zlib";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { computeWeightingComparison } from "../src/analytics/analyze/weighting-comparison.ts";
import type { Point } from "../src/analytics/types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXDIR = join(HERE, "..", "tests", "fixtures", "regime");
const DEST = join(HERE, "..", "..", "frontend", "public", "data", "weighting-comparison.json");

function readGz(name: string): string {
  return gunzipSync(readFileSync(join(FIXDIR, name))).toString("utf8");
}

interface RawRow {
  date: string;
  value: number;
}

function loadRawIndicatorHistory(): Record<string, RawRow[]> {
  const text = readGz("raw-indicator-history.csv.gz");
  const lines = text.split("\n");
  const out: Record<string, RawRow[]> = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const c = line.indexOf(",");
    const c2 = line.indexOf(",", c + 1);
    const date = line.slice(0, c);
    const id = line.slice(c + 1, c2);
    const v = parseFloat(line.slice(c2 + 1));
    if (!date || !id || !Number.isFinite(v)) continue;
    (out[id] ||= []).push({ date, value: v });
  }
  for (const id in out) out[id].sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

interface Snapshot {
  asof: string;
  extras: { eth: Point[]; spx: Point[] };
}

function loadSnapshot(): Snapshot {
  const snap = JSON.parse(readGz("regime-snapshot.json.gz"));
  return { asof: snap.asof, extras: snap.extras };
}

function main(): void {
  const raw = loadRawIndicatorHistory();
  const { asof, extras } = loadSnapshot();

  const result = computeWeightingComparison({ raw, snapAsof: asof, extras });
  const out = { generated_at: new Date().toISOString(), ...result };

  writeFileSync(DEST, JSON.stringify(out, null, 2));
  console.log(`[weighting-comparison-regenerate] wrote ${DEST}`);
  for (const [id, d] of Object.entries(out.methods)) {
    console.log(`\n${id}`);
    for (const port of ["eth", "mixed"] as const) {
      const f = (s: "composite" | "conservative" | "aggressive" | "hodl") =>
        `${d[port][s].final_value.toFixed(1)}x/sh${d[port][s].sharpe.toFixed(2)}/dd${(d[port][s].max_drawdown * 100).toFixed(0)}%`;
      console.log(`  ${port}: comp ${f("composite")}  cons ${f("conservative")}  aggr ${f("aggressive")}  hodl ${f("hodl")}`);
    }
  }
}

main();
