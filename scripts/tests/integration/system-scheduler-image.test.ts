// Issue #1026 W4 — THE SCHEDULER'S ENTRYPOINT RUNS INSIDE THE IMAGE THAT SHIPS
// IT.
//
// AUTHORITY: docs/technical/system-scheduler-spec.md §1 and §7, and
// docs/technical/smoke-production-spec.md §3.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS BOOTS A CONTAINER
// ─────────────────────────────────────────────────────────────────────────────
//
// `backend/Dockerfile` once copied only `backend/`, so the compose command
// `bun run scripts/system-scheduler.ts` died on a missing file the moment the
// container started. Every compose test RENDERS config and never boots, and
// the health test only greps the Dockerfile's COPY lines, so nothing in the
// suite could see it. The only honest proof that the image carries the
// entrypoint and every module it imports is to build the image and run it.
//
// WHAT "RUNS" MEANS HERE. ES module imports are resolved before any of
// `main()` executes, so a missing module ends the process with a resolution
// error before the token-file check can speak. The token-file refusal is
// therefore proof that the whole import graph — the entrypoint, everything
// under `scripts/lib/system-scheduler/`, and `@robotmoney/contract` from the
// image's own node_modules — resolved inside the image. The second case goes
// one step further and watches the process get as far as its startup check.
//
// WHAT IT DOES NOT PROVE: that the container talks to a real API. There is no
// API here, on purpose; that is the `[e2e]` gate.
//
// LOUD, NEVER SKIPPED. Docker is a hard dependency of this repo's test
// harness already (the backend suite boots ephemeral Postgres through it).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../../..");
const IMAGE_TAG = `rm-system-scheduler-image-test:${process.pid}`;
const containers: string[] = [];
const dirs: string[] = [];

function docker(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync("docker", args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** The markers of an entrypoint that never got as far as running. */
const RESOLUTION_FAILURES = [/Cannot find module/i, /Module not found/i, /ENOENT/, /error: .*resolve/i];

beforeAll(() => {
  // The build compose performs for `system-scheduler`: context is the repo
  // root, dockerfile is backend/Dockerfile.
  execFileSync("docker", ["build", "-f", "backend/Dockerfile", "-t", IMAGE_TAG, "."], {
    cwd: repoRoot,
    stdio: "pipe",
    maxBuffer: 64 * 1024 * 1024,
  });
}, 600_000);

afterAll(() => {
  for (const name of containers) docker(["rm", "-f", "-v", name]);
  docker(["rmi", "-f", IMAGE_TAG]);
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("backend/Dockerfile ships a runnable system-scheduler entrypoint", () => {
  test("with no token file, the entrypoint exits 2 with the NAMED token-file refusal, not a module error", () => {
    const name = `rm-sched-image-notoken-${process.pid}`;
    containers.push(name);
    const r = docker([
      "run",
      "--name",
      name,
      "--network",
      "none",
      "-e",
      "SCHEDULER_API_URL=http://127.0.0.1:1",
      "-e",
      "SCHEDULER_TOKEN_FILE=/run/rm-state/automation-token",
      IMAGE_TAG,
      "bun",
      "run",
      "scripts/system-scheduler.ts",
    ]);
    const output = `${r.stdout}\n${r.stderr}`;
    for (const failure of RESOLUTION_FAILURES) {
      expect({ failure: String(failure), found: failure.test(output.replace(/automation token file not found: \S+/, "")) }).toEqual({
        failure: String(failure),
        found: false,
      });
    }
    expect(output).toContain("[system-scheduler] automation token file not found: /run/rm-state/automation-token");
    expect(r.status).toBe(2);
    docker(["rm", "-f", "-v", name]);
  }, 120_000);

  test("with a token file and no API, the process runs to its startup check and stays up", async () => {
    const name = `rm-sched-image-noapi-${process.pid}`;
    containers.push(name);
    const state = mkdtempSync(join(tmpdir(), "rm-sched-image-"));
    dirs.push(state);
    writeFileSync(join(state, "automation-token"), "rmat_image_test\n");
    chmodSync(state, 0o755);
    chmodSync(join(state, "automation-token"), 0o644);

    const started = docker([
      "run",
      "-d",
      "--name",
      name,
      "--network",
      "none",
      "-v",
      `${state}:/run/rm-state:ro`,
      "-e",
      "SCHEDULER_API_URL=http://127.0.0.1:1",
      "-e",
      "SCHEDULER_TOKEN_FILE=/run/rm-state/automation-token",
      "-e",
      "SCHEDULER_HEALTH_PORT=8090",
      IMAGE_TAG,
      "bun",
      "run",
      "scripts/system-scheduler.ts",
    ]);
    expect(started.status).toBe(0);

    let logs = "";
    for (let i = 0; i < 100 && !logs.includes("startup check: API unreachable"); i += 1) {
      await Bun.sleep(200);
      const l = docker(["logs", name]);
      logs = `${l.stdout}\n${l.stderr}`;
    }
    expect(logs).toContain("[system-scheduler] health on :8090/health");
    expect(logs).toContain("startup check: API unreachable");
    for (const failure of RESOLUTION_FAILURES) expect(failure.test(logs)).toBe(false);

    const state_ = docker(["inspect", "-f", "{{.State.Running}}", name]);
    expect(state_.stdout.trim()).toBe("true");
    docker(["rm", "-f", "-v", name]);
  }, 120_000);
});
