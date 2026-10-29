// Issue #977 AC8: the analytics run-ledger HTTP boundary — analytics-provider
// authentication, whole-body validation before any transaction opens,
// idempotent retry semantics, rejection of a second conflicting freeze, and
// readback of the exact frozen manifest. Drives the REAL route handlers and
// SQL stores through handleAnalytics against real ephemeral Postgres.
import { test, expect, beforeAll } from "bun:test";
import { ROUTES } from "@robotmoney/contract";
import { sql } from "../../src/db/client.ts";
import { handleAnalytics } from "../../src/api/routes/analytics.ts";
import { REGIME_STORAGE_KEYS, loadHistoricalSourceValues } from "../../src/analytics/store/run-ledger-store.ts";
import { saveSourceAcquisition } from "../../src/analytics/store/source-ledger-store.ts";
import { useCleanDatabase } from "../support/clean-db.ts";
import { provisionAnalyticsToken, provisionOperatorToken } from "../support/automation-auth.ts";

useCleanDatabase(import.meta.file);

const A = ROUTES.analytics;
let TOKEN = "";
let ADMIN = "";

// Store-issued, like the real credentials (smoke spec §3, D52 (1)): the
// producer's token is the only one the analytics boundary accepts, and the
// operator's admin token is refused there, in every env.
beforeAll(async () => {
  TOKEN = await provisionAnalyticsToken();
  ADMIN = await provisionOperatorToken();
});

