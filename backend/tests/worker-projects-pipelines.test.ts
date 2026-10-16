// PROJECTS PIPELINE WORKER CONTRACT (issue #87). Runs against the ephemeral
// Postgres the preload provisions (real DB, never mocked). Asserts: every new
// projects.* kind resolves in the handler registry and is seeded idempotently in
// job_schedules; the pipeline upserts fixture-derived rows into the 0013(+)
// tables; discovery is idempotent (stable row counts); and a forced extractor
// failure leaves the last-persisted rows intact while the handler reports a
// non-success status (degrade-to-persisted, nothing fabricated).
import { test, expect } from "bun:test";
import { sql } from "../src/db/client.ts";
import { fixtureDb } from "./support/fixture-db.ts";
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
import type { DiscoveredVault, ProjectsDataSource } from "../src/projects/access/data-source.ts";
import { loadV0RosterWithManifest } from "../src/projects/seed/roster-seed.ts";
import { failingSource, uniqueSlugSource } from "./support/projects-fixture-source.ts";
import {
  _resetRpcConcurrencyForTests,
  decodeAggregate3Calls,
  encodeAggregate3Result,
  MULTICALL3_ADDRESS,
  type Aggregate3Result,
} from "../src/chain/base-rpc-client.ts";
import { _resetTokenPriceCacheForTests } from "../src/chain/token-prices.ts";

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
  await seed(fixtureDb);
  for (const k of KINDS) {
    const rows = await sql<{ enabled: boolean }[]>`SELECT enabled FROM job_schedules WHERE kind = ${k}`;
    expect(rows.length).toBe(1);
    expect(rows[0].enabled).toBe(true);
  }
  // Re-running the seed must not duplicate schedule rows.
  await seed(fixtureDb);
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
  await fixtureDb`UPDATE projects SET
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

// ── Issue #1047: the paid CoinGecko key never leaks through a degraded run ────
// refreshCoins on the LIVE source with COINGECKO_API_KEY set, CoinGecko stubbed
// to 401 at the process boundary. The run must degrade (nothing written), and
// neither the returned result — which the loop copies into job_runs — nor the
// console.error the degraded() helper writes may contain the key.
test("refreshCoins with the CoinGecko key set and a 401 degrades without leaking the key", async () => {
  const KEY = "cg-worker-test-key-5b1d02aa-never-log-me";
  const prevKey = process.env.COINGECKO_API_KEY;
  const realFetch = globalThis.fetch;
  const realError = console.error;
  const realLog = console.log;
  const errors: string[] = [];
  const urls: string[] = [];
  process.env.COINGECKO_API_KEY = KEY;
  globalThis.fetch = (async (input: string | URL | Request) => {
    urls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    return new Response(JSON.stringify({ status: { error_code: 401 } }), { status: 401 });
  }) as typeof fetch;
  const capture = (...args: unknown[]) => {
    errors.push(args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack ?? ""}` : String(a))).join(" "));
  };
  console.error = capture;
  console.log = capture;

  const slug = `wkcgkey_${crypto.randomUUID().slice(0, 8)}`;
  let projectId: string | undefined;
  try {
    const [{ id }] = await fixtureDb<{ id: string }[]>`
      INSERT INTO projects (slug, display_name, status) VALUES (${slug}, 'CG Key', 'active') RETURNING id`;
    projectId = id;
    await fixtureDb`INSERT INTO lobster_coins (project_id, name, ticker, coingecko_id, is_active, market_cap)
              VALUES (${projectId}, 'CG Key Coin', 'CGK', 'virtual-protocol', true, 777)`;

    const res = await refreshCoins({}, liveProjectsDataSource);

    expect(res.ok).toBe(false);
    expect(res.status).toBe("degraded");
    expect(urls.some((u) => u.startsWith("https://pro-api.coingecko.com/api/v3/coins/markets?"))).toBe(true);
    expect(String(res.error)).toContain("pro-api.coingecko.com");
    expect(String(res.error)).toContain("401");
    expect(JSON.stringify(res)).not.toContain(KEY);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join("\n")).not.toContain(KEY);

    const [{ mc }] = await fixtureDb<{ mc: number }[]>`
      SELECT market_cap::float8 AS mc FROM lobster_coins WHERE project_id = ${projectId}`;
    expect(mc).toBe(777); // degraded: last-persisted value untouched
  } finally {
    globalThis.fetch = realFetch;
    console.error = realError;
    console.log = realLog;
    if (prevKey === undefined) delete process.env.COINGECKO_API_KEY;
    else process.env.COINGECKO_API_KEY = prevKey;
    if (projectId) {
      await fixtureDb`DELETE FROM lobster_coins WHERE project_id = ${projectId}`;
      await fixtureDb`DELETE FROM projects WHERE id = ${projectId}`;
    }
  }
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
  const [{ id: badWalletId }] = await fixtureDb<{ id: string }[]>`
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
  await fixtureDb`
    INSERT INTO tracked_wallets (project_id, label, chain, address, is_active, balance_usd)
    VALUES (${projectId}, 'No Fixture Wallet (job)', 'base', ${badAddress}, true, 222)`;

  const kind = "projects.refresh_wallets";
  const original = handlers[kind];
  handlers[kind] = (payload) => refreshWallets(payload, src);
  const jobIds: number[] = [];
  try {
    const [{ id: jobId }] = await fixtureDb<{ id: number }[]>`
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
      await fixtureDb`DELETE FROM job_runs WHERE job_id IN ${sql(jobIds)}`;
      await fixtureDb`DELETE FROM jobs WHERE id IN ${sql(jobIds)}`;
    }
  }
});

