// /api/analytics/* ingestion boundary (issue #106) — authorization, DTO
// validation, atomicity, and idempotency against the REAL ephemeral Postgres
// the preload provisions (never mocked; a missing Postgres fails the preload
// loudly, so this suite goes red rather than skipping).
//
// Covers the issue ACs:
//   • every mutation returns 401/403 AND makes zero database changes without a
//     valid bearer token; accepts a valid ANALYTICS_TOKEN; NEVER accepts
//     ADMIN_TOKEN or a committee-member credential as a substitute;
//   • malformed / oversized / duplicate-conflicting / non-finite / partial
//     payloads are rejected before any row changes;
//   • valid batches persist atomically + idempotently on their natural keys; a
//     forced mid-operation error rolls back the whole mutation;
//   • credentials are never returned in responses or emitted in logs, and the
//     updater startup guard fails loudly in demo/prod without its token.
import { test, expect, afterEach } from "bun:test";
import { ROUTES } from "@robotmoney/contract";
import { sql } from "../../src/db/client.ts";
import { config } from "../../src/config.ts";
import { handleAnalytics } from "../../src/api/routes/analytics.ts";
import { assertAnalyticsUpdaterCredentials } from "../../src/analytics/api-client.ts";
import { hashKey } from "../../src/lib/keys.ts";

const A = ROUTES.analytics;
const TOKEN = "tok_analytics_test_secret";
const ADMIN = "tok_admin_test_secret";

// Prod-shaped auth for every test: a token is configured and the insecure
// convenience path is OFF, so only the exact ANALYTICS_TOKEN authorizes.
const orig = { analyticsToken: config.analyticsToken, adminToken: config.adminToken, allowInsecure: config.allowInsecure };
function prodAuth() {
  config.analyticsToken = TOKEN;
  config.adminToken = ADMIN;
  config.allowInsecure = false;
}
afterEach(() => {
  config.analyticsToken = orig.analyticsToken;
  config.adminToken = orig.adminToken;
  config.allowInsecure = orig.allowInsecure;
});

