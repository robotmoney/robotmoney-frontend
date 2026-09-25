// Judge spend comes from the participant that made the model call (issue #1026;
// D55 decision 3, R19).
//
//   "Judge spend (R19) is filled from the usage the participant judge reports
//    with its judgement. ... The participant now makes the model call, so it is
//    the only process that knows what the call cost."
//
// This is the SERVER half: the judgement submission route accepts an optional
// `usage` block `{ inputTokens, outputTokens, totalTokens, costUsd }`, validates
// it, and writes the four `usage_*` columns of `swarm_session_judgements`
// (migration 0059) in the judgement's own transaction. Absent usage stores NULL
// — never 0, which would claim the call was free. A malformed block refuses the
// whole judgement and writes nothing.
//
// Every submission goes through the real participant route
// (`POST …/participants/judgement`, through the swarm dispatcher), signed by a
// seated in-house judge exactly as scripts/agent/participant/judge-client.ts
// signs one.
import { expect, test } from "bun:test";
import { ROUTES } from "@robotmoney/contract";
import { sql } from "../src/db/client.ts";
import * as ic from "../src/swarm/domain.ts";
import { handleSwarm } from "../src/api/routes/swarm.ts";
import { useCleanDatabasePerTest } from "./support/clean-db.ts";
import { activeMember, activeSubject, sessionDate, sessionRow, submitTake } from "./support/epoch-fixtures.ts";
import { enforceJudging, requestJudgingFor, seatJudge, signedJudgement, type TestJudge } from "./support/stub-judge.ts";

useCleanDatabasePerTest(import.meta.file);

/** A session in `judging` with one take on file, and the judge that owes it. */
async function judgingSession(prefix: string): Promise<{ sessionId: string; judge: TestJudge }> {
  // The judge is seated BEFORE the epoch opens, so it holds no take seat.
  const judge = await seatJudge({ prefix: `${prefix}_judge` });
  const subjectId = await activeSubject(prefix, 3600);
  await enforceJudging();
  const opened = await ic.openEpoch(subjectId);
  if (!opened.ok) throw new Error(`openEpoch: ${JSON.stringify(opened)}`);
  const m = await activeMember();
  const took = await submitTake(m, sessionDate(await sessionRow(opened.sessionId)), subjectId, { body: "a take to judge" });
  if (!took.ok) throw new Error(`submitTake: ${JSON.stringify(took)}`);
  const turned = await ic.turnOverEpoch(subjectId, opened.sessionId);
  if (!turned.ok) throw new Error(`turnOverEpoch: ${JSON.stringify(turned)}`);
  const aggregated = await ic.aggregateEpoch(opened.sessionId);
  if (!aggregated.ok) throw new Error(`aggregateEpoch: ${JSON.stringify(aggregated)}`);
  await requestJudgingFor(opened.sessionId);
  return { sessionId: opened.sessionId, judge };
}

async function submitViaRoute(judge: TestJudge, body: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const url = `http://localhost${ROUTES.swarm.participants.judgement}`;
  const res = await handleSwarm(
    new Request(url, {
      method: "POST",
      headers: { authorization: `Bearer ${judge.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    new URL(url),
  );
  if (!res || res instanceof Response) throw new Error("judgement route did not answer with an envelope");
  return res as { status: number; body: any };
}

const spendRows = async (sessionId: string) => [...(await sql<{
  usage_input_tokens: number | null;
  usage_output_tokens: number | null;
  usage_total_tokens: number | null;
  usage_cost_usd: string | null;
}[]>`
  SELECT usage_input_tokens, usage_output_tokens, usage_total_tokens, usage_cost_usd
    FROM swarm_session_judgements WHERE session_id = ${sessionId}`)];

test("a judgement's reported usage is written to the four spend columns, in the judgement's transaction", async () => {
  const { sessionId, judge } = await judgingSession("spend_present");
  const signed = await signedJudgement(judge, sessionId);
  const res = await submitViaRoute(judge, {
    ...signed,
    usage: { inputTokens: 1834, outputTokens: 412, totalTokens: 2246, costUsd: 0.01234567 },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expect(res.body.applied).toBe(true);

  const rows = await spendRows(sessionId);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.usage_input_tokens).toBe(1834);
  expect(rows[0]!.usage_output_tokens).toBe(412);
  expect(rows[0]!.usage_total_tokens).toBe(2246);
  expect(Number(rows[0]!.usage_cost_usd)).toBeCloseTo(0.01234567, 8);
});

test("absent usage stores NULL in every spend column — never 0", async () => {
  const { sessionId, judge } = await judgingSession("spend_absent");
  const res = await submitViaRoute(judge, { ...(await signedJudgement(judge, sessionId)) });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expect(await spendRows(sessionId)).toEqual([
    { usage_input_tokens: null, usage_output_tokens: null, usage_total_tokens: null, usage_cost_usd: null },
  ]);
});

test("a partial usage block stores what was reported and NULL for the rest", async () => {
  const { sessionId, judge } = await judgingSession("spend_partial");
  const res = await submitViaRoute(judge, { ...(await signedJudgement(judge, sessionId)), usage: { totalTokens: 900 } });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expect(await spendRows(sessionId)).toEqual([
    { usage_input_tokens: null, usage_output_tokens: null, usage_total_tokens: 900, usage_cost_usd: null },
  ]);
});

test("malformed usage refuses the WHOLE judgement with a named reason, and writes no row", async () => {
  const { sessionId, judge } = await judgingSession("spend_malformed");
  const cases: [unknown, string][] = [
    [{ inputTokens: -1 }, "usage_malformed:inputTokens"],
    [{ outputTokens: 1.5 }, "usage_malformed:outputTokens"],
    [{ totalTokens: "900" }, "usage_malformed:totalTokens"],
    [{ totalTokens: 10_000_001 }, "usage_malformed:totalTokens"],
    [{ costUsd: -0.01 }, "usage_malformed:costUsd"],
    [{ costUsd: Number.POSITIVE_INFINITY }, "usage_malformed:costUsd"],
    [{ costUsd: 10_001 }, "usage_malformed:costUsd"],
    [{ inputTokens: 5, dollars: 3 }, "usage_malformed:unknown_field:dollars"],
    ["2246 tokens", "usage_malformed:not_an_object"],
    [[1, 2, 3], "usage_malformed:not_an_object"],
  ];
  for (const [usage, error] of cases) {
    // JSON has no Infinity (it would arrive as null, "not reported"), so that
    // one is asserted on the domain validator the route calls, not sent.
    if (usage && typeof usage === "object" && (usage as { costUsd?: number }).costUsd === Number.POSITIVE_INFINITY) {
      expect(ic.parseJudgementUsage(usage)).toEqual({ ok: false, error });
      continue;
    }
    const res = await submitViaRoute(judge, { ...(await signedJudgement(judge, sessionId)), usage });
    expect(res.status, JSON.stringify(usage)).toBe(400);
    expect(res.body.error, JSON.stringify(usage)).toBe(error);
  }
  expect(await spendRows(sessionId)).toHaveLength(0);
  expect((await sessionRow(sessionId)).state).toBe("judging");

  // RED CONTROL: the same judge, the same session, a well-formed block — lands.
  const ok = await submitViaRoute(judge, { ...(await signedJudgement(judge, sessionId)), usage: { inputTokens: 10, costUsd: 0 } });
  expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  expect(await spendRows(sessionId)).toEqual([
    { usage_input_tokens: 10, usage_output_tokens: null, usage_total_tokens: null, usage_cost_usd: "0.00000000" },
  ]);
});
