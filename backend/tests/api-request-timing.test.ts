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

const get = (path: string, ua = "Bun/1.3.14") => new Request(`http://api.test${path}`, { headers: { "user-agent": ua } });
const ok = async () => new Response("ok", { status: 200 });

test("the limit is a named constant above the old 10 s default and below nginx's 60 s", () => {
  expect(API_IDLE_TIMEOUT_SECONDS).toBeGreaterThan(10);
  expect(API_IDLE_TIMEOUT_SECONDS).toBeLessThan(60);
  expect(Number.isInteger(API_IDLE_TIMEOUT_SECONDS)).toBe(true);
  expect(API_IDLE_TIMEOUT_SECONDS).toBeLessThanOrEqual(255); // Bun's maximum
  expect(API_SLOW_REQUEST_MS).toBeLessThan(API_IDLE_TIMEOUT_SECONDS * 1000);
});

test("the api's Bun.serve is given that constant, so no other value is in effect", () => {
  const src = readFileSync(join(import.meta.dir, "../src/api/index.ts"), "utf8");
  const serve = src.slice(src.indexOf("Bun.serve({"), src.indexOf("async fetch(req, server)"));
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
  expect(lines[0]!.message).toContain("GET /api/swarm/sessions/2026-09-28/woon took 6.2s status=200 ua=Bun/1.3.14");
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
