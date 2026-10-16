// Issue #977 AC8: the analytics run-ledger HTTP boundary — analytics-provider
// authentication, whole-body validation before any transaction opens,
// idempotent retry semantics, rejection of a second conflicting freeze, and
// readback of the exact frozen manifest. Drives the REAL route handlers and
// SQL stores through handleAnalytics against real ephemeral Postgres.
import { test, expect, beforeAll } from "bun:test";
import { ROUTES } from "@robotmoney/contract";
import { sql } from "../../src/db/client.ts";
import { handleAnalytics } from "../../src/api/routes/analytics.ts";
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
