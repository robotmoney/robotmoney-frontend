// Postflight for the v0.5.0 -> v0.5.1 rollout. All database checks are
// SELECT-only.
//
// v0.5.1's application delta changes no schema; its single migration (0062) is
// a gate repair. So this postflight asks three questions:
//   (a) did 0062 land, and did it WORK -- `readonly-sequence-access` is the
//       difference between "recorded" and "the backup can now run";
//   (b) did the deploy leave the v0.5.0 schema otherwise exactly as it was;
//   (c) do the v0.5.0 data invariants still hold after the new code has run?
//
// (c) is the load-bearing half for the release's own features. The v0.5.1
// delta is swarm session lifecycle, API pool timeouts and the judge-job wait
// -- code that writes swarm rows on every cycle. A release that barely touches
// the schema can still corrupt what is in it, and schema checks alone would
// report green through that.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertContractInstallFresh } from "../../../../scripts/lib/contract-freshness.ts";
import { tableExists } from "../../lib/checks.ts";
import type { Checker } from "../../lib/checks.ts";
import { runPostflightMain, type Db } from "../../lib/postflight-utils.ts";
import { deriveHostRole } from "../../lib/rollout-receipt.ts";
import {
  PRESERVED_RELEASE_TABLES,
  PRIOR_RELEASE_MIGRATIONS,
  RELEASE_MIGRATIONS,
  REQUIRED_TABLES,
  TAG_GLOB,
} from "./release.ts";

const dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(dir, "..", "..", "..", "..");
const receiptStep = process.argv.find((arg) => arg.startsWith("--emit-receipt="))?.split("=", 2)[1]
  ?? (process.argv.includes("--emit-receipt") ? "P8.postflight-prod" : undefined);

