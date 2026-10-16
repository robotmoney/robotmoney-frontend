// A stand-in JUDGE PARTICIPANT, for backend tests that need a judgement to
// EXIST (issue #1026, D53 point 4).
//
// WHAT CHANGED. This file used to be a local stand-in for the OpenCode Zen
// endpoint, because the judge ran inside the API and a test reached a recorded
// judgement by letting that inline judge call it. The inline judge is deleted;
// the judge is a participant that subscribes, runs its own model and submits a
// SIGNED judgement (smoke-production-spec.md §6.2). So a test now does exactly
// what `scripts/agent/participant/judge-client.ts` does, minus the HTTP hop:
// seat a real member with `role = 'judge'` and its own Ed25519 key, read the
// input the subscription serves, sign the model's answer over the contract's
// canonical judgement bytes, and hand it to `submitJudgement` — which verifies
// the signature, re-checks the digest and parses the answer exactly as it does
// for a real judge.
//
// NOTHING HERE IS A FALLBACK. The "model answer" is a fixed string a test
// chooses; it goes through the same parser and the same refusals as any other.
import { canonicalizeJudgement } from "@robotmoney/contract";
import { sql } from "../../src/db/client.ts";
import {
  judgeInputFromFrozen,
  loadFrozenTakeSet,
  registerMember,
  requestJudging,
  submitJudgement,
  type JudgementSubmission,
  type SubmitJudgementResult,
} from "../../src/swarm/domain.ts";
import { getJudgeConfig, setJudgeConfig } from "../../src/swarm/judge-config.ts";
import { inputsDigest, JUDGE_PROMPT_HASH } from "../../src/swarm/judge.ts";
import { generateKeyPair, signMessage } from "../../src/lib/signing.ts";

/** The model a stub judgement names. Any non-keyless id; nothing calls it. */
export const STUB_JUDGE_MODEL = "stub/judge";

/** A valid judge answer. `disagreements` is empty so one reply serves every
 *  session — an empty array is a correct answer, and it needs no real member
 *  ids, which a `positions[]` entry would. */
export const STUB_JUDGE_REPLY = JSON.stringify({
  rationale: "Stub judge: the submitted takes support the session's read.",
  disagreements: [],
  release_safety: { release: "safe", concerns: [] },
});

export interface TestJudge {
  id: string;
  token: string;
  privateKey: CryptoKey;
}

/**
 * Seat an active judge. `operator` defaults to the in-house `robotmoney`, which
 * passes the third-party gate whatever `third_party_enabled` says (§6.2); pass
 * another value (or null) for a third-party judge.
 */
export async function seatJudge(
  opts: { prefix?: string; operator?: string | null } = {},
): Promise<TestJudge> {
  const id = `${opts.prefix ?? "judge"}_${crypto.randomUUID().slice(0, 8)}`;
  const { publicKeyB64, privateKey } = await generateKeyPair();
  const r = await registerMember({ memberId: id, name: id, publicKey: publicKeyB64 });
  if (!("token" in r) || !r.token) throw new Error(`seatJudge(): registerMember failed: ${JSON.stringify(r)}`);
  const operator = opts.operator === undefined ? "robotmoney" : opts.operator;
  await sql`UPDATE swarm_members SET role = 'judge', operator = ${operator} WHERE id = ${id}`;
  return { id, token: r.token, privateKey };
}

let standing: TestJudge | null = null;

/**
 * THE in-house judge for a test file: seated once and reused while its row
 * exists, re-seated after a per-test database reset. Reuse matters: the judge
 * of record is the lowest-id eligible judge (scheduler spec §4.4), so seating a
 * fresh judge for every session would let a later one outrank the judge whose
 * judgements a test expects to be the consensus.
 */