function req(method: string, path: string, body?: unknown, token?: string, rawBody?: string): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token !== undefined) headers.Authorization = `Bearer ${token}`;
  return new Request(`http://x${path}`, {
    method,
    headers,
    body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
}
const call = (r: Request) => handleAnalytics(r, new URL(r.url));

const rid = () => `T_${crypto.randomUUID().slice(0, 8).toUpperCase()}`;

async function tableCounts(): Promise<{ raw: number; snaps: number; signals: number }> {
  const [{ raw }] = await sql`SELECT COUNT(*)::int AS raw FROM raw_indicator_history`;
  const [{ snaps }] = await sql`SELECT COUNT(*)::int AS snaps FROM regime_snapshots`;
  const [{ signals }] = await sql`SELECT COUNT(*)::int AS signals FROM research_signals`;
  return { raw, snaps, signals };
}

const validBodies: [string, string, unknown][] = [
  ["POST", A.rawHistory, { history: { [rid()]: [{ date: "2020-01-01", value: 1 }] } }],
  ["POST", A.rawHistorySeed, { history: { [rid()]: [{ date: "2020-01-01", value: 1 }] } }],
  ["POST", A.regimeSnapshots, { snapshots: [{ date: "1999-01-01", composite: 0.5, compositePercentile: 0.5, regime: "neutral", macroRegime: null, onchainRegime: null, factorRegime: null, percentiles: {}, indicators: [] }] }],
  ["POST", A.researchSignals, { signals: [{ key: `sig-${rid()}`, date: "1999-01-01", payload: { title: "t" } }] }],
];

test("every mutation: 401 with no bearer, 403 with a wrong/admin/member bearer — and ZERO row changes", async () => {
  prodAuth();
  // A real committee-member credential (the strongest confusable substitute).
  const memberId = `az_${crypto.randomUUID().slice(0, 8)}`;
  const memberToken = `tok_member_${crypto.randomUUID().slice(0, 8)}`;
  await sql`INSERT INTO committee_members (id, status, name) VALUES (${memberId}, 'active', ${memberId})`;
  await sql`INSERT INTO committee_member_keys (member_id, public_key, token_hash)
            VALUES (${memberId}, ${"A".repeat(44)}, ${hashKey(memberToken)})`;

  const before = await tableCounts();
  for (const [method, path, body] of validBodies) {
    expect((await call(req(method, path, body)))?.status).toBe(401); // no credential
    expect((await call(req(method, path, body, "wrong-token")))?.status).toBe(403); // wrong bearer
    expect((await call(req(method, path, body, ADMIN)))?.status).toBe(403); // ADMIN_TOKEN is NOT a substitute
    expect((await call(req(method, path, body, memberToken)))?.status).toBe(403); // member bearer is NOT a substitute
  }
  // The read is analytics-provider-only too.
  expect((await call(req("GET", A.rawHistory)))?.status).toBe(401);
  expect(await tableCounts()).toEqual(before); // zero database changes

  // The SAME payloads succeed with the valid ANALYTICS_TOKEN.
  for (const [method, path, body] of validBodies) {
    expect((await call(req(method, path, body, TOKEN)))?.status).toBe(200);
  }
});

test("fail-closed: no token configured → locked in demo/prod, open only under allowInsecure", async () => {
  prodAuth();
  config.analyticsToken = null; // demo/prod misconfiguration
  const [method, path] = ["POST", A.rawHistory] as const;
  const body = { history: { [rid()]: [{ date: "2020-01-01", value: 1 }] } };
  expect((await call(req(method, path, body)))?.status).toBe(401);
  expect((await call(req(method, path, body, "anything")))?.status).toBe(403);
  config.allowInsecure = true; // ephemeral / explicit RM_ALLOW_INSECURE opt-in
  expect((await call(req(method, path, body)))?.status).toBe(200);
});

test("DTO validation rejects malformed/oversized/duplicate-conflicting/non-finite/partial payloads with zero row changes", async () => {
  prodAuth();
  const ind = rid();
  const before = await tableCounts();

  const badRaw: (unknown | { raw: string })[] = [
    null, // not JSON
    {}, // missing history
    { history: [] }, // wrong container type
    { history: { [ind]: [{ date: "2020-13-40", value: 1 }] } }, // invalid date shape
    { history: { [ind]: [{ date: "2024-02-30", value: 1 }] } }, // non-calendar date
    { history: { [ind]: [{ date: "2020-01-01", value: "1" }] } }, // non-numeric
    { history: { [ind]: [{ date: "2020-01-01", value: null }] } }, // JSON NaN → null
    { history: { [ind]: [{ date: "2020-01-01", value: 1 }, { date: "2020-01-01", value: 2 }] } }, // duplicate-conflicting natural key
    // PARTIAL payload: one valid point + one invalid → the whole batch must be rejected.
    { history: { [ind]: [{ date: "2020-01-01", value: 1 }], [`${ind}B`]: [{ date: "2020-01-02", value: "oops" }] } },
  ];
  for (const body of badRaw) {
    for (const path of [A.rawHistory, A.rawHistorySeed]) {
      const res = await call(req("POST", path, body, TOKEN));
      expect(res?.status).toBe(400);
    }
  }
  // Non-finite via raw JSON (1e999 parses to Infinity — JSON.stringify can't build this).
  const inf = await call(req("POST", A.rawHistory, undefined, TOKEN, `{"history":{"${ind}":[{"date":"2020-01-01","value":1e999}]}}`));
  expect(inf?.status).toBe(400);

  const badSnaps: unknown[] = [
    {}, // missing snapshots
    { snapshots: [{}] }, // missing date
    { snapshots: [{ date: "2024-02-30", percentiles: {}, indicators: [] }] }, // bad date
    { snapshots: [{ date: "1999-01-02", composite: "x", percentiles: {}, indicators: [] }] }, // non-numeric
    { snapshots: [{ date: "1999-01-02", percentiles: { a: "x" }, indicators: [] }] }, // bad percentile map
    { snapshots: [{ date: "1999-01-02", percentiles: {}, indicators: {} }] }, // indicators not array
    { snapshots: [ // duplicate natural key
      { date: "1999-01-02", percentiles: {}, indicators: [] },
      { date: "1999-01-02", percentiles: {}, indicators: [] },
    ] },
  ];
  for (const body of badSnaps) {
    expect((await call(req("POST", A.regimeSnapshots, body, TOKEN)))?.status).toBe(400);
  }

  const badSignals: unknown[] = [
    {}, // missing signals
    { signals: [{ key: "", date: "1999-01-02", payload: {} }] }, // empty key
    { signals: [{ key: "k", date: "not-a-date", payload: {} }] },
    { signals: [{ key: "k", date: "1999-01-02", payload: "not-an-object" }] },
    { signals: [{ key: "k", date: "1999-01-02", payload: {} }, { key: "k", date: "1999-01-02", payload: {} }] }, // duplicate
    { signals: Array.from({ length: 51 }, (_, i) => ({ key: `k${i}`, date: "1999-01-02", payload: {} })) }, // oversized
  ];
  for (const body of badSignals) {
    expect((await call(req("POST", A.researchSignals, body, TOKEN)))?.status).toBe(400);
  }

  expect(await tableCounts()).toEqual(before); // every rejection left zero row changes
});

test("raw-history: persists atomically, idempotent upsert on (date, indicator)", async () => {
  prodAuth();
  const ind = rid();
  const body = { history: { [ind]: [{ date: "2020-01-01", value: 1 }, { date: "2020-01-02", value: 2 }] } };
  expect((await call(req("POST", A.rawHistory, body, TOKEN)))?.status).toBe(200);
  expect((await call(req("POST", A.rawHistory, body, TOKEN)))?.status).toBe(200); // re-submit converges
  const rows = await sql`SELECT date::text AS date, value FROM raw_indicator_history WHERE indicator = ${ind} ORDER BY date`;
  expect(rows.length).toBe(2); // no duplicates
  // Changed value on the same natural key overwrites (upsert, not append).
  await call(req("POST", A.rawHistory, { history: { [ind]: [{ date: "2020-01-02", value: 99 }] } }, TOKEN));
  const [after] = await sql`SELECT value FROM raw_indicator_history WHERE indicator = ${ind} AND date = '2020-01-02'`;
  expect(Number(after.value)).toBe(99);
});

test("seed ingestion: gap-fill only (existing rows win), idempotent no-op when warm", async () => {
  prodAuth();
  const ind = rid();
  await sql`INSERT INTO raw_indicator_history (date, indicator, value) VALUES ('2020-01-02', ${ind}, 42)`;
  const body = { history: { [ind]: [
    { date: "2020-01-01", value: 1 },
    { date: "2020-01-02", value: 2 }, // must NOT overwrite the persisted 42
    { date: "2020-01-03", value: 3 },
  ] } };
  const first = await call(req("POST", A.rawHistorySeed, body, TOKEN));
  expect(first?.status).toBe(200);
  expect(first?.body).toMatchObject({ ok: true, seededPoints: 2, existingPoints: 1 });
  const [kept] = await sql`SELECT value FROM raw_indicator_history WHERE indicator = ${ind} AND date = '2020-01-02'`;
  expect(Number(kept.value)).toBe(42); // existing row won
  const second = await call(req("POST", A.rawHistorySeed, body, TOKEN));
  expect(second?.body).toMatchObject({ seededPoints: 0, existingPoints: 3 }); // warm → no-op
});

test("regime snapshots + research signals: idempotent on (date) / (signal_key, date)", async () => {
  prodAuth();
  const date = "1998-06-15";
  await sql`DELETE FROM regime_snapshots WHERE date = ${date}`;
  const snap = { date, composite: 0.4, compositePercentile: 0.6, regime: "neutral", macroRegime: "neutral", onchainRegime: "neutral", factorRegime: null, percentiles: { VIX: 0.5 }, indicators: [{ id: "VIX" }] };
  expect((await call(req("POST", A.regimeSnapshots, { snapshots: [snap] }, TOKEN)))?.status).toBe(200);
  expect((await call(req("POST", A.regimeSnapshots, { snapshots: [{ ...snap, composite: 0.9 }] }, TOKEN)))?.status).toBe(200);
  const rows = await sql`SELECT composite FROM regime_snapshots WHERE date = ${date}`;
  expect(rows.length).toBe(1); // upserted, not duplicated
  expect(Number(rows[0].composite)).toBe(0.9);

  const key = `sig-${rid()}`;
  await call(req("POST", A.researchSignals, { signals: [{ key, date, payload: { v: 1 } }] }, TOKEN));
  await call(req("POST", A.researchSignals, { signals: [{ key, date, payload: { v: 2 } }] }, TOKEN));
  const sigs = await sql`SELECT payload FROM research_signals WHERE signal_key = ${key} AND date = ${date}`;
  expect(sigs.length).toBe(1);
  expect(sigs[0].payload).toEqual({ v: 2 });
});

test("forced mid-operation error rolls back the WHOLE mutation (nothing persists)", async () => {
  prodAuth();
  // The research-signals route runs ONE INSERT statement per signal inside a
  // single transaction, so a trigger that detonates on the SECOND signal proves
  // cross-statement rollback: the first (already-executed) INSERT must be undone.
  const good = `sig-${rid()}`;
  await sql`
    CREATE OR REPLACE FUNCTION rmtest_boom() RETURNS trigger AS $$
    BEGIN
      IF NEW.signal_key = 'zz-boom' THEN RAISE EXCEPTION 'forced mid-operation failure'; END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql`;
  await sql`CREATE TRIGGER rmtest_boom_trg BEFORE INSERT ON research_signals FOR EACH ROW EXECUTE FUNCTION rmtest_boom()`;
  try {
    const body = { signals: [
      { key: good, date: "1999-01-03", payload: { v: 1 } }, // executes first
      { key: "zz-boom", date: "1999-01-03", payload: { v: 2 } }, // detonates second
    ] };
    await expect(call(req("POST", A.researchSignals, body, TOKEN))).rejects.toThrow(/forced mid-operation failure/);
    const [{ n }] = await sql`SELECT COUNT(*)::int AS n FROM research_signals WHERE signal_key IN (${good}, 'zz-boom')`;
    expect(n).toBe(0); // full rollback — the earlier good row did not survive
  } finally {
    await sql`DROP TRIGGER IF EXISTS rmtest_boom_trg ON research_signals`;
    await sql`DROP FUNCTION IF EXISTS rmtest_boom()`;
  }
});

test("credentials never appear in responses or logs", async () => {
  prodAuth();
  const captured: string[] = [];
  const spy = (...args: unknown[]) => { captured.push(args.map(String).join(" ")); };
  const real = { log: console.log, warn: console.warn, error: console.error };
  console.log = spy as typeof console.log;
  console.warn = spy as typeof console.warn;
  console.error = spy as typeof console.error;
  try {
    const ok = await call(req("POST", A.rawHistory, { history: { [rid()]: [{ date: "2020-01-01", value: 1 }] } }, TOKEN));
    const rejected = await call(req("POST", A.rawHistory, { history: {} }, "wrong-token"));
    const read = await call(req("GET", A.rawHistory, undefined, TOKEN));
    for (const res of [ok, rejected, read]) {
      expect(JSON.stringify(res)).not.toContain(TOKEN);
      expect(JSON.stringify(res)).not.toContain(ADMIN);
    }
  } finally {
    console.log = real.log;
    console.warn = real.warn;
    console.error = real.error;
  }
  expect(captured.join("\n")).not.toContain(TOKEN);
  expect(captured.join("\n")).not.toContain(ADMIN);
});

test("startup guard: demo/prod updater without ANALYTICS_TOKEN fails loudly; token or insecure opt-in boots", () => {
  expect(() => assertAnalyticsUpdaterCredentials({ env: "prod", allowInsecure: false, analyticsToken: null }))
    .toThrow(/ANALYTICS_TOKEN/);
  expect(() => assertAnalyticsUpdaterCredentials({ env: "demo", allowInsecure: false, analyticsToken: null }))
    .toThrow(/ANALYTICS_TOKEN/);
  // The thrown message never contains a secret (there is none) and setting one boots.
  expect(() => assertAnalyticsUpdaterCredentials({ env: "prod", allowInsecure: false, analyticsToken: TOKEN })).not.toThrow();
  expect(() => assertAnalyticsUpdaterCredentials({ env: "ephemeral", allowInsecure: true, analyticsToken: null })).not.toThrow();
});

test("GET raw-history returns the persisted floor to the analytics-provider", async () => {
  prodAuth();
  const ind = rid();
  await sql`INSERT INTO raw_indicator_history (date, indicator, value) VALUES ('2021-05-05', ${ind}, 7)`;
  const res = await call(req("GET", A.rawHistory, undefined, TOKEN));
  expect(res?.status).toBe(200);
  const history = (res?.body as { history: Record<string, { date: string; value: number }[]> }).history;
  expect(history[ind]).toEqual([{ date: "2021-05-05", value: 7 }]);
});

// ── POST /api/analytics/telemetry (issue #151) — same analytics-provider-only
// boundary as every mutation above, just with its own DTO shape (a run with
// stages/warnings/artifacts) rather than a natural-key batch.
function validTelemetryBody(kind = `tel-${rid()}`): unknown {
  const now = new Date().toISOString();
  return {
    run: {
      kind,
      asof: "1999-01-04",
      source: "hermetic",
      status: "succeeded",
      startedAt: now,
      finishedAt: now,
      checksum: "abc",
      summary: { composite: 0.5 },
      stages: [
        { stage: "access", sequence: 1, status: "ok", summary: "fetched", startedAt: now, finishedAt: now },
      ],
      warnings: [],
      artifacts: [{ stage: "access", kind: "sample", checksum: "def", preview: { a: 1 } }],
      jobId: null,
    },
  };
}

test("telemetry: 401 with no bearer, 403 with a wrong/admin/member bearer — ZERO row changes; 200 with the valid token", async () => {
  prodAuth();
  const memberId = `az_${crypto.randomUUID().slice(0, 8)}`;
  const memberToken = `tok_member_${crypto.randomUUID().slice(0, 8)}`;
  await sql`INSERT INTO committee_members (id, status, name) VALUES (${memberId}, 'active', ${memberId})`;
  await sql`INSERT INTO committee_member_keys (member_id, public_key, token_hash)
            VALUES (${memberId}, ${"B".repeat(44)}, ${hashKey(memberToken)})`;

  const body = validTelemetryBody();
  const [{ n: before }] = await sql`SELECT COUNT(*)::int AS n FROM analytics_runs`;
  expect((await call(req("POST", A.telemetry, body)))?.status).toBe(401);
  expect((await call(req("POST", A.telemetry, body, "wrong-token")))?.status).toBe(403);
  expect((await call(req("POST", A.telemetry, body, ADMIN)))?.status).toBe(403);
  expect((await call(req("POST", A.telemetry, body, memberToken)))?.status).toBe(403);
  const [{ n: afterRejections }] = await sql`SELECT COUNT(*)::int AS n FROM analytics_runs`;
  expect(afterRejections).toBe(before);

  const res = await call(req("POST", A.telemetry, body, TOKEN));
  expect(res?.status).toBe(200);
  const ok = res?.body as { ok: boolean; runId: number };
  expect(ok.ok).toBe(true);
  const [run] = await sql`SELECT kind, status FROM analytics_runs WHERE id = ${ok.runId}`;
  expect(run.kind).toBe((body as any).run.kind);
  expect(run.status).toBe("succeeded");
  const stages = await sql`SELECT stage FROM analytics_run_stages WHERE run_id = ${ok.runId}`;
  expect(stages.length).toBe(1);
  const artifacts = await sql`SELECT kind, preview FROM analytics_run_artifacts WHERE run_id = ${ok.runId}`;
  expect(artifacts.length).toBe(1);
  expect(artifacts[0].preview).toEqual({ a: 1 });
});

test("telemetry: DTO validation rejects malformed run/stage/warning/artifact payloads with zero row changes", async () => {
  prodAuth();
  const [{ n: before }] = await sql`SELECT COUNT(*)::int AS n FROM analytics_runs`;
  const good = validTelemetryBody();
  const badBodies: unknown[] = [
    null,
    {},
    { run: {} }, // missing every field
    { run: { ...(good as any).run, kind: "" } }, // empty kind
    { run: { ...(good as any).run, asof: "not-a-date" } },
    { run: { ...(good as any).run, source: "" } },
    { run: { ...(good as any).run, status: "not-a-status" } },
    { run: { ...(good as any).run, startedAt: "not-a-timestamp" } },
    { run: { ...(good as any).run, summary: "not-an-object" } },
    { run: { ...(good as any).run, stages: [{ stage: "not-a-stage", sequence: 1, status: "ok", summary: "x", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() }] } },
    { run: { ...(good as any).run, stages: [{ stage: "access", sequence: 1, status: "not-a-status", summary: "x", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() }] } },
    { run: { ...(good as any).run, stages: [
      { stage: "access", sequence: 1, status: "ok", summary: "x", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() },
      { stage: "extract", sequence: 1, status: "ok", summary: "x", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() },
    ] } }, // duplicate sequence
    { run: { ...(good as any).run, warnings: [{ stage: "access", message: "" }] } }, // empty message
    { run: { ...(good as any).run, artifacts: [{ stage: "access", kind: "x", checksum: null, preview: "x".repeat(30_000) }] } }, // oversized preview
  ];
  for (const body of badBodies) {
    expect((await call(req("POST", A.telemetry, body, TOKEN)))?.status).toBe(400);
  }
  const [{ n: after }] = await sql`SELECT COUNT(*)::int AS n FROM analytics_runs`;
  expect(after).toBe(before);
});
