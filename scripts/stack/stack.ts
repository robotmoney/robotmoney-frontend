// The ONE compose bring-up — docs/decisions.md D22 "shared components",
// docs/architecture.md §11.3 E5.
//
// The demo consumes it TODAY (`full` profile, scripts/lib/demo-main.ts): its
// hand-rolled runCompose/waitForPostgres/waitForHttp are gone, not parallel, so
// `bun demo` boots through this file and nothing else. The onboarding eval and
// the inference-off rails check (whose forked bringUpInfra() this replaces)
// adopt the `core` profile next; until they do, the demo is the single runtime
// judge of this module. The StackHooks event surface below is how the demo
// drives its TUI panes without this module importing a renderer.
//
// A thin IMPURE shell over scripts/stack/config.ts's pure builders. Nothing
// runs on import: `createStack()` only computes an env map and some argv, it
// spawns nothing, opens nothing, and touches no global. The caller passes its
// own host environment explicitly (`hostEnv`) — this module never reads it —
// and only the allowlisted docker-client plumbing survives into a child.
//
// Loud-skip-never (test-coverage-policy, docs/architecture.md §11.3 E2):
// `assertDockerAvailable()` returns void or THROWS. There is deliberately no
// boolean, no "available?" predicate, and no option — no shape a caller could
// turn into a conditional skip.
import {
  API_CONTAINER_PORT,
  buildArgs,
  buildComposeEnv,
  buildSpawnEnv,
  composeArgs,
  downArgs,
  hostBackendUrl,
  internalDatabaseUrl,
  migrateArgs,
  pgReadyArgs,
  portArgs,
  POSTGRES_CONTAINER_PORT,
  servicesFor,
  upArgs,
  type StackConfig,
  type StackHostPorts,
} from "./config.ts";
import { parseComposePortOutput, PortDiscoveryError } from "./ports.ts";
import { readFileSync } from "node:fs";

export type StackPhase = "docker-preflight" | "build" | "postgres" | "migrate" | "services" | "ports" | "health";

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
  /**
   * `http://127.0.0.1:<the host port Docker gave api>`. A GETTER, not a value
   * fixed at construction: the port does not exist until the container is
   * running, so reading this before `up()` (or before an explicit
   * `hostPorts()`) THROWS rather than handing back a plausible-looking URL
   * built from a number nobody assigned.
   */
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
  /** Ask the daemon which host port it published one container port on. */
  publishedPort(service: string, containerPort: number): number;
  /** Both stack ports, queried live and then cached for this handle. */
  hostPorts(): StackHostPorts;
  up(opts?: StackUpOptions): Promise<StackHostPorts>;
  down(opts?: { removeVolumes?: boolean; removeOrphans?: boolean }): ComposeResult;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A full stack starts the independent analytics producer, so its Docker-secret
 * source must exist and contain a credential before Docker does any work.
 * Core/status/down operations deliberately do not have this requirement.
 */
