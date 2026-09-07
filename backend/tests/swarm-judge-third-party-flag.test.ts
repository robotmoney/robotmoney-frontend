// WHAT THIS FILE PROTECTS (issue #796).
//
// #812 gave a graduated member (`swarm_members.role = 'judge'`) an identity
// and a fail-closed authorization seam inside `judgeSession()` — but it left
// that seam permanently open: any active judge-role member could already
// author a judgement, with no admin control over whether THIRD-PARTY judging
// is permitted at all. That is this issue's whole job: a single admin-
// flippable, no-redeploy gate — `swarm_judge_config.third_party_enabled` —
// that refuses every judgeMemberId judgement while off, and leaves the
// built-in worker's judgements (no judgeMemberId) completely unaffected
// either way.
//
// The three promises graded here, each with its own way to break quietly:
//   1. Flag off -> a third-party judgement is refused BEFORE any row lands,
//      with a named reason (`third_party_judging_disabled`), not a generic
//      409 and not a silent skip.
//   2. Flag off -> the in-house worker (no judgeMemberId) is NOT gated by
//      this flag at all — enabling third parties must never become a
//      prerequisite for the in-house rollout stage.
//   3. Flag on -> a third-party judgement proceeds to the #812 checks
//      (role/status/no-take-in-session) exactly as before, and the row it
//      writes still names its judging party.
import { expect, test } from "bun:test";
import { sql } from "../src/db/client.ts";
import * as admin from "../src/swarm/admin.ts";
import * as swarm from "../src/swarm/domain.ts";
import { getJudgeConfig, judgeSession, latestJudgement, setJudgeConfig } from "../src/swarm/judge-session.ts";
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

async function judgeRole(prefix: string) {
  const m = await member(prefix);
  expect((await admin.setMemberRoleAdmin(m.id, 1, "judge")).ok).toBe(true);
  return m;
}

test("shipped default is off, and off refuses a third-party judgement before any row lands", async () => {
  expect((await getJudgeConfig()).thirdPartyEnabled).toBe(false);

  await setJudgeConfig({ mode: "shadow" }); // thirdPartyEnabled left at its default: false
  const judge = await judgeRole("candidate");
  const s = await aggregated("flag_off");

  const result = await judgeSession(s.session.id, { judgeMemberId: judge.id, transport });
  expect(result).toMatchObject({ ok: false, status: 403, error: "third_party_judging_disabled" });

  const rows = await sql`SELECT id FROM swarm_session_judgements WHERE session_id = ${s.session.id}`;
  expect(rows).toHaveLength(0);
  expect(await latestJudgement(s.session.id)).toBeNull();
});

test("the in-house worker succeeds with the flag off — third parties are never a prerequisite for the in-house stage", async () => {
  await setJudgeConfig({ mode: "shadow" });
  expect((await getJudgeConfig()).thirdPartyEnabled).toBe(false);

  const s = await aggregated("in_house_unaffected");
  const result = await judgeSession(s.session.id, { transport }); // no judgeMemberId
  expect(result.ok).toBe(true);
  const row = await latestJudgement(s.session.id) as any;
  expect(row.judged_by).toBe("robotmoney-in-house");
  expect(row.judged_by_member_id).toBeNull();
});

test("turning the flag on permits a graduated judge, and every row still names its judging party", async () => {
  await setJudgeConfig({ mode: "shadow", thirdPartyEnabled: true });
  expect((await getJudgeConfig()).thirdPartyEnabled).toBe(true);

  const judge = await judgeRole("permitted");
  const s = await aggregated("flag_on");
  const result = await judgeSession(s.session.id, { judgeMemberId: judge.id, transport });
  expect(result.ok).toBe(true);

  const row = await latestJudgement(s.session.id) as any;
  expect(row.judged_by).toBe(judge.id);
  expect(row.judged_by_member_id).toBe(judge.id);
});

test("the flag is read fresh inside the write transaction — turning it off after the model call still refuses the row", async () => {
  // Same shape as #812's role-revocation race: the model call happens outside
  // the transaction and can take up to 60s, so an admin flipping the switch
  // mid-flight must be observed before any judgement row can land.
  await setJudgeConfig({ mode: "shadow", thirdPartyEnabled: true });
  const judge = await judgeRole("raced");
  const s = await aggregated("raced_off");

  const slowTransport = {
    model: "test/judge",
    complete: async () => {
      // The flag flips to off while this "model call" is in flight, i.e.
      // before judgeSession()'s write transaction opens.
      await setJudgeConfig({ thirdPartyEnabled: false });
      return opinion;
    },
  };
  const result = await judgeSession(s.session.id, { judgeMemberId: judge.id, transport: slowTransport });
  expect(result).toMatchObject({ ok: false, status: 403, error: "third_party_judging_disabled" });
  expect(await latestJudgement(s.session.id)).toBeNull();
});

test("turning the flag on and off is a database row, audited like mode already is, and needs no redeploy", async () => {
  const on = await admin.setJudgeConfigAdmin({ mode: "shadow", thirdPartyEnabled: true });
  expect(on).toMatchObject({ ok: true, status: 200, judge: { thirdPartyEnabled: true } });

  const off = await admin.setJudgeConfigAdmin({ thirdPartyEnabled: false });
  expect(off).toMatchObject({ ok: true, status: 200, judge: { thirdPartyEnabled: false } });

  const read = await admin.getJudgeConfigAdmin();
  expect(read).toMatchObject({ ok: true, judge: { thirdPartyEnabled: false } });

  const audited = await sql`
    SELECT action, scope FROM audit_log WHERE action = 'judge_config' ORDER BY id DESC LIMIT 2`;
  expect(audited).toHaveLength(2);
  expect((audited[1] as any).scope.thirdPartyEnabled).toBe(true);
  expect((audited[0] as any).scope.thirdPartyEnabled).toBe(false);
});

test("rejects a non-boolean thirdPartyEnabled", async () => {
  await expect(setJudgeConfig({ thirdPartyEnabled: "yes" as any })).rejects.toThrow(/invalid judge thirdPartyEnabled/);
  const bad = await admin.setJudgeConfigAdmin({ thirdPartyEnabled: "yes" as any });
  expect(bad).toMatchObject({ ok: false, status: 400 });
});
