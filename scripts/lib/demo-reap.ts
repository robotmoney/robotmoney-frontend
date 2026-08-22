// Label-driven reaper for errant containers and Compose networks left behind by
// the stack families in scripts/stack/naming.ts. Pure decision logic + an
// injectable Docker runner keep every guard provable without a daemon.
//
// WHY THIS EXISTS — the incident, 2026-07-29. e2e run 30406428674 was CANCELLED
// mid-boot. The demo boot step owns its own `docker compose down`, so killing it
// meant teardown never ran and the whole stack survived. The `if: always()`
// backstop step then ran `demo:clean`, which removes VOLUMES only — it found the
// run's pgdata volume still referenced by a live container, LOUDLY SKIPPED it,
// and exited 0:
//
//     [demo:clean] found 1 demo volume(s):
//     [demo:clean] SKIPPED 1 volume(s) (left intact):
//       ⚠ rmdemo_ci_30406428674_1_pgdata — in use (a container still
//         references it): volume is in use - [676c43de5091...]
//
// The step reported SUCCESS while the leak persisted. That leaked api container
// then held host port 48787 — the cloudflared origin for
// stage.robotmoney-labs.dev — for over an hour and broke the operator's demo.
// Two structural gaps produced it:
//
//   1. Nothing ever ran `docker compose down` for the project outside the boot
//      process itself (fixed in the workflows + the demo-clean exit code).
//   2. NOTHING REAPED ORPHANS FROM PRIOR RUNS, so any leak was permanent. This
//      host had accumulated stale containers up to four days old. That is the
//      gap this module closes.
//
// SELECTION IS BY LABEL, NEVER BY NAME SUBSTRING. Commit c0d34f4 put
// `robotmoney.env=ci|local` + `robotmoney.env.hash=<hash>` on every container
// this repo starts precisely so a sweeper can say "everything from CI" without
// pattern-matching a name. A name-substring match on a host that also serves the
// live site is an outage waiting to happen: `rm_demo_stack_*` (the standing
// stage demo) and `rm_ci_stack_*` (a CI run) differ by a prefix that one sloppy
// glob erases.
//
// THREE GUARDS, applied before anything is removed (see planReap):
//
//   G1 ACTIVE PROJECT — the project named in .agents/demo-state.json is never
//      touched, whatever its age or class.
//   G2 LIVE PROJECT   — a non-CI project with a running container that is either
//      healthcheck-healthy or publishing a host port is never touched, whatever
//      its age. This exists because the state file G1 reads CAN BE STALE: on this
//      host today it pointed at a dead project while a DIFFERENT stack served
//      traffic on 48787. Belt and braces.
//   G3 SELF          — under GitHub Actions, containers carrying THIS job's
//      env hash are never touched. The age threshold already covers them, but a
//      clock skew must not be able to make a job reap its own stack.
//
// G2 deliberately does NOT extend to `robotmoney.env=ci` containers, and that is
// the whole point rather than an oversight: a CI container cannot be a standing
// demo by construction, and the e2e job's own ceiling is 105 minutes, so a
// CI-labelled container that is still running past the (>= 105 min) age
// threshold IS the leak — refusing to reap it because it looks healthy would
// reproduce run 30406428674 exactly. Every such removal says so out loud.
import { existsSync, readFileSync } from "node:fs";
import {
  CI_PROJECT_PREFIX,
  ENV_CLASS_LABEL,
  ENV_HASH_LABEL,
  LOCAL_PROJECT_PREFIX,
  MANAGED_NETWORK_LABEL,
  PROJECT_LABEL,
  ROLE_LABEL,
  TWIN_ROLE,
  type EnvironmentClass,
} from "../stack/naming.ts";
import { listDemoVolumes, removeDemoVolumes, type DockerRunner } from "./demo-volumes.ts";

// Compose stamps this on the networks (and containers) it creates. It is
// docker's own label, not ours — which is exactly why it is the right key for
// finding the `<project>_default` network after its containers are gone, rather
// than reconstructing the network NAME from the project name.
export const COMPOSE_PROJECT_LABEL = "com.docker.compose.project";

