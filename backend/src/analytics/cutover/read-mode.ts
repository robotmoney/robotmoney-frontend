// Issue #979: the runtime switch every ledger-derived-current read consults
// (report/projections.ts, api/routes/admin.ts, swarm/domain.ts). Backed by
// migration 0060's single-row analytics_read_mode table — never an in-process
// flag alone — so every API process instance agrees, and so flipping it is
// itself an ordinary, observable database write (audited the same way any
// other admin action is; see setAnalyticsReadMode's caller in
// scripts/analytics-ledger-cutover-gate.ts).
import { sql, type DbHandle } from "../../db/client.ts";
import { on, registerQuery } from "../../db/registry.ts";
import { evaluateCutoverGate, defaultCutoverGateConfig } from "./gate.ts";

export type AnalyticsReadMode = "compatibility" | "ledger";

// Registered queries (smoke-production-spec.md §7.1). The switch is READ on
// every ledger-derived-current request path and by the cutover CLI; it is
// WRITTEN only by that CLI.
const readMode = registerQuery({
  role: "rm_app",
  object: "analytics_read_mode",
  privileges: ["SELECT"],
  site: "src/analytics/cutover/read-mode:getAnalyticsReadMode",
  purpose: "Read which source (compatibility tables or the immutable ledger) a ledger-derived-current read serves from.",
  // admin (analytics overview), dashboards (report projections), swarm (a
  // brief's body), and the cutover CLI's status line.
  callers: [
    "src/api/routes/admin",
    "src/api/routes/dashboards",
    "src/api/routes/swarm",
    "scripts/analytics-ledger-cutover-gate",
  ],
  probe: { statement: "SELECT mode FROM analytics_read_mode WHERE id = true" },
});

const writeMode = registerQuery({
  role: "rm_app",
  object: "analytics_read_mode",
  // SELECT because the WHERE reads the row it updates.
  privileges: ["UPDATE", "SELECT"],
  site: "src/analytics/cutover/read-mode:setAnalyticsReadMode",
  purpose: "Flip the single analytics read-mode row, behind the cutover gate for 'ledger' and ungated for a rollback.",
  callers: ["scripts/analytics-ledger-cutover-gate"],
  probe: {
    statement: `UPDATE analytics_read_mode SET mode = $1, updated_at = clock_timestamp(), updated_by = $2
      WHERE id = true`,
    params: ["compatibility", "probe"],
  },
});

export async function getAnalyticsReadMode(db: DbHandle = sql): Promise<AnalyticsReadMode> {
  const [row] = await on(db, readMode)<{ mode: AnalyticsReadMode }>`SELECT mode FROM analytics_read_mode WHERE id = true`;
  // No row is a first-boot-before-migration-0060 shape, never a reason to
  // refuse a read: default to the mode every consumer has always used.
  return row?.mode ?? "compatibility";
}

// Thrown by setAnalyticsReadMode('ledger') when the cutover gate has not
// passed — switching to ledger-mode reads is refused, not merely warned
// about, the same fail-closed shape the append-only guard uses.
export class CutoverGateNotPassedError extends Error {
  constructor(public readonly reasons: readonly string[]) {
    super(`ledger-mode cutover refused: ${reasons.join("; ")}`);
    this.name = "CutoverGateNotPassedError";
  }
}

// Non-destructive by construction (issue #979 AC4): this UPDATEs ONE row in
// a table migration 0060 deliberately left OUTSIDE the append-only guard
// (it is a config switch, not history — see that migration's header) and
// touches no ledger table at all, in either direction. Rolling back from
// 'ledger' to 'compatibility' is exactly as cheap and exactly as safe as the
// forward switch: both are the same single UPDATE.
export async function setAnalyticsReadMode(
  mode: AnalyticsReadMode,
  updatedBy: string,
  db: DbHandle = sql,
): Promise<void> {
  // The gate is enforced HERE, not only in the CLI (defense in depth): every
  // caller of this function — script, admin action, or a future direct call —
  // is refused the same way. Switching to 'compatibility' is never gated: a
  // rollback must always be available, including to recover from a bad
  // cutover.
  if (mode === "ledger") {
    const result = await evaluateCutoverGate(db, defaultCutoverGateConfig());
    if (!result.ok) throw new CutoverGateNotPassedError(result.reasons);
  }
  await on(db, writeMode)`
    UPDATE analytics_read_mode SET mode = ${mode}, updated_at = clock_timestamp(), updated_by = ${updatedBy}
    WHERE id = true`;
}
