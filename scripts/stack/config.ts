// Shared compose-stack CONFIGURATION — pure builders, nothing else.
//
// Written in the style of scripts/lib/smoke-env.ts, and binding for the whole
// scripts/stack/ directory (docs/decisions.md D22 "shared components",
// docs/architecture.md §11.3 E5 and §3 L2/L3):
//
//   1. This module MUST stay side-effect free. Nothing runs on import — no
//      port is bound, no secret is generated, no child process is spawned.
//      scripts/lib/smoke-main.ts does its setup at module scope, which is
//      exactly why nothing could import it; this module exists so the smoke,
//      the inference-off rails check, and the onboarding eval can share ONE
//      bring-up without booting anything by merely importing it.
//   2. This module MUST never read or write the process environment. Every
//      input arrives as an explicit argument or an explicit config object,
//      and the environment handed to a compose child is BUILT here rather
//      than inherited. That is what keeps an operator's ambient credential
//      (or a provider secret) from silently reaching a container.
//   3. Nothing here has an inference-off, injection, or skip affordance
//      (D22 §11.3 E2). A missing dependency is the caller's problem to throw
//      about, never something this layer papers over.
import {
  ENV_CLASS_COMPOSE_VAR,
  ENV_HASH_COMPOSE_VAR,
  type StackEnvironment,
} from "./naming.ts";

// ── Profiles ────────────────────────────────────────────────────────────────
// `core` is postgres + api: everything apply/approve/claim needs (Postgres CRUD
// plus signature verification), and nothing else. `full` adds the three worker
// execution lanes that the standing smoke drives. The member-agent service is
// deliberately in NEITHER *running* list: it is compose-profile gated
// (docker-compose.smoke.yml `profiles: ["member-agent"]`) and is only ever
// started one-shot via `docker compose run`.
export type StackProfile = "core" | "full";

export const CORE_SERVICES = ["postgres", "api"] as const;
export const WORKER_LANE_SERVICES = ["worker-swarm", "worker-analytics", "worker-research"] as const;
export const PRODUCER_SERVICES = ["analytics-producer"] as const;
export const FULL_SERVICES = [...CORE_SERVICES, ...WORKER_LANE_SERVICES, ...PRODUCER_SERVICES] as const;
export const MEMBER_AGENT_SERVICE = "member-agent" as const;

// Services are always named EXPLICITLY (never a bare `docker compose up -d`),
// so a compose service added in the future can never leak into `core`.
//
// `externalPostgres` drops the `postgres` service from either profile: with
// `bun run smoke -- --external-pg` the stack talks to a managed server and the
// ephemeral container is not started at all (scripts/lib/smoke-external-pg.ts).
// Naming it here — rather than filtering at the call site — keeps "which
// services does this stack consist of" answerable in one place.
export function servicesFor(profile: StackProfile, opts: { externalPostgres?: boolean } = {}): string[] {
  const all = profile === "core" ? [...CORE_SERVICES] : [...FULL_SERVICES];
  return opts.externalPostgres ? all.filter((s) => s !== "postgres") : all;
}

/**
 * Images a stack must finish building before it is ready for its consumers.
 *
 * A full stack drives swarm sessions, whose members launch concurrently as
 * one-shot `member-agent` containers. The service is profile-gated so it must
 * not appear in `servicesFor("full")`, but its image is still a runtime
 * prerequisite. Including it once in the shared build plan prevents multiple
 * concurrent `docker compose run` calls from racing an implicit cold build.
 * Core stacks retain their existing build plan; onboarding/eval explicitly
 * builds the member-agent image when that rail is requested.
 */
export function buildServicesFor(profile: StackProfile, opts: { externalPostgres?: boolean } = {}): string[] {
  const running = servicesFor(profile, opts);
  return profile === "full" ? [...running, MEMBER_AGENT_SERVICE] : running;
}

// The compose file list every consumer of this module defaults to. The smoke
// overrides it (it may append the stage overlay and/or a generated pg-data bind
// overlay); the eval harness and the rails check, which today each spell their
// own copy out, take this one as they adopt the module.
export const DEFAULT_COMPOSE_FILES = ["docker-compose.yml", "docker-compose.smoke.yml"];

// The `bun run smoke -- --stage` overlay: the ONLY file in the repo that names a
// host port. APPENDED to the list above (never a replacement, and never
// selected from the environment) exactly the way the generated `--pg-data` bind
// overlay is. See docker-compose.stage.yml's header for why it uses
// `ports: !override` rather than a plain `ports:`.
export const STAGE_COMPOSE_FILE = "docker-compose.stage.yml";

// ── Container-internal ports ────────────────────────────────────────────────
// The CONTAINER side of each publish — fixed literals, not knobs (each
// container has its own network namespace, so nothing can contend for a port
// inside it). They are the argument to `docker compose port <svc> <port>`,
// which is how the HOST side is discovered after `up`; the host side itself is
// chosen by Docker and appears nowhere in this repo's configuration.
export const API_CONTAINER_PORT = 8787;
export const POSTGRES_CONTAINER_PORT = 5432;

