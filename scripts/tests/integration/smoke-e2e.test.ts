// The full-stack lifecycle verdict, run for real (issue #1026; smoke spec §10
// W1 and W3; scheduler spec §10; plan P6).
//
// One run of scripts/smoke-e2e.ts, which boots `bun smoke --local blank
// --migrate --seed` with the committed fixture credential file and no overlay,
// seats the fixture participants, observes one turnover of a short-epoch
// subject, removes the scheduler's token file, stops its container, and ends
// with `smoke:down`. The script gates every check itself and prints one line per
// check; this test asserts it exited 0 and that each named check was reached,
// so a check that silently stopped running goes red here.
//
// Fixture keys only: test-fixtures/smoke holds an empty roster and two throwaway
// Ed25519 seeds. The run's state lives in a temp root of its own.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot, teardown, harness, BOOT_TIMEOUT_MS } from "./smoke-boot-harness.ts";

const h = harness("e2e");

afterAll(() => {
  // The script's own `smoke:down` ran; this is the backstop and the volume reclaim.
  teardown(h);
}, 300_000);

describe("scripts/smoke-e2e.ts against a real stack", () => {
  test("the fixtures are committed and hold fixture keys only", () => {
    const empty = JSON.parse(readFileSync(join(repoRoot, "test-fixtures/smoke/empty-roster.credentials.json"), "utf8"));
    expect(empty).toEqual({ agents: {}, judges: {} });
    const participants = readFileSync(join(repoRoot, "test-fixtures/smoke/participants.fixture.json"), "utf8");
    expect(participants).toContain("FIXTURE KEYS ONLY");
    expect(existsSync(join(repoRoot, "test-fixtures/smoke/participants.fixture.json"))).toBe(true);
  });

  test(
    "it exits 0 and reaches every lifecycle check",
    () => {
      const out = Bun.spawnSync(["bun", "scripts/smoke-e2e.ts", "--instance", h.instance], {
        cwd: repoRoot,
        env: { ...h.env, E2E_EPOCH_SECONDS: "30", E2E_JUDGING_SECONDS: "10" },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const text = `${out.stdout.toString()}${out.stderr.toString()}`;
      expect({ code: out.exitCode, tail: out.exitCode === 0 ? "" : text.slice(-4000) }).toEqual({ code: 0, tail: "" });
      for (const line of [
        "the boot exits 0 at readiness",
        "a receipt is present",
        "exactly one collecting session per active subject",
        "the real scheduler is healthy",
        "each participant is running with restart: unless-stopped",
        "exactly two sessions after the turnover",
        "the first session is published",
        "the second session is collecting",
        "the failure names the scheduler's token file",
        "smoke:status names the stopped scheduler as not running now",
        "every lifecycle check passed",
      ]) {
        expect({ line, reached: text.includes(line) }).toEqual({ line, reached: true });
      }
      expect(text).not.toContain("✗");
    },
    2 * BOOT_TIMEOUT_MS,
  );
});

