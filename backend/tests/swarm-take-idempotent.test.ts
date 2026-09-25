// A take's identity is its signed nonce, and a member has one FINAL take per
// session (issue #1026 W3; D51, D52; smoke-production-spec.md §6.2 and §6.4).
//
// AUTHORITY, verbatim from smoke spec §6.2:
//
//   "A submission is identified by its signed `nonce`. ... A resubmission whose
//    nonce is already recorded for that member and session is a retry: it
//    returns the existing record and the participant treats it as success. A
//    new nonce is an intentional amendment, allowed while the window is open:
//    each is its own signed row, and accepting one marks it final and unsets
//    the member's previous one. A partial unique index on `(session, member)
//    WHERE final` makes two final takes impossible even when two submissions
//    race, and `rm_app` may `UPDATE` only the `final` column of
//    `swarm_recommendations`. An old and a new container overlapping during a
//    roster change can therefore produce an amendment, never a second final
//    take."
//
// and §6.4: "the server rejects submissions signed with a superseded key".
//
// WHAT EACH BLOCK PROVES, by criterion:
//   127 — acceptance flips the flag in the accepting transaction; every
//         "session's takes" read selects on the flag, not on revision order;
//         content is never rewritten and nothing is deleted; a retry returns
//         the existing record.
//   130 — a recorded nonce returns the existing row; a new nonce amends.
//   129 — the window, not the storage state, freezes a take.
//   126 — two containers holding DIFFERENT tokens for one member, overlapping
//         across a key rebind, leave one final take; an identical retry adds
//         no row. THE MECHANISM IS AUTH, NOT THE TAKE PATH'S LOCK: a member
//         holds exactly one valid bearer at a time (a rebind deactivates every
//         prior key in its transaction, and memberIdForToken requires
//         `k.active`), so the old container is refused with 401 and two
//         different tokens can never both be accepted. The take path's own
//         race guarantee — one final take under genuinely concurrent accepted
//         submissions — is proven separately with ONE token ("two amendments
//         racing through the route").
//   148 — a rebind keeps old takes verifying; a new take signed with the
//         superseded key is refused with 403 and writes nothing.
//
// EVERY TAKE GOES THROUGH THE REAL ROUTE (`POST /api/swarm/submit`, handleSwarm)
// with a signed body, as a participant container sends it. The fields asserted
// on a retry are the ones scripts/agent/participant/take-runner.ts reads:
// `alreadySubmitted`, `recommendationId`, `verified`.
import { expect, test } from "bun:test";
import { canonicalizeSubmission, ROUTES, path as routePath } from "@robotmoney/contract";
import { sql } from "../src/db/client.ts";
import * as ic from "../src/swarm/domain.ts";
import * as admin from "../src/swarm/admin.ts";
import { handleSwarm } from "../src/api/routes/swarm.ts";
import { generateKeyPair, signMessage } from "../src/lib/signing.ts";
import { useCleanDatabasePerTest } from "./support/clean-db.ts";
import { activeSubject, rid, sessionDate, sessionRow } from "./support/epoch-fixtures.ts";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createTakeWorkspace,
  findPersistedSubmissions,
  sendSignedSubmission,
  submitTake as runnerSubmitTake,
} from "../../scripts/agent/participant/take-runner.ts";
import type { ParticipantConfig } from "../../scripts/agent/participant/main.ts";

// Per TEST: members are global and capped (SWARM_ROSTER_CAP), and several
// tests below count every row a member owns.
useCleanDatabasePerTest(import.meta.file);

interface Container {
  memberId: string;
  token: string;
  privateKey: CryptoKey;
}

interface SignedTake {
  memberId: string;
  date: string;
  subjectId: string;
  nonce: string;
  stance: string;
  confidence: number;
  body: string;
  signature: string;
}

async function member(): Promise<Container & { publicKey: string }> {
  const memberId = rid("m");
  const { publicKeyB64, privateKey } = await generateKeyPair();
  const r = await ic.registerMember({ memberId, name: memberId, publicKey: publicKeyB64 });
  if (!("token" in r) || !r.token) throw new Error(`registerMember failed: ${JSON.stringify(r)}`);
  return { memberId, token: r.token, privateKey, publicKey: publicKeyB64 };
}

