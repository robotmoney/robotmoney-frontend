// A judge is not an analyst seat. The host driver opens sessions with no frozen
// roster, so aggregation falls back to the live member list; before this fix it
// counted the judge there, and every production session published the judge as
// absent ("7 of 8 members (88% participation)", 2026-09-25..28).
import { expect, test } from "bun:test";
import { canonicalizeSubmission } from "@robotmoney/contract";
import * as admin from "../src/swarm/admin.ts";
import * as swarm from "../src/swarm/domain.ts";
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

test("a session with no frozen roster counts analysts only: the judge is neither active nor absent", async () => {
  const a = await member("analyst_a");
  const b = await member("analyst_b");
  const judge = await member("themis");
  expect((await admin.setMemberRoleAdmin(judge.id, 1, "judge")).ok).toBe(true);

  const subjectId = rid("subject");
  await swarm.ensureSubject(subjectId, subjectId);
  const opened = await swarm.openSession(subjectId);
  await swarm.publishBrief(opened.id, 60);
  const date = opened.date instanceof Date ? opened.date.toISOString().slice(0, 10) : String(opened.date).slice(0, 10);
  for (const m of [a, b]) {
    const payload = { memberId: m.id, date, subjectId, nonce: rid("nonce"), stance: "neutral", confidence: 0.5, body: "signed take" };
    const signature = await signMessage(canonicalizeSubmission(payload), m.privateKey);
    expect((await swarm.submitRecommendation(m.token, { ...payload, signature })).status).toBe(201);
  }
  await swarm.closeWindow(opened.id);
  const rec: any = await swarm.aggregateSession(opened.id);
  expect(rec.quorum).toEqual({ active: 2, submitted: 2, absent: 0, participation: 1 });
});
