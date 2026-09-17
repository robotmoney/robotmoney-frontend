#!/usr/bin/env bun
// Issue #979 AC2/AC4: the cutover gate CLI. Run with no arguments to check
// whether ledger-mode reads are permitted (exit 0) or refused (nonzero, with
// every reason printed). Run with `--switch ledger` or `--switch
// compatibility` to also flip analytics_read_mode — the ledger switch is
// itself refused (nonzero exit, CutoverGateNotPassedError) unless the gate
// passes; the compatibility switch (rollback) is always allowed and touches
// no ledger table.
import { evaluateCutoverGate, defaultCutoverGateConfig } from "../src/analytics/cutover/gate.ts";
import { getAnalyticsReadMode, setAnalyticsReadMode, CutoverGateNotPassedError } from "../src/analytics/cutover/read-mode.ts";
import { closeDb } from "../src/db/client.ts";

function parseArgs(argv: string[]): { switchTo: "ledger" | "compatibility" | null } {
  const idx = argv.indexOf("--switch");
  if (idx === -1) return { switchTo: null };
  const value = argv[idx + 1];
  if (value !== "ledger" && value !== "compatibility") {
    throw new Error(`--switch requires "ledger" or "compatibility", got ${JSON.stringify(value)}`);
  }
  return { switchTo: value };
}

export async function runCutoverGateCli(argv: string[]): Promise<number> {
  const { switchTo } = parseArgs(argv);
  const result = await evaluateCutoverGate(undefined, defaultCutoverGateConfig());
  console.log(`[cutover-gate] current mode: ${await getAnalyticsReadMode()}`);
  console.log(`[cutover-gate] gate ${result.ok ? "PASSES" : "FAILS"}`);
  for (const reason of result.reasons) console.log(`[cutover-gate]   - ${reason}`);
  for (const [domain, d] of Object.entries(result.perDomain)) {
    console.log(`[cutover-gate] ${domain}: count=${d.count} earliest=${d.earliest ?? "-"} latest=${d.latest ?? "-"} allMatched=${d.allMatched}`);
  }

  if (switchTo === "compatibility") {
    await setAnalyticsReadMode("compatibility", "cutover-gate-cli");
    console.log(`[cutover-gate] switched to compatibility mode (non-destructive rollback)`);
    return 0;
  }
  if (switchTo === "ledger") {
    if (!result.ok) {
      console.error(`[cutover-gate] REFUSING to switch to ledger mode: the gate has not passed.`);
      return 1;
    }
    await setAnalyticsReadMode("ledger", "cutover-gate-cli");
    console.log(`[cutover-gate] switched to ledger mode`);
    return 0;
  }
  return result.ok ? 0 : 1;
}

if (import.meta.main) {
  runCutoverGateCli(process.argv.slice(2))
    .then(async (code) => {
      await closeDb();
      process.exit(code);
    })
    .catch(async (err) => {
      console.error(err instanceof CutoverGateNotPassedError ? err.message : err);
      await closeDb();
      process.exit(1);
    });
}