/** Which env classes a sweep considers. `all` = every managed resource. */
export type EnvClassSelector = EnvironmentClass | "all";

export interface ReapContainer {
  id: string;
  name: string;
  /** robotmoney.demo.project — the compose project this belongs to. */
  project: string | null;
  /** robotmoney.env — "ci" or "local". */
  envClass: string | null;
  /** robotmoney.env.hash — identifies the ENVIRONMENT, not the run's contents. */
  envHash: string | null;
  /** Parsed creation time, or null when docker gave us something we can't read. */
  createdAt: Date | null;
  /** The raw string we tried to parse, for the loud "unknown age" message. */
  createdRaw: string;
  running: boolean;
  /** Healthcheck says healthy (docker renders it as "Up 3 hours (healthy)"). */
  healthy: boolean;
  /** Publishes at least one host port, e.g. "0.0.0.0:48787->8787/tcp". */
  publishesHostPort: boolean;
  /**
   * robotmoney.demo.role — what this container does inside its project, or null
   * for the ordinary serving containers. Only `twin` is set today, and only G2
   * reads it: a twin publishes a host port without serving anything, so counting
   * it as proof of life would pin a dead project forever.
   */
  role: string | null;
  status: string;
}

export interface ReapVerdict {
  container: ReapContainer;
  reap: boolean;
  /** Human reason, printed for EVERY container — reaped or kept. Never silent. */
  reason: string;
}

export interface ReapNetwork {
  id: string;
  name: string;
  project: string | null;
  composeProject: string | null;
  envClass: string | null;
  envHash: string | null;
  managed: string | null;
  createdAt: Date | null;
  createdRaw: string;
  attachedContainerIds: string[];
}

export interface ReapNetworkVerdict {
  network: ReapNetwork;
  reap: boolean;
  reason: string;
}

export interface ReapPlan {
  verdicts: ReapVerdict[];
  /** Containers to remove, in listing order. */
  doomed: ReapContainer[];
  /** Distinct non-null projects every doomed container belongs to. */
  doomedProjects: string[];
  networkVerdicts: ReapNetworkVerdict[];
  /** Managed networks safe to remove after doomed containers have gone. */
  doomedNetworks: ReapNetwork[];
}

export interface PlanOptions {
  now: Date;
  olderThanMs: number;
  /** G1: projects that must never be reaped (from .agents/demo-state.json). */
  activeProjects?: string[];
  /** G3: this job's own env hash, under GitHub Actions only. */
  selfEnvHash?: string;
}

// ── Parsing ─────────────────────────────────────────────────────────────────

// docker renders timestamps two ways depending on the surface: `docker ps
// --format json` gives "2026-07-29 02:19:17 +0000 UTC", `docker inspect` gives
// RFC3339Nano. Both are accepted; anything else returns null and the container
// is KEPT with a loud "unknown age" reason. A zone is REQUIRED — assuming UTC
// for a zone-less stamp could misjudge an age by up to 13 hours, and a reaper
// that guesses is a reaper that deletes the wrong thing.
export function parseDockerTimestamp(raw: string): Date | null {
  const t = (raw ?? "").trim();
  if (!t) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?\s*(Z|[+-]\d{2}:?\d{2})/.exec(t);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, frac, zone] = m;
  const millis = frac ? Number(frac.slice(0, 3).padEnd(3, "0")) : 0;
  let epoch = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), millis);
  if (zone !== "Z") {
    const z = /^([+-])(\d{2}):?(\d{2})$/.exec(zone!);
    if (!z) return null;
    const offsetMs = (Number(z[2]) * 60 + Number(z[3])) * 60_000 * (z[1] === "-" ? -1 : 1);
    epoch -= offsetMs;
  }
  return Number.isFinite(epoch) ? new Date(epoch) : null;
}

// `--older-than 6h`. Deliberately a SMALL grammar (<int><s|m|h|d>) with no
// silent fallback: a typo throws rather than quietly becoming "0", which would
// turn the reaper into "delete everything".
export function parseDuration(raw: string): number {
  const m = /^(\d+)(s|m|h|d)$/.exec((raw ?? "").trim());
  if (!m) {
    throw new Error(`invalid duration ${JSON.stringify(raw)} — expected <integer><s|m|h|d>, e.g. 90m or 6h`);
  }
  const n = Number(m[1]);
  const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "s" | "m" | "h" | "d"];
  return n * unit;
}