// The host ports Docker assigned to one running stack, read back after `up`.
// `pgPort` is NULL — not 0, not absent — when the stack runs against an external
// managed Postgres: there is no postgres container, so no host port was ever
// published. Null says "there is deliberately no number here"; a 0 would read as
// a number nobody assigned, which this module is at pains elsewhere never to
// hand back.
export interface StackHostPorts {
  apiPort: number;
  pgPort: number | null;
}

// ── Database ────────────────────────────────────────────────────────────────
export interface StackDatabase {
  user: string;
  password: string;
  name: string;
  /**
   * An EXTERNAL/managed Postgres URL. When set, this stack starts no postgres
   * container: `url` is what every container connects with, `servicesFor` drops
   * the service, and the caller appends the generated overlay that removes it
   * from the compose model (scripts/lib/smoke-external-pg.ts). The three fields
   * above stay as they are — they interpolate POSTGRES_* for a compose model
   * that no longer contains the service, so they are inert, not authoritative.
   *
   * NEVER log or serialize this: unlike the baked-in smoke credentials it is a
   * real secret. Print `redactPostgresUrl()` instead.
   */
  url?: string;
}

// The baked-in smoke credentials (previously spelled out in smoke-main.ts). They
// are not secrets: postgres is reachable only over the compose network plus a
// random host port, and every consumer of this stack is ephemeral.
export const DEFAULT_STACK_DATABASE: StackDatabase = {
  user: "robotmoney",
  password: "robotmoney",
  name: "robotmoney",
};

// The URL a CONTAINER uses: the `postgres` compose service on its internal
// port, never a host port — unless the stack was given an external managed URL,
// which is passed through verbatim (that server is reached over the network like
// any other external dependency, so there is no compose-internal form of it).
export function internalDatabaseUrl(db: StackDatabase): string {
  return db.url ?? `postgres://${db.user}:${db.password}@postgres:5432/${db.name}`;
}

// Use 127.0.0.1, NOT localhost: Docker publishes the container ports on IPv4
// (0.0.0.0) but GitHub Actions' daemon does not publish on IPv6, while Bun's
// fetch resolves "localhost" to ::1 first — so a localhost health check times
// out in CI even though the service is up. 127.0.0.1 forces the IPv4 path.
export function hostBackendUrl(apiPort: number): string {
  return `http://127.0.0.1:${apiPort}`;
}

// ── Credentials ─────────────────────────────────────────────────────────────
export interface StackCredentials {
  // Guards the /admin task-queue dashboard (X-Admin-Token) and every swarm
  // admin route. Fresh per stack.
  adminToken: string;
  automationToken: string;
  // Analytics-provider bearer (issue #106): the api verifies it, the worker
  // submits with it. Fresh per stack, never printed anywhere.
  analyticsToken: string;
  /** Optional host path mounted as a Docker secret; avoids placing the token in child env. */
  analyticsTokenFile?: string;
}

// A FUNCTION, called by the caller — never executed on import (invariant 1).
export function generateStackCredentials(): StackCredentials {
  return {
    adminToken: crypto.randomUUID().replace(/-/g, "").slice(0, 20),
    automationToken: crypto.randomUUID().replace(/-/g, "").slice(0, 20),
    analyticsToken: crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, ""),
  };
}

// ── Config object ───────────────────────────────────────────────────────────
export interface StackConfig {
  repoRoot: string;
  project: string;
  profile: StackProfile;
  // NO apiPort/pgPort. A host port is not an INPUT to a bring-up any more: the
  // compose files publish container ports only and Docker picks the host side,
  // so the numbers do not exist until after `up` and are read back with
  // `docker compose port` (scripts/stack/stack.ts's hostPorts()). Carrying them
  // here at all is what made the old pre-bind race possible — a config field
  // has to be filled in before the daemon is asked.
  composeFiles: string[];
  database: StackDatabase;
  credentials: StackCredentials;
  // WHICH ENVIRONMENT started this stack (scripts/stack/naming.ts). REQUIRED,
  // not optional: it is the input to both the compose project name AND the
  // labels every container carries, and an optional field is one a spawner
  // forgets — which is exactly how the host accumulated containers that could
  // not be attributed to a CI job or to an operator's shell, and therefore
  // could not be reaped without risking the standing smoke.
  environment: StackEnvironment;
  // Extra compose interpolation values a specific consumer needs (the smoke
  // passes its resolved data-path env here). Merged LAST so a consumer can
  // extend, and deliberately never sourced from the ambient environment.
  extraComposeEnv?: Record<string, string>;
}

