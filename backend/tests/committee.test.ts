import { test, expect } from "bun:test";
import * as ic from "../src/committee/domain.ts";
import { generateKeyPair, signMessage } from "../src/lib/signing.ts";
import { canonicalizeSubmission } from "@robotmoney/contract";

const rid = (p: string) => `${p}_${crypto.randomUUID().slice(0, 8)}`;

async function activeMember() {
  const id = rid("m");
  const { publicKeyB64, privateKey } = await generateKeyPair();
  const r = await ic.registerMember({ memberId: id, name: id, publicKey: publicKeyB64 });
  return { id, token: r.token, privateKey };
}

test("apply is create-only (existing memberId rejected)", async () => {
  const id = rid("a");
  const { publicKeyB64 } = await generateKeyPair();
  expect((await ic.applyMember({ memberId: id, name: "A", publicKey: publicKeyB64 })).status).toBe(201);
  expect((await ic.applyMember({ memberId: id, name: "A2", publicKey: publicKeyB64 })).status).toBe(409);
});

test("apply → activate mints a usable token; re-activate finds no pending key", async () => {
  const id = rid("b");
  const { publicKeyB64 } = await generateKeyPair();
  await ic.applyMember({ memberId: id, name: "B", publicKey: publicKeyB64 });
  const act = await ic.activateMember(id);
  expect(act.status).toBe(200);
  expect(await ic.memberIdForToken(act.token!)).toBe(id);
  expect((await ic.activateMember(id)).status).toBe(409);
});

test("submit: signature verify/reject, window, duplicate", async () => {
  const subj = rid("s");
  await ic.ensureSubject(subj, "S");
  const date = "2026-06-30";
  const session = await ic.openSession(date, subj);
  await ic.publishBrief(session.id, 60);

  const m = await activeMember();
  const base = { memberId: m.id, date, subjectId: subj, stance: "bullish", confidence: 0.9, body: "x" };
  const signed = async (nonce: string) => {
    const sub = { ...base, nonce };
    return { ...sub, signature: await signMessage(canonicalizeSubmission(sub), m.privateKey) };
  };

  const ok = await ic.submitRecommendation(m.token, await signed("n1"));
  expect(ok.status).toBe(201);
  expect(ok.verified).toBe(true);
  const detail = await ic.getSession(date, subj);
  expect(detail?.session.subjectId).toBe(subj);
  expect(detail?.session).not.toHaveProperty("subject_id");
  expect(detail?.takes[0].memberId).toBe(m.id);
  expect(detail?.takes[0]).not.toHaveProperty("member_id");

  // same member, same session → 409 (one take per member)
  expect((await ic.submitRecommendation(m.token, await signed("n2"))).status).toBe(409);

  // tampered signature → 400 (fresh member to avoid the per-member dup guard)
  const m2 = await activeMember();
  const s2 = { memberId: m2.id, date, subjectId: subj, nonce: "n3", stance: "bullish", confidence: 0.5, body: "y" };
  const wrongSig = await signMessage(canonicalizeSubmission({ ...s2, stance: "bearish" }), m2.privateKey);
  expect((await ic.submitRecommendation(m2.token, { ...s2, signature: wrongSig })).status).toBe(400);

  // window closed → 409
  await ic.closeWindow(session.id);
  const m3 = await activeMember();
  const s3 = { memberId: m3.id, date, subjectId: subj, nonce: "n4", stance: "neutral", confidence: 0.5, body: "z" };
  const sig3 = await signMessage(canonicalizeSubmission(s3), m3.privateKey);
  expect((await ic.submitRecommendation(m3.token, { ...s3, signature: sig3 })).status).toBe(409);
});
