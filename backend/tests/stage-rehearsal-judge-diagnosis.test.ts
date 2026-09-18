// F4/T19 + T28 — THE TWO WAYS THE REHEARSAL GATE COULD NOT SEE WHAT IT GUARDS.
//
// Written before the fix (QA plan §12.7.2).
//
// T19. The gate's only defence against credential/credit-poisoned evidence was
// `isDisqualifyingFallbackReason`, and judge.ts fails CLOSED on exactly those
// reasons — no judgement row, no receipt, nothing for the success-side poll to
// read. The real failure surfaced as "timed out: no post-rehearsal receipt row"
// after fifteen idle minutes, indistinguishable from a slow publish. The lane's
// own `jobs.last_error` carries the class the whole time.
//
// T28. `waitForVerifiedFusionReceipt` is thoroughly tested, but every test
// injects `latest` — so the one part that could be wrong, the query in main(),
// executed in NO test. It resolved the reason with `ORDER BY j.created_at DESC
// LIMIT 1`: the session's LATEST judgement, not the one
// `swarm_consensus_receipts.judgement_id` says the receipt was assembled from.
// A re-judge or a shadow-then-enforce sequence makes that refuse a good receipt
// or clear a bad one.
import { expect, test, describe } from "bun:test";
import { RECEIPT_DOMAIN_SEPARATOR } from "@robotmoney/contract";
import { sql } from "../src/db/client.ts";
// A database of its own: these cases seed receipts and judge jobs and then ask
// "what is the LATEST one", which is a question every other file's rows would
// otherwise answer.
import { useCleanDatabase } from "./support/clean-db.ts";
import {
  DISQUALIFYING_FALLBACK_REASONS,
  FAIL_FAST_JUDGE_LANE_REASONS,
  failFastJudgeReason,
  isDisqualifyingFallbackReason,
  latestFusionReceiptCandidate,
  latestJudgeLaneFailure,
  waitForVerifiedFusionReceipt,
} from "../scripts/upgrades/0.4.0-to-0.5.0/stage-rehearsal.ts";

useCleanDatabase(import.meta.file);

// Since D10 the rehearsal polls BOTH receipt routes — the bare anchored bytes
// at `/consensus-receipt` and the envelope at `/consensus-receipt/verified` —
// so a healthy double has to answer both. A single-route stub leaves the poll
// looping until its deadline, which is what this file is about NOT doing.
const BARE = '{"schema_version":"1.0"}\n';
const ok = async (url: string | URL) =>
  String(url).endsWith("/verified")
    ? Response.json({ verified: true, canonicalBytes: RECEIPT_DOMAIN_SEPARATOR + BARE, signatures: [{ verified: true }] })
    : new Response(BARE);

describe("T18/D15 — model_timeout disqualifies rehearsal evidence", () => {
  test("model_timeout is on the disqualifying list", () => {
    expect(DISQUALIFYING_FALLBACK_REASONS).toContain("model_timeout");
    expect(isDisqualifyingFallbackReason("model_timeout")).toBe(true);
  });

  test("a receipt whose judgement timed out is refused, not accepted as an outage fallback", async () => {
    await expect(waitForVerifiedFusionReceipt({
      backendUrl: "http://stage.invalid",
      latest: async () => ({ sessionId: "s-timeout", source: "fallback", mode: "enforce", fallbackReason: "model_timeout" }),
      fetcher: ok,
    })).rejects.toThrow(/model_timeout/);
  });

  test("model_timeout is NOT a lane fail-fast class — it produces a receipt, not a closed judge", () => {
    expect(FAIL_FAST_JUDGE_LANE_REASONS).not.toContain("model_timeout");
  });
});