export async function inHouseJudge(): Promise<TestJudge> {
  if (standing) {
    const [row] = await sql<{ id: string }[]>`
      SELECT id FROM swarm_members WHERE id = ${standing.id} AND status = 'active' AND role = 'judge'`;
    if (row) return standing;
  }
  standing = await seatJudge({ prefix: "in_house_judge" });
  return standing;
}

/** The digest of what the subscription would serve for this session right now. */
export async function servedDigest(sessionId: string): Promise<string> {
  const frozen = await loadFrozenTakeSet(sessionId);
  if (!frozen) throw new Error(`servedDigest(): no session ${sessionId}`);
  return inputsDigest(await judgeInputFromFrozen(frozen, (await getJudgeConfig()).minTakes));
}

/** A signed submission, exactly as judge-client.ts builds one. Fields can be overridden to forge. */
export async function signedJudgement(
  judge: TestJudge,
  sessionId: string,
  opinion: string = STUB_JUDGE_REPLY,
  over: Partial<{ model: string; promptHash: string; inputsDigest: string; nonce: string; signAs: string }> = {},
): Promise<JudgementSubmission> {
  const body = {
    sessionId,
    opinion,
    model: over.model ?? STUB_JUDGE_MODEL,
    promptHash: over.promptHash ?? JUDGE_PROMPT_HASH,
    inputsDigest: over.inputsDigest ?? await servedDigest(sessionId),
    nonce: over.nonce ?? crypto.randomUUID(),
  };
  const signature = await signMessage(
    canonicalizeJudgement({ ...body, memberId: over.signAs ?? judge.id }),
    judge.privateKey,
  );
  return { ...body, signature };
}

/** Sign and submit, as the participant route would. */
export async function submitSigned(
  judge: TestJudge,
  sessionId: string,
  opinion: string = STUB_JUDGE_REPLY,
): Promise<SubmitJudgementResult> {
  return submitJudgement(judge.token, await signedJudgement(judge, sessionId, opinion));
}

/**
 * Switch the judge to `enforce` (with the stub model, which 0056 requires) so
 * the NEXT close captures it. Call it BEFORE `closeWindow`: the close stores
 * the judge mode in force on the session (system-scheduler-spec.md §4.4,
 * "Judge mode and judging duration are captured at turnover"), and settlement
 * reads only what the close captured. The shipped mode is `off`, and a session
 * closed under `off` is refused by `requestJudging` as `judge_mode_off`.
 * This goes through the real config writer, never a patched session row.
 */
export async function enforceJudging(): Promise<void> {
  await setJudgeConfig({ mode: "enforce", model: STUB_JUDGE_MODEL });
}

/**
 * Put an AGGREGATED session into `judging`, as the scheduler's request-judging
 * step does (system-scheduler-spec.md §4.4).
 *
 * NO MODE IS WRITTEN HERE. The mode was captured when the session closed, and
 * `requestJudging` refuses a session whose close captured `off`
 * (`judge_mode_off`) or nothing (`judging_not_captured`). A test that judges
 * therefore calls `enforceJudging()` before its `closeWindow`, and the tests
 * exercise that contract rather than a fixture-patched one.
 */
export async function requestJudgingFor(sessionId: string): Promise<void> {
  const requested = await requestJudging(sessionId);
  if (!requested.ok) throw new Error(`requestJudgingFor(): ${JSON.stringify(requested)}`);
}

/**
 * The whole participant path for one session: request judging, seat an
 * in-house judge (or use the one given), and submit its signed judgement. On
 * success the session is `judged` and carries the opinion, which is what a
 * consensus receipt embeds.
 */
export async function judgeViaParticipant(
  sessionId: string,
  opts: { judge?: TestJudge; opinion?: string } = {},
): Promise<{ judge: TestJudge; result: SubmitJudgementResult }> {
  await requestJudgingFor(sessionId);
  const judge = opts.judge ?? await inHouseJudge();
  const result = await submitSigned(judge, sessionId, opts.opinion ?? STUB_JUDGE_REPLY);
  return { judge, result };
}
