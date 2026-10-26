#!/usr/bin/env bun
// scripts/release/baseline.ts — release step P07-baseline (with R2.4), run ON THE TARGET HOST.
// Standing checks SP.3 (the real ledger reconciles with backend/migrations and
// the bytes at the tag the running stack reports, ./ledger.ts, D67) and SP.6
// (the product baseline for the postflight comparison).
//
//   bun scripts/release/baseline.ts --instance <name> --run <run-ts> --origin <url>
//
// Read-only, through `rm_readonly` from `$HOME/.env` on a session proven
// read-only (./db-read.ts). It reads, and records:
//   - the migration ledger: count and every name (baseline-ledger.txt);
//   - whether deployment_identity exists (expected absent before 0081);
//   - rm_owner, rm_app, rm_worker, rm_readonly and doadmin: rolcanlogin, rolcreaterole;
//   - who migration 0101 would clear (D55 (2), issue 1120), with the query
//     copied verbatim from runbook P07-baseline (baseline-would-clear.txt);
//   - the ledger reconciliation (./ledger.ts): the pending set, every recorded
//     name backend/migrations lacks, and each applied file's bytes against the
//     version the running stack reports at --origin/api/version (the receipt);
//   - the R2.4 row counts and the database size;
//   - the sessions in flight, with their window close (V01-subject-spacing's parity input).
// It writes baseline.json beside them in `<instance state dir>/release/<run-ts>/`.
//
// It REFUSES (exit 1, after writing the record) when an in-house handle is in
// the would-clear list, when the reconciliation's verdict is anything but
// `ok`, when the running stack reports no version to pin to, or when a pending
// migration is not `compat: additive`: a release is a rolling upgrade (owner,
// 2026-10-14), so C05-migrate migrates while the previous release still serves, and
// only an additive change keeps that release correct. It never
// judges a count or a number order: the same step runs any patch from the
// ledger production actually holds (issues 1272, 1273).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openReadOnly, readCounts, readDatabaseSize } from "./db-read.ts";
import { ledgerProblems, MIGRATIONS_DIR, readRunningVersion, reconcileLedger, repoMigrations, runningPinRef, type ReconcileReceipt } from "./ledger.ts";
import { parsePendingHeader } from "../../backend/src/db/schema-compat.ts";
import { releaseStateDir } from "./release-state.ts";
import { loadReleaseRunbook } from "./runbook.ts";

/** The in-house seats migration 0101 must never clear (runbook P07-baseline). */
/** Sessions in flight at the baseline; V01-subject-spacing checks each one published on its normal close. */
export const IN_FLIGHT_SQL = `SELECT id::text AS id, subject_id::text AS subject, state, window_closes_at
  FROM swarm_sessions WHERE state NOT IN ('published', 'cancelled') ORDER BY window_closes_at NULLS LAST, id`;

export interface InFlightSession { readonly id: string; readonly subject: string; readonly state: string; readonly window_closes_at: string | Date | null }

export const IN_HOUSE_HANDLES: readonly string[] = Object.freeze(["athena", "noop-analyst", "robot-money", "themis"]);

/** Runbook P07-baseline's would-clear query, verbatim. Read-only; it mirrors migration 0101's rule. */
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

/** PURE. The refusals P07-baseline names, empty when the baseline may stand. `repo` defaults to backend/migrations. */
export function baselineProblems(reconcile: ReconcileReceipt, wouldClear: readonly Pick<WouldClearRow, "handle">[]): string[] {
  const out: string[] = [];
  const inHouse = wouldClear.filter((r) => IN_HOUSE_HANDLES.includes(r.handle)).map((r) => r.handle);
  if (inHouse.length > 0) out.push(`migration 0101 would clear in-house seats: ${inHouse.join(", ")} (a defect: stop)`);
  out.push(...ledgerProblems(reconcile));
  return out;
}

/**
 * PURE. Why the pending set cannot migrate under a running previous release;
 * empty when every pending file declares `compat: additive`. `read` returns a
 * file's text. A file with no declaration, or one that fails to parse, refuses.
 * A `compat: breaking` file passes only when the release runbook names it in
 * `breaking:` (spec §8.5: the release then migrates in the breaking order, not
 * under the running release); an undeclared breaking file still refuses.
 */
