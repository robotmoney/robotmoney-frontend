// Issue #107 — the smoke's status/TUI surface is LANE-AWARE. Two layers:
//
//  1. Compose topology (docker compose config — offline interpolation, no
//     containers): the smoke stack starts one worker container per execution
//     lane (worker-analytics / worker-research), each with its WORKER_LANE
//     pinned; the old undifferentiated `worker` service is gone. Fails loudly
//     if the topology regresses to generic workers. There is no session lane:
//     issue #1026 moved session timing out of the queue entirely.
//
//  2. TUI wiring (source-level assertions on scripts/lib/smoke-main.ts, which
//     cannot be imported without side effects): the Startup pane names each
//     lane container, the Research pane polls the two DISTINCT analytics kinds
//     (regime.classify + research.refresh) and renders an INDEPENDENT countdown
//     per kind, and no polling path references the retired analytics.run kind.
//
// Docker is a hard dependency of this repo's test harness; a missing docker CLI
// fails this test loudly — never a silent skip (test-coverage policy).
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../../..");

const WORKER_LANE_SERVICES: Record<string, string> = {
  "worker-analytics": "analytics",
  "worker-research": "research",
};

interface ComposeConfig {
  services: Record<string, { environment?: Record<string, string | null> }>;
}

function composeConfig(): ComposeConfig {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  env.SMOKE_PROJECT = "lane-topology-test";
  env.RM_STACK_ENV_CLASS = "local";
  env.RM_STACK_ENV_HASH = "lanetopo000";
  // `${WEB_PORT:?…}` / `${POSTGRES_PORT:?…}` are REQUIRED inputs now (no
  // defaults — see scripts/stack/ports.ts), so `config` needs values even
  // though this test only inspects the resolved service environments.
  env.WEB_PORT = "18788";
  env.POSTGRES_PORT = "15433";
  // docker-compose.yml requires the instance and its state directory (`${RM_INSTANCE_STATE_DIR:?…}`, no
  // checkout fallback; smoke spec §1.1). Nothing is mounted by `config`, so any absolute path renders.
  env.RM_INSTANCE = "rm_local_lanetopo";
  env.RM_INSTANCE_STATE_DIR = "/var/empty/rm_local_lanetopo";
  const r = Bun.spawnSync(
    ["docker", "compose", "-f", "docker-compose.yml", "-f", "docker-compose.smoke.yml", "config", "--format", "json"],
    { cwd: repoRoot, env, stdout: "pipe", stderr: "pipe" },
  );
  if (r.exitCode !== 0) {
    throw new Error(`docker compose config failed (exit ${r.exitCode}): ${new TextDecoder().decode(r.stderr)}`);
  }
  return JSON.parse(new TextDecoder().decode(r.stdout)) as ComposeConfig;
}

describe("smoke lane topology (issue #107)", () => {
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

describe("smoke readiness polling is lane-aware (issue #107)", async () => {
  const src = await Bun.file(join(repoRoot, "scripts/lib/smoke-main.ts")).text();
  // Issue #1026: `bun smoke` draws no TUI (spec §1), so smoke-main.ts no longer
  // holds a startup pane naming the lanes. The lanes a failed boot must STOP
  // are still named, in the decisions module smoke-main.ts does import.
  const failureSrc = await Bun.file(join(repoRoot, "scripts/lib/smoke-failure.ts")).text();

  test("every worker lane container is one a failed boot stops", () => {
    for (const svc of Object.keys(WORKER_LANE_SERVICES)) {
      expect(failureSrc).toContain(`"${svc}"`);
    }
  });

  // The research PANE and its poller retired with the TUI (issue #1026, smoke
  // spec §1): `bun smoke` polls no job kinds at all now. What must still hold
  // is that nothing in the boot names the retired analytics.run kind.
  test("the boot never names the retired analytics.run kind, and runs no job poller", () => {
    expect(src).not.toContain("analytics.run");
    expect(src).not.toContain("smoke-readiness-polling");
  });

  test("the per-kind countdown retired with the poller, and the boot paints none", () => {
    expect(existsSync(join(repoRoot, "scripts/lib/smoke-readiness-polling.ts"))).toBe(false);
    expect(src).not.toContain("secsUntilNext(");
  });
});