// ── Issue 1275: wallets with no live read path are skipped, not failed ──────
// Production carries roster wallets on Ethereum/Solana and non-EVM addresses.
// The live source has no read path for them, so each run used to log one
// error per wallet and end degraded, which retried the job 5 times every slot.
// refreshWallets now asks supportsWallet first and skips them quietly, while a
// Base wallet whose read really fails still logs an error and degrades the run.
//
// refreshWallets scans every active wallet in the shared DB, so each test
// parks the other active wallets for its run and restores them after, which
// keeps the counts exact.
async function withOnlyWallets<T>(ids: string[], run: () => Promise<T>): Promise<T> {
  const parked = await fixtureDb<{ id: string }[]>`
    UPDATE tracked_wallets SET is_active = false WHERE is_active = true AND id NOT IN ${sql(ids)} RETURNING id`;
  try {
    return await run();
  } finally {
    if (parked.length) await fixtureDb`UPDATE tracked_wallets SET is_active = true WHERE id IN ${sql(parked.map((r) => r.id))}`;
  }
}

async function seedUnsupportedWallets(tag: string, base: { label: string; address: string }) {
  const [{ id: projectId }] = await fixtureDb<{ id: string }[]>`
    INSERT INTO projects (slug, display_name, status) VALUES (${`wkunsup_${tag}`}, 'Unsupported Wallets', 'active') RETURNING id`;
  const rows = await fixtureDb<{ id: string; label: string }[]>`
    INSERT INTO tracked_wallets (project_id, label, chain, address, is_active, balance_usd) VALUES
      (${projectId}, 'eth-treasury', 'ethereum', ${"0x" + "ee".repeat(20)}, true, 500),
      (${projectId}, 'solana-on-base', 'base', '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU', true, 600),
      (${projectId}, ${base.label}, 'base', ${base.address}, true, 700)
    RETURNING id, label`;
  const byLabel = Object.fromEntries(rows.map((r) => [r.label, r.id]));
  return { projectId, ids: rows.map((r) => r.id), byLabel };
}

function liveRuleSource(read: (address: string) => Promise<number>, calls: string[]): ProjectsDataSource {
  return {
    ...uniqueSlugSource("wkunsup"),
    supportsWallet: liveProjectsDataSource.supportsWallet,
    async walletBalanceUsd(address: string) {
      calls.push(address);
      return read(address);
    },
  };
}

function captureConsole() {
  const errors: string[] = [];
  const infos: string[] = [];
  const origError = console.error;
  const origLog = console.log;
  console.error = (...a: unknown[]) => void errors.push(a.map(String).join(" "));
  console.log = (...a: unknown[]) => void infos.push(a.map(String).join(" "));
  return { errors, infos, restore: () => ((console.error = origError), (console.log = origLog)) };
}

test("refreshWallets skips a non-base wallet and a non-EVM-address wallet without reading them, keeps their balance, and stays ok", async () => {
  const tag = crypto.randomUUID().slice(0, 8);
  const goodAddress = "0x" + "ab".repeat(20);
  const { projectId, ids, byLabel } = await seedUnsupportedWallets(tag, { label: "base-good", address: goodAddress });
  const calls: string[] = [];
  const src = liveRuleSource(async () => 1234, calls);
  const con = captureConsole();
  try {
    const res = await withOnlyWallets(ids, () => refreshWallets({}, src));
    con.restore();

    expect(res).toEqual({ ok: true, status: "ok", updated: 1, failed: 0, unsupported: 2 });
    // Only the Base wallet with a real address was read.
    expect(calls).toEqual([goodAddress]);
    // No error line for a wallet that has no live path; one info summary.
    expect(con.errors).toEqual([]);
    const summary = con.infos.filter((l) => l.includes("[projects.refresh_wallets]"));
    expect(summary.length).toBe(1);
    expect(summary[0]).toContain("skipped 2 of 3 wallet(s)");

    const rows = await sql<{ id: string; balance_usd: string; refreshed_at: Date | null }[]>`
      SELECT id, balance_usd, refreshed_at FROM tracked_wallets WHERE id IN ${sql(ids)}`;
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(Number(byId[byLabel["eth-treasury"]].balance_usd)).toBe(500);
    expect(byId[byLabel["eth-treasury"]].refreshed_at).toBeNull();
    expect(Number(byId[byLabel["solana-on-base"]].balance_usd)).toBe(600);
    expect(byId[byLabel["solana-on-base"]].refreshed_at).toBeNull();
    expect(Number(byId[byLabel["base-good"]].balance_usd)).toBe(1234);
    expect(byId[byLabel["base-good"]].refreshed_at).not.toBeNull();
  } finally {
    con.restore();
    await fixtureDb`DELETE FROM projects WHERE id = ${projectId}`;
  }
});

