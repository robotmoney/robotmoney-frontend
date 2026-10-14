// POST /api/swarm/submit/dry-run (RM-178): every check submit runs, through the
// same checkTake, with nothing written. A member proves its setup before it is
// seated on a session that is still collecting, instead of finding out at its
// first real take.
//
// Each case pins two things: the dry run's verdict, and that submit, sent the
// same body, answers with exactly the status and error of the first check the
// dry run failed. That second half is what keeps the two from drifting apart.
import { expect, test } from "bun:test";
import { canonicalizeSubmission, ROUTES, type SwarmSubmitDryRunResult, type SwarmTakeCheck } from "@robotmoney/contract";
import * as ic from "../src/swarm/domain.ts";
import { handleSwarm } from "../src/api/routes/swarm.ts";
import { sql } from "../src/db/client.ts";
import { generateKeyPair, signMessage } from "../src/lib/signing.ts";
import { useCleanDatabasePerTest } from "./support/clean-db.ts";
import { activeMember, activeSubject, rid, sessionDate, type TestMember } from "./support/epoch-fixtures.ts";

useCleanDatabasePerTest(import.meta.file);

const SUBMIT_ORDER: SwarmTakeCheck["check"][] = [
  "fields", "token", "nonce", "session", "date", "window",
  "reportSnapshot", "roster", "amendmentCap", "weights", "signature",
];

/** An epoch: its roster is frozen at open, seating every member active then. */
async function openedEpoch(subjectId: string) {
  const opened = await ic.openEpoch(subjectId);
  if (!opened.ok) throw new Error(`openEpoch failed: ${JSON.stringify(opened)}`);
  const [row] = await sql`SELECT id, date FROM swarm_sessions WHERE id = ${opened.sessionId}`;
  return { sessionId: String(row!.id), date: sessionDate(row!) };
}

async function signedTake(
  m: TestMember,
  subjectId: string,
  date: string,
  over: { signWith?: CryptoKey; reportSnapshotId?: string } = {},
) {
  const sub = {
    memberId: m.id,
    date,
    subjectId,
    nonce: rid("n"),
    stance: "neutral",
    confidence: 0.5,
    body: "a take",
    ...(over.reportSnapshotId ? { reportSnapshotId: over.reportSnapshotId } : {}),
  };
  const signature = await signMessage(canonicalizeSubmission(sub), over.signWith ?? m.privateKey);
  return { ...sub, signature };
}

/** Everything a take, a refusal or an acceptance writes. A dry run writes none of it. */
async function writes() {
  const [row] = await sql`SELECT
    (SELECT count(*)::int FROM swarm_recommendations) AS takes,
    (SELECT count(*)::int FROM swarm_agent_health_events) AS events,
    (SELECT count(*)::int FROM audit_log) AS audit`;
  return row;
}

async function dryRun(token: string | null, body: unknown): Promise<{ status: number; body: SwarmSubmitDryRunResult }> {
  const url = `http://localhost${ROUTES.swarm.submitDryRun}`;
  const res = await handleSwarm(
    new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    }),
    new URL(url),
  );
  if (!res || res instanceof Response) throw new Error("the dry run was not handled");
  return res as { status: number; body: SwarmSubmitDryRunResult };
}

const check = (r: SwarmSubmitDryRunResult, name: string) => r.checks.find((c) => c.check === name);
const firstRefusal = (r: SwarmSubmitDryRunResult) => {
  const c = r.checks.find((x) => !x.ok);
  return c ? { status: c.status!, error: c.error! } : null;
};

test("a take submit would accept: setupOk and wouldAcceptNow, every check in submit's order, nothing written, then submit accepts it", async () => {
  const subject = await activeSubject("dry-ok");
  const m = await activeMember();
  const { sessionId, date } = await openedEpoch(subject);
  const take = await signedTake(m, subject, date);

  const before = await writes();
  const res = await dryRun(m.token, take);
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({ dryRun: true, setupOk: true, wouldAcceptNow: true, sessionId });
  expect(res.body.checks.map((c) => c.check)).toEqual(SUBMIT_ORDER);
  expect(res.body.checks.every((c) => c.ok)).toBe(true);
  expect(await writes()).toEqual(before);

  const submitted = await ic.submitRecommendation(m.token, take);
  expect(submitted.status).toBe(201);
});

test("a member approved after the session opened: setupOk holds, the roster refusal is situational, and submit refuses with it", async () => {
  const subject = await activeSubject("dry-roster");
  const { date } = await openedEpoch(subject);
  const late = await activeMember();
  const take = await signedTake(late, subject, date);

  const before = await writes();
  const res = await dryRun(late.token, take);
  expect(res.body.setupOk).toBe(true);
  expect(res.body.wouldAcceptNow).toBe(false);
  expect(check(res.body, "roster")).toEqual({
    check: "roster", situational: true, ok: false, status: 403, error: "member is not on this session's expected roster",
  });
  // The point of the dry run: the signature is verified although submit never gets that far.
  expect(check(res.body, "signature")).toEqual({ check: "signature", ok: true });
  expect(await writes()).toEqual(before);

  const submitted = await ic.submitRecommendation(late.token, take);
  expect({ status: submitted.status, error: submitted.error }).toEqual(firstRefusal(res.body)!);
});

