// THE STANDING PARTICIPANT SERVICES — one compose service per credential-file
// roster entry (smoke-production-spec.md §6.1, §6.2, §3; issue #1026 W3).
//
// ── WHAT THIS MODULE IS ─────────────────────────────────────────────────────
// `bun smoke`'s `participants` phase makes the running participants equal the
// credential file (§6.1). credential-file.ts `planParticipants` decides WHAT
// to start, keep and stop; this module turns that decision into compose
// services and applies it to Docker:
//
//   renderParticipantServices  pure: roster entries → N+M service definitions
//                              and one env file per service;
//   listRunningParticipants    Docker read: the participant containers of this
//                              project, by label;
//   applyParticipantPlan       Docker write: stop what the plan stops, then
//                              bring the desired services up.
//
// ── EACH CONTAINER RECEIVES ONLY ITS OWN KEY (§3, §6.1) ─────────────────────
// A service's whole credential arrives through ONE env file, written 0600 in
// the instance's state directory, named per instance and per participant (§3:
// "a file the boot places in the instance's state directory, named per
// instance and per holder, never in `~/.env` and never in an image"). The
// compose model names that file under `env_file` and carries no secret of its
// own, so no service's definition, label or command line holds another
// participant's bearer, signing key or model key. Nothing a participant is
// given names a database, a service token or a Docker socket: the renderer
// refuses an env key that looks like one, and the no-docker-socket,
// no-db-credential and no-model-key compose tests read the rendered services.
//
// ── restart: unless-stopped, AND NOTHING SPAWNS THEM AT RUNTIME (§1, §6.2) ──
// Every participant is a standing container Docker keeps up; `bun smoke`
// starts them from the host and exits, and `bun smoke:down` stops them with
// the rest of the project. No `depends_on`: a participant is a client of the
// API exactly like a third party's deployment, and it rides out an API restart
// by retrying (scripts/agent/participant/main.ts).
//
// ── NAMES ───────────────────────────────────────────────────────────────────
// A service is named from its kind and member (`participant-agent-athena`);
// compose prefixes the instance's project, so the container name carries the
// instance, the kind and the member. Labels carry the same three facts plus the
// spoof generation (§6.4), which is how `listRunningParticipants` finds them
// again without any file of its own.
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { ROUTES } from "@robotmoney/contract";
import type { ParticipantKind, RosterEntry, RunningParticipant } from "./swarm/credential-file.ts";
import { isDbCredentialKey, looksLikeConnectionString } from "./db-credential-keys.ts";
import { JUDGE_CLIENT_ENV } from "../agent/participant/judge-client.ts";
import { INFERENCE_KEY_ENV, INFERENCE_URL_ENV, INFERENCE_WIRE_ID_ENV, TAKE_COMMAND_ENV } from "../agent/participant/take-runner.ts";

/** Label every participant container carries, so a boot can find them again. */
export const PARTICIPANT_LABEL = "robotmoney.participant";
export const PARTICIPANT_KIND_LABEL = "robotmoney.participant.kind";
export const PARTICIPANT_NAME_LABEL = "robotmoney.participant.name";
/** The spoof generation (§6.4) a container was started from; empty for the file's own key. */
export const PARTICIPANT_GENERATION_LABEL = "robotmoney.participant.generation";

/** The entrypoint every participant image runs (the backend image, which carries it). */
export const PARTICIPANT_COMMAND: readonly string[] = Object.freeze(["bun", "run", "scripts/agent/participant/main.ts"]);

/**
 * The one-shot an AGENT runs per take (take-runner.ts `RM_TAKE_COMMAND`): the
 * authoring program shipped in the same image. An agent refuses to boot
 * without one (main.ts), so every rendered agent carries it.
 */
export const PARTICIPANT_TAKE_COMMAND: readonly string[] = Object.freeze(["bun", "run", "scripts/agent/participant/author-take.ts"]);

/** Everything the renderer needs besides the roster. No secret travels here. */
export interface ParticipantRenderOptions {
  /** The deployment instance (§1.1), carried as a label. */
  readonly instance: string;
  /** Where each participant's env file is written: the instance's `participants/` directory. */
  readonly envDir: string;
  /** Compose-internal API base, e.g. `http://api:8787`. */
  readonly apiUrl: string;
  /** The stack's `RM_ENV`, so a judge applies the acceptance model rules of its host. */
  readonly rmEnv: string;
  /**
   * The model participants call, as the vendor's REST endpoint spells it (no
   * `opencode/` prefix), and that endpoint. Resolved once by the boot from the
   * single selection signal (model-registry.ts `resolveAgentModel`).
   */
  readonly inference: { readonly wireId: string; readonly baseUrl: string };
  /** The image build every participant service uses. */
  readonly build: { readonly context: string; readonly dockerfile: string };
}

