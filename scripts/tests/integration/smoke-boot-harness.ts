// Shared harness for the integration tests that run a REAL `bun smoke` process
// (issue #1026: smoke-lifecycle, smoke-instance-lock, smoke-journal-lifecycle).
//
// Each test gets its own state root (RM_SMOKE_STATE_ROOT, spec §1.1) and its
// own named instance, so it can never read or disturb the operator's standing
// instance or another test's. The boot runs exactly as an operator runs it —
// `bun --no-env-file scripts/smoke.ts --local blank --migrate --instance <name>`
// — with a hermetic environment: no CI and no GitHub Actions identity (either
// would change the instance and project resolution under test), a development
// RM_ENV and a keyless model (no local path calls a model; the inference
// preflight still resolves one), and an explicit empty roster unless a test
// plants one. Docker and bun keep the real HOME so builds hit the host's caches.
//
// Teardown is by the instance's own commands (`smoke:down --instance`, then
// `smoke:clean --project`), so a test also exercises the path an operator uses.
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { instancePaths, readStackState, type InstancePaths } from "../../lib/smoke-state.ts";
import { readJournal, type Journal } from "../../lib/smoke-journal.ts";
import { resolveStackEnvironment, stackProjectName } from "../../stack/naming.ts";

export const repoRoot = join(import.meta.dir, "..", "..", "..");

/** A full boot builds images and waits for health; generous, and still bounded. */
export const BOOT_TIMEOUT_MS = 20 * 60 * 1000;

export interface BootHarness {
  readonly root: string;
  /** Whether this harness made `root` (and so removes it at teardown). */
  readonly ownsRoot: boolean;
  readonly instance: string;
  readonly paths: InstancePaths;
  /** The compose project `bun smoke` derives for this instance (naming.ts, seeded by the instance name). */
  readonly project: string;
  readonly env: Record<string, string>;
  /** An explicit empty roster (§6.1), so the host's ~/.env RM_CREDENTIALS never leaks in. */
  readonly emptyRoster: string;
}

/**
 * A fresh instance. With `opts.root`, the instance shares that state root with
 * another harness (two instances on one host, criterion 33); the root is then
 * the other harness's to remove.
 */
