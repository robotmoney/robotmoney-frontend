// Postflight for the v0.4.0 -> v0.4.1 rollout. All database checks are
// SELECT-only; migration 0045-0048 already ran (at boot, via migrate.ts)
// by the time this runs.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertContractInstallFresh } from "../../../../scripts/lib/contract-freshness.ts";
import { tableExists } from "../../lib/checks.ts";
import type { Checker } from "../../lib/checks.ts";
import { runPostflightMain, type Db } from "../../lib/postflight-utils.ts";
import { deriveHostRole } from "../../lib/rollout-receipt.ts";
import { NEW_RELEASE_TABLES, PRIOR_RELEASE_MIGRATIONS, RELEASE_MIGRATIONS, TAG_GLOB } from "./release.ts";

const dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(dir, "..", "..", "..", "..");
const receiptStep = process.argv.find((arg) => arg.startsWith("--emit-receipt="))?.split("=", 2)[1]
  ?? (process.argv.includes("--emit-receipt") ? "P8.postflight-prod" : undefined);

export async function runChecks(db: Db, { record }: Checker): Promise<void> {
  const rows = (await db`SELECT name FROM schema_migrations`) as unknown as { name: string }[];
  const applied = new Set(rows.map((row) => row.name));
  const missing = PRIOR_RELEASE_MIGRATIONS.filter((name) => !applied.has(name));
  record("schema-preserved", missing.length ? "FAIL" : "PASS", missing.length ? `missing: ${missing.join(", ")}` : "all v0.4.0 migrations remain recorded");

  const absentTables: string[] = [];
  for (const table of ["swarm_judge_config", "swarm_session_judgements", "swarm_consensus_receipts"]) {
    if (!(await tableExists(db, table))) absentTables.push(table);
  }
  record("runtime-schema", absentTables.length ? "FAIL" : "PASS", absentTables.length ? `absent: ${absentTables.join(", ")}` : "v0.4.0 runtime tables are present");

  const missingRelease = RELEASE_MIGRATIONS.filter((name) => !applied.has(name));
  record("migrations", missingRelease.length ? "FAIL" : "PASS", missingRelease.length ? `missing: ${missingRelease.join(", ")}` : "all four v0.4.1 migrations recorded");

  const absentNewTables: string[] = [];
  for (const table of NEW_RELEASE_TABLES) if (!(await tableExists(db, table))) absentNewTables.push(table);
  record("new-tables", absentNewTables.length ? "FAIL" : "PASS", absentNewTables.length ? `absent: ${absentNewTables.join(", ")}` : "chain_address_floors, asset_prices, and asset_price_floors are present");

  const [{ count: priceRows }] = (await db`SELECT count(*)::int AS count FROM asset_prices`) as unknown as { count: number }[];
  record("asset-prices-seeded", priceRows > 0 ? "PASS" : "FAIL", `${priceRows} row(s) in asset_prices`, "0046's seed should have carried forward existing live/seed price history; an empty table means the seed query matched nothing.");

  const [{ count: driftedNames }] = (await db`
    SELECT count(*)::int AS count FROM swarm_sessions s JOIN swarm_subjects sub ON s.subject_id = sub.id
     WHERE s.subject_name IS DISTINCT FROM sub.name
  `) as unknown as { count: number }[];
  record("subject-name-backfill", driftedNames === 0 ? "PASS" : "FAIL", driftedNames === 0 ? "every session's subject_name matches its subject's current name" : `${driftedNames} session(s) still show a stale subject_name`);

  const [judgeConfig] = (await db`SELECT third_party_enabled FROM swarm_judge_config WHERE id = 1`) as unknown as { third_party_enabled: boolean }[];
  record("third-party-judging-off", judgeConfig?.third_party_enabled === false ? "PASS" : "FAIL", judgeConfig ? `third_party_enabled = ${judgeConfig.third_party_enabled}` : "no swarm_judge_config row with id=1", "0048 ships this off by default; do not flip it during cutover.");

  try {
    await assertContractInstallFresh(repoRoot);
    record("contract-freshness", "PASS", "installed @robotmoney/contract matches this checkout");
  } catch (error) {
    record("contract-freshness", "FAIL", error instanceof Error ? error.message : String(error), "Run bun install --force at the repository root and rerun postflight.");
  }
}

const code = await runPostflightMain({
  name: "postflight-0.4.1",
  runChecks,
  receipt: receiptStep ? { step: receiptStep, repoRoot, tagGlob: TAG_GLOB, hostRole: deriveHostRole(repoRoot).role } : undefined,
});
process.exitCode = code;
