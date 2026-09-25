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
//   analytics-producer-authenticated  the producer container's Docker health: its
//                                   healthcheck rides the producer's AUTHENTICATED
//                                   readiness gate (backend/src/producer/index.ts),
//                                   so a rejected token reads unhealthy.
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
    const producerId = serviceContainerId(run, cfg.project, cfg.producerService);
    const producerHealth = containerHealth(run, producerId);
    return {
      apiHealth,
      scheduler,
      subjects: await readSubjects(cfg.apiUrl, cfg.operatorToken, fetchImpl),
      workers: cfg.workerServices.map((service) => readWorkerStartup(run, cfg.project, service)),
      producer: {
        health: producerHealth,
        detail: producerHealth === "healthy"
          ? "its healthcheck rides the authenticated analytics readiness gate with its token"
          : "its authenticated analytics readiness gate has not answered ok",
      },
      seed: cfg.seed(),
    };
  };
}