export function formatAge(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)}h`;
  return `${(ms / 86_400_000).toFixed(1)}d`;
}

// One line of `docker ps --format json`. Labels arrive as a flat comma-joined
// "k=v,k2=v2" string, same shape as `docker volume ls` (see demo-volumes.ts).
export function parseContainerLine(line: string): ReapContainer | null {
  const t = line.trim();
  if (!t || !t.startsWith("{")) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(t) as Record<string, unknown>;
  } catch {
    return null;
  }
  const names = typeof obj.Names === "string" ? obj.Names : Array.isArray(obj.Names) ? obj.Names.join(",") : "";
  const name = names.split(",")[0]?.trim().replace(/^\//, "") ?? "";
  const id = typeof obj.ID === "string" ? obj.ID : typeof obj.Id === "string" ? obj.Id : "";
  if (!id && !name) return null;

  const labels = new Map<string, string>();
  for (const pair of String(obj.Labels ?? "").split(",")) {
    const eq = pair.indexOf("=");
    if (eq > 0) labels.set(pair.slice(0, eq).trim(), pair.slice(eq + 1));
  }

  const status = String(obj.Status ?? "");
  // `State` only exists on docker >= 23; fall back to the rendered Status so an
  // older CLI degrades to a correct answer rather than "nothing is running"
  // (which would make G2 vacuous — a silent loss of a guard).
  const state = String(obj.State ?? "");
  const running = state ? state === "running" : /^Up\b/.test(status);
  const createdRaw = String(obj.CreatedAt ?? "");
  const ports = String(obj.Ports ?? "");

  return {
    id: id || name,
    name,
    project: labels.get(PROJECT_LABEL) ?? null,
    envClass: labels.get(ENV_CLASS_LABEL) ?? null,
    envHash: labels.get(ENV_HASH_LABEL) ?? null,
    createdAt: parseDockerTimestamp(createdRaw),
    createdRaw,
    running,
    healthy: /\(healthy\)/i.test(status),
    publishesHostPort: /:\d+->/.test(ports),
    role: labels.get(ROLE_LABEL) ?? null,
    status,
  };
}

// ── Listing ─────────────────────────────────────────────────────────────────

/**
 * Every container carrying our env label, optionally narrowed to one class.
 * `--filter label=robotmoney.env` (key existence) is the "all" case, so a
 * container we never labelled is not even a candidate.
 *
 * A docker/daemon failure THROWS. A silent empty list here would read exactly
 * like "no leaks", which is the failure mode this whole module exists to end.
 */
export function listLabeledContainers(run: DockerRunner, envClass: EnvClassSelector = "all"): ReapContainer[] {
  const filter = envClass === "all" ? `label=${ENV_CLASS_LABEL}` : `label=${ENV_CLASS_LABEL}=${envClass}`;
  const r = run(["ps", "-a", "--filter", filter, "--format", "json"]);
  if (r.exitCode !== 0) {
    throw new Error(`docker ps failed (exit ${r.exitCode}): ${r.stderr.trim() || r.stdout.trim()}`);
  }
  const out: ReapContainer[] = [];
  for (const line of r.stdout.split("\n")) {
    const c = parseContainerLine(line);
    if (c) out.push(c);
  }
  return out;
}

function labelsFromRecord(value: unknown): Map<string, string> {
  const labels = new Map<string, string>();
  if (!value || typeof value !== "object" || Array.isArray(value)) return labels;
  for (const [key, labelValue] of Object.entries(value as Record<string, unknown>)) {
    if (typeof labelValue === "string") labels.set(key, labelValue);
  }
  return labels;
}

/**
 * Enumerate networks carrying our explicit managed-network label, then inspect
 * each one. `docker network ls` is only candidate discovery; inspect is the
 * authoritative source for identity, creation time, and live attachments.
 * Any Docker or parse failure throws so an incomplete scan cannot read green.
 */
export function listManagedNetworks(run: DockerRunner, envClass: EnvClassSelector = "all"): ReapNetwork[] {
  const args = ["network", "ls", "--filter", `label=${MANAGED_NETWORK_LABEL}=1`];
  if (envClass !== "all") args.push("--filter", `label=${ENV_CLASS_LABEL}=${envClass}`);
  args.push("--format", "{{.ID}}");
  const listed = run(args);
  if (listed.exitCode !== 0) {
    throw new Error(`docker network ls failed (exit ${listed.exitCode}): ${listed.stderr.trim() || listed.stdout.trim()}`);
  }

  const networks: ReapNetwork[] = [];
  for (const id of listed.stdout.split("\n").map((line) => line.trim()).filter(Boolean)) {
    networks.push(inspectManagedNetwork(run, id));
  }
  return networks;
}

function inspectManagedNetwork(run: DockerRunner, id: string): ReapNetwork {
  const inspected = run(["network", "inspect", id]);
  if (inspected.exitCode !== 0) {
    throw new Error(`docker network inspect ${id} failed (exit ${inspected.exitCode}): ${inspected.stderr.trim() || inspected.stdout.trim()}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(inspected.stdout);
  } catch {
    throw new Error(`docker network inspect ${id} returned invalid JSON`);
  }
  const obj = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    throw new Error(`docker network inspect ${id} returned no network object`);
  }
  const record = obj as Record<string, unknown>;
  const labels = labelsFromRecord(record.Labels);
  const attached = record.Containers && typeof record.Containers === "object" && !Array.isArray(record.Containers)
    ? Object.keys(record.Containers as Record<string, unknown>)
    : [];
  const createdRaw = typeof record.Created === "string" ? record.Created : "";
  return {
    id: typeof record.Id === "string" ? record.Id : id,
    name: typeof record.Name === "string" ? record.Name : "",
    project: labels.get(PROJECT_LABEL) ?? null,
    composeProject: labels.get(COMPOSE_PROJECT_LABEL) ?? null,
    envClass: labels.get(ENV_CLASS_LABEL) ?? null,
    envHash: labels.get(ENV_HASH_LABEL) ?? null,
    managed: labels.get(MANAGED_NETWORK_LABEL) ?? null,
    createdAt: parseDockerTimestamp(createdRaw),
    createdRaw,
    attachedContainerIds: attached,
  };
}

// ── G1 input: the active demo ───────────────────────────────────────────────

export interface ActiveProjectRead {
  projects: string[];
  /** Loud, human-readable note about WHY the list is what it is. Always printed. */
  note: string;
}

/**
 * The project named by `.agents/demo-state.json`, if any. Takes the path so a
 * test can point it at a fixture.
 *
 * A missing or malformed state file is a WARNING, never a throw and never a
 * silent empty: without it G1 is gone and only G2 stands between the sweep and
 * an operator's demo, which the caller must be told. It is also why G2 exists at
 * all — this file was observed STALE on this host on 2026-07-29, naming a dead
 * project while a different stack served :48787.
 */
export function readActiveProjects(stateFile: string): ActiveProjectRead {
  if (!existsSync(stateFile)) {
    return { projects: [], note: `no ${stateFile} — G1 (active-project guard) has nothing to protect; G2 (live-project guard) still applies` };
  }
  try {
    const parsed = JSON.parse(readFileSync(stateFile, "utf8")) as { project?: unknown };
    if (typeof parsed.project === "string" && parsed.project.trim()) {
      return { projects: [parsed.project.trim()], note: `G1 protects project=${parsed.project.trim()} (from ${stateFile})` };
    }
    return { projects: [], note: `WARNING: ${stateFile} carries no "project" field — G1 protects nothing this run` };
  } catch (err) {
    return { projects: [], note: `WARNING: could not read ${stateFile} (${err instanceof Error ? err.message : String(err)}) — G1 protects nothing this run` };
  }
}

// ── Planning (PURE — no docker, no clock, no filesystem) ────────────────────

