// Issue #812: a graduated member (`swarm_members.role = 'judge'`) judges under
// its own identity, and the role/status/take-conflict checks run before any
// judgement row lands. Since issue #1026 (D53 point 4) those checks live where a
// judgement enters — `submitJudgement` in domain.ts — and every judgement is
// SIGNED by its judge's own key, so the tests below sign with the member's key.
import { expect, test } from "bun:test";
import { sql } from "../src/db/client.ts";
import * as admin from "../src/swarm/admin.ts";
import * as ic from "../src/swarm/domain.ts";
import { setJudgeConfig } from "../src/swarm/judge-config.ts";
import { canonicalizeSubmission } from "@robotmoney/contract";
import { generateKeyPair, signMessage } from "../src/lib/signing.ts";
import { useCleanDatabasePerTest } from "./support/clean-db.ts";
import { ensureProseSubject } from "./support/prose-subject.ts";
import { requestJudgingFor, seatJudge, signedJudgement, enforceJudging } from "./support/stub-judge.ts";

useCleanDatabasePerTest(import.meta.file);

const rid = (prefix: string) => `${prefix}_${crypto.randomUUID().slice(0, 8)}`;

async function member(prefix: string) {
  const id = rid(prefix);
  const { publicKeyB64, privateKey } = await generateKeyPair();
  const result = await ic.registerMember({ memberId: id, name: id, publicKey: publicKeyB64 });
  if (!("token" in result) || !result.token) throw new Error(`registerMember failed: ${JSON.stringify(result)}`);
  return { id, token: result.token, privateKey };
}

async function session(prefix: string) {
  const subjectId = rid(prefix);
  await ensureProseSubject(subjectId, subjectId);
  const opened = await ic.openSession(subjectId);
  await ic.publishBrief(opened.id, 60);
  return { subjectId, session: opened, date: opened.date instanceof Date ? opened.date.toISOString().slice(0, 10) : String(opened.date).slice(0, 10) };
}

async function submit(m: Awaited<ReturnType<typeof member>>, date: string, subjectId: string) {
  const payload = { memberId: m.id, date, subjectId, nonce: rid("nonce"), stance: "neutral", confidence: 0.5, body: "signed take" };
  const signature = await signMessage(canonicalizeSubmission(payload), m.privateKey);
  return ic.submitRecommendation(m.token, { ...payload, signature });
}

/** Two signed takes, closed, aggregated and in `judging`. */
async function judging(prefix: string) {
  const s = await session(prefix);
  const voters = [await member("voter_a"), await member("voter_b")];
  for (const voter of voters) expect((await submit(voter, s.date, s.subjectId)).status).toBe(201);
  await enforceJudging();
  await ic.closeWindow(s.session.id);
  await ic.aggregateSession(s.session.id);
  await requestJudgingFor(s.session.id);
  return s;
}

const judge = async (m: Awaited<ReturnType<typeof member>>, sessionId: string) =>
  ic.submitJudgement(m.token, await signedJudgement(m, sessionId));

const rowsFor = async (sessionId: string) =>
  (await sql`SELECT judged_by, judged_by_member_id FROM swarm_session_judgements WHERE session_id = ${sessionId}`) as any[];

