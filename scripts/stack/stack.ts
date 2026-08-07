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
  buildServicesFor,
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
import { join } from "node:path";

export type StackPhase = "docker-preflight" | "build" | "postgres" | "migrate" | "services" | "ports" | "health" | "initialize";

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
  migrateScriptArgs?: string[];
  /**
   * Last chance to refuse BEFORE anything is written.
   *
   * Runs after build() and the postgres phase — so images exist and the server
   * is reachable — but before migrate(), which is the first step that writes.
   * Throwing here aborts the boot with nothing committed. Deliberately NOT a
   * new StackPhase: the phase sequence is pinned by
   * scripts/tests/unit/stack-lifecycle-order.test.ts and this is a guard, not a
   * stage of bring-up.
   */
  preflight?: () => Promise<void>;
  /** Scenario-specific initialization after services start but before the
   * stack is declared ready. Migration remains owned by this method exactly once. */
  initialize?: () => Promise<void>;
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
  migrate(extraEnv?: Record<string, string>, scriptArgs?: string[]): Promise<void>;
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

/**
 * The three ways this module touches anything outside its own process: it runs
 * a docker CLI synchronously, it runs one to completion, and it probes an HTTP
 * URL. Everything else here is argv construction and sequencing.
 *
 * It is injectable so `up()`'s PHASE ORDERING can be asserted by executing it
 * rather than by reading this file's source. That distinction is the whole
 * point: an ordering guarantee is runtime behaviour, and the byte offsets of
 * the statements that produce it are not evidence about it — scenario
 * initialization is passed to `up()` as a callback, so the correct order is
 * written "out of order" in the source and a text scan reports a healthy boot
 * as broken. See scripts/tests/unit/stack-lifecycle-order.test.ts.
 */
export interface StackRuntime {
  runSync(argv: string[], io: StackIo): ComposeResult;
  run(argv: string[], io: StackIo): Promise<number>;
  probe(url: string): Promise<{ ok: boolean; detail: string }>;
}

