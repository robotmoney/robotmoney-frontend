// Issue #979 AC6: the production startup guard for the Phase A analytics
// ledger's IMMUTABILITY triggers — a distinct check from
// append-only-guard.ts's, because the ledger tables (migrations 0057-0060)
// are protected by FOUR dedicated trigger functions, none of which is
// rm_append_only_guard(), and each of which blocks UPDATE as well as
// DELETE/TRUNCATE (the generic guard blocks only the latter two). A
// deployment could pass the generic append-only check while every one of
// these ledgers is silently rewritable, so this is a second, independent
// probe with its own catalog inventory and its own removal/rewrite attempts —
// same shape as checkAppendOnlyGuard, deliberately not merged into it: a
// reader who sees "armed" from THIS module knows specifically that the
// evidence ledger (not merely the older swarm/audit history) is protected.
import type postgresTypes from "postgres";
import { sql } from "./client.ts";
import { createNamespaceGuardClient } from "./guard-client.ts";

export type AnalyticsLedgerDb = postgresTypes.Sql<{}> | postgresTypes.TransactionSql<{}>;

export interface LedgerFamily {
  /** Operator-facing name of the layer, used in every message this family's
   *  trigger function raises: "<label> is immutable: UPDATE is not permitted
   *  on <table>". */
  label: string;
  functionName: string;
  migration: string;
  tables: readonly string[];
  /** One column per table that is harmless to write back to itself — used to
   *  build a `WHERE false` UPDATE probe that cannot touch a real row. */
  noopColumn: Record<string, string>;
}

export const LEDGER_FAMILIES: readonly LedgerFamily[] = [
  {
    label: "source ledger",
    functionName: "rm_source_ledger_immutable",
    migration: "0057_source_acquisition_ledger.sql",
    tables: ["source_acquisitions", "source_acquisition_events", "source_payloads", "source_fetches", "source_value_versions"],
    noopColumn: {
      source_acquisitions: "cache_identity",
      source_acquisition_events: "detail",
      source_payloads: "knowledge_time",
      source_fetches: "error_detail",
      source_value_versions: "revision_kind",
    },
  },
  {
    label: "analytics run ledger",
    functionName: "rm_analytics_run_ledger_immutable",
    migration: "0058_analytics_run_ledger.sql",
    tables: [
      "analytics_ledger_methodology_versions",
      "analytics_ledger_runs",
      "analytics_ledger_run_events",
      "analytics_data_vintages",
      "analytics_vintage_members",
    ],
    noopColumn: {
      analytics_ledger_methodology_versions: "version_label",
      analytics_ledger_runs: "build_identity",
      analytics_ledger_run_events: "detail",
      analytics_data_vintages: "build_identity",
      analytics_vintage_members: "source_key",
    },
  },
  {
    label: "analytics output ledger",
    functionName: "rm_analytics_output_ledger_immutable",
    migration: "0059_analytics_output_and_report_snapshots.sql",
    tables: ["analytics_output_snapshots", "analytics_report_snapshots", "swarm_brief_revisions"],
    noopColumn: {
      analytics_output_snapshots: "artifact_kind",
      analytics_report_snapshots: "asof",
      swarm_brief_revisions: "revision",
    },
  },
  {
    label: "analytics cutover ledger",
    functionName: "rm_analytics_cutover_immutable",
    migration: "0060_analytics_ledger_cutover.sql",
    tables: ["analytics_parity_observations"],
    noopColumn: { analytics_parity_observations: "domain" },
  },
];

export function ledgerTriggerNames(table: string): { statement: string; row: string } {
  return { statement: `${table}_immutable`, row: `${table}_immutable_row` };
}

export type LedgerGuardStatus = "armed" | "disarmed" | "not_applied" | "unavailable";

export interface LedgerGuardCheck {
  status: LedgerGuardStatus;
  problems: string[];
  detail?: string;
}

interface TriggerRow {
  table_name: string;
  trigger_name: string;
  enabled: string;
  function_name: string;
  is_row: boolean;
}

async function existingTables(db: AnalyticsLedgerDb, tables: readonly string[]): Promise<string[]> {
  if (tables.length === 0) return [];
  const rows = (await db`
    SELECT t AS table_name FROM unnest(${[...tables] as string[]}::text[]) AS t
    WHERE to_regclass('public.' || t) IS NOT NULL
  `) as unknown as { table_name: string }[];
  return rows.map((r) => r.table_name);
}

