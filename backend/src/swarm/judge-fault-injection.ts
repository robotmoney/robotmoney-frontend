// THE TEST-ONLY JUDGE FAULT-INJECTION LEVER (R13, AC-E2E-06's
// malformed-judge-output clause).
//
// HISTORY FIRST: THE LEVER HAS NO CONSUMER TODAY. It was built for AC-E2E-06,
// which then asked for an executed demonstration that a malformed judge
// response yielded deterministic fallback prose, with `fallback_reason`
// recorded and the weight vector untouched. Its only consumer was the backend
// `judgeSession()`. That judge, and the template fallback with it, are deleted
// (D53 point 4): the judge is a participant, and a malformed answer is now
// REFUSED at submission (`judgement_refused:*`) with no row and no substitute
// prose. Until a judge participant reads this row, swarm/admin.ts refuses to
// arm it (`fault_injection_has_no_consumer`), so the gates below describe the
// lever as it will be consumed, not a path that runs today.
//
// THREE INDEPENDENT GATES, ALL OF WHICH MUST BE OPEN. The lever is a way to
// make the judge lie about what a model said; it is one env var away from being
// the mechanism that manufactures the exact evidence the QA plan forbids. So:
//
//   1. THE ROW (`swarm_judge_fault_injection`, migration 0058). Set only
//      through swarm/admin.ts's admin path, which writes an `audit_log` row in
//      the same transaction. There is no other writer.
//   2. THE PROCESS FLAG (`SWARM_JUDGE_FAULT_INJECTION`). A row enabled in a
//      database that some other process also reads cannot fault THAT process's
//      judging. An api/worker image run without the flag honours nothing.
//   3. ON AN ACCEPTANCE PATH, A SECOND EXPLICIT OPT-IN
//      (`SWARM_JUDGE_FAULT_INJECTION_ACCEPTANCE_OPT_IN`). RM_ENV=prod is what
//      BOTH staging and production run (judge-model-policy.ts), and under D13
//      an UNSET RM_ENV is acceptance/strict too — so the default answer on an
//      unlabelled deployment is REFUSED. The opt-in exists because staging is
//      where AC-E2E-06 is rehearsed; production has no reason to ever set it.
//
// ENABLING IT ON STAGING IS A RECORDED ACCEPTANCE MUTATION. A stack whose judge
// is answering from this table is not judging the way the rehearsal narrative
// says it is, and judgements produced while it is enabled are NOT evidence of
// the judge's model behaviour. The `audit_log` row written by the admin path is
// the record of when that began and when it ended, and it is the artifact the
// acceptance bundle cites. Turn it off — `{ enabled: false }` — as the last step
// of the demonstration.
//
// WHAT IT COULD NOT DO, when it had a consumer. The deleted judge() never
// parsed an injected body and never trusted one, so every injected call landed
// on the (now also deleted) deterministic fallback with
// `fallback_reason = "malformed_output"`. And it could not move a weight:
// weights come from meanTakeWeights() in domain.ts, and no judgement path
// receives them. A participant that takes the lever over must keep both
// properties: an injected body is at most a refused judgement, never a
// `source: "model"` one.
import { sql, type DbHandle } from "../db/client.ts";
import { isAcceptanceJudgeEnv } from "./judge-model-policy.ts";

/** The process flag that makes the row honourable at all. */
export const FAULT_INJECTION_FLAG_ENV = "SWARM_JUDGE_FAULT_INJECTION";
/** The SECOND, acceptance-path-only opt-in. */
export const FAULT_INJECTION_ACCEPTANCE_ENV = "SWARM_JUDGE_FAULT_INJECTION_ACCEPTANCE_OPT_IN";

/** Mirrors migration 0058's CHECKs, so a refusal names the bound before the driver does. */
export const FAULT_BODY_MAX_CHARS = 20_000;
export const FAULT_NOTE_MAX_CHARS = 500;
export const FAULT_REMAINING_MAX = 100;

