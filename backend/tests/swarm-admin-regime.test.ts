// The regime write boundary (issue #361 Phase 4; docs/decisions.md D25, §9.6):
// POST /api/swarm/regime is a genuine provider SUBMISSION gate (validate +
// persist; NEVER recompute server-side), the ADMIN_TOKEN classifier path
// (POST /api/swarm/admin/regime) is REMOVED. The independent producer owns
// cadence; ADMIN_TOKEN cannot enqueue a consumer-worker replacement.
//
// Dispatches through handleSwarm in-process (the same pattern authz.test.ts
// uses) rather than over HTTP.
import { test, expect, afterEach } from "bun:test";
import { config } from "../src/config.ts";
import { handleSwarm } from "../src/api/routes/swarm.ts";
import { sql } from "../src/db/client.ts";
import { useCleanDatabase } from "./support/clean-db.ts";

// Own database per file, cloned from the migrated template (support/clean-db.ts).
useCleanDatabase(import.meta.file);

const origConfig = {
  adminToken: config.adminToken,
  allowInsecure: config.allowInsecure,
  analyticsToken: config.analyticsToken,
};
afterEach(() => {
  config.adminToken = origConfig.adminToken;
  config.allowInsecure = origConfig.allowInsecure;
  config.analyticsToken = origConfig.analyticsToken;
});

const call = (req: Request) => handleSwarm(req, new URL(req.url));

function snapshotRow(date: string, composite: number) {
  return {
    date,
    composite,
    compositePercentile: 0.5,
    regime: "neutral",
    macroRegime: "neutral",
    onchainRegime: "neutral",
    factorRegime: "neutral",
    macroIndex: 0.5,
    onchainIndex: 0.5,
    factorIndex: 0.5,
    macroPercentile: 0.5,
    onchainPercentile: 0.5,
    factorPercentile: 0.5,
    panelWeights: null,
    version: "test-v1",
    percentiles: { test_indicator: 0.5 },
    indicators: [],
    panels: null,
    bucketThresholds: null,
    backtest: null,
    correlations: null,
    extras: null,
  };
}

function regimeReq(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://x/api/swarm/regime", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

test("POST /api/swarm/regime is a provider SUBMISSION gate: analytics bearer persists submitted snapshots verbatim, with no server-side recompute", async () => {
  config.analyticsToken = "analytics-secret";
  config.allowInsecure = false;

  const date = "2031-06-15";
  const res = await call(
    regimeReq({ snapshots: [snapshotRow(date, 0.731)] }, { Authorization: "Bearer analytics-secret" }),
  );
  expect(res).not.toBeNull();
  expect(res!.status).toBe(200);
  expect(res!.body).toMatchObject({ ok: true, saved: 1 });
  // The SUBMITTED composite landed — not a recomputed one: 0.731 is not a
  // value any classifier run over this suite's data would produce for a
  // future date, so reading it back proves persistence of the provider's own
  // computation.
  const [row] = await sql<{ composite: number | null; version: string | null }[]>`
    SELECT composite, version FROM regime_snapshots WHERE date = ${date}`;
  expect(Number(row.composite)).toBeCloseTo(0.731, 6);
  expect(row.version).toBe("test-v1");
});

test("POST /api/swarm/regime rejects a malformed submission with 400 and zero writes", async () => {
  config.analyticsToken = "analytics-secret";
  config.allowInsecure = false;
  const res = await call(
    regimeReq({ snapshots: [{ date: "not-a-date" }] }, { Authorization: "Bearer analytics-secret" }),
  );
  expect(res!.status).toBe(400);
  expect(String((res!.body as { error: string }).error)).toContain("snapshots[0]");
});

test("POST /api/swarm/regime refuses ADMIN_TOKEN and member-shaped bearers — the analytics role is not substitutable", async () => {
  config.analyticsToken = "analytics-secret";
  config.adminToken = "admin-secret";
  config.allowInsecure = false;
  const payload = { snapshots: [snapshotRow("2031-06-16", 0.5)] };
  // Admin header is not the analytics role.
  expect((await call(regimeReq(payload, { "X-Admin-Token": "admin-secret" })))!.status).toBe(403);
  // Neither is an arbitrary (member-shaped) bearer.
  expect((await call(regimeReq(payload, { Authorization: "Bearer tok_member_x" })))!.status).toBe(403);
});

test("the ADMIN_TOKEN classifier path is gone: POST /api/swarm/admin/regime is an unknown admin action", async () => {
  config.adminToken = null;
  config.allowInsecure = true;
  const req = new Request("http://x/api/swarm/admin/regime", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ asof: "2026-06-29" }),
  });
  const res = await call(req);
  expect(res!.status).toBe(404);
  expect((res!.body as { error: string }).error).toBe("unknown admin action");
});

test("ADMIN_TOKEN cannot trigger classification through enqueue-job", async () => {
  config.adminToken = null;
  config.allowInsecure = true;
  const req = new Request("http://x/api/swarm/admin/enqueue-job", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "regime_classify", asof: "2031-06-17" }),
  });
  const res = await call(req);
  expect(res!.status).toBe(400);
  expect((res!.body as { error: string }).error).toContain("unknown action");
});

