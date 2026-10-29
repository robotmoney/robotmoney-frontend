// Issue 1060: the api's request time limit is an explicit decision, and a slow request leaves a trace.
//
// On 2026-09-30 one request ran past Bun's default 10 s limit, was cut off, and nginx answered 502; the only record was
// Bun's own line, with no path and no duration. These tests pin the limit to one named constant that Bun.serve is given,
// and the log a slow request now leaves.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { API_IDLE_TIMEOUT_SECONDS, API_SLOW_REQUEST_MS } from "../src/config.ts";
import { withRequestTiming } from "../src/api/request-timing.ts";
import { dbFailureLogPrefix } from "../src/api/db-failure.ts";
import { createPoolGate, gatedPool } from "../src/db/pool-gate.ts";
import { requestWaits } from "../src/lib/request-waits.ts";

const get = (path: string, ua = "Bun/1.3.14") => new Request(`http://api.test${path}`, { headers: { "user-agent": ua } });
const ok = async () => new Response("ok", { status: 200 });

test("the limit is a named constant, deliberately not above Bun's old 10 s default, and below nginx's 60 s", () => {
  // Raising it would hide CPU- or database-bound work on the request path instead of exposing it (issue 1060).
  expect(API_IDLE_TIMEOUT_SECONDS).toBeLessThanOrEqual(10);
  expect(API_IDLE_TIMEOUT_SECONDS).toBeGreaterThan(API_SLOW_REQUEST_MS / 1000);
  expect(Number.isInteger(API_IDLE_TIMEOUT_SECONDS)).toBe(true);
    expect(API_SLOW_REQUEST_MS).toBeLessThan(API_IDLE_TIMEOUT_SECONDS * 1000);
});