export function assertFullStackProducerCredential(cfg: StackConfig): void {
  if (cfg.profile !== "full") return;
  const file = cfg.credentials.analyticsTokenFile;
  if (!file) {
    throw new Error("full stack profile requires credentials.analyticsTokenFile for the independent analytics producer");
  }
  let value: string;
  try {
    value = readFileSync(file, "utf8").trim();
  } catch (error) {
    throw new Error(
      `full stack analytics producer credential file is not readable: ${file} (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (!value) throw new Error(`full stack analytics producer credential file is empty: ${file}`);
}

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
  const databaseUrl = internalDatabaseUrl(cfg.database);
  // Discovered by hostPorts() after the containers are running, then reused.
  // `undefined` is the honest state before that: this module has no other way
  // to know a number Docker has not yet chosen.
  let discovered: StackHostPorts | undefined;
  const services = servicesFor(cfg.profile);
  const prefix = composeArgs(cfg.project, cfg.composeFiles);

  // NON-INTERACTIVE, ALWAYS. `docker compose` has questions it will ask on a
  // terminal — the volume-recreate confirmation most of all, which blocks
  // forever waiting for an answer and DELETES a live database if it gets a
  // "yes". Nothing on this path has an operator behind it, so stdin is closed
  // on every compose child and a question can only ever be declined at once.
  // (compose 2.40.3 exposes no `--yes`/`--non-interactive` flag for `run`;
  // closing stdin IS the supported mechanism.)
  function compose(args: string[], io: StackIo = defaultIo): ComposeResult {
    const r = Bun.spawnSync(["docker", ...prefix, ...args], {
      cwd: cfg.repoRoot,
      env: spawnEnv,
      stdin: "ignore",
      stdout: (io.stdout ?? "pipe") as "pipe",
      stderr: (io.stderr ?? "pipe") as "pipe",
    });
    return { exitCode: r.exitCode ?? -1, stdout: decode(r.stdout), stderr: decode(r.stderr) };
  }

  async function composeAsync(args: string[], label: string, io: StackIo = defaultIo): Promise<void> {
    const proc = Bun.spawn(["docker", ...prefix, ...args], {
      cwd: cfg.repoRoot,
      env: spawnEnv,
      stdin: "ignore",
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
      stdin: "ignore",
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

  // ── Host-port readback ────────────────────────────────────────────────────
  // The compose files publish CONTAINER ports only, so the daemon picks the
  // host side and binds it atomically — no window in which someone else can
  // take a number we already handed to compose (scripts/stack/ports.ts's header
  // has the full TOCTOU rationale). The price is that the number is unknown
  // until the container exists, and this is where we pay it: ask the daemon.
  function publishedPort(service: string, containerPort: number): number {
    const r = compose(portArgs(service, containerPort), { stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) {
      throw new PortDiscoveryError(
        service,
        containerPort,
        r.stdout,
        `\`docker compose port\` exited ${r.exitCode}: ${r.stderr.trim() || "(no stderr)"}`,
      );
    }
    return parseComposePortOutput(r.stdout, service, containerPort);
  }

  // Cached per handle: within one process the containers do not move, and
  // demo-main asks for the api port on several code paths. A stale cache is
  // impossible for the same reason — a `down` invalidates the handle, not the
  // number. Callers that must not trust a cache (demo:status, whose state file
  // CAN be stale across processes) query publishedPort() themselves.
  function hostPorts(): StackHostPorts {
    if (discovered) return discovered;
    discovered = {
      apiPort: publishedPort("api", API_CONTAINER_PORT),
      pgPort: publishedPort("postgres", POSTGRES_CONTAINER_PORT),
    };
    return discovered;
  }

  function currentBackendUrl(): string {
    if (!discovered) {
      throw new Error(
        "stack.backendUrl was read before the host port was discovered — Docker assigns it when the " +
          "api container starts, so call up() (or hostPorts()) first",
      );
    }
    return hostBackendUrl(discovered.apiPort);
  }

  async function up(upOpts: StackUpOptions = {}): Promise<StackHostPorts> {
    assertFullStackProducerCredential(cfg);
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

    // Only NOW do the host ports exist. Everything downstream — the health
    // check below, the caller's READY banner, its state file — takes them from
    // here, so there is exactly one place in the system that knows a host port
    // and it learned it from the daemon.
    emit({ phase: "ports", status: "start" });
    const ports = hostPorts();
    emit({ phase: "ports", status: "done", detail: `api=:${ports.apiPort} pg=:${ports.pgPort}` });

    emit({ phase: "health", status: "start" });
    await waitForHttp(`${hostBackendUrl(ports.apiPort)}/health`, upOpts.healthTimeoutMs ?? 60_000);
    emit({ phase: "health", status: "done" });
    return ports;
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
    // A getter so `stack.backendUrl` stays a plain property read at every call
    // site while still reflecting a port that is only known after up().
    get backendUrl() {
      return currentBackendUrl();
    },
    databaseUrl,
    services,
    compose,
    composeAsync,
    assertDockerAvailable,
    build,
    waitForPostgres,
    waitForHttp,
    migrate,
    publishedPort,
    hostPorts,
    up,
    down,
  };
}