/** The stored lever, as `swarm_judge_fault_injection` holds it. */
export interface JudgeFaultInjectionState {
  enabled: boolean;
  body: string;
  remaining: number;
  sessionId: string | null;
  note: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
}

/** The lever as it applies to ONE judging, once every gate has been passed. */
export interface JudgeFaultInjection {
  body: string;
  /** Echoed onto the audit trail and the judge log line; never into a reason string. */
  note: string | null;
}

/**
 * WHY A JUDGING IS NOT BEING FAULTED. `"allowed"` is the only value that opens
 * the gate; the other two are refusals with different operator answers, and the
 * admin path turns each into its own message.
 */
export type FaultInjectionGate = "allowed" | "flag_absent" | "acceptance_path";

/**
 * A lever an environment may not honour. Thrown by the admin path so an
 * operator gets the refusal at the moment they try to ARM it, rather than a
 * silently inert row they believe is working.
 */
export class JudgeFaultInjectionRefused extends Error {
  readonly gate: Exclude<FaultInjectionGate, "allowed">;
  constructor(gate: Exclude<FaultInjectionGate, "allowed">) {
    super(
      gate === "flag_absent"
        ? `the judge fault-injection lever is TEST-ONLY and this process was not started with ${FAULT_INJECTION_FLAG_ENV}=1. ` +
          "Set it on the judging process (api and worker) and try again — a row armed without it is inert."
        : `the judge fault-injection lever is REFUSED on an acceptance path (RM_ENV=prod, which staging and production ` +
          `both run, and which an UNSET RM_ENV resolves to under D13). Arming it here is a RECORDED ACCEPTANCE ` +
          `MUTATION: judgements produced while it is on are not evidence of the judge's model behaviour. To rehearse ` +
          `AC-E2E-06 on staging deliberately, set ${FAULT_INJECTION_ACCEPTANCE_ENV}=1 beside ` +
          `${FAULT_INJECTION_FLAG_ENV}=1 and re-issue this request.`,
    );
    this.name = "JudgeFaultInjectionRefused";
    this.gate = gate;
  }
}

