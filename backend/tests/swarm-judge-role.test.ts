import { expect, test } from "bun:test";
import { sql } from "../src/db/client.ts";
import * as admin from "../src/swarm/admin.ts";
import * as swarm from "../src/swarm/domain.ts";
import { judgeSession, latestJudgement, setJudgeConfig } from "../src/swarm/judge-session.ts";
import { canonicalizeSubmission } from "@robotmoney/contract";
import { generateKeyPair, signMessage } from "../src/lib/signing.ts";
import { useCleanDatabasePerTest } from "./support/clean-db.ts";

useCleanDatabasePerTest(import.meta.file);

const rid = (prefix: string) => `${prefix}_${crypto.randomUUID().slice(0, 8)}`;

async function member(prefix: string) {
  const id = rid(prefix);
  const { publicKeyB64, privateKey } = await generateKeyPair();
  const result = await swarm.registerMember({ memberId: id, name: id, publicKey: publicKeyB64 });
  if (!("token" in result) || !result.token) throw new Error(`registerMember failed: ${JSON.stringify(result)}`);
  return { id, token: result.token, privateKey };
}

async function session(prefix: string) {
  const subjectId = rid(prefix);
  await swarm.ensureSubject(subjectId, subjectId);
  const opened = await swarm.openSession(subjectId);
  await swarm.publishBrief(opened.id, 60);
  return { subjectId, session: opened, date: opened.date instanceof Date ? opened.date.toISOString().slice(0, 10) : String(opened.date).slice(0, 10) };
}

async function submit(m: Awaited<ReturnType<typeof member>>, date: string, subjectId: string) {
  const payload = { memberId: m.id, date, subjectId, nonce: rid("nonce"), stance: "neutral", confidence: 0.5, body: "signed take" };
  const signature = await signMessage(canonicalizeSubmission(payload), m.privateKey);
  return swarm.submitRecommendation(m.token, { ...payload, signature });
}

const opinion = JSON.stringify({
  rationale: "The takes are coherent enough to publish.",
  disagreements: [],
  release_safety: { release: "safe", concerns: [] },
});
const transport = { model: "test/judge", complete: async () => opinion };

async function aggregated(prefix: string) {
  const s = await session(prefix);
  const voters = [await member("voter_a"), await member("voter_b")];
  for (const voter of voters) expect((await submit(voter, s.date, s.subjectId)).status).toBe(201);
  await swarm.closeWindow(s.session.id);
  await swarm.aggregateSession(s.session.id);
  return s;
}

test("grant/revoke preserves the existing credential and makes judging immediately permitted then refused", async () => {
  const candidate = await member("candidate");
  const before = await session("before");
  expect((await submit(candidate, before.date, before.subjectId)).status).toBe(201);

  const grant = await admin.setMemberRoleAdmin(candidate.id, 1, "judge");
  expect(grant.ok).toBe(true);
  expect((grant as any).member.role).toBe("judge");
  // The token and key were not replaced: the same bearer still identifies this
  // identity, but the standing separation-of-duties gate refuses its take.
  expect(await swarm.memberIdForToken(candidate.token)).toBe(candidate.id);
  const whileJudge = await session("while_judge");
  expect((await submit(candidate, whileJudge.date, whileJudge.subjectId)).error).toBe("judge_role_cannot_submit_takes");

  await setJudgeConfig({ mode: "shadow" });
  const judged = await aggregated("judge_allowed");
  const allowed = await judgeSession(judged.session.id, { judgeMemberId: candidate.id, transport });
  expect(allowed.ok).toBe(true);
  expect((await latestJudgement(judged.session.id) as any).judged_by).toBe(candidate.id);

  // Rotation is still the existing member path, including for a judge: it
  // carries the same public key and returns a new bearer token only once.
  const rotated = await admin.rotateMemberKeyAdmin(candidate.id);
  expect(rotated.ok).toBe(true);
  candidate.token = (rotated as any).token;
  expect(await swarm.memberIdForToken(candidate.token)).toBe(candidate.id);
  const current = (await admin.listMembersAdmin()).find((m) => m.id === candidate.id)!;
  const revoke = await admin.setMemberRoleAdmin(candidate.id, current.version, "member");
  expect(revoke.ok).toBe(true);
  const after = await session("after");
  expect((await submit(candidate, after.date, after.subjectId)).status).toBe(201);
  const refusalSession = await aggregated("after_refusal");
  const refused = await judgeSession(refusalSession.session.id, { judgeMemberId: candidate.id, transport });
  expect(refused).toMatchObject({ ok: false, status: 403, error: "judge_role_required" });
  expect(await latestJudgement(refusalSession.session.id)).toBeNull();
});

test("the in-house worker and a graduated member both leave named judgement parties", async () => {
  await setJudgeConfig({ mode: "shadow" });
  const inHouse = await aggregated("in_house");
  expect((await judgeSession(inHouse.session.id, { transport })).ok).toBe(true);
  expect((await latestJudgement(inHouse.session.id) as any).judged_by).toBe("robotmoney-in-house");

  const candidate = await member("named_judge");
  expect((await admin.setMemberRoleAdmin(candidate.id, 1, "judge")).ok).toBe(true);
  const external = await aggregated("member_judge");
  expect((await judgeSession(external.session.id, { judgeMemberId: candidate.id, transport })).ok).toBe(true);
  const row = await latestJudgement(external.session.id) as any;
  expect(row.judged_by).toBe(candidate.id);
  expect(row.judged_by_member_id).toBe(candidate.id);
});

test("a non-judge is refused before a judgement row is written", async () => {
  await setJudgeConfig({ mode: "shadow" });
  const candidate = await member("ungraduated");
  const s = await aggregated("refusal");
  const refused = await judgeSession(s.session.id, { judgeMemberId: candidate.id, transport });
  expect(refused).toMatchObject({ ok: false, status: 403, error: "judge_role_required" });
  const rows = await sql`SELECT id FROM swarm_session_judgements WHERE session_id = ${s.session.id}`;
  expect(rows).toHaveLength(0);
});
