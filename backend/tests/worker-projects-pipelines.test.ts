// PROJECTS PIPELINE WORKER CONTRACT (issue #87). Runs against the ephemeral
// Postgres the preload provisions (real DB, never mocked). Asserts: every new
// projects.* kind resolves in the handler registry and is seeded idempotently in
// job_schedules; the pipeline upserts fixture-derived rows into the 0013(+)
// tables; discovery is idempotent (stable row counts); and a forced extractor
// failure leaves the last-persisted rows intact while the handler reports a
// non-success status (degrade-to-persisted, nothing fabricated).
import { test, expect } from "bun:test";
import { sql } from "../src/db/client.ts";
import { config } from "../src/config.ts";
import { getHandler, handlers } from "../src/worker/handlers/index.ts";
import { processOneJob } from "../src/worker/loop.ts";
import { liveProjectsDataSource } from "../src/projects/access/live-source.ts";
import {
  discover,
  fetchVaults,
  recomputeCoverage,
  refreshCoins,
  refreshWallets,
  snapshotDaily,
  syncRevenue,
} from "../src/worker/handlers/projects.ts";
import { failingSource, uniqueSlugSource } from "./support/projects-fixture-source.ts";

const KINDS = [
  "projects.discover",
  "projects.refresh_coins",
  "projects.refresh_wallets",
  "projects.sync_revenue",
  "projects.snapshot_daily",
  "projects.fetch_vaults",
  "projects.recompute_coverage",
];

async function projectIds(prefix: string): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`SELECT id FROM projects WHERE slug LIKE ${prefix + "-%"}`;
  return rows.map((r) => r.id);
}

async function counts(ids: string[]) {
  if (!ids.length) return { agents: 0, coins: 0, wallets: 0, vaults: 0 };
  const [[a], [c], [w], [v]] = await Promise.all([
    sql`SELECT count(*)::int n FROM openclaw_agents WHERE project_id IN ${sql(ids)}`,
    sql`SELECT count(*)::int n FROM lobster_coins WHERE project_id IN ${sql(ids)}`,
    sql`SELECT count(*)::int n FROM tracked_wallets WHERE project_id IN ${sql(ids)}`,
    sql`SELECT count(*)::int n FROM agent_vaults WHERE project_id IN ${sql(ids)}`,
  ]);
  return { agents: a.n as number, coins: c.n as number, wallets: w.n as number, vaults: v.n as number };
}

test("every projects.* kind resolves in the handler registry", () => {
  for (const k of KINDS) expect(typeof getHandler(k)).toBe("function");
});