test("refreshWallets still logs an error and degrades for a base wallet whose read throws, with none for the skipped wallets", async () => {
  const tag = crypto.randomUUID().slice(0, 8);
  const badAddress = "0x" + "bc".repeat(20);
  const { projectId, ids, byLabel } = await seedUnsupportedWallets(tag, { label: "base-broken", address: badAddress });
  const calls: string[] = [];
  const src = liveRuleSource(async () => {
    throw new Error("Base RPC: forced read failure");
  }, calls);
  const con = captureConsole();
  try {
    const res = await withOnlyWallets(ids, () => refreshWallets({}, src));
    con.restore();

    expect(res).toEqual({ ok: false, status: "degraded", updated: 0, failed: 1, unsupported: 2 });
    expect(calls).toEqual([badAddress]);
    // Exactly one error line, and it names the Base wallet, not a skipped one.
    expect(con.errors.length).toBe(1);
    expect(con.errors[0]).toContain(`wallet ${byLabel["base-broken"]} live read failed`);
    expect(con.errors[0]).not.toContain(byLabel["eth-treasury"]);
    expect(con.errors[0]).not.toContain(byLabel["solana-on-base"]);

    const [{ balance_usd }] = await sql<{ balance_usd: string }[]>`
      SELECT balance_usd FROM tracked_wallets WHERE id = ${byLabel["base-broken"]}`;
    expect(Number(balance_usd)).toBe(700);
  } finally {
    con.restore();
    await fixtureDb`DELETE FROM projects WHERE id = ${projectId}`;
  }
});

// ── Issue 1373: one refresh reads every Base wallet in a few Multicall3 POSTs ─
// Production (2026-10-14) refreshed 793 wallets one Multicall3 POST each through
// the shared 0.25 calls/s Base RPC bucket: 52 min per attempt. These tests run
// the REAL live source and transport over 785 Base wallets, with fetch mocked
// only at the process boundary, and count what goes on the wire.
const PROD_BASE_WALLETS = 785;
const GET_ETH_BALANCE = "0x4d2301cc";

interface CountingTransport {
  posts: string[][]; // the wallets each Base RPC POST asked for
  priceReads: number;
}

function countingTransport(opts: { revert?: string; failPostWith?: string } = {}): CountingTransport {
  const t: CountingTransport = { posts: [], priceReads: 0 };
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("geckoterminal.com")) {
      t.priceReads += 1;
      const addrs = u.split("/token_price/")[1]!.toLowerCase().split(",");
      const token_prices = Object.fromEntries(addrs.map((a) => [a, "2000"]));
      return new Response(JSON.stringify({ data: { attributes: { token_prices } } }), { status: 200 });
    }
    const body = JSON.parse(String(init?.body)) as { id?: number; method: string; params: [{ to: string; data: string }, string] };
    expect(body.method).toBe("eth_call");
    expect(body.params[0].to).toBe(MULTICALL3_ADDRESS);
    const calls = decodeAggregate3Calls(body.params[0].data);
    for (const c of calls) expect(c.callData.slice(0, 10)).toBe(GET_ETH_BALANCE);
    const wallets = calls.map((c) => "0x" + c.callData.slice(-40));
    t.posts.push(wallets);
    if (opts.failPostWith && wallets.includes(opts.failPostWith)) {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id ?? 1, error: { code: -32000, message: "forced chunk failure" } }), { status: 200 });
    }
    const results: Aggregate3Result[] = wallets.map((w) =>
      w === opts.revert ? { success: false, returnData: "0x" } : { success: true, returnData: "0x" + (10n ** 18n).toString(16).padStart(64, "0") },
    );
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id ?? 1, result: encodeAggregate3Result(results) }), { status: 200 });
  }) as unknown as typeof fetch;
  return t;
}

// 785 Base wallets at a stale $5 balance, under one throwaway project.
async function seedBaseWallets(tag: string): Promise<{ projectId: string; rows: { id: string; address: string }[] }> {
  const [{ id: projectId }] = await fixtureDb<{ id: string }[]>`
    INSERT INTO projects (slug, display_name, status) VALUES (${`wkbatch_${tag}`}, 'Batched Wallets', 'active') RETURNING id`;
  const values = Array.from({ length: PROD_BASE_WALLETS }, (_, i) => ({
    project_id: projectId,
    label: `w${i}`,
    chain: "base",
    address: "0x" + tag + i.toString(16).padStart(32, "0"),
    is_active: true,
    balance_usd: 5,
  }));
  const rows = await fixtureDb<{ id: string; address: string }[]>`
    INSERT INTO tracked_wallets ${sql(values)}
    RETURNING id, address`;
  return { projectId, rows };
}

async function balancesById(ids: string[]): Promise<Map<string, { balance: number; refreshed: boolean }>> {
  const rows = await sql<{ id: string; balance_usd: string; refreshed_at: Date | null }[]>`
    SELECT id, balance_usd, refreshed_at FROM tracked_wallets WHERE id IN ${sql(ids)}`;
  return new Map(rows.map((r) => [r.id, { balance: Number(r.balance_usd), refreshed: r.refreshed_at !== null }]));
}

async function withLiveTransport<T>(run: () => Promise<T>): Promise<T> {
  const realFetch = globalThis.fetch;
  _resetRpcConcurrencyForTests();
  _resetTokenPriceCacheForTests();
  try {
    return await run();
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.BASE_RPC_MAX_RETRIES;
    _resetRpcConcurrencyForTests();
    _resetTokenPriceCacheForTests();
  }
}

test("refreshWallets over 785 Base wallets issues at most 10 Base RPC POSTs and one ETH price read, and updates every wallet", async () => {
  const tag = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  const { projectId, rows } = await seedBaseWallets(tag);
  const ids = rows.map((r) => r.id);
  try {
    await withLiveTransport(async () => {
      const t = countingTransport();
      const res = await withOnlyWallets(ids, () => refreshWallets({}, liveProjectsDataSource));

      expect(res).toEqual({ ok: true, status: "ok", updated: PROD_BASE_WALLETS, failed: 0, unsupported: 0 });
      expect(t.posts.length).toBeLessThanOrEqual(10);
      expect(t.priceReads).toBe(1);
      expect(t.posts.flat().length).toBe(PROD_BASE_WALLETS); // every wallet asked for once
      const after = await balancesById(ids);
      for (const id of ids) expect(after.get(id)).toEqual({ balance: 2000, refreshed: true });
    });
  } finally {
    await fixtureDb`DELETE FROM projects WHERE id = ${projectId}`;
  }
});