function req(method: string, path: string, body?: unknown, token?: string): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token !== undefined) headers.Authorization = `Bearer ${token}`;
  return new Request(`http://x${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}
const call = (r: Request) => handleAnalytics(r, new URL(r.url));

function runBody(overrides: Record<string, unknown> = {}) {
  return {
    run: {
      runKey: crypto.randomUUID(),
      asof: "2026-05-15",
      toolId: "api-test",
      sourceLabel: "fixture",
      methodology: { toolId: "api-test", versionLabel: "v-test", config: { k: "v" } },
      buildIdentity: "api-test-build",
      ...overrides,
    },
  };
}

async function beginRunViaApi(overrides: Record<string, unknown> = {}): Promise<{ runId: string; methodologyVersionId: string }> {
  const res = await call(req("POST", A.runs, runBody(overrides), TOKEN));
  expect(res!.status).toBe(200);
  return res!.body as { runId: string; methodologyVersionId: string };
}

test("POST runs (begin run): analytics-provider auth is required, and no header row exists without a valid token", async () => {
  const body = runBody();
  expect((await call(req("POST", A.runs, body)))?.status).toBe(401);
  expect((await call(req("POST", A.runs, body, ADMIN)))?.status).toBe(403);
  expect((await call(req("POST", A.runs, body, "member-token")))?.status).toBe(403);
  const [{ before }] = await sql`SELECT count(*)::int AS before FROM analytics_ledger_runs`;
  expect(before).toBe(0);

  const ok = await call(req("POST", A.runs, body, TOKEN));
  expect(ok!.status).toBe(200);
  expect((ok!.body as any).replayed).toBe(false);
  const [{ after }] = await sql`SELECT count(*)::int AS after FROM analytics_ledger_runs`;
  expect(after).toBe(1);
});

test("POST runs: the WHOLE body is validated before any transaction opens — a malformed payload writes nothing", async () => {
  // Delta, not an absolute count: this file's OTHER tests share one database
  // (useCleanDatabase is per-file) and may already have written a header.
  const [{ n: before }] = await sql`SELECT count(*)::int AS n FROM analytics_ledger_runs`;

  const bad = runBody({ runKey: "not-a-uuid" });
  const res = await call(req("POST", A.runs, bad, TOKEN));
  expect(res!.status).toBe(400);

  const badMethodology = runBody({ methodology: { toolId: "x" } }); // missing versionLabel/config
  expect((await call(req("POST", A.runs, badMethodology, TOKEN)))?.status).toBe(400);
  const badAsof = runBody({ asof: "not-a-date" });
  expect((await call(req("POST", A.runs, badAsof, TOKEN)))?.status).toBe(400);
  const badSource = runBody({ sourceLabel: "made-up" });
  expect((await call(req("POST", A.runs, badSource, TOKEN)))?.status).toBe(400);

  const [{ n: after }] = await sql`SELECT count(*)::int AS n FROM analytics_ledger_runs`;
  expect(after).toBe(before); // every rejected payload wrote nothing
});

test("POST runs: idempotent retry on the SAME runKey replays the existing header rather than creating a second one", async () => {
  const body = runBody();
  const first = await call(req("POST", A.runs, body, TOKEN));
  expect(first!.status).toBe(200);
  expect((first!.body as any).replayed).toBe(false);
  const second = await call(req("POST", A.runs, body, TOKEN));
  expect(second!.status).toBe(200);
  expect((second!.body as any).replayed).toBe(true);
  expect((second!.body as any).runId).toBe((first!.body as any).runId);
  const [{ n }] = await sql`SELECT count(*)::int AS n FROM analytics_ledger_runs WHERE run_key = ${body.run.runKey}`;
  expect(n).toBe(1);
});

test("POST runs: a genuinely CONCURRENT duplicate submission (not just a sequential retry) is still idempotent, not an unhandled 23505", async () => {
  const body = runBody();
  // Fire both requests together so they race on the same run_key uniqueness
  // check, rather than one completing before the other starts.
  const [a, b] = await Promise.all([
    call(req("POST", A.runs, body, TOKEN)),
    call(req("POST", A.runs, body, TOKEN)),
  ]);
  expect(a!.status).toBe(200);
  expect(b!.status).toBe(200);
  const replayedFlags = [(a!.body as any).replayed, (b!.body as any).replayed].sort();
  expect(replayedFlags).toEqual([false, true]); // exactly one winner, one idempotent replay
  expect((a!.body as any).runId).toBe((b!.body as any).runId);
  const [{ n }] = await sql`SELECT count(*)::int AS n FROM analytics_ledger_runs WHERE run_key = ${body.run.runKey}`;
  expect(n).toBe(1);
});

test("POST runs/events (append event): auth required, whole-body validated, and events land in order", async () => {
  const { runId } = await beginRunViaApi();

  const eventBody = { event: { runId, eventType: "started", detail: null } };
  expect((await call(req("POST", A.runEvents, eventBody)))?.status).toBe(401);
  expect((await call(req("POST", A.runEvents, eventBody, ADMIN)))?.status).toBe(403);

  const bad = { event: { runId, eventType: "not-a-real-status", detail: null } };
  expect((await call(req("POST", A.runEvents, bad, TOKEN)))?.status).toBe(400);
  const [{ n: zero }] = await sql`SELECT count(*)::int AS n FROM analytics_ledger_run_events WHERE run_id = ${runId}::bigint`;
  expect(zero).toBe(0);

  expect((await call(req("POST", A.runEvents, eventBody, TOKEN)))?.status).toBe(200);
  expect((await call(req("POST", A.runEvents, { event: { runId, eventType: "succeeded", detail: null } }, TOKEN)))?.status).toBe(200);
  const events = await sql`SELECT sequence, event_type FROM analytics_ledger_run_events WHERE run_id = ${runId}::bigint ORDER BY sequence`;
  expect(events.map((e) => e.event_type)).toEqual(["started", "succeeded"]);
});

function vintageBody(runId: string, methodologyVersionId: string, overrides: Record<string, unknown> = {}) {
  return {
    vintage: {
      runId, toolId: "api-test",
      knowledgeTimeCutoff: "2026-06-01T00:00:00.000Z",
      marketTimeCutoff: "2026-05-15",
      methodologyVersionId,
      buildIdentity: "api-test-build",
      ...overrides,
    },
  };
}

test("POST vintages (freeze): auth required, whole-body validated, idempotent retry, rejection of a second CONFLICTING freeze, and exact-manifest readback", async () => {
  const { runId, methodologyVersionId } = await beginRunViaApi({ runKey: crypto.randomUUID(), asof: "2026-05-16", toolId: "vintage-test" });
  const body = vintageBody(runId, methodologyVersionId, { toolId: "vintage-test" });

  expect((await call(req("POST", A.vintages, body)))?.status).toBe(401);
  expect((await call(req("POST", A.vintages, body, ADMIN)))?.status).toBe(403);

  const badRunId = vintageBody("not-a-number", methodologyVersionId, { toolId: "vintage-test" });
  expect((await call(req("POST", A.vintages, badRunId, TOKEN)))?.status).toBe(400);
  const [{ n: zero }] = await sql`SELECT count(*)::int AS n FROM analytics_data_vintages`;
  expect(zero).toBe(0);

  const first = await call(req("POST", A.vintages, body, TOKEN));
  expect(first!.status).toBe(200);
  const firstBody = first!.body as { vintageId: string; manifest: { manifestDigest: string }; replayed: boolean };
  expect(firstBody.replayed).toBe(false);

  // Idempotent retry: the identical request again replays the SAME vintage.
  const retry = await call(req("POST", A.vintages, body, TOKEN));
  expect(retry!.status).toBe(200);
  const retryBody = retry!.body as { vintageId: string; replayed: boolean };
  expect(retryBody.vintageId).toBe(firstBody.vintageId);
  expect(retryBody.replayed).toBe(true);
  const [{ n: still }] = await sql`SELECT count(*)::int AS n FROM analytics_data_vintages WHERE run_id = ${runId}::bigint`;
  expect(still).toBe(1); // never a second row for the same (run, tool)

  // A DIFFERING resubmission for the same (runId, toolId) is a conflict, 409 — never a silent overwrite.
  const conflicting = vintageBody(runId, methodologyVersionId, { toolId: "vintage-test", marketTimeCutoff: "2026-05-10" });
  const conflict = await call(req("POST", A.vintages, conflicting, TOKEN));
  expect(conflict!.status).toBe(409);
  const [{ n: stillOne }] = await sql`SELECT count(*)::int AS n FROM analytics_data_vintages WHERE run_id = ${runId}::bigint`;
  expect(stillOne).toBe(1);

  // Readback (GET) returns EXACTLY the frozen manifest.
  const readback = await call(req("GET", `${A.vintage}?runId=${runId}&toolId=vintage-test`, undefined, TOKEN));
  expect(readback!.status).toBe(200);
  const vintage = (readback!.body as any).vintage;
  expect(vintage.vintageId).toBe(firstBody.vintageId);
  expect(vintage.manifest.manifestDigest).toBe(firstBody.manifest.manifestDigest);
  expect(vintage.manifestDigest).toBe(firstBody.manifest.manifestDigest);
});

test("GET vintage: unauthorized without a token, and 404 for a (runId, toolId) that was never frozen", async () => {
  const { runId } = await beginRunViaApi({ runKey: crypto.randomUUID(), asof: "2026-05-17", toolId: "never-frozen" });
  expect((await call(req("GET", `${A.vintage}?runId=${runId}&toolId=never-frozen`)))?.status).toBe(401);
  expect((await call(req("GET", `${A.vintage}?runId=${runId}&toolId=never-frozen`, undefined, TOKEN)))?.status).toBe(404);
});

// Issue 1534: vintage.regimeVersionIds, the exact versions a regime run read.
async function record(sourceKey: string, values: { date: string; value: number }[]): Promise<string[]> {
  const saved = await saveSourceAcquisition({
    id: crypto.randomUUID(), provider: "fixture", parserVersion: "fixture:1", cacheIdentity: "api-1534",
    requestedByRunId: null, events: [], fetches: [],
    values: values.map((v) => ({ sourceKey, marketDate: v.date, marketInstant: null, value: v.value, provenance: "seed" })),
  });
  return saved.committed!.map((c) => c.versionId);
}
// The sleeps keep rows a clear millisecond from the clock: postgres.js binds a
// timestamptz parameter through a JS Date, which keeps only milliseconds.
const dbClock = async () => {
  await Bun.sleep(5);
  const t = (await sql<{ t: string }[]>`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS t`)[0]!.t;
  await Bun.sleep(5);
  return t;
};
const vintageCount = async () => (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM analytics_data_vintages`)[0]!.n;

