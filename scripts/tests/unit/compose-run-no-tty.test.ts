// `docker compose run` allocates a pseudo-terminal unless it is given -T. The
// smoke boot runs under a terminal whenever an operator starts it (or a test
// wraps it in script(1)), and then `run` reads its stdin, which the boot does
// not hand it, and fails at once with "the input device is not a TTY". CI saw
// exactly that: the producer's seed command exited 1 in 130 ms and every
// readiness check after it never ran. A passing local run did not show it,
// because that depends on the docker client's version. Each one-off the boot
// spawns therefore says -T, whatever the terminal is.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..", "..");
const SPAWNERS = ["scripts/lib/smoke-main.ts", "scripts/lib/swarm/session.ts"];

describe("a compose one-off the smoke boot spawns allocates no terminal", () => {
  for (const file of SPAWNERS) {
    test(`${file}: every \`run ... analytics-producer\` carries -T`, () => {
      const text = readFileSync(join(root, file), "utf8");
      const runs = text.match(/"run",[^\]]*?"analytics-producer"/g) ?? [];
      expect(runs.length).toBeGreaterThan(0);
      for (const r of runs) expect(r).toContain('"-T"');
    });
  }
  test("red control: the pattern sees a run without -T", () => {
    const bad = '["run", "--rm", "--no-deps", "analytics-producer", "bun"]';
    const runs = bad.match(/"run",[^\]]*?"analytics-producer"/g) ?? [];
    expect(runs.length).toBe(1);
    expect(runs[0]).not.toContain('"-T"');
  });
});
