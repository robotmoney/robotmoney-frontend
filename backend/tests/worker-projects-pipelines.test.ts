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
  expect(ids.length).toBe(4);

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
  expect(scored).toBe(4);

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

// ── Issue #346: per-wallet degrade (never a whole-run abort) ─────────────────
// Before #346, ONE wallet's walletBalanceUsd throw aborted the entire
// refreshWallets run — every wallet, including ones whose read would have
// succeeded, stayed frozen at its last-persisted balance. Now a failing
// wallet degrades ALONE: the others still update, and nothing is fabricated
// for the one that failed.
test("refreshWallets degrades only the failing wallet — other wallets in the same run still update", async () => {
  const prefix = `wkwallet_${crypto.randomUUID().slice(0, 8)}`;
  const src = uniqueSlugSource(prefix);

  await discover({}, src);
  const [{ id: projectId }] = await sql<{ id: string }[]>`
    SELECT id FROM projects WHERE slug = ${prefix + "-virtuals-protocol"}`;

  // A second wallet on the same project whose address has no fixture entry —
  // walletBalanceUsd throws for it ("fixture wallet balance missing").
  const badAddress = "0xwalletbadbadbadbadbadbadbadbadbadbadbad";
  const [{ id: badWalletId }] = await sql<{ id: string }[]>`
    INSERT INTO tracked_wallets (project_id, label, chain, address, is_active, balance_usd)
    VALUES (${projectId}, 'No Fixture Wallet', 'base', ${badAddress}, true, 111)
    RETURNING id`;

  // refreshWallets scans EVERY active tracked_wallets row, not just this
  // test's project (no project_ids scoping on this handler), so other tests'
  // wallets sharing the DB contribute to the totals — assert on failed/ok/
  // status (which our forced-bad wallet guarantees) rather than an exact
  // global `updated` count, and confirm the specific rows below.
  const res = await refreshWallets({}, src);
  // `ok` reflects ANY per-wallet failure, not "did at least one succeed" —
  // it must line up with status:"degraded" the same way every other handler's
  // ok<->status pairing does, because loop.ts's isDegradedResult gate (retry/
  // backoff/admin-visibility) keys purely off `ok === false` (issue #346
  // review finding: a partial failure that reported ok:true fell through to
  // the ordinary success path and was invisible to that machinery).
  expect(res.ok).toBe(false);
  expect(res.status).toBe("degraded"); // the run as a whole is non-clean
  expect(res.failed as number).toBeGreaterThanOrEqual(1);
  expect(res.updated as number).toBeGreaterThanOrEqual(1);

  // The known wallet (discovered, has a fixture) got a fresh balance + refreshed_at.
  const [{ balance_usd: goodBalance, refreshed_at: goodRefreshedAt }] = await sql<{ balance_usd: string; refreshed_at: Date | null }[]>`
    SELECT balance_usd, refreshed_at FROM tracked_wallets WHERE project_id = ${projectId} AND label != 'No Fixture Wallet'`;
  expect(Number(goodBalance)).toBeGreaterThan(0);
  expect(goodRefreshedAt).not.toBeNull();

  // The failing wallet's balance and refreshed_at are UNTOUCHED — never
  // fabricated, never silently zeroed.
  const [{ balance_usd: badBalance, refreshed_at: badRefreshedAt }] = await sql<{ balance_usd: string; refreshed_at: Date | null }[]>`
    SELECT balance_usd, refreshed_at FROM tracked_wallets WHERE id = ${badWalletId}`;
  expect(Number(badBalance)).toBe(111);
  expect(badRefreshedAt).toBeNull();
});

// ── Issue #346 (review finding): partial wallet failure must be visible to
// the REAL dispatch path, not just to a direct refreshWallets() call ─────────
// A `refreshWallets()` unit call proved the handler's return shape, but never
// exercised loop.ts's isDegradedResult gate — the only place that decides
// whether a partial failure gets retried, keeps a truthful last_error, and
// shows up in job_runs/GET /api/admin/runs?status=degraded. Drive this
// through processOneJob() (temporarily rebinding the real
// "projects.refresh_wallets" registry entry to a fixture source with one bad
// wallet) so the assertion covers the actual production wiring, not a proxy.
test("processOneJob routes a partial-wallet-failure refresh_wallets run to job_runs.status='degraded' with a populated last_error and a scheduled backoff retry", async () => {
  const prefix = `wkjob_${crypto.randomUUID().slice(0, 8)}`;
  const src = uniqueSlugSource(prefix);

  await discover({}, src);
  const [{ id: projectId }] = await sql<{ id: string }[]>`
    SELECT id FROM projects WHERE slug = ${prefix + "-virtuals-protocol"}`;
  const badAddress = "0xwalletbadbadbadbadbadbadbadbadbadbadjob";
  await sql`
    INSERT INTO tracked_wallets (project_id, label, chain, address, is_active, balance_usd)
    VALUES (${projectId}, 'No Fixture Wallet (job)', 'base', ${badAddress}, true, 222)`;

  const kind = "projects.refresh_wallets";
  const original = handlers[kind];
  handlers[kind] = (payload) => refreshWallets(payload, src);
  const jobIds: number[] = [];
  try {
    const [{ id: jobId }] = await sql<{ id: number }[]>`
      INSERT INTO jobs (kind, priority, max_attempts) VALUES (${kind}, 1000000, 5) RETURNING id`;
    jobIds.push(jobId);

    expect(await processOneJob()).toBe(true);

    const [job] = await sql<{ status: string; attempts: number; due: boolean; last_error: string | null }[]>`
      SELECT status, attempts, run_after > now() AS due, last_error FROM jobs WHERE id = ${jobId}`;
    // Retryable (attempts=1 < max_attempts=5): re-queued as 'pending' with a
    // future run_after (backoff engaged) — NEVER 'succeeded' with a cleared
    // last_error, which is exactly what a wrongly-`ok:true` degraded result
    // used to produce (the gap the reviewer found invisible to CI).
    expect(job.status).toBe("pending");
    expect(job.status).not.toBe("succeeded");
    expect(job.attempts).toBe(1);
    expect(job.due).toBe(true); // backoff retry scheduled
    expect(job.last_error).toBeTruthy(); // last_error populated, not cleared

    const [run] = await sql<{ status: string }[]>`
      SELECT status FROM job_runs WHERE job_id = ${jobId} ORDER BY id DESC LIMIT 1`;
    expect(run.status).toBe("degraded");
    expect(run.status).not.toBe("succeeded");
  } finally {
    handlers[kind] = original;
    if (jobIds.length) {
      await sql`DELETE FROM job_runs WHERE job_id IN ${sql(jobIds)}`;
      await sql`DELETE FROM jobs WHERE id IN ${sql(jobIds)}`;
    }
  }
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
