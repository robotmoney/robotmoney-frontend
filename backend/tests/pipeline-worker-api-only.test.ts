// The pipeline worker runs its jobs through the api with no database key in its
// environment (issue 1034, decision D75).
//
// This boots the real api (`bun run src/api/index.ts`, as rm_app) and spawns
// the real worker entry (`bun run src/worker/index.ts`, WORKER_LANE=analytics)
// with an environment built from nothing: no DATABASE_URL, no
// WORKER_DATABASE_URL, no PG* key. Its only credential is the pipeline-worker
// token file. Five jobs are queued and must reach `succeeded`, and the rows
// they write must exist:
//
//   vault.sample_share_price  → vault_share_price_history
//   wallet.sample_balances    → wallet_balance_samples
//   buybacks.refresh          → buyback_scan_state (the scanned window)
//   projects.snapshot_daily   → daily_coin_snapshots
//   ops.repair_gaps           → its job_runs output (the gap reports it read)
//
// THE CHAIN. The worker's chain and price reads go to providers, never to a
// test database. A `bun --preload` module in the worker process answers them:
// a JSON-RPC fake for BASE_RPC_URL (every Multicall3 sub-call reads 1e18, the
// head is just past the buyback floor, no logs) and an empty answer for the
// price hosts. PRICE_SOURCE=stub keeps the prices fixtures. Nothing in it
// touches the database or the api.
//
// The second test spawns the same entry with DATABASE_URL set: it must exit
// non-zero, naming the key and never its value.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "../src/db/client.ts";
import { BUYBACK_FROM_BLOCK } from "../src/config.ts";
import { useCleanDatabase } from "./support/clean-db.ts";
import { fixtureDb } from "./support/fixture-db.ts";
import { bootApi, provisionPipelineToken, writeTokenFile, type ApiProcess } from "./support/automation-auth.ts";

useCleanDatabase(import.meta.file);

const BACKEND = join(import.meta.dir, "..");
const KINDS = [
  "vault.sample_share_price",
  "wallet.sample_balances",
  "buybacks.refresh",
  "projects.snapshot_daily",
  "ops.repair_gaps",
] as const;

let api: ApiProcess;
let tokenFile = "";
const workDir = mkdtempSync(join(tmpdir(), "rm-pipeline-worker-"));

function writeChainPreload(): string {
  const file = join(workDir, "fake-chain.preload.ts");
  writeFileSync(
    file,
    `import { decodeAggregate3Calls, encodeAggregate3Result } from ${JSON.stringify(join(BACKEND, "src/chain/base-rpc-client.ts"))};
const realFetch = globalThis.fetch;
const word = (n: bigint) => "0x" + n.toString(16).padStart(64, "0");
const head = "0x" + (${BUYBACK_FROM_BLOCK} + 10).toString(16);
function answer(req: { id?: number; method: string; params: any[] }) {
  const id = req.id ?? 1;
  switch (req.method) {
    case "eth_call": {
      const data = String(req.params[0]?.data ?? "");
      try {
        const calls = decodeAggregate3Calls(data);
        return { jsonrpc: "2.0", id, result: encodeAggregate3Result(calls.map(() => ({ success: true, returnData: word(10n ** 18n) }))) };
      } catch {
        return { jsonrpc: "2.0", id, result: word(10n ** 18n) };
      }
    }
    case "eth_blockNumber": return { jsonrpc: "2.0", id, result: head };
    case "eth_getLogs": return { jsonrpc: "2.0", id, result: [] };
    case "eth_getBalance": return { jsonrpc: "2.0", id, result: word(10n ** 18n) };
    case "eth_getBlockByNumber": return { jsonrpc: "2.0", id, result: { number: req.params[0], timestamp: "0x68000000", hash: "0x" + "ab".repeat(32) } };
    default: return { jsonrpc: "2.0", id, error: { code: -32601, message: "fake rpc has no " + req.method } };
  }
}
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith("http://fake-rpc.invalid")) {
    const body = JSON.parse(String(init?.body));
    const out = Array.isArray(body) ? body.map(answer) : answer(body);
    return new Response(JSON.stringify(out), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (/geckoterminal|coingecko|yahoo/.test(url)) return new Response(JSON.stringify({ data: [] }), { status: 200 });
  return realFetch(input, init);
}) as typeof fetch;
`,
  );
  return file;
}

/** The worker's whole environment: nothing inherited, so no database key can ride along by accident. */
function workerEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? workDir,
    WORKER_LANE: "analytics",
    WORKER_ID: "pipeline-api-only-test",
    PIPELINE_API_URL: api.base,
    PIPELINE_TOKEN_FILE: tokenFile,
    BASE_RPC_URL: "http://fake-rpc.invalid",
    BASE_RPC_SOURCE: "live",
    PRICE_SOURCE: "stub",
    BASE_RPC_MAX_CALLS_PER_SEC: "0",
    GECKO_MIN_INTERVAL_MS: "0",
    WORKER_IDLE_POLL_MS: "200",
    SCHEDULER_TICK_MS: "60000",
    REAPER_TICK_MS: "60000",
    HEARTBEAT_FILE: join(workDir, "heartbeat"),
    SCHEDULER_HEARTBEAT_FILE: join(workDir, "heartbeat.scheduler"),
    ...extra,
  };
}