/**
 * Open an epoch for a fresh subject. Call it AFTER creating the members a test
 * submits as: an epoch seats every active member when it opens, and a member
 * activated mid-epoch joins the next one (admin-surface.md US-C3).
 */
async function openEpoch(prefix: string) {
  const subjectId = await activeSubject(prefix, 3600);
  const opened = await ic.openEpoch(subjectId);
  if (!opened.ok) throw new Error(`openEpoch: ${JSON.stringify(opened)}`);
  return { subjectId, sessionId: opened.sessionId, date: sessionDate(await sessionRow(opened.sessionId)) };
}

/** Author and sign a take — the bytes a participant writes to its workspace before sending. */
async function sign(
  c: Pick<Container, "memberId" | "privateKey">,
  date: string,
  subjectId: string,
  body: string,
  nonce = rid("n"),
): Promise<SignedTake> {
  const sub = { memberId: c.memberId, date, subjectId, nonce, stance: "neutral", confidence: 0.5, body };
  return { ...sub, signature: await signMessage(canonicalizeSubmission(sub), c.privateKey) };
}

/** Send signed bytes through the real route, under a bearer token. */
async function send(token: string, take: SignedTake): Promise<{ status: number; body: any }> {
  const p = ROUTES.swarm.submit;
  const res = await handleSwarm(
    new Request(`http://localhost${p}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(take),
    }),
    new URL(`http://localhost${p}`),
  );
  if (!res || res instanceof Response) throw new Error("submit route did not answer with an envelope");
  return res as { status: number; body: any };
}

type TakeRow = {
  id: string; revision: number; final: boolean; nonce: string; body: string;
  stance: string; signature: string; payload: unknown; received_at: Date;
};

const takeRows = (sessionId: string, memberId: string) => sql<TakeRow[]>`
  SELECT id, revision, final, nonce, body, stance, signature, payload, received_at
    FROM swarm_recommendations
   WHERE session_id = ${sessionId} AND member_id = ${memberId}
   ORDER BY revision`;

const finals = async (sessionId: string, memberId: string) =>
  (await takeRows(sessionId, memberId)).filter((r) => r.final);

// ── 130 / 127: a retry is identified by its signed nonce ────────────────────

test("a retry of the identical signed submission returns the EXISTING record — 200, alreadySubmitted, same id, no row added", async () => {
  const m = await member();
  const { subjectId, sessionId, date } = await openEpoch("retry");
  const bytes = await sign(m, date, subjectId, "the take");

  const first = await send(m.token, bytes);
  expect(first.status).toBe(201);
  expect(first.body).toMatchObject({ alreadySubmitted: false, verified: true, revision: 1, final: true });
  const id = first.body.recommendationId as string;

  // A crash-restart resends the SAME bytes. The take-runner reads exactly
  // these three fields and treats `alreadySubmitted: true` as success.
  const retry = await send(m.token, bytes);
  expect(retry.status).toBe(200);
  expect(retry.body.alreadySubmitted).toBe(true);
  expect(retry.body.recommendationId).toBe(id);
  expect(retry.body.verified).toBe(true);
  expect(await takeRows(sessionId, m.memberId)).toHaveLength(1);
});

test("a retry still returns the existing record after the window closed and the epoch turned over — the resend settles, it is not refused", async () => {
  const m = await member();
  const { subjectId, sessionId, date } = await openEpoch("retry_late");
  const bytes = await sign(m, date, subjectId, "filed in time");
  const first = await send(m.token, bytes);
  expect(first.status).toBe(201);

  await sql`UPDATE swarm_sessions SET window_closes_at = clock_timestamp() - interval '1 second' WHERE id = ${sessionId}`;
  const turned = await ic.turnOverEpoch(subjectId, sessionId);
  expect(turned.ok).toBe(true);

  const resend = await send(m.token, bytes);
  expect(resend.status).toBe(200);
  expect(resend.body).toMatchObject({ alreadySubmitted: true, recommendationId: first.body.recommendationId, verified: true });
  expect(await takeRows(sessionId, m.memberId)).toHaveLength(1);
  if (turned.ok) expect(await takeRows(turned.openedSessionId, m.memberId)).toHaveLength(0);
});

test("130 over HTTP: the participant's own take-runner persists the signed bytes, and resending them after a crash-restart settles as already_submitted against the real route", async () => {
  // The participant half of 130, run with the participant's OWN code against
  // the real submit route behind a live HTTP server — not a fake API, and not
  // hand-built requests. submitTake fetches the canonical bytes from the
  // signing-payload route, signs, writes the request into the workspace, then
  // sends; the "restarted" container finds those bytes on disk and resends
  // them with sendSignedSubmission.
  const kp = generateKeyPairSync("ed25519");
  const privateJwk = kp.privateKey.export({ format: "jwk" }) as Record<string, unknown>;
  const publicKeyB64 = Buffer.from((kp.publicKey.export({ format: "jwk" }) as { x: string }).x, "base64url").toString("base64");
  const memberId = rid("m");
  const reg = await ic.registerMember({ memberId, name: memberId, publicKey: publicKeyB64 });
  if (!("token" in reg) || !reg.token) throw new Error(`registerMember failed: ${JSON.stringify(reg)}`);
  const { subjectId, sessionId, date } = await openEpoch("runner_http");

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const res = await handleSwarm(req, new URL(req.url));
      if (!res) return new Response("not found", { status: 404 });
      if (res instanceof Response) return res;
      return Response.json(res.body, { status: res.status });
    },
  });
  const root = mkdtempSync(join(tmpdir(), "rm-take-runner-http-"));
  try {
    const config = {
      apiUrl: `http://127.0.0.1:${server.port}`,
      name: memberId,
      kind: "agent",
      memberId,
      token: reg.token,
      identity: { publicKeyB64, privateJwk },
      modelKey: "",
      takeCommand: [],
      pollIntervalMs: 5_000,
      takeTimeoutMs: 60_000,
      workspaceRoot: root,
    } as unknown as ParticipantConfig;
    const work = { sessionId, subjectId, date };
    const draft = { memberId, date, subjectId, stance: "neutral", confidence: 0.5, body: "authored by the runner" };

    const first = await runnerSubmitTake(config, work, draft, createTakeWorkspace(root, sessionId, memberId));
    expect(first.status).toBe("submitted");
    expect(first.verified).toBe(true);
    expect(typeof first.takeId).toBe("string");

    // Crash-restart: the new process knows only what the workspace holds.
    const persisted = findPersistedSubmissions(root, memberId, sessionId);
    expect(persisted).toHaveLength(1);
    const resent = await sendSignedSubmission(config, persisted[0]!.record.bytes);
    expect(resent).toMatchObject({ status: "already_submitted", takeId: first.takeId, verified: true });

    const rows = await takeRows(sessionId, memberId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(first.takeId!);
    expect(rows[0]!.nonce).toBe(persisted[0]!.record.nonce);
    expect(rows[0]!.final).toBe(true);
  } finally {
    server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
});

