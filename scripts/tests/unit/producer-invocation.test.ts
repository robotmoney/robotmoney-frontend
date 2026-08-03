import { expect, test } from "bun:test";
import { runRegimeClassify, type ProducerComposeRail } from "../../lib/swarm/session.ts";

test("regime producer uses the caller's explicit stack coordinates", async () => {
  const rail: ProducerComposeRail = {
    repoRoot: "/worktrees/feature",
    composeProject: "explicit-project",
    composeFiles: ["docker-compose.yml", "feature-overlay.yml"],
    composeSpawnEnv: { DEMO_PROJECT: "explicit-project", COMPOSE_SENTINEL: "explicit" },
    backendUrl: "http://127.0.0.1:49123",
  };
  const calls: Array<{ rail: ProducerComposeRail; asof: string }> = [];
  const readUrls: string[] = [];

  // #398: runRegimeClassify polls `latest.date` (the served row's own write
  // date), never `staleness.asof` — since #398 that field is the newest REAL
  // raw observation date, which legitimately lags "today" even on a healthy
  // run, so it can't be used as the "did today's row land" signal.
  const result = await runRegimeClassify("2031-01-02", rail, 1_000, {
    runProducer: async (receivedRail, asof) => { calls.push({ rail: receivedRail, asof }); },
    readLatest: async (baseUrl) => {
      readUrls.push(baseUrl);
      return { latest: { date: "2031-01-02" }, staleness: { asof: "2030-12-20" } };
    },
    wait: async () => {},
  });

  expect(calls).toEqual([{ rail, asof: "2031-01-02" }]);
  expect(readUrls).toEqual(["http://127.0.0.1:49123"]);
  expect(result.latest.date).toBe("2031-01-02");
});

test("#398 regression: a stale-but-landed row (real observations lagging today) is still recognized as landed via latest.date, not staleness.asof", async () => {
  const rail: ProducerComposeRail = {
    repoRoot: "/worktrees/feature",
    composeProject: "explicit-project",
    composeFiles: ["docker-compose.yml"],
    composeSpawnEnv: {},
    backendUrl: "http://127.0.0.1:49124",
  };
  // Planted violation control: if runRegimeClassify polled `staleness.asof`
  // instead, this row (whose real observations lag behind `asof`, exactly
  // like a live FRED/weekend lag) would never satisfy `servedAsof >= asof`
  // and the call would time out.
  const result = await runRegimeClassify("2031-01-02", rail, 1_000, {
    runProducer: async () => {},
    readLatest: async () => ({
      latest: { date: "2031-01-02" },
      staleness: { asof: "2031-01-01", stale: false },
    }),
    wait: async () => {},
  });
  expect(result.latest.date).toBe("2031-01-02");
});