// ── Compose env (PURE) ──────────────────────────────────────────────────────
// Exactly the interpolation values docker-compose.yml / docker-compose.smoke.yml
// need, and nothing else. Deliberately does NOT spread the caller's ambient
// environment, and deliberately does NOT set COMPOSE_FILE / COMPOSE_PROJECT_NAME:
// topology is expressed as argv (`-p` / `-f`, see composeArgs) so a stale
// exported COMPOSE_* value can never redirect a bring-up.
export function buildComposeEnv(cfg: StackConfig): Record<string, string> {
  if (cfg.profile === "full" && !cfg.credentials.analyticsTokenFile) {
    throw new Error(
      "full stack profile requires credentials.analyticsTokenFile for the independent analytics producer",
    );
  }
  return {
    SMOKE_PROJECT: cfg.project,
    // The environment labels every smoke-overlay service and the pgdata volume
    // stamp (docker-compose.smoke.yml). Threaded through compose interpolation
    // rather than applied by a wrapper so a bare `docker compose -f … up` gets
    // them too, and so `smoke:down`/`smoke:status` reproduce them from the state
    // file without a second code path.
    [ENV_CLASS_COMPOSE_VAR]: cfg.environment.class,
    [ENV_HASH_COMPOSE_VAR]: cfg.environment.hash,
    DATABASE_URL: internalDatabaseUrl(cfg.database),
    ADMIN_TOKEN: cfg.credentials.adminToken,
    AUTOMATION_TOKEN: cfg.credentials.automationToken,
    ANALYTICS_TOKEN: cfg.credentials.analyticsTokenFile ? "" : cfg.credentials.analyticsToken,
    ANALYTICS_TOKEN_FILE_HOST: cfg.credentials.analyticsTokenFile ?? "/dev/null",
    // No WEB_PORT / POSTGRES_PORT. They were compose interpolation OUTPUTS
    // right up until the compose files stopped naming a host port at all
    // (`ports: ["8787"]` / `["5432"]` — Docker assigns the host side). Emitting
    // them now would be a value nothing reads, which is how the last one
    // survived long enough to look like configuration; `bun smoke` warns loudly
    // when it finds either in the operator's environment.
    POSTGRES_USER: cfg.database.user,
    POSTGRES_PASSWORD: cfg.database.password,
    POSTGRES_DB: cfg.database.name,
    ...cfg.extraComposeEnv,
  };
}

// Docker CLIENT plumbing — the only host variables a compose child is allowed
// to inherit. Everything not on this list is dropped, which is the mechanism
// that keeps a provider secret, an operator's own admin token, or a model
// selection knob from ever reaching a container (D22 §11.3 E1). Grown only for
// a variable the docker CLI itself needs to find and talk to a daemon.
export const DOCKER_CLIENT_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "TMPDIR",
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_CONFIG",
  "DOCKER_CERT_PATH",
  "DOCKER_TLS_VERIFY",
  "DOCKER_BUILDKIT",
  "COMPOSE_DOCKER_CLI_BUILD",
  "SSH_AUTH_SOCK",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
] as const;

// Allowlisted docker-client plumbing from the EXPLICITLY PASSED host env, then
// the stack's own compose env on top (so a host value can never shadow a
// stack value).
export function buildSpawnEnv(cfg: StackConfig, hostEnv: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of DOCKER_CLIENT_ENV_ALLOWLIST) {
    const v = hostEnv[key];
    if (v !== undefined) out[key] = v;
  }
  return { ...out, ...buildComposeEnv(cfg) };
}

// ── argv builders (PURE — every command shape is testable without Docker) ───
export function composeArgs(project: string, files: string[] = DEFAULT_COMPOSE_FILES): string[] {
  return ["compose", "-p", project, ...files.flatMap((f) => ["-f", f])];
}

export function buildArgs(services: string[] = []): string[] {
  return ["build", ...services];
}

export function upArgs(services: string[]): string[] {
  return ["up", "-d", ...services];
}

// `--no-deps` is safe (and correct) because up() waits for postgres to be ready
// BEFORE migrating; if that ordering is ever rearranged, migrate fails loudly
// with a connection error instead of implicitly starting postgres.
export function migrateArgs(extraEnv: Record<string, string> = {}, scriptArgs: string[] = []): string[] {
  return [
    "run",
    "--rm",
    "--no-deps",
    "-T",
    ...Object.entries(extraEnv).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
    "api",
    "bun",
    "run",
    "src/db/migrate.ts",
    ...scriptArgs,
  ];
}

export function downArgs(opts: { removeVolumes?: boolean; removeOrphans?: boolean } = {}): string[] {
  return [
    "down",
    ...(opts.removeVolumes ? ["--volumes"] : []),
    ...(opts.removeOrphans ? ["--remove-orphans"] : []),
  ];
}

export function pgReadyArgs(db: StackDatabase): string[] {
  return ["exec", "-T", "postgres", "pg_isready", "-U", db.user, "-d", db.name];
}

// Ask the daemon which HOST port it published `service`'s `containerPort` on.
// This is the only way the host side is ever learned: the compose files no
// longer name one, so nothing in this repo could otherwise say. Parsed by
// scripts/stack/ports.ts's parseComposePortOutput (which handles the IPv4 +
// IPv6 dual-line case).
export function portArgs(service: string, containerPort: number): string[] {
  return ["port", service, String(containerPort)];
}