test("a recorded nonce under DIFFERENT signed bytes is a replay: 409, no row, and no signature work", async () => {
  const m = await member();
  const { subjectId, sessionId, date } = await openEpoch("replay");
  const nonce = rid("fixed");
  expect((await send(m.token, await sign(m, date, subjectId, "original", nonce))).status).toBe(201);

  const replay = await send(m.token, await sign(m, date, subjectId, "different content", nonce));
  expect(replay.status).toBe(409);
  expect(replay.body.error).toContain("nonce already used");
  expect(replay.body.alreadySubmitted).toBeUndefined();
  expect(await takeRows(sessionId, m.memberId)).toHaveLength(1);
  const [events] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM swarm_agent_health_events
     WHERE member_id = ${m.memberId} AND event_type = 'rejected_signature'`;
  expect(events!.n).toBe(0);
});

test("a NEW nonce is an amendment: a new row, marked final, and the prior take unset — in the accepting transaction", async () => {
  const m = await member();
  const { subjectId, sessionId, date } = await openEpoch("amend");
  const a = await send(m.token, await sign(m, date, subjectId, "first read"));
  expect(a.status).toBe(201);
  const before = (await takeRows(sessionId, m.memberId))[0]!;
  expect(before.final).toBe(true);

  const b = await send(m.token, await sign(m, date, subjectId, "second read"));
  expect(b.status).toBe(201);
  expect(b.body).toMatchObject({ alreadySubmitted: false, revision: 2, final: true });

  const rows = await takeRows(sessionId, m.memberId);
  expect(rows).toHaveLength(2);
  expect(rows.map((r) => [r.revision, r.final])).toEqual([[1, false], [2, true]]);
  // CONTENT, NONCE AND SIGNATURE ARE NEVER UPDATED: the superseded row is
  // byte-for-byte what was accepted; only its flag moved.
  expect(rows[0]!.id).toBe(before.id);
  expect(rows[0]!.body).toBe(before.body);
  expect(rows[0]!.stance).toBe(before.stance);
  expect(rows[0]!.nonce).toBe(before.nonce);
  expect(rows[0]!.signature).toBe(before.signature);
  expect(JSON.stringify(rows[0]!.payload)).toBe(JSON.stringify(before.payload));
  expect(new Date(rows[0]!.received_at).getTime()).toBe(new Date(before.received_at).getTime());

  // A retry of the SUPERSEDED submission still returns its own record, and
  // says truthfully that it is no longer final. Nothing moves.
  const staleRetry = await send(m.token, await sign(m, date, subjectId, "first read", before.nonce));
  expect(staleRetry.status).toBe(200);
  expect(staleRetry.body).toMatchObject({ alreadySubmitted: true, recommendationId: before.id, final: false });
  expect((await finals(sessionId, m.memberId)).map((r) => r.revision)).toEqual([2]);
});

test("content is refused by GRANT — rm_app may UPDATE only `final` — and an amendment deletes nothing", async () => {
  const m = await member();
  const { subjectId, sessionId, date } = await openEpoch("grant");
  await send(m.token, await sign(m, date, subjectId, "one"));
  await send(m.token, await sign(m, date, subjectId, "two"));
  const [{ id }] = await sql<{ id: string }[]>`
    SELECT id FROM swarm_recommendations WHERE session_id = ${sessionId} AND member_id = ${m.memberId} AND revision = 1`;

  // As the runtime role the API connects as. A rewrite of a take's content is
  // refused whatever code issues it.
  for (const column of ["body", "stance", "nonce", "signature"] as const) {
    let code: string | undefined;
    try {
      await sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE rm_app`;
        await tx.unsafe(`UPDATE swarm_recommendations SET ${column} = ${column} WHERE id = $1`, [id]);
      });
    } catch (err) {
      code = (err as { code?: string }).code;
    }
    expect(code, `rm_app UPDATE of ${column}`).toBe("42501");
  }
  // RED CONTROL: the same role CAN move the flag, so the refusals above are
  // about the column, not a role that cannot write at all.
  await sql.begin(async (tx) => {
    await tx`SET LOCAL ROLE rm_app`;
    await tx`UPDATE swarm_recommendations SET final = final WHERE id = ${id}`;
  });
  // NOTHING IS DELETED: the amendment added a row and removed none. (The
  // refusal of a DELETE itself is migration 0032's guard, pinned by
  // append-only-enforcement.test.ts; this file never issues one.)
  expect(await takeRows(sessionId, m.memberId)).toHaveLength(2);
});

