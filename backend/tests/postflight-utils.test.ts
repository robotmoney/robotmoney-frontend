// backend/scripts/lib/postflight-utils.ts — the pieces exercisable without a
// full boot: fetchCheck's error handling, and runPostflightMain's DATABASE_URL
// guard. The DB-query checks themselves live in each versioned upgrade's
// postflight.ts and are exercised there against the suite's real Postgres.
import { afterEach, describe, expect, test } from "bun:test";
import { fetchCheck, runPostflightMain } from "../scripts/lib/postflight-utils.ts";

describe("fetchCheck — never throws, always reports ok/error", () => {
  test("an unreachable host resolves to {ok: false, error: ...}, not a rejection", async () => {
    const r = await fetchCheck("http://127.0.0.1:1/", { timeoutMs: 500 });
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });

  test("a genuinely reachable URL returns ok:true with a body", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("hello", { status: 200 }) });
    try {
      const r = await fetchCheck(`http://127.0.0.1:${server.port}/`);
      expect(r.ok).toBe(true);
      expect(r.status).toBe(200);
      expect(r.body).toBe("hello");
    } finally {
      server.stop(true);
    }
  });

  test("a non-2xx response is reported ok:false with the status, not thrown", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("nope", { status: 500 }) });
    try {
      const r = await fetchCheck(`http://127.0.0.1:${server.port}/`);
      expect(r.ok).toBe(false);
      expect(r.status).toBe(500);
    } finally {
      server.stop(true);
    }
  });
});

describe("runPostflightMain — the guard that must reject BEFORE any connection is opened", () => {
  const saved = process.env.DATABASE_URL;
  afterEach(() => {
    process.env.DATABASE_URL = saved;
  });

  test("DATABASE_URL unset -> exit code 2, no connection attempted", async () => {
    delete process.env.DATABASE_URL;
    const code = await runPostflightMain({
      name: "test",
      runChecks: async () => {
        throw new Error("must not be called");
      },
    });
    expect(code).toBe(2);
  });
});