/** One rendered compose service (the fields the overlay carries). */
export interface ParticipantService {
  build: { context: string; dockerfile: string };
  command: string[];
  env_file: string[];
  labels: Record<string, string>;
  restart: "unless-stopped";
  logging: { driver: "json-file"; options: { "max-size": string; "max-file": string } };
}

/** The renderer's output: the compose overlay and the env file each service reads. */
export interface RenderedParticipants {
  /** `{ services: { <name>: … } }`, ready to be written as the participants overlay. */
  readonly compose: { services: Record<string, ParticipantService> };
  /** Env-file path → its exact contents. Each holds ONE participant's secrets. */
  readonly envFiles: Readonly<Record<string, string>>;
  /** Service name → the roster entry it runs, in the roster's order. */
  readonly services: ReadonlyArray<{ service: string; name: string; kind: ParticipantKind; generation?: string }>;
}

/** A compose service name for one participant: kind, then the member's handle. */
export function participantServiceName(kind: ParticipantKind, name: string): string {
  const handle = name.trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^[-_.]+|[-_.]+$/g, "");
  if (handle === "") throw new Error(`participant name "${name}" has no character a compose service name can carry`);
  return `participant-${kind}-${handle}`;
}

/**
 * The non-secret and secret settings ONE participant container receives, by
 * env name. Every name here is one scripts/agent/participant/main.ts (or the
 * judge client it dispatches to) reads; nothing else reaches the container.
 */
export function participantEnv(entry: RosterEntry, options: ParticipantRenderOptions): Record<string, string> {
  const identity = JSON.stringify({ publicKeyB64: entry.credential.publicKeyB64, privateJwk: entry.credential.privateJwk });
  const env: Record<string, string> = {
    RM_API_URL: options.apiUrl,
    RM_ENV: options.rmEnv,
    RM_PARTICIPANT_KIND: entry.kind,
    RM_MEMBER_NAME: entry.name,
    RM_MEMBER_ID: entry.credential.memberId,
    RM_MEMBER_TOKEN: entry.credential.bearer,
    RM_MEMBER_IDENTITY: identity,
    // D52: this participant's OWN model key, from its own entry.
    [INFERENCE_KEY_ENV]: entry.credential.modelKey,
  };
  if (entry.kind === "agent") {
    env[TAKE_COMMAND_ENV] = JSON.stringify(PARTICIPANT_TAKE_COMMAND);
    env[INFERENCE_URL_ENV] = options.inference.baseUrl;
    env[INFERENCE_WIRE_ID_ENV] = options.inference.wireId;
  } else {
    // The judge client's own names, read from it rather than spelled twice.
    env[JUDGE_CLIENT_ENV.model] = options.inference.wireId;
    env[JUDGE_CLIENT_ENV.endpoint] = options.inference.baseUrl;
  }
  if (entry.generation !== undefined) env.RM_SPOOF_GENERATION_ID = entry.generation;
  return env;
}

/**
 * A key a participant must never be handed. A participant holds no database
 * credential and no Docker socket (§3), and no service token: those belong to
 * `api`, the pipeline worker, `system-scheduler`, `analytics-producer` and the
 * operator.
 */
function forbiddenParticipantKey(key: string, value: string): string | null {
  if (isDbCredentialKey(key) || /DATABASE_URL|POSTGRES|^PG/i.test(key) || looksLikeConnectionString(value)) {
    return "a database credential";
  }
  if (/^(DOCKER_|CONTAINER_HOST$)/i.test(key) || /(docker|podman|containerd)\.sock/i.test(value)) return "a Docker socket";
  if (/_TOKEN_FILE$|^ANALYTICS_TOKEN|^SCHEDULER_TOKEN|^RM_OPERATOR_TOKEN/i.test(key)) return "a service token";
  return null;
}

/**
 * One env file's text. Every value is single-quoted, which compose reads
 * literally — no `$` interpolation and no `#` comment — so a key or a JSON JWK
 * reaches the container exactly as the credential file holds it. A value that
 * a single-quoted line cannot carry (a quote or a line break) refuses, naming
 * the key and never the value.
 */
