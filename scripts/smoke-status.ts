// `bun smoke:status [--instance <name>]` — what one deployment instance did, and
// what is running now.
//
// Spec §1.4: "At readiness smoke writes a durable receipt … `smoke:status`,
// rollback, and incident work read the receipt when present, the journal when
// not." And after an interrupted replace, `smoke:status` "reports the phase and
// which services are new versus old".
//
// So this command reads three records from the instance's state directory
// (scripts/lib/smoke-state.ts), never from the checkout:
//
//   the RECEIPT  — history: the plan id, schema identity, preflight and
//                  readiness results of the last run that reached readiness;
//   the JOURNAL  — the run in progress or the one that stopped: its phase,
//                  its committed preparation, and each service new or old;
//   the STACK RECORD — the compose project and data location, so the LIVE
//                  state (containers, the ports Docker publishes now) can be
//                  asked of the daemon.
//
// Receipt and journal are history; the daemon is now. They are shown side by
// side, and a daemon that cannot be reached is a line in the report, not a
// failure: the records are still readable, and this is exactly when an
// operator needs them.
//
// It acts on ONE instance: `--instance`, or the only one with state here. It
// writes nothing and takes no lock.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { API_CONTAINER_PORT, dockerClientHostEnv, parseComposePortOutput, portArgs, WEBSITE_SERVER_CONTAINER_PORT } from "./stack/index.ts";
import { instanceComposeEnv } from "./stack/config.ts";
import { buildSmokeLifecycleComposeEnv, dbModeFromState } from "./lib/smoke-lifecycle-env.ts";
import {
  deploymentLockHolder,
  instanceFlag,
  instanceStackProject,
  readStackState,
  selectExistingInstance,
  stateRoot,
  type InstancePaths,
  type StackStateRecord,
} from "./lib/smoke-state.ts";
import { readJournal, readReceipt, type Journal, type Receipt } from "./lib/smoke-journal.ts";

/** Everything the report is computed from. Plain data, so it renders with Docker unreachable. */
export interface StatusInput {
  readonly instance: string;
  readonly stateDir: string;
  readonly journal: Journal | null;
  readonly receipt: Receipt | null;
  readonly stack: StackStateRecord | null;
  /** Running application services → image digest, or `null` when the daemon could not be asked. */
  readonly live: Readonly<Record<string, string>> | null;
  /** The deployment lock's holder, when one is held; `alive` false for a stale lock. */
  readonly lockHolder: { readonly pid: number | null; readonly planId: string | null; readonly alive?: boolean } | null;
  /**
   * With no stack record: the project the instance's boot derives (smoke-state
   * instanceStackProject), which `live` was read from. "No record" is never
   * reported as "nothing running".
   */
  readonly derivedProject?: string;
}

/** One service's standing after a run, relative to what ran when replacement began (§1.4). */
export interface ServiceStanding {
  readonly service: string;
  /** `new`: on an image this run put there. `old`: still on what ran before replacement. */
  readonly standing: "new" | "old" | "not running" | "unknown";
  readonly digest: string | null;
}

/**
 * Which services are new versus old for the journal's plan.
 *
 * NEW: the replace phase committed it, or the daemon shows it on a digest other
 * than the one it ran when replacement began (it was recreated, whether or not
 * the phase got to commit). OLD: still on the digest it ran when replacement
 * began. NOT RUNNING: the daemon shows no container, which after replacement
 * began is a real possibility (§1.4: "no guarantee the old services survive").
 * With the daemon unreachable, a committed replacement is still reported; the
 * rest are unknown.
 */
export function classifyServices(journal: Journal, live: Readonly<Record<string, string>> | null): ServiceStanding[] {
  const replaceRecords = journal.phases.filter((record) => record.phase === "replace");
  const lastReplace = replaceRecords.at(-1);
  const before = lastReplace?.expectations.services ?? journal.phases.at(-1)?.expectations.services ?? {};
  const committed: Record<string, string> = {};
  for (const record of journal.phases) {
    if (record.phase === "plan" && record.step === "resume") continue;
    for (const [service, digest] of Object.entries(record.outcome?.servicesReplaced ?? {})) committed[service] = digest;
  }
  const services = [...new Set([...Object.keys(journal.plan.images), ...Object.keys(before)])].sort();
  return services.map((service) => {
    const now = live?.[service];
    if (live === null) {
      return committed[service] !== undefined
        ? { service, standing: "new", digest: committed[service]! }
        : { service, standing: "unknown", digest: null };
    }
    if (now === undefined) return { service, standing: "not running", digest: null };
    if (lastReplace === undefined) return { service, standing: "old", digest: now };
    if (committed[service] === now) return { service, standing: "new", digest: now };
    if (before[service] === now) return { service, standing: "old", digest: now };
    return { service, standing: "new", digest: now };
  });
}

function short(digest: string | null): string {
  return digest === null ? "-" : digest.replace(/^sha256:/, "").slice(0, 12);
}

