// Shared primitives for preflight/postflight scripts (backend/scripts/lib/
// preflight-utils.ts, postflight-utils.ts, and the versioned scripts under
// backend/scripts/upgrades/<from>-to-<to>/). Deliberately tiny and dependency-
// free beyond `postgres` — this is imported by standalone, zero-write-risk
// scripts, so it must not drag in src/config.ts or a shared pool.

export type Status = "PASS" | "WARN" | "FAIL";

export interface CheckResult {
  name: string;
  status: Status;
  detail: string[];
  /** What the operator does about it. Only read for WARN/FAIL. */
  remediation?: string;
}

/**
 * A bound, per-run instance — NOT a module-level global. A process that runs
 * checks twice in one lifetime (e.g. once against a restored dump, once
 * against a live replica) needs two independent result sets, not one that
 * accumulates across both runs.
 */
export interface Checker {
  results: CheckResult[];
  record(name: string, status: Status, detail: string | string[], remediation?: string): CheckResult;
}

export function createChecker(logPrefix: string): Checker {
  const results: CheckResult[] = [];
  return {
    results,
    record(name, status, detail, remediation) {
      const r: CheckResult = {
        name,
        status,
        detail: Array.isArray(detail) ? detail : [detail],
        remediation,
      };
      results.push(r);
      const head = r.detail[0] ?? "";
      console.log(`${logPrefix}[${status.padEnd(4)}] ${name.padEnd(22)} ${head}`);
      for (const line of r.detail.slice(1)) console.log(`${" ".repeat(logPrefix.length + 31)}${line}`);
      return r;
    },
  };
}

type QueryableDb = { unsafe(query: string, params?: unknown[]): Promise<unknown> };

/**
 * `to_regclass('public.<table>') IS NOT NULL` — the pattern every check here
 * uses before touching a table that might not exist yet (pre-migration) or
 * might never have existed on the database this run is pointed at.
 */
export async function tableExists(db: QueryableDb, table: string): Promise<boolean> {
  const [row] = (await db.unsafe(
    `SELECT to_regclass('public.${table}') IS NOT NULL AS present`,
  )) as unknown as { present: boolean }[];
  return row?.present ?? false;
}

/**
 * `information_schema.columns` existence check — the ONE safe way to ask
 * "does this column exist yet" before a migration that adds it has applied.
 * Naming a not-yet-existing column directly raises 42703, which reads as a
 * confusing failure rather than the expected pre-migration state. This
 * pattern is documented at length in docs/runbooks/*.md (§2's
 * admin-credential recovery_hash, §8's checks 4/6/7/9, §5.3's
 * namespace-invariant query) —
 * three separate hand-written landmines this helper exists to stop from
 * recurring a fourth time.
 */
export async function columnExists(db: QueryableDb, table: string, column: string): Promise<boolean> {
  const [row] = (await db.unsafe(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2
     ) AS present`,
    [table, column],
  )) as unknown as { present: boolean }[];
  return row?.present ?? false;
}

/** Prints the final PASS/WARN/FAIL summary and returns the process exit code
 *  (0 = clean or warn-only, 1 = at least one FAIL). Shared by preflight and
 *  postflight — only the pass/blocked wording differs between them. */
export function printVerdict(
  results: CheckResult[],
  labels: { logPrefix: string; okAll: string; okWithWarnings: string; blocked: string },
): number {
  const fails = results.filter((r) => r.status === "FAIL");
  const warns = results.filter((r) => r.status === "WARN");
  const p = labels.logPrefix;

  console.log("");
  console.log("─".repeat(78));
  if (fails.length === 0 && warns.length === 0) {
    console.log(`${labels.okAll} — all checks passed.`);
    return 0;
  }
  if (fails.length === 0) {
    console.log(`${labels.okWithWarnings} with ${warns.length} warning(s). Read them before you start:`);
    for (const w of warns) console.log(`  [WARN] ${w.name}: ${w.remediation ?? w.detail[0]}`);
    return 0;
  }
  console.log(
    `${labels.blocked} — ${fails.length} blocking condition(s)${warns.length > 0 ? `, ${warns.length} warning(s)` : ""}.`,
  );
  for (const f of fails) {
    console.log(`  [FAIL] ${f.name}`);
    console.log(`         ${f.detail[0]}`);
    if (f.remediation) console.log(`         FIX: ${f.remediation}`);
  }
  for (const w of warns) console.log(`  [WARN] ${w.name}: ${w.remediation ?? w.detail[0]}`);
  return 1;
}
