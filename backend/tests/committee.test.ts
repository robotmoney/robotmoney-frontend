import { test, expect, beforeAll } from "bun:test";
import * as ic from "../src/committee/domain.ts";
import { generateKeyPair, signMessage } from "../src/lib/signing.ts";
import { canonicalizeApplication, canonicalizeSubmission, path as routePath, ROUTES } from "@robotmoney/contract";
import { sql } from "../src/db/client.ts";
import { handleCommittee } from "../src/api/routes/committee.ts";

const rid = (p: string) => `${p}_${crypto.randomUUID().slice(0, 8)}`;

// §11 R6 — build a validly-signed apply payload the way an rmpc-equipped agent
// would: generate a keypair, sign the canonical application payload with it.
// The server mints the memberId; the caller never supplies one.
async function signedApply(fields: { name: string; contact: string; lens?: string }) {
  const { publicKeyB64, privateKey } = await generateKeyPair();
  const application = { name: fields.name, contact: fields.contact, lens: fields.lens, publicKey: publicKeyB64 };
  const signature = await signMessage(canonicalizeApplication(application), privateKey);
  return { publicKeyB64, privateKey, signature, body: { ...fields, publicKey: publicKeyB64, signature } };
}

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
  // registerMember returns {ok:false, status, error} (not a token) when the
  // roster cap is hit — fail loudly here instead of returning a bogus member
  // whose id was never actually inserted (a caller then hits a confusing FK
  // violation far away from the real cause).
  if (!("token" in r) || !r.token) {
    throw new Error(`activeMember(): registerMember failed for ${id}: ${JSON.stringify(r)}`);
  }
  return { id, token: r.token, privateKey };
}

test("signed apply mints a server-side UUID; re-applying with the SAME key refreshes the pending record", async () => {
  const first = await signedApply({ name: "A", contact: `${rid("a")}@example.test` });
  const applied1 = await ic.applyMember(first.body as any);
  expect(applied1.status).toBe(201);
  const memberId = (applied1 as any).memberId as string;
  expect(memberId).toMatch(/^[0-9a-f-]{36}$/); // server-minted UUID, not client-supplied

  // Same key, second apply (e.g. resubmitting after a stale prompt) refreshes
  // the SAME pending application rather than forking a new identity. The
  // resubmission must be re-signed — a signature is over the exact bytes
  // submitted, so changing `name` without re-signing must NOT verify.
  const renamedApplication = { name: "A renamed", contact: first.body.contact, publicKey: first.publicKeyB64 };
  const renamedSignature = await signMessage(canonicalizeApplication(renamedApplication), first.privateKey);
  const refreshed = await ic.applyMember({ ...renamedApplication, signature: renamedSignature } as any);
  expect(refreshed.status).toBe(201);
  expect((refreshed as any).memberId).toBe(memberId);
  const row = (await sql`SELECT name FROM committee_members WHERE id = ${memberId}`)[0] as { name: string };
  expect(row.name).toBe("A renamed");

  // Once admitted, the SAME key can never re-apply and overwrite the active
  // member (that's an admin operation — key rotation).
  await ic.activateMember(memberId);
  const afterActivate = await ic.applyMember(first.body as any);
  expect(afterActivate.status).toBe(409);
});

