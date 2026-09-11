// EXECUTES scripts/stack-migrate.sh — a pre_start_command wrapper only proves
// its one required property (issue #895 AC 2 / Test plan) by actually
// running: that its own exit code matches whatever the underlying migrate
// invocation exits with, so a non-zero migration genuinely aborts
// `stack manage start`, not merely "reads like it would."
//
// The wrapper's real invocation is `docker compose run --rm --no-deps api
// bun run src/db/migrate.ts` (see the script's own header comment for why:
// DATABASE_URL is `external: true` on the compose target, so it can only be
// delivered through the same compose-interpolation path the app pod's own
// containers use — no secrets.env line exists to source instead). The unit
// tier blocks the real `docker` binary (unit.yml), which is exactly right
// here: these tests stub `docker` on PATH themselves, so they prove the
// wrapper's own exit-code plumbing rather than depending on a real Docker
// daemon or a real database.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WRAPPER = join(import.meta.dir, "../../stack-migrate.sh");

const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

// Plants a fake `docker` on PATH ahead of everything else, so `docker
// compose run --rm --no-deps api bun run src/db/migrate.ts` resolves to a
// stub that just exits with the given code — proving the wrapper propagates
// whatever the underlying migrate command does, without touching a real
// Docker daemon.
function stubDocker(exitCode: number): string {
  const dir = mkdtempSync(join(tmpdir(), "stack-migrate-stub-"));
  made.push(dir);
  const dockerBin = join(dir, "docker");
  writeFileSync(dockerBin, `#!/usr/bin/env bash\nexit ${exitCode}\n`);
  chmodSync(dockerBin, 0o755);
  return dir;
}

function runWrapper(stubDir: string): { code: number; out: string } {
  const deploymentDir = mkdtempSync(join(tmpdir(), "stack-migrate-deploy-"));
  made.push(deploymentDir);
  const p = Bun.spawnSync(["bash", WRAPPER], {
    env: {
      ...process.env,
      PATH: `${stubDir}:${process.env.PATH ?? ""}`,
      STACK_DEPLOYMENT_DIR: deploymentDir,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: p.exitCode ?? -1,
    out: new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr),
  };
}

describe("scripts/stack-migrate.sh (executed, not merely present)", () => {
  // AC 1 / Test plan: `shellcheck scripts/stack-migrate.sh` exits 0.
  // ubuntu-latest (this repo's CI runner) ships shellcheck preinstalled, so
  // this asserts the real tool's verdict rather than a hand-rolled lint. A
  // missing binary fails LOUDLY (not a silent skip/pass) — per this repo's
  // loud-skip convention — because a green run must mean shellcheck actually
  // ran, not that it was absent.
  test("shellcheck scripts/stack-migrate.sh exits 0", () => {
    const which = Bun.spawnSync(["bash", "-c", "command -v shellcheck"]);
    if (which.exitCode !== 0) {
      throw new Error(
        "shellcheck is not installed on this runner — cannot verify AC 1 (this must fail loudly, not silently pass)",
      );
    }
    const p = Bun.spawnSync(["shellcheck", WRAPPER], { stdout: "pipe", stderr: "pipe" });
    const out = new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr);
    if (p.exitCode !== 0) {
      throw new Error(`shellcheck scripts/stack-migrate.sh exited ${p.exitCode}:\n${out}`);
    }
    expect(p.exitCode).toBe(0);
  });

  test("exits 0 when the underlying migrate command exits 0", () => {
    const stubDir = stubDocker(0);
    const result = runWrapper(stubDir);
    expect(result.code).toBe(0);
  });

  test("propagates a non-zero exit from the underlying migrate command", () => {
    const stubDir = stubDocker(1);
    const result = runWrapper(stubDir);
    expect(result.code).toBe(1);
  });

  test("propagates a DIFFERENT non-zero exit code too, not just 1", () => {
    const stubDir = stubDocker(17);
    const result = runWrapper(stubDir);
    expect(result.code).toBe(17);
  });

  test("refuses loudly (not exit 0) when STACK_DEPLOYMENT_DIR is unset", () => {
    const stubDir = stubDocker(0);
    const p = Bun.spawnSync(["bash", WRAPPER], {
      env: { ...process.env, PATH: `${stubDir}:${process.env.PATH ?? ""}`, STACK_DEPLOYMENT_DIR: "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(p.exitCode).not.toBe(0);
  });
});