test("the api's Bun.serve is given that constant, so no other value is in effect", () => {
  const src = readFileSync(join(import.meta.dir, "../src/api/index.ts"), "utf8");
  // `Bun.serve<Data, never>({` since the scheduler stream's socket (D55 (11)) gave it a type argument.
  const serveAt = src.search(/Bun\.serve(<[^>]*>)?\(\{/);
  expect(serveAt).toBeGreaterThan(-1);
  const serve = src.slice(serveAt, src.indexOf("async fetch(req, server)"));
  expect(serve).toContain("idleTimeout: API_IDLE_TIMEOUT_SECONDS");
  expect(src.match(/idleTimeout/g)!.length).toBe(1); // set once, to the constant
  // and the router runs inside the timer
  expect(src).toContain("withRequestTiming(req, pathname,");
});

test("a request over the slow threshold logs once: method, path, duration, status and caller", async () => {
  const lines: { level: string; message: string }[] = [];
  let t = 0;
  const res = await withRequestTiming(get("/api/swarm/sessions/2026-09-28/woon?search=secret"), "/api/swarm/sessions/2026-09-28/woon", async () => { t += 6_200; return new Response("ok", { status: 200 }); }, {
    now: () => t,
    log: { warn: (m) => lines.push({ level: "warn", message: m }), error: (m) => lines.push({ level: "error", message: m }) },
  });
  expect(res.status).toBe(200);
  expect(lines.length).toBe(1);
  expect(lines[0]!.level).toBe("warn");
  expect(lines[0]!.message).toContain("GET /api/swarm/sessions/2026-09-28/woon took 6.2s status=200 limiter_wait_ms=0 pool_wait_ms=0 handler_ms=6200 ua=Bun/1.3.14");
  expect(lines[0]!.message).not.toContain("secret"); // the query string is not logged
});

test("a request inside the threshold logs nothing", async () => {
  const lines: string[] = [];
  let t = 0;
  await withRequestTiming(get("/api/health"), "/api/health", async () => { t += API_SLOW_REQUEST_MS - 1; return new Response("ok"); }, {
    now: () => t, log: { warn: (m) => lines.push(m), error: (m) => lines.push(m) },
  });
  expect(lines).toEqual([]);
});

test("a request that finishes after the limit is an error line saying the client was cut off", async () => {
  const lines: { level: string; message: string }[] = [];
  let t = 0;
  await withRequestTiming(get("/api/swarm/sessions"), "/api/swarm/sessions", async () => { t += (API_IDLE_TIMEOUT_SECONDS + 4) * 1000; return new Response("ok"); }, {
    now: () => t,
    log: { warn: (m) => lines.push({ level: "warn", message: m }), error: (m) => lines.push({ level: "error", message: m }) },
  });
  expect(lines.length).toBe(1);
  expect(lines[0]!.level).toBe("error");
  expect(lines[0]!.message).toContain(`past the ${API_IDLE_TIMEOUT_SECONDS}s limit, so the client was cut off`);
});

test("a handler that throws still leaves the slow line, and the error still reaches the caller", async () => {
  const lines: string[] = [];
  let t = 0;
  await expect(withRequestTiming(get("/api/x"), "/api/x", async () => { t += 7_000; throw new Error("boom"); }, {
    now: () => t, log: { warn: (m) => lines.push(m), error: (m) => lines.push(m) },
  })).rejects.toThrow("boom");
  expect(lines.length).toBe(1);
  expect(lines[0]).toContain("status=threw");
});

test("the response is returned untouched", async () => {
  const body = await (await withRequestTiming(get("/api/x"), "/api/x", async () => new Response("payload", { status: 201, headers: { "x-a": "b" } }))).text();
  expect(body).toBe("payload");
  const res = await withRequestTiming(get("/api/x"), "/api/x", ok);
  expect(res.status).toBe(200);
});

// ── Issue 1514: the slow line says where the time went, and a refusal names its gate ──

test("the slow line splits the time into limiter wait, pool wait and handler time", async () => {
  // A pool of one permit, held, so the request's transaction waits for it.
  const gate = createPoolGate("batch", 1, 5_000);
  const pool = gatedPool({ begin: async (fn: (tx: unknown) => unknown) => fn({}) } as never, gate);
  const held = await gate.acquire();
  setTimeout(held, 300);
  const lines: string[] = [];
  let t = 0;
  await withRequestTiming(get("/api/analytics/source-acquisitions"), "/api/analytics/source-acquisitions", async () => {
    // What the analytics limiter and the pipeline token gate add when a request queues behind them.
    requestWaits()!.limiterMs += 1_200;
    await (pool as unknown as { begin: (fn: () => Promise<void>) => Promise<void> }).begin(async () => {});
    t += 6_000;
    return new Response("ok");
  }, { now: () => t, log: { warn: (m) => lines.push(m), error: (m) => lines.push(m) } });
  expect(lines.length).toBe(1);
  const m = /took 6\.0s status=200 limiter_wait_ms=(\d+) pool_wait_ms=(\d+) handler_ms=(\d+) ua=/.exec(lines[0]!);
  expect(m).not.toBeNull();
  const [limiter, poolWait, handler] = [Number(m![1]), Number(m![2]), Number(m![3])];
  expect(limiter).toBe(1_200);
  expect(poolWait).toBeGreaterThanOrEqual(250);
  expect(poolWait).toBeLessThan(2_000);
  expect(limiter + poolWait + handler).toBe(6_000);
});

test("waits outside a timed request are not recorded, and one request's waits never reach another's line", async () => {
  expect(requestWaits()).toBeUndefined();
  const lines: string[] = [];
  const log = { warn: (m: string) => lines.push(m), error: (m: string) => lines.push(m) };
  let a = 0;
  let b = 0;
  await Promise.all([
    withRequestTiming(get("/a"), "/a", async () => { await Bun.sleep(5); requestWaits()!.limiterMs += 700; a += 5_000; return new Response("ok"); }, { now: () => a, log }),
    withRequestTiming(get("/b"), "/b", async () => { await Bun.sleep(5); requestWaits()!.poolMs += 900; b += 5_000; return new Response("ok"); }, { now: () => b, log }),
  ]);
  expect(lines.find((l) => l.includes("GET /a "))).toContain("limiter_wait_ms=700 pool_wait_ms=0");
  expect(lines.find((l) => l.includes("GET /b "))).toContain("limiter_wait_ms=0 pool_wait_ms=900");
});

test("a db_saturated log names the gate that refused: a pool, or a pipeline token's gate", async () => {
  for (const name of ["batch", "pipeline:rm_prod/pipeline-worker"]) {
    const gate = createPoolGate(name, 1, 10);
    const held = await gate.acquire();
    const refused = await gate.acquire().then(() => null, (err: unknown) => err);
    held();
    expect(dbFailureLogPrefix(503, "/api/pipeline/queue/claim", refused)).toBe(`api error (503 /api/pipeline/queue/claim) db_saturated gate=${name}:`);
  }
  // Any other database failure keeps the old prefix.
  expect(dbFailureLogPrefix(503, "/api/x", Object.assign(new Error("cancel"), { code: "57014" }))).toBe("api error (503 /api/x):");
  // The router logs through it.
  const src = readFileSync(join(import.meta.dir, "../src/api/index.ts"), "utf8");
  expect(src).toContain("console.error(dbFailureLogPrefix(failure.status, pathname, err), err);");
});
