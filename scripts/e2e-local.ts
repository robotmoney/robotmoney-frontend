// One-command local reproduction of .github/workflows/e2e.yml's required job
// (Bun TypeScript; it replaces the old bash orchestrator). Skips the
// CI-runner-only provisioning since a dev shell already has it, then runs what
// the workflow gates on: scripts/smoke.ts (which runs smoke-frontend-check,
// Playwright and smoke-live-smoke against the same live providers CI uses).
// Does NOT run the opt-in onboarding real-inference eval.
//
// The funded key is read from the one credential file ($HOME/.env, or
// E2E_LOCAL_ENV_FILE) and handed to the child's environment only: never
// written, never put on a command line.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const PINNED_OPENCODE_VERSION = "1.18.1";

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

// $HOME/.env is `key = value` lines, not shell-sourceable: pull one key.
export function readKey(text: string, key: string): string {
  for (const line of text.split("\n")) {
    const m = line.match(new RegExp(`^${key}\\s*=\\s*(.*)$`));
    if (m) return m[1]!.trim();
  }
  return "";
}

function run(cmd: string[], env: Record<string, string | undefined> = process.env): number {
  const r = Bun.spawnSync(cmd, { cwd: root, env, stdout: "inherit", stderr: "inherit" });
  return r.exitCode ?? 1;
}

if (import.meta.main) {
  const home = process.env.HOME ?? "";
  const envFile = process.env.E2E_LOCAL_ENV_FILE || join(home, ".env");
  if (!existsSync(envFile)) die(`no ${envFile} found: it must define a funded OPENCODE_API_KEY (see .env.example), or set E2E_LOCAL_ENV_FILE`);
  const key = readKey(readFileSync(envFile, "utf8"), "OPENCODE_API_KEY");
  if (!key) die(`OPENCODE_API_KEY is empty in ${envFile}: the live swarm session step will fail loudly without it`);

  const v = Bun.spawnSync(["opencode", "--version"], { stdout: "pipe", stderr: "pipe" });
  if (v.exitCode !== 0) die(`opencode CLI not on PATH: install v${PINNED_OPENCODE_VERSION} (see e2e.yml's 'Install opencode CLI' step)`);
  const local = v.stdout.toString().trim();
  if (local !== PINNED_OPENCODE_VERSION) console.log(`note: local opencode is v${local}, CI pins v${PINNED_OPENCODE_VERSION}: behavior may differ`);

  if (run(["bun", "install", "--frozen-lockfile"]) !== 0) process.exit(1);
  if (run(["bunx", "playwright", "install", "chromium"]) !== 0) process.exit(1);

  // No SMOKE_PROJECT (retired); the boot names its own project and logs it
  // (`project=<name>`) before it creates anything; the teardown reads it back.
  // --local blank --migrate --seed asks for a fresh local stack.
  // --no-env-file: the boot refuses an environment filled from the checkout's .env.
  const runId = Math.floor(Date.now() / 1000);
  const log = `/tmp/rm-e2e-local-${runId}.log`;
  const containerLog = `/tmp/rm-e2e-local-${runId}-containers.log`;
  const child = Bun.spawn(["bun", "--no-env-file", "scripts/smoke.ts", "--local", "blank", "--migrate", "--seed"], {
    cwd: root,
    env: { ...process.env, CI: "true", OPENCODE_API_KEY: key },
    stdout: "pipe",
    stderr: "inherit",
  });
  let out = "";
  const dec = new TextDecoder();
  for await (const chunk of child.stdout) {
    const t = dec.decode(chunk);
    out += t;
    process.stdout.write(t);
  }
  const status = await child.exited;
  await Bun.write(log, out);

  const project = out.match(/project=([A-Za-z0-9_]+)/)?.[1];
  if (!project) {
    console.log("teardown skipped: the boot never logged its project (it refused before creating anything)");
  } else {
    const logs = Bun.spawnSync(["docker", "compose", "-p", project, "--env-file", "/dev/null", "-f", "docker-compose.yml", "logs", "--no-color"], { cwd: root, stdout: "pipe", stderr: "pipe" });
    await Bun.write(containerLog, logs.stdout.toString() + logs.stderr.toString());
    run(["docker", "compose", "-p", project, "--env-file", "/dev/null", "-f", "docker-compose.yml", "down", "-v", "--remove-orphans"]);
    run(["bun", "run", "scripts/smoke-clean.ts", "--project", project], { ...process.env, WEB_PORT: "1", POSTGRES_PORT: "1" });
    console.log(`teardown ${project}`);
  }
  console.log(`combined runtime+test log: ${log}`);
  console.log(`full container logs (api/worker/postgres): ${containerLog}`);
  if (existsSync(join(root, "test-results"))) {
    console.log("playwright failure traces (if any): test-results/ (view with: bunx playwright show-trace <trace.zip>)");
  }
  process.exit(status);
}
