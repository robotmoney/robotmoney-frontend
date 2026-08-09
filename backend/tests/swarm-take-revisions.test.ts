// A member can amend and resubmit its take (issue #573, ADR D32).
//
// WHAT THIS FILE PROTECTS. Migration 0028 relaxes `UNIQUE (session_id,
// member_id)` — until now the ONLY server-side bound on a member's write
// volume, and the schema fact three read paths and one frontend `x-for` key
// silently depended on. Every assertion below is aimed at one of the things
// that constraint was quietly doing for us:
//
//   1. Append, never edit. A superseded row's bytes, signature and filing time
//      are unchanged after the amendment — the property the whole signature
//      apparatus exists to provide, and the one an in-place UPDATE would have
//      destroyed.
//   2. Latest-per-member on every read that means "the session's takes".
//   3. Participation and quorum from DISTINCT MEMBERS, not `takes.length`.
//      Unfixed this publishes participation above 100%.
//   4. Every revision verifies INDEPENDENTLY, superseded ones included. A
//      revision rendering as a tamper is a bug; `toVerifiedTake` re-verifies at
//      read time against the member's active key, so this is not free.
//   5. A superseded permalink resolves, still shows the bytes that were signed,
//      and points forward. It must not 404 and must not substitute content.
//   6. The cap caps, AND the refusal lands BEFORE the Ed25519 verify. The
//      ordering is the requirement, not an optimisation — see the ordering test
//      for how it is proved behaviourally rather than by reading a comment.
import { test, expect, beforeEach } from "bun:test";
import * as ic from "../src/swarm/domain.ts";
import { generateKeyPair, signMessage } from "../src/lib/signing.ts";
import { canonicalizeSubmission, SWARM_TAKE_REVISION_CAP, path as routePath, ROUTES } from "@robotmoney/contract";
import { sql } from "../src/db/client.ts";
import { handleSwarm } from "../src/api/routes/swarm.ts";

const rid = (p: string) => `${p}_${crypto.randomUUID().slice(0, 8)}`;

// The DATABASE dates a session (migration 0022). Tests read it, never choose it.
const sessionDate = (s: Record<string, unknown>): string =>
  s.date instanceof Date ? s.date.toISOString().slice(0, 10) : String(s.date).slice(0, 10);

// Every swarm test file shares ONE ephemeral Postgres (tests/preload.ts), and
// SWARM_ROSTER_CAP is hard-enforced on every transition-to-active. This file
// seats ~13 members across its tests, so a beforeAll reset would run it into
// the cap partway through and turn real assertions into spurious "roster full"
// failures. Reset per test instead: no test here reads another's rows, and the
// CASCADE also clears member keys, takes and agent-health events, which is what
// makes the health-event counters below unambiguous.
beforeEach(async () => {
  await sql`TRUNCATE swarm_members RESTART IDENTITY CASCADE`;
});

async function activeMember() {
  const id = rid("m");
  const { publicKeyB64, privateKey } = await generateKeyPair();
  const r = await ic.registerMember({ memberId: id, name: id, publicKey: publicKeyB64 });
  if (!("token" in r) || !r.token) {
    throw new Error(`activeMember(): registerMember failed for ${id}: ${JSON.stringify(r)}`);
  }
  return { id, token: r.token, privateKey };
}

type Member = Awaited<ReturnType<typeof activeMember>>;

/**
 * Submit as a member would: mint a FRESH nonce and sign the canonical payload
 * with the member's own key. This is the whole amendment protocol — there is no
 * new endpoint and no new field, which is the point of ADR D32's "no protocol
 * change, no rmpc rebuild".
 */
async function submit(
  m: Member,
  date: string,
  subjectId: string,
  overrides: Partial<{ stance: string; confidence: number; body: string; nonce: string }> = {},
) {
  const sub = {
    memberId: m.id,
    date,
    subjectId,
    nonce: overrides.nonce ?? rid("n"),
    stance: overrides.stance ?? "neutral",
    confidence: overrides.confidence ?? 0.5,
    body: overrides.body ?? "a take",
  };
  const signature = await signMessage(canonicalizeSubmission(sub), m.privateKey);
  return ic.submitRecommendation(m.token, { ...sub, signature });
}

