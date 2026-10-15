// Issue 1378 — a worker start releases no job burst.
//
// The v0.6.2 stage QA run of 2026-10-15 booted on the 19:12Z production dump
// (21:07:25-21:08:10Z). worker-analytics claimed analytics.parity_sweep at
// 21:07:29.62, before the api listened (21:07:30.47); the reaper re-released
// the dump's 'running' projects.refresh_wallets row; catch-up queued one parity
// sweep per missed hour; 131 jobs were due by 21:13 and live wallet samplers
// waited behind stale ones. This file boots startWorker on that shape of
// database (src/worker/boot.ts, runtime.ts beforeFirstClaim) and asserts:
//   - no job is claimed while the stub api's /health refuses, and the first
//     claim follows its first 200;
//   - at most one live row per heavy ('latest-only') kind remains, every
//     superseded row is 'cancelled' with the 'superseded at worker start'
//     reason, the expired-lease running refresh_wallets row included;
//   - a 'collapse-per-bucket' sampler keeps its newest slot per UTC day;
//   - every 'all' policy row is untouched (it runs, it is never cancelled);
//   - the newest sampler slot is claimed within 300 s of its slotAt.
// Runs in backend.yml against ephemeral Postgres (tests/preload.ts).
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "../src/db/client.ts";
import { seedJobSchedules } from "../src/db/seed.ts";
import { handlers } from "../src/worker/handlers/index.ts";
import { LANES } from "../src/worker/lanes.ts";
import { startWorker, type WorkerHandle } from "../src/worker/runtime.ts";
import { SUPERSEDED_REASON } from "../src/worker/boot.ts";
import { fixtureDb } from "./support/fixture-db.ts";
import { useCleanDatabase } from "./support/clean-db.ts";

useCleanDatabase(import.meta.file);

const HEAVY = [
  "analytics.parity_sweep",
  "projects.refresh_wallets",
  "projects.fetch_vaults",
  "projects.refresh_coins",
  "ops.repair_gaps",
  "ops.backfill_asset_prices",
] as const;
const SAMPLER = "wallet.sample_balances";
const ALL_KIND = "buybacks.refresh";
const STUBBED = [...HEAVY, SAMPLER, ALL_KIND];

const claims: { kind: string; slotAt: string | undefined; at: number }[] = [];
const original = new Map<string, (typeof handlers)[string]>();
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "worker-boot-burst-"));
  for (const kind of STUBBED) {
    original.set(kind, handlers[kind]);
    handlers[kind] = async (payload: Record<string, unknown>) => {
      claims.push({ kind, slotAt: payload.slotAt as string | undefined, at: Date.now() });
      return { ok: true };
    };
  }
});
afterAll(async () => {
  for (const [kind, fn] of original) {
    if (fn) handlers[kind] = fn; else delete handlers[kind];
  }
  rmSync(dir, { recursive: true, force: true });
  await fixtureDb`DELETE FROM jobs`;
  await fixtureDb`DELETE FROM job_schedules`;
  await seedJobSchedules(fixtureDb as never);
});
beforeEach(async () => {
  claims.length = 0;
  await fixtureDb`DELETE FROM job_runs`;
  await fixtureDb`DELETE FROM jobs`;
  await fixtureDb`DELETE FROM job_schedules`;
  // The production schedules, with their real catch-up policies. next_run_at
  // in the future, so the boot's own scheduler tick enqueues nothing and the
  // queue below is exactly what the test planted.
  await seedJobSchedules(fixtureDb as never);
  await fixtureDb`UPDATE job_schedules SET next_run_at = now() + interval '1 day'`;
});

