// WHAT `bun smoke`'S READINESS READS — issue #1026 W4, criteria 27 and 41.
//
// AUTHORITY: docs/technical/smoke-production-spec.md §6.3 and §7.2.
//
// The verdict lives in scripts/lib/smoke-readiness-scheduler.ts, which runs
// nothing. This file is the other half: the READS a real boot makes to fill a
// `ReadinessObservation`, each from the authority that owns the fact.
//
//   api-health                      GET <api>/health on the host-published port.
//   scheduler (four checks)         GET the scheduler's own /health, published on
//                                   loopback (docker-compose.yml): "Smoke reads
//                                   this from the scheduler's health endpoint".
//   epoch-per-active-subject        the API, not the scheduler: the admin subject
//                                   list (the operator token's `admin` right) and
//                                   the public list of `collecting` sessions.
//   pipeline-worker-startup         each worker container's Docker health plus the
//                                   last `startup_preflight:` line it logged (§7.2:
//                                   the worker writes no heartbeat until checks
//                                   1-3 pass, and logs the refusal and exits 1).
//   analytics-producer-authenticated  the PHASE of the producer's own heartbeat, as
//                                   its last Docker healthcheck printed it
//                                   (`docker inspect` .State.Health.Log; the check
//                                   is backend/src/ops/healthcheck.ts). Container
//                                   health alone is NOT authentication: the
//                                   producer writes a `boot` record, healthy for
//                                   180s, BEFORE waitForApi presents its token
//                                   (backend/src/producer/index.ts
//                                   startProducerSchedules). Only after waitForApi
//                                   got an ok from the AUTHENTICATED
//                                   ROUTES.analytics.readiness does it write any
//                                   other phase: `busy` from the boot catch-up,
//                                   then `armed` from the liveness loop, whose
//                                   every tick re-probes that route with the
//                                   token. A rejected token makes waitForApi
//                                   throw and the process exit, so no post-auth
//                                   phase is ever written.
//
// EVERY DOCKER CALL HERE IS A READ: `compose port`, `ps`, `inspect`, `logs`.
// None starts, stops or restarts anything — §6.3: "smoke never restarts it on
// its own". The command runner is injected so a test can record every argv the
// real readiness path issues and assert that.
import { ROUTES } from "@robotmoney/contract";
import { parseComposePortOutput } from "../stack/ports.ts";
import {
  fetchSchedulerHealth,
  lastStartupPreflightLine,
  type ContainerHealth,
  type ReadinessObservation,
  type WorkerStartupReading,
} from "./smoke-readiness-scheduler.ts";

/** One command's result. */
export interface ProbeCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Runs one `docker …` argv (without the leading `docker`) and returns its output. Reads only. */
export type ProbeRunner = (args: readonly string[]) => ProbeCommandResult;

/** The scheduler's health port inside its container (docker-compose.yml SCHEDULER_HEALTH_PORT). */
export const SCHEDULER_HEALTH_PORT = 8090;

/** The docker subcommands the readiness path may issue. Anything else is refused before it runs. */
export const READ_ONLY_DOCKER_SUBCOMMANDS = ["compose port", "ps", "inspect", "logs"] as const;

export interface ReadinessProbeConfig {
  /** The compose project, for container lookup by label. */
  readonly project: string;
  /** `docker compose -p … -f …` argv prefix (without `docker`), for `compose port`. */
  readonly composePrefix: readonly string[];
  /** `http://127.0.0.1:<api host port>`. */
  readonly apiUrl: string;
  /** The operator's token (§3), for the admin subject list. */
  readonly operatorToken: string;
  /** The pipeline worker's compose services. */
  readonly workerServices: readonly string[];
  readonly producerService: string;
  readonly schedulerService: string;
  /** What the producer's seed command did on this boot. */
  readonly seed: () => { completed: boolean; detail: string };
  readonly run: ProbeRunner;
  readonly fetchImpl?: typeof fetch;
}