/** Whether the receipt is the completion of the journal on disk (or there is no journal to prefer). */
function receiptIsCurrent(journal: Journal | null, receipt: Receipt): boolean {
  if (journal === null || journal.closedAt !== null) return true;
  if (journal.planId !== receipt.planId) return false;
  const last = journal.phases.at(-1);
  return last !== undefined && last.phase === "readiness" && last.status === "committed" && (last.endedAt ?? "") <= receipt.writtenAt;
}

/**
 * The report, as lines. PURE: everything it says comes from {@link StatusInput},
 * which is why `bun test` can execute it with Docker unreachable.
 */
export function statusReport(input: StatusInput): string[] {
  const lines = [`[smoke:status] instance ${input.instance}  (state ${input.stateDir})`];
  const { journal, receipt } = input;
  if (input.lockHolder && input.lockHolder.alive !== false) {
    lines.push(`[smoke:status]   a run is IN PROGRESS: pid ${input.lockHolder.pid ?? "unknown"} holds the deployment lock for plan ${input.lockHolder.planId ?? "unknown"}`);
  } else if (input.lockHolder) {
    lines.push(`[smoke:status]   a STALE deployment lock names pid ${input.lockHolder.pid ?? "unknown"} (plan ${input.lockHolder.planId ?? "unknown"}), which is gone; the next run takes it over`);
  }

  if (receipt !== null && receiptIsCurrent(journal, receipt)) {
    lines.push(`[smoke:status] source: receipt — reached readiness under plan ${receipt.planId} at ${receipt.writtenAt}`);
    const tail = receipt.schema.migrations.at(-1);
    lines.push(`[smoke:status]   schema: manifest ${receipt.schema.manifestHash}; ${receipt.schema.migrations.length} migration(s)${tail ? `, ending ${tail}` : ""}`);
    for (const check of receipt.preflight) lines.push(`[smoke:status]   preflight ${check.check}: ${check.pass ? "pass" : "FAIL"} (${check.detail})`);
    if (receipt.preflight.length === 0) lines.push("[smoke:status]   preflight: this run recorded no preflight check");
    for (const check of receipt.readiness) lines.push(`[smoke:status]   readiness ${check.check}: ${check.pass ? "pass" : "FAIL"} (${check.detail})`);
    for (const service of Object.keys(receipt.images).sort()) {
      const ran = receipt.images[service]!;
      const now = input.live === null ? "daemon unreachable" : input.live[service] === undefined ? "NOT RUNNING now" : input.live[service] === ran ? "running now" : `now on ${short(input.live[service]!)}`;
      lines.push(`[smoke:status]   service ${service}: ${short(ran)} at readiness — ${now}`);
    }
  } else if (journal !== null) {
    const last = journal.phases.at(-1);
    lines.push(
      journal.closedAt !== null
        ? `[smoke:status] source: journal — CLOSED at ${journal.closedAt} (${journal.closeReport ?? "no reason recorded"})`
        : "[smoke:status] source: journal — this deployment is IN PROGRESS or was interrupted (no receipt for it)",
    );
    lines.push(`[smoke:status]   plan ${journal.planId}, opened ${journal.openedAt}`);
    lines.push(
      last === undefined
        ? "[smoke:status]   phase: none has begun"
        : `[smoke:status]   phase: ${last.phase}${last.step === null ? "" : ` (${last.step})`} — ${last.status}${last.reason === null ? "" : ` — ${last.reason}`}`,
    );
    const prepared = journal.phases.filter((r) => r.phase === "prepare" && r.status === "committed").map((r) => r.step ?? "prepare");
    lines.push(`[smoke:status]   committed preparation: ${prepared.length === 0 ? "none" : [...new Set(prepared)].join(", ")}`);
    const migrations = journal.phases.flatMap((r) => r.outcome?.migrationsApplied ?? []);
    if (migrations.length > 0) lines.push(`[smoke:status]   migrations applied by this plan: ${migrations.join(", ")}`);
    const replaceBegan = journal.phases.some((r) => r.phase === "replace");
    lines.push(`[smoke:status]   services (${replaceBegan ? "replacement BEGAN" : "replacement has not begun"}):`);
    for (const s of classifyServices(journal, input.live)) {
      lines.push(`[smoke:status]     ${s.service}: ${s.standing}${s.digest === null ? "" : ` (${short(s.digest)})`}`);
    }
    if (input.live === null) lines.push("[smoke:status]   the daemon could not be asked; live service state is unknown");
    if (receipt !== null) lines.push(`[smoke:status]   last receipt (history): plan ${receipt.planId} reached readiness at ${receipt.writtenAt}`);
  } else {
    lines.push("[smoke:status] No receipt and no journal: this instance has no recorded run.");
  }

  const s = input.stack;
  if (s === null) {
    lines.push(
      input.derivedProject === undefined
        ? "[smoke:status]   no stack record: which containers are this instance's is UNKNOWN"
        : `[smoke:status]   no stack record: live state read from the instance's derived compose project ${input.derivedProject}` +
            (input.live === null ? " (the daemon could not be asked: UNKNOWN)" : `; ${Object.keys(input.live).length} application service(s) running`),
    );
  }
  if (s !== null) {
    const mode = dbModeFromState(s);
    lines.push(`[smoke:status]   compose project ${s.project}  (env ${s.envClass}/${s.envHash}${s.stage ? "; --static-port: the cloudflared origin" : ""})`);
    if (mode === "external") lines.push(`[smoke:status]   pg data: EXTERNAL managed server ${s.databaseUrl} — not this smoke's; smoke:down and smoke:clean cannot touch it`);
    else if (mode === "smoke-twin") lines.push(`[smoke:status]   pg data: TWIN volume ${s.smokeTwinVolume ?? "(unrecorded)"} — a copy of production; reclaim with bun run smoke:clean`);
    else lines.push(`[smoke:status]   pg data: volume ${s.pgVolume ?? `${s.project}_pgdata`}  (kept on smoke:down; reattach: bun smoke --local volume --instance ${input.instance})`);
    if (s.logFile) lines.push(`[smoke:status]   log file: ${s.logFile}`);
  }
  return lines;
}