// ── 127: every "session's takes" read selects on the flag ───────────────────

test("every read that means 'the session's takes' selects on the FINAL flag, not on revision order", async () => {
  // RED CONTROL BUILT IN. The flag is moved, as the database owner, onto the
  // LOWER revision, so the flag and `ORDER BY revision DESC` disagree. A read
  // that still ordered on revision would return "revision two"; each read
  // below must return "revision one". Under normal operation the two agree —
  // the accepting trigger marks the newest final — which is exactly why only a
  // disagreement can tell which one a read uses.
  const m = await member();
  // A second member, created before the epoch opens so it is seated; used by
  // the take_count red control at the end.
  const other = await member();
  const { subjectId, sessionId, date } = await openEpoch("flag_reads");
  await send(m.token, await sign(m, date, subjectId, "revision one"));
  await send(m.token, await sign(m, date, subjectId, "revision two"));
  await sql.begin(async (tx) => {
    await tx`UPDATE swarm_recommendations SET final = false WHERE session_id = ${sessionId} AND member_id = ${m.memberId}`;
    await tx`UPDATE swarm_recommendations SET final = true WHERE session_id = ${sessionId} AND member_id = ${m.memberId} AND revision = 1`;
  });
  const [r1, r2] = await takeRows(sessionId, m.memberId);

  const frozen = await ic.loadFrozenTakeSet(sessionId);
  expect(frozen!.takes.map((t) => t.body)).toEqual(["revision one"]);

  const detail = await ic.getSessionById(sessionId);
  expect(detail!.takes.map((t) => t.body)).toEqual(["revision one"]);

  const record = await ic.getMemberTakes(m.memberId, 10);
  expect(record.takes.map((t) => t.take.body)).toEqual(["revision one"]);

  const listed = await ic.listSessions({ subject: subjectId });
  expect((listed.sessions[0] as { takeCount?: number }).takeCount).toBe(1);

  // RED CONTROL FOR take_count. Moving the flag between one member's rows
  // cannot tell `count(*) WHERE final` from the old `count(DISTINCT
  // member_id)`: both say 1. A second member whose every row has been cleared
  // (as the owner) has takes but no final take, so the two counts now differ —
  // 2 by member, 1 by flag — and take_count must follow the flag. The frozen
  // take set, which settlement digests, must leave that member out too.
  expect((await send(other.token, await sign(other, date, subjectId, "other member"))).status).toBe(201);
  expect((await ic.listSessions({ subject: subjectId })).sessions[0]).toMatchObject({ takeCount: 2 });
  await sql`UPDATE swarm_recommendations SET final = false WHERE session_id = ${sessionId} AND member_id = ${other.memberId}`;
  const [{ byMember }] = await sql<{ byMember: number }[]>`
    SELECT count(DISTINCT member_id)::int AS "byMember" FROM swarm_recommendations WHERE session_id = ${sessionId}`;
  expect(byMember).toBe(2);
  expect((await ic.listSessions({ subject: subjectId })).sessions[0]).toMatchObject({ takeCount: 1 });
  expect((await ic.loadFrozenTakeSet(sessionId))!.takes.map((t) => t.body)).toEqual(["revision one"]);
  expect((await ic.getSessionById(sessionId))!.takes.map((t) => t.body)).toEqual(["revision one"]);

  // The permalink's forward pointer names the final take, whichever revision
  // it is: revision two now points at revision one, and revision one at none.
  expect((await ic.getTakeReceipt(r2!.id))!.supersededBy?.id).toBe(r1!.id);
  expect((await ic.getTakeReceipt(r1!.id))!.supersededBy).toBeNull();
});

