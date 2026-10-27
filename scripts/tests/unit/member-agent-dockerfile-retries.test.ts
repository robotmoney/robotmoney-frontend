// Issue #1040: the member-agent image downloads on every build. A single
// mirror or GitHub blip failed the whole build (main went red twice on
// 2026-09-24), so every download retries. The pinned versions and checksums
// must not move with it.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dockerfile = readFileSync(join(import.meta.dir, "../../lib/member-agent/Dockerfile"), "utf8");

/** Dockerfile text with `\`-continued lines joined, comments dropped. */
const logical = dockerfile
  .replace(/\\\n\s*/g, " ")
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("#"));

/** Every `curl ...` invocation's argument tokens, up to the first `&&`. */
function curlInvocations(lines: string[]): string[][] {
  const out: string[][] = [];
  for (const l of lines) {
    for (const m of l.matchAll(/(?:^|\s)curl\s+(-[^&|;]*)/g)) out.push(m[1]!.trim().split(/\s+/));
  }
  return out;
}

describe("member-agent Dockerfile download retries", () => {
  test("every curl carries --retry 5, --retry-all-errors and --connect-timeout", () => {
    const curls = curlInvocations(logical.filter((l) => l.startsWith("RUN")));
    expect(curls.length).toBe(2);
    for (const args of curls) {
      const at = args.indexOf("--retry");
      expect(at, args.join(" ")).toBeGreaterThanOrEqual(0);
      expect(args[at + 1]).toBe("5");
      expect(args).toContain("--retry-all-errors");
      expect(args).toContain("--connect-timeout");
    }
  });

  test("every apt-get update and install carries -o Acquire::Retries=5", () => {
    const calls = logical.flatMap((l) => [...l.matchAll(/apt-get\s+([^&|;]*)/g)].map((m) => m[0]));
    expect(calls.filter((c) => /\b(update|install)\b/.test(c)).length).toBe(2);
    for (const c of calls) expect(c, c).toContain("-o Acquire::Retries=5");
  });

  test("the pinned versions and sha256 values are unchanged", () => {
    expect(dockerfile).toContain("ARG OPENCODE_VERSION=1.18.1");
    expect(dockerfile).toContain("ARG OPENCODE_LINUX_X64_SHA256=9ecce27cf529ade5f177fab478b4876b5c31d9ddc8216b994816acf192159511");
    expect(dockerfile).toContain("ARG BUN_VERSION=1.4.4");
    expect(dockerfile).toContain("ARG BUN_LINUX_X64_SHA256=bf8ccbfb2b0b80159e0f9a6d15c55317add8077534dbc6130a3edb52fccb395c");
  });
});

describe("the Dockerfile's curl flags survive a flaky server", () => {
  /** The flags before `-o`, from the first curl in the Dockerfile. */
  const flags = curlInvocations(logical.filter((l) => l.startsWith("RUN")))[0]!.slice(
    0,
    curlInvocations(logical.filter((l) => l.startsWith("RUN")))[0]!.indexOf("-o"),
  );

  function serve() {
    let hits = 0;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => (++hits <= 2 ? new Response("busy", { status: 503 }) : new Response("payload")),
    });
    return { server, reset: () => (hits = 0) };
  }

  test("503, 503, 200 exits 0 and writes the 200 body; the same URL without the flags fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rm-curl-retry-"));
    const { server, reset } = serve();
    try {
      const url = `http://127.0.0.1:${server.port}/asset`;
      // Async spawn: the server shares this event loop, so a synchronous spawn would deadlock it.
      const withFlags = await Bun.spawn(["curl", ...flags, "-o", join(dir, "ok"), url], { stderr: "pipe" }).exited;
      expect(withFlags).toBe(0);
      expect(readFileSync(join(dir, "ok"), "utf8")).toBe("payload");

      reset();
      const stripped = await Bun.spawn(["curl", "-fsSL", "-o", join(dir, "bad"), url], { stderr: "pipe" }).exited;
      expect(stripped).not.toBe(0);
    } finally {
      server.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
