import { test, expect, beforeAll } from "bun:test";
import * as ic from "../src/committee/domain.ts";
import { generateKeyPair, signMessage } from "../src/lib/signing.ts";
import { applicationProofMessage, canonicalizeSubmission } from "@robotmoney/contract";
import { sql } from "../src/db/client.ts";

const rid = (p: string) => `${p}_${crypto.randomUUID().slice(0, 8)}`;

// All committee test files share ONE ephemeral Postgres (tests/preload.ts). Now
// that COMMITTEE_ROSTER_CAP is hard-enforced on every transition-to-active, a
// roster left full by an earlier-running file would make this file's real
// apply→activate / registerMember admissions 409 ("roster full"). Start from a
// clean roster so this file's ~6 admissions are order-independent and well under
// the cap. (CASCADE also clears member keys / session-member rows.)
beforeAll(async () => {
  await sql`TRUNCATE committee_members RESTART IDENTITY CASCADE`;
});

async function activeMember() {
  const id = rid("m");
  const { publicKeyB64, privateKey } = await generateKeyPair();
  const r = await ic.registerMember({ memberId: id, name: id, publicKey: publicKeyB64 });
  return { id, token: r.token, privateKey };
}

test("apply is create-only (existing memberId rejected)", async () => {
  const id = rid("a");
  const { publicKeyB64, privateKey } = await generateKeyPair();
  const keyProofSignature = await signMessage(applicationProofMessage(id, publicKeyB64), privateKey);
  expect((await ic.applyMember({ memberId: id, name: "A", publicKey: publicKeyB64, keyProofSignature })).status).toBe(201);
  expect((await ic.applyMember({ memberId: id, name: "A2", publicKey: publicKeyB64 })).status).toBe(409);

  const badId = rid("bad-proof");
  const badKeys = await generateKeyPair();
  const badProof = await signMessage(applicationProofMessage("somebody-else", badKeys.publicKeyB64), badKeys.privateKey);
  expect((await ic.applyMember({ memberId: badId, name: "Bad", publicKey: badKeys.publicKeyB64, keyProofSignature: badProof })).status).toBe(400);
  expect(await ic.getMember(badId)).toBeNull();
});

test("apply → approve → signed challenge returns the token only to the member", async () => {
  const id = rid("b");
  const { publicKeyB64, privateKey } = await generateKeyPair();
  const keyProofSignature = await signMessage(applicationProofMessage(id, publicKeyB64), privateKey);
  const applied = await ic.applyMember({
    memberId: id,
    name: "B",
    publicKey: publicKeyB64,
    keyProofSignature,
    operator: "B Labs",
    thesis: "Prefer durable, transparent yield.",
    mandate: "Protect principal first.",
    biases: ["liquidity"],
    wallets: ["0xabc"],
    contact: "b@example.com",
  });
  expect(applied.statusUrl).toBe(`/committee/apply/${id}`);
  const act = await ic.activateMember(id);
  expect(act.status).toBe(200);
  expect(act).not.toHaveProperty("token");
  expect(act.activationEmailQueued).toBe(true);
  expect((await ic.applicationStatus(id))?.claimable).toBe(true);

  const challenge = await ic.createTokenClaimChallenge(id);
  expect(challenge.status).toBe(201);
  const signature = await signMessage(challenge.challenge!, privateKey);
  const claimed = await ic.claimMemberToken(id, challenge.challenge!, signature);
  expect(claimed.status).toBe(200);
  expect(await ic.memberIdForToken(claimed.token!)).toBe(id);
  expect((await ic.applicationStatus(id))?.claimed).toBe(true);
  expect((await ic.claimMemberToken(id, challenge.challenge!, signature)).status).toBe(409);
  expect((await ic.activateMember(id)).status).toBe(409);
});

test("submit: signature verify/reject, window, duplicate", async () => {
  const subj = rid("s");
  await ic.ensureSubject(subj, "S");
  const date = "2026-06-30";
  const m = await activeMember();
  const m2 = await activeMember();
  const m3 = await activeMember();
  const session = await ic.openSession(date, subj);
  await ic.publishBrief(session.id, 60);

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
  const s2 = { memberId: m2.id, date, subjectId: subj, nonce: "n3", stance: "bullish", confidence: 0.5, body: "y" };
  const wrongSig = await signMessage(canonicalizeSubmission({ ...s2, stance: "bearish" }), m2.privateKey);
  expect((await ic.submitRecommendation(m2.token, { ...s2, signature: wrongSig })).status).toBe(400);

  // window closed → 409
  await ic.closeWindow(session.id);
  const s3 = { memberId: m3.id, date, subjectId: subj, nonce: "n4", stance: "neutral", confidence: 0.5, body: "z" };
  const sig3 = await signMessage(canonicalizeSubmission(s3), m3.privateKey);
  expect((await ic.submitRecommendation(m3.token, { ...s3, signature: sig3 })).status).toBe(409);
});