// ── 129: the window, not the storage state, freezes a take ──────────────────

test("a member amends twice while the window is open; after window_closes_at a third is refused even though turnover is late", async () => {
  const m = await member();
  const { subjectId, sessionId, date } = await openEpoch("window");
  for (const body of ["first", "second", "third"]) {
    expect((await send(m.token, await sign(m, date, subjectId, body))).status).toBe(201);
  }
  // The instant passes; the scheduler's turnover has not run (§4.6 exhaustion).
  await sql`UPDATE swarm_sessions SET window_closes_at = clock_timestamp() - interval '1 second' WHERE id = ${sessionId}`;
  expect((await sessionRow(sessionId)).state).toBe("collecting");

  const late = await send(m.token, await sign(m, date, subjectId, "too late"));
  expect(late.status).toBe(409);
  expect(late.body.error).toBe("submission window closed");
  const rows = await takeRows(sessionId, m.memberId);
  expect(rows).toHaveLength(3);
  expect(rows.filter((r) => r.final).map((r) => r.body)).toEqual(["third"]);

  // What was final at the close is what settlement reads.
  const turned = await ic.turnOverEpoch(subjectId, sessionId);
  expect(turned.ok).toBe(true);
  const frozen = await ic.loadFrozenTakeSet(sessionId);
  expect(frozen!.takes.map((t) => t.body)).toEqual(["third"]);
  // After the turnover the next take belongs to epoch N+1, the one now
  // collecting — never to N, whose take set stays exactly what was final at
  // its close.
  const afterTurnover = await send(m.token, await sign(m, date, subjectId, "later still"));
  expect(afterTurnover.status).toBe(201);
  expect(await takeRows(sessionId, m.memberId)).toHaveLength(3);
  if (turned.ok) {
    expect((await takeRows(turned.openedSessionId, m.memberId)).map((r) => [r.body, r.final])).toEqual([["later still", true]]);
  }
});

// ── 127 / 126: races ────────────────────────────────────────────────────────