/** Running application services of `project` → image digest, or `null` when the daemon cannot be asked. */
function liveServices(project: string, env: Record<string, string | undefined>): Record<string, string> | null {
  const dockerEnv = dockerClientHostEnv(env);
  const ps = Bun.spawnSync(
    ["docker", "ps", "-q", "--filter", `label=com.docker.compose.project=${project}`, "--filter", "label=com.docker.compose.oneoff=False"],
    { env: dockerEnv, stdout: "pipe", stderr: "pipe" },
  );
  if (ps.exitCode !== 0) return null;
  const ids = ps.stdout.toString().split("\n").map((l) => l.trim()).filter(Boolean);
  if (ids.length === 0) return {};
  const inspect = Bun.spawnSync(
    ["docker", "inspect", "--format", '{{index .Config.Labels "com.docker.compose.service"}}\t{{.Image}}', ...ids],
    { env: dockerEnv, stdout: "pipe", stderr: "pipe" },
  );
  if (inspect.exitCode !== 0) return null;
  const out: Record<string, string> = {};
  for (const line of inspect.stdout.toString().split("\n")) {
    const [service = "", image = ""] = line.trim().split("\t");
    if (service && service !== "postgres") out[service] = image;
  }
  return out;
}

export function main(argv: readonly string[], env: Record<string, string | undefined>): number {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(scriptDir, "..");
  let paths: InstancePaths;
  let input: StatusInput;
  try {
    paths = selectExistingInstance(stateRoot(env), instanceFlag(argv));
    const instance = paths.dir.split("/").at(-1)!;
    const stack = readStackState(paths);
    // No record is not "none running": a boot killed before it wrote one may
    // have started containers, and its project is fixed by the instance.
    const derivedProject = stack === null ? instanceStackProject(instance, env) : undefined;
    input = {
      instance,
      stateDir: paths.dir,
      journal: readJournal(paths),
      receipt: readReceipt(paths),
      stack,
      live: liveServices(stack?.project ?? derivedProject!, env),
      lockHolder: deploymentLockHolder(paths),
      ...(derivedProject !== undefined ? { derivedProject } : {}),
    };
  } catch (err) {
    console.error(`[smoke:status] ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  for (const line of statusReport(input)) console.log(line);

  // The LIVE ports and containers come from the daemon, never from the record:
  // a record is history, and reporting its port as "the smoke is at :N" sends
  // the operator to a dead or foreign port.
  if (input.stack !== null && input.live !== null) {
    const dockerEnv = {
      ...buildSmokeLifecycleComposeEnv(input.stack, env),
      ...instanceComposeEnv({ name: input.instance, stateDir: paths.dir }),
    };
    const port = (service: string, containerPort: number): number | undefined => {
      const r = Bun.spawnSync(["docker", "compose", "--env-file", "/dev/null", ...portArgs(service, containerPort)], {
        cwd: repoRoot, env: dockerEnv, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      });
      if (r.exitCode !== 0) return undefined;
      try { return parseComposePortOutput(r.stdout.toString(), service, containerPort); } catch { return undefined; }
    };
    const web = port("website-server", WEBSITE_SERVER_CONTAINER_PORT);
    const api = port("api", API_CONTAINER_PORT);
    console.log(`[smoke:status]   now: web ${web === undefined ? "NOT RUNNING" : `http://127.0.0.1:${web}/`}  api ${api === undefined ? "NOT RUNNING" : `:${api}`}`);
    console.log("");
    Bun.spawnSync(["docker", "compose", "--env-file", "/dev/null", "ps"], { cwd: repoRoot, env: dockerEnv, stdout: "inherit", stderr: "inherit" });
  }
  return 0;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2), process.env));
}
