// The PUBLISH wait after a judge-wait backstop expiry (the CI failure this
// fixes): while the `swarm.judge` job still holds the single-concurrency lane,
// the publish job cannot be claimed at all, so a plain 30s state wait expires
// against an occupied lane and kills the smoke at the publish line.
// waitForSessionStateAfterJob extends its deadline while the judge job is
// `running`, and names the lane-hold if everything wedges.
//
// Executed against a stubbed fetch — no network, no server. The session-state
// endpoint is answered by the stub; the judge job row is answered by a stubbed
// readJudgeJob through the injected seam.
import { afterEach, describe, expect, test } from "bun:test";
import { waitForSessionStateAfterJob } from "../../lib/swarm/session.ts";
import type { JudgeJobStatus } from "../../lib/swarm/session.ts";

const realFetch = globalThis.fetch;
const realBackend = process.env.BACKEND_URL;

function stubSessionState(state: string | null) {
  globalThis.fetch = (async (input: any) => {
    const url = String(input);
    if (!url.includes("/api/swarm/sessions/")) throw new Error(`unexpected fetch: ${url}`);
    return new Response(JSON.stringify(state ? { session: { state } } : {}), {
      status: state ? 200 : 500,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

function stubJudgeJob(status: string) {
  return async (): Promise<JudgeJobStatus | null> =>
    ({ status, attempts: 1, maxAttempts: 5, lastError: null, runAfter: null });
}

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realBackend === undefined) delete process.env.BACKEND_URL;
  else process.env.BACKEND_URL = realBackend;
});

describe("waitForSessionStateAfterJob — the publish wait survives a judge still holding the lane", () => {
  test("returns the instant the session reaches the expected state", async () => {
    process.env.BACKEND_URL = "http://publishwait.invalid";
    const seen: string[] = [];
    globalThis.fetch = (async (input: any) => {
      seen.push(String(input));
      return new Response(JSON.stringify({ session: { state: "published" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    const data = await waitForSessionStateAfterJob("2026-08-31", "woon", "published", null, "tok");
    expect((data as { session: { state: string } }).session.state).toBe("published");
    expect(seen.length).toBe(1);
  });

  test("a judge job still RUNNING extends the wait past the ordinary deadline — the lane is the resource, not the clock", async () => {
    process.env.BACKEND_URL = "http://publishwait.invalid";
    stubSessionState("aggregated"); // never reaches published
    const start = Date.now();
    let threw: Error | null = null;
    try {
      await waitForSessionStateAfterJob("2026-08-31", "woon", "published", "77", "tok", 200, {
        readJob: stubJudgeJob("running"),
        laneCeilingMs: 3_000,
      });
    } catch (err) {
      threw = err as Error;
    }
    const elapsed = Date.now() - start;
    // It survived PAST the ordinary 200ms deadline (which a plain
    // waitForSessionState would have thrown at), and only gave up at the lane
    // ceiling, naming the lane as the reason.
    expect(threw).not.toBeNull();
    expect(elapsed).toBeGreaterThanOrEqual(2_000);
    expect(threw!.message).toContain("judge job held the swarm lane");
  });

  test("once the judge job is terminal, the ordinary deadline applies", async () => {
    process.env.BACKEND_URL = "http://publishwait.invalid";
    stubSessionState("aggregated");
    const start = Date.now();
    let threw: Error | null = null;
    try {
      await waitForSessionStateAfterJob("2026-08-31", "woon", "published", "77", "tok", 200, {
        readJob: stubJudgeJob("succeeded"), // lane free from the start
        laneCeilingMs: 30_000,
      });
    } catch (err) {
      threw = err as Error;
    }
    expect(threw).not.toBeNull();
    expect(Date.now() - start).toBeLessThan(1_000);
    expect(threw!.message).toContain("did not reach 'published' within 200ms");
  });
});