// The ONE compose bring-up — docs/decisions.md D22 "shared components",
// docs/architecture.md §11.3 E5.
//
// The smoke consumes it TODAY (`full` profile, scripts/lib/smoke-main.ts): its
// hand-rolled runCompose/waitForPostgres/waitForHttp are gone, not parallel, so
// `bun smoke` boots through this file and nothing else. The onboarding eval and
// the inference-off rails check (whose forked bringUpInfra() this replaces)
// adopt the `core` profile next; until they do, the smoke is the single runtime
// judge of this module. The StackHooks event surface below is how the smoke
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
  CONTAINER_TOKEN_HOLDERS,
  composeFilesWithImagesOverride,
  downArgs,
  hostBackendUrl,
  internalDatabaseUrl,
  migrateArgs,
  pgReadyArgs,
  portArgs,
  POSTGRES_CONTAINER_PORT,
  serviceTokenFile,
  servicesFor,
  upArgs,
  WEBSITE_SERVER_CONTAINER_PORT,
  type StackConfig,
  type StackHostPorts,
} from "./config.ts";
import {
  BUILD_COMMIT_COMPOSE_VAR,
  BUILD_TAG_COMPOSE_VAR,
  resolveBuildIdentityEnv,
} from "./build-identity.ts";
import { parseComposePortOutput, PortDiscoveryError } from "./ports.ts";
import { inspectArgs, missingImageRefs, parseImagesOverrideRefs, assertOverrideOutsideCheckout } from "./images.ts";
import { ensureContractInstallFresh } from "../lib/contract-freshness.ts";
import { placeSite, WEB_DIR_NAME } from "../lib/smoke-site.ts";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type StackPhase = "docker-preflight" | "build" | "postgres" | "migrate" | "services" | "ports" | "health" | "initialize";

/**
 * The steps up() takes, in order, as {@link StackUpOptions.beforeStep} names
 * them. Not a {@link StackPhase}: the event sequence is pinned by
 * scripts/tests/unit/stack-lifecycle-order.test.ts, and these are boundaries a
 * caller may act at, not narration.
 */
export type StackStep =
  | "assemble"
  | "database"
  | "site"
  | "build"
  | "postgres"
  | "preflight"
  | "migrate"
  | "services"
  | "health"
  | "initialize"
  | "deferred";

export type StackEvent =
  | { phase: StackPhase; status: "start" | "done"; detail?: string }
  | { phase: "log"; message: string };

