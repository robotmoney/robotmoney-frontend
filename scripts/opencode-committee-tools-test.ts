import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");
const composeFile = join(repoRoot, "mcp", "tests", "opencode-tools", "compose.yml");
const project = `rm_opencode_tools_${crypto.randomUUID().slice(0, 8)}`;

async function compose(args: string[], stdout: "inherit" | "pipe" = "inherit") {
  const proc = Bun.spawn(["docker", "compose", "--ansi", "never", "-p", project, "-f", composeFile, ...args], {
    cwd: repoRoot,
    env: { ...process.env, BUILDKIT_PROGRESS: "plain", COMPOSE_PROGRESS: "plain" },
    stdout,
    stderr: "inherit",
  });
  const exitCode = await proc.exited;
  return { exitCode, stdout: stdout === "pipe" ? await new Response(proc.stdout).text() : "" };
}

try {
  const run = await compose(["up", "--build", "--abort-on-container-exit", "--exit-code-from", "agent", "agent"]);
  if (run.exitCode !== 0) {
    const logs = await compose(["logs", "--no-color", "fixture-backend", "mcp", "agent"], "pipe");
    if (logs.stdout) process.stderr.write(logs.stdout);
    throw new Error(`OpenCode committee-tools test exited ${run.exitCode}`);
  }
  console.log("OpenCode committee MCP tools test passed");
} finally {
  await compose(["down", "--volumes", "--remove-orphans"]);
}

