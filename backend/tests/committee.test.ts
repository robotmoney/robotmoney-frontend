import { test, expect, beforeAll } from "bun:test";
import * as ic from "../src/committee/domain.ts";
import { generateKeyPair, signMessage } from "../src/lib/signing.ts";
import { canonicalizeSubmission } from "@robotmoney/contract";
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
  const session = await ic.openSession(date, subj);
  const publishedBrief = await ic.publishBrief(session.id, 60);
  const brief = await ic.getBrief(date, subj);
  expect(brief?.body?.prompt.system).toContain("Author only your own analysis");
  expect(brief?.body?.prompt.user).toContain("Woon Treasury");
  expect(brief?.body?.takeSchema.stance.enum).toEqual(["bearish", "cautious", "neutral", "constructive", "bullish"]);
  expect(brief?.body?.takeSchema.confidence).toEqual({ type: "number", minimum: 0, maximum: 1 });
  expect(brief?.body?.takeSchema.body).toEqual({ type: "string" });
  expect(brief?.body?.takeSchema.weights.optional).toBe(true);
  expect(brief?.body?.windowClosesAt).toBe(publishedBrief.windowClosesAt);
  expect(brief?.body?.windowClosesAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  expect(new Date(brief!.body!.windowClosesAt).toISOString()).toBe(brief?.body?.windowClosesAt);

  // Two members with DISTINCT stances so a disagreement is synthesized.
  const submit = async (stance: string, confidence: number) => {
    const m = await activeMember();
    const sub = {
      memberId: m.id,
      date,
      subjectId: subj,
      nonce: rid("n"),
      stance,
      confidence,
      body: memoBody(subj),
      weights: [{ bucket: "must_not_aggregate_for_position_actions", weight: 1 }],
    };
    const signature = await signMessage(canonicalizeSubmission(sub), m.privateKey);
    const res = await ic.submitRecommendation(m.token, { ...sub, signature });
    expect(res.status).toBe(201);
    return m.id;
  };
  await submit("bullish", 0.8);
  await submit("cautious", 0.7);

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
  expect(rec.disagreements[0]).toHaveProperty("what_settles");
  expect(["position_actions", "bucket_weights"]).toContain(rec.type);
  expect(rec.type).toBe("position_actions");
  expect(rec.weights).toBeUndefined();

  // Synthesis is prose, not a one-liner rollup.
  expect(typeof s.synthesis).toBe("string");
  expect(s.synthesis!.length).toBeGreaterThan(60);

  // A submitted take body carries all three memo section headers.
  const body = detail!.takes[0].body ?? "";
  expect(body).toContain("**REGIME**");
  expect(body).toContain("**ALLOCATION**");
  expect(body).toContain("**SUBJECT**");
});