test("grant/revoke preserves the existing credential and makes judging immediately permitted then refused", async () => {
  const candidate = await member("candidate");
  const before = await session("before");
  expect((await submit(candidate, before.date, before.subjectId)).status).toBe(201);

  const grant = await admin.setMemberRoleAdmin(candidate.id, 1, "judge");
  expect(grant.ok).toBe(true);
  expect((grant as any).member.role).toBe("judge");
  // The token and key were not replaced: the same bearer still identifies this
  // identity, but the standing separation-of-duties gate refuses its take.
  expect(await ic.memberIdForToken(candidate.token)).toBe(candidate.id);
  const whileJudge = await session("while_judge");
  expect((await submit(candidate, whileJudge.date, whileJudge.subjectId)).error).toBe("judge_role_cannot_submit_takes");

  // The candidate is not in-house (no `robotmoney` operator), so the
  // third-party flag must be on for these #812 checks to be what is tested.
  await setJudgeConfig({ thirdPartyEnabled: true });
  const judged = await judging("judge_allowed");
  const allowed = await judge(candidate, judged.session.id);
  expect(allowed.ok, JSON.stringify(allowed)).toBe(true);
  expect(await rowsFor(judged.session.id)).toEqual([{ judged_by: candidate.id, judged_by_member_id: candidate.id }]);

  // Rotation is still the existing member path, including for a judge: it
  // carries the same public key and returns a new bearer token only once.
  const rotated = await admin.rotateMemberKeyAdmin(candidate.id);
  expect(rotated.ok).toBe(true);
  candidate.token = (rotated as any).token;
  expect(await ic.memberIdForToken(candidate.token)).toBe(candidate.id);
  const current = (await admin.listMembersAdmin()).find((m) => m.id === candidate.id)!;
  const revoke = await admin.setMemberRoleAdmin(candidate.id, current.version, "member");
  expect(revoke.ok).toBe(true);
  const after = await session("after");
  expect((await submit(candidate, after.date, after.subjectId)).status).toBe(201);
  const refusalSession = await judging("after_refusal");
  expect(await judge(candidate, refusalSession.session.id)).toEqual({ ok: false, status: 403, error: "judge_role_required" });
  expect(await rowsFor(refusalSession.session.id)).toEqual([]);
});

test("an in-house judge and a graduated third-party member both leave named judgement parties", async () => {
  await setJudgeConfig({ thirdPartyEnabled: true });
  const inHouse = await seatJudge({ prefix: "in_house", operator: "robotmoney" });
  const first = await judging("in_house");
  expect((await ic.submitJudgement(inHouse.token, await signedJudgement(inHouse, first.session.id))).ok).toBe(true);
  expect(await rowsFor(first.session.id)).toEqual([{ judged_by: inHouse.id, judged_by_member_id: inHouse.id }]);

  const candidate = await member("named_judge");
  expect((await admin.setMemberRoleAdmin(candidate.id, 1, "judge")).ok).toBe(true);
  const external = await judging("member_judge");
  expect((await judge(candidate, external.session.id)).ok).toBe(true);
  expect((await rowsFor(external.session.id)).map((r) => r.judged_by_member_id)).toContain(candidate.id);
});

test("a non-judge is refused before a judgement row is written", async () => {
  await setJudgeConfig({ thirdPartyEnabled: true });
  const candidate = await member("ungraduated");
  const s = await judging("refusal");
  expect(await judge(candidate, s.session.id)).toEqual({ ok: false, status: 403, error: "judge_role_required" });
  expect(await rowsFor(s.session.id)).toHaveLength(0);
});

// Issue #925 (review-security-002): the judge/take conflict-of-interest guard.
// A member submits a take as an ordinary voter, is later promoted to
// `role: 'judge'`, and then attempts to judge the very session it already has
// a take in — separation of duties must refuse this before any judgement row
// lands, not merely discourage it.
test("a judge who already submitted a take in the session is refused before a judgement row is written", async () => {
  // thirdPartyEnabled must be ON so the take-conflict check (which runs AFTER
  // the third-party gate) is actually what is under test here, rather than a
  // third-party refusal masking it.
  await setJudgeConfig({ thirdPartyEnabled: true });

  const candidate = await member("has_take");
  const s = await session("take_conflict");
  const voter = await member("voter_take_conflict");
  // Submitted while candidate is still a plain member — the role promotion
  // below happens strictly AFTER this take is on the session.
  expect((await submit(candidate, s.date, s.subjectId)).status).toBe(201);
  expect((await submit(voter, s.date, s.subjectId)).status).toBe(201);
  await enforceJudging();
  await ic.closeWindow(s.session.id);
  await ic.aggregateSession(s.session.id);
  await requestJudgingFor(s.session.id);

  expect((await admin.setMemberRoleAdmin(candidate.id, 1, "judge")).ok).toBe(true);

  expect(await judge(candidate, s.session.id)).toEqual({ ok: false, status: 409, error: "judge_member_has_take_in_session" });
  expect(await rowsFor(s.session.id)).toHaveLength(0);
});