async function migrationApplied(db: AnalyticsLedgerDb, migration: string): Promise<boolean> {
  const [{ present }] = (await db`
    SELECT (
      to_regclass('public.schema_migrations') IS NOT NULL
      AND EXISTS (SELECT 1 FROM schema_migrations WHERE name = ${migration})
    ) AS present
  `) as unknown as { present: boolean }[];
  return present;
}

async function triggerInventory(db: AnalyticsLedgerDb, family: LedgerFamily, tables: string[]): Promise<string[]> {
  if (tables.length === 0) return [];
  const rows = (await db`
    SELECT c.relname::text AS table_name, t.tgname::text AS trigger_name, t.tgenabled::text AS enabled,
           p.proname::text AS function_name, (t.tgtype & 1) = 1 AS is_row
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_proc p ON p.oid = t.tgfoid
    WHERE NOT t.tgisinternal AND c.relname = ANY(${tables}::text[])
  `) as unknown as TriggerRow[];
  const byName = new Map(rows.map((r) => [`${r.table_name}.${r.trigger_name}`, r]));
  const problems: string[] = [];
  for (const table of tables) {
    const names = ledgerTriggerNames(table);
    for (const [level, name] of [["statement", names.statement], ["row", names.row]] as const) {
      const row = byName.get(`${table}.${name}`);
      if (!row) {
        problems.push(`${table}: the ${level}-level ${family.label} trigger '${name}' is MISSING — re-apply backend/migrations/${family.migration}.`);
        continue;
      }
      if (row.function_name !== family.functionName) {
        problems.push(`${table}: trigger '${name}' calls '${row.function_name}()', not ${family.functionName}().`);
      }
      if ((level === "row") !== row.is_row) {
        problems.push(`${table}: trigger '${name}' is ${row.is_row ? "ROW" : "STATEMENT"} level, expected ${level.toUpperCase()}.`);
      }
      if (row.enabled !== "A") {
        problems.push(`${table}: trigger '${name}' is tgenabled='${row.enabled}', not 'A' (ALWAYS).`);
      }
    }
  }
  return problems;
}

const INCONCLUSIVE_CODES = new Set(["57014", "55P03", "57P01", "57P02", "57P03", "53300", "42501"]);
function isInconclusive(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  if (typeof code !== "string" || !/^[0-9A-Z]{5}$/.test(code)) return true;
  return INCONCLUSIVE_CODES.has(code) || code.startsWith("08");
}

function isFamilyRefusal(err: unknown, family: LedgerFamily, table: string, op: "UPDATE" | "DELETE" | "TRUNCATE"): boolean {
  const e = err as { message?: string; code?: string } | null;
  if (e?.code !== "0A000") return false;
  return new RegExp(`^${family.label} is immutable: ${op} is not permitted on ${table}`).test(String(e?.message ?? ""));
}

class LedgerGuardInconclusive extends Error {}

async function probeFamily(db: AnalyticsLedgerDb, family: LedgerFamily, tables: string[]): Promise<string[]> {
  const problems: string[] = [];
  for (const table of tables) {
    const noopColumn = family.noopColumn[table];
    const statements: { op: "UPDATE" | "DELETE" | "TRUNCATE"; sql: string }[] = [
      ...(noopColumn ? [{ op: "UPDATE" as const, sql: `UPDATE public.${table} SET ${noopColumn} = ${noopColumn} WHERE false` }] : []),
      { op: "DELETE", sql: `DELETE FROM public.${table} WHERE false` },
    ];
    for (const { op, sql: statement } of statements) {
      let raised: unknown = null;
      try {
        await db.unsafe(statement);
      } catch (e) {
        raised = e;
      }
      if (raised === null) {
        problems.push(`${table}: a ${op} was ACCEPTED — the ${family.label}'s immutability guard is not refusing ${op} on this table.`);
        continue;
      }
      if (isFamilyRefusal(raised, family, table, op)) continue;
      if (isInconclusive(raised)) {
        const e = raised as { message?: string; code?: string };
        throw new LedgerGuardInconclusive(`probing ${table} (${op}): ${e?.code ?? "no SQLSTATE"}: ${String(e?.message ?? raised).split("\n")[0]}`);
      }
      const e = raised as { message?: string; code?: string };
      problems.push(`${table}: a ${op} was refused, but NOT by the ${family.label} — got ${e?.code ?? "?"}: ${String(e?.message ?? raised).split("\n")[0]}`);
    }
  }
  return problems;
}