const started: WorkerHandle[] = [];
let stub: ReturnType<typeof Bun.serve> | null = null;
afterEach(async () => {
  const handles = started.splice(0);
  await Promise.all(handles.map((w) => w.stop()));
  await Promise.all(handles.map((w) => w.drained(10_000)));
  stub?.stop(true);
  stub = null;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const HOUR = 3_600_000;

async function plant(kind: string, slotAt: string, extra: { status?: string; lockedAgoMinutes?: number } = {}): Promise<number> {
  const status = extra.status ?? "pending";
  const [row] = extra.lockedAgoMinutes === undefined
    ? await fixtureDb`INSERT INTO jobs (kind, payload, status, dedupe_key, run_after)
        VALUES (${kind}, ${fixtureDb.json({ slotAt })}, ${status}, ${`${kind}:${slotAt}`}, ${slotAt}) RETURNING id`
    : await fixtureDb`INSERT INTO jobs (kind, payload, status, dedupe_key, run_after, attempts, locked_at, locked_by)
        VALUES (${kind}, ${fixtureDb.json({ slotAt })}, ${status}, ${`${kind}:${slotAt}`}, ${slotAt}, 1,
                now() - (${extra.lockedAgoMinutes} || ' minutes')::interval, 'dead-worker-from-the-dump') RETURNING id`;
  return Number(row!.id);
}

/** A free port: bind one, read it, release it. */
function freePort(): number {
  const s = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = s.port as number;
  s.stop(true);
  return port;
}

test("no job is claimed while the api's /health refuses, and the first claim follows its first 200", async () => {
  const port = freePort();
  await plant(ALL_KIND, iso(10 * 60_000));
  const w = startWorker({
    lane: LANES.analytics,
    workerId: "boot-burst-wait",
    idlePollMs: 25,
    schedulerTickMs: 60_000,
    reaperTickMs: 60_000,
    shutdownTimeoutMs: 5_000,
    heartbeatFile: join(dir, "hb-wait"),
    schedulerHeartbeatFile: join(dir, "hb-wait.scheduler"),
    apiHealthUrl: `http://127.0.0.1:${port}/health`,
  });
  started.push(w);

  // Phase 1: nothing listens (connection refused).
  await sleep(1_200);
  expect(claims).toHaveLength(0);
  // Phase 2: the api listens but is not ready (503).
  let ready = false;
  let firstOkAt = 0;
  stub = Bun.serve({
    port,
    fetch: () => {
      if (!ready) return new Response("starting", { status: 503 });
      firstOkAt ||= Date.now();
      return new Response("ok");
    },
  });
  await sleep(1_500);
  expect(claims).toHaveLength(0);
  const [stillPending] = await sql`SELECT status FROM jobs WHERE kind = ${ALL_KIND}`;
  expect(stillPending!.status).toBe("pending");

  // Phase 3: ready. The first claim follows the first 200.
  ready = true;
  const deadline = Date.now() + 15_000;
  while (claims.length === 0 && Date.now() < deadline) await sleep(25);
  expect(claims).toHaveLength(1);
  expect(firstOkAt).toBeGreaterThan(0);
  expect(claims[0]!.at).toBeGreaterThanOrEqual(firstOkAt);
}, 30_000);

test("a stale backlog leaves at most one live row per heavy kind, cancels the rest with a reason, keeps 'all' rows, and claims the newest sampler slot within 300 s", async () => {
  // The dump's shape: three hourly slots per heavy kind still pending.
  const planted = new Map<string, number[]>();
  for (const kind of HEAVY) {
    const ids: number[] = [];
    for (const hoursAgo of [3, 2, 1]) ids.push(await plant(kind, iso(hoursAgo * HOUR)));
    planted.set(kind, ids);
  }
  // refresh_wallets also holds a 'running' row whose lease expired with the
  // worker that took it (10 min > the 300 s visibility timeout): the reaper
  // would requeue it, a 52-minute job.
  const orphan = await plant("projects.refresh_wallets", iso(6 * HOUR), { status: "running", lockedAgoMinutes: 10 });
  // A collapse-per-bucket sampler: two slots of yesterday, three of today, the
  // newest one second old.
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const at = (ms: number) => new Date(ms).toISOString();
  const yesterday = [
    await plant(SAMPLER, at(todayStart.getTime() - 2 * HOUR)),
    await plant(SAMPLER, at(todayStart.getTime() - HOUR)),
  ];
  const sinceMidnight = Date.now() - todayStart.getTime();
  const today = [
    await plant(SAMPLER, at(todayStart.getTime() + Math.floor(sinceMidnight * 0.3))),
    await plant(SAMPLER, at(todayStart.getTime() + Math.floor(sinceMidnight * 0.6))),
  ];
  const newestSlot = iso(1_000);
  const newestSampler = await plant(SAMPLER, newestSlot);
  // An 'all' policy kind: every slot carries distinct work and must run.
  const allRows = [await plant(ALL_KIND, iso(12 * HOUR)), await plant(ALL_KIND, iso(6 * HOUR))];

  const w = startWorker({
    lane: LANES.analytics,
    workerId: "boot-burst-sweep",
    idlePollMs: 25,
    schedulerTickMs: 60_000,
    reaperTickMs: 60_000,
    shutdownTimeoutMs: 5_000,
    heartbeatFile: join(dir, "hb-sweep"),
    schedulerHeartbeatFile: join(dir, "hb-sweep.scheduler"),
  });
  started.push(w);
  const deadline = Date.now() + 20_000;
  for (;;) {
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM jobs WHERE status IN ('pending', 'running')`;
    if (n === 0 || Date.now() > deadline) break;
    await sleep(50);
  }
  await w.stop();

  // Heavy kinds: exactly one row survived (the newest slot), and it ran.
  for (const kind of HEAVY) {
    const rows = await sql<{ id: string; status: string; last_error: string | null }[]>`
      SELECT id, status, last_error FROM jobs WHERE kind = ${kind} ORDER BY id`;
    const live = rows.filter((r) => r.status !== "cancelled");
    expect({ kind, live: live.map((r) => Number(r.id)) }).toEqual({ kind, live: [planted.get(kind)![2]!] });
    expect(live[0]!.status).toBe("succeeded");
    for (const r of rows.filter((r) => r.status === "cancelled")) expect(r.last_error).toBe(SUPERSEDED_REASON);
    expect(claims.filter((c) => c.kind === kind)).toHaveLength(1);
  }
  // The orphaned running row from the dump was cancelled, never re-released.
  const [o] = await sql`SELECT status, locked_by, last_error FROM jobs WHERE id = ${orphan}`;
  expect(o).toEqual({ status: "cancelled", locked_by: null, last_error: SUPERSEDED_REASON });

  // Sampler: the newest slot of each UTC day survives.
  const samplerRows = new Map(
    (await sql<{ id: string; status: string }[]>`SELECT id, status FROM jobs WHERE kind = ${SAMPLER}`)
      .map((r) => [Number(r.id), r.status]),
  );
  expect(samplerRows.get(yesterday[0]!)).toBe("cancelled");
  expect(samplerRows.get(yesterday[1]!)).toBe("succeeded");
  for (const id of today) expect(samplerRows.get(id)).toBe("cancelled");
  expect(samplerRows.get(newestSampler)).toBe("succeeded");
  const newestClaim = claims.find((c) => c.kind === SAMPLER && c.slotAt === newestSlot);
  expect(newestClaim).toBeDefined();
  expect(newestClaim!.at - Date.parse(newestSlot)).toBeLessThan(300_000);

  // 'all' policy rows: untouched by the sweep, both ran.
  for (const id of allRows) {
    const [r] = await sql`SELECT status FROM jobs WHERE id = ${id}`;
    expect(r!.status).toBe("succeeded");
  }
  expect(claims.filter((c) => c.kind === ALL_KIND)).toHaveLength(2);
}, 40_000);
