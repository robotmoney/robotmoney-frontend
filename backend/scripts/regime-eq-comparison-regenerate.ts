// Regenerates frontend/public/data/regime-eq-comparison.json — the
// /blog/regime-eq-vs-base research report. Ported from agentjuno/robotmoney
// scripts/regime/regime-eq-comparison.js (R1, docs/v0-v1-quant-platform-
// parity-report.md §8 Phase R / D5): that script had NO v1 implementation and
// v1 was serving a byte-frozen copy of v0's last publication (asof
// 2026-05-30) that nothing in this repo could regenerate.
//
// Inputs, matching v0's exact contract (regime-eq-comparison.js:47-58,131-143):
//   - the raw (pre-transform) indicator floor
//   - regime-snapshot.json's `extras.eth` / `extras.spx` chart-overlay price
//     series (the walk-forward backtest's risky-asset legs)
//
// v1's pipeline does not yet persist `extras` on regime_snapshots (parity
// report 8.5, Phase 2 item 10) — until it does, this script sources both
// inputs from the same committed regime fidelity fixtures the rest of the
// regime suite already trusts (backend/tests/fixtures/regime/). The pure
// computation (analyze/regime-eq-comparison.ts) takes both as explicit
// arguments and has no opinion on where they came from — a golden-replay
// test or a future DB-backed regenerate path can substitute a different
// source without touching the math.
//
// Usage: bun run scripts/regime-eq-comparison-regenerate.ts
import { gunzipSync } from "node:zlib";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { computeRegimeEqComparison } from "../src/analytics/analyze/regime-eq-comparison.ts";
import type { Point } from "../src/analytics/types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXDIR = join(HERE, "..", "tests", "fixtures", "regime");
const DEST = join(HERE, "..", "..", "frontend", "public", "data", "regime-eq-comparison.json");

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

interface SnapshotExtras {
  extras: { eth: Point[]; spx: Point[] };
}

function loadSnapshotExtras(): SnapshotExtras {
  const snap = JSON.parse(readGz("regime-snapshot.json.gz"));
  return { extras: snap.extras };
}

function main(): void {
  const raw = loadRawIndicatorHistory();
  const { extras } = loadSnapshotExtras();

  const result = computeRegimeEqComparison({ raw, extras });
  const out = { generated_at: new Date().toISOString(), ...result };

  writeFileSync(DEST, JSON.stringify(out, null, 2));

  const f = (s: (typeof result)["backtest"]["eth"]["base"]) =>
    `${s.final_value.toFixed(2)}x  cagr ${(s.cagr * 100).toFixed(1)}%  sh ${s.sharpe.toFixed(2)}  mdd ${(s.max_drawdown * 100).toFixed(0)}%`;
  console.log(`[regime-eq-comparison-regenerate] wrote ${DEST}`);
  console.log(
    `\nasof ${out.asof}  agreement ${(out.agreement.same_pct * 100).toFixed(1)}%  panels macro/onchain/factor = ${out.indicator_counts.macro}/${out.indicator_counts.onchain}/${out.indicator_counts.factor}\n`,
  );
  for (const port of ["eth", "spx", "mixed"] as const) {
    console.log(`=== ${port.toUpperCase()} / cash ===`);
    const b = out.backtest[port];
    console.log(`  base          ${f(b.base)}`);
    console.log(`  eq            ${f(b.eq)}`);
    console.log(`  macro alone   ${f(b.macro_alone)}`);
    console.log(`  onchain alone ${f(b.onchain_alone)}`);
    console.log(`  factor alone  ${f(b.factor_alone)}`);
    console.log(`  HODL          ${f(b.hodl)}\n`);
  }
}

main();
