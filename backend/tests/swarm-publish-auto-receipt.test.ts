// THE CADENCE PUBLISHES ITS OWN RECEIPT — NO ADMIN CALL REQUIRED.
//
// Before this, `swarm.publish` (worker/handlers/swarm.ts) left a judged
// session's consensus receipt for an operator to request separately
// (admin.publishConsensusReceiptAdmin, `POST .../consensus-receipt`) — by
// original design (admin.ts's own comment on issue #754: wiring assembly into
// every publish would make an `off`-mode swarm's ordinary publish an assembly
// that refuses). That reasoning is exactly why folding it in is safe now:
// `publishConsensusReceiptAdmin` already turns every refusal into an
// `{ok:false, error}` result instead of throwing, so an `off`- or `shadow`-mode
// publish still completes cleanly — this file's second test is the proof.
//
// Reuses consensus-receipt-publish.test.ts's fixture shape (a bucket-weighted,
// two-member session) rather than importing its private helpers, so this file
// stays a clean regression pin for one thing: the CADENCE PATH
// (`worker/handlers/swarm.ts publishSession`), not the admin ladder.
import { expect, test } from "bun:test";
import * as admin from "../src/swarm/admin.ts";
import * as ic from "../src/swarm/domain.ts";
import { canonicalizeSubmission } from "@robotmoney/contract";
import { sql } from "../src/db/client.ts";
import { generateKeyPair, signMessage } from "../src/lib/signing.ts";
import { setJudgeConfig } from "../src/swarm/judge-session.ts";
import { publishSession as publishSessionJob } from "../src/worker/handlers/swarm.ts";
import { useCleanDatabasePerTest } from "./support/clean-db.ts";

useCleanDatabasePerTest(import.meta.file);

const rid = (p: string) => `${p}_${crypto.randomUUID().slice(0, 8)}`;
const CANONICAL_FOUR = ["agent_tokens", "conservative_defi_yield", "protocol_tokens", "real_world_assets"];

async function member() {
  const id = rid("m");
  const { publicKeyB64, privateKey } = await generateKeyPair();
  const r = await ic.registerMember({ memberId: id, name: id, publicKey: publicKeyB64 });
  if (!("token" in r) || !r.token) throw new Error(`member() failed: ${JSON.stringify(r)}`);
  return { id, token: r.token, privateKey };
}
type Member = Awaited<ReturnType<typeof member>>;

async function submit(m: Member, date: string, subjectId: string, weights: number[]) {
  const sub = {
    memberId: m.id, date, subjectId, nonce: rid("n"),
    stance: "neutral", confidence: 0.5, body: `${m.id} take`,
    weights: CANONICAL_FOUR.map((bucket, i) => ({ bucket, weight: weights[i]! })),
  };
  const signature = await signMessage(canonicalizeSubmission(sub), m.privateKey);
  const res = await ic.submitRecommendation(m.token, { ...sub, signature });
  if (res.status !== 201) throw new Error(`submit failed: ${JSON.stringify(res)}`);
}

/** A judged (real, per-mode) session, positioned right before publish. */
async function judgedButUnpublished(prefix: string, mode: "shadow" | "enforce") {
  const subjectId = rid(prefix);
  await ic.ensureSubject(subjectId, `${prefix} subject`);
  await sql`UPDATE swarm_subjects SET recommendation_type = 'bucket_weights' WHERE id = ${subjectId}`;
  await setJudgeConfig({ mode, minTakes: 2 });
  const session = await ic.openSession(subjectId);
  await ic.publishBrief(session.id, 60);
  const date = session.date instanceof Date ? session.date.toISOString().slice(0, 10) : String(session.date).slice(0, 10);
  for (const weights of [[70, 10, 10, 10], [60, 20, 10, 10]]) {
    await submit(await member(), date, subjectId, weights);
  }
  const closed = await admin.closeSessionAdmin(session.id, undefined);
  if (!closed.ok) throw new Error(`close failed: ${JSON.stringify(closed)}`);
  const aggregated = await admin.aggregateSessionAdmin(session.id, undefined);
  if (!aggregated.ok) throw new Error(`aggregate failed: ${JSON.stringify(aggregated)}`);
  // No model configured: the judge takes its template-fallback path.
  const judged = await admin.judgeSessionAdmin(session.id, undefined);
  if (!judged.ok) throw new Error(`judge failed: ${JSON.stringify(judged)}`);
  return session.id;
}

const receiptRow = async (sessionId: string) =>
  (await sql`SELECT session_id FROM swarm_consensus_receipts WHERE session_id = ${sessionId}`)[0] ?? null;

test("swarm.publish (the cadence path) auto-publishes the receipt for an enforce-judged session — no admin call", async () => {
  const sessionId = await judgedButUnpublished("auto-receipt-enforce", "enforce");
  expect(await receiptRow(sessionId), "nothing exists before publish").toBeNull();

  const result = (await publishSessionJob({ sessionId })) as { state: string; consensusReceipt: { published: boolean } };
  expect(result.state).toBe("published");
  expect(result.consensusReceipt).toEqual({ published: true });

  const row = await receiptRow(sessionId);
  expect(row, "the worker itself wrote the receipt — no admin.publishConsensusReceiptAdmin call in this test").not.toBeNull();
});

test("swarm.publish still completes cleanly for a shadow-judged session — no receipt to attest to, no thrown error", async () => {
  const sessionId = await judgedButUnpublished("auto-receipt-shadow", "shadow");

  const result = (await publishSessionJob({ sessionId })) as {
    state: string;
    consensusReceipt: { published: boolean; reason?: string };
  };
  expect(result.state).toBe("published");
  // Structural, not a bug this patch could remove: a shadow judgement is
  // deliberately withheld from the session (consensus-receipt.ts), so there is
  // no opinion the session adopted for a receipt to embed.
  expect(result.consensusReceipt).toEqual({ published: false, reason: "judgement_not_adopted" });
  // The expected-refusal allowlist leaves the RUN successful: no `ok`, so
  // loop.ts's isDegradedResult() does not match and the cadence is not retried.
  expect(result).not.toHaveProperty("ok");
  expect(await receiptRow(sessionId)).toBeNull();
});

test("a receipt refusal that is NOT an expected one degrades the run instead of reporting success", async () => {
  // `no_session` stands in for the whole assembly-failure family (no_takes,
  // schema_invalid, canonicalization_failed, the weights_* reasons): it is the
  // one that needs no key material to provoke, and it takes the same branch.
  // Before this, EVERY refusal returned a result with no `ok` field, so
  // isDegradedResult() never matched and a broken receipt path was recorded as
  // a SUCCEEDED publish carrying a quiet `published: false` — the feature could
  // stop producing receipts in production with nothing to alert on.
  // A well-formed id that matches no row: `swarm_sessions.id` is a uuid, so a
  // non-uuid string fails in the UPDATE before assembly is ever reached.
  const result = (await publishSessionJob({ sessionId: crypto.randomUUID() })) as {
    ok?: boolean;
    error?: string;
    consensusReceipt: { published: boolean; reason?: string };
  };
  expect(result.consensusReceipt).toEqual({ published: false, reason: "no_session" });
  expect(result.ok, "loop.ts's isDegradedResult() matches on ok === false").toBe(false);
  expect(result.error).toContain("no_session");
});
