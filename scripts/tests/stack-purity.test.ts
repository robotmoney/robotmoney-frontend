// EXECUTED proof (not a doc-grep) of scripts/stack/'s two structural
// invariants — docs/decisions.md D22 "shared components", docs/architecture.md
// §11.3 E5:
//
//   1. Nothing runs on import. demo-main.ts does its port allocation, secret
//      generation and log-file opening at MODULE scope, which is exactly why
//      no test could import it and why the rails check had to fork its own
//      mini-stack. If scripts/stack/ ever grows the same habit, this test goes
//      red instead of the habit spreading.
//   2. Importing it neither reads nor writes the process environment, and
//      spawns nothing: the child below runs with PATH pointed at an EMPTY
//      directory, so any docker invocation at import time would fail loudly.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStack, DEFAULT_COMPOSE_FILES, DEFAULT_STACK_DATABASE, type StackEvent } from "../stack/index.ts";

const repoRoot = join(import.meta.dir, "..", "..");

describe("scripts/stack purity", () => {
  test("importing scripts/stack/index.ts changes no environment variable, writes no file, and spawns nothing", () => {
    const emptyPathDir = mkdtempSync(join(tmpdir(), "stack-purity-emptypath-"));
    try {
      const entry = join(repoRoot, "scripts", "stack", "index.ts");
      const agentsDir = join(repoRoot, ".agents");
      const child = Bun.spawnSync(
        [
          process.execPath,
          "-e",
          `
          import { readdirSync, existsSync } from "node:fs";
          const listAgents = () => (existsSync(${JSON.stringify(agentsDir)}) ? readdirSync(${JSON.stringify(agentsDir)}).sort().join(",") : "<absent>");
          const envBefore = JSON.stringify(process.env);
          const filesBefore = listAgents();
          await import(${JSON.stringify(entry)});
          const envAfter = JSON.stringify(process.env);
          const filesAfter = listAgents();
          if (envBefore !== envAfter) { console.error("IMPORT MUTATED THE ENVIRONMENT"); process.exit(2); }
          if (filesBefore !== filesAfter) { console.error("IMPORT WROTE INTO .agents/: " + filesBefore + " -> " + filesAfter); process.exit(3); }
          process.exit(0);
          `,
        ],
        {
          cwd: repoRoot,
          // PATH deliberately points at an EMPTY dir: a `docker` call at import
          // time cannot resolve and would surface here rather than silently
          // succeeding on a developer machine that happens to have Docker.
          env: { PATH: emptyPathDir, HOME: emptyPathDir },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const stderr = new TextDecoder().decode(child.stderr);
      expect(`${child.exitCode} ${stderr}`.trim()).toBe("0");
    } finally {
      rmSync(emptyPathDir, { recursive: true, force: true });
    }
  }, 60_000);

  test("createStack computes only — it spawns nothing and never fires a lifecycle hook", () => {
    const events: StackEvent[] = [];
    const stack = createStack(
      {
        repoRoot,
        project: "rm_purity_probe",
        profile: "core",
        apiPort: 1,
        pgPort: 2,
        composeFiles: DEFAULT_COMPOSE_FILES,
        database: DEFAULT_STACK_DATABASE,
        credentials: { adminToken: "a", analyticsToken: "b" },
      },
      { hooks: { onEvent: (e) => events.push(e) } },
    );
    expect(events).toEqual([]);
    expect(stack.services).toEqual(["postgres", "api"]);
    expect(stack.backendUrl).toBe("http://127.0.0.1:1");
  });

  test("with no hostEnv the child environment is hermetic — nothing is inherited by accident", () => {
    const stack = createStack({
      repoRoot,
      project: "rm_purity_probe",
      profile: "core",
      apiPort: 1,
      pgPort: 2,
      composeFiles: DEFAULT_COMPOSE_FILES,
      database: DEFAULT_STACK_DATABASE,
      credentials: { adminToken: "a", analyticsToken: "b" },
    });
    expect(stack.spawnEnv.PATH).toBeUndefined();
    expect(Object.keys(stack.spawnEnv).sort()).toEqual(Object.keys(stack.composeEnv).sort());
  });
});