export function envFileText(env: Readonly<Record<string, string>>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error(`participant env key ${key} is not a plain upper-case name`);
    if (/['\r\n]/.test(value)) {
      throw new Error(`participant env ${key} carries a quote or a line break, which an env file cannot hold literally`);
    }
    lines.push(`${key}='${value}'`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Render the participant services for a roster: exactly one service per
 * entry, N agents and M judges giving N+M services.
 *
 * Pure: it computes the overlay and the env files' text and writes nothing
 * (`writeParticipantFiles` writes them). The same roster renders the same
 * output, and an entry's service holds that entry's credential and no other.
 *
 * Refusals: two entries that would share a service name; an env key that would
 * hand a participant a database credential, a Docker socket or a service
 * token; a value an env file cannot carry literally.
 */
export function renderParticipantServices(
  entries: readonly RosterEntry[],
  options: ParticipantRenderOptions,
): RenderedParticipants {
  const services: Record<string, ParticipantService> = {};
  const envFiles: Record<string, string> = {};
  const index: Array<{ service: string; name: string; kind: ParticipantKind; generation?: string }> = [];
  for (const entry of entries) {
    const service = participantServiceName(entry.kind, entry.name);
    if (services[service]) throw new Error(`two roster entries render the same participant service ${service}`);
    const env = participantEnv(entry, options);
    for (const [key, value] of Object.entries(env)) {
      const forbidden = forbiddenParticipantKey(key, value);
      if (forbidden) throw new Error(`participant ${service} would receive ${forbidden} (${key}); a participant holds none (spec §3)`);
    }
    const envFile = join(options.envDir, `${options.instance}.${service}.env`);
    envFiles[envFile] = envFileText(env);
    services[service] = {
      build: { context: options.build.context, dockerfile: options.build.dockerfile },
      command: [...PARTICIPANT_COMMAND],
      env_file: [envFile],
      labels: {
        "robotmoney.instance": options.instance,
        [PARTICIPANT_LABEL]: "1",
        [PARTICIPANT_KIND_LABEL]: entry.kind,
        [PARTICIPANT_NAME_LABEL]: entry.name,
        [PARTICIPANT_GENERATION_LABEL]: entry.generation ?? "",
      },
      restart: "unless-stopped",
      logging: { driver: "json-file", options: { "max-size": "10m", "max-file": "3" } },
    };
    index.push({ service, name: entry.name, kind: entry.kind, ...(entry.generation === undefined ? {} : { generation: entry.generation }) });
  }
  return { compose: { services }, envFiles, services: index };
}

/**
 * Write the rendered env files (0600, in a 0700 directory, each staged and
 * renamed so a reader never sees half a file) and the overlay. The overlay is
 * JSON, which compose reads as YAML.
 */
export function writeParticipantFiles(rendered: RenderedParticipants, envDir: string, overlayPath: string): void {
  mkdirSync(envDir, { recursive: true, mode: 0o700 });
  chmodSync(envDir, 0o700);
  for (const [path, text] of Object.entries(rendered.envFiles)) {
    const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    const fd = openSync(temp, "wx", 0o600);
    try {
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      renameSync(temp, path);
    } catch (error) {
      rmSync(temp, { force: true });
      throw error;
    }
  }
  writeFileSync(overlayPath, `${JSON.stringify(rendered.compose, null, 2)}\n`, { mode: 0o600 });
}

/** How this module reaches Docker: an argv in, the exit code and output back. */
export type DockerRun = (args: string[]) => { exitCode: number; stdout: string; stderr: string };

/**
 * The participant containers of `project` that exist now — running, restarting
 * or stopped — read from Docker by label. A container Docker reports is a
 * participant this host started; one stopped by hand is still one, so it is
 * listed and reconciliation decides about it.
 *
 * Refusals: Docker cannot be asked. An unknown running set is not an empty one
 * (the same rule as the credential file: absence of an answer is never an
 * instruction), so this throws rather than returning `[]`.
 */
export function listRunningParticipants(project: string, run: DockerRun): RunningParticipant[] {
  const r = run([
    "ps", "-a",
    "--filter", `label=com.docker.compose.project=${project}`,
    "--filter", `label=${PARTICIPANT_LABEL}=1`,
    "--format", `{{.Names}}\t{{.Label "${PARTICIPANT_KIND_LABEL}"}}\t{{.Label "${PARTICIPANT_NAME_LABEL}"}}\t{{.Label "${PARTICIPANT_GENERATION_LABEL}"}}`,
  ]);
  if (r.exitCode !== 0) {
    throw new Error(`could not ask Docker which participants of ${project} are running: ${r.stderr.trim() || `exit ${r.exitCode}`}`);
  }
  const out: RunningParticipant[] = [];
  for (const line of r.stdout.split("\n")) {
    if (line.trim() === "") continue;
    const [containerName = "", kind = "", name = "", generation = ""] = line.split("\t");
    if (kind !== "agent" && kind !== "judge") {
      throw new Error(`participant container ${containerName} carries no participant kind label; refusing to guess what it is`);
    }
    out.push({ name, kind, containerName, ...(generation === "" ? {} : { generation }) });
  }
  return out.sort((a, b) => `${a.kind}:${a.name}`.localeCompare(`${b.kind}:${b.name}`));
}

/**
 * The database's role for every member, as the running API reports it on the
 * admin members route (`swarm_members.role`), for credential-file.ts's role
 * check (spec §6.1, D52). Read with the operator's service token (§3), over
 * HTTP: this process holds no database credential of its own at this phase.
 *
 * Refusals: the route does not answer 200 with a `members` list. The roles
 * decide whether the boot may start anyone, so an unknown answer is never
 * read as "no members".
 */
export async function fetchMemberRoles(
  apiUrl: string,
  operatorToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ReadonlyMap<string, { role: string }>> {
  const res = await fetchImpl(`${apiUrl.replace(/\/+$/, "")}${ROUTES.swarm.admin.members}`, {
    headers: { "X-Automation-Token": operatorToken },
  });
  if (!res.ok) throw new Error(`${ROUTES.swarm.admin.members} answered HTTP ${res.status}; the roster's roles cannot be checked, so no participant is started`);
  const body = (await res.json()) as { members?: { id?: unknown; role?: unknown }[] };
  if (!Array.isArray(body.members)) throw new Error(`${ROUTES.swarm.admin.members} answered without a members list`);
  const roles = new Map<string, { role: string }>();
  for (const m of body.members) {
    if (typeof m?.id === "string" && typeof m.role === "string") roles.set(m.id, { role: m.role });
  }
  return roles;
}

/** What `applyParticipantPlan` needs to run compose for the participants overlay. */
export interface ApplyParticipantsOptions {
  /** The instance's compose project. */
  readonly project: string;
  /** The stack's compose files, with the participants overlay LAST. */
  readonly composeFiles: readonly string[];
  readonly run: DockerRun;
}

/**
 * Apply a reconciliation plan: stop (and remove) every container the plan
 * stops, THEN bring the desired services up. Stop-then-start (§6.4): two
 * containers for one member, one on each key, would both poll for the same
 * session.
 *
 * `desired` is every service the roster renders — the plan's `start` and
 * `keep` — and `docker compose up -d --no-deps` over them starts the missing
 * ones and leaves an unchanged running one exactly as it is (same container,
 * same start time). `--no-deps` keeps the application services out of it.
 *
 * Refusals: any Docker failure throws, naming the step; what was stopped stays
 * stopped and the journal records the phase as failed, so a rerun reconciles
 * again from what is running.
 */
export function applyParticipantPlan(
  plan: { stop: readonly RunningParticipant[] },
  desired: readonly string[],
  options: ApplyParticipantsOptions,
): void {
  if (plan.stop.length > 0) {
    const names = plan.stop.map((p) => p.containerName);
    const stopped = options.run(["rm", "-f", ...names]);
    if (stopped.exitCode !== 0) throw new Error(`stopping participants ${names.join(", ")} failed: ${stopped.stderr.trim()}`);
  }
  if (desired.length === 0) return;
  // `--env-file /dev/null` as on every compose call: compose would otherwise
  // read the checkout's `.env` for interpolation (scripts/stack/config.ts).
  const up = options.run([
    "compose", "--env-file", "/dev/null", "-p", options.project, ...options.composeFiles.flatMap((f) => ["-f", f]),
    "up", "-d", "--no-deps", "--build", ...desired,
  ]);
  if (up.exitCode !== 0) throw new Error(`starting participants ${desired.join(", ")} failed: ${up.stderr.trim().slice(-2000)}`);
}