/** Submit with a signature over DIFFERENT bytes than the ones sent — a forgery. */
async function submitWithBadSignature(
  m: Member,
  date: string,
  subjectId: string,
  overrides: Partial<{ body: string }> = {},
) {
  const sub = {
    memberId: m.id,
    date,
    subjectId,
    nonce: rid("bad"),
    stance: "neutral",
    confidence: 0.5,
    body: overrides.body ?? "forged",
  };
  // Signed over a body that is NOT the one submitted: verifySubmissionSignature
  // must reject this, and recordAgentHealthEvent('rejected_signature') is the
  // observable side effect of it having done so.
  const signature = await signMessage(canonicalizeSubmission({ ...sub, body: `${sub.body} (other bytes)` }), m.privateKey);
  return ic.submitRecommendation(m.token, { ...sub, signature });
}

async function openCollectingSession(prefix: string) {
  const subj = rid(prefix);
  await ic.ensureSubject(subj, `${prefix} subject`);
  const s = await ic.openSession(subj);
  await ic.publishBrief(s.id, 60);
  return { subj, session: s, date: sessionDate(s) };
}

const takeReceipt = async (id: string) => {
  const p = routePath(ROUTES.swarm.take, { id });
  return handleSwarm(new Request(`http://localhost${p}`), new URL(`http://localhost${p}`));
};

const rows = (sessionId: string, memberId: string) => sql<
  { id: string; revision: number; body: string; signature: string; payload: any; received_at: Date }[]
>`SELECT id, revision, body, signature, payload, received_at FROM swarm_recommendations
  WHERE session_id = ${sessionId} AND member_id = ${memberId} ORDER BY revision`;

// ── 1. The model: append, never edit ────────────────────────────────────────

test("amendment inside the window is ACCEPTED, becomes the latest, and APPENDS — the superseded row is byte-for-byte untouched", async () => {
  const { subj, session, date } = await openCollectingSession("amend");
  const m = await activeMember();

  const first = await submit(m, date, subj, { stance: "cautious", confidence: 0.3, body: "the original read" });
  expect(first.status).toBe(201);
  expect((first as { revision?: number }).revision).toBe(1);

  const before = (await rows(session.id, m.id))[0]!;

  const second = await submit(m, date, subj, { stance: "bullish", confidence: 0.9, body: "a filing landed; revised" });
  expect(second.status).toBe(201);
  expect((second as { revision?: number }).revision).toBe(2);

  // TWO ROWS, and the FIRST one is exactly as it was. This is the assertion
  // that separates this model from in-place UPDATE: if a single character of
  // the superseded row's body, payload, signature or filing time moved, the
  // permalink already shared as proof of participation would be attesting
  // something other than what it attested yesterday.
  const after = await rows(session.id, m.id);
  expect(after).toHaveLength(2);
  expect(after[0]!.id).toBe(before.id);
  expect(after[0]!.revision).toBe(1);
  expect(after[0]!.body).toBe("the original read");
  expect(after[0]!.signature).toBe(before.signature);
  expect(JSON.stringify(after[0]!.payload)).toBe(JSON.stringify(before.payload));
  expect(new Date(after[0]!.received_at).getTime()).toBe(new Date(before.received_at).getTime());
  expect(after[1]!.revision).toBe(2);
  expect(after[1]!.id).not.toBe(before.id);

  // The session read resolves to ONE take for this member — the latest.
  const detail = await ic.getSession(date, subj);
  const mine = detail!.takes.filter((t) => t.memberId === m.id);
  expect(mine).toHaveLength(1);
  expect(mine[0]!.body).toBe("a filing landed; revised");
  expect(mine[0]!.stance).toBe("bullish");
  expect(mine[0]!.revision).toBe(2);

  // ...and so does the member's own record page (getMemberTakes), which is a
  // per-SESSION collapse rather than a per-member one and so is a genuinely
  // separate code path.
  const record = await ic.getMemberTakes(m.id, 10);
  const forThisSession = record.takes.filter((t) => t.subjectId === subj);
  expect(forThisSession).toHaveLength(1);
  expect(forThisSession[0]!.take.body).toBe("a filing landed; revised");
  expect(forThisSession[0]!.take.revision).toBe(2);
});