// Containers are grouped by PROJECT, not judged individually, because the guards
// are project-scoped facts: "the api container is healthy" protects its postgres
// sibling too. An unlabelled-project container is its own group (the \0 prefix
// cannot collide with a compose project name, which is [a-z0-9][a-z0-9_-]*).
function groupKey(c: ReapContainer): string {
  return c.project ?? ` unlabelled:${c.id}`;
}

/**
 * Decide the fate of every candidate. Pure: `now` is injected, guards are
 * arguments. Every container gets a verdict WITH a reason — kept containers are
 * reported just as loudly as removed ones, because "the reaper found nothing"
 * and "the reaper refused to act" are different facts and must read differently.
 */
export function planReap(containers: ReapContainer[], opts: PlanOptions, networks: ReapNetwork[] = []): ReapPlan {
  const active = new Set(opts.activeProjects ?? []);
  const groups = new Map<string, ReapContainer[]>();
  for (const c of containers) {
    const k = groupKey(c);
    const list = groups.get(k);
    if (list) list.push(c);
    else groups.set(k, [c]);
  }

  const byId = new Map<string, ReapVerdict>();
  for (const [, members] of groups) {
    const project = members[0]!.project;
    const isCi = members.some((m) => m.envClass === "ci");

    // G1 — the active demo, named by .agents/demo-state.json.
    if (project && active.has(project)) {
      for (const c of members) {
        byId.set(c.id, { container: c, reap: false, reason: `G1 active demo project (.agents/demo-state.json names ${project})` });
      }
      continue;
    }

    // G3 — our own environment, under GitHub Actions.
    const selfHash = opts.selfEnvHash;
    if (selfHash && members.some((m) => m.envHash === selfHash)) {
      for (const c of members) {
        byId.set(c.id, { container: c, reap: false, reason: `G3 this job's own environment (robotmoney.env.hash=${selfHash})` });
      }
      continue;
    }

    // G2 — a live, serving NON-CI project. See this file's header for why `ci`
    // is exempt: a CI container older than the threshold is the leak, and the
    // state file that G1 trusts has already been observed stale on this host.
    if (!isCi) {
      // A twin is EXCLUDED from the liveness evidence, not from the reap. It
      // publishes a host port because the stack's containers dial it, never
      // because anything is being served — so a twin that outlived its stack
      // would otherwise read as "project is live" and protect itself, and every
      // other container in the project, from every future reap.
      const live = members.find((m) => m.role !== TWIN_ROLE && m.running && (m.healthy || m.publishesHostPort));
      if (live) {
        const why = live.healthy ? "healthcheck healthy" : "publishing a host port";
        for (const c of members) {
          byId.set(c.id, { container: c, reap: false, reason: `G2 project is live and serving (${live.name} is running, ${why}) — state files go stale, running containers do not` });
        }
        continue;
      }
    }

    // Age is the last gate, per container.
    for (const c of members) {
      if (!c.createdAt) {
        byId.set(c.id, { container: c, reap: false, reason: `unknown age — docker reported CreatedAt ${JSON.stringify(c.createdRaw)}, which this parser does not accept; never guessing` });
        continue;
      }
      const age = opts.now.getTime() - c.createdAt.getTime();
      if (age < opts.olderThanMs) {
        byId.set(c.id, { container: c, reap: false, reason: `younger than the threshold (age ${formatAge(age)} < ${formatAge(opts.olderThanMs)})` });
        continue;
      }
      const stillRunning = c.running
        ? ` — STILL RUNNING (${c.status}); no CI job outlives the threshold, so this is a leak, not work in progress`
        : "";
      byId.set(c.id, { container: c, reap: true, reason: `age ${formatAge(age)} >= ${formatAge(opts.olderThanMs)}${stillRunning}` });
    }
  }

  // Preserve the input order so output is stable and diffable.
  const verdicts = containers.map((c) => byId.get(c.id)!).filter(Boolean);
  const doomed = verdicts.filter((v) => v.reap).map((v) => v.container);
  const doomedIds = new Set(doomed.map((container) => container.id));
  const networkVerdicts: ReapNetworkVerdict[] = networks.map((network) => {
    const identityProblem = managedNetworkIdentityProblem(network);
    if (identityProblem) return { network, reap: false, reason: identityProblem };
    if (active.has(network.project!)) {
      return { network, reap: false, reason: `G1 active demo project (.agents/demo-state.json names ${network.project})` };
    }
    if (opts.selfEnvHash && network.envHash === opts.selfEnvHash) {
      return { network, reap: false, reason: `G3 this job's own environment (robotmoney.env.hash=${opts.selfEnvHash})` };
    }
    // `docker ps` commonly reports a 12-character id while network inspect uses
    // the full id. Prefix equivalence is Docker's normal identity convention.
    const attachmentIsDoomed = (id: string) => [...doomedIds].some((doomedId) =>
      id === doomedId || id.startsWith(doomedId) || doomedId.startsWith(id));
    const foreignAttachments = network.attachedContainerIds.filter((id) => !attachmentIsDoomed(id));
    if (foreignAttachments.length > 0) {
      return { network, reap: false, reason: `attached to ${foreignAttachments.length} container(s) not selected for removal — preserving an in-use network` };
    }
    if (!network.createdAt) {
      return { network, reap: false, reason: `unknown age — docker reported Created ${JSON.stringify(network.createdRaw)}, which this parser does not accept; never guessing` };
    }
    const age = opts.now.getTime() - network.createdAt.getTime();
    if (age < opts.olderThanMs) {
      return { network, reap: false, reason: `younger than the threshold (age ${formatAge(age)} < ${formatAge(opts.olderThanMs)})` };
    }
    const afterContainers = network.attachedContainerIds.length > 0
      ? `; ${network.attachedContainerIds.length} attached container(s) are selected for removal and zero attachments will be re-verified`
      : "; zero attached containers verified";
    return { network, reap: true, reason: `managed network age ${formatAge(age)} >= ${formatAge(opts.olderThanMs)}${afterContainers}` };
  });
  const doomedNetworks = networkVerdicts.filter((verdict) => verdict.reap).map((verdict) => verdict.network);
  const doomedProjects: string[] = [];
  for (const c of doomed) {
    if (c.project && !doomedProjects.includes(c.project)) doomedProjects.push(c.project);
  }
  // Network-only projects do NOT become volume-reclamation projects. Demo
  // teardown intentionally preserves pgdata; discovering a leaked network is
  // not authorization to erase that persistent database. The historical
  // container-orphan path above retains its existing volume behavior.
  return { verdicts, doomed, doomedProjects, networkVerdicts, doomedNetworks };
}