test("bucket aggregation computes the normalized unweighted mean and attributes only stored non-empty bodies", async () => {
  const subjectId = rid("weighted");
  const date = "2026-07-06";
  await ic.ensureSubject(subjectId, "Weighted Subject");
  const members = await Promise.all([activeMember(), activeMember(), activeMember()]);
  const session = await ic.openSession(date, subjectId);
  for (const member of members) {
    await sql`INSERT INTO committee_session_members (session_id, member_id, member_name, status)
              VALUES (${session.id}, ${member.id}, ${member.id}, 'expected')`;
  }
  await ic.publishBrief(session.id, 60);

  const fixtures = [
    {
      stance: "bullish",
      confidence: 0.9,
      body: "Member one supports the submitted allocation because liquidity is observable.",
      weights: [{ bucket: "alpha", weight: 2 }, { bucket: "beta", weight: 1 }],
    },
    {
      stance: "cautious",
      confidence: 0.6,
      body: "Member two prefers a larger beta sleeve until volatility settles.",
      weights: [{ bucket: "alpha", weight: 1 }, { bucket: "beta", weight: 3 }, { bucket: "gamma", weight: 1 }],
    },
    {
      stance: "neutral",
      confidence: 0.3,
      body: "",
      weights: [{ bucket: "beta", weight: 1 }, { bucket: "gamma", weight: 1 }],
    },
  ];
  for (let index = 0; index < fixtures.length; index++) {
    const submission = {
      memberId: members[index].id,
      date,
      subjectId,
      nonce: rid("weight_nonce"),
      ...fixtures[index],
    };
    const signature = await signMessage(canonicalizeSubmission(submission), members[index].privateKey);
    expect((await ic.submitRecommendation(members[index].token, { ...submission, signature })).status).toBe(201);
  }

  await ic.closeWindow(session.id);
  await ic.aggregateSession(session.id);
  const detail = await ic.getSession(date, subjectId);
  const recommendation: any = detail?.session.committeeRecommendation;

  const bucketNames = [...new Set(fixtures.flatMap((fixture) => fixture.weights.map((entry) => entry.bucket)))].sort();
  const expected = bucketNames.map((bucket) => {
    const mean = fixtures.reduce((sum, fixture) => {
      const total = fixture.weights.reduce((inner, entry) => inner + entry.weight, 0);
      return sum + (fixture.weights.find((entry) => entry.bucket === bucket)?.weight ?? 0) / total;
    }, 0) / fixtures.length;
    return { bucket, weight: mean };
  });
  const expectedTotal = expected.reduce((sum, entry) => sum + entry.weight, 0);
  const expectedRounded = expected.map((entry) => ({ ...entry, weight: Math.round((entry.weight / expectedTotal) * 1e8) / 1e8 }));
  expectedRounded[expectedRounded.length - 1].weight = Math.round((1 - expectedRounded.slice(0, -1).reduce((sum, entry) => sum + entry.weight, 0)) * 1e8) / 1e8;

  expect(recommendation.weights).toEqual(expectedRounded);
  expect(recommendation.weights).not.toEqual([
    { bucket: "conservative_defi_yield", weight: 0.95 },
    { bucket: "agent_tokens", weight: 0.05 },
    { bucket: "protocol_tokens", weight: 0 },
    { bucket: "real_world_assets", weight: 0 },
  ]);
  const storedBodyByMember = new Map(detail!.takes.map((take) => [take.memberId, take.body ?? ""]));
  for (const disagreement of recommendation.disagreements) {
    for (const position of disagreement.positions) {
      expect(storedBodyByMember.get(position.member_id)).toContain(position.view);
      expect(position.member_id).not.toBe(members[2].id);
    }
  }
  expect(recommendation.rationale).toBe(`${fixtures[0].body}\n\n${fixtures[1].body}`);
  expect(detail?.session.synthesis).toBe(`${fixtures[0].body}\n\n${fixtures[1].body}`);
  expect(recommendation.stances.neutral).toBe(1);
  expect(detail?.takes[2].weights).toEqual(fixtures[2].weights);
});

test("aggregation omits invented prose and weights when no eligible body or valid weighted take exists", async () => {
  const subjectId = rid("empty");
  const date = "2026-07-07";
  await ic.ensureSubject(subjectId, "Empty Body Subject");
  const member = await activeMember();
  const session = await ic.openSession(date, subjectId);
  await sql`INSERT INTO committee_session_members (session_id, member_id, member_name, status)
            VALUES (${session.id}, ${member.id}, ${member.id}, 'expected')`;
  await ic.publishBrief(session.id, 60);
  const submission = { memberId: member.id, date, subjectId, nonce: rid("empty_nonce"), stance: "neutral", confidence: 0.5, body: "" };
  const signature = await signMessage(canonicalizeSubmission(submission), member.privateKey);
  expect((await ic.submitRecommendation(member.token, { ...submission, signature })).status).toBe(201);
  await ic.closeWindow(session.id);
  await ic.aggregateSession(session.id);

  const detail = await ic.getSession(date, subjectId);
  const recommendation: any = detail?.session.committeeRecommendation;
  expect(recommendation.weights).toBeUndefined();
  expect(recommendation.disagreements).toEqual([]);
  expect(recommendation.rationale).toBeUndefined();
  expect(recommendation.stances).toEqual({ neutral: 1 });
  expect(detail?.session.synthesis).toBeNull();
});
