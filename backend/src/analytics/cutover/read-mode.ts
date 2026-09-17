// Issue #979: the runtime switch every ledger-derived-current read consults
// (report/projections.ts, api/routes/admin.ts, swarm/domain.ts). Backed by
// migration 0060's single-row analytics_read_mode table — never an in-process
// flag alone — so every API process instance agrees, and so flipping it is
// itself an ordinary, observable database write (audited the same way any
// other admin action is; see setAnalyticsReadMode's caller in
// scripts/analytics-ledger-cutover-gate.ts).
import { sql, type DbHandle } from "../../db/client.ts";
import { evaluateCutoverGate, defaultCutoverGateConfig } from "./gate.ts";

export type AnalyticsReadMode = "compatibility" | "ledger";

export async function getAnalyticsReadMode(db: DbHandle = sql): Promise<AnalyticsReadMode> {
  const [row] = (await db`SELECT mode FROM analytics_read_mode WHERE id = true`) as unknown as { mode: AnalyticsReadMode }[];
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
  await db`
    UPDATE analytics_read_mode SET mode = ${mode}, updated_at = clock_timestamp(), updated_by = ${updatedBy}
    WHERE id = true`;
}
