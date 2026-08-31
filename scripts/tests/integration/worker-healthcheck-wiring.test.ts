// Wiring guard for the worker/producer healthcheck: the command string in
// docker-compose.yml is EXECUTED here, not merely asserted to exist.
//
// The failure this exists to catch is the one a config-level test cannot see: a
// healthcheck whose command is wrong (moved file, bad flag, missing binary) is
// a non-zero exit on every probe, which Docker reports as a permanently
// unhealthy container. Every service would go red at once and the signal would
// be worthless — so the command is pulled out of the resolved compose config and
// run against real heartbeat files, exactly as the container runs it.
//
// Docker is a hard dependency of this repo's test harness; a missing docker CLI
// fails this test loudly rather than skipping (test-coverage policy).
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../../..");
const backendDir = join(repoRoot, "backend");

// One `docker compose config` run for the whole file (issue #809). Shelling out
// to the Docker CLI costs seconds on a cold shared runner, which is enough for
// the 5000 ms Bun applies to a test that declares no timeout to expire on an
// unrelated diff. The rendering is the same for every service, so it is
// resolved ONCE — on the first call, which happens while the describe below is
// being collected, not inside any test's budget — and every later lookup reads
// the cached config. A missing or broken docker CLI still throws loudly here;
// it is never a silent skip (test-coverage policy).
let renderedServices: Record<string, { healthcheck?: { test?: string[] } }> | undefined;

function composeServices(): Record<string, { healthcheck?: { test?: string[] } }> {
  if (renderedServices) return renderedServices;
  const r = Bun.spawnSync(
    ["docker", "compose", "-f", "docker-compose.yml", "config", "--format", "json"],
    {
      cwd: repoRoot,
      // The two published-port lines are `${VAR:?…}`; compose refuses to resolve
      // without them. Values are arbitrary — nothing is published here.
      env: { ...process.env, WEB_PORT: "18787", POSTGRES_PORT: "15432" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (r.exitCode !== 0) {
    throw new Error(`docker compose config failed (exit ${r.exitCode}): ${new TextDecoder().decode(r.stderr)}`);
  }
  const cfg = JSON.parse(new TextDecoder().decode(r.stdout)) as {
    services: Record<string, { healthcheck?: { test?: string[] } }>;
  };
  renderedServices = cfg.services;
  return renderedServices;
}

function resolvedHealthcheckCommand(service: string): string[] {
  const test_ = composeServices()[service]?.healthcheck?.test;
  if (!test_?.length) throw new Error(`service "${service}" declares no healthcheck test`);
  // ["CMD", ...argv] — the exec form the lanes and the producer both use.
  if (test_[0] !== "CMD") throw new Error(`expected an exec-form CMD healthcheck, got ${test_[0]}`);
  return test_.slice(1);
}

/** Run the container's healthcheck argv against a given heartbeat file. The
 *  image sets WORKDIR /app == backend/, so that is the cwd here too. */
function runCheck(argv: string[], heartbeatFile: string): { exitCode: number; stdout: string } {
  const r = Bun.spawnSync(argv, {
    cwd: backendDir,
    env: { ...process.env, HEARTBEAT_FILE: heartbeatFile },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: r.exitCode,
    stdout: new TextDecoder().decode(r.stdout) + new TextDecoder().decode(r.stderr),
  };
}

describe("the healthcheck command docker-compose.yml declares actually runs", () => {
  const argv = resolvedHealthcheckCommand("worker-swarm");
  const dir = mkdtempSync(join(tmpdir(), "rm-hc-wiring-"));

  test("the lanes and the producer are wired to the same command", () => {
    expect(resolvedHealthcheckCommand("analytics-producer")).toEqual(argv);
    for (const lane of ["worker-analytics", "worker-research"]) {
      expect(resolvedHealthcheckCommand(lane)).toEqual(argv);
    }
  });

  test("a fresh heartbeat exits 0", () => {
    const file = join(dir, "fresh");
    writeFileSync(file, JSON.stringify({ ts: Date.now(), staleAfterMs: 60_000, phase: "idle", writer: "swarm-1" }));

    const { exitCode, stdout } = runCheck(argv, file);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("ok:");
  });

  test("a stale heartbeat exits 1 and prints WHY — Docker keeps this in .State.Health.Log", () => {
    const file = join(dir, "stale");
    writeFileSync(file, JSON.stringify({
      ts: Date.now() - 600_000, staleAfterMs: 60_000, phase: "busy", writer: "swarm-1", detail: "job 41 (swarm.session_open)",
    }));

    const { exitCode, stdout } = runCheck(argv, file);

    expect(exitCode).toBe(1);
    expect(stdout).toContain("STALE");
    expect(stdout).toContain("no progress");
    expect(stdout).toContain("job 41 (swarm.session_open)");
  });

  test("a container that never wrote a heartbeat exits 1", () => {
    const { exitCode, stdout } = runCheck(argv, join(dir, "never-written"));

    expect(exitCode).toBe(1);
    expect(stdout).toContain("no heartbeat file");
  });

  test("the check is cheap enough for its 10s timeout", () => {
    const file = join(dir, "timing");
    writeFileSync(file, JSON.stringify({ ts: Date.now(), staleAfterMs: 60_000, phase: "idle" }));

    const t0 = Date.now();
    runCheck(argv, file);

    // A probe that outran its compose `timeout` would be reported as a failed
    // check regardless of what the heartbeat says.
    expect(Date.now() - t0).toBeLessThan(10_000);
    rmSync(dir, { recursive: true, force: true });
  });
});
