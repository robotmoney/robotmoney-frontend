import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_STACK_DATABASE,
  createStack,
  type StackConfig,
} from "../../stack/index.ts";

const cleanup: string[] = [];
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("shared full-stack member-agent prebuild", () => {
  test("finishes one image build before concurrent one-shot member containers launch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rm-stack-prebuild-"));
    cleanup.push(dir);
    const logPath = join(dir, "docker.log");
    const tokenPath = join(dir, "analytics-token");
    writeFileSync(tokenPath, "test-token\n", { mode: 0o600 });

    const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    try {
      const dockerPath = join(dir, "docker");
      writeFileSync(
        dockerPath,
        `#!/bin/sh\nprintf '%s\\n' "$*" >> '${logPath}'\ncase "$*" in\n  *" port api 8787") printf '0.0.0.0:${server.port}\\n' ;;\nesac\nexit 0\n`,
        { mode: 0o755 },
      );
      chmodSync(dockerPath, 0o755);

      // `up()` assembles the prerendered STATIC_DIR before it touches Docker,
      // so this fake repo root needs the script that step runs. Without it the
      // bring-up aborts at exit 127 and never reaches the prebuild ordering
      // this test is about. A no-op stub is the right fidelity: static assembly
      // has its own coverage, and mattering here would make this test fail for
      // a reason that has nothing to do with member-agent prebuild.
      mkdirSync(join(dir, "scripts"), { recursive: true });
      writeFileSync(join(dir, "scripts", "static-assembly.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      chmodSync(join(dir, "scripts", "static-assembly.sh"), 0o755);

      const cfg: StackConfig = {
        repoRoot: dir,
        project: "rm_ci_stack_prebuild",
        profile: "full",
        composeFiles: ["docker-compose.yml", "docker-compose.smoke.yml"],
        database: { ...DEFAULT_STACK_DATABASE, url: "postgres://managed.example/db" },
        credentials: {
          adminToken: "admin",
          automationToken: "automation",
          analyticsToken: "analytics",
          analyticsTokenFile: tokenPath,
        },
        environment: { class: "ci", hash: "prebuild00" },
      };
      const stack = createStack(cfg, { hostEnv: { PATH: `${dir}:/usr/bin:/bin` } });

      // `up()` is the shared barrier used by normal smoke and smoke. Only after
      // it resolves may runSession fan out its member containers.
      await stack.up({ healthTimeoutMs: 1_000 });
      await Promise.all(
        ["athena", "robotmoney", "woon"].map((member) =>
          stack.composeAsync(
            ["run", "--rm", "--no-deps", "--name", `member-${member}`, "member-agent", "true"],
            `member ${member}`,
          )
        ),
      );

      const commands = readFileSync(logPath, "utf8").trim().split("\n");
      const buildCommands = commands.filter((line) => line.includes(" build "));
      expect(buildCommands).toHaveLength(1);
      expect(buildCommands[0]!.split(" ").filter((part) => part === "member-agent")).toHaveLength(1);

      const memberRuns = commands.filter((line) => line.includes(" run ") && line.includes(" member-agent "));
      expect(memberRuns).toHaveLength(3);
      expect(commands.indexOf(buildCommands[0]!)).toBeLessThan(
        Math.min(...memberRuns.map((line) => commands.indexOf(line))),
      );
      for (const run of memberRuns) expect(run).not.toContain("--build");
    } finally {
      server.stop(true);
    }
  });
});