export function harness(prefix: string, opts: { root?: string } = {}): BootHarness {
  const root = opts.root ?? mkdtempSync(join(tmpdir(), `rm-${prefix}-`));
  const instance = `rm_it_${prefix.replace(/[^a-z0-9]/g, "")}_${Math.random().toString(16).slice(2, 8)}`;
  const env: Record<string, string> = { RM_SMOKE_STATE_ROOT: root, RM_ENV: "smoke", AGENT_MODEL: "free" };
  for (const key of ["PATH", "HOME", "TMPDIR", "DOCKER_HOST", "DOCKER_CONFIG", "DOCKER_CONTEXT", "BUN_INSTALL", "BUN_INSTALL_CACHE_DIR"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  const emptyRoster = join(root, `credential-${instance}.json`);
  writeFileSync(emptyRoster, JSON.stringify({ agents: {}, judges: {} }));
  return {
    root,
    ownsRoot: opts.root === undefined,
    instance,
    paths: instancePaths(root, instance),
    project: stackProjectName("stack", resolveStackEnvironment({}, { seed: instance })),
    env,
    emptyRoster,
  };
}

export interface RunningBoot {
  readonly proc: Bun.Subprocess;
  /** Everything the process wrote so far, stdout and stderr interleaved as read. */
  output(): string;
  readonly exited: Promise<number>;
}

/** The argv an operator types, for this harness's instance. */
export function bootArgs(h: BootHarness, extra: readonly string[] = [], local = "blank"): string[] {
  return ["bun", "--no-env-file", "scripts/smoke.ts", "--local", local, "--migrate", "--instance", h.instance, ...extra];
}

/**
 * Start `bun smoke`. With `tty`, it runs under `script(1)`, so its stdout IS a
 * terminal — the case criterion 26 is about. Without, `proc.pid` is the smoke
 * process itself, which is what the lock and signal tests need.
 */
export function spawnBoot(h: BootHarness, extra: readonly string[] = [], opts: { tty?: boolean; local?: string } = {}): RunningBoot {
  const argv = bootArgs(h, extra.length > 0 ? extra : ["--credentials", h.emptyRoster], opts.local);
  const cmd = opts.tty ? ["script", "-qfec", argv.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" "), "/dev/null"] : argv;
  const proc = Bun.spawn(cmd, { cwd: repoRoot, env: h.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let text = "";
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) text += decoder.decode(chunk, { stream: true });
  };
  const pumps = Promise.all([pump(proc.stdout as ReadableStream<Uint8Array>), pump(proc.stderr as ReadableStream<Uint8Array>)]);
  const exited = (async () => {
    const code = await proc.exited;
    await pumps;
    return code;
  })();
  return { proc, output: () => text, exited };
}

/** Run one of the instance's lifecycle commands (`smoke:status`, `smoke:tui`, `smoke:down`) as its own process. */
export function runCommand(h: BootHarness, script: string, args: readonly string[]): { code: number; out: string } {
  const r = Bun.spawnSync(["bun", "--no-env-file", join("scripts", script), ...args], {
    cwd: repoRoot,
    env: h.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: r.exitCode ?? -1, out: `${r.stdout.toString()}${r.stderr.toString()}` };
}

export async function waitFor(check: () => boolean, timeoutMs: number, what: string, boot?: RunningBoot): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await Bun.sleep(150);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}${boot ? `; boot output tail:\n${boot.output().slice(-3000)}` : ""}`);
}

/** The journal on disk, or null while none exists (tolerating a write in flight). */
export function journalNow(h: BootHarness): Journal | null {
  try {
    return readJournal(h.paths);
  } catch {
    return null;
  }
}

export function phaseList(journal: Journal | null): Array<[string, string | null, string]> {
  return (journal?.phases ?? []).map((r) => [r.phase, r.step, r.status]);
}

/** Containers of the project, by compose service, with their state (`running`, `restarting`, `exited`…). */
export function projectContainers(project: string): Record<string, string> {
  const r = Bun.spawnSync(
    ["docker", "ps", "-a", "--filter", `label=com.docker.compose.project=${project}`, "--filter", "label=com.docker.compose.oneoff=False",
      "--format", '{{.Label "com.docker.compose.service"}}\t{{.State}}'],
    { stdout: "pipe", stderr: "pipe" },
  );
  const out: Record<string, string> = {};
  for (const line of r.stdout.toString().split("\n")) {
    const [service = "", state = ""] = line.trim().split("\t");
    if (service) out[service] = state;
  }
  return out;
}

/** One environment variable of a running service's container, read from Docker. */
export function containerEnv(project: string, service: string, key: string): string | undefined {
  const id = Bun.spawnSync(
    ["docker", "ps", "-q", "--filter", `label=com.docker.compose.project=${project}`, "--filter", `label=com.docker.compose.service=${service}`],
    { stdout: "pipe" },
  ).stdout.toString().trim().split("\n")[0];
  if (!id) return undefined;
  const env = Bun.spawnSync(["docker", "inspect", "--format", "{{json .Config.Env}}", id], { stdout: "pipe" }).stdout.toString();
  const entry = (JSON.parse(env || "[]") as string[]).find((e) => e.startsWith(`${key}=`));
  return entry?.slice(key.length + 1);
}

/** Every path under `dir`, relative, sorted; `[]` when it does not exist. */
export function listTree(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    let names: string[];
    try {
      names = readdirSync(join(dir, rel));
    } catch {
      return;
    }
    for (const name of names) {
      const path = rel ? join(rel, name) : name;
      out.push(`${path}@${statSync(join(dir, path)).mtimeMs}`);
      if (statSync(join(dir, path)).isDirectory()) walk(path);
    }
  };
  walk("");
  return out.sort();
}

/**
 * Stop and reclaim everything this harness's instance brought up: its stack
 * through `smoke:down --instance`, its volume through `smoke:clean --project`,
 * and a `docker compose down -v` backstop for a boot killed before it wrote a
 * stack record. Never throws: a teardown must not mask the test's own failure.
 */
export function teardown(h: BootHarness, boot?: RunningBoot): void {
  try { boot?.proc.kill("SIGKILL"); } catch { /* already gone */ }
  try {
    if (readStackState(h.paths) !== null) runCommand(h, "smoke-down.ts", ["--instance", h.instance]);
  } catch { /* backstop below */ }
  Bun.spawnSync(
    ["docker", "compose", "--env-file", "/dev/null", "-p", h.project, "-f", "docker-compose.yml", "-f", "docker-compose.smoke.yml", "down", "-v", "--remove-orphans"],
    { cwd: repoRoot, env: { ...h.env, RM_INSTANCE: h.instance, RM_INSTANCE_STATE_DIR: h.paths.dir, SMOKE_PROJECT: h.project, RM_STACK_ENV_CLASS: "local", RM_STACK_ENV_HASH: "teardown" }, stdout: "ignore", stderr: "ignore" },
  );
  Bun.spawnSync(["bun", "--no-env-file", "scripts/smoke-clean.ts", "--project", h.project], { cwd: repoRoot, env: h.env, stdout: "ignore", stderr: "ignore" });
  if (h.ownsRoot) rmSync(h.root, { recursive: true, force: true });
  else rmSync(h.paths.dir, { recursive: true, force: true });
}

/**
 * Each container of `project` with its id, state and start time: what
 * "untouched" means for another instance's stack. A container that was
 * recreated has a new id; one that was restarted has a new start time.
 */
export function containerIdentity(project: string): Record<string, { id: string; state: string; startedAt: string }> {
  const ids = Bun.spawnSync(
    ["docker", "ps", "-aq", "--filter", `label=com.docker.compose.project=${project}`, "--filter", "label=com.docker.compose.oneoff=False"],
    { stdout: "pipe", stderr: "pipe" },
  ).stdout.toString().split("\n").map((l) => l.trim()).filter(Boolean);
  if (ids.length === 0) return {};
  const out: Record<string, { id: string; state: string; startedAt: string }> = {};
  const inspect = Bun.spawnSync(
    ["docker", "inspect", "--format", '{{index .Config.Labels "com.docker.compose.service"}}\t{{.Id}}\t{{.State.Status}}\t{{.State.StartedAt}}', ...ids],
    { stdout: "pipe", stderr: "pipe" },
  ).stdout.toString();
  for (const line of inspect.split("\n")) {
    const [service = "", id = "", state = "", startedAt = ""] = line.trim().split("\t");
    if (service) out[service] = { id, state, startedAt };
  }
  return out;
}

/** Whether a Docker volume exists. */
export function volumeExists(name: string): boolean {
  return Bun.spawnSync(["docker", "volume", "inspect", name], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
}