test("POST vintages with regimeVersionIds: every id a committed read could not have returned answers 400 and writes no vintage; a valid list freezes exactly those ids", async () => {
  const VIX = "raw_indicator_history:VIX";
  expect(REGIME_STORAGE_KEYS).toContain(VIX);
  const heads = await record(VIX, [{ date: "2026-05-01", value: 10 }, { date: "2026-05-02", value: 11 }]);
  const [revised] = await record(VIX, [{ date: "2026-05-02", value: 50 }]);
  const [afterMarket] = await record(VIX, [{ date: "2026-05-20", value: 12 }]);
  const [nonRegime] = await record("api-1534:not-regime", [{ date: "2026-05-01", value: 1 }]);
  const cutoff = await dbClock();
  const [afterKnowledge] = await record(VIX, [{ date: "2026-05-03", value: 13 }]);
  expect(revised).not.toBe(heads[1]);

  const { runId, methodologyVersionId } = await beginRunViaApi({ runKey: crypto.randomUUID(), asof: "2026-05-15", toolId: "ids-1534" });
  const body = (ids: unknown) => vintageBody(runId, methodologyVersionId, { toolId: "ids-1534", knowledgeTimeCutoff: cutoff, regimeVersionIds: ids });
  const before = await vintageCount();
  const refused: [string, unknown][] = [
    ["unknown id", [heads[0], "999999999999"]],
    ["non-regime source_key", [heads[0], nonRegime]],
    ["market_date after the market cutoff", [heads[0], afterMarket]],
    ["knowledge_time after the knowledge cutoff", [heads[0], afterKnowledge]],
    ["two ids for one (source_key, market_date)", [heads[0], heads[1], revised]],
    ["a repeated id", [heads[0], heads[0]]],
    ["a non-decimal id", [heads[0], "12a"]],
    ["not an array", heads[0]],
  ];
  for (const [label, ids] of refused) {
    const res = await call(req("POST", A.vintages, body(ids), TOKEN));
    expect(res!.status, label).toBe(400);
    expect(typeof (res!.body as { error: string }).error, label).toBe("string");
  }
  expect(await vintageCount()).toBe(before);

  // The valid read set: VIX's heads as of the cutoff (2026-05-02's head is the revision).
  const ids = [heads[0]!, revised!];
  const ok = await call(req("POST", A.vintages, body(ids), TOKEN));
  expect(ok!.status).toBe(200);
  const frozen = ok!.body as { vintageId: string; memberCount: number };
  const readback = await call(req("GET", `${A.vintage}?runId=${runId}&toolId=ids-1534`, undefined, TOKEN));
  const members = (readback!.body as { vintage: { members: { versionId: string; sourceKey: string }[] } }).vintage.members;
  const regimeKeys = new Set(REGIME_STORAGE_KEYS);
  expect(members.filter((m) => regimeKeys.has(m.sourceKey)).map((m) => m.versionId).sort()).toEqual([...ids].sort());
  expect(members.map((m) => m.versionId)).toContain(nonRegime);
  expect(frozen.memberCount).toBe(members.length);
});

