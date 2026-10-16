// A judge is not an analyst seat. The host driver opens sessions with no frozen
// roster, so aggregation falls back to the live member list; before this fix it
// counted the judge there, and every production session published the judge as
// absent ("7 of 8 members (88% participation)", 2026-09-25..28).
import { expect, test } from "bun:test";
import { canonicalizeSubmission } from "@robotmoney/contract";
import * as admin from "../src/swarm/admin.ts";
import * as domain from "../src/swarm/domain.ts";
import { generateKeyPair, signMessage } from "../src/lib/signing.ts";
import { useCleanDatabasePerTest } from "./support/clean-db.ts";

useCleanDatabasePerTest(import.meta.file);

const rid = (prefix: string) => `${prefix}_${crypto.randomUUID().slice(0, 8)}`;

async function member(prefix: string) {
  const id = rid(prefix);
  const { publicKeyB64, privateKey } = await generateKeyPair();
  const result = await domain.registerMember({ memberId: id, name: id, publicKey: publicKeyB64 });
  if (!("token" in result) || !result.token) throw new Error(`registerMember failed: ${JSON.stringify(result)}`);
  return { id, token: result.token, privateKey };
}

const memoBody = (subj: string) => [
  "**REGIME**",
  "- Composite 0.544 at the 56th percentile, risk-on by label.",
  "- Three-panel read: macro 74th, on-chain 10th, factor 92nd.",
  "",
  "**ALLOCATION**",
  "- Targets stay 95/5/0/0 across Conservative DeFi Yield / Agent Tokens / Protocol / RWA.",
  "- Fund the 5% Agent Tokens sleeve via rmUSDC before any tilt.",
  "",
  "**SUBJECT**",
  `- ${subj} carries most of its book on a single revenue stream.`,
  "- First move: route the next stable tranche into rmUSDC.",
].join("\n");

test("a session with no frozen roster counts analysts only: the judge is neither active nor absent", async () => {
  const a = await member("analyst_a");
  const b = await member("analyst_b");
  const judge = await member("themis");
  expect((await admin.setMemberRoleAdmin(judge.id, 1, "judge")).ok).toBe(true);

  const subjectId = rid("subject");
  await domain.ensureSubject(subjectId, subjectId);
  const opened = await domain.openSession(subjectId);
  await domain.publishBrief(opened.id, 60);
  const date = opened.date instanceof Date ? opened.date.toISOString().slice(0, 10) : String(opened.date).slice(0, 10);
  for (const m of [a, b]) {
    const payload = { memberId: m.id, date, subjectId, nonce: rid("nonce"), stance: "neutral", confidence: 0.5, body: memoBody(subjectId), weights: ["agent_tokens", "conservative_defi_yield", "protocol_tokens", "real_world_assets"].map((bucket) => ({ bucket, weight: 0.25 })) };
    const signature = await signMessage(canonicalizeSubmission(payload), m.privateKey);
    const r: any = await domain.submitRecommendation(m.token, { ...payload, signature }); expect(r.status).toBe(201);
  }
  await domain.closeWindow(opened.id);
  const rec: any = await domain.aggregateSession(opened.id);
  expect(rec.quorum).toEqual({ active: 2, submitted: 2, absent: 0, participation: 1 });
});
