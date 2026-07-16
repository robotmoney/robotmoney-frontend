// Placeholder for the Demo readiness gate phase (issue #63, dev-scout). Reserves
// the CI seam for the POST /api/committee/admin/regime handler's dedicated test
// file so #59 can land its tools-array scoping assertion without also owning
// file creation. #59 extends this file; it does not need to build the harness.
//
// Dispatches through handleCommittee in-process (the same pattern authz.test.ts
// uses) rather than over HTTP, and pins ANALYTICS_SOURCE=hermetic so the run
// never touches the network (mirrors hermetic-source.test.ts).
import { test, expect, afterEach } from "bun:test";
import { config } from "../src/config.ts";
import { handleCommittee } from "../src/api/routes/committee.ts";
import { sql } from "../src/db/client.ts";

const origConfig = { adminToken: config.adminToken, allowInsecure: config.allowInsecure };
const origSource = process.env.ANALYTICS_SOURCE;
afterEach(() => {
  config.adminToken = origConfig.adminToken;
  config.allowInsecure = origConfig.allowInsecure;
  if (origSource === undefined) delete process.env.ANALYTICS_SOURCE;
  else process.env.ANALYTICS_SOURCE = origSource;
});

// runAnalytics computes the full indicator + backtest suite even in hermetic
// mode, so this mirrors the extended timeouts other suites use around it
// (hermetic-source.test.ts, analytics-suite.test.ts) rather than the 5s default.
test(
  "POST /api/committee/admin/regime recomputes ONLY the regime composite (tools === ['regime'])",
  async () => {
    config.adminToken = null;
    config.allowInsecure = true;
    process.env.ANALYTICS_SOURCE = "hermetic";

    const req = new Request("http://x/api/committee/admin/regime", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ asof: "2026-06-29" }),
    });
    const res = await handleCommittee(req, new URL(req.url));

    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    // The scoping fix (issue #59): this admin route must NOT recompute the full
    // suite (regime + both research signals) — only the regime composite, so it
    // never triggers the multi-minute live SEC EDGAR research crawl that hung
    // `bun demo`. Object.keys of the scoped runAnalytics result is exactly ["regime"].
    expect((res!.body as { tools: string[] }).tools).toEqual(["regime"]);
  },
  { timeout: 120_000 },
);

// Migration 0017 (admin surface, issue #150) against the suite's real,
// already-migrated Postgres. Full pre-migration legacy-fixture and backfill
// coverage lives in admin-surface-migration.test.ts (which provisions its own
// pre-0017 database); these tests instead prove the NEW schema shape works
// end to end against real Postgres and stays compatible with the existing
// insert style domain.ts already uses (which never sets the new columns).
test("legacy-row compatibility: a session inserted the pre-0017 way (no version/updated_at/brief_opens_at) still reads back with sane defaults", async () => {
  await sql`INSERT INTO committee_subjects (id, status, name) VALUES ('regime-test-subject', 'active', 'Regime Test Subject')
            ON CONFLICT (id) DO NOTHING`;
  const [row] = await sql<{ version: number; state: string; updated_at: Date; brief_opens_at: Date | null }[]>`
    INSERT INTO committee_sessions (date, subject_id, subject_name, state)
    VALUES ('2031-01-01', 'regime-test-subject', 'Regime Test Subject', 'scheduled')
    RETURNING version, state, updated_at, brief_opens_at`;
  expect(row.version).toBe(1);
  expect(row.state).toBe("scheduled");
  expect(row.updated_at).toBeInstanceOf(Date);
  expect(row.brief_opens_at).toBeNull();
});

test("committee_sessions.state check accepts all six legal states and rejects an unknown one", async () => {
  await sql`INSERT INTO committee_subjects (id, status, name) VALUES ('regime-test-subject', 'active', 'Regime Test Subject')
            ON CONFLICT (id) DO NOTHING`;
  const states = ["scheduled", "collecting", "window_closed", "aggregated", "published", "cancelled"];
  for (let i = 0; i < states.length; i++) {
    const state = states[i]!;
    const [row] = await sql<{ state: string }[]>`
      INSERT INTO committee_sessions (date, subject_id, subject_name, state)
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
    await sql`INSERT INTO committee_sessions (date, subject_id, subject_name, state)
        VALUES ('2031-03-01', 'regime-test-subject', 'Regime Test Subject', 'brief_published')`;
  } catch {
    threw = true;
  }
  expect(threw).toBe(true);
});

test("committee_session_members and committee_session_events round-trip a real session's roster snapshot and lifecycle history", async () => {
  await sql`INSERT INTO committee_subjects (id, status, name) VALUES ('regime-test-subject', 'active', 'Regime Test Subject')
            ON CONFLICT (id) DO NOTHING`;
  await sql`INSERT INTO committee_members (id, status, name, lens) VALUES ('regime-test-member', 'active', 'Regime Test Member', 'macro')
            ON CONFLICT (id) DO NOTHING`;
  const [session] = await sql<{ id: string }[]>`
    INSERT INTO committee_sessions (date, subject_id, subject_name, state)
    VALUES ('2031-04-01', 'regime-test-subject', 'Regime Test Subject', 'scheduled')
    RETURNING id`;

  await sql`INSERT INTO committee_session_members (session_id, member_id, member_name, member_lens, status)
            VALUES (${session.id}, 'regime-test-member', 'Regime Test Member', 'macro', 'expected')`;
  await sql`INSERT INTO committee_session_events (session_id, from_state, to_state, action, actor)
            VALUES (${session.id}, NULL, 'scheduled', 'create', 'admin')`;

  const [roster] = await sql<{ status: string }[]>`
    SELECT status FROM committee_session_members WHERE session_id = ${session.id} AND member_id = 'regime-test-member'`;
  expect(roster.status).toBe("expected");

  const events = await sql<{ action: string; to_state: string }[]>`
    SELECT action, to_state FROM committee_session_events WHERE session_id = ${session.id}`;
  expect(events).toEqual([{ action: "create", to_state: "scheduled" }]);

  // ON DELETE CASCADE: removing the session removes its roster/event rows too.
  await sql`DELETE FROM committee_sessions WHERE id = ${session.id}`;
  const [{ n: remainingRoster }] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM committee_session_members WHERE session_id = ${session.id}`;
  const [{ n: remainingEvents }] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM committee_session_events WHERE session_id = ${session.id}`;
  expect(remainingRoster).toBe(0);
  expect(remainingEvents).toBe(0);
});