test("POST /api/committee/apply rejects malformed Ed25519 keys and an invalid signature; accepts a validly-signed application", async () => {
  const callApply = async (body: Record<string, unknown>) => {
    const req = new Request("http://test/api/committee/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return handleCommittee(req, new URL(req.url));
  };
  const base = { name: "Route Applicant", contact: "route-applicant@example.test" };
  const bad = await callApply({ ...base, publicKey: Buffer.alloc(31, 1).toString("base64"), signature: "sig" });
  expect(bad?.status).toBe(400);
  expect((bad?.body as { error: string }).error).toBe(
    "publicKey must be canonical base64 for a 32-byte raw Ed25519 public key",
  );

  // A well-formed key with a signature over the WRONG bytes (or from the
  // wrong key) is rejected — nothing is recorded.
  const { publicKeyB64 } = await generateKeyPair();
  const wrongBytesSig = await signMessage("not the canonical payload", (await generateKeyPair()).privateKey);
  const badSig = await callApply({ ...base, publicKey: publicKeyB64, signature: wrongBytesSig });
  expect(badSig?.status).toBe(400);
  // Nothing recorded — no member/key row was ever created for this key.
  expect(await sql`SELECT id FROM committee_member_keys WHERE public_key = ${publicKeyB64}`).toHaveLength(0);

  const good = await signedApply({ name: "Route Applicant", contact: "route-applicant2@example.test" });
  const goodRes = await callApply(good.body);
  expect(goodRes?.status).toBe(201);
  expect((goodRes?.body as { memberId: string }).memberId).toBeString();
});

test("apply → activate approves without minting; re-activate finds no pending key", async () => {
  const { body } = await signedApply({ name: "B", contact: `${rid("b")}@example.test` });
  const applied = await ic.applyMember(body as any);
  const id = (applied as any).memberId as string;
  const act = await ic.activateMember(id);
  expect(act.status).toBe(200);
  expect(act).not.toHaveProperty("token");
  expect((act as any).claimRequired).toBe(true);
  expect((await ic.activateMember(id)).status).toBe(409);
});

test("submit: signature verify/reject, window, duplicate", async () => {
  const subj = rid("s");
  await ic.ensureSubject(subj, "S");
  const date = "2026-06-30";
  const session = await ic.openSession(date, subj);
  await ic.publishBrief(session.id, 60);

  const m = await activeMember();
  const memo = await ic.postMemo(m.token, { sessionId: session.id, title: "Signed memo", body: "memo evidence" });
  if (!("url" in memo)) throw new Error(`memo creation failed: ${JSON.stringify(memo)}`);
  const base = {
    memberId: m.id,
    date,
    subjectId: subj,
    stance: "bullish",
    confidence: 0.9,
    body: "x",
    memoUrl: memo.url,
  };
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
  expect(detail?.takes[0].verified).toBe(true);

  if (!("recommendationId" in ok)) throw new Error(`submission failed: ${JSON.stringify(ok)}`);
  const receiptPath = routePath(ROUTES.committee.take, { id: ok.recommendationId });
  const receiptResult = await handleCommittee(new Request(`http://localhost${receiptPath}`), new URL(`http://localhost${receiptPath}`));
  expect(receiptResult?.status).toBe(200);
  const receipt = receiptResult?.body as any;
  expect(receipt.take.verified).toBe(true);
  expect(receipt.take.body).toBe("x");
  expect(receipt.memo.body).toBe("memo evidence");
  expect(receipt.signer).toEqual(expect.objectContaining({ id: m.id, name: m.id }));
  expect(receipt.signer.publicKeyFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(JSON.stringify(receipt.signer)).not.toContain("publicKeyB64");

  // Required negative control: the stored submit-time flag stays true, but a
  // changed persisted payload must make both public read surfaces report false.
  await sql`UPDATE committee_recommendations
            SET payload = jsonb_set(payload, '{body}', to_jsonb(${"tampered after insert"}::text)),
                verified = true
            WHERE id = ${ok.recommendationId}`;
  const tamperedSessionPath = routePath(ROUTES.committee.session, { date, subject: subj });
  const tamperedSessionResult = await handleCommittee(
    new Request(`http://localhost${tamperedSessionPath}`),
    new URL(`http://localhost${tamperedSessionPath}`),
  );
  expect(tamperedSessionResult?.status).toBe(200);
  const tamperedSession = tamperedSessionResult?.body as any;
  expect(tamperedSession.takes[0].body).toBe("tampered after insert");
  expect(tamperedSession.takes[0].verified).toBe(false);

  const tamperedReceiptResult = await handleCommittee(
    new Request(`http://localhost${receiptPath}`),
    new URL(`http://localhost${receiptPath}`),
  );
  expect((tamperedReceiptResult?.body as any).take.verified).toBe(false);

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

  // Issue #323: the aggregator must not fill these five slots with verbatim
  // take bodies. Cheap check per the issue: rationale !== synthesis, and no
  // consensus entry is anywhere near a full take body's length.
  const takeBodies: string[] = detail!.takes.map((t: any) => t.body ?? "");
  expect(rec.rationale).not.toBe(s.synthesis);
  for (const point of rec.consensus) {
    expect(point.length).toBeLessThan(300);
    expect(takeBodies).not.toContain(point);
  }
  expect(s.synthesis).not.toContain(takeBodies[0]);
  // Disagreement topic names the actual stances in conflict, not the
  // "Submitted views on <subject>" placeholder, and what_settles is a real,
  // non-empty objective test rather than "".
  expect(rec.disagreements[0].topic).not.toMatch(/^Submitted views on/);
  expect(rec.disagreements[0].what_settles).not.toBe("");
  expect(String(rec.disagreements[0].what_settles).length).toBeGreaterThan(0);

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
  // Issue #323: rationale/synthesis must be derived prose, never the
  // concatenated take bodies, and must not equal each other.
  expect(recommendation.rationale).toBeDefined();
  expect(recommendation.rationale).not.toBe(`${fixtures[0].body}\n\n${fixtures[1].body}`);
  expect(recommendation.rationale).not.toContain(fixtures[0].body);
  expect(detail?.session.synthesis).not.toBe(`${fixtures[0].body}\n\n${fixtures[1].body}`);
  expect(detail?.session.synthesis).not.toContain(fixtures[0].body);
  expect(recommendation.rationale).not.toBe(detail?.session.synthesis);
  expect(recommendation.disagreements[0].topic).not.toMatch(/^Submitted views on/);
  expect(recommendation.disagreements[0].what_settles).not.toBe("");
  expect(recommendation.stances.neutral).toBe(1);
  expect(detail?.takes[2].weights).toEqual(fixtures[2].weights);
});

test("aggregation omits invented prose and weights when no eligible body or valid weighted take exists", async () => {
  // Reset first: this file's earlier tests accumulate active members toward
  // COMMITTEE_ROSTER_CAP without deactivating them (see the file header
  // comment), and this test's single activeMember() call must never 409.
  await sql`TRUNCATE committee_members RESTART IDENTITY CASCADE`;
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

test("restart-safety (issue #208): re-opening the same session is idempotent (one row); a duplicate member take is 409 with exactly one recommendation row", async () => {
  // This file's earlier tests accumulate active members toward
  // COMMITTEE_ROSTER_CAP without deactivating them (see the file header
  // comment) — reset so this test's one admission is never a spurious 409.
  await sql`TRUNCATE committee_members RESTART IDENTITY CASCADE`;
  const subj = rid("restart");
  await ic.ensureSubject(subj, "Restart Subject");
  const date = "2026-07-08";

  // A worker restart (or an at-most-once cron retry) may call openSession twice
  // for the same (date, subject_id) — this must never create a second session row.
  const first = await ic.openSession(date, subj);
  const second = await ic.openSession(date, subj);
  expect(second.id).toBe(first.id);
  const sessionRows = await sql`SELECT id FROM committee_sessions WHERE date = ${date} AND subject_id = ${subj}`;
  expect(sessionRows.length).toBe(1);

  await ic.publishBrief(first.id, 60);
  const m = await activeMember();
  const sub = { memberId: m.id, date, subjectId: subj, nonce: rid("n"), stance: "neutral", confidence: 0.5, body: "one take per member" };
  const sign = async (nonce: string) => {
    const s = { ...sub, nonce };
    return { ...s, signature: await signMessage(canonicalizeSubmission(s), m.privateKey) };
  };
  const ok = await ic.submitRecommendation(m.token, await sign(rid("n")));
  expect(ok.status).toBe(201);
  // Same member, same session, a FRESH nonce (a naive retry) → still 409 (the
  // one-take-per-member-per-session unique constraint, not just nonce reuse).
  const dup = await ic.submitRecommendation(m.token, await sign(rid("n")));
  expect(dup.status).toBe(409);
  const recRows = await sql`SELECT id FROM committee_recommendations WHERE session_id = ${first.id} AND member_id = ${m.id}`;
  expect(recRows.length).toBe(1);
});

// ── Issue #243: paginate /api/committee/sessions + drop the member-profile N+1 ─

// Walks every page of GET /api/committee/sessions for the given query,
// following nextCursor until it's null, and returns the union (id -> row).
// Also asserts the core paging invariants along the way: every page obeys the
// requested limit, and no id is EVER repeated across pages (a cursor bug would
// either loop forever — caught by the iteration cap — or skip/duplicate rows).
async function walkSessionsPages(
  query: Record<string, string>,
  limit: number,
  maxPages = 200,
): Promise<Map<string, any>> {
  const byId = new Map<string, any>();
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const qs = new URLSearchParams({ ...query, limit: String(limit), ...(cursor ? { cursor } : {}) });
    const req = new Request(`http://test/api/committee/sessions?${qs}`);
    const res = await handleCommittee(req, new URL(req.url));
    expect(res?.status).toBe(200);
    const body = res!.body as { sessions: any[]; nextCursor: string | null };
    expect(body.sessions.length).toBeLessThanOrEqual(limit);
    for (const s of body.sessions) {
      expect(byId.has(s.id)).toBe(false); // no duplicate across pages
      byId.set(s.id, s);
    }
    if (!body.nextCursor) return byId;
    cursor = body.nextCursor;
  }
  throw new Error(`walkSessionsPages: exceeded ${maxPages} pages — cursor likely never terminates`);
}

test("GET /api/committee/sessions default: light-projected + cursor-paginated (no big fields, no dupes/gaps across pages)", async () => {
  const n = 5;
  const created: { id: string; date: string; subjectId: string }[] = [];
  for (let i = 0; i < n; i++) {
    const subj = rid(`pagsubj${i}`);
    const date = `2031-01-${String(10 + i).padStart(2, "0")}`;
    await ic.ensureSubject(subj, `Pagination Subject ${i}`);
    const row = await ic.openSession(date, subj); // leaves state = 'scheduled'
    created.push({ id: row.id, date, subjectId: subj });
  }

  // The `scheduled` bucket is shared with other test files against the one
  // ephemeral Postgres, so page counts/totals can't be asserted exactly — the
  // invariant that DOES hold regardless of what else is in that bucket: a
  // small-limit multi-page traversal (limit=2) must collect the EXACT same
  // row set as one big-limit traversal (limit=100), proving the cursor
  // neither drops nor duplicates rows as it walks.
  const smallLimitPages = await walkSessionsPages({ state: "scheduled" }, 2);
  const bigLimitPages = await walkSessionsPages({ state: "scheduled" }, 100);
  expect([...smallLimitPages.keys()].sort()).toEqual([...bigLimitPages.keys()].sort());

  for (const c of created) {
    expect(smallLimitPages.has(c.id)).toBe(true);
    const s = smallLimitPages.get(c.id);
    expect(s.state).toBe("scheduled");
    // Light projection: the big fields are absent entirely (not just null).
    expect("regimeSummary" in s).toBe(false);
    expect("synthesis" in s).toBe(false);
    expect("subjectSnapshotTotalValueUsd" in s).toBe(false);
    // Everything a list consumer (committee.js / committee-overview.js) reads is kept.
    expect(s.id).toBe(c.id);
    expect(s.date).toBe(c.date);
    expect(s.subjectId).toBe(c.subjectId);
    expect("committeeRecommendation" in s).toBe(true);
    expect(typeof s.generatedAt).toBe("string");
  }
});

test("GET /api/committee/sessions?full=1 reproduces the pre-#243 unpaginated/unprojected shape; the light default omits its big fields", async () => {
  const subj = rid("fullproj");
  const date = "2031-02-01";
  await ic.ensureSubject(subj, "Full Projection Subject");
  const session = await ic.openSession(date, subj);
  await ic.publishBrief(session.id, 60);
  const m = await activeMember();
  const sub = {
    memberId: m.id, date, subjectId: subj, nonce: rid("n"), stance: "bullish", confidence: 0.6,
    body: "x".repeat(80),
  };
  const signature = await signMessage(canonicalizeSubmission(sub), m.privateKey);
  expect((await ic.submitRecommendation(m.token, { ...sub, signature })).status).toBe(201);
  await ic.closeWindow(session.id);
  await ic.aggregateSession(session.id);
  await ic.publishSession(session.id);

  const fullReq = new Request("http://test/api/committee/sessions?full=1");
  const fullRes = await handleCommittee(fullReq, new URL(fullReq.url));
  expect(fullRes?.status).toBe(200);
  const fullBody = fullRes!.body as { sessions: any[]; nextCursor: string | null };
  expect(fullBody.nextCursor).toBeNull(); // full=1 is never paginated
  const fullItem = fullBody.sessions.find((s: any) => s.id === session.id);
  expect(fullItem).toBeTruthy();
  expect(fullItem.regimeSummary).toBeTruthy();
  expect(typeof fullItem.synthesis).toBe("string");
  expect(fullItem.synthesis.length).toBeGreaterThan(0);

  // The light default (paged through until this session's id is found or the
  // cursor is exhausted) carries the same id/state/committeeRecommendation but
  // no regimeSummary/synthesis key at all.
  let lightItem: any = null;
  let cursor: string | undefined;
  for (let page = 0; page < 50 && !lightItem; page++) {
    const qs = new URLSearchParams({ state: "published", limit: "100", ...(cursor ? { cursor } : {}) });
    const req = new Request(`http://test/api/committee/sessions?${qs}`);
    const res = await handleCommittee(req, new URL(req.url));
    const body = res!.body as { sessions: any[]; nextCursor: string | null };
    lightItem = body.sessions.find((s: any) => s.id === session.id) ?? null;
    if (!body.nextCursor) break;
    cursor = body.nextCursor;
  }
  expect(lightItem).toBeTruthy();
  expect(lightItem.state).toBe("published");
  expect("regimeSummary" in lightItem).toBe(false);
  expect("synthesis" in lightItem).toBe(false);
  expect(lightItem.committeeRecommendation).toBeTruthy();
});

test("GET /api/committee/sessions: malformed cursor and out-of-range limit are 400s (never a 500 or a silent fallback)", async () => {
  const badCursor = Buffer.from("not json", "utf8").toString("base64url");
  const cases = [
    `http://test/api/committee/sessions?cursor=${badCursor}`,
    "http://test/api/committee/sessions?limit=0",
    "http://test/api/committee/sessions?limit=101",
    "http://test/api/committee/sessions?limit=abc",
  ];
  for (const url of cases) {
    const req = new Request(url);
    const res = await handleCommittee(req, new URL(req.url));
    expect(res?.status).toBe(400);
    expect((res!.body as { error?: string }).error).toBeTruthy();
  }
});

test("GET /api/committee/members/:id/takes (#243B): collapses list+N-detail into one call — newest first, in-progress states included, doesn't collide with the plain member-detail route", async () => {
  const subjOlder = rid("takesA");
  const subjNewer = rid("takesB");
  const dateOlder = "2031-03-01";
  const dateNewer = "2031-03-02";
  await ic.ensureSubject(subjOlder, "Takes Subject A");
  await ic.ensureSubject(subjNewer, "Takes Subject B");
  const m = await activeMember();

  const submitOnce = async (date: string, subjectId: string, stance: string) => {
    const session = await ic.openSession(date, subjectId);
    await ic.publishBrief(session.id, 60);
    const sub = { memberId: m.id, date, subjectId, nonce: rid("n"), stance, confidence: 0.5, body: "y".repeat(80) };
    const signature = await signMessage(canonicalizeSubmission(sub), m.privateKey);
    expect((await ic.submitRecommendation(m.token, { ...sub, signature })).status).toBe(201);
    return session;
  };

  // Older session goes all the way to published; newer stays "collecting"
  // (in-progress) — the member-takes endpoint must surface BOTH.
  const olderSession = await submitOnce(dateOlder, subjOlder, "bearish");
  await ic.closeWindow(olderSession.id);
  await ic.aggregateSession(olderSession.id);
  await ic.publishSession(olderSession.id);
  await submitOnce(dateNewer, subjNewer, "bullish"); // left in "collecting"

  // Route disambiguation: the plain member-detail route must still resolve —
  // /members/:id/takes must never be swallowed by /members/:id's `.startsWith`.
  const memberReq = new Request(`http://test${routePath(ROUTES.committee.member, { id: m.id })}`);
  const memberRes = await handleCommittee(memberReq, new URL(memberReq.url));
  expect(memberRes?.status).toBe(200);
  expect((memberRes!.body as { id: string }).id).toBe(m.id);

  const takesReq = new Request(`http://test${routePath(ROUTES.committee.memberTakes, { id: m.id })}?limit=10`);
  const takesRes = await handleCommittee(takesReq, new URL(takesReq.url));
  expect(takesRes?.status).toBe(200);
  const body = takesRes!.body as { takes: any[] };
  const mine = body.takes.filter((t) => [subjOlder, subjNewer].includes(t.subjectId));
  expect(mine.length).toBe(2);

  // Newest session first.
  expect(mine[0].subjectId).toBe(subjNewer);
  expect(mine[0].sessionDate).toBe(dateNewer);
  expect(mine[0].sessionState).toBe("collecting"); // in-progress, included
  expect(mine[0].take.stance).toBe("bullish");
  expect(mine[0].take.verified).toBe(true);
  expect(mine[0].take.memberId).toBe(m.id);

  expect(mine[1].subjectId).toBe(subjOlder);
  expect(mine[1].sessionDate).toBe(dateOlder);
  expect(mine[1].sessionState).toBe("published");
  expect(mine[1].take.stance).toBe("bearish");
  expect(mine[1].take.verified).toBe(true);
});

test("GET /api/committee/members/:id/takes: an unknown/never-submitted member gets an empty list, not an error", async () => {
  const req = new Request(`http://test${routePath(ROUTES.committee.memberTakes, { id: rid("ghost") })}`);
  const res = await handleCommittee(req, new URL(req.url));
  expect(res?.status).toBe(200);
  expect((res!.body as { takes: any[] }).takes).toEqual([]);
});
test("GET /api/committee/members exposes rosterCap, seatsFilled, and seatsAvailable, updating on activate/deactivate", async () => {
  await sql`TRUNCATE committee_members RESTART IDENTITY CASCADE`;

  const getMembersRoute = async () => {
    const req = new Request(`http://test${ROUTES.committee.members}`);
    const res = await handleCommittee(req, new URL(req.url));
    expect(res?.status).toBe(200);
    return res!.body as { members: any[]; rosterCap: number; seatsFilled: number; seatsAvailable: number };
  };

  const initial = await getMembersRoute();
  expect(initial.members).toEqual([]);
  expect(initial.rosterCap).toBe(ic.COMMITTEE_ROSTER_CAP);
  expect(initial.seatsFilled).toBe(0);
  expect(initial.seatsAvailable).toBe(ic.COMMITTEE_ROSTER_CAP);

  // Apply a new applicant (status = 'applied') — should not consume a seat
  const applicant = await signedApply({ name: "Roster Applicant", contact: "roster-applicant@example.test" });
  const appliedRes = await ic.applyMember(applicant.body as any);
  expect(appliedRes.status).toBe(201);
  const memberId = (appliedRes as any).memberId as string;

  const afterApply = await getMembersRoute();
  expect(afterApply.seatsFilled).toBe(0);
  expect(afterApply.seatsAvailable).toBe(ic.COMMITTEE_ROSTER_CAP);

  // Activate the applicant (status = 'active') — consumes 1 seat
  const actRes = await ic.activateMember(memberId);
  expect(actRes.status).toBe(200);

  const afterActivate = await getMembersRoute();
  expect(afterActivate.members.length).toBe(1);
  expect(afterActivate.rosterCap).toBe(ic.COMMITTEE_ROSTER_CAP);
  expect(afterActivate.seatsFilled).toBe(1);
  expect(afterActivate.seatsAvailable).toBe(ic.COMMITTEE_ROSTER_CAP - 1);

  // Deactivate member (status = 'inactive') — frees 1 seat
  await sql`UPDATE committee_members SET status = 'inactive' WHERE id = ${memberId}`;

  const afterDeactivate = await getMembersRoute();
  expect(afterDeactivate.members.length).toBe(0);
  expect(afterDeactivate.seatsFilled).toBe(0);
  expect(afterDeactivate.seatsAvailable).toBe(ic.COMMITTEE_ROSTER_CAP);
});

test("POST /api/committee/signing-payload and submit reject unknown stances and unknown top-level fields with 400 and clear error string", async () => {
  const m = await activeMember();

  // signing-payload with unknown key `summary`
  const reqUnknownKey = new Request(`http://test${ROUTES.committee.signingPayload}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      memberId: m.id, date: "2026-09-25", subjectId: "woon", nonce: "n1",
      summary: "my analysis", stance: "bullish", confidence: 0.7,
    }),
  });
  const resUnknownKey = await handleCommittee(reqUnknownKey, new URL(reqUnknownKey.url));
  expect(resUnknownKey?.status).toBe(400);
  expect((resUnknownKey?.body as { error: string }).error).toBe("unknown field: summary");

  // signing-payload with unknown stance `wildly-bullish`
  const reqUnknownStance = new Request(`http://test${ROUTES.committee.signingPayload}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      memberId: m.id, date: "2026-09-25", subjectId: "woon", nonce: "n1",
      body: "my analysis", stance: "wildly-bullish", confidence: 0.7,
    }),
  });
  const resUnknownStance = await handleCommittee(reqUnknownStance, new URL(reqUnknownStance.url));
  expect(resUnknownStance?.status).toBe(400);
  expect((resUnknownStance?.body as { error: string }).error).toBe(
    "stance must be one of bearish, cautious, neutral, constructive, bullish",
  );

  // submit with unknown key `summary`
  const reqSubmitUnknownKey = new Request(`http://test${ROUTES.committee.submit}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${m.token}`,
    },
    body: JSON.stringify({
      memberId: m.id, date: "2026-09-25", subjectId: "woon", nonce: "n1",
      summary: "my analysis", stance: "bullish", confidence: 0.7, signature: "sig",
    }),
  });
  const resSubmitUnknownKey = await handleCommittee(reqSubmitUnknownKey, new URL(reqSubmitUnknownKey.url));
  expect(resSubmitUnknownKey?.status).toBe(400);
  expect((resSubmitUnknownKey?.body as { error: string }).error).toBe("unknown field: summary");

  // submit with unknown stance `wildly-bullish`
  const reqSubmitUnknownStance = new Request(`http://test${ROUTES.committee.submit}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${m.token}`,
    },
    body: JSON.stringify({
      memberId: m.id, date: "2026-09-25", subjectId: "woon", nonce: "n1",
      body: "my analysis", stance: "wildly-bullish", confidence: 0.7, signature: "sig",
    }),
  });
  const resSubmitUnknownStance = await handleCommittee(reqSubmitUnknownStance, new URL(reqSubmitUnknownStance.url));
  expect(resSubmitUnknownStance?.status).toBe(400);
  expect((resSubmitUnknownStance?.body as { error: string }).error).toBe(
    "stance must be one of bearish, cautious, neutral, constructive, bullish",
  );
});