test("refreshWallets: a wallet whose getEthBalance sub-call fails keeps its balance and counts as failed; the rest of its chunk updates", async () => {
  const tag = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  const { projectId, rows } = await seedBaseWallets(tag);
  const ids = rows.map((r) => r.id);
  const reverted = rows[7]!;
  try {
    await withLiveTransport(async () => {
      const t = countingTransport({ revert: reverted.address });
      const res = await withOnlyWallets(ids, () => refreshWallets({}, liveProjectsDataSource));

      expect(res).toEqual({ ok: false, status: "degraded", updated: PROD_BASE_WALLETS - 1, failed: 1, unsupported: 0 });
      const chunk = new Set(t.posts.find((p) => p.includes(reverted.address))!);
      expect(chunk.size).toBeGreaterThan(1);
      const after = await balancesById(ids);
      expect(after.get(reverted.id)).toEqual({ balance: 5, refreshed: false });
      for (const r of rows) {
        if (r.id !== reverted.id) expect(after.get(r.id)).toEqual({ balance: 2000, refreshed: true });
      }
    });
  } finally {
    await fixtureDb`DELETE FROM projects WHERE id = ${projectId}`;
  }
});

test("refreshWallets: a chunk whose POST throws fails only that chunk's wallets; wallets in other chunks update", async () => {
  const tag = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  const { projectId, rows } = await seedBaseWallets(tag);
  const ids = rows.map((r) => r.id);
  const inBrokenChunk = rows[400]!.address;
  process.env.BASE_RPC_MAX_RETRIES = "0";
  try {
    await withLiveTransport(async () => {
      const t = countingTransport({ failPostWith: inBrokenChunk });
      const res = await withOnlyWallets(ids, () => refreshWallets({}, liveProjectsDataSource));

      const broken = new Set(t.posts.find((p) => p.includes(inBrokenChunk))!);
      expect(broken.size).toBeGreaterThan(0);
      expect(broken.size).toBeLessThan(PROD_BASE_WALLETS);
      expect(res).toEqual({ ok: false, status: "degraded", updated: PROD_BASE_WALLETS - broken.size, failed: broken.size, unsupported: 0 });
      const after = await balancesById(ids);
      for (const r of rows) {
        expect(after.get(r.id)).toEqual(broken.has(r.address) ? { balance: 5, refreshed: false } : { balance: 2000, refreshed: true });
      }
    });
  } finally {
    await fixtureDb`DELETE FROM projects WHERE id = ${projectId}`;
  }
});

// ── Issue #95: live-fetch timeout ────────────────────────────────────────────
// A stalled (not errored) provider socket must abort at the hard timeout so the
// handler fails FAST and degrades to last-persisted — never hangs, pinning the
// worker slot. Points the live source's Base-RPC eth_call at a server that
// accepts the connection but never responds, with a 200ms timeout.
test("a stalled live provider fetch aborts at the timeout and fetchVaults degrades to last-persisted (no hang)", async () => {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Promise<Response>(() => {}) });
  const prevRpc = config.baseRpcUrl;
  const prevTimeout = process.env.LIVE_FETCH_TIMEOUT_MS;
  process.env.LIVE_FETCH_TIMEOUT_MS = "200";
  config.baseRpcUrl = `http://localhost:${server.port}`;

  let projectId: string | undefined;
  try {
    const slug = `wkstall_${crypto.randomUUID().slice(0, 8)}`;
    const [{ id }] = await fixtureDb<{ id: string }[]>`
      INSERT INTO projects (slug, display_name, status) VALUES (${slug}, 'Stall Vault', 'active') RETURNING id`;
    projectId = id;
    const vaultAddr = "0x" + "ab".repeat(20);
    const [{ id: vaultId }] = await fixtureDb<{ id: string }[]>`INSERT INTO agent_vaults (project_id, name, vault_address, chain, strategy_type, data_source, is_active, tvl_usd)
              VALUES (${projectId}, 'stall', ${vaultAddr}, 'base', 'erc4626', 'live', true, 42424) RETURNING id`;

    // Issue 1291: fetchVaults now reads every vault even after one fails, so
    // the other tests' live vaults are parked to keep this run to one read.
    const started = Date.now();
    const res = await withOnlyVaults([vaultId], () => fetchVaults({}, liveProjectsDataSource));
    const elapsed = Date.now() - started;

    expect(res.ok).toBe(false);
    expect(res.status).toBe("degraded"); // stalled fetch → degrade-to-persisted
    expect(res.terminal).toBeUndefined(); // a timeout is transient: the loop retries it
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
      await fixtureDb`DELETE FROM daily_tvl_snapshots WHERE vault_id IN (SELECT id FROM agent_vaults WHERE project_id = ${projectId})`;
      await fixtureDb`DELETE FROM agent_vaults WHERE project_id = ${projectId}`;
      await fixtureDb`DELETE FROM projects WHERE id = ${projectId}`;
    }
  }
}, 15_000);

