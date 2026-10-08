#!/usr/bin/env bun
// scripts/release/compare-baseline.ts — release step R7.5, run ON THE TARGET HOST.
// Standing check SV.5.
//
//   bun scripts/release/compare-baseline.ts --instance <name> --run <run-ts> --max-size-ratio <r>
//
// Reads the R2.3 record (baseline.json, ./baseline.ts) of the same run, reads
// the same row counts and the database size again through the read-only
// session (./db-read.ts), and compares: every count only grows (nothing
// shrank, nothing vanished), and the size is at most --max-size-ratio times
// the baseline's (the ledger did not balloon). Writes compare-baseline.json
// beside the baseline. Exit 1 on any problem.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openReadOnly, readCounts, readDatabaseSize } from "./db-read.ts";
import { releaseStateDir } from "./release-state.ts";

export interface BaselineFigures {
  readonly counts: Readonly<Record<string, number | null>>;
  readonly databaseSizeBytes: number;
}

/** PURE. Every reason the after-state is not an append-only growth of the before-state. */
export function compareBaseline(before: BaselineFigures, after: BaselineFigures, maxSizeRatio: number): string[] {
  const out: string[] = [];
  for (const [table, was] of Object.entries(before.counts)) {
    const now = after.counts[table];
    if (was === null) continue;
    if (now === null || now === undefined) out.push(`${table}: ${was} rows before, table gone after`);
    else if (now < was) out.push(`${table}: shrank from ${was} to ${now}`);
  }
  if (!(maxSizeRatio > 0)) out.push(`max size ratio must be positive, got ${maxSizeRatio}`);
  else if (before.databaseSizeBytes > 0 && after.databaseSizeBytes > before.databaseSizeBytes * maxSizeRatio) {
    out.push(`database size ${after.databaseSizeBytes} bytes is over ${maxSizeRatio}x the baseline ${before.databaseSizeBytes}`);
  }
  return out;
}

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

async function main(): Promise<number> {
  const instance = flag("--instance");
  const run = flag("--run");
  const ratio = Number(flag("--max-size-ratio"));
  if (!instance || !run || !/^\d{8}T\d{6}Z$/.test(run) || !Number.isFinite(ratio)) {
    console.error("usage: bun scripts/release/compare-baseline.ts --instance <name> --run <run-ts> --max-size-ratio <r>");
    return 2;
  }
  const dir = releaseStateDir(instance, run);
  let before: BaselineFigures;
  try {
    before = JSON.parse(readFileSync(join(dir, "baseline.json"), "utf8")) as BaselineFigures;
  } catch (error) {
    console.error(`[compare-baseline] REFUSE: no R2.3 baseline for run ${run} in ${dir} (${error instanceof Error ? error.message : String(error)})`);
    return 1;
  }
  const db = await openReadOnly();
  let after: BaselineFigures;
  try {
    after = { counts: await readCounts(db), databaseSizeBytes: await readDatabaseSize(db) };
  } finally {
    await db.close();
  }
  const problems = compareBaseline(before, after, ratio);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, "compare-baseline.json");
  writeFileSync(file, `${JSON.stringify({ step: "R7.5", instance, run, maxSizeRatio: ratio, before, after, problems, at: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
  for (const [t, n] of Object.entries(after.counts)) console.log(`[compare-baseline] ${t}: ${before.counts[t]} → ${n}`);
  console.log(`[compare-baseline] size: ${before.databaseSizeBytes} → ${after.databaseSizeBytes} bytes (bound ${ratio}x)`);
  console.log(`[compare-baseline] receipt: ${file}`);
  for (const p of problems) console.error(`[compare-baseline] FAIL: ${p}`);
  return problems.length === 0 ? 0 : 1;
}

if (import.meta.main) process.exitCode = await main();
