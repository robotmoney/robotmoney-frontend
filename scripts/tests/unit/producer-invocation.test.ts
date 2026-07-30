import { expect, test } from "bun:test";
import { runRegimeClassify, type ProducerComposeRail } from "../../lib/committee/session.ts";

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

  const result = await runRegimeClassify("2031-01-02", rail, 1_000, {
    runProducer: async (receivedRail, asof) => { calls.push({ rail: receivedRail, asof }); },
    readLatest: async (baseUrl) => {
      readUrls.push(baseUrl);
      return { staleness: { asof: "2031-01-02" } };
    },
    wait: async () => {},
  });

  expect(calls).toEqual([{ rail, asof: "2031-01-02" }]);
  expect(readUrls).toEqual(["http://127.0.0.1:49123"]);
  expect(result.staleness.asof).toBe("2031-01-02");
});
