// Shared fixtures for the epoch-lifecycle test files (issue #1026 W4.1-W4.3).
//
// Five files drive the same three objects — an active subject with a known
// epoch duration, a seated member that can sign a take, and the session row
// itself — so they are built once here rather than copied five times. Nothing
// in this module asserts; it only constructs, which keeps each test file's
// intent readable and stops a fixture drift in one file from silently changing
// what another file believes it is testing.
import * as ic from "../../src/swarm/domain.ts";
import { sql } from "../../src/db/client.ts";
import { ensureProseSubject } from "./prose-subject.ts";
import { generateKeyPair, signMessage } from "../../src/lib/signing.ts";
import { canonicalizeSubmission } from "@robotmoney/contract";

export const rid = (p: string) => `${p}_${crypto.randomUUID().slice(0, 8)}`;

/** The DATABASE dates a session (migration 0022). Tests read it, never choose it. */
export const sessionDate = (s: Record<string, unknown>): string =>
  s.date instanceof Date ? s.date.toISOString().slice(0, 10) : String(s.date).slice(0, 10);

/**
 * An ACTIVE subject with an explicit epoch duration.
 *
 * Prose-typed for the same reason tests/support/prose-subject.ts exists: a
 * `bucket_weights` subject refuses a weightless take, and none of these files
 * is about allocations.
 */
export async function activeSubject(prefix: string, epochDurationSeconds = 3600): Promise<string> {
  const id = rid(prefix);
  await ensureProseSubject(id, `${prefix} subject`);
  await sql`UPDATE swarm_subjects
               SET epoch_duration_seconds = ${epochDurationSeconds}, status = 'active'
             WHERE id = ${id}`;
  return id;
}

export interface TestMember {
  id: string;
  token: string;
  privateKey: CryptoKey;
}

export async function activeMember(): Promise<TestMember> {
  const id = rid("m");
  const { publicKeyB64, privateKey } = await generateKeyPair();
  const r = await ic.registerMember({ memberId: id, name: id, publicKey: publicKeyB64 });
  if (!("token" in r) || !r.token) {
    throw new Error(`activeMember(): registerMember failed for ${id}: ${JSON.stringify(r)}`);
  }
  return { id, token: r.token, privateKey };
}

/** Submit a signed take exactly as a participant container would. */
export async function submitTake(
  m: TestMember,
  date: string,
  subjectId: string,
  overrides: Partial<{ stance: string; confidence: number; body: string }> = {},
) {
  const sub = {
    memberId: m.id,
    date,
    subjectId,
    nonce: rid("n"),
    stance: overrides.stance ?? "neutral",
    confidence: overrides.confidence ?? 0.5,
    body: overrides.body ?? "a take",
  };
  const signature = await signMessage(canonicalizeSubmission(sub), m.privateKey);
  return ic.submitRecommendation(m.token, { ...sub, signature });
}

export async function sessionRow(id: string): Promise<Record<string, any>> {
  const [row] = await sql`SELECT * FROM swarm_sessions WHERE id = ${id}`;
  if (!row) throw new Error(`no session ${id}`);
  return row as Record<string, any>;
}

export async function collectingSessions(subjectId: string): Promise<Record<string, any>[]> {
  return (await sql`SELECT * FROM swarm_sessions
                     WHERE subject_id = ${subjectId} AND state = 'collecting'
                     ORDER BY convened_at`) as unknown as Record<string, any>[];
}

/**
 * Set the operator's judge mode.
 *
 * Written straight to the one-row config rather than through
 * `setJudgeConfig()` on purpose: that function also enforces the pinned-model
 * policy (judge-model-policy.ts), which has nothing to do with the epoch
 * lifecycle and would bind these files to whichever model happens to be
 * pinned. `enforce` needs SOME model by migration 0056's CHECK, so one is
 * supplied; no judge is ever called from these files.
 */
export async function setJudgeMode(mode: "off" | "enforce"): Promise<void> {
  await sql`UPDATE swarm_judge_config
               SET mode = ${mode},
                   model = ${mode === "off" ? null : "test/epoch-fixture-judge"},
                   updated_at = now()
             WHERE id = 1`;
}

/** Seat a member on the session's FROZEN expected roster (the absence denominator). */
export async function seat(sessionId: string, member: TestMember): Promise<void> {
  await sql`INSERT INTO swarm_session_members (session_id, member_id, member_name)
            VALUES (${sessionId}, ${member.id}, ${member.id})
            ON CONFLICT DO NOTHING`;
}
