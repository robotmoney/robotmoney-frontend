// The ONE compose bring-up shared by the demo (`full` profile), the
// inference-off rails check, and the onboarding eval (`core` profile) —
// docs/decisions.md D22 "shared components", docs/architecture.md §11.3 E5.
//
// A thin IMPURE shell over scripts/stack/config.ts's pure builders. Nothing
// runs on import: `createStack()` only computes an env map and some argv, it
// spawns nothing, opens nothing, and touches no global. The caller passes its
// own host environment explicitly (`hostEnv`) — this module never reads it —
// and only the allowlisted docker-client plumbing survives into a child.
//
// Loud-skip-never (docs/skills/_shared/test-coverage-policy.md, D22 §11.3 E2):
// `assertDockerAvailable()` returns void or THROWS. There is deliberately no
// boolean, no "available?" predicate, and no option — no shape a caller could
// turn into a conditional skip.
import {
  buildArgs,
  buildComposeEnv,
  buildSpawnEnv,
  composeArgs,
  downArgs,
  hostBackendUrl,
  internalDatabaseUrl,
  migrateArgs,
  pgReadyArgs,
  servicesFor,
  upArgs,
  type StackConfig,
} from "./config.ts";

export type StackPhase = "docker-preflight" | "build" | "postgres" | "migrate" | "services" | "health";

export type StackEvent =
  | { phase: StackPhase; status: "start" | "done"; detail?: string }
  | { phase: "log"; message: string };

// How a consumer renders progress WITHOUT this module importing its renderer:
// scripts/lib/demo-main.ts maps these events onto its TUI panes; a test passes
// nothing at all.
export interface StackHooks {
  onEvent?(e: StackEvent): void;
}

export interface StackIo {
  stdout?: number | "inherit" | "pipe" | "ignore";
  stderr?: number | "inherit" | "pipe" | "ignore";
}

export interface ComposeResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface StackUpOptions {
  // Extra `-e KEY=VALUE` pairs for the one-shot migrate container.
  migrateEnv?: Record<string, string>;
  pgTimeoutMs?: number;
  healthTimeoutMs?: number;
}

export interface Stack {
  readonly config: StackConfig;
  readonly composeEnv: Record<string, string>;
  readonly spawnEnv: Record<string, string>;
  readonly backendUrl: string;
  readonly databaseUrl: string;
  readonly services: string[];
  compose(args: string[], io?: StackIo): ComposeResult;
  composeAsync(args: string[], label: string, io?: StackIo): Promise<void>;
  assertDockerAvailable(): void;
  build(services?: string[]): Promise<void>;
  waitForPostgres(timeoutMs?: number): Promise<void>;
  waitForHttp(url: string, timeoutMs?: number): Promise<void>;
  migrate(extraEnv?: Record<string, string>): Promise<void>;
  up(opts?: StackUpOptions): Promise<void>;
  down(opts?: { removeVolumes?: boolean; removeOrphans?: boolean }): ComposeResult;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function decode(buf: unknown): string {
  return buf instanceof Uint8Array ? new TextDecoder().decode(buf) : "";
}

export function createStack(
  cfg: StackConfig,
  opts: { hostEnv?: Record<string, string | undefined>; io?: StackIo; hooks?: StackHooks } = {},
): Stack {
  // `hostEnv` defaults to EMPTY on purpose: an explicit caller passes its own
  // environment, and a caller that forgets gets a hermetic child rather than a
  // silently inherited one.
  const hostEnv = opts.hostEnv ?? {};
  const defaultIo: StackIo = opts.io ?? { stdout: "pipe", stderr: "pipe" };
  const emit = (e: StackEvent) => opts.hooks?.onEvent?.(e);

  const composeEnv = buildComposeEnv(cfg);
  const spawnEnv = buildSpawnEnv(cfg, hostEnv);
  const backendUrl = hostBackendUrl(cfg.apiPort);
  const databaseUrl = internalDatabaseUrl(cfg.database);
  const services = servicesFor(cfg.profile);
  const prefix = composeArgs(cfg.project, cfg.composeFiles);

  function compose(args: string[], io: StackIo = defaultIo): ComposeResult {
    const r = Bun.spawnSync(["docker", ...prefix, ...args], {
      cwd: cfg.repoRoot,
      env: spawnEnv,
      stdout: (io.stdout ?? "pipe") as "pipe",
      stderr: (io.stderr ?? "pipe") as "pipe",
    });
    return { exitCode: r.exitCode ?? -1, stdout: decode(r.stdout), stderr: decode(r.stderr) };
  }

  async function composeAsync(args: string[], label: string, io: StackIo = defaultIo): Promise<void> {
    const proc = Bun.spawn(["docker", ...prefix, ...args], {
      cwd: cfg.repoRoot,
      env: spawnEnv,
      stdout: (io.stdout ?? "pipe") as "pipe",
      stderr: (io.stderr ?? "pipe") as "pipe",
    });
    const code = await proc.exited;
    if (code !== 0) throw new Error(`${label} failed (exit ${code})`);
  }

  function assertDockerAvailable(): void {
    emit({ phase: "docker-preflight", status: "start" });
    const r = Bun.spawnSync(["docker", "version"], {
      cwd: cfg.repoRoot,
      env: spawnEnv,
      stdout: "ignore",
      stderr: "pipe",
    });
    if (r.exitCode !== 0) {
      throw new Error(
        `docker is required for this stack bring-up and is not usable in this environment ` +
          `(exit ${r.exitCode}: ${decode(r.stderr)})`,
      );
    }
    emit({ phase: "docker-preflight", status: "done" });
  }

  async function build(buildServices: string[] = services): Promise<void> {
    emit({ phase: "build", status: "start", detail: buildServices.join(", ") });
    await composeAsync(buildArgs(buildServices), `compose build ${buildServices.join(" ")}`.trim());
    emit({ phase: "build", status: "done", detail: buildServices.join(", ") });
  }

  async function waitForPostgres(timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      // Health poll fires every second — keep it quiet (never on the console).
      const r = compose(pgReadyArgs(cfg.database), { stdout: "ignore", stderr: "ignore" });
      if (r.exitCode === 0) return;
      await sleep(1000);
    }
    throw new Error("postgres did not become ready in time");
  }