test("two amendments racing through the route are BOTH accepted, in order, and leave exactly one final take", async () => {
  const m = await member();
  const { subjectId, sessionId, date } = await openEpoch("race");
  expect((await send(m.token, await sign(m, date, subjectId, "opening take"))).status).toBe(201);

  // Two containers, one member, each with its own nonce, sent at once.
  const [x, y] = await Promise.all([
    send(m.token, await sign(m, date, subjectId, "container x")),
    send(m.token, await sign(m, date, subjectId, "container y")),
  ]);
  expect([x.status, y.status]).toEqual([201, 201]);
  expect([x.body.revision, y.body.revision].sort()).toEqual([2, 3]);

  const rows = await takeRows(sessionId, m.memberId);
  expect(rows).toHaveLength(3);
  const final = rows.filter((r) => r.final);
  expect(final).toHaveLength(1);
  // The later-accepted one is final: the newest revision.
  expect(final[0]!.revision).toBe(3);
  // The index is what makes that structural; ask it directly.
  const [{ n }] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM swarm_recommendations
     WHERE session_id = ${sessionId} AND member_id = ${m.memberId} AND final`;
  expect(n).toBe(1);
});

test("two copies of ONE signed submission racing add one row, and both are answered with the same record", async () => {
  const m = await member();
  const { subjectId, sessionId, date } = await openEpoch("race_same");
  const bytes = await sign(m, date, subjectId, "sent twice at once");
  const [a, b] = await Promise.all([send(m.token, bytes), send(m.token, bytes)]);
  expect([a.status, b.status].sort()).toEqual([200, 201]);
  expect(a.body.recommendationId).toBe(b.body.recommendationId);
  expect(await takeRows(sessionId, m.memberId)).toHaveLength(1);
});

test("an old and a new container holding DIFFERENT tokens for one member, overlapping across a key rebind, leave ONE final take — because only one token is ever valid, the old one is refused by auth; an identical retry adds no row", async () => {
  const m = await member();
  const { subjectId, sessionId, date } = await openEpoch("overlap");
  const oldContainer: Container = { memberId: m.memberId, token: m.token, privateKey: m.privateKey };

  // The old container files its take.
  const oldBytes = await sign(oldContainer, date, subjectId, "old container's take");
  expect((await send(oldContainer.token, oldBytes)).status).toBe(201);

  // Roster change: the member's credential is rebound. Same keypair, fresh
  // bearer (rotate-key without a new publicKey) — the new container holds the
  // new token, the old container still holds the old one.
  const rotated = await admin.rotateMemberKeyAdmin(m.memberId);
  expect(rotated.ok).toBe(true);
  const newContainer: Container = { memberId: m.memberId, token: (rotated as unknown as { token: string }).token, privateKey: m.privateKey };
  expect(newContainer.token).not.toBe(oldContainer.token);

  // THE MECHANISM, stated as an assertion rather than left to the 401s below:
  // the rebind left exactly ONE active credential for the member, the new one.
  // Two different tokens are never valid at once, so overlapping containers
  // cannot both be accepted — the one-final-take outcome here is decided by
  // auth. (The take path's own race guarantee is the single-token race test.)
  const [{ activeKeys }] = await sql<{ activeKeys: number }[]>`
    SELECT count(*)::int AS "activeKeys" FROM swarm_member_keys
     WHERE member_id = ${m.memberId} AND active AND token_hash IS NOT NULL`;
  expect(activeKeys).toBe(1);
  expect(await ic.memberIdForToken(oldContainer.token)).toBeNull();
  expect(await ic.memberIdForToken(newContainer.token)).toBe(m.memberId);

  // OVERLAP: the old container resends a pending take and authors another,
  // while the new container authors its own — all at once.
  const oldAgain = await sign(oldContainer, date, subjectId, "old container, second thought");
  const newBytes = await sign(newContainer, date, subjectId, "new container's take");
  const [oldResend, oldAmend, fresh] = await Promise.all([
    send(oldContainer.token, oldBytes),
    send(oldContainer.token, oldAgain),
    send(newContainer.token, newBytes),
  ]);
  // The superseded token is refused outright; nothing it sends lands.
  expect(oldResend.status).toBe(401);
  expect(oldAmend.status).toBe(401);
  expect(fresh.status).toBe(201);

  let rows = await takeRows(sessionId, m.memberId);
  expect(rows).toHaveLength(2);
  expect(rows.filter((r) => r.final).map((r) => r.body)).toEqual(["new container's take"]);

  // The identity of a retry is the signed bytes, not the token: the old
  // container's pending submission resent under the new token is the take
  // already on file, and adds nothing.
  const adopted = await send(newContainer.token, oldBytes);
  expect(adopted.status).toBe(200);
  expect(adopted.body.alreadySubmitted).toBe(true);
  // And the new container's own crash-restart resend adds no row either.
  const resent = await send(newContainer.token, newBytes);
  expect(resent.status).toBe(200);
  expect(resent.body).toMatchObject({ alreadySubmitted: true, recommendationId: fresh.body.recommendationId, final: true });

  rows = await takeRows(sessionId, m.memberId);
  expect(rows).toHaveLength(2);
  expect(rows.filter((r) => r.final)).toHaveLength(1);
});

// ── 148: a rebind keeps history verifying and refuses the superseded key ────

async function assertHistoryVerifies(subjectId: string, sessionId: string, memberId: string, ids: string[]) {
  for (const id of ids) {
    const receipt = await ic.getTakeReceipt(id);
    expect(receipt!.take.verified, `getTakeReceipt(${id})`).toBe(true);
  }
  const detail = await ic.getSessionById(sessionId);
  const mine = detail!.takes.filter((t) => t.memberId === memberId);
  expect(mine).toHaveLength(1);
  expect(mine[0]!.verified).toBe(true);
  const record = await ic.getMemberTakes(memberId, 10);
  const inSession = record.takes.filter((t) => t.subjectId === subjectId);
  expect(inSession).toHaveLength(1);
  expect(inSession[0]!.take.verified).toBe(true);
}

for (const rebind of ["rotateMemberKeyAdmin", "registerMember"] as const) {
  test(`after ${rebind} to a NEW key, old takes still verify everywhere, and a new take signed with the superseded key is 403 with no row`, async () => {
    const m = await member();
    const { subjectId, sessionId, date } = await openEpoch(`rebind_${rebind}`);
    const r1 = await send(m.token, await sign(m, date, subjectId, "signed with key one"));
    const r2 = await send(m.token, await sign(m, date, subjectId, "also key one"));
    expect([r1.status, r2.status]).toEqual([201, 201]);

    const next = await generateKeyPair();
    let newToken: string;
    if (rebind === "rotateMemberKeyAdmin") {
      const rotated = await admin.rotateMemberKeyAdmin(m.memberId, { publicKey: next.publicKeyB64 });
      expect(rotated.ok).toBe(true);
      newToken = (rotated as unknown as { token: string }).token;
    } else {
      const again = await ic.registerMember({ memberId: m.memberId, name: m.memberId, publicKey: next.publicKeyB64 });
      if (!("token" in again) || !again.token) throw new Error(`re-register failed: ${JSON.stringify(again)}`);
      newToken = again.token;
    }

    // HISTORY: both old takes verify through every read that serves them,
    // against the key that signed them (signing_key_id), not the active one.
    await assertHistoryVerifies(subjectId, sessionId, m.memberId, [r1.body.recommendationId, r2.body.recommendationId]);

    // A NEW take signed with the superseded private key, sent under the
    // member's CURRENT token (the old token no longer authenticates at all).
    const stale = await send(newToken, await sign(m, date, subjectId, "old key, new token"));
    expect(stale.status).toBe(403);
    expect(stale.body.error).toContain("signing_key_superseded");
    expect(await takeRows(sessionId, m.memberId)).toHaveLength(2);

    // RED CONTROL: the current key is accepted, so the 403 is about the key.
    const current = await send(newToken, await sign({ memberId: m.memberId, privateKey: next.privateKey }, date, subjectId, "new key"));
    expect(current.status).toBe(201);
    // …and a signature over tampered bytes is still the 400 it always was.
    const forged = await sign({ memberId: m.memberId, privateKey: next.privateKey }, date, subjectId, "forged");
    const tampered = await send(newToken, { ...forged, body: "not what was signed" });
    expect(tampered.status).toBe(400);
    await assertHistoryVerifies(subjectId, sessionId, m.memberId, [r1.body.recommendationId, r2.body.recommendationId]);
  });
}