/** Refuse any docker argv that is not a read, before it runs. */
export function readOnlyRunner(run: ProbeRunner): ProbeRunner {
  return (args) => {
    const head = args[0] === "compose" ? `compose ${args.find((a, i) => i > 0 && !a.startsWith("-") && !isFlagValue(args, i)) ?? ""}` : args[0];
    if (!(READ_ONLY_DOCKER_SUBCOMMANDS as readonly string[]).includes(head ?? "")) {
      throw new Error(`the readiness path issues read-only docker commands only; refused: docker ${args.join(" ")}`);
    }
    return run(args);
  };
}

/** Whether argv[i] is the value of a compose flag that takes one (`-p x`, `-f x`, `--env-file x`). */
function isFlagValue(args: readonly string[], i: number): boolean {
  return ["-p", "-f", "--env-file", "--project-name", "--file"].includes(args[i - 1] ?? "");
}

/** The running container of `service` in `project`, or undefined. */
export function serviceContainerId(run: ProbeRunner, project: string, service: string): string | undefined {
  const r = run([
    "ps", "-q",
    "--filter", `label=com.docker.compose.project=${project}`,
    "--filter", `label=com.docker.compose.service=${service}`,
    "--filter", "label=com.docker.compose.oneoff=False",
  ]);
  return r.stdout.split("\n").map((l) => l.trim()).find(Boolean);
}

/** A container's Docker health. */
export function containerHealth(run: ProbeRunner, id: string | undefined): ContainerHealth {
  if (!id) return "missing";
  const r = run(["inspect", "--format", "{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}", id]);
  const status = r.stdout.trim();
  return status === "healthy" || status === "unhealthy" || status === "starting" || status === "none" ? status : "missing";
}

/**
 * The heartbeat phases the producer writes only AFTER its token authenticated
 * (backend/src/producer/index.ts): `busy` from the catch-up that runs once
 * waitForApi returned, `armed` from the liveness loop. `boot` is written before
 * waitForApi and proves nothing about the token.
 */
export const PRODUCER_AUTHENTICATED_PHASES = ["busy", "armed"] as const;

/** Docker's `.State.Health`, as `docker inspect --format '{{json .State.Health}}'` prints it. */
interface DockerHealthState {
  Status?: string;
  Log?: { ExitCode?: number; Output?: string; End?: string }[];
}

/** What the producer's last healthcheck said: its container health and the heartbeat phase it printed. */
export interface ProducerAuthReading {
  health: ContainerHealth;
  /** The heartbeat phase in the last healthcheck's output (`phase=<x>`), or null when none was printed yet. */
  phase: string | null;
  /** Whether that phase can only have been written after the token authenticated, on a passing check. */
  authenticated: boolean;
  detail: string;
}

/** Parse `{{json .State.Health}}` into the producer's authentication reading. Pure. */
export function parseProducerHealth(json: string): ProducerAuthReading {
  let state: DockerHealthState | null = null;
  try {
    state = JSON.parse(json.trim() || "null") as DockerHealthState | null;
  } catch {
    state = null;
  }
  if (!state || typeof state.Status !== "string") {
    return { health: "none", phase: null, authenticated: false, detail: "the producer container reports no healthcheck state" };
  }
  const status = state.Status;
  const health: ContainerHealth =
    status === "healthy" || status === "unhealthy" || status === "starting" ? status : "missing";
  const last = (state.Log ?? []).at(-1);
  if (!last) return { health, phase: null, authenticated: false, detail: `container ${status}; no healthcheck has run yet` };
  const output = (last.Output ?? "").trim();
  const phase = /\bphase=([a-z]+)/.exec(output)?.[1] ?? null;
  const passed = last.ExitCode === 0;
  const authenticated = passed && health === "healthy" && phase !== null && (PRODUCER_AUTHENTICATED_PHASES as readonly string[]).includes(phase);
  const why = authenticated
    ? `heartbeat phase=${phase}, written only after waitForApi's authenticated readiness call returned ok`
    : phase === "boot"
      ? "heartbeat phase=boot: the producer has not yet authenticated with its token (waitForApi still waiting)"
      : !passed
        ? `last healthcheck failed: ${output.split("\n")[0] ?? ""}`
        : `heartbeat phase=${phase ?? "none"} does not show an authenticated producer`;
  return { health, phase, authenticated, detail: `container ${status}; ${why}` };
}

