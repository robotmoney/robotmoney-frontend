// EXECUTED proof of `bun run demo:clean`'s exit-code contract
// (scripts/demo-clean.ts) — the loud-skip-never-silent-skip invariant applied to
// teardown.
//
// WHY THIS FILE EXISTS. e2e run 30406428674 was cancelled mid-boot, so the demo
// boot step's own `docker compose down` never ran and the stack survived. The
// `if: always()` backstop then ran demo-clean, which removes VOLUMES only: it
// found the run's pgdata volume still referenced by a live container, printed
//
//     [demo:clean] SKIPPED 1 volume(s) (left intact):
//       ⚠ rmdemo_ci_30406428674_1_pgdata — in use ... [676c43de5091...]
//
// …and EXITED 0. The step went green over a live leak; the surviving api
// container then held :48787 (the cloudflared origin for
// stage.robotmoney-labs.dev) for over an hour. A backstop that cannot fail in
// the exact scenario its own comment cites is not a backstop.
//
// The contract is ROLE-DEPENDENT, which is why it needs executed assertions on
// the real process exit code rather than a unit test of a helper:
//
//   with --project    (CI backstop role)  any surviving resource ⇒ EXIT 1
//   without --project (operator role)     any surviving resource ⇒ EXIT 0
//
// Both are proven here by running the actual script with a FAKE `docker` first
// on PATH. No daemon is contacted — which is not merely a speed choice: the host
// these tests run on serves stage.robotmoney-labs.dev, and a teardown test that
// reached a real daemon could take the live site down proving teardown works.
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..", "..");
const CLEAN = join(repoRoot, "scripts", "demo-clean.ts");

// A `docker` shim covering exactly the three calls demo-clean makes:
// `ps -a --format json` (zombie eval-container purge), `volume ls` and
// `volume rm`. Behaviour is switched by env vars so one shim serves every case.
const FAKE_DOCKER = `#!/usr/bin/env bash
set -u
case "$1 \${2:-}" in
  "ps -a")
    exit 0
    ;;
  "volume ls")
    if [ "\${FAKE_LS_FAILS:-0}" = "1" ]; then
      echo "Cannot connect to the Docker daemon" >&2
      exit 1
    fi
    if [ "\${FAKE_NO_VOLUMES:-0}" = "1" ]; then
      exit 0
    fi
    echo '{"Name":"rm_ci_stack_30406428674_1_pgdata","Labels":"robotmoney.demo=1,robotmoney.demo.project=rm_ci_stack_30406428674_1","Driver":"local","Scope":"local"}'
    exit 0
    ;;
  "volume rm")
    if [ "\${FAKE_IN_USE:-0}" = "1" ]; then
      echo "Error response from daemon: remove $3: volume is in use - [676c43de5091abcdef]" >&2
      exit 1
    fi
    echo "$3"
    exit 0
    ;;
esac
exit 0
`;

interface RunResult { exitCode: number; output: string }

function runClean(args: string[], env: Record<string, string> = {}): RunResult {
  const dir = mkdtempSync(join(tmpdir(), "demo-clean-fakedocker-"));
  try {
    const shim = join(dir, "docker");
    writeFileSync(shim, FAKE_DOCKER);
    chmodSync(shim, 0o755);
    const r = Bun.spawnSync([process.execPath, CLEAN, ...args], {
      cwd: repoRoot,
      // PATH is ONLY the shim directory plus the minimum bash needs: a real
      // docker on this host must be unreachable from these tests, period.
      env: { PATH: `${dir}:/usr/bin:/bin`, HOME: dir, ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const dec = new TextDecoder();
    return { exitCode: r.exitCode ?? -1, output: `${dec.decode(r.stdout)}${dec.decode(r.stderr)}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const PROJECT = "rm_ci_stack_30406428674_1";

describe("demo:clean exit codes — the CI backstop role (--project)", () => {
  test("an in-use volume FAILS the step (the regression that shipped run 30406428674's green teardown)", () => {
    const r = runClean(["--project", PROJECT], { FAKE_IN_USE: "1" });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("TEARDOWN INCOMPLETE");
    expect(r.output).toContain(`project=${PROJECT}`);
  });

  test("the failure is ACTIONABLE — it names the volume, the holding container, and the command that clears it", () => {
    const r = runClean(["--project", PROJECT], { FAKE_IN_USE: "1" });
    expect(r.output).toContain("rm_ci_stack_30406428674_1_pgdata");
    // The bracketed container id docker hands back is the single most useful
    // fact in the message and used to be buried in a log line nobody read.
    expect(r.output).toContain("676c43de5091abcdef");
    expect(r.output).toContain(`docker compose -p ${PROJECT} down -v --remove-orphans`);
    expect(r.output).toContain("demo:reap");
  });

  test("a clean teardown still exits 0 — the gate is a leak, not the mere presence of a volume", () => {
    const r = runClean(["--project", PROJECT]);
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("removed 1 volume(s)");
    expect(r.output).not.toContain("TEARDOWN INCOMPLETE");
  });

  test("nothing to remove exits 0", () => {
    const r = runClean(["--project", PROJECT], { FAKE_NO_VOLUMES: "1" });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("nothing to remove");
  });
});

describe("demo:clean exit codes — the operator role (no --project)", () => {
  test("an in-use volume exits 0 — bare `bun run demo:clean` while your demo is up is not an error", () => {
    const r = runClean([], { FAKE_IN_USE: "1" });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("SKIPPED 1 volume(s)");
    // Still LOUD: reported, with the holder and the way to reclaim it.
    expect(r.output).toContain("676c43de5091abcdef");
    expect(r.output).toContain("bun run demo:down");
    expect(r.output).not.toContain("TEARDOWN INCOMPLETE");
  });

  test("a clean sweep exits 0", () => {
    const r = runClean([]);
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("removed 1 volume(s)");
  });
});

describe("demo:clean exit codes — a dead daemon is red in BOTH roles", () => {
  test("with --project", () => {
    const r = runClean(["--project", PROJECT], { FAKE_LS_FAILS: "1" });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("could not list volumes");
  });
  test("without --project — 'could not look' must never read as 'nothing to find'", () => {
    const r = runClean([], { FAKE_LS_FAILS: "1" });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("could not list volumes");
  });
});

describe("the fake-docker harness itself is honest", () => {
  test("the shim is what answered — no real daemon was reachable on the test PATH", () => {
    // If a real docker had answered `volume ls`, this synthetic volume name
    // could not appear. It is the control that keeps every assertion above
    // meaningful rather than accidentally passing against a live host.
    const r = runClean([]);
    expect(r.output).toContain("rm_ci_stack_30406428674_1_pgdata");
  });
});