function managedNetworkIdentityProblem(network: ReapNetwork): string | null {
  if (network.managed !== "1") return `managed ownership label ${MANAGED_NETWORK_LABEL}=1 is missing or changed`;
  if (network.envClass !== "ci" && network.envClass !== "local") return `invalid ${ENV_CLASS_LABEL} label ${JSON.stringify(network.envClass)}`;
  if (!network.envHash || !/^[0-9a-f]{10}$/.test(network.envHash)) return `invalid ${ENV_HASH_LABEL} label ${JSON.stringify(network.envHash)}`;
  if (!network.project) return `missing ${PROJECT_LABEL} label`;
  if (network.composeProject !== network.project) {
    return `${COMPOSE_PROJECT_LABEL}=${JSON.stringify(network.composeProject)} does not match ${PROJECT_LABEL}=${JSON.stringify(network.project)}`;
  }
  const prefix = network.envClass === "ci" ? CI_PROJECT_PREFIX : LOCAL_PROJECT_PREFIX;
  const expected = new RegExp(`^${prefix}_(?:stack|eval|eval-swarm|infra|pgtest)_${network.envHash}$`);
  if (!expected.test(network.project)) return `project ${JSON.stringify(network.project)} does not match its environment labels`;
  if (network.name !== `${network.project}_default`) {
    return `network name ${JSON.stringify(network.name)} does not match managed default network ${JSON.stringify(`${network.project}_default`)}`;
  }
  return null;
}

// ── Execution ───────────────────────────────────────────────────────────────

export interface ReapOutcome {
  removedContainers: string[];
  failedContainers: { name: string; reason: string }[];
  removedNetworks: string[];
  failedNetworks: { name: string; reason: string }[];
  removedVolumes: string[];
  skippedVolumes: { name: string; reason: string }[];
  /** True when nothing was mutated because --dry-run was in force. */
  dryRun: boolean;
}

