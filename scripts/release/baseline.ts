#!/usr/bin/env bun
// scripts/release/baseline.ts — release step R2.3 (with R2.4), run ON THE TARGET HOST.
// Standing checks SP.3 (the real ledger equals a shipped baseline) and SP.6
// (the product baseline for the postflight comparison).
//
//   bun scripts/release/baseline.ts --instance <name> --run <run-ts>
//
// Read-only, through `rm_readonly` from `$HOME/.env` on a session proven
// read-only (./db-read.ts). It reads, and records:
//   - the migration ledger: count and every name (baseline-ledger.txt);
//   - whether deployment_identity exists (expected absent before 0081);
//   - rm_owner, rm_app, rm_worker, rm_readonly and doadmin: rolcanlogin, rolcreaterole;
//   - who migration 0101 would clear (D55 (2), issue 1120), with the query
//     copied verbatim from runbook R2.3 (baseline-would-clear.txt);
//   - matchSupportedRelease's answer (backend/src/db/supported-releases.ts);
//   - the R2.4 row counts and the database size.
// It writes baseline.json beside them in `<instance state dir>/release/<run-ts>/`.
//
// It REFUSES (exit 1, after writing the record) when an in-house handle is in
// the would-clear list, or when the ledger matches no supported baseline.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describeUnmatchedLedger, matchSupportedRelease } from "../../backend/src/db/supported-releases.ts";
import { openReadOnly, readCounts, readDatabaseSize } from "./db-read.ts";
import { releaseStateDir } from "./release-state.ts";

/** The in-house seats migration 0101 must never clear (runbook R2.3). */
export const IN_HOUSE_HANDLES: readonly string[] = Object.freeze(["athena", "noop-analyst", "robot-money", "themis"]);

/** Runbook R2.3's would-clear query, verbatim. Read-only; it mirrors migration 0101's rule. */
export const WOULD_CLEAR_SQL = `WITH self_writes AS (
  SELECT scope->>'memberId' AS member_id, max(id) AS last_id FROM audit_log
   WHERE action = 'update_profile' AND scope ? 'memberId'
     AND (NOT (scope ? 'fields') OR (scope->'fields') ? 'operator')
   GROUP BY 1),
admin_writes AS (
  SELECT scope->>'memberId' AS member_id, max(id) AS last_id FROM audit_log
   WHERE action = 'member_update' AND scope ? 'memberId'
     AND jsonb_typeof(scope->'fields') = 'array' AND (scope->'fields') ? 'operator'
   GROUP BY 1)
SELECT m.id, m.handle, m.operator, s.last_id AS self_write_audit_id, w.last_id AS admin_write_audit_id
  FROM swarm_members m
  JOIN self_writes s ON s.member_id = m.id
  LEFT JOIN admin_writes w ON w.member_id = m.id
 WHERE lower(trim(m.operator)) = 'robotmoney'
   AND (w.last_id IS NULL OR w.last_id < s.last_id)
   AND m.handle <> ALL (ARRAY['athena','noop-analyst','robot-money','themis'])
 ORDER BY m.id;`;

export interface WouldClearRow {
  readonly id: string;
  readonly handle: string;
  readonly operator: string | null;
  readonly self_write_audit_id: string | number | null;
  readonly admin_write_audit_id: string | number | null;
}

/** PURE. The refusals R2.3 names, empty when the baseline may stand. */
export function baselineProblems(ledger: readonly string[], wouldClear: readonly Pick<WouldClearRow, "handle">[]): string[] {
  const out: string[] = [];
  const inHouse = wouldClear.filter((r) => IN_HOUSE_HANDLES.includes(r.handle)).map((r) => r.handle);
  if (inHouse.length > 0) out.push(`migration 0101 would clear in-house seats: ${inHouse.join(", ")} (a defect: stop)`);
  if (matchSupportedRelease(ledger) === null) out.push(`the ledger matches no supported baseline: ${describeUnmatchedLedger(ledger)}`);
  return out;
}

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

async function main(): Promise<number> {
  const instance = flag("--instance");
  const run = flag("--run");
  if (!instance || !run || !/^\d{8}T\d{6}Z$/.test(run)) {
    console.error("usage: bun scripts/release/baseline.ts --instance <name> --run <run-ts>");
    return 2;
  }
  const db = await openReadOnly();
  try {
    const ledger = (await db.query<{ name: string }>(`SELECT name FROM schema_migrations ORDER BY name COLLATE "C"`)).map((r) => r.name);
    const identityTable = (await db.query<{ t: string | null }>("SELECT to_regclass('public.deployment_identity')::text AS t"))[0]?.t ?? null;
    const identity = identityTable ? (await db.query<{ kind: string }>("SELECT kind FROM deployment_identity"))[0]?.kind ?? null : null;
    const roles = await db.query<{ rolname: string; rolcanlogin: boolean; rolcreaterole: boolean }>(
      "SELECT rolname, rolcanlogin, rolcreaterole FROM pg_roles WHERE rolname IN ('rm_owner','rm_app','rm_worker','rm_readonly','doadmin') ORDER BY rolname",
    );
    const wouldClear = await db.query<WouldClearRow>(WOULD_CLEAR_SQL);
    const counts = await readCounts(db);
    const sizeBytes = await readDatabaseSize(db);
    const matched = matchSupportedRelease(ledger);
    const problems = baselineProblems(ledger, wouldClear);

    const dir = releaseStateDir(instance, run);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "baseline-ledger.txt"), `${ledger.join("\n")}\n`, { mode: 0o600 });
    writeFileSync(
      join(dir, "baseline-would-clear.txt"),
      wouldClear.map((r) => [r.id, r.handle, r.operator, r.self_write_audit_id, r.admin_write_audit_id].join("\t")).join("\n") + "\n",
      { mode: 0o600 },
    );
    const record = {
      step: "R2.3",
      instance,
      run,
      target: db.target,
      rmEnv: process.env.RM_ENV ?? null,
      readAt: new Date().toISOString(),
      ledger: { count: ledger.length, names: ledger },
      deploymentIdentity: { table: identityTable !== null, kind: identity },
      roles,
      wouldClear,
      supportedBaseline: matched ? matched.name : null,
      unmatched: matched ? null : describeUnmatchedLedger(ledger),
      counts,
      databaseSizeBytes: sizeBytes,
      problems,
    };
    const file = join(dir, "baseline.json");
    writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    console.log(`[baseline] ${db.target}: ledger ${ledger.length} names, identity ${identityTable ? identity : "absent"}, baseline ${matched?.name ?? "NONE"}`);
    console.log(`[baseline] roles: ${roles.map((r) => `${r.rolname} login=${r.rolcanlogin}`).join(", ")}`);
    console.log(`[baseline] would-clear: ${wouldClear.length} row(s)${wouldClear.length ? `: ${wouldClear.map((r) => r.handle).join(", ")}` : ""}`);
    console.log(`[baseline] counts: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(", ")}; size ${sizeBytes} bytes`);
    console.log(`[baseline] receipt: ${file}`);
    for (const p of problems) console.error(`[baseline] REFUSE: ${p}`);
    return problems.length === 0 ? 0 : 1;
  } finally {
    await db.close();
  }
}

if (import.meta.main) process.exitCode = await main();
