// csvb-backup is OPTIONAL and NON-GATING (D82, issue 1608): a full-stack boot passes with it stopped, absent or
// unhealthy. A fake StackRuntime records every docker call; the sequencing asserted is the real `up()`.
import { describe, expect, test } from "bun:test";
import { createStack, type StackRuntime } from "../../stack/stack.ts";
import { API_CONTAINER_PORT, type StackConfig } from "../../stack/config.ts";

const config: StackConfig = {
  repoRoot: "/nonexistent-by-design",
  project: "stack_optional_test",
  profile: "full",
  composeFiles: ["docker-compose.yml"],
  database: { user: "u", password: "p", name: "d" },
  environment: { class: "ci", hash: "0123456789" },
};

/** `optional` decides how the csvb-backup start answers: ok, fail (nonzero), or throw. */
function runtime(calls: string[], optional: "ok" | "fail" | "throw"): StackRuntime {
  return {
    runSync(argv) {
      const line = argv.join(" ");
      if (argv.includes("port")) return { exitCode: 0, stdout: `0.0.0.0:${argv.includes(String(API_CONTAINER_PORT)) ? "40001" : "40002"}\n`, stderr: "" };
      if (line.includes("ps -q --status running")) return { exitCode: 0, stdout: "", stderr: "" };
      if (line.includes(" up ")) {
        calls.push(line.slice(line.indexOf(" up ") + 1));
        if (line.includes("csvb-backup")) {
          if (optional === "throw") throw new Error("docker exploded");
          if (optional === "fail") return { exitCode: 1, stdout: "", stderr: "Error response from daemon: no such image csvb-backup" };
        }
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    async run(argv) {
      const line = argv.join(" ");
      if (line.includes(" up ")) calls.push(line.slice(line.indexOf(" up ") + 1));
      return { exitCode: 0, outputTail: "" };
    },
    async probe() {
      return { ok: true, detail: "ok" };
    },
  };
}

describe("a full boot never waits on, or fails for, csvb-backup", () => {
  for (const mode of ["ok", "fail", "throw"] as const) {
    test(`with its start ${mode === "ok" ? "succeeding (running, healthy or not)" : mode === "fail" ? "failing (stopped, absent image)" : "throwing"}, up() resolves and the logs say so`, async () => {
      const calls: string[] = [];
      const logs: string[] = [];
      const hooks = { onEvent: (e: { phase: string; message?: string }) => { if (e.phase === "log" && e.message) logs.push(e.message); } };
      await createStack(config, { runtime: runtime(calls, mode), hooks: hooks as never }).up();
      const ups = calls.filter((c) => c.startsWith("up "));
      // Exactly one start of csvb-backup, with no --wait, after the stack's own services.
      const optional = ups.filter((c) => c.includes("csvb-backup"));
      expect(optional).toHaveLength(1);
      expect(optional[0]).not.toContain("--wait");
      expect(ups.filter((c) => c.includes("--wait") && c.includes("csvb-backup"))).toEqual([]);
      expect(ups.indexOf(optional[0]!)).toBeGreaterThan(ups.findIndex((c) => c.includes("api")));
      if (mode !== "ok") expect(logs.some((l) => l.includes("did not start") && l.includes("the boot continues"))).toBe(true);
    });
  }

  test("a core boot does not start it at all", async () => {
    const calls: string[] = [];
    await createStack({ ...config, profile: "core" }, { runtime: runtime(calls, "ok") }).up();
    expect(calls.some((c) => c.includes("csvb-backup"))).toBe(false);
  });
});