// A representative 3-section memo body (what the MCP agent's buildMemo produces).
const memoBody = (subj: string) => [
  "**REGIME**",
  `- Composite 0.544 at the 56th percentile — risk-on by label, drifting toward neutral.`,
  "- Three-panel read: macro 74th, on-chain 10th, factor 92nd — the spread is the signal.",
  "",
  "**ALLOCATION**",
  "- Targets stay 95/5/0/0 across Conservative DeFi Yield / Agent Tokens / Protocol / RWA.",
  "- Fund the 5% Agent Tokens sleeve via rmUSDC before any tilt.",
  "",
  "**SUBJECT**",
  `- ${subj} carries most of its book on a single revenue stream.`,
  "- First move: route the next stable tranche into rmUSDC to clear the 5% floor.",
].join("\n");

test("full open→brief→submit→aggregate cycle enriches the session (regime_summary, recommendation, synthesis, memo body)", async () => {
  const subj = rid("sub");
  await ic.ensureDemoSubjectFixtures(subj, "Woon Treasury", "2026-07-05");
  const date = "2026-07-05";
  const members = [await activeMember(), await activeMember()];
  const session = await ic.openSession(date, subj);
  await ic.publishBrief(session.id, 60);

  // Two members with DISTINCT stances and allocation proposals so the
  // disagreement is extractive and the recommendation is data-derived.
  const submit = async (m: Awaited<ReturnType<typeof activeMember>>, stance: string, confidence: number, proposedWeights: Record<string, number>) => {
    const sub = { memberId: m.id, date, subjectId: subj, nonce: rid("n"), stance, confidence, body: memoBody(subj), proposedWeights };
    const signature = await signMessage(canonicalizeSubmission(sub), m.privateKey);
    const res = await ic.submitRecommendation(m.token, { ...sub, signature });
    expect(res.status).toBe(201);
    return m.id;
  };
  await submit(members[0], "bullish", 0.8, { conservative_defi_yield: 0.8, agent_tokens: 0.2 });
  await submit(members[1], "cautious", 0.7, { conservative_defi_yield: 1, agent_tokens: 0 });

  await ic.closeWindow(session.id);
  await ic.aggregateSession(session.id);

  const detail = await ic.getSession(date, subj);
  expect(detail).not.toBeNull();
  const s = detail!.session;

  // regime_summary is the reference OBJECT shape with a >= 8-point sparkline history.
  const rs: any = s.regimeSummary;
  expect(rs).toBeTruthy();
  expect(typeof rs.composite).toBe("number");
  expect(Array.isArray(rs.history)).toBe(true);
  expect(rs.history.length).toBeGreaterThanOrEqual(8);
  expect(typeof rs.history[0].composite).toBe("number");
  expect(rs).toHaveProperty("macro_percentile");
  expect(rs).toHaveProperty("onchain_regime");

  // subject snapshot total flowed onto the session.
  expect(s.subjectSnapshotTotalValueUsd).toBeGreaterThan(0);

  // Recommendation keeps the rollup fields AND carries rich reference fields.
  const rec: any = s.committeeRecommendation;
  expect(rec.quorum).toBeTruthy();
  expect(rec.stances).toBeTruthy();
  expect(Array.isArray(rec.consensus)).toBe(true);
  expect(rec.consensus.length).toBeGreaterThan(0);
  expect(Array.isArray(rec.disagreements)).toBe(true);
  expect(rec.disagreements.length).toBeGreaterThanOrEqual(1);
  for (const position of rec.disagreements[0].positions) {
    const take = detail!.takes.find((candidate) => candidate.memberId === position.member_id);
    expect(take?.body).toContain(position.view);
  }
  expect(["position_actions", "bucket_weights"]).toContain(rec.type);
  expect(rec.actions).toBeUndefined();
  expect(rec.weights).toEqual([
    { bucket: "conservative_defi_yield", weight: 0.8933 },
    { bucket: "agent_tokens", weight: 0.1067 },
    { bucket: "protocol_tokens", weight: 0 },
    { bucket: "real_world_assets", weight: 0 },
  ]);
  expect(detail!.takes[0].proposedWeights).toBeTruthy();

  // Synthesis is prose, not a one-liner rollup.
  expect(typeof s.synthesis).toBe("string");
  expect(s.synthesis!.length).toBeGreaterThan(60);

  // A submitted take body carries all three memo section headers.
  const body = detail!.takes[0].body ?? "";
  expect(body).toContain("**REGIME**");
  expect(body).toContain("**ALLOCATION**");
  expect(body).toContain("**SUBJECT**");
});
