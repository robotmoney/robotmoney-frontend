import { expect, test } from "bun:test";
import { hermeticDataSource } from "../src/analytics/access/hermetic-source.ts";
import type { AnalyticsPersistence } from "../src/analytics/persistence.ts";
import { requireProducerApiConfig, runProducerCommand, runProducerOnce, startProducerSchedules } from "../src/producer/index.ts";

const persistence = {} as AnalyticsPersistence;

test("independent producer computes regime itself and receives only an HTTP persistence port", async () => {
  const calls: string[] = [];
  const result = await runProducerOnce("regime", "2031-01-02", {
    source: hermeticDataSource,
    persistence,
    runner: async (asof, tool, source, store) => {
      expect(asof).toBe("2031-01-02");
      expect(source).toBe(hermeticDataSource);
      expect(store).toBe(persistence);
      calls.push(tool);
      return { [tool]: { submitted: true } };
    },
  });
  expect(calls).toEqual(["regime"]);
  expect(result).toEqual({ regime: { submitted: true } });
});

test("independent research producer scopes execution to the two research tools", async () => {
  const calls: string[] = [];
  await runProducerOnce("research", "2031-01-02", {
    source: hermeticDataSource,
    persistence,
    runner: async (_asof, tool) => { calls.push(tool); return { [tool]: true }; },
  });
  expect(calls).toEqual(["channel-divergence", "late-cycle-signals"]);
  expect(calls).not.toContain("regime");
});

test("producer refuses to reach readiness without an analytics credential", async () => {
  let readinessChecked = false;
  await expect(runProducerCommand("regime", "2031-01-02", {
    env: { ANALYTICS_API_URL: "http://api:8787" },
    waitUntilReady: async () => { readinessChecked = true; },
  })).rejects.toThrow("requires ANALYTICS_TOKEN");
  expect(readinessChecked).toBe(false);
  expect(() => requireProducerApiConfig({ ANALYTICS_TOKEN: "  " })).toThrow("requires ANALYTICS_TOKEN");
});

test("serve validates the credential with the API before arming either schedule", async () => {
  const expectedToken = "correct-producer-secret";
  const requests: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      requests.push(`${url.pathname}:${req.headers.get("authorization") ?? "none"}`);
      if (url.pathname === "/health") return Response.json({ status: "ok" });
      if (url.pathname === "/api/analytics/readiness") {
        return req.headers.get("authorization") === `Bearer ${expectedToken}`
          ? Response.json({ ok: true, role: "analytics-provider" })
          : Response.json({ error: "analytics-provider role required" }, { status: 403 });
      }
      return new Response("not found", { status: 404 });
    },
  });
  const baseEnv = { ANALYTICS_API_URL: `http://127.0.0.1:${server.port}` };
  try {
    const rejectedSchedules: string[] = [];
    await expect(startProducerSchedules({
      env: { ...baseEnv, ANALYTICS_TOKEN: "wrong-non-empty-secret" },
      scheduleKind: (kind) => { rejectedSchedules.push(kind); },
    })).rejects.toThrow("credential was rejected");
    expect(rejectedSchedules).toEqual([]);

    const acceptedSchedules: string[] = [];
    await startProducerSchedules({
      env: { ...baseEnv, ANALYTICS_TOKEN: expectedToken },
      scheduleKind: (kind, cron) => { acceptedSchedules.push(`${kind}:${cron}`); },
    });
    expect(acceptedSchedules).toEqual([
      "regime:30 22 * * *",
      "research:0 23 * * *",
    ]);
    expect(requests).toContain("/api/analytics/readiness:Bearer wrong-non-empty-secret");
    expect(requests).toContain(`/api/analytics/readiness:Bearer ${expectedToken}`);
  } finally {
    server.stop(true);
  }
});

test("seed waits for the API, seeds raw history, then produces both research signals", async () => {
  const events: string[] = [];
  await runProducerCommand("seed", "2031-01-02", {
    env: { ANALYTICS_API_URL: "http://api:8787", ANALYTICS_TOKEN: "producer-secret" },
    waitUntilReady: async (cfg) => {
      expect(cfg.baseUrl).toBe("http://api:8787");
      expect(cfg.token).toBe("producer-secret");
      events.push("ready");
    },
    bootstrapSeed: async () => { events.push("seed"); },
    source: hermeticDataSource,
    persistence,
    runner: async (_asof, tool, _source, store) => {
      expect(store).toBe(persistence);
      events.push(tool);
      return { [tool]: true };
    },
  });
  expect(events).toEqual(["ready", "seed", "channel-divergence", "late-cycle-signals"]);
});
