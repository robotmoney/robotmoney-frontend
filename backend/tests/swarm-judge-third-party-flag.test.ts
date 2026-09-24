// WHAT THIS FILE PROTECTS (issue #796, re-keyed by D52).
//
// smoke-production-spec.md §6.2, "Third-party gate": "A judgement from a judge
// whose member `operator` is `robotmoney` is in-house and is accepted whatever
// `swarm_judge_config.third_party_enabled` says. A judgement from any other
// judge is refused while that flag is false." D52's defaults say the same.
//
// THE GATE LIVES WHERE JUDGEMENTS ENTER: `submitJudgement` (domain.ts), the
// participant route's one entry point. The inline `judgeSession()` this file
// used to drive is deleted (D53 point 4), and so is its in-house worker path
// with no judge member at all — every judgement now comes from a seated judge
// signing its own submission.
//
// KEYED ON OPERATOR, AND THE #925 FORGERY STAYS CLOSED. `operator` is a
// profile column, and #925 showed a member writing `robotmoney` into its own
// row to pass as in-house. Keying the gate on `handle` instead was the old
// answer; D52 keys it on `operator`, which is only sound because no non-admin
// writer may set that literal. That reservation is asserted here at the
// writer (`updateMemberProfile`), not merely at the route's validator.
//
// The promises graded, each with its own way to break quietly:
//   1. Flag off → a third-party judgement is refused BEFORE any row lands,
//      with a named reason, not a generic 409 and not a silent skip.
//   2. Flag off → the in-house judge (operator `robotmoney`) is accepted.
//   3. Flag on → the third-party judge is accepted and its row names it.
//   4. The flag is read inside the write transaction.
//   5. A member cannot make itself in-house through self-service.
import { expect, test } from "bun:test";
import { sql } from "../src/db/client.ts";
import * as admin from "../src/swarm/admin.ts";
import * as ic from "../src/swarm/domain.ts";
import { getJudgeConfig, setJudgeConfig } from "../src/swarm/judge-config.ts";
import { canonicalizeSubmission } from "@robotmoney/contract";
import { generateKeyPair, signMessage } from "../src/lib/signing.ts";
import { useCleanDatabasePerTest } from "./support/clean-db.ts";
import { ensureProseSubject } from "./support/prose-subject.ts";
import { requestJudgingFor, seatJudge, signedJudgement, STUB_JUDGE_MODEL, STUB_JUDGE_REPLY } from "./support/stub-judge.ts";

useCleanDatabasePerTest(import.meta.file);

const rid = (prefix: string) => `${prefix}_${crypto.randomUUID().slice(0, 8)}`;

async function member(prefix: string) {
  const id = rid(prefix);
  const { publicKeyB64, privateKey } = await generateKeyPair();
  const result = await ic.registerMember({ memberId: id, name: id, publicKey: publicKeyB64 });
  if (!("token" in result) || !result.token) throw new Error(`registerMember failed: ${JSON.stringify(result)}`);
  return { id, token: result.token, privateKey };
}

async function submit(m: Awaited<ReturnType<typeof member>>, date: string, subjectId: string) {
  const payload = { memberId: m.id, date, subjectId, nonce: rid("nonce"), stance: "neutral", confidence: 0.5, body: "signed take" };
  const signature = await signMessage(canonicalizeSubmission(payload), m.privateKey);
  return ic.submitRecommendation(m.token, { ...payload, signature });
}

/** An aggregated session in `judging`, two signed takes on file. */
async function judging(prefix: string) {
  const subjectId = rid(prefix);
  await ensureProseSubject(subjectId, subjectId);
  const opened = await ic.openSession(subjectId);
  await ic.publishBrief(opened.id, 60);
  const date = opened.date instanceof Date ? opened.date.toISOString().slice(0, 10) : String(opened.date).slice(0, 10);
  for (const voter of [await member("voter_a"), await member("voter_b")]) {
    expect((await submit(voter, date, subjectId)).status).toBe(201);
  }
  await ic.closeWindow(opened.id);
  await ic.aggregateSession(opened.id);
  await requestJudgingFor(opened.id);
  return opened.id as string;
}

const judgementRows = async (sessionId: string) =>
  (await sql`SELECT judged_by, judged_by_member_id FROM swarm_session_judgements WHERE session_id = ${sessionId}`) as any[];

test("shipped default is off, and off refuses a third-party judgement before any row lands", async () => {
  expect((await getJudgeConfig()).thirdPartyEnabled).toBe(false);
  const thirdParty = await seatJudge({ prefix: "candidate", operator: "peaq" });
  const sessionId = await judging("flag_off");

  const result = await ic.submitJudgement(thirdParty.token, await signedJudgement(thirdParty, sessionId));
  expect(result).toEqual({ ok: false, status: 403, error: "third_party_judging_disabled" });
  expect(await judgementRows(sessionId)).toHaveLength(0);
  expect(((await sql`SELECT state FROM swarm_sessions WHERE id = ${sessionId}`)[0] as any).state).toBe("judging");
});

test("a judge with NO operator is third-party too — only the in-house literal is exempt", async () => {
  const anonymous = await seatJudge({ prefix: "anonymous", operator: null });
  const sessionId = await judging("flag_off_null_operator");
  const result = await ic.submitJudgement(anonymous.token, await signedJudgement(anonymous, sessionId));
  expect(result).toEqual({ ok: false, status: 403, error: "third_party_judging_disabled" });
  expect(await judgementRows(sessionId)).toHaveLength(0);
});

test("the in-house judge (operator 'robotmoney') is accepted with the flag off — third parties are never a prerequisite", async () => {
  expect((await getJudgeConfig()).thirdPartyEnabled).toBe(false);
  const inHouse = await seatJudge({ prefix: "themis", operator: "robotmoney" });
  const sessionId = await judging("in_house_flag_off");

  const result = await ic.submitJudgement(inHouse.token, await signedJudgement(inHouse, sessionId));
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) return;
  expect(result.judgeOfRecord).toBe(true);
  expect(result.state).toBe("judged");
  expect(await judgementRows(sessionId)).toEqual([{ judged_by: inHouse.id, judged_by_member_id: inHouse.id }]);
});

test("while the flag is off a third-party judge is not the judge of record, even with the lowest member id", async () => {
  // Scheduler spec §4.4: the judge of record is chosen by member id among the
  // ELIGIBLE judges, and "it passes the third-party gate" is part of eligible.
  // A third-party judge sorting first must not displace the in-house one.
  const thirdParty = await seatJudge({ prefix: "aaa_third_party", operator: "peaq" });
  const inHouse = await seatJudge({ prefix: "zzz_in_house", operator: "robotmoney" });
  const sessionId = await judging("of_record_gate");
  expect((await ic.submitJudgement(thirdParty.token, await signedJudgement(thirdParty, sessionId))).ok).toBe(false);
  const result = await ic.submitJudgement(inHouse.token, await signedJudgement(inHouse, sessionId));
  expect(result).toMatchObject({ ok: true, judgeOfRecord: true, state: "judged" });
});

test("turning the flag on permits a third-party judge, and its row names it", async () => {
  await setJudgeConfig({ thirdPartyEnabled: true });
  expect((await getJudgeConfig()).thirdPartyEnabled).toBe(true);
  const thirdParty = await seatJudge({ prefix: "permitted", operator: "peaq" });
  const sessionId = await judging("flag_on");

  const result = await ic.submitJudgement(thirdParty.token, await signedJudgement(thirdParty, sessionId));
  expect(result.ok, JSON.stringify(result)).toBe(true);
  expect(await judgementRows(sessionId)).toEqual([{ judged_by: thirdParty.id, judged_by_member_id: thirdParty.id }]);
});

test("the flag is read inside the write transaction — turning it off after the model answered still refuses the row", async () => {
  // The model call happens in the judge's own container and can take minutes.
  // An admin flipping the switch in that window must be observed at
  // submission: the judgement below was signed while the flag was ON.
  await setJudgeConfig({ thirdPartyEnabled: true });
  const thirdParty = await seatJudge({ prefix: "raced", operator: "peaq" });
  const sessionId = await judging("raced_off");
  const signedWhileOn = await signedJudgement(thirdParty, sessionId, STUB_JUDGE_REPLY);

  await setJudgeConfig({ thirdPartyEnabled: false });
  const result = await ic.submitJudgement(thirdParty.token, signedWhileOn);
  expect(result).toEqual({ ok: false, status: 403, error: "third_party_judging_disabled" });
  expect(await judgementRows(sessionId)).toHaveLength(0);
});

// Issue #925: the forgery the gate must not reopen. Keyed on `operator`, the
// gate is only as good as the rule that no non-admin writer can set it.
test("a member cannot make itself in-house: self-service refuses the reserved operator at the writer", async () => {
  const forger = await seatJudge({ prefix: "forger", operator: "peaq" });
  for (const spelling of ["robotmoney", "RobotMoney", " robotmoney "]) {
    const patched = await ic.updateMemberProfile(forger.token, forger.id, { operator: spelling });
    expect({ spelling, status: patched.status, ok: patched.ok }).toEqual({ spelling, status: 403, ok: false });
  }
  expect(((await sql`SELECT operator FROM swarm_members WHERE id = ${forger.id}`)[0] as any).operator).toBe("peaq");

  // …so the forger is still third-party, and still refused.
  const sessionId = await judging("forged_operator");
  const result = await ic.submitJudgement(forger.token, await signedJudgement(forger, sessionId));
  expect(result).toEqual({ ok: false, status: 403, error: "third_party_judging_disabled" });
  expect(await judgementRows(sessionId)).toHaveLength(0);

  // An ordinary operator string still goes through — the reservation is of one
  // literal, not of the field.
  expect((await ic.updateMemberProfile(forger.token, forger.id, { operator: "self" })).status).toBe(200);
});

test("the route's validator refuses the reserved operator too", async () => {
  // The self-service route and the domain writer agree; the domain rule above
  // is the one that holds for any future caller.
  const { validateMemberProfile } = await import("../src/api/validation.ts");
  const parsed = validateMemberProfile({ operator: "robotmoney" } as any);
  expect(parsed.ok).toBe(false);
});

test("turning the flag on and off is a database row, audited like mode already is, and needs no redeploy", async () => {
  const on = await admin.setJudgeConfigAdmin({ mode: "enforce", thirdPartyEnabled: true, model: STUB_JUDGE_MODEL });
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