// ── Issue 1291: fetchVaults isolates each vault ──────────────────────────────
// Production 2026-10-14 and the v0.6.2 stage QA run 2026-10-15: the Bankr
// Agent Token LP (0x7689006F6C3A3473449E42b628544E60D0bCCb07, strategy_type
// lp-fees) is not an ERC-4626 vault, so totalAssets() reverts on Base. The
// handler read every vault in one try block, so that one revert ended the run
// with updated: 0 and no vault's TVL updated. These tests drive the REAL live
// source over a mocked Base RPC: one vault reverts totalAssets() and asset()
// the way the Bankr LP does, the other answers like Robot Money USDC.
const BANKR_LP = "0x7689006F6C3A3473449E42b628544E60D0bCCb07";
const USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const SEL_TOTAL_ASSETS = "0x01e1d114";
const SEL_ASSET = "0x38d52e0f";
const SEL_DECIMALS = "0x313ce567";
const word = (n: bigint) => "0x" + n.toString(16).padStart(64, "0");

// fetchVaults reads every active live vault in the shared DB, so each test
// parks the others for its run and restores them after.
async function withOnlyVaults<T>(ids: string[], run: () => Promise<T>): Promise<T> {
  const parked = await fixtureDb<{ id: string }[]>`
    UPDATE agent_vaults SET is_active = false
    WHERE is_active = true AND data_source = 'live' AND id NOT IN ${sql(ids)} RETURNING id`;
  try {
    return await run();
  } finally {
    if (parked.length) await fixtureDb`UPDATE agent_vaults SET is_active = true WHERE id IN ${sql(parked.map((r) => r.id))}`;
  }
}

// Answers each Multicall3 sub-call: a vault in `reverting` reverts every call,
// any other vault holds 1234.5 USDC. USDC answers decimals() = 6.
function vaultTransport(reverting: Set<string>): { posts: number } {
  const t = { posts: 0 };
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    t.posts += 1;
    const body = JSON.parse(String(init?.body)) as { id?: number; params: [{ to: string; data: string }, string] };
    const { to, data } = body.params[0];
    const reply = (result: string) => new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id ?? 1, result }), { status: 200 });
    if (to.toLowerCase() === USDC_BASE && data.startsWith(SEL_DECIMALS)) return reply(word(6n));
    expect(to).toBe(MULTICALL3_ADDRESS);
    const results: Aggregate3Result[] = decodeAggregate3Calls(data).map((c) => {
      if (reverting.has(c.target.toLowerCase())) return { success: false, returnData: "0x" };
      if (c.callData.startsWith(SEL_TOTAL_ASSETS)) return { success: true, returnData: word(1_234_500_000n) };
      if (c.callData.startsWith(SEL_ASSET)) return { success: true, returnData: word(BigInt(USDC_BASE)) };
      throw new Error(`unexpected sub-call ${c.callData}`);
    });
    return reply(encodeAggregate3Result(results));
  }) as unknown as typeof fetch;
  return t;
}

async function seedVaults(tag: string, rows: { name: string; address: string; tvl: number | null }[]) {
  const [{ id: projectId }] = await fixtureDb<{ id: string }[]>`
    INSERT INTO projects (slug, display_name, status) VALUES (${`wkvault_${tag}`}, 'Vault Isolation', 'active') RETURNING id`;
  const byName: Record<string, string> = {};
  for (const r of rows) {
    const [{ id }] = await fixtureDb<{ id: string }[]>`
      INSERT INTO agent_vaults (project_id, name, vault_address, chain, strategy_type, data_source, is_active, tvl_usd, last_refresh_status)
      VALUES (${projectId}, ${r.name}, ${r.address}, 'base', 'erc4626', 'live', true, ${r.tvl}, 'ok') RETURNING id`;
    byName[r.name] = id;
  }
  return { projectId, byName, ids: Object.values(byName) };
}

async function vaultRow(id: string) {
  const [r] = await sql<{ tvl: number | null; status: string | null; refreshed_at: Date | null }[]>`
    SELECT tvl_usd::float8 AS tvl, last_refresh_status AS status, refreshed_at FROM agent_vaults WHERE id = ${id}`;
  return r!;
}

async function dropProject(projectId: string) {
  await fixtureDb`DELETE FROM daily_tvl_snapshots WHERE vault_id IN (SELECT id FROM agent_vaults WHERE project_id = ${projectId})`;
  await fixtureDb`DELETE FROM agent_vaults WHERE project_id = ${projectId}`;
  await fixtureDb`DELETE FROM projects WHERE id = ${projectId}`;
}

test("fetchVaults: a vault whose totalAssets() reverts keeps its TVL and is marked failed; the valid vault still updates", async () => {
  const tag = crypto.randomUUID().slice(0, 8);
  const { projectId, byName, ids } = await seedVaults(tag, [
    { name: "bankr-lp", address: BANKR_LP, tvl: 999 },
    { name: "rmusdc", address: "0x" + "4f".repeat(20), tvl: 1 },
  ]);
  const con = captureConsole();
  try {
    await withLiveTransport(async () => {
      vaultTransport(new Set([BANKR_LP.toLowerCase()]));
      const res = await withOnlyVaults(ids, () => fetchVaults({}, liveProjectsDataSource));
      con.restore();

      expect(res).toEqual({ ok: true, status: "ok", updated: 1, failed: 1 });

      const good = await vaultRow(byName["rmusdc"]!);
      expect(good.tvl).toBe(1234.5);
      expect(good.status).toBe("ok");
      expect(good.refreshed_at).not.toBeNull();

      const bad = await vaultRow(byName["bankr-lp"]!);
      expect(bad.tvl).toBe(999); // last-persisted TVL kept, never zeroed
      expect(bad.status).toBe("failed");
      expect(bad.refreshed_at).toBeNull(); // not refreshed: no new TVL was read

      // One line for the failing vault, naming it, and no whole-run line.
      expect(con.errors).toEqual([
        `[projects.fetch_vaults] vault ${byName["bankr-lp"]} live read failed, keeping last-persisted TVL (degraded): live-source: totalAssets() failed for ${BANKR_LP}`,
      ]);
    });
  } finally {
    con.restore();
    await dropProject(projectId);
  }
});