  async function waitForHttp(url: string, timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastErr: unknown;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(url);
        if (r.ok) return;
        lastErr = new Error(`${url} -> ${r.status}`);
      } catch (e) {
        lastErr = e;
      }
      await sleep(500);
    }
    throw new Error(`timed out waiting for ${url}: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
  }

  async function migrate(extraEnv: Record<string, string> = {}): Promise<void> {
    emit({ phase: "migrate", status: "start" });
    await composeAsync(migrateArgs(extraEnv), "migrations");
    emit({ phase: "migrate", status: "done" });
  }

  async function up(upOpts: StackUpOptions = {}): Promise<void> {
    assertDockerAvailable();
    await build();

    emit({ phase: "postgres", status: "start" });
    await composeAsync(upArgs(["postgres"]), "start postgres");
    await waitForPostgres(upOpts.pgTimeoutMs);
    emit({ phase: "postgres", status: "done" });

    await migrate(upOpts.migrateEnv);

    // Named explicitly from the profile — never a bare `docker compose up -d` —
    // so a compose service added later can never leak into `core`.
    const rest = services.filter((s) => s !== "postgres");
    emit({ phase: "services", status: "start", detail: rest.join(", ") });
    await composeAsync(upArgs(rest), "start services");
    emit({ phase: "services", status: "done", detail: rest.join(", ") });

    emit({ phase: "health", status: "start" });
    await waitForHttp(`${backendUrl}/health`, upOpts.healthTimeoutMs ?? 60_000);
    emit({ phase: "health", status: "done" });
  }

  // Returns the raw result so callers keep their own loud logging — teardown
  // failures must never be swallowed, and must never mask an earlier failure
  // by throwing over it.
  function down(downOpts: { removeVolumes?: boolean; removeOrphans?: boolean } = {}): ComposeResult {
    return compose(downArgs(downOpts));
  }

  return {
    config: cfg,
    composeEnv,
    spawnEnv,
    backendUrl,
    databaseUrl,
    services,
    compose,
    composeAsync,
    assertDockerAvailable,
    build,
    waitForPostgres,
    waitForHttp,
    migrate,
    up,
    down,
  };
}