// How a consumer renders progress WITHOUT this module importing its renderer:
// scripts/lib/smoke-main.ts maps these events onto its TUI panes; a test passes
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
   * Run the one-shot migrate container at all. Defaults to `true` — unchanged
   * behaviour for ephemeral/smoke-twin, which own their data and always
   * migrate. `--db external` passes `false` unless the operator opted in with
   * `--migrate` (scripts/lib/smoke-db-mode.ts): rm_app cannot `SET LOCAL ROLE
   * rm_owner`, so an unopted migrate() against a production server with
   * pending migrations would die mid-boot rather than serve today's schema.
   */
  migrate?: boolean;
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
  /**
   * The DATABASE half of a deployment, run FIRST — before assembly, the image
   * build or any application service — when given. `bun smoke` passes its
   * spec §7 sequence here: database create/restore (a local mode starts its
   * own `postgres` service through `compose`), the §2 target lock, the §4.3
   * identity matrix, then the authorized preparation (bootstrap, enrollment,
   * `--migrate`, `--seed`). None of it needs an application image, and an
   * operator typing a remote rm_owner password should not wait on a build to
   * be asked for it. A throw aborts the bring-up with nothing built. Not a
   * StackPhase: the event sequence is pinned by
   * scripts/tests/unit/stack-lifecycle-order.test.ts, and the caller journals
   * its own steps.
   */
  prepareDatabase?: () => Promise<void>;
  /** Scenario-specific initialization after services start but before the
   * stack is declared ready. Migration remains owned by this method exactly once. */
  initialize?: () => Promise<void>;
  /** Services that must start only after initialization has populated their
   * durable input. They are started with Compose's health barrier so a caller
   * cannot consume a process still busy with boot-time catch-up. */
  deferredServices?: string[];
  /**
   * Awaited before each step up() takes (only the steps this call will take:
   * no `migrate` when migrate is off, no `preflight` or `initialize` without
   * their callbacks). The seam a deployment journal (smoke spec §1.3) hangs
   * its phase boundaries on: `bun smoke` journals a phase and honours a
   * Ctrl-C here, between steps, never inside one. A throw aborts the bring-up
   * at that boundary with nothing of the next step begun.
   */
  beforeStep?: (step: StackStep) => Promise<void>;
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
  /** Provision the three service tokens for a throwaway stack's own compose postgres. */
  provisionTokens(): Promise<void>;
  /** Ask the daemon which host port it published one container port on. */
  publishedPort(service: string, containerPort: number): number;
  /** Both stack ports, queried live and then cached for this handle. */
  hostPorts(): StackHostPorts;
  up(opts?: StackUpOptions): Promise<StackHostPorts>;
  down(opts?: { removeVolumes?: boolean; removeOrphans?: boolean }): ComposeResult;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A `full` stack starts `system-scheduler` and `analytics-producer`, and each
 * reads its own token file from the instance's state directory (smoke spec §3).
 * Refuse BEFORE any application service starts when one is missing or empty:
 * a scheduler started without its file crash-loops on "automation token file
 * not found", and a boot that let it would report containers up while nothing
 * could authenticate. Checked after the database half, which is where `bun
 * smoke` provisions them. Core/status/down operations have no such service.
 */