export async function runChecks(db: Db, { record }: Checker): Promise<void> {
  const rows = (await db`SELECT name FROM schema_migrations`) as unknown as { name: string }[];
  const applied = new Set(rows.map((row) => row.name));

  const missing = PRIOR_RELEASE_MIGRATIONS.filter((name) => !applied.has(name));
  record(
    "schema-preserved",
    missing.length ? "FAIL" : "PASS",
    missing.length ? `missing: ${missing.join(", ")}` : `all ${PRIOR_RELEASE_MIGRATIONS.length} v0.4.0+v0.5.0 migrations remain recorded`,
  );

  // This release's own migration must be recorded, and nothing this checkout
  // does not carry may be. Stated as "no migration outside the known set"
  // rather than as a count delta: on a smoke-twin restored from a dump that
  // had not yet reached v0.5.0, the boot legitimately applies the outstanding
  // v0.5.0 migrations too, so the ledger DOES grow during a rehearsal.
  const known = new Set<string>([...PRIOR_RELEASE_MIGRATIONS, ...RELEASE_MIGRATIONS]);
  const unexpected = [...applied].filter((name) => !known.has(name) && /^00(4[5-9]|5\d|6\d)/.test(name));
  const missingRelease = RELEASE_MIGRATIONS.filter((name) => !applied.has(name));
  record(
    "release-migrations",
    missingRelease.length === 0 && unexpected.length === 0 ? "PASS" : "FAIL",
    [
      ...(missingRelease.length ? [`this release's migration(s) are NOT recorded: ${missingRelease.join(", ")}`] : [`all ${RELEASE_MIGRATIONS.length} v0.5.1 migration(s) recorded`]),
      ...(unexpected.length ? [`migration(s) recorded that this checkout does not ship: ${unexpected.join(", ")}`] : []),
    ],
    "A migration the checkout does not carry means the target was migrated by a build from another branch — releases-0.6.x collides with this line at 0056-0061.",
  );

  // THE SELF-HEAL PROOF, and the reason 0062 exists. pg_dump reads every
  // sequence's last_value as rm_readonly, so a single unreadable sequence
  // breaks P3.backup — the FIRST gate of the next release. Asserting the count
  // is zero is what turns "0062 is recorded" into "0062 worked".
  const unreadableSeqs = (await db`
    WITH s AS MATERIALIZED (
      SELECT c.oid, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'S'
    )
    SELECT relname FROM s WHERE NOT has_sequence_privilege('rm_readonly', oid, 'SELECT') ORDER BY relname
  `) as unknown as { relname: string }[];
  record(
    "readonly-sequence-access",
    unreadableSeqs.length === 0 ? "PASS" : "FAIL",
    unreadableSeqs.length === 0
      ? "rm_readonly can read every sequence in public — the next release's pg_dump will not be refused"
      : `${unreadableSeqs.length} sequence(s) still deny rm_readonly a read after 0062: ${unreadableSeqs.slice(0, 15).map((r) => r.relname).join(", ")}`,
    "0062 grants SELECT on all sequences and restores the default. If any remain unreadable, a later migration re-revoked them — see backend/tests/migration-readonly-sequence-grant.test.ts.",
  );

  const absentRequired: string[] = [];
  for (const table of REQUIRED_TABLES) if (!(await tableExists(db, table))) absentRequired.push(table);
  record(
    "runtime-schema",
    absentRequired.length ? "FAIL" : "PASS",
    absentRequired.length ? `absent: ${absentRequired.join(", ")}` : "v0.4.0 runtime tables are present",
  );

  const absentPreserved: string[] = [];
  for (const table of PRESERVED_RELEASE_TABLES) if (!(await tableExists(db, table))) absentPreserved.push(table);
  record(
    "v0.5-tables-preserved",
    absentPreserved.length ? "FAIL" : "PASS",
    absentPreserved.length ? `absent: ${absentPreserved.join(", ")}` : `all ${PRESERVED_RELEASE_TABLES.length} v0.5.0 tables are present`,
  );

  // ── the v0.5.0 data invariants, re-asserted after v0.5.1's code has run ──

  const [{ count: priceRows }] = (await db`SELECT count(*)::int AS count FROM asset_prices`) as unknown as { count: number }[];
  record("asset-prices-seeded", priceRows > 0 ? "PASS" : "FAIL", `${priceRows} row(s) in asset_prices`, "0046's seed carried existing live/seed price history forward; an empty table means it matched nothing.");

  const [{ count: driftedNames }] = (await db`
    SELECT count(*)::int AS count FROM swarm_sessions s JOIN swarm_subjects sub ON s.subject_id = sub.id
     WHERE s.subject_name IS DISTINCT FROM sub.name
  `) as unknown as { count: number }[];
  record("subject-name-backfill", driftedNames === 0 ? "PASS" : "FAIL", driftedNames === 0 ? "every session's subject_name matches its subject's current name" : `${driftedNames} session(s) still show a stale subject_name`);

  const [judgeConfig] = (await db`SELECT third_party_enabled FROM swarm_judge_config WHERE id = 1`) as unknown as { third_party_enabled: boolean }[];
  record("third-party-judging-off", judgeConfig?.third_party_enabled === false ? "PASS" : "FAIL", judgeConfig ? `third_party_enabled = ${judgeConfig.third_party_enabled}` : "no swarm_judge_config row with id=1", "0048 ships this off by default; v0.5.1 does not flip it.");

  // The analytics read switch must still be on the side the operator left it.
  // v0.5.1 ships no cutover, so a mode other than the seeded `compatibility`
  // can only have come from a deliberate 0060 gate run -- recorded, never
  // failed, because flipping it IS a supported operator action.
  const [readMode] = (await db`SELECT mode FROM analytics_read_mode WHERE id = 1`) as unknown as { mode: string }[];
  record(
    "analytics-read-mode",
    readMode ? "PASS" : "FAIL",
    readMode ? `analytics_read_mode = ${readMode.mode} (v0.5.1 does not change it)` : "no analytics_read_mode row with id=1",
    "0060 seeds this row at `compatibility`; its absence means 0060 did not land.",
  );

  // ── v0.5.1's own delta: the swarm session lifecycle fixes ──
  //
  // The release exists to stop sessions wedging. A session stuck in a
  // non-terminal state past any plausible run is the exact symptom f2c21a56
  // and ebbfc0bb address, so postflight names it rather than trusting a green
  // boot. Scoped to the last 24h: older wedges are pre-existing history this
  // release does not claim to repair.
  const [{ count: wedged }] = (await db`
    SELECT count(*)::int AS count FROM swarm_sessions
     WHERE state NOT IN ('published', 'cancelled')
       AND window_closes_at IS NOT NULL
       AND window_closes_at < now() - interval '2 hours'
       AND convened_at > now() - interval '24 hours'
  `) as unknown as { count: number }[];
  record(
    "no-wedged-sessions",
    wedged === 0 ? "PASS" : "FAIL",
    wedged === 0
      ? "every session convened in the last 24h whose window has closed reached a terminal state"
      : `${wedged} session(s) convened in the last 24h closed their window 2h+ ago and are still non-terminal (state not in published/cancelled)`,
    "The session lifecycle fixes are what v0.5.1 ships; a fresh wedge means they did not take.",
  );

  try {
    await assertContractInstallFresh(repoRoot);
    record("contract-freshness", "PASS", "installed @robotmoney/contract matches this checkout");
  } catch (error) {
    record("contract-freshness", "FAIL", error instanceof Error ? error.message : String(error), "Run bun install --force at the repository root and rerun postflight.");
  }
}

// Guarded (import.meta.url) because stage-rehearsal.ts imports runChecks from
// this module to fold the schema checks into the rehearsal's single graded
// verdict. An unguarded body would run a SECOND postflight on import — and,
// with --emit-receipt, write a second P5.rehearsal receipt recording only the
// schema half, before the functional criteria had run at all.
if (import.meta.url === `file://${process.argv[1]}`) {
  const code = await runPostflightMain({
    name: "postflight-0.5.1",
    runChecks,
    receipt: receiptStep ? { step: receiptStep, repoRoot, tagGlob: TAG_GLOB, hostRole: deriveHostRole(repoRoot).role } : undefined,
  });
  process.exitCode = code;
}
