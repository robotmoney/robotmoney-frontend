// Issue #107 — the demo's status/TUI surface is LANE-AWARE. Two layers:
//
//  1. Compose topology (docker compose config — offline interpolation, no
//     containers): the demo stack starts one worker container per execution
//     lane (worker-committee reserved / worker-analytics / worker-research),
//     each with its WORKER_LANE pinned; the old undifferentiated `worker`
//     service is gone. Fails loudly if the topology regresses to generic
//     workers (which could consume the reserved committee capacity).
//
//  2. TUI wiring (source-level assertions on scripts/lib/demo-main.ts, which
//     cannot be imported without side effects): the Startup pane names each
//     lane container, the Research pane polls the two DISTINCT analytics kinds
//     (regime.classify + research.refresh) and renders an INDEPENDENT countdown
//     per kind, and no polling path references the retired analytics.run kind.
//
// Docker is a hard dependency of this repo's test harness; a missing docker CLI
// fails this test loudly — never a silent skip (test-coverage policy).
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../../..");

const WORKER_LANE_SERVICES: Record<string, string> = {
  "worker-committee": "committee",
  "worker-analytics": "analytics",
  "worker-research": "research",
};

interface ComposeConfig {
  services: Record<string, { environment?: Record<string, string | null> }>;
}

function composeConfig(): ComposeConfig {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  env.DEMO_PROJECT = "lane-topology-test";
  const r = Bun.spawnSync(
    ["docker", "compose", "-f", "docker-compose.yml", "-f", "docker-compose.demo.yml", "config", "--format", "json"],
    { cwd: repoRoot, env, stdout: "pipe", stderr: "pipe" },
  );
  if (r.exitCode !== 0) {
    throw new Error(`docker compose config failed (exit ${r.exitCode}): ${new TextDecoder().decode(r.stderr)}`);
  }
  return JSON.parse(new TextDecoder().decode(r.stdout)) as ComposeConfig;
}

describe("demo lane topology (issue #107)", () => {
  const cfg = composeConfig();

  test("one worker service per lane, each pinned to its WORKER_LANE", () => {
    for (const [svc, lane] of Object.entries(WORKER_LANE_SERVICES)) {
      const service = cfg.services[svc];
      expect(service, `compose is missing the ${svc} service`).toBeDefined();
      expect(service.environment?.WORKER_LANE).toBe(lane);
    }
  });

  test("no undifferentiated generic `worker` service remains (reserved capacity would be claimable)", () => {
    expect(cfg.services["worker"]).toBeUndefined();
    for (const [name, svc] of Object.entries(cfg.services)) {
      // Any worker-lane container MUST carry an explicit lane (the worker entry
      // fails loudly without one, so an unset lane = a container crash-loop).
      if (name.startsWith("worker")) expect(svc.environment?.WORKER_LANE ?? "").not.toBe("");
    }
  });
});

describe("demo TUI is lane-aware (issue #107)", async () => {
  const src = await Bun.file(join(repoRoot, "scripts/lib/demo-main.ts")).text();

  test("startup pane names each worker lane container", () => {
    for (const svc of Object.keys(WORKER_LANE_SERVICES)) {
      expect(src).toContain(`"${svc}"`);
    }
  });

  test("research pane polls the two distinct kinds and never the retired analytics.run", () => {
    expect(src).toContain("j.kind IN ('regime.classify','research.refresh')");
    expect(src).toContain("kind IN ('regime.classify','research.refresh')");
    expect(src).not.toContain("analytics.run");
  });

  test("independent countdown per kind (regime vs research)", () => {
    expect(src).toContain('secsUntilNext("regime.classify")');
    expect(src).toContain('secsUntilNext("research.refresh")');
  });
});