// Compose networks belonging to a project we just emptied. Found by compose's
// OWN label rather than by rebuilding `<project>_default` from the project name:
// a project with an explicitly-named network would be missed by the name guess,
// and a name guess is the fragile channel this module refuses to use.
export function listProjectNetworks(run: DockerRunner, project: string): string[] {
  const r = run(["network", "ls", "--filter", `label=${COMPOSE_PROJECT_LABEL}=${project}`, "--format", "{{.Name}}"]);
  if (r.exitCode !== 0) return [];
  return r.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
}

/**
 * Execute a plan: containers → their compose networks → their now-unreferenced
 * labelled volumes. That ORDER is load-bearing — a network with an attached
 * container cannot be removed, and a volume referenced by a container cannot be
 * removed (that is precisely the in-use skip run 30406428674 hit).
 *
 * `dryRun` suppresses every MUTATING call and nothing else: the read calls still
 * run, so the printed plan is what would actually happen rather than a guess.
 */
export function executeReap(run: DockerRunner, plan: ReapPlan, opts: { dryRun?: boolean } = {}): ReapOutcome {
  const dryRun = opts.dryRun === true;
  const out: ReapOutcome = {
    removedContainers: [],
    failedContainers: [],
    removedNetworks: [],
    failedNetworks: [],
    removedVolumes: [],
    skippedVolumes: [],
    dryRun,
  };

  for (const c of plan.doomed) {
    if (dryRun) {
      out.removedContainers.push(c.name || c.id);
      continue;
    }
    // By ID, never by name: ids are unambiguous, and `-f` is correct here (unlike
    // for volumes) because the whole point is to stop a container that outlived
    // the job that owned it.
    const r = run(["rm", "-f", c.id]);
    if (r.exitCode === 0) out.removedContainers.push(c.name || c.id);
    else out.failedContainers.push({ name: c.name || c.id, reason: (r.stderr.trim() || r.stdout.trim()).replace(/\s+/g, " ") });
  }

  for (const planned of plan.doomedNetworks) {
    if (dryRun) {
      out.removedNetworks.push(planned.name);
      continue;
    }

    // Re-read immediately before deletion. Container removals happen above,
    // but another process could attach in the meantime or labels could have
    // changed. The actual mutation is allowed only with identity still intact
    // and an authoritative empty Containers map.
    let current: ReapNetwork;
    try {
      current = inspectManagedNetwork(run, planned.id);
    } catch (err) {
      out.failedNetworks.push({ name: planned.name, reason: err instanceof Error ? err.message : String(err) });
      continue;
    }
    const identityProblem = managedNetworkIdentityProblem(current);
    if (identityProblem) {
      out.failedNetworks.push({ name: planned.name, reason: `identity changed before removal: ${identityProblem}` });
      continue;
    }
    if (current.attachedContainerIds.length > 0) {
      out.failedNetworks.push({ name: planned.name, reason: `network acquired ${current.attachedContainerIds.length} attached container(s); preserved` });
      continue;
    }
    const r = run(["network", "rm", current.id]);
    if (r.exitCode === 0) out.removedNetworks.push(current.name);
    else out.failedNetworks.push({ name: current.name, reason: (r.stderr.trim() || r.stdout.trim()).replace(/\s+/g, " ") });
  }

  for (const project of plan.doomedProjects) {
    // Scoped to the reaped project's label — the same discipline demo:clean uses,
    // so a co-tenant project's volume can never be swept up by a wide filter.
    let names: string[];
    try {
      names = listDemoVolumes(run, { project }).map((v) => v.name);
    } catch (err) {
      out.skippedVolumes.push({ name: `(project ${project})`, reason: `could not list volumes: ${err instanceof Error ? err.message : String(err)}` });
      continue;
    }
    if (dryRun) {
      out.removedVolumes.push(...names);
      continue;
    }
    const res = removeDemoVolumes(run, names);
    out.removedVolumes.push(...res.removed);
    out.skippedVolumes.push(...res.skipped);
  }

  return out;
}