export function createStack(
  cfg: StackConfig,
  opts: {
    hostEnv?: Record<string, string | undefined>;
    io?: StackIo;
    hooks?: StackHooks;
    runtime?: StackRuntime;
  } = {},
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
  // An external managed Postgres (cfg.database.url) means there is no postgres
  // container in this stack at all: it is not in `services`, it is not started,
  // it is not waited on, and it publishes no host port.
  const externalPostgres = Boolean(cfg.database.url);
  const services = servicesFor(cfg.profile, { externalPostgres });
  // A full stack runs member sessions after bring-up. `member-agent` is a
  // one-shot, profile-gated service (never part of `services` / `up`), but its
  // image must exist before those concurrent session containers launch. Keep
  // that prebuild in the shared stack lifecycle used by both demo and smoke.
  const defaultBuildServices = buildServicesFor(cfg.profile, { externalPostgres });
  const prefix = composeArgs(cfg.project, cfg.composeFiles);

  // NON-INTERACTIVE, ALWAYS. `docker compose` has questions it will ask on a
  // terminal — the volume-recreate confirmation most of all, which blocks
  // forever waiting for an answer and DELETES a live database if it gets a
  // "yes". Nothing on this path has an operator behind it, so stdin is closed
  // on every compose child and a question can only ever be declined at once.
  // (compose 2.40.3 exposes no `--yes`/`--non-interactive` flag for `run`;
  // closing stdin IS the supported mechanism.)
  // The default runtime IS the previous inline bodies, verbatim — spawning
  // `docker` from cfg.repoRoot with the allowlisted spawnEnv and a closed
  // stdin. A caller that passes nothing gets exactly the behaviour this module
  // has always had.
  const runtime: StackRuntime = opts.runtime ?? {
    runSync(argv, io) {
      const r = Bun.spawnSync(argv, {
        cwd: cfg.repoRoot,
        env: spawnEnv,
        stdin: "ignore",
        stdout: (io.stdout ?? "pipe") as "pipe",
        stderr: (io.stderr ?? "pipe") as "pipe",
      });
      return { exitCode: r.exitCode ?? -1, stdout: decode(r.stdout), stderr: decode(r.stderr) };
    },
    async run(argv, io) {
      const proc = Bun.spawn(argv, {
        cwd: cfg.repoRoot,
        env: spawnEnv,
        stdin: "ignore",
        stdout: (io.stdout ?? "pipe") as "pipe",
        stderr: (io.stderr ?? "pipe") as "pipe",
      });
      return (await proc.exited) ?? -1;
    },
    async probe(url) {
      try {
        const r = await fetch(url);
        return { ok: r.ok, detail: `${url} -> ${r.status}` };
      } catch (e) {
        return { ok: false, detail: e instanceof Error ? e.message : String(e) };
      }
    },
  };

  function compose(args: string[], io: StackIo = defaultIo): ComposeResult {
    return runtime.runSync(["docker", ...prefix, ...args], io);
  }

  async function composeAsync(args: string[], label: string, io: StackIo = defaultIo): Promise<void> {
    const code = await runtime.run(["docker", ...prefix, ...args], io);
    if (code !== 0) throw new Error(`${label} failed (exit ${code})`);
  }

  function assertDockerAvailable(): void {
    emit({ phase: "docker-preflight", status: "start" });
    const r = runtime.runSync(["docker", "version"], { stdout: "ignore", stderr: "pipe" });
    if (r.exitCode !== 0) {
      throw new Error(
        `docker is required for this stack bring-up and is not usable in this environment ` +
          `(exit ${r.exitCode}: ${decode(r.stderr)})`,
      );
    }
    emit({ phase: "docker-preflight", status: "done" });
  }

  async function build(buildServices: string[] = defaultBuildServices): Promise<void> {
    emit({ phase: "build", status: "start", detail: buildServices.join(", ") });
    await composeAsync(buildArgs(buildServices), `compose build ${buildServices.join(" ")}`.trim());
    emit({ phase: "build", status: "done", detail: buildServices.join(", ") });
  }

  // The api's STATIC_DIR is a bind mount of `_static` (docker-compose.yml), and
  // `_static` is a BUILD OUTPUT: frontend/public plus the per-route prerendered
  // HTML scripts/prerender.ts writes from seo.js's table (issue #480,
  // docs/decisions.md D29). Nothing else in the bring-up produces it, and a
  // bind path that does not exist makes Docker create an EMPTY directory — the
  // api would then serve nothing at all, which is why this runs before
  // `compose up` rather than being left to an operator to remember. Assembly
  // failure aborts the bring-up loudly; it never degrades to the raw source
  // tree, because that is precisely the shape that shipped the unfurl bug.
  async function assembleStaticDir(): Promise<void> {
    emit({ phase: "log", message: "assembling prerendered STATIC_DIR (_static)…" });
    // Routed through the runtime seam like every other child process here.
    // This one is `bash`, not `docker`, and it is the fourth and last way this
    // module reaches outside itself — a spawn that bypassed the seam is a spawn
    // that cannot be tested, which is exactly how it broke `up()`'s ordering
    // test on a runner whose allowlisted PATH could not resolve `bash`.
    const code = await runtime.run(["bash", join(cfg.repoRoot, "scripts", "static-assembly.sh")], defaultIo);
    if (code !== 0) throw new Error(`static assembly failed (scripts/static-assembly.sh exited ${code})`);
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
    let lastDetail = "never probed";
    while (Date.now() < deadline) {
      const r = await runtime.probe(url);
      if (r.ok) return;
      lastDetail = r.detail;
      await sleep(500);
    }
    throw new Error(`timed out waiting for ${url}: ${lastDetail}`);
  }

  async function migrate(extraEnv: Record<string, string> = {}, scriptArgs: string[] = []): Promise<void> {
    emit({ phase: "migrate", status: "start" });
    await composeAsync(migrateArgs(extraEnv, scriptArgs), "migrations");
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
      // No container, no publish, no number to ask the daemon for. Asking anyway
      // would fail with a "no such service" that reads like a broken stack.
      pgPort: externalPostgres ? null : publishedPort("postgres", POSTGRES_CONTAINER_PORT),
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
    await assembleStaticDir();
    await build();

    emit({ phase: "postgres", status: "start" });
    if (externalPostgres) {
      // Nothing to start and nothing to poll: the server is somebody else's,
      // already running. Reachability is proven a moment later by migrate(),
      // which fails loudly with the driver's own connection error — a better
      // diagnostic than anything a pre-flight ping here could synthesize.
      emit({ phase: "postgres", status: "done", detail: "external (managed) — no container started" });
    } else {
      await composeAsync(upArgs(["postgres"]), "start postgres");
      await waitForPostgres(upOpts.pgTimeoutMs);
      emit({ phase: "postgres", status: "done" });
    }

    // Refuse before the first write, not after it. migrate() is that first
    // write — it does not only migrate, it seeds.
    if (upOpts.preflight) await upOpts.preflight();

    await migrate(upOpts.migrateEnv, upOpts.migrateScriptArgs);

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
    emit({
      phase: "ports",
      status: "done",
      detail: `api=:${ports.apiPort} pg=${ports.pgPort === null ? "external" : `:${ports.pgPort}`}`,
    });

    emit({ phase: "health", status: "start" });
    await waitForHttp(`${hostBackendUrl(ports.apiPort)}/health`, upOpts.healthTimeoutMs ?? 60_000);
    emit({ phase: "health", status: "done" });

    // Initialization runs LAST, after the API answers /health — never merely
    // after its container started. An initializer is a client of the running
    // stack: the archive initializer calls the api over the compose network
    // (ANALYTICS_API_URL=http://api:8787), so starting it between `services`
    // and the readiness gate raced the server's own boot and failed against an
    // API that was up but not yet listening. Readiness is a precondition of
    // initialization, so it is sequenced as one.
    if (upOpts.initialize) {
      emit({ phase: "initialize", status: "start" });
      await upOpts.initialize();
      emit({ phase: "initialize", status: "done" });
    }

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