test("fetchVaults: when every vault fails the run is ok:false, status degraded, and every TVL is kept", async () => {
  const tag = crypto.randomUUID().slice(0, 8);
  const other = "0x" + "22".repeat(20);
  const { projectId, byName, ids } = await seedVaults(tag, [
    { name: "bankr-lp", address: BANKR_LP, tvl: 999 },
    { name: "bnkr-pool", address: other, tvl: 555 },
  ]);
  const con = captureConsole();
  try {
    await withLiveTransport(async () => {
      vaultTransport(new Set([BANKR_LP.toLowerCase(), other]));
      const res = await withOnlyVaults(ids, () => fetchVaults({}, liveProjectsDataSource));
      con.restore();

      expect(res.ok).toBe(false);
      expect(res.status).toBe("degraded");
      expect(res.updated).toBe(0);
      expect(res.failed).toBe(2);
      // Both are reverts: no retry can change the answer.
      expect(res.terminal).toBe(true);
      expect(con.errors.length).toBe(2);
      expect((await vaultRow(byName["bankr-lp"]!)).tvl).toBe(999);
      expect((await vaultRow(byName["bnkr-pool"]!)).tvl).toBe(555);
      expect((await vaultRow(byName["bankr-lp"]!)).status).toBe("failed");
      expect((await vaultRow(byName["bnkr-pool"]!)).status).toBe("failed");
    });
  } finally {
    con.restore();
    await dropProject(projectId);
  }
});