beforeAll(async () => {
  tokenFile = writeTokenFile(await provisionPipelineToken());
  api = await bootApi();
  // Nothing queued but this file's five jobs: the bootstrap's cold-start rows
  // are cancelled, and the schedules stay as the snapshot left them.
  await fixtureDb`UPDATE jobs SET status = 'cancelled', updated_at = now() WHERE status IN ('pending', 'running')`;
  // A live project and coin, so the daily rollup writes a row.
  const [project] = await fixtureDb<{ id: string }[]>`
    INSERT INTO projects (slug, display_name, status) VALUES ('pipeline-api-only', 'Pipeline api only', 'active') RETURNING id`;
  await fixtureDb`
    INSERT INTO lobster_coins (project_id, name, ticker, price_usd, market_cap, volume_24h, is_active)
    VALUES (${project!.id}, 'Coin', 'CN', 1.5, 1000, 10, true)`;
}, 120_000);

afterAll(() => api?.stop());

async function waitFor<T>(what: string, read: () => Promise<T>, done: (v: T) => boolean, ms: number): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (done(v)) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(v)}`);
    await Bun.sleep(250);
  }
}

test(
  "the worker, with no database key in its environment, runs five jobs to succeeded through /api/pipeline/**, and their rows exist",
  async () => {
    const ids: Record<string, number> = {};
    for (const kind of KINDS) {
      const [row] = await fixtureDb<{ id: number }[]>`INSERT INTO jobs (kind, payload) VALUES (${kind}, '{}'::jsonb) RETURNING id`;
      ids[kind] = Number(row!.id);
    }

    const proc = Bun.spawn(["bun", "run", "--preload", writeChainPreload(), "src/worker/index.ts"], {
      cwd: BACKEND,
      env: workerEnv(),
      stdout: "pipe",
      stderr: "pipe",
    });
    let out = "";
    try {
      const statuses = await waitFor(
        "the five jobs to settle",
        async () => {
          const rows = await sql<{ kind: string; status: string; last_error: string | null }[]>`
            SELECT kind, status, last_error FROM jobs WHERE id = ANY(${Object.values(ids)}) ORDER BY kind`;
          return rows;
        },
        (rows) => rows.every((r) => r.status !== "pending" && r.status !== "running"),
        90_000,
      );
      expect(statuses.map((r) => ({ kind: r.kind, status: r.status, error: r.last_error }))).toEqual(
        [...KINDS].sort().map((kind) => ({ kind, status: "succeeded", error: null })),
      );
    } finally {
      proc.kill("SIGTERM");
      await proc.exited;
      out = `${await new Response(proc.stdout as ReadableStream).text()}\n${await new Response(proc.stderr as ReadableStream).text()}`;
    }
    // The HTTP startup check passed, and no line names a database URL.
    expect(out).toContain("pipeline_startup: passed");
    expect(out).not.toMatch(/postgres(ql)?:\/\//);

    // The rows each job wrote.
    const [share] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM vault_share_price_history`;
    expect(share!.n).toBeGreaterThan(0);
    const [balances] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM wallet_balance_samples
       WHERE sample_date = (now() AT TIME ZONE 'UTC')::date AND superseded_at IS NULL`;
    expect(balances!.n).toBeGreaterThan(0);
    const [scan] = await sql<{ b: string }[]>`SELECT last_scanned_block::text AS b FROM buyback_scan_state WHERE id = 1`;
    expect(Number(scan!.b)).toBe(BUYBACK_FROM_BLOCK + 10);
    const [coinSnaps] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM daily_coin_snapshots WHERE snapshot_date = (now() AT TIME ZONE 'UTC')::date`;
    expect(coinSnaps!.n).toBe(1);
    const [repair] = await sql<{ output: { dirtySeries?: unknown[] } }[]>`
      SELECT output FROM job_runs WHERE job_id = ${ids["ops.repair_gaps"]!} AND status = 'succeeded'`;
    expect(Array.isArray(repair!.output.dirtySeries)).toBe(true);

    // Every write went through the pipeline routes, fenced and receipted.
    const writes = await sql<{ operation: string }[]>`
      SELECT DISTINCT operation FROM pipeline_ingest_receipts WHERE job_id = ANY(${Object.values(ids)}) ORDER BY operation`;
    expect(writes.map((w) => w.operation)).toEqual(
      expect.arrayContaining(["buybacks.record_window", "projects.snapshot_daily", "queue.settle", "vault.share_price", "wallet.balance_samples"]),
    );
  },
  180_000,
);

test("the same worker, given DATABASE_URL, exits non-zero naming the key and never its value", async () => {
  const secret = "postgres://rm_worker:do-not-print-me@db.invalid:5432/rm";
  const proc = Bun.spawn(["bun", "run", "src/worker/index.ts"], {
    cwd: BACKEND,
    env: workerEnv({ DATABASE_URL: secret }),
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  const out = `${await new Response(proc.stdout as ReadableStream).text()}\n${await new Response(proc.stderr as ReadableStream).text()}`;
  expect(code).not.toBe(0);
  expect(out).toContain("pipeline_startup: refused");
  expect(out).toContain("DATABASE_URL");
  expect(out).not.toContain("do-not-print-me");
}, 60_000);