// Migration 0017 (admin surface, issue #150) against the suite's real,
// already-migrated Postgres. Full pre-migration legacy-fixture and backfill
// coverage lives in admin-surface-migration.test.ts (which provisions its own
// pre-0017 database); these tests instead prove the NEW schema shape works
// end to end against real Postgres and stays compatible with the existing
// insert style domain.ts already uses (which never sets the new columns).
test("legacy-row compatibility: a session inserted the pre-0017 way (no version/updated_at/brief_opens_at) still reads back with sane defaults", async () => {
  await sql`INSERT INTO swarm_subjects (id, status, name) VALUES ('regime-test-subject', 'active', 'Regime Test Subject')
            ON CONFLICT (id) DO NOTHING`;
  const [row] = await sql<{ version: number; state: string; updated_at: Date; brief_opens_at: Date | null }[]>`
    INSERT INTO swarm_sessions (convened_at, subject_id, subject_name, state)
    VALUES ('2031-01-01', 'regime-test-subject', 'Regime Test Subject', 'scheduled')
    RETURNING version, state, updated_at, brief_opens_at`;
  expect(row.version).toBe(1);
  expect(row.state).toBe("scheduled");
  expect(row.updated_at).toBeInstanceOf(Date);
  expect(row.brief_opens_at).toBeNull();
});

test("swarm_sessions.state check accepts all six legal states and rejects an unknown one", async () => {
  await sql`INSERT INTO swarm_subjects (id, status, name) VALUES ('regime-test-subject', 'active', 'Regime Test Subject')
            ON CONFLICT (id) DO NOTHING`;
  const states = ["scheduled", "collecting", "window_closed", "aggregated", "published", "cancelled"];
  for (let i = 0; i < states.length; i++) {
    const state = states[i]!;
    const [row] = await sql<{ state: string }[]>`
      INSERT INTO swarm_sessions (convened_at, subject_id, subject_name, state)
      VALUES (${`2031-02-${String(i + 1).padStart(2, "0")}`}, 'regime-test-subject', 'Regime Test Subject', ${state})
      RETURNING state`;
    expect(row.state).toBe(state);
  }

  // postgres.js tagged-template results are lazy thenables, not plain
  // Promises; bun:test's `expect(query).rejects` wrapper hangs against them
  // (mirrors analytics-worker-role.test.ts's `denied` helper) — assert via
  // try/catch instead.
  let threw = false;
  try {
    await sql`INSERT INTO swarm_sessions (convened_at, subject_id, subject_name, state)
        VALUES ('2031-03-01', 'regime-test-subject', 'Regime Test Subject', 'brief_published')`;
  } catch {
    threw = true;
  }
  expect(threw).toBe(true);
});

test("swarm_session_members and swarm_session_events round-trip a real session's roster snapshot and lifecycle history", async () => {
  await sql`INSERT INTO swarm_subjects (id, status, name) VALUES ('regime-test-subject', 'active', 'Regime Test Subject')
            ON CONFLICT (id) DO NOTHING`;
  await sql`INSERT INTO swarm_members (id, status, name, lens) VALUES ('regime-test-member', 'active', 'Regime Test Member', 'macro')
            ON CONFLICT (id) DO NOTHING`;
  const [session] = await sql<{ id: string }[]>`
    INSERT INTO swarm_sessions (convened_at, subject_id, subject_name, state)
    VALUES ('2031-04-01', 'regime-test-subject', 'Regime Test Subject', 'scheduled')
    RETURNING id`;

  await sql`INSERT INTO swarm_session_members (session_id, member_id, member_name, member_lens, status)
            VALUES (${session.id}, 'regime-test-member', 'Regime Test Member', 'macro', 'expected')`;
  await sql`INSERT INTO swarm_session_events (session_id, from_state, to_state, action, actor)
            VALUES (${session.id}, NULL, 'scheduled', 'create', 'admin')`;

  const [roster] = await sql<{ status: string }[]>`
    SELECT status FROM swarm_session_members WHERE session_id = ${session.id} AND member_id = 'regime-test-member'`;
  expect(roster.status).toBe("expected");

  const events = await sql<{ action: string; to_state: string }[]>`
    SELECT action, to_state FROM swarm_session_events WHERE session_id = ${session.id}`;
  expect([...events]).toEqual([{ action: "create", to_state: "scheduled" }]);

  // The session's ON DELETE CASCADE to its roster/event rows is now
  // UNREACHABLE: migration 0032 makes swarm_sessions append-only, so the
  // delete that would have triggered the cascade is refused categorically
  // (0A000) for every role. That refusal is the guarantee worth asserting —
  // a convened session's attendance and event trail cannot be erased.
  const refusal = await sql`DELETE FROM swarm_sessions WHERE id = ${session.id}`
    .then(() => null, (e: { code?: string }) => e.code ?? "unknown");
  expect(refusal).toBe("0A000");
  const [{ n: remainingRoster }] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM swarm_session_members WHERE session_id = ${session.id}`;
  const [{ n: remainingEvents }] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM swarm_session_events WHERE session_id = ${session.id}`;
  expect(remainingRoster).toBeGreaterThan(0);
  expect(remainingEvents).toBeGreaterThan(0);
});