/** Read the producer container's authentication from its last healthcheck. */
export function readProducerAuth(run: ProbeRunner, id: string | undefined): ProducerAuthReading {
  if (!id) return { health: "missing", phase: null, authenticated: false, detail: "no analytics-producer container is running" };
  const r = run(["inspect", "--format", "{{json .State.Health}}", id]);
  if (r.exitCode !== 0) return { health: "missing", phase: null, authenticated: false, detail: `docker inspect failed: ${r.stderr.trim()}` };
  return parseProducerHealth(r.stdout);
}

/** One worker container: its health and its last startup-preflight line. */
export function readWorkerStartup(run: ProbeRunner, project: string, service: string): WorkerStartupReading {
  const id = serviceContainerId(run, project, service);
  if (!id) return { service, health: "missing", line: null };
  const logs = run(["logs", "--tail", "400", id]);
  return { service, health: containerHealth(run, id), line: lastStartupPreflightLine(`${logs.stdout}\n${logs.stderr}`) };
}

/** Active subjects (admin list) and the subjects holding a `collecting` session (public list). */
export async function readSubjects(apiUrl: string, operatorToken: string, fetchImpl: typeof fetch = fetch): Promise<ReadinessObservation["subjects"]> {
  try {
    const subjectsRes = await fetchImpl(`${apiUrl}${ROUTES.swarm.admin.subjects}`, {
      headers: { "X-Automation-Token": operatorToken, Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    const sessionsRes = await fetchImpl(`${apiUrl}${ROUTES.swarm.sessions}?state=collecting&limit=100`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!subjectsRes.ok || !sessionsRes.ok) return null;
    const subjects = ((await subjectsRes.json()) as { subjects?: { id: string; status: string }[] }).subjects ?? [];
    const sessions = ((await sessionsRes.json()) as { sessions?: { subjectId: string; state: string }[] }).sessions ?? [];
    return {
      active: subjects.filter((s) => s.status === "active").map((s) => s.id),
      collecting: [...new Set(sessions.filter((s) => s.state === "collecting").map((s) => s.subjectId))],
    };
  } catch {
    return null;
  }
}

/** The scheduler's host-published health URL, or null while it publishes none (not running). */
export function schedulerHealthUrl(run: ProbeRunner, composePrefix: readonly string[], service: string): string | null {
  const r = run([...composePrefix, "port", service, String(SCHEDULER_HEALTH_PORT)]);
  if (r.exitCode !== 0) return null;
  try {
    return `http://127.0.0.1:${parseComposePortOutput(r.stdout, service, SCHEDULER_HEALTH_PORT)}/health`;
  } catch {
    return null;
  }
}

/** A function that reads one full observation, each fact from its authority. */
export function makeReadinessObserver(cfg: ReadinessProbeConfig): () => Promise<ReadinessObservation> {
  const run = readOnlyRunner(cfg.run);
  const fetchImpl = cfg.fetchImpl ?? fetch;
  return async () => {
    const apiHealth = await fetchImpl(`${cfg.apiUrl}/health`, { signal: AbortSignal.timeout(10_000) })
      .then((r) => ({ ok: r.ok, detail: `${cfg.apiUrl}/health answered ${r.status}` }))
      .catch((error: unknown) => ({ ok: false, detail: `${cfg.apiUrl}/health unreachable: ${error instanceof Error ? error.message : String(error)}` }));
    const url = schedulerHealthUrl(run, cfg.composePrefix, cfg.schedulerService);
    const scheduler = url ? await fetchSchedulerHealth(url, fetchImpl) : null;
    const producer = readProducerAuth(run, serviceContainerId(run, cfg.project, cfg.producerService));
    return {
      apiHealth,
      scheduler,
      subjects: await readSubjects(cfg.apiUrl, cfg.operatorToken, fetchImpl),
      workers: cfg.workerServices.map((service) => readWorkerStartup(run, cfg.project, service)),
      producer,
      seed: cfg.seed(),
    };
  };
}