test("EVERY revision verifies independently — including the superseded one, which must never render as a tamper", async () => {
  const { subj, session, date } = await openCollectingSession("verify");
  const m = await activeMember();
  await submit(m, date, subj, { body: "revision one body" });
  await submit(m, date, subj, { body: "revision two body" });
  await submit(m, date, subj, { body: "revision three body" });

  const all = await rows(session.id, m.id);
  expect(all).toHaveLength(3);

  // toVerifiedTake IGNORES the stored `verified` flag and re-verifies the
  // signature against the payload and the member's ACTIVE key on every read.
  // Each revision signs its own bytes with its own fresh nonce, so each must
  // check out on its own — a superseded revision is still a valid signed
  // artifact, and rendering it as `verified: false` would accuse the member of
  // forgery for the act of changing its mind.
  for (const row of all) {
    const res = await takeReceipt(row.id);
    expect(res?.status).toBe(200);
    const receipt = res?.body as any;
    expect(receipt.take.verified).toBe(true);
    expect(receipt.take.body).toBe(row.body);
    expect(receipt.take.revision).toBe(row.revision);
    expect(receipt.signer.publicKeyFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
  }
});

test("a superseded permalink keeps RESOLVING, keeps showing the bytes that were signed, and points forward", async () => {
  const { subj, session, date } = await openCollectingSession("perma");
  const m = await activeMember();
  await submit(m, date, subj, { body: "first word" });
  await submit(m, date, subj, { body: "second word" });
  const [r1, r2] = await rows(session.id, m.id);

  const superseded = (await takeReceipt(r1!.id))?.body as any;
  // NOT a 404 (asserted by the 200 in the loop above and again here) and NOT a
  // silent substitution: the URL still serves revision 1's prose.
  expect(superseded.take.body).toBe("first word");
  expect(superseded.take.revision).toBe(1);
  expect(superseded.supersededBy).toEqual({
    id: r2!.id,
    revision: 2,
    receivedAt: expect.any(String),
  });

  // The current revision says it is current.
  const current = (await takeReceipt(r2!.id))?.body as any;
  expect(current.take.body).toBe("second word");
  expect(current.supersededBy).toBeNull();

  // A third revision moves revision 1's forward pointer to the NEWEST one, not
  // to the next one — a reader following the link lands on what the member
  // currently says, in one hop.
  await submit(m, date, subj, { body: "third word" });
  const r3 = (await rows(session.id, m.id))[2]!;
  const stillSuperseded = (await takeReceipt(r1!.id))?.body as any;
  expect(stillSuperseded.take.body).toBe("first word");
  expect(stillSuperseded.supersededBy.id).toBe(r3.id);
  expect(stillSuperseded.supersededBy.revision).toBe(3);
});

// ── 2. The window ───────────────────────────────────────────────────────────

test("amendment OUTSIDE the window is refused — both after the advertised deadline and after aggregation", async () => {
  // (a) The advertised deadline has passed. Rewriting the stored deadline is
  // the suite's only honest lever: it is compared against Postgres now(), so no
  // fake clock can move it.
  const a = await openCollectingSession("late-amend");
  const ma = await activeMember();
  expect((await submit(ma, a.date, a.subj, { body: "in time" })).status).toBe(201);
  await sql`UPDATE swarm_sessions SET window_closes_at = now() - interval '1 second' WHERE id = ${a.session.id}`;
  const late = await submit(ma, a.date, a.subj, { body: "too late" });
  expect(late.status).toBe(409);
  expect((late as { error: string }).error).toBe("submission window closed");
  expect(await rows(a.session.id, ma.id)).toHaveLength(1);

  // (b) The session has been AGGREGATED. This is the case the advertised
  // deadline does not cover, because closeWindow may run before it: #570
  // deliberately keeps a FIRST take acceptable right up to the advertised
  // instant even after an early close, so the deadline alone cannot protect the
  // snapshot. aggregateSession copies take prose VERBATIM into
  // swarm_recommendation.disagreements[].positions[].view and is never
  // recomputed, so an amendment landing here would leave a published session
  // quoting a body the member has withdrawn.
  const b = await openCollectingSession("aggregated-amend");
  const mb = await activeMember();
  expect((await submit(mb, b.date, b.subj, { body: "the take of record" })).status).toBe(201);
  await ic.closeWindow(b.session.id);
  await ic.aggregateSession(b.session.id);
  const state = (await sql`SELECT state, window_closes_at FROM swarm_sessions WHERE id = ${b.session.id}`)[0] as any;
  expect(state.state).toBe("aggregated");
  // The deadline has NOT passed — proving this refusal comes from the
  // aggregation gate and not from the window comparison.
  expect(new Date(state.window_closes_at).getTime()).toBeGreaterThan(Date.now());

  const afterAggregate = await submit(mb, b.date, b.subj, { body: "second thoughts" });
  expect(afterAggregate.status).toBe(409);
  expect((afterAggregate as { error: string }).error).toContain("amendment window closed");
  expect((afterAggregate as { error: string }).error).toContain("aggregated");
  expect(await rows(b.session.id, mb.id)).toHaveLength(1);

  // And the published snapshot still quotes exactly what is on file.
  const rec = (await sql`SELECT swarm_recommendation FROM swarm_sessions WHERE id = ${b.session.id}`)[0] as any;
  expect(JSON.stringify(rec.swarm_recommendation)).not.toContain("second thoughts");
});

test("the aggregation gate is AMENDMENT-ONLY: a first take is still governed by the advertised deadline alone (#570)", async () => {
  // The regression this guards: implementing the gate as "no submits once
  // aggregated" would have silently re-created the dead zone #570 removed, for
  // a member that had not yet spoken.
  const { subj, session, date } = await openCollectingSession("first-after-agg");
  const seated = await activeMember();
  expect((await submit(seated, date, subj, { body: "early bird" })).status).toBe(201);
  await ic.closeWindow(session.id);
  await ic.aggregateSession(session.id);

  const latecomer = await activeMember();
  const first = await submit(latecomer, date, subj, { body: "my first word on this" });
  expect(first.status).toBe(201);
  expect((first as { revision?: number }).revision).toBe(1);
});

// ── 3. The bound ────────────────────────────────────────────────────────────

test(`the cap caps: a member gets exactly ${SWARM_TAKE_REVISION_CAP} takes in one session, and the refusal names why`, async () => {
  const { subj, session, date } = await openCollectingSession("cap");
  const m = await activeMember();

  for (let i = 1; i <= SWARM_TAKE_REVISION_CAP; i++) {
    const res = await submit(m, date, subj, { body: `take ${i}` });
    expect(res.status).toBe(201);
    expect((res as { revision?: number }).revision).toBe(i);
  }

  const overCap = await submit(m, date, subj, { body: "one too many" });
  expect(overCap.status).toBe(409);
  // Distinguishable from the other 409s on this route — an agent must be able
  // to tell "stop" from "retry" from "re-mint a nonce".
  expect((overCap as { error: string }).error).toContain("amendment cap reached");
  expect((overCap as { error: string }).error).toContain(String(SWARM_TAKE_REVISION_CAP));
  expect((overCap as { error: string }).error).not.toContain("window closed");
  expect((overCap as { error: string }).error).not.toContain("nonce");

  // Nothing was written, and waiting does not restore budget.
  expect(await rows(session.id, m.id)).toHaveLength(SWARM_TAKE_REVISION_CAP);
  expect((await submit(m, date, subj, { body: "still too many" })).status).toBe(409);
  expect(await rows(session.id, m.id)).toHaveLength(SWARM_TAKE_REVISION_CAP);

  // The cap is per SESSION, not per member for all time: the same member is
  // unbudgeted again in the next session.
  const next = await openCollectingSession("cap-next");
  const fresh = await submit(m, next.date, next.subj, { body: "new session, new budget" });
  expect(fresh.status).toBe(201);
  expect((fresh as { revision?: number }).revision).toBe(1);
});

test("THE CHEAP PATH: the cap is refused BEFORE the Ed25519 verify, not after", async () => {
  // WHY THIS IS A REQUIREMENT AND NOT AN OPTIMISATION. Before #573 the only
  // refusal of a repeat submit was the unique-constraint violation raised by
  // the INSERT at the very bottom of submitRecommendation — so a looping,
  // unattended agent paid for a token lookup, a session lookup, two roster
  // queries, publicKeyFor AND a full signature verification on every rejected
  // call. Asserting the status code alone would not have caught that: the old
  // code returned 409 too, just expensively.
  //
  // HOW THE ORDERING IS PROVED. Submit an INVALID signature while over the cap.
  // The verify branch has an observable side effect — it writes a
  // `rejected_signature` row to swarm_agent_health_events and returns 400. If
  // the verify ran, we would see that 400 and that row. Seeing the cap's 409
  // and NO such row means the cap short-circuited above it. The control below
  // proves the probe can actually detect the verify path, so a green here is
  // not a green from a broken probe.
  const { subj, session, date } = await openCollectingSession("order");
  const capped = await activeMember();
  for (let i = 1; i <= SWARM_TAKE_REVISION_CAP; i++) {
    expect((await submit(capped, date, subj, { body: `take ${i}` })).status).toBe(201);
  }

  const healthEvents = (memberId: string) => sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM swarm_agent_health_events
    WHERE member_id = ${memberId} AND event_type = 'rejected_signature'`;

  expect((await healthEvents(capped.id))[0]!.n).toBe(0);

  const forged = await submitWithBadSignature(capped, date, subj);
  // The CAP answers, not the signature. If this ever reads 400
  // "signature verification failed", the cheap refusal has moved back below the
  // verify and the ordering requirement is broken.
  expect(forged.status).toBe(409);
  expect((forged as { error: string }).error).toContain("amendment cap reached");
  // ...and the verify's side effect never happened.
  expect((await healthEvents(capped.id))[0]!.n).toBe(0);
  expect(await rows(session.id, capped.id)).toHaveLength(SWARM_TAKE_REVISION_CAP);

  // CONTROL — the probe is real. The same forged submission from a member that
  // is NOT over the cap does reach the verify: 400, and the health event lands.
  // Without this, a probe that could never fire would make the assertion above
  // vacuous.
  const underCap = await activeMember();
  const reachesVerify = await submitWithBadSignature(underCap, date, subj);
  expect(reachesVerify.status).toBe(400);
  expect((reachesVerify as { error: string }).error).toBe("signature verification failed");
  expect((await healthEvents(underCap.id))[0]!.n).toBe(1);
});

test("nonce replay is refused before the verify too, and says something different from the cap", async () => {
  const { subj, date } = await openCollectingSession("replay");
  const m = await activeMember();
  const nonce = rid("fixed");
  expect((await submit(m, date, subj, { nonce, body: "first" })).status).toBe(201);

  const replayed = await submit(m, date, subj, { nonce, body: "first" });
  expect(replayed.status).toBe(409);
  expect((replayed as { error: string }).error).toContain("nonce already used");
  expect((replayed as { error: string }).error).not.toContain("cap");

  // Same nonce, INVALID signature: still the nonce answer, and the verify's
  // health event never fires — the same cheap-path proof as the cap.
  const sub = { memberId: m.id, date, subjectId: subj, nonce, stance: "neutral", confidence: 0.5, body: "forged" };
  const badSig = await signMessage(canonicalizeSubmission({ ...sub, body: "different bytes" }), m.privateKey);
  const replayedForgery = await ic.submitRecommendation(m.token, { ...sub, signature: badSig });
  expect(replayedForgery.status).toBe(409);
  expect((replayedForgery as { error: string }).error).toContain("nonce already used");
  const events = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM swarm_agent_health_events
    WHERE member_id = ${m.id} AND event_type = 'rejected_signature'`;
  expect(events[0]!.n).toBe(0);
});

// ── 4. Participation and quorum ─────────────────────────────────────────────

test("participation and quorum count DISTINCT MEMBERS, not rows — the assertion that catches the takes.length bug", async () => {
  const { subj, session, date } = await openCollectingSession("quorum");
  // Exactly three seated members — openSession takes the legacy/demo path with
  // no frozen roster, so aggregateSession's denominator is the live active
  // roster, which beforeEach has just emptied. Three seats, and the numbers
  // below are checked against them.
  // Three seated members. A amends twice (3 rows), B files once (1 row), C
  // never speaks. Four rows, two participants, three seats.
  const a = await activeMember();
  const b = await activeMember();
  const c = await activeMember();

  expect((await submit(a, date, subj, { stance: "bearish", confidence: 0.2, body: "A first" })).status).toBe(201);
  expect((await submit(a, date, subj, { stance: "cautious", confidence: 0.4, body: "A second" })).status).toBe(201);
  expect((await submit(a, date, subj, { stance: "bullish", confidence: 0.8, body: "A final word" })).status).toBe(201);
  expect((await submit(b, date, subj, { stance: "bearish", confidence: 0.6, body: "B only word" })).status).toBe(201);

  const rowCount = (await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM swarm_recommendations WHERE session_id = ${session.id}`)[0]!.n;
  expect(rowCount).toBe(4);

  await ic.closeWindow(session.id);
  await ic.aggregateSession(session.id);

  const rec = (await sql`SELECT swarm_recommendation, synthesis FROM swarm_sessions WHERE id = ${session.id}`)[0] as any;
  const quorum = rec.swarm_recommendation.quorum;

  // WITH `takes.length` THIS READS 4 AND 133% PARTICIPATION, PUBLISHED.
  expect(quorum.submitted).toBe(2);
  expect(quorum.active).toBe(3);
  expect(quorum.participation).toBeCloseTo(2 / 3, 10);
  expect(quorum.participation).toBeLessThanOrEqual(1);
  expect(quorum.absent).toBe(1);
  expect(rec.swarm_recommendation.absent).toEqual([c.id]);

  // The stance tally is per member too: A contributed THREE rows but only its
  // final stance counts, so the tally sums to 2 and carries no trace of the
  // stances A moved through.
  const stances = rec.swarm_recommendation.stances as Record<string, number>;
  expect(Object.values(stances).reduce((sum, n) => sum + n, 0)).toBe(2);
  expect(stances).toEqual({ bullish: 1, bearish: 1 });

  // Mean confidence is over MEMBERS, not rows: (0.8 + 0.6) / 2, never
  // (0.2 + 0.4 + 0.8 + 0.6) / 4.
  expect(rec.swarm_recommendation.meanConfidence).toBeCloseTo(0.7, 10);

  // And the prose a reader actually sees agrees with the numbers.
  expect(rec.swarm_recommendation.consensus.join(" ")).toContain("2 of 3 members submitted (67% participation)");
  expect(String(rec.synthesis)).toContain("2 of 3 members");

  // THE SNAPSHOT QUOTES THE LATEST PROSE, NEVER A WITHDRAWN ONE. aggregation
  // copies take bodies verbatim into disagreements[].positions[].view and is
  // never recomputed, so a superseded body reaching it would be published
  // permanently.
  const serialized = JSON.stringify(rec.swarm_recommendation);
  expect(serialized).toContain("A final word");
  expect(serialized).not.toContain("A first");
  expect(serialized).not.toContain("A second");
});

// ── 5. One card per member ──────────────────────────────────────────────────

test("the session payload carries ONE take per member with revisions present — what makes the page render one card, not one per revision", async () => {
  // The frontend half of this — that
  // frontend/public/views/swarm/session.html keys its two take loops on the
  // MEMBER and not the row id — is pinned by
  // scripts/tests/unit/swarm-session-take-key.test.ts. This is the server half:
  // the payload the page renders.
  const { subj, date } = await openCollectingSession("cards");
  const a = await activeMember();
  const b = await activeMember();
  await submit(a, date, subj, { body: "A v1" });
  await submit(a, date, subj, { body: "A v2" });
  await submit(a, date, subj, { body: "A v3" });
  await submit(b, date, subj, { body: "B v1" });

  const p = routePath(ROUTES.swarm.session, { date, subject: subj });
  const res = await handleSwarm(new Request(`http://localhost${p}`), new URL(`http://localhost${p}`));
  expect(res?.status).toBe(200);
  const takes = (res?.body as any).takes as { id: string; memberId: string; body: string; revision: number }[];

  expect(takes).toHaveLength(2);
  expect(new Set(takes.map((t) => t.memberId)).size).toBe(2);
  // Distinct row ids too — the ids are per-revision, which is exactly why
  // keying the template on `t.id` would have rendered a card per revision the
  // moment latest-per-member regressed.
  expect(new Set(takes.map((t) => t.id)).size).toBe(2);
  expect(takes.find((t) => t.memberId === a.id)!.body).toBe("A v3");
  expect(takes.find((t) => t.memberId === a.id)!.revision).toBe(3);
  expect(takes.find((t) => t.memberId === b.id)!.body).toBe("B v1");
});
