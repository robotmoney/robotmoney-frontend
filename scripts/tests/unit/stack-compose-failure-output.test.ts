// Issue #1040: a failed `compose build member-agent` used to throw only
// "member-agent failed (exit 1)". The docker child's stdout/stderr were piped
// and never read, so nobody could tell which download failed, and a large
// build could stall on a full pipe. These tests drive the REAL default runtime
// against a fake `docker` on PATH.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_STACK_DATABASE,
  createStack,
  type StackConfig,
  type StackEvent,
  type StackRuntime,
} from "../../stack/index.ts";

const cleanup: string[] = [];
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

/** A fake repo root with a `docker` shim that prints 5000 numbered lines to stderr. */
function fixture(exitCode: number, staticAssembly = "#!/bin/sh\nexit 0\n") {
  const dir = mkdtempSync(join(tmpdir(), "rm-stack-failout-"));
  cleanup.push(dir);
  const dockerPath = join(dir, "docker");
  writeFileSync(
    dockerPath,
    `#!/bin/sh\ncase "$1" in version) exit 0 ;; esac\ni=1\nwhile [ $i -le 5000 ]; do echo "line $i" >&2; i=$((i+1)); done\nexit ${exitCode}\n`,
    { mode: 0o755 },
  );
  chmodSync(dockerPath, 0o755);
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(join(dir, "scripts", "static-assembly.sh"), staticAssembly, { mode: 0o755 });
  const cfg: StackConfig = {
    repoRoot: dir,
    project: "rm_ci_failout",
    profile: "full",
    composeFiles: ["docker-compose.yml"],
    database: { ...DEFAULT_STACK_DATABASE, url: "postgres://managed.example/db" },
    environment: { class: "ci", hash: "failout000" },
  };
  return { dir, cfg, hostEnv: { PATH: `${dir}:/usr/bin:/bin` } };
}

describe("compose failure output (issue #1040)", () => {
  test("a failing 5000-line build rejects with the exit code and the tail, bounded, never the head", async () => {
    const { cfg, hostEnv } = fixture(1);
    const stack = createStack(cfg, { hostEnv });
    const err = await stack.build(["member-agent"]).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain("compose build member-agent failed (exit 1)");
    expect(err!.message).toContain("line 5000");
    expect(err!.message).not.toContain("line 1\n");
    expect(err!.message).not.toContain("line 4800");
    expect(Buffer.byteLength(err!.message)).toBeLessThan(40_000);
  }, 20_000);

  test("a succeeding 5000-line build resolves without hanging, and no log event carries its output", async () => {
    const { cfg, hostEnv } = fixture(0);
    const events: StackEvent[] = [];
    const stack = createStack(cfg, { hostEnv, hooks: { onEvent: (e) => events.push(e) } });
    await stack.build(["member-agent"]);
    expect(JSON.stringify(events)).not.toContain("line 5000");
  }, 20_000);

  test("an injected runtime's outputTail lands in the thrown error", async () => {
    const { cfg } = fixture(0);
    const runtime: StackRuntime = {
      runSync: () => ({ exitCode: 0, stdout: "", stderr: "" }),
      run: async () => ({ exitCode: 2, outputTail: "E: Unable to fetch" }),
      probe: async () => ({ ok: true, detail: "ok" }),
    };
    const stack = createStack(cfg, { runtime });
    await expect(stack.composeAsync(["build", "member-agent"], "compose build member-agent")).rejects.toThrow(
      /failed \(exit 2\)[\s\S]*E: Unable to fetch/,
    );
  });

  test("a failing static-assembly.sh surfaces its stderr in up()'s rejection", async () => {
    const { cfg, hostEnv } = fixture(0, "#!/bin/sh\necho 'prerender exploded: ENOENT seo.js' >&2\nexit 7\n");
    const stack = createStack(cfg, { hostEnv });
    await expect(stack.up({ healthTimeoutMs: 1_000 })).rejects.toThrow(
      /static assembly failed[\s\S]*exited 7[\s\S]*prerender exploded: ENOENT seo\.js/,
    );
  }, 20_000);
});