test("processOneJob: a totalAssets() revert never requeues projects.fetch_vaults on the 2 s backoff", async () => {
  const tag = crypto.randomUUID().slice(0, 8);
  const { projectId, ids: mixedIds } = await seedVaults(tag, [
    { name: "bankr-lp", address: BANKR_LP, tvl: 999 },
    { name: "rmusdc", address: "0x" + "4f".repeat(20), tvl: 1 },
  ]);
  const onlyBankr = [mixedIds[0]!];
  const kind = "projects.fetch_vaults";
  const original = handlers[kind];
  const jobIds: number[] = [];
  const con = captureConsole();
  try {
    await withLiveTransport(async () => {
      vaultTransport(new Set([BANKR_LP.toLowerCase()]));
      // Mixed run (production today): the revert is counted and the job succeeds.
      // Only revert(s) left: the job settles at once, never 'pending' with a backoff.
      for (const [scope, expected] of [
        [mixedIds, { job: "succeeded", run: "succeeded" }],
        [onlyBankr, { job: "failed", run: "failed" }],
      ] as const) {
        handlers[kind] = (payload) => withOnlyVaults([...scope], () => fetchVaults(payload, liveProjectsDataSource));
        const [{ id: jobId }] = await fixtureDb<{ id: number }[]>`
          INSERT INTO jobs (kind, priority, max_attempts) VALUES (${kind}, 1000000, 5) RETURNING id`;
        jobIds.push(jobId);
        expect(await processOneJob()).toBe(true);

        const [job] = await sql<{ status: string; attempts: number }[]>`SELECT status, attempts FROM jobs WHERE id = ${jobId}`;
        expect(job.status).toBe(expected.job);
        expect(job.status).not.toBe("pending");
        expect(job.attempts).toBe(1);
        const [run] = await sql<{ status: string }[]>`
          SELECT status FROM job_runs WHERE job_id = ${jobId} ORDER BY id DESC LIMIT 1`;
        expect(run.status).toBe(expected.run);
      }
    });
  } finally {
    con.restore();
    handlers[kind] = original;
    if (jobIds.length) {
      await fixtureDb`DELETE FROM job_runs WHERE job_id IN ${sql(jobIds)}`;
      await fixtureDb`DELETE FROM jobs WHERE id IN ${sql(jobIds)}`;
    }
    await dropProject(projectId);
  }
});

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
    const [{ id: retryId }] = await fixtureDb<{ id: number }[]>`
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

    // Attempts exhausted (max_attempts=1): must NOT go 'dead' — the
    // last-persisted rows are intact and the schedule must keep firing, so an
    // operator requeue and the next cron slot both stay available.
    //
    // IT SETTLES 'failed', NOT 'succeeded' (R16). This assertion used to read
    // 'succeeded', on the reasoning that the next cron slot re-enqueues a fresh
    // attempt — which is true, and is unaffected by the status, because the
    // scheduler enqueues NEW rows. What the old status did was make the row lie:
    // staging job 83 read `succeeded, attempts 5, last_error judge_unavailable`
    // for a judging that never happened, and the admin overview, the queue
    // counts and swarm/receipt-gap.ts all had to work around a green row for
    // work that was never done. The RUN keeps 'degraded', which is where the
    // "kept last-persisted rows" distinction actually belongs.
    const [{ id: termId }] = await fixtureDb<{ id: number }[]>`
      INSERT INTO jobs (kind, priority, max_attempts) VALUES (${kind}, 1000000, 1) RETURNING id`;
    jobIds.push(termId);
    expect(await processOneJob()).toBe(true);

    const [termJob] = await sql<{ status: string }[]>`SELECT status FROM jobs WHERE id = ${termId}`;
    expect(termJob.status).not.toBe("dead"); // never escalate degrade to dead
    expect(termJob.status).toBe("failed"); // honest terminal; next cron re-enqueues a fresh row

    const [termRun] = await sql<{ status: string }[]>`
      SELECT status FROM job_runs WHERE job_id = ${termId} ORDER BY id DESC LIMIT 1`;
    expect(termRun.status).toBe("degraded");
  } finally {
    delete handlers[kind];
    if (jobIds.length) {
      await fixtureDb`DELETE FROM job_runs WHERE job_id IN ${sql(jobIds)}`;
      await fixtureDb`DELETE FROM jobs WHERE id IN ${sql(jobIds)}`;
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

// ── discovery freshness provenance (issue #495 data-integrity blocker) ───────
//
// resolved_at / enriched_at are read by the leaderboard's source-health panel
// (projects/leaderboard-projections.ts sourceHealth) as "when this data was
// last refreshed", and it calls a source healthy when they are within 36h. The
// live source serves a COMMITTED roster frozen at its manifest's generatedAt,
// so stamping now() on those rows on every nightly run reported a months-old
// dataset as fresh in perpetuity. These tests fail if now() ever comes back.

const SEED_AS_OF = "2026-08-03T20:43:29.019Z";

function asOfSource(prefix: string, asOf: string | null): ProjectsDataSource {
  return { ...uniqueSlugSource(prefix), async discoveredAsOf() { return asOf; } };
}

test("discovery stamps the SOURCE's declared as-of on resolved_at/enriched_at, never wall-clock now()", async () => {
  const prefix = `wkasof_${crypto.randomUUID().slice(0, 8)}`;
  const startedAt = Date.now();
  const d = await discover({}, asOfSource(prefix, SEED_AS_OF));
  expect(d.ok).toBe(true);

  const ids = await projectIds(prefix);
  expect(ids.length).toBe(4);
  const projectRows = await sql<{ resolved_at: Date }[]>`
    SELECT resolved_at FROM projects WHERE id IN ${sql(ids)}`;
  expect(projectRows.length).toBe(4);
  for (const r of projectRows) expect(new Date(r.resolved_at).toISOString()).toBe(SEED_AS_OF);

  const agentRows = await sql<{ enriched_at: Date }[]>`
    SELECT enriched_at FROM openclaw_agents WHERE project_id IN ${sql(ids)}`;
  expect(agentRows.length).toBeGreaterThan(0);
  for (const a of agentRows) expect(new Date(a.enriched_at).toISOString()).toBe(SEED_AS_OF);

  // The load-bearing half: these timestamps are strictly older than this test
  // run, so they cannot have come from now(). Without the fix every row here
  // carries a timestamp >= startedAt and the whole freshness signal is fiction.
  for (const r of projectRows) expect(new Date(r.resolved_at).getTime()).toBeLessThan(startedAt);
  for (const a of agentRows) expect(new Date(a.enriched_at).getTime()).toBeLessThan(startedAt);
});

test("re-running discovery over an unchanged seed does NOT advance enriched_at (a frozen roster stops claiming it just refreshed)", async () => {
  const prefix = `wkasof2_${crypto.randomUUID().slice(0, 8)}`;
  const src = asOfSource(prefix, SEED_AS_OF);
  await discover({}, src);
  const ids = await projectIds(prefix);
  const before = await sql<{ enriched_at: Date }[]>`
    SELECT enriched_at FROM openclaw_agents WHERE project_id IN ${sql(ids)} ORDER BY name`;
  expect(before.length).toBeGreaterThan(0);

  await discover({}, src); // the nightly re-run, same frozen artifact
  const after = await sql<{ enriched_at: Date }[]>`
    SELECT enriched_at FROM openclaw_agents WHERE project_id IN ${sql(ids)} ORDER BY name`;
  expect(after.map((r) => new Date(r.enriched_at).toISOString())).toEqual(
    before.map((r) => new Date(r.enriched_at).toISOString()),
  );
});

test("a source that declares no as-of still gets wall-clock now() (the hermetic fixture path is unchanged)", async () => {
  const prefix = `wknoasof_${crypto.randomUUID().slice(0, 8)}`;
  const startedAt = Date.now() - 1000;
  await discover({}, uniqueSlugSource(prefix)); // no discoveredAsOf implemented
  const ids = await projectIds(prefix);
  const [row] = await sql<{ resolved_at: Date }[]>`
    SELECT resolved_at FROM projects WHERE id IN ${sql(ids)} LIMIT 1`;
  expect(new Date(row.resolved_at).getTime()).toBeGreaterThanOrEqual(startedAt);
});

test("discovery degrades rather than persisting rows under an unparseable declared as-of", async () => {
  const prefix = `wkbadasof_${crypto.randomUUID().slice(0, 8)}`;
  const d = await discover({}, asOfSource(prefix, "not-a-timestamp"));
  expect(d.ok).toBe(false);
  expect(d.status).toBe("degraded");
  expect(await projectIds(prefix)).toEqual([]); // nothing written under a fabricated fallback
});

// ── Issue 1382: the two Bankr lp-fees rows are tokens, not vaults ────────────
// Owner decision 2026-10-16: deactivate both rows (migration 0124), no LP
// valuation. The roster seed no longer lists them, and the discover upsert never
// sets is_active, so neither an existing database nor a fresh one brings them
// back; fetchVaults reads only active rows, so it never reads either address.
const BANKR_TOKEN_VAULTS = [
  { name: "Bankr Agent Token LP", vault_address: "0x7689006F6C3A3473449E42b628544E60D0bCCb07" },
  { name: "Bankr BNKR LP Pool", vault_address: "0x22aF33FE49fD1Fa80c7149773dDe5890D3c76F3b" },
];
const BANKR_TOKEN_ADDRESSES = BANKR_TOKEN_VAULTS.map((v) => v.vault_address.toLowerCase());
const BANKR_SEED_SLUG = "bankr-agent-614b56";

// A source serving the committed roster seed's Bankr project (loaded through the
// checksum-validating loader) under a unique slug, optionally with extra vaults.
async function bankrSeedSource(prefix: string, extraVaults: DiscoveredVault[] = []): Promise<ProjectsDataSource> {
  const { projects } = await loadV0RosterWithManifest();
  const bankr = projects.find((p) => p.slug === BANKR_SEED_SLUG);
  if (!bankr) throw new Error(`roster seed has no ${BANKR_SEED_SLUG}`);
  const project = { ...structuredClone(bankr), slug: `${prefix}-${BANKR_SEED_SLUG}` };
  project.vaults.push(...extraVaults);
  return { ...uniqueSlugSource(prefix), async discoverProjects() { return [structuredClone(project)]; } };
}

async function bankrVaults(prefix: string): Promise<{ name: string; vault_address: string; is_active: boolean }[]> {
  return [...await sql<{ name: string; vault_address: string; is_active: boolean }[]>`
    SELECT v.name, v.vault_address, v.is_active FROM agent_vaults v JOIN projects p ON p.id = v.project_id
     WHERE p.slug = ${`${prefix}-${BANKR_SEED_SLUG}`} ORDER BY v.name`];
}

test("the roster seed lists neither Bankr token address as a vault, and its manifest checksum validates", async () => {
  const { projects, manifest } = await loadV0RosterWithManifest(); // throws on a checksum mismatch
  const vaultAddresses = projects.flatMap((p) => p.vaults.map((v) => (v.vault_address ?? "").toLowerCase()));
  for (const a of BANKR_TOKEN_ADDRESSES) expect(vaultAddresses).not.toContain(a);
  expect(manifest.vaultCount).toBe(vaultAddresses.length);
  // The Bankr project and its BNKR coin stay; only the two vault rows went.
  const bankr = projects.find((p) => p.slug === BANKR_SEED_SLUG)!;
  expect(bankr.vaults).toEqual([]);
  expect(bankr.coins.map((c) => c.ticker)).toEqual(["BNKR"]);
});

test("discover with the regenerated seed inserts no Bankr token vault on an empty database and never reactivates the deactivated rows", async () => {
  const prefix = `wkbankr_${crypto.randomUUID().slice(0, 8)}`;
  // Fresh database for this project: the seed creates the project, no vault row.
  expect((await discover({}, await bankrSeedSource(prefix))).ok).toBe(true);
  expect(await bankrVaults(prefix)).toEqual([]);

  // An upgraded database: the two rows exist and migration 0124 left them inactive.
  const [{ id: projectId }] = await sql<{ id: string }[]>`SELECT id FROM projects WHERE slug = ${`${prefix}-${BANKR_SEED_SLUG}`}`;
  for (const v of BANKR_TOKEN_VAULTS) {
    await fixtureDb`
      INSERT INTO agent_vaults (project_id, name, vault_address, chain, strategy_type, protocol, data_source, is_active, tvl_usd)
      VALUES (${projectId}, ${v.name}, ${v.vault_address}, 'base', 'lp-fees', 'bankr', 'live', false, 1)`;
  }
  const inactive = BANKR_TOKEN_VAULTS.map((v) => ({ ...v, is_active: false }));
  expect((await discover({}, await bankrSeedSource(prefix))).ok).toBe(true);
  expect(await bankrVaults(prefix)).toEqual(inactive);

  // Even a roster that still listed them would not flip is_active back.
  const old: DiscoveredVault[] = BANKR_TOKEN_VAULTS.map((v) => ({ ...v, chain: "base", strategy_type: "lp-fees", protocol: "bankr", data_source: "live" }));
  expect((await discover({}, await bankrSeedSource(prefix, old))).ok).toBe(true);
  expect(await bankrVaults(prefix)).toEqual(inactive);
});

test("fetchVaults issues no read for an inactive vault row", async () => {
  const tag = crypto.randomUUID().slice(0, 8);
  const good = "0x" + "4f".repeat(20);
  const { projectId, byName, ids } = await seedVaults(tag, [
    { name: "bankr-token", address: BANKR_TOKEN_VAULTS[0]!.vault_address, tvl: 999 },
    { name: "rmusdc", address: good, tvl: 1 },
  ]);
  await fixtureDb`UPDATE agent_vaults SET is_active = false WHERE id = ${byName["bankr-token"]!}`;
  const reads: string[] = [];
  const spy: ProjectsDataSource = {
    ...uniqueSlugSource(tag),
    async vaultErc4626Read(address: string) {
      reads.push(address.toLowerCase());
      return { totalAssetsRaw: "1234500000", decimals: 6, assetPriceUsd: 1 };
    },
  };
  try {
    const res = await withOnlyVaults(ids, () => fetchVaults({}, spy));
    expect(res).toEqual({ ok: true, status: "ok", updated: 1, failed: 0 });
    expect(reads).toEqual([good]);
    expect((await vaultRow(byName["bankr-token"]!)).tvl).toBe(999);
  } finally {
    await dropProject(projectId);
  }
});