test("every projects.* kind is seeded exactly once in job_schedules (idempotent)", async () => {
  // Re-seed first so this assertion is independent of test ordering (queue.test.ts
  // truncates job_schedules in its beforeEach). seed() is idempotent.
  const { seed } = await import("../src/db/seed.ts");
  await seed();
  for (const k of KINDS) {
    const rows = await sql<{ enabled: boolean }[]>`SELECT enabled FROM job_schedules WHERE kind = ${k}`;
    expect(rows.length).toBe(1);
    expect(rows[0].enabled).toBe(true);
  }
  // Re-running the seed must not duplicate schedule rows.
  await seed();
  for (const k of KINDS) {
    const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int n FROM job_schedules WHERE kind = ${k}`;
    expect(n).toBe(1);
  }
});

test("the full pipeline upserts fixture-derived rows; discovery is idempotent", async () => {
  const prefix = `wk_${crypto.randomUUID().slice(0, 8)}`;
  const src = uniqueSlugSource(prefix);

  const d = await discover({}, src);
  expect(d.ok).toBe(true);
  const ids = await projectIds(prefix);
  expect(ids.length).toBe(3);

  await refreshCoins({}, src);
  await refreshWallets({}, src);
  await fetchVaults({}, src);
  await snapshotDaily({ project_ids: ids });
  await syncRevenue({}, src);
  await recomputeCoverage({ project_ids: ids });

  // Rows landed with pipeline-derived values.
  const [{ mc }] = await sql<{ mc: number }[]>`
    SELECT market_cap::float8 AS mc FROM lobster_coins c JOIN projects p ON p.id = c.project_id
    WHERE p.slug = ${prefix + "-virtuals-protocol"} AND c.ticker = 'VIRTUAL'`;
  expect(mc).toBe(1_500_000_000);

  const [{ rev }] = await sql<{ rev: number }[]>`
    SELECT COALESCE(sum(revenue_usd),0)::float8 AS rev FROM agent_revenue_daily r
    JOIN openclaw_agents a ON a.id = r.agent_id WHERE a.project_id IN ${sql(ids)}`;
  expect(rev).toBeGreaterThan(0);

  const [{ snaps }] = await sql<{ snaps: number }[]>`
    SELECT count(*)::int AS snaps FROM daily_coin_snapshots s
    JOIN lobster_coins c ON c.id = s.coin_id WHERE c.project_id IN ${sql(ids)}`;
  expect(snaps).toBeGreaterThan(0);

  const [{ scored }] = await sql<{ scored: number }[]>`
    SELECT count(*)::int AS scored FROM projects WHERE id IN ${sql(ids)} AND data_coverage_score IS NOT NULL`;
  expect(scored).toBe(3);

  // Idempotent discovery: re-run leaves facet row counts unchanged (upsert, not
  // duplicate) so FK-linked snapshot/revenue rows survive.
  const before = await counts(ids);
  await discover({}, src);
  const after = await counts(ids);
  expect(after).toEqual(before);
});

test("admin-authored overview_short/overview_long survive a re-discovery run while facet columns still refresh (issue #93)", async () => {
  const prefix = `wkovr_${crypto.randomUUID().slice(0, 8)}`;
  const src = uniqueSlugSource(prefix);

  await discover({}, src);
  const slug = `${prefix}-virtuals-protocol`;
  const [before] = await sql<{ id: string; display_name: string }[]>`
    SELECT id, display_name FROM projects WHERE slug = ${slug}`;
  expect(before).toBeTruthy();
  const fixtureName = before.display_name; // what discovery writes for display_name

  // Simulate an admin edit of the overview text AND drift a refreshable facet
  // column (display_name) so the re-run can prove it refreshes that column.
  await sql`UPDATE projects SET
      overview_short = 'ADMIN SHORT', overview_long = 'ADMIN LONG', display_name = 'STALE NAME'
    WHERE id = ${before.id}`;

  // A subsequent scheduled discovery pass must NOT clobber the admin overview…
  await discover({}, src);
  const [after] = await sql<{ overview_short: string; overview_long: string; display_name: string }[]>`
    SELECT overview_short, overview_long, display_name FROM projects WHERE id = ${before.id}`;
  expect(after.overview_short).toBe("ADMIN SHORT");
  expect(after.overview_long).toBe("ADMIN LONG");
  // …while still refreshing non-overview columns back to the discovered values.
  expect(after.display_name).toBe(fixtureName);
  expect(after.display_name).not.toBe("STALE NAME");
});

test("a forced extractor failure leaves last-persisted rows intact and reports non-success", async () => {
  const prefix = `wkfail_${crypto.randomUUID().slice(0, 8)}`;
  const src = uniqueSlugSource(prefix);

  await discover({}, src);
  await refreshCoins({}, src); // persist real market caps

  const [{ before }] = await sql<{ before: number }[]>`
    SELECT market_cap::float8 AS before FROM lobster_coins c JOIN projects p ON p.id = c.project_id
    WHERE p.slug = ${prefix + "-virtuals-protocol"} AND c.ticker = 'VIRTUAL'`;
  expect(before).toBe(1_500_000_000);

  // Extractor throws → handler must NOT write and must report non-success.
  const res = await refreshCoins({}, failingSource(prefix));
  expect(res.ok).toBe(false);
  expect(res.status).toBe("degraded");

  const [{ after }] = await sql<{ after: number }[]>`
    SELECT market_cap::float8 AS after FROM lobster_coins c JOIN projects p ON p.id = c.project_id
    WHERE p.slug = ${prefix + "-virtuals-protocol"} AND c.ticker = 'VIRTUAL'`;
  expect(after).toBe(before); // last-persisted value untouched
});

// ── Issue #95: live-fetch timeout ────────────────────────────────────────────
// A stalled (not errored) provider socket must abort at the hard timeout so the
// handler fails FAST and degrades to last-persisted — never hangs, pinning the
// worker slot. Points the live source's Base-RPC eth_call at a server that
// accepts the connection but never responds, with a 200ms timeout.
test("a stalled live provider fetch aborts at the timeout and fetchVaults degrades to last-persisted (no hang)", async () => {
  const server = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) });
  const prevRpc = config.baseRpcUrl;
  const prevTimeout = process.env.LIVE_FETCH_TIMEOUT_MS;
  process.env.LIVE_FETCH_TIMEOUT_MS = "200";
  config.baseRpcUrl = `http://localhost:${server.port}`;

  let projectId: string | undefined;
  try {
    const slug = `wkstall_${crypto.randomUUID().slice(0, 8)}`;
    const [{ id }] = await sql<{ id: string }[]>`
      INSERT INTO projects (slug, display_name, status) VALUES (${slug}, 'Stall Vault', 'active') RETURNING id`;
    projectId = id;
    const vaultAddr = "0x" + "ab".repeat(20);
    await sql`INSERT INTO agent_vaults (project_id, name, vault_address, chain, strategy_type, data_source, is_active, tvl_usd)
              VALUES (${projectId}, 'stall', ${vaultAddr}, 'base', 'erc4626', 'live', true, 42424)`;

    const started = Date.now();
    const res = await fetchVaults({}, liveProjectsDataSource);
    const elapsed = Date.now() - started;

    expect(res.ok).toBe(false);
    expect(res.status).toBe("degraded"); // stalled fetch → degrade-to-persisted
    expect(elapsed).toBeLessThan(5000); // aborted at ~200ms, never hung the slot

    const [{ tvl }] = await sql<{ tvl: number }[]>`
      SELECT tvl_usd::float8 AS tvl FROM agent_vaults WHERE project_id = ${projectId} AND name = 'stall'`;
    expect(tvl).toBe(42424); // last-persisted value untouched
  } finally {
    config.baseRpcUrl = prevRpc;
    if (prevTimeout === undefined) delete process.env.LIVE_FETCH_TIMEOUT_MS;
    else process.env.LIVE_FETCH_TIMEOUT_MS = prevTimeout;
    server.stop(true);
    if (projectId) {
      await sql`DELETE FROM daily_tvl_snapshots WHERE vault_id IN (SELECT id FROM agent_vaults WHERE project_id = ${projectId})`;
      await sql`DELETE FROM agent_vaults WHERE project_id = ${projectId}`;
      await sql`DELETE FROM projects WHERE id = ${projectId}`;
    }
  }
}, 15_000);

// ── Issue #95: honest degraded-run signalling in the worker loop ─────────────
// A handler that returns { ok:false } (degraded) must NOT be recorded as
// 'succeeded' — the loop must write a distinct non-'succeeded' job_runs row and
// engage the exponential-backoff retry, but never escalate a persistently-flaky
// provider to 'dead' (last-persisted data stays, the schedule keeps firing).
test("the loop records a degraded handler result as a non-'succeeded' job_runs signal and retries with backoff", async () => {
  const kind = `test.projects_degrade_${crypto.randomUUID().slice(0, 8)}`;
  handlers[kind] = async () => ({ ok: false, status: "degraded", error: "forced degrade" });
  const jobIds: number[] = [];
  try {
    // Retryable: attempts remain → job goes back to 'pending' with a future
    // run_after (backoff engaged), and the run is recorded 'degraded'.
    const [{ id: retryId }] = await sql<{ id: number }[]>`
      INSERT INTO jobs (kind, priority, max_attempts) VALUES (${kind}, 1000000, 5) RETURNING id`;
    jobIds.push(retryId);
    expect(await processOneJob()).toBe(true);

    const [retryJob] = await sql<{ status: string; attempts: number; due: boolean }[]>`
      SELECT status, attempts, run_after > now() AS due FROM jobs WHERE id = ${retryId}`;
    expect(retryJob.status).toBe("pending"); // re-queued for retry
    expect(retryJob.attempts).toBe(1);
    expect(retryJob.due).toBe(true); // backoff pushed run_after into the future

    const [retryRun] = await sql<{ status: string }[]>`
      SELECT status FROM job_runs WHERE job_id = ${retryId} ORDER BY id DESC LIMIT 1`;
    expect(retryRun.status).toBe("degraded");
    expect(retryRun.status).not.toBe("succeeded");

    // Attempts exhausted (max_attempts=1): must NOT go 'dead' — settle
    // 'succeeded' so the schedule survives, while still recording 'degraded'.
    const [{ id: termId }] = await sql<{ id: number }[]>`
      INSERT INTO jobs (kind, priority, max_attempts) VALUES (${kind}, 1000000, 1) RETURNING id`;
    jobIds.push(termId);
    expect(await processOneJob()).toBe(true);

    const [termJob] = await sql<{ status: string }[]>`SELECT status FROM jobs WHERE id = ${termId}`;
    expect(termJob.status).not.toBe("dead"); // never escalate degrade to dead
    expect(termJob.status).toBe("succeeded"); // last-persisted intact; next cron re-enqueues

    const [termRun] = await sql<{ status: string }[]>`
      SELECT status FROM job_runs WHERE job_id = ${termId} ORDER BY id DESC LIMIT 1`;
    expect(termRun.status).toBe("degraded");
  } finally {
    delete handlers[kind];
    if (jobIds.length) {
      await sql`DELETE FROM job_runs WHERE job_id IN ${sql(jobIds)}`;
      await sql`DELETE FROM jobs WHERE id IN ${sql(jobIds)}`;
    }
  }
});

// ── Issue #95: empty project_ids guard ───────────────────────────────────────
// An explicit project_ids:[] must fall back to the whole-directory query, never
// build invalid `IN ()` SQL (which would throw and fail the run).
test("snapshotDaily/recomputeCoverage with project_ids:[] emit no invalid IN () SQL", async () => {
  const snap = await snapshotDaily({ project_ids: [] });
  expect(snap.ok).toBe(true); // did not throw on `IN ()`
  const cov = await recomputeCoverage({ project_ids: [] });
  expect(cov.ok).toBe(true);
});
