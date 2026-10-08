#!/usr/bin/env bun
// scripts/release/restore-proof.ts — release step R2.4r, run ON THE CAPTURE HOST.
// Standing check SP.2: the backup is taken AND its restore is proven, with the
// restore time recorded (policy 4.3).
//
//   bun scripts/release/restore-proof.ts --dump <R2.1 capture dir> --receipt-dir <dir>
//
// Restores the run's fresh capture into a THROWAWAY local Postgres container
// through the repo's one restore path (scripts/lib/restore-container.ts,
// withSmokeTwinContainer: loopback bind, generated password, always torn down),
// counts the restored ledger, and records how long the restore took. It reads
// the encrypted files on disk and touches no database but its own container.
// The same step runs for every target.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withSmokeTwinContainer } from "../lib/restore-container.ts";

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

async function main(): Promise<number> {
  const dump = flag("--dump");
  const receiptDir = flag("--receipt-dir");
  if (!dump || !receiptDir) {
    console.error("usage: bun scripts/release/restore-proof.ts --dump <capture dir> --receipt-dir <dir>");
    return 2;
  }
  const log = (m: string) => console.log(`[restore-proof] ${m}`);
  const started = Date.now();
  let restoreMs = 0;
  const result = await withSmokeTwinContainer({ backupDir: dump, log }, async (restored, backup) => {
    restoreMs = Date.now() - started;
    const url = `postgres://${encodeURIComponent(restored.username)}:${encodeURIComponent(restored.password)}@${restored.host}:${restored.port}/${restored.database}`;
    const sql = new Bun.SQL(url, { max: 1 });
    try {
      const rows = (await sql.unsafe("SELECT count(*)::int AS n FROM schema_migrations")) as { n: number }[];
      return { stamp: backup.stamp, ledgerCount: Number(rows[0]?.n ?? 0) };
    } finally {
      await sql.close();
    }
  });
  const ok = !("error" in result);
  const record = {
    step: "R2.4r",
    dump,
    ...(ok ? { stamp: result.stamp, ledgerCount: result.ledgerCount, restoreSeconds: Math.round(restoreMs / 1000) } : { error: result.error }),
    totalSeconds: Math.round((Date.now() - started) / 1000),
    containerDropped: true,
    at: new Date().toISOString(),
  };
  mkdirSync(receiptDir, { recursive: true, mode: 0o700 });
  const file = join(receiptDir, "restore-proof.json");
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  if (ok) log(`restored ${result.stamp} in ${Math.round(restoreMs / 1000)} s; ledger ${result.ledgerCount} names; container dropped`);
  else console.error(`[restore-proof] FAIL: ${result.error}`);
  log(`receipt: ${file}`);
  return ok && result.ledgerCount > 0 ? 0 : 1;
}

if (import.meta.main) process.exitCode = await main();