export function assertContainerTokenFiles(cfg: StackConfig): void {
  // No instance: compose itself refuses the model before any service starts
  // (docker-compose.yml spells RM_INSTANCE_STATE_DIR with `:?`), so there is no
  // file to look for and nothing that could start without one.
  if (cfg.profile !== "full" || !cfg.instance) return;
  for (const holder of CONTAINER_TOKEN_HOLDERS) {
    const file = serviceTokenFile(cfg.instance.stateDir, holder);
    let value = "";
    try {
      value = readFileSync(file, "utf8").trim();
    } catch (error) {
      throw new Error(
        `the ${holder} token file ${file} is not readable (${error instanceof Error ? error.message : String(error)}). ` +
          "`bun smoke --local blank|dump` provisions it; production and a remote rehearsal target provision it " +
          "explicitly with `bun scripts/prod-init.ts provision-tokens`.",
      );
    }
    if (!value) throw new Error(`the ${holder} token file ${file} is empty`);
  }
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
  /**
   * `cwd` is optional and defaults to cfg.repoRoot, which is what every compose
   * call wants. It exists because the contract-freshness repair (R18) runs
   * `bun install` and an install that ran in the wrong directory would report
   * success while leaving the stale copy exactly where it was.
   */
  run(argv: string[], io: StackIo, cwd?: string): Promise<number>;
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
  // MUTABLE FOR EXACTLY ONE REASON (AC-ID-03): `build()` resolves the tree's
  // commit/tag through `runtime.runSync` and folds them in as compose build
  // args, so the identity baked into an image is the identity of the source it
  // was built from. Resolving it at createStack() time would spawn on
  // construction, which this module's header forbids; leaving it out entirely
  // is the state that let a staging host serve an untagged tip with no way to
  // tell from the outside. Nothing else reassigns this.
  let spawnEnv = buildSpawnEnv(cfg, hostEnv);
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
  // that prebuild in the shared stack lifecycle used by both smoke and smoke.
  const defaultBuildServices = buildServicesFor(cfg.profile, { externalPostgres });
  // AC-ID-05: the images override is appended LAST so it wins the merge, and it
  // is appended HERE rather than by each caller so that every consumer of this
  // module — smoke, evals, the rails check — gets the same topology from the
  // same field.
  const composeFiles = composeFilesWithImagesOverride(cfg.composeFiles, cfg.imagesOverride);
  const shippedImages = Boolean(cfg.imagesOverride);
  const prefix = composeArgs(cfg.project, composeFiles);

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
  // EVERY CHILD IN ITS OWN PROCESS GROUP (`detached`: a new session). A
  // terminal's Ctrl-C is delivered to the whole foreground process group; with
  // the build, `compose up` and the static assembly in it, a second Ctrl-C
  // killed the step mid-flight and the journal recorded it `failed` (wave-2
  // open problem 10). Detached, only the orchestrator receives the signal, and
  // `bun smoke` stops at the next phase boundary with the step complete (spec
  // §1.4). stdout and stderr are still the caller's; stdin is never read.
  const runtime: StackRuntime = opts.runtime ?? {
    runSync(argv, io) {
      const r = Bun.spawnSync(argv, {
        cwd: cfg.repoRoot,
        env: spawnEnv,
        stdin: "ignore",
        stdout: (io.stdout ?? "pipe") as "pipe",
        stderr: (io.stderr ?? "pipe") as "pipe",
        detached: true,
      } as Parameters<typeof Bun.spawnSync>[1]);
      return { exitCode: r.exitCode ?? -1, stdout: decode(r.stdout), stderr: decode(r.stderr) };
    },
    async run(argv, io, cwd) {
      const proc = Bun.spawn(argv, {
        cwd: cwd ?? cfg.repoRoot,
        env: spawnEnv,
        stdin: "ignore",
        stdout: (io.stdout ?? "pipe") as "pipe",
        stderr: (io.stderr ?? "pipe") as "pipe",
        detached: true,
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

  // The build identity of cfg.repoRoot, resolved AT MOST ONCE per handle.
  //
  // It used to be resolved inside build(). That was the only consumer until
  // AC-ID-05 gave the stack a path where build() never runs at all (the images
  // were built on pinza) and T26 gave `_static` — assembled on THIS host, in
  // every case, shipped images or not — a manifest that has to carry the same
  // commit/tag the image does. Resolving it here keeps one answer for both, and
  // still does not spawn at construction time (this module's header forbids it).
  let identityResolved = false;
  function resolveIdentityOnce(): void {
    if (identityResolved) return;
    identityResolved = true;
    // WHAT SOURCE THIS IMAGE IS (AC-ID-03). Resolved from cfg.repoRoot — the
    // tree compose is about to build — and never inherited from the host
    // environment: RM_BUILD_* are not in DOCKER_CLIENT_ENV_ALLOWLIST, so an
    // operator cannot hand a stack an identity it does not have.
    const identity = resolveBuildIdentityEnv((argv) => runtime.runSync(argv, { stdout: "pipe", stderr: "pipe" }));
    spawnEnv = { ...spawnEnv, ...identity };
    emit({
      phase: "log",
      message: `source ${identity[BUILD_COMMIT_COMPOSE_VAR] || "unavailable"}` +
        `${identity[BUILD_TAG_COMPOSE_VAR] ? ` (${identity[BUILD_TAG_COMPOSE_VAR]})` : ""}`,
    });
  }

  /**
   * AC-ID-05 — the guard that makes "nothing is built on the staging host" a
   * fact rather than an intention.
   *
   * `--no-build` already makes compose refuse, but its message names one
   * service at a time and arrives after the postgres phase has started
   * containers. This asks the daemon for every ref the override file pins,
   * BEFORE anything is started, and names all the missing ones at once — the
   * operator's next step is a re-ship, and they should learn the whole list in
   * one go.
   *
   * The refs come from the FILE compose was handed, not from a tag re-derived
   * here: if those two could disagree, this check would be grading something
   * other than the boot.
   */
  function assertShippedImagesPresent(): void {
    const overridePath = cfg.imagesOverride!;
    assertOverrideOutsideCheckout(overridePath, cfg.repoRoot);
    let text: string;
    try {
      text = readFileSync(overridePath, "utf8");
    } catch (error) {
      throw new Error(
        `images override ${overridePath} is not readable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const refs = parseImagesOverrideRefs(text);
    if (refs.length === 0) {
      throw new Error(`images override ${overridePath} pins no images — it names no \`image:\` for any service`);
    }
    emit({ phase: "build", status: "start", detail: `shipped images (no build): ${refs.length} refs` });
    const missing = missingImageRefs(refs, (ref) => runtime.runSync(inspectArgs(ref), { stdout: "ignore", stderr: "ignore" }).exitCode === 0);
    if (missing.length > 0) {
      throw new Error(
        `these images are pinned by ${overridePath} and are NOT on this host: ${missing.join(", ")}. ` +
          `Nothing may be built here (AC-ID-05) — build them on pinza at the RC tag and ship them with ` +
          `\`bun scripts/stack/ship-images.ts --tag <tag> --host <host>\`.`,
      );
    }
    emit({ phase: "build", status: "done", detail: `shipped images verified: ${refs.join(", ")}` });
  }

  async function build(buildServices: string[] = defaultBuildServices): Promise<void> {
    if (shippedImages) {
      throw new Error(
        `this stack was given an images-override (${cfg.imagesOverride}), so it builds NOTHING here: its images ` +
          "were built on pinza at the RC tag and shipped with `docker save | ssh docker load` (AC-ID-05). " +
          `Build them there and re-ship, or drop the override to build locally.`,
      );
    }
    emit({ phase: "build", status: "start", detail: buildServices.join(", ") });
    resolveIdentityOnce();
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
  // smoke-main asks for the api port on several code paths. A stale cache is
  // impossible for the same reason — a `down` invalidates the handle, not the
  // number. Callers that must not trust a cache (smoke:status, whose state file
  // CAN be stale across processes) query publishedPort() themselves.
  function hostPorts(): StackHostPorts {
    if (discovered) return discovered;
    discovered = {
      apiPort: publishedPort("api", API_CONTAINER_PORT),
      // Issue #892: the static/SPA origin backendUrl resolves against — always
      // part of CORE_SERVICES, so this is never "no such service".
      webPort: publishedPort("website-server", WEBSITE_SERVER_CONTAINER_PORT),
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
          "website-server container starts, so call up() (or hostPorts()) first",
      );
    }
    return hostBackendUrl(discovered.webPort);
  }

  /**
   * Provision the three service tokens for a THROWAWAY stack — an eval or a
   * rails test on the stack's own compose postgres — through the one entry
   * module that writes them (backend/scripts/provision-tokens.ts, its
   * `stack-superuser` form: that container's superuser, on this host's
   * loopback). `bun smoke` never comes here: it provisions inside its own
   * journaled, target-locked preparation. The request carries no secret (the
   * stack superuser's password is the baked-in, non-secret default).
   */
  async function provisionTokens(): Promise<void> {
    if (!cfg.instance) throw new Error("provisionTokens needs an instance: the token files live in its state directory");
    if (externalPostgres) throw new Error("provisionTokens is for a stack's own compose postgres; a deployment provisions through bun smoke or prod-init");
    const requestFile = join(cfg.instance.stateDir, `provision-request-${process.pid}.json`);
    const resultFile = join(cfg.instance.stateDir, `provision-result-${process.pid}.json`);
    const request = {
      instance: cfg.instance.name,
      stateRoot: dirname(cfg.instance.stateDir),
      target: { host: "127.0.0.1", port: publishedPort("postgres", POSTGRES_CONTAINER_PORT), database: cfg.database.name, sslmode: "disable" },
      credentials: { source: "stack-superuser", user: cfg.database.user, password: cfg.database.password },
      resultFile,
    };
    writeFileSync(requestFile, JSON.stringify(request), { mode: 0o600 });
    emit({ phase: "log", message: "provisioning the three service tokens…" });
    try {
      const code = await runtime.run(
        ["bun", "--no-env-file", join(cfg.repoRoot, "backend", "scripts", "provision-tokens.ts"), "--request", requestFile],
        defaultIo,
        join(cfg.repoRoot, "backend"),
      );
      const result = existsSync(resultFile) ? (JSON.parse(readFileSync(resultFile, "utf8")) as { ok: boolean; error?: string }) : null;
      if (code !== 0 || result?.ok !== true) {
        throw new Error(`service-token provisioning failed: ${result?.error ?? `exit ${code} with no result`}`);
      }
    } finally {
      rmSync(requestFile, { force: true });
      rmSync(resultFile, { force: true });
    }
  }

  async function up(upOpts: StackUpOptions = {}): Promise<StackHostPorts> {
    assertDockerAvailable();
    // R18 / C-18. Bun COPIES `file:` deps, so `node_modules/@robotmoney/contract`
    // is a point-in-time copy: the rc.1→rc.2 repin moved the checkout past a
    // commit touching `contract/` and everything that read a route added since
    // saw `undefined` until someone ran `bun install --force` by hand. Every
    // repin has that shape, so the boot repairs it rather than the runbook
    // asking an operator to remember — and re-verifies, so a repair that did
    // not work fails here instead of three frames deep in the prerenderer.
    await ensureContractInstallFresh(cfg.repoRoot, async (argv, cwd) =>
      runtime.run(argv, defaultIo, cwd),
    );
    // Both the static manifest (T26) and any build below report the identity of
    // THIS tree, and they must not be able to disagree about it.
    resolveIdentityOnce();
    const boundary = async (step: StackStep): Promise<void> => {
      if (upOpts.beforeStep) await upOpts.beforeStep(step);
    };
    // ASSEMBLE FIRST, then the database. Assembly writes only the checkout's
    // `_static`; it touches no target. Running it before prepareDatabase lets
    // a caller decide on the assembled site at the `database` boundary, BEFORE
    // the first mutation of the target (smoke spec §13.3: the web-compat
    // refusal must leave the database and every container as they were).
    await boundary("assemble");
    await assembleStaticDir();
    if (upOpts.prepareDatabase) {
      await boundary("database");
      await upOpts.prepareDatabase();
    }
    if (cfg.instance) {
      // The assembled site becomes the instance's current one (website-server
      // serves `web/current`; scripts/lib/smoke-site.ts). Every consumer of this
      // module gets it, so an eval's website-server serves the same bytes a
      // smoke's does. Idempotent: an unchanged site is neither copied nor swapped.
      await boundary("site");
      const site = placeSite(join(cfg.instance.stateDir, WEB_DIR_NAME), join(cfg.repoRoot, "_static"));
      emit({
        phase: "log",
        message: `site ${site.siteId}: ${site.copied ? "placed" : "already placed"}${site.swapped ? `, now current (was ${site.previous ?? "none"})` : ", already current"}`,
      });
    }
    await boundary("build");
    if (shippedImages) assertShippedImagesPresent();
    else await build();

    await boundary("postgres");
    emit({ phase: "postgres", status: "start" });
    if (externalPostgres) {
      // Nothing to start and nothing to poll: the server is somebody else's,
      // already running. Reachability is proven a moment later by migrate(),
      // which fails loudly with the driver's own connection error — a better
      // diagnostic than anything a pre-flight ping here could synthesize.
      emit({ phase: "postgres", status: "done", detail: "external (managed) — no container started" });
    } else {
      await composeAsync(upArgs(["postgres"], { noBuild: shippedImages }), "start postgres");
      await waitForPostgres(upOpts.pgTimeoutMs);
      emit({ phase: "postgres", status: "done" });
    }

    // Refuse before the first write, not after it. migrate() is that first
    // write — it does not only migrate, it seeds.
    if (upOpts.preflight) {
      await boundary("preflight");
      await upOpts.preflight();
    }

    if (upOpts.migrate ?? true) {
      await boundary("migrate");
      try {
        await migrate(upOpts.migrateEnv, upOpts.migrateScriptArgs);
      } finally {
        // A caller that set MIGRATE_DATABASE_URL for this one run (an
        // interactively-typed doadmin credential, or a rehearsal's
        // twinMigrationCredential()) never wants it outliving the call it was
        // for — this process keeps running long after migrate() returns.
        delete process.env.MIGRATE_DATABASE_URL;
      }
      // The throwaway stack's own database is now the schema; its services
      // authenticate with store-issued tokens like every other stack's.
      if (cfg.instance && !externalPostgres && !upOpts.prepareDatabase) await provisionTokens();
    } else {
      emit({ phase: "migrate", status: "start", detail: "skipped — pass --migrate to run it" });
      emit({ phase: "migrate", status: "done", detail: "skipped" });
    }

    // Named explicitly from the profile — never a bare `docker compose up -d` —
    // so a compose service added later can never leak into `core`.
    const requestedDeferred = new Set(upOpts.deferredServices ?? []);
    const unknownDeferred = [...requestedDeferred].filter((s) => !services.includes(s));
    if (unknownDeferred.length > 0) {
      throw new Error(`deferred services are not in the ${cfg.profile} profile: ${unknownDeferred.join(", ")}`);
    }
    const rest = services.filter((s) => s !== "postgres" && !requestedDeferred.has(s));
    assertContainerTokenFiles(cfg);
    await boundary("services");
    emit({ phase: "services", status: "start", detail: rest.join(", ") });
    await composeAsync(upArgs(rest, { noBuild: shippedImages }), "start services");
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
      detail: `api=:${ports.apiPort} web=:${ports.webPort} pg=${ports.pgPort === null ? "external" : `:${ports.pgPort}`}`,
    });

    await boundary("health");
    emit({ phase: "health", status: "start" });
    // api's own /health directly first: a database-connectivity problem is a
    // more specific diagnostic there than the same check proxied through
    // website-server would give.
    await waitForHttp(`${hostBackendUrl(ports.apiPort)}/health`, upOpts.healthTimeoutMs ?? 60_000);
    // Then website-server itself (issue #892) — the origin backendUrl actually
    // resolves to, and what every page-load/BACKEND_URL consumer needs up.
    await waitForHttp(`${hostBackendUrl(ports.webPort)}/health`, upOpts.healthTimeoutMs ?? 60_000);
    emit({ phase: "health", status: "done" });

    // Initialization runs LAST, after the API answers /health — never merely
    // after its container started. An initializer is a client of the running
    // stack: the archive initializer calls the api over the compose network
    // (ANALYTICS_API_URL=http://api:8787), so starting it between `services`
    // and the readiness gate raced the server's own boot and failed against an
    // API that was up but not yet listening. Readiness is a precondition of
    // initialization, so it is sequenced as one.
    if (upOpts.initialize) {
      await boundary("initialize");
      emit({ phase: "initialize", status: "start" });
      await upOpts.initialize();
      emit({ phase: "initialize", status: "done" });
    }

    if (requestedDeferred.size > 0) {
      const deferred = [...requestedDeferred];
      await boundary("deferred");
      emit({ phase: "services", status: "start", detail: deferred.join(", ") });
      await composeAsync(
        upArgs(deferred, { wait: true, waitTimeoutSeconds: 600 }),
        `start deferred services ${deferred.join(" ")}`,
      );
      emit({ phase: "services", status: "done", detail: deferred.join(", ") });
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
    provisionTokens,
    publishedPort,
    hostPorts,
    up,
    down,
  };
}