test("a bad signature on a session the member is not seated on: the dry run names both, submit stops at the roster, and no signature event is written", async () => {
  const subject = await activeSubject("dry-badsig");
  const { date } = await openedEpoch(subject);
  const late = await activeMember();
  const { privateKey: otherKey } = await generateKeyPair();
  const take = await signedTake(late, subject, date, { signWith: otherKey });

  const res = await dryRun(late.token, take);
  expect(res.body.setupOk).toBe(false);
  expect(check(res.body, "roster")).toMatchObject({ ok: false, situational: true });
  expect(check(res.body, "signature")).toEqual({
    check: "signature", ok: false, status: 400, error: "signature verification failed",
  });

  const submitted = await ic.submitRecommendation(late.token, take);
  expect({ status: submitted.status, error: submitted.error }).toEqual(firstRefusal(res.body)!);
  const [{ n }] = await sql`SELECT count(*)::int AS n FROM swarm_agent_health_events
                             WHERE member_id = ${late.id} AND event_type = 'rejected_signature'`;
  expect(n).toBe(0);
});

test("a closed window is situational: the signature is still checked and setupOk holds", async () => {
  const subject = await activeSubject("dry-closed");
  const m = await activeMember();
  const { sessionId, date } = await openedEpoch(subject);
  await sql`UPDATE swarm_sessions SET window_closes_at = now() - interval '1 second' WHERE id = ${sessionId}`;
  const take = await signedTake(m, subject, date);

  const res = await dryRun(m.token, take);
  expect(res.body).toMatchObject({ setupOk: true, wouldAcceptNow: false });
  expect(check(res.body, "window")).toMatchObject({ ok: false, situational: true, status: 409 });
  expect(check(res.body, "signature")).toEqual({ check: "signature", ok: true });

  const submitted = await ic.submitRecommendation(m.token, take);
  expect({ status: submitted.status, error: submitted.error }).toEqual(firstRefusal(res.body)!);
});

test("a wrong signed date and a report snapshot on an unbound brief fail setup, each as submit refuses it", async () => {
  const subject = await activeSubject("dry-draft");
  const m = await activeMember();
  const { date } = await openedEpoch(subject);

  const wrongDate = await signedTake(m, subject, "2001-01-01");
  const dated = await dryRun(m.token, wrongDate);
  expect(dated.body.setupOk).toBe(false);
  expect(check(dated.body, "date")).toMatchObject({ ok: false, status: 409 });
  expect(check(dated.body, "signature")).toEqual({ check: "signature", ok: true });
  const submittedDated = await ic.submitRecommendation(m.token, wrongDate);
  expect({ status: submittedDated.status, error: submittedDated.error }).toEqual(firstRefusal(dated.body)!);

  const unbound = await signedTake(m, subject, date, { reportSnapshotId: "7" });
  const snap = await dryRun(m.token, unbound);
  expect(snap.body.setupOk).toBe(false);
  expect(check(snap.body, "reportSnapshot")).toMatchObject({ ok: false, status: 409 });
  const submittedSnap = await ic.submitRecommendation(m.token, unbound);
  expect({ status: submittedSnap.status, error: submittedSnap.error }).toEqual(firstRefusal(snap.body)!);
});

test("an allocation take without weights fails the weights check with submit's own refusal", async () => {
  const subject = await activeSubject("dry-weights");
  await sql`UPDATE swarm_subjects SET recommendation_type = 'bucket_weights' WHERE id = ${subject}`;
  const m = await activeMember();
  const { date } = await openedEpoch(subject);
  const take = await signedTake(m, subject, date);

  const res = await dryRun(m.token, take);
  expect(res.body.setupOk).toBe(false);
  expect(check(res.body, "weights")!.error).toContain("weights_required_for_bucket_weights_subject");
  const submitted = await ic.submitRecommendation(m.token, take);
  expect({ status: submitted.status, error: submitted.error }).toEqual(firstRefusal(res.body)!);
});

test("a credential is refused as submit refuses it; past that, a body submit refuses is a failed fields check in a 200", async () => {
  const subject = await activeSubject("dry-auth");
  const m = await activeMember();
  const other = await activeMember();
  const { date } = await openedEpoch(subject);
  const take = await signedTake(m, subject, date);

  expect((await dryRun(null, take)).status).toBe(401);
  const unknown = await dryRun("tok_nobody_00000000-0000-0000-0000-000000000000", take);
  expect({ status: unknown.status, body: unknown.body as unknown }).toEqual({ status: 401, body: { error: "unknown member token" } });
  const mismatch = await dryRun(other.token, take);
  expect({ status: mismatch.status, body: mismatch.body as unknown }).toEqual({ status: 403, body: { error: "token/member mismatch" } });

  const withCites = await dryRun(m.token, { ...take, cites: ["a"] });
  expect(withCites.status).toBe(200);
  expect(withCites.body.checks).toEqual([{ check: "fields", ok: false, status: 400, error: "unknown field: cites" }]);
});

test("a take already on file: the dry run says submit would answer alreadySubmitted", async () => {
  const subject = await activeSubject("dry-retry");
  const m = await activeMember();
  const { date } = await openedEpoch(subject);
  const take = await signedTake(m, subject, date);
  expect((await ic.submitRecommendation(m.token, take)).status).toBe(201);

  const res = await dryRun(m.token, take);
  expect(res.body).toMatchObject({ setupOk: true, wouldAcceptNow: true, alreadySubmitted: true });
});
