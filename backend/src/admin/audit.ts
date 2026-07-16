// Shared audit_log writer + redactor for the admin surface (issue #155,
// docs/plan-admin-surface.md §5.4/§6.3/US-A3). Every admin mutation this issue
// owns (dead-job retry, schedule toggle) writes exactly one row here in the
// same transaction as its state change, and GET /api/admin/audit reads it back
// through `redactDeep` so no credential material ever reaches the response.
import type { DbHandle } from "../db/client.ts";
import { jsonValue } from "../db/client.ts";

export interface RecordAuditInput {
  actor: string;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  reason?: string | null;
  beforeState?: unknown;
  afterState?: unknown;
  outcome?: "succeeded" | "failed";
  jobId?: number | null;
  sessionId?: string | null;
  // Legacy free-form column (migration 0004); kept for callers that want a
  // quick cross-reference (e.g. { sourceJobId, newJobId }) without widening
  // target_type/target_id to a compound key.
  scope?: unknown;
}

export interface AuditRow {
  id: number;
  request_id: string;
}

// Insert one audit_log row on the given handle (pool or transaction) and
// return its id/request_id so the caller can echo `auditRequestId` in its API
// response. Must run inside the SAME transaction as the mutation it records.
export async function recordAudit(db: DbHandle, input: RecordAuditInput): Promise<AuditRow> {
  const [row] = await db`
    INSERT INTO audit_log (
      actor, action, scope, target_type, target_id, reason,
      before_state, after_state, outcome, job_id, session_id
    ) VALUES (
      ${input.actor}, ${input.action}, ${input.scope != null ? db.json(jsonValue(input.scope)) : null},
      ${input.targetType ?? null}, ${input.targetId ?? null}, ${input.reason ?? null},
      ${input.beforeState != null ? db.json(jsonValue(input.beforeState)) : null},
      ${input.afterState != null ? db.json(jsonValue(input.afterState)) : null},
      ${input.outcome ?? "succeeded"}, ${input.jobId ?? null}, ${input.sessionId ?? null}
    )
    RETURNING id, request_id`;
  return row as AuditRow;
}

// Keys that must never leave the admin surface, matched case-insensitively
// anywhere in a nested audit payload (docs/plan-admin-surface.md §6.2/§8.1:
// "Secrets, token hashes, bearer tokens, signatures, ... and request headers
// are excluded from audit JSON"). A key match redacts the whole subtree so a
// nested `{ credential: { token: "..." } }` cannot smuggle a value out under
// an unlisted parent key.
const FORBIDDEN_KEY_RE = /token|authoriz|header|cookie|secret|password|signature/i;
const REDACTED = "[redacted]";

export function redactDeep<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as unknown as T;
  if (value != null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = FORBIDDEN_KEY_RE.test(k) ? REDACTED : redactDeep(v);
    }
    return out as unknown as T;
  }
  return value;
}

// Redact the jsonb-bearing columns of one audit_log row for API output.
export function redactAuditRow<T extends { scope?: unknown; before_state?: unknown; after_state?: unknown }>(
  row: T,
): T {
  return {
    ...row,
    scope: row.scope != null ? redactDeep(row.scope) : row.scope,
    before_state: row.before_state != null ? redactDeep(row.before_state) : row.before_state,
    after_state: row.after_state != null ? redactDeep(row.after_state) : row.after_state,
  };
}