function flagSet(value: string | undefined): boolean {
  const v = (value ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/**
 * Whether THIS process may honour (or arm) the lever at all. Evaluated on every
 * judging, not cached: the answer is a property of the process environment and
 * an operator reading a refusal must be reading today's answer.
 */
export function faultInjectionGate(
  env: Record<string, string | undefined> = process.env,
): FaultInjectionGate {
  if (!flagSet(env[FAULT_INJECTION_FLAG_ENV])) return "flag_absent";
  if (isAcceptanceJudgeEnv(env) && !flagSet(env[FAULT_INJECTION_ACCEPTANCE_ENV])) return "acceptance_path";
  return "allowed";
}

/** The gate as a refusal. Returns silently when it is open. */
export function assertFaultInjectionAllowed(env: Record<string, string | undefined> = process.env): void {
  const gate = faultInjectionGate(env);
  if (gate !== "allowed") throw new JudgeFaultInjectionRefused(gate);
}

/**
 * The lever as it applies to `sessionId`, or null when it does not apply —
 * because the gate is shut, the row is off or spent, or the row names a
 * DIFFERENT session.
 *
 * Pure, so the whole selection rule is testable without a database.
 */
export function selectFaultInjection(
  state: JudgeFaultInjectionState | null | undefined,
  sessionId: string,
  env: Record<string, string | undefined> = process.env,
): JudgeFaultInjection | null {
  if (!state || !state.enabled) return null;
  if (faultInjectionGate(env) !== "allowed") return null;
  if (state.remaining <= 0) return null;
  if (!state.body.trim()) return null;
  if (state.sessionId && state.sessionId !== sessionId) return null;
  return { body: state.body, note: state.note };
}

function toState(row: Record<string, unknown> | undefined): JudgeFaultInjectionState {
  return {
    enabled: row?.enabled === true,
    body: typeof row?.body === "string" ? row.body : "",
    remaining: Number(row?.remaining ?? 0),
    sessionId: (row?.session_id as string | null) ?? null,
    note: (row?.note as string | null) ?? null,
    updatedBy: (row?.updated_by as string | null) ?? null,
    updatedAt: row?.updated_at ? String(row.updated_at) : null,
  };
}

export async function getJudgeFaultInjection(db: DbHandle = sql): Promise<JudgeFaultInjectionState> {
  const row = (await db`SELECT enabled, body, remaining, session_id, note, updated_by, updated_at FROM swarm_judge_fault_injection WHERE id = 1`)[0] as
    | Record<string, unknown>
    | undefined;
  return toState(row);
}

export interface JudgeFaultInjectionPatch {
  enabled: boolean;
  body?: string;
  remaining?: number;
  sessionId?: string | null;
  note?: string | null;
}

/**
 * Arm or disarm the lever. VALIDATION MIRRORS THE MIGRATION so the refusal an
 * operator reads names the rule rather than a driver's CHECK string.
 *
 * DISARMING IS ALWAYS ALLOWED, in every environment: the gate is asserted by
 * the caller (swarm/admin.ts) only for `enabled: true`. An acceptance stack
 * that somehow has an armed row must never need a second env var to turn it
 * OFF — that is the direction that reduces risk.
 */
export async function writeJudgeFaultInjection(
  patch: JudgeFaultInjectionPatch,
  actor: string,
  db: DbHandle = sql,
): Promise<JudgeFaultInjectionState> {
  const body = (patch.body ?? "").toString();
  const remaining = patch.remaining ?? 0;
  const note = patch.note ?? null;
  if (patch.enabled) {
    if (!body.trim()) throw new Error("judge fault injection requires a non-empty body to return");
    if (body.length > FAULT_BODY_MAX_CHARS) {
      throw new Error(`judge fault-injection body exceeds ${FAULT_BODY_MAX_CHARS} characters`);
    }
    if (!Number.isInteger(remaining) || remaining < 1 || remaining > FAULT_REMAINING_MAX) {
      throw new Error(`judge fault-injection remaining must be an integer between 1 and ${FAULT_REMAINING_MAX}`);
    }
  }
  if (note !== null && (typeof note !== "string" || note.length > FAULT_NOTE_MAX_CHARS)) {
    throw new Error(`judge fault-injection note exceeds ${FAULT_NOTE_MAX_CHARS} characters`);
  }
  // Disarming CLEARS the payload rather than leaving it parked in the table: a
  // disabled row still holding a weight-smuggling body is an invitation.
  const row = (await db`
    UPDATE swarm_judge_fault_injection SET
      enabled = ${patch.enabled},
      body = ${patch.enabled ? body : ""},
      remaining = ${patch.enabled ? remaining : 0},
      session_id = ${patch.enabled ? (patch.sessionId ?? null) : null},
      note = ${patch.enabled ? note : null},
      updated_by = ${actor},
      updated_at = now()
    WHERE id = 1
    RETURNING enabled, body, remaining, session_id, note, updated_by, updated_at`)[0] as Record<string, unknown> | undefined;
  return toState(row);
}

/**
 * Spend one call off the lever, and disarm it when it reaches zero.
 *
 * Decremented CONDITIONALLY in SQL (`remaining > 0`) rather than read-then-
 * write, so two concurrent judgings cannot both spend the last call — the
 * lever's whole purpose is a bounded, countable number of faulted judgings.
 */
export async function consumeJudgeFaultInjection(db: DbHandle = sql): Promise<void> {
  await db`
    UPDATE swarm_judge_fault_injection
    SET remaining = remaining - 1,
        enabled = (remaining - 1) > 0,
        body = CASE WHEN (remaining - 1) > 0 THEN body ELSE '' END,
        session_id = CASE WHEN (remaining - 1) > 0 THEN session_id ELSE NULL END,
        updated_at = now()
    WHERE id = 1 AND enabled AND remaining > 0`;
}