export function rollingMigrationProblems(pending: readonly string[], read: (name: string) => string, declaredBreaking: readonly string[] = []): string[] {
  const out: string[] = [];
  for (const name of pending) {
    let compat: string | null;
    try {
      compat = parsePendingHeader(name, read(name))?.compat ?? null;
    } catch (error) {
      out.push(`${name}: its compat header does not parse (${error instanceof Error ? error.message : String(error)})`);
      continue;
    }
    if (compat === "breaking" && declaredBreaking.includes(name)) continue;
    if (compat !== "additive") {
      out.push(`${name} is ${compat ?? "undeclared"}, not additive: a rolling release migrates while the previous release serves, so a breaking migration needs its own plan (the release runbook names it in breaking: to declare it, spec §8.5)`);
    }
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
  const origin = flag("--origin");
  if (!instance || !run || !/^\d{8}T\d{6}Z$/.test(run) || !origin) {
    console.error("usage: bun scripts/release/baseline.ts --instance <name> --run <run-ts> --origin <url>");
    return 2;
  }
  // The pin ref (D67): the tag the running stack reports, else its commit.
  const version = await readRunningVersion(origin);
  const pinRef = "error" in version ? null : runningPinRef(version);
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
    const inFlight = (await db.query<InFlightSession>(IN_FLIGHT_SQL)).map((r) => ({
      ...r, window_closes_at: r.window_closes_at === null ? null : new Date(r.window_closes_at).toISOString(),
    }));
    const sizeBytes = await readDatabaseSize(db);
    const repo = repoMigrations();
    const reconcile = reconcileLedger(ledger, pinRef === null ? {} : { pinRef });
    const pending = reconcile.pending;
    const problems = baselineProblems(reconcile, wouldClear);
    // The release the runner names (RM_RELEASE) declares its breaking migrations in its own runbook; no release, no declaration.
    const release = process.env.RM_RELEASE;
    let declaredBreaking: readonly string[] = [];
    if (release) {
      try { declaredBreaking = loadReleaseRunbook(release).breaking ?? []; } catch (error) { problems.push(`the runbook of ${release} could not be read for its breaking declaration: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`); }
    }
    problems.push(...rollingMigrationProblems(pending, (name) => readFileSync(join(MIGRATIONS_DIR, name), "utf8"), declaredBreaking));
    if (pinRef === null) problems.push(`the running stack at ${origin} reports no version to pin the applied migration bytes to (${(version as { error: string }).error})`);

    const dir = releaseStateDir(instance, run);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "baseline-ledger.txt"), `${ledger.join("\n")}\n`, { mode: 0o600 });
    writeFileSync(
      join(dir, "baseline-would-clear.txt"),
      wouldClear.map((r) => [r.id, r.handle, r.operator, r.self_write_audit_id, r.admin_write_audit_id].join("\t")).join("\n") + "\n",
      { mode: 0o600 },
    );
    const record = {
      step: "P07-baseline",
      instance,
      run,
      target: db.target,
      rmEnv: process.env.RM_ENV ?? null,
      readAt: new Date().toISOString(),
      ledger: { count: ledger.length, names: ledger },
      deploymentIdentity: { table: identityTable !== null, kind: identity },
      roles,
      wouldClear,
      repoMigrations: repo.length,
      pending: { count: pending.length, names: pending },
      breakingDeclared: declaredBreaking,
      running: pinRef === null ? null : { origin, pinRef },
      reconcile,
      counts,
      inFlight,
      databaseSizeBytes: sizeBytes,
      problems,
    };
    const file = join(dir, "baseline.json");
    writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    console.log(`[baseline] ${db.target}: ledger ${ledger.length} names, identity ${identityTable ? identity : "absent"}, repo ${repo.length} files, pending ${pending.length}, reconcile ${reconcile.verdict}${pinRef ? ` against ${pinRef}` : ""}`);
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
