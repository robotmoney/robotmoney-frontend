// scripts/tests/unit/analytics-load-check-exit.test.ts — issue 1597: the stage
// load check wrote its receipt and printed PASS, then its process never exited,
// so release step Q34a hung. These tests run the real entry point in a
// subprocess and assert it ends by itself, with the documented exit code and a
// written receipt.
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "../../release/analytics-load-check.ts");
const PASS_LOG = "2026-10-28T06:00:01.000000000Z [analytics-producer] research run started\n";
const FAIL_LOG = "2026-10-28T06:31:10.000000000Z [api] slow request: POST /api/analytics/vintages took 9.5s status=200 ua=Bun/1.3.14\n";
const EXIT_WITHIN_MS = 15_000;

async function run(args: string[], env: Record<string, string> = {}): Promise<{ code: number | null; timedOut: boolean; out: string }> {
  const proc = Bun.spawn(["bun", SCRIPT, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, EXIT_WITHIN_MS);
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  clearTimeout(timer);
  return { code: timedOut ? null : code, timedOut, out };
}

describe("analytics-load-check exits by itself (issue 1597)", () => {
  const dir = mkdtempSync(join(tmpdir(), "alc-exit-"));
  const receipt = (name: string) => join(dir, name);

  test("--log, a passing window: exit 0, receipt ok", async () => {
    const log = join(dir, "pass.log");
    writeFileSync(log, PASS_LOG);
    const r = await run(["--log", log, "--receipt-dir", receipt("r-pass")]);
    expect(r.timedOut).toBe(false);
    expect(r.code).toBe(0);
    expect(r.out).toContain("PASS");
    expect(JSON.parse(readFileSync(join(receipt("r-pass"), "analytics-load-check.json"), "utf8")).ok).toBe(true);
  });

  test("--log, a failing window: exit 1, receipt not ok", async () => {
    const log = join(dir, "fail.log");
    writeFileSync(log, FAIL_LOG);
    const r = await run(["--log", log, "--receipt-dir", receipt("r-fail")]);
    expect(r.timedOut).toBe(false);
    expect(r.code).toBe(1);
    expect(JSON.parse(readFileSync(join(receipt("r-fail"), "analytics-load-check.json"), "utf8")).ok).toBe(false);
  });

  test("usage error: exit 2", async () => {
    const r = await run([]);
    expect(r.timedOut).toBe(false);
    expect(r.code).toBe(2);
  });

  // The real hang: the default mode follows the producer's log with a cap timer
  // set at boundary + window. A stream finishing the race left that timer
  // pending. A fake `docker` on PATH stands in for the host's.
  test("default mode, tick followed to its regime line: exit 0 within seconds, receipt written", async () => {
    const bin = join(dir, "bin");
    const state = join(dir, "state");
    mkdirSync(bin, { recursive: true });
    mkdirSync(join(state, "stage"), { recursive: true });
    writeFileSync(join(state, "stage", "stack-state.json"), JSON.stringify({ project: "fakeproj", composeFiles: "x", apiPort: 1 }));
    const boundary = new Date(Date.now() - 3_600_000);
    const regime = new Date(boundary.getTime() + 1_000).toISOString();
    writeFileSync(
      join(bin, "docker"),
      `#!/bin/sh
case "$1" in
  ps) echo fakectr ;;
  logs)
    case "$*" in
      *--follow*) echo "${regime} [analytics] regime asof 2026-10-28"; exec sleep 60 ;;
      *) echo "${PASS_LOG.trim()}" ;;
    esac ;;
esac
`,
    );
    chmodSync(join(bin, "docker"), 0o755);
    const r = await run(
      ["--instance", "stage", "--boundary", boundary.toISOString(), "--window-minutes", "120", "--receipt-dir", receipt("r-default")],
      { PATH: `${bin}:${process.env.PATH}`, RM_SMOKE_STATE_ROOT: state },
    );
    expect(r.timedOut).toBe(false);
    expect(r.code).toBe(0);
    expect(existsSync(join(receipt("r-default"), "analytics-load-check.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(receipt("r-default"), "analytics-load-check.json"), "utf8")).ok).toBe(true);
  }, 30_000);

  test("cleanup", () => rmSync(dir, { recursive: true, force: true }));
});