async function checkFamily(db: AnalyticsLedgerDb, family: LedgerFamily): Promise<{ status: LedgerGuardStatus; problems: string[] }> {
  const applied = await migrationApplied(db, family.migration);
  const tables = await existingTables(db, family.tables);
  if (!applied) return { status: "not_applied", problems: [] };
  if (tables.length === 0) {
    return {
      status: "disarmed",
      problems: [`${family.migration} is recorded in schema_migrations but none of its ${family.tables.length} tables exist.`],
    };
  }
  const problems = [...(await triggerInventory(db, family, tables)), ...(await probeFamily(db, family, tables))];
  return { status: problems.length > 0 ? "disarmed" : "armed", problems };
}

/** Every family's status, combined: "disarmed" if ANY family is disarmed,
 *  "armed" only if every applied family is armed, "not_applied" if no family
 *  has been migrated yet (an ordinary pre-#976 first boot). */
export async function checkAnalyticsLedgerGuard(db: AnalyticsLedgerDb = sql): Promise<LedgerGuardCheck> {
  try {
    const results = await Promise.all(LEDGER_FAMILIES.map((f) => checkFamily(db, f)));
    const problems = results.flatMap((r) => r.problems);
    if (problems.length > 0) return { status: "disarmed", problems };
    if (results.every((r) => r.status === "not_applied")) return { status: "not_applied", problems: [] };
    return { status: "armed", problems: [] };
  } catch (err) {
    return { status: "unavailable", problems: [], detail: err instanceof Error ? err.message : String(err) };
  }
}

export const ANALYTICS_LEDGER_GUARD_BUDGET_MS = 2_000;

function expireAfter(ms: number): { expiry: Promise<never>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout>;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${ms}ms`)), ms);
  });
  return { expiry, cancel: () => clearTimeout(timer!) };
}

export function analyticsLedgerGuardRefusalLines(problems: readonly string[], prefix: string): string[] {
  return [
    `${prefix} REFUSING the boot: the analytics ledger immutability guard (issue #979) is NOT armed on this database.`,
    `${prefix} At least one Phase A ledger family's UPDATE/DELETE/TRUNCATE protection is missing or disabled:`,
    ...problems.map((p) => `${prefix}   ${p}`),
    `${prefix} Re-apply the migration that installs the missing trigger(s) and re-boot.`,
  ];
}

export const ANALYTICS_LEDGER_GUARD_OVERRIDE_ENV = "RM_ALLOW_UNARMED_ANALYTICS_LEDGER_GUARD";

let guardOutcome: LedgerGuardStatus | "unchecked" = "unchecked";
export function analyticsLedgerGuardOutcome(): LedgerGuardStatus | "unchecked" {
  return guardOutcome;
}

/** The api's boot check, same shape and same three callers as
 *  assertAppendOnlyGuardArmed (backend/src/db/append-only-guard.ts): called
 *  right after it from api/index.ts, prod-bootstrap.ts, and db-preflight.ts. */
export async function assertAnalyticsLedgerGuardArmed(db?: AnalyticsLedgerDb): Promise<void> {
  const own = db === undefined ? createNamespaceGuardClient(ANALYTICS_LEDGER_GUARD_BUDGET_MS) : undefined;
  try {
    const bound = expireAfter(ANALYTICS_LEDGER_GUARD_BUDGET_MS);
    const result = await Promise.race([checkAnalyticsLedgerGuard(own ?? db!), bound.expiry])
      .catch((err): LedgerGuardCheck => ({ status: "unavailable", problems: [], detail: err instanceof Error ? err.message : String(err) }))
      .finally(() => bound.cancel());
    guardOutcome = result.status;
    if (result.status === "disarmed") {
      for (const line of analyticsLedgerGuardRefusalLines(result.problems, "[api]")) console.error(line);
      if (process.env[ANALYTICS_LEDGER_GUARD_OVERRIDE_ENV] === "1") {
        console.error(`[api] ${ANALYTICS_LEDGER_GUARD_OVERRIDE_ENV}=1 — OVERRIDE: serving ANYWAY with the analytics ledger guard unarmed.`);
        guardOutcome = "disarmed";
        return;
      }
      console.error(`[api] The api will NOT start: the Phase A analytics ledger is not verifiably immutable.`);
      process.exit(1);
    }
    if (result.status === "unavailable") {
      console.error(`[api] analytics ledger guard check could NOT run — database not queryable: ${result.detail}. Serving anyway, UNCHECKED.`);
      guardOutcome = "unchecked" as LedgerGuardStatus;
      return;
    }
  } finally {
    if (own) void own.end({ timeout: 0 }).catch(() => {});
  }
}