test("POST vintages without regimeVersionIds freezes the cutoff selection for every key, replays an identical resubmission and answers 409 to a differing one", async () => {
  await record("raw_indicator_history:VIX", [{ date: "2026-04-01", value: 7 }]);
  await record("api-1534:compat", [{ date: "2026-04-01", value: 2 }]);
  const cutoff = await dbClock();
  const { runId, methodologyVersionId } = await beginRunViaApi({ runKey: crypto.randomUUID(), asof: "2026-05-15", toolId: "compat-1534" });
  const body = vintageBody(runId, methodologyVersionId, { toolId: "compat-1534", knowledgeTimeCutoff: cutoff });
  const first = await call(req("POST", A.vintages, body, TOKEN));
  expect(first!.status).toBe(200);
  expect((first!.body as { replayed: boolean }).replayed).toBe(false);
  const readback = await call(req("GET", `${A.vintage}?runId=${runId}&toolId=compat-1534`, undefined, TOKEN));
  const members = (readback!.body as { vintage: { members: { versionId: string }[] } }).vintage.members.map((m) => m.versionId).sort();
  const expected = (await loadHistoricalSourceValues(cutoff, "2026-05-15")).map((m) => m.versionId).sort();
  expect(members).toEqual(expected);
  expect(members.length).toBeGreaterThan(0);

  const retry = await call(req("POST", A.vintages, body, TOKEN));
  expect(retry!.status).toBe(200);
  expect((retry!.body as { replayed: boolean; vintageId: string }).replayed).toBe(true);
  const differing = vintageBody(runId, methodologyVersionId, { toolId: "compat-1534", knowledgeTimeCutoff: cutoff, buildIdentity: "other-build" });
  expect((await call(req("POST", A.vintages, differing, TOKEN)))!.status).toBe(409);
  const [{ n }] = await sql`SELECT count(*)::int AS n FROM analytics_data_vintages WHERE run_id = ${runId}::bigint`;
  expect(n).toBe(1);
});