describe("T19 — the fail-closed classes are diagnosed from the lane, not waited out", () => {
  test.each([...FAIL_FAST_JUDGE_LANE_REASONS])("%s in last_error is named immediately", (reason) => {
    expect(failFastJudgeReason(`judge_unavailable:${reason}`)).toBe(reason);
  });

  test("an unrelated lane error is not a fail-fast class", () => {
    expect(failFastJudgeReason("judge_unavailable:response_unparseable")).toBeNull();
    expect(failFastJudgeReason(null)).toBeNull();
    expect(failFastJudgeReason("")).toBeNull();
  });

  test("the poll fails fast on the lane failure instead of running out its deadline", async () => {
    const started = Date.now();
    await expect(waitForVerifiedFusionReceipt({
      backendUrl: "http://stage.invalid",
      timeoutMs: 30_000,
      pollMs: 1,
      latest: async () => null,
      failure: async () => ({ jobId: 83, sessionId: "s-1", lastError: "judge_unavailable:credit_exhausted", failFastReason: "credit_exhausted" }),
      fetcher: ok,
    })).rejects.toThrow(/credit_exhausted/);
    // The point of the change: it does not sit on the deadline.
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("a lane failure with no fail-fast class does not abort a healthy rehearsal", async () => {
    const result = await waitForVerifiedFusionReceipt({
      backendUrl: "http://stage.invalid",
      pollMs: 1,
      latest: async () => ({ sessionId: "s-ok", source: "model", mode: "enforce" }),
      failure: async () => ({ jobId: 9, sessionId: "s-ok", lastError: "terminal_state:published", failFastReason: null }),
      fetcher: ok,
    });
    expect(result.sessionId).toBe("s-ok");
  });
});

// ── T28: the real queries, against the real database ───────────────────────
const SUBJECT = "rehearsal-judgement-subject";

async function seedJudgement(sessionId: string, opts: { source: string; reason: string | null; mode?: string }): Promise<number> {
  const [row] = (await sql`
    INSERT INTO swarm_session_judgements
      (session_id, mode, source, fallback_reason, model, prompt_hash, inputs_digest, take_count, min_takes, opinion)
    VALUES (${sessionId}, ${opts.mode ?? "enforce"}, ${opts.source}, ${opts.reason}, 'deepseek-v4-flash',
            'prompt-hash', 'inputs-digest', 3, 1, ${sql.json({ summary: "x" } as never)})
    RETURNING id`) as unknown as { id: string }[];
  return Number(row!.id);
}

async function seedSession(): Promise<string> {
  await sql`INSERT INTO swarm_subjects (id, name) VALUES (${SUBJECT}, 'Rehearsal Judgement Subject') ON CONFLICT (id) DO NOTHING`;
  const [s] = (await sql`
    INSERT INTO swarm_sessions (subject_id, convened_at, subject_name, state)
    VALUES (${SUBJECT}, now(), 'Rehearsal Judgement Subject', 'published') RETURNING id`) as unknown as { id: string }[];
  return s!.id;
}

async function seedReceipt(sessionId: string, judgementId: number, judge: { source: string; mode: string }): Promise<void> {
  await sql`
    INSERT INTO swarm_consensus_receipts (session_id, subject_id, schema_version, judgement_id, session_version, receipt, canonical_bytes)
    VALUES (${sessionId}, ${SUBJECT}, '1.0', ${judgementId}, 1,
            ${sql.json({ schema_version: "1.0", session_id: sessionId, subject_id: SUBJECT, judge } as never)},
            ${`robotmoney:consensus-receipt:v1\n{"session_id":"${sessionId}"}\n`})`;
}

test("the rehearsal reads the receipt's OWN judgement, not the session's latest", async () => {
  const since = new Date(Date.now() - 60_000);
  const sessionId = await seedSession();
  // The judgement the receipt was assembled from: a clean model judging.
  const own = await seedJudgement(sessionId, { source: "model", reason: null });
  await seedReceipt(sessionId, own, { source: "model", mode: "enforce" });
  // A LATER judgement on the same session — a re-judge after the credential
  // lapsed. The receipt does not attest to it and the gate must not read it.
  await seedJudgement(sessionId, { source: "fallback", reason: "credit_exhausted" });

  const candidate = await latestFusionReceiptCandidate(sql, since);
  expect(candidate?.sessionId).toBe(sessionId);
  expect(candidate?.fallbackReason ?? null).toBeNull();
  expect(isDisqualifyingFallbackReason(candidate?.fallbackReason)).toBe(false);
});

test("the mirror case: a poisoned receipt is NOT cleared by a later clean judgement", async () => {
  const since = new Date(Date.now() - 60_000);
  const sessionId = await seedSession();
  const own = await seedJudgement(sessionId, { source: "fallback", reason: "credit_exhausted" });
  await seedReceipt(sessionId, own, { source: "fallback", mode: "enforce" });
  await seedJudgement(sessionId, { source: "model", reason: null });

  const candidate = await latestFusionReceiptCandidate(sql, since);
  expect(candidate?.sessionId).toBe(sessionId);
  expect(candidate?.fallbackReason).toBe("credit_exhausted");
  expect(isDisqualifyingFallbackReason(candidate?.fallbackReason)).toBe(true);
});

test("the lane query names the fail-closed class from jobs.last_error", async () => {
  const sessionId = await seedSession();
  await sql`
    INSERT INTO jobs (kind, scope_type, scope_id, dedupe_key, payload, status, attempts, last_error)
    VALUES ('swarm.judge', 'swarm_session', ${sessionId}, ${`judge-diag-${sessionId}`},
            ${sql.json({ sessionId } as never)}, 'succeeded', 5, 'judge_unavailable:credit_exhausted')`;
  const failure = await latestJudgeLaneFailure(sql, new Date(Date.now() - 60_000));
  expect(failure?.failFastReason).toBe("credit_exhausted");
  expect(failure?.lastError).toContain("credit_exhausted");
});
