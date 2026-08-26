// `bun run smoke:reap` — sweep errant containers and Compose networks left
// behind by any stack family, selecting by LABEL and never by name substring.
//
// WHY (incident, 2026-07-29): e2e run 30406428674 was cancelled mid-boot, its
// in-process `docker compose down` never ran, and NOTHING ELSE ever reaped a
// prior run's orphans — so the leak was permanent. The leaked api container held
// host port 48787 (the cloudflared origin for stage.robotmoney-labs.dev) for
// over an hour and broke the operator's smoke, and the host had by then
// accumulated stale containers up to four days old. The full root-cause writeup
// and the three guards live in scripts/lib/smoke-reap.ts's header.
//
// SAFE POSTURE: run `--dry-run` first. It performs every READ and no mutation,
// so what it prints is exactly what a real run would remove.
//
//   bun run smoke:reap -- --dry-run                    # see the plan, change nothing
//   bun run smoke:reap -- --dry-run --older-than 30m   # widen the window, still read-only
//   bun run smoke:reap                                  # reap, default threshold 6h
//   bun run smoke:reap -- --env-class ci                # CI leftovers only (what e2e.yml runs)
//
// Flags (all CLI ARGUMENTS, never env vars — same rule as `--pg-data` /
// `--stage`, so nothing a shell exports can silently widen a sweep):
//   --older-than <dur>   only resources older than this. <int><s|m|h|d>, default 6h.
//   --env-class <c>      ci | local | all (default all). `ci` can never match the
//                        standing stage smoke or an operator's shell.
//   --dry-run            print the plan, mutate nothing.
//
// Exit codes: 0 when the sweep completed (including "nothing to reap" — finding
// and clearing a prior run's orphan is SUCCESS, not a regression to fail a PR
// over). Non-zero when docker itself failed, an argument was invalid, or a
// removal we ATTEMPTED did not succeed — an attempted-and-failed removal is a
// surviving leak and must never read as green.
import { join } from "node:path";
import {
  executeReap,
  formatAge,
  listLabeledContainers,
  listManagedNetworks,
  parseDuration,
  planReap,
  readActiveProjects,
  type EnvClassSelector,
} from "./lib/smoke-reap.ts";
import { makeDockerRunner } from "./lib/smoke-volumes.ts";
import { isGithubActions, resolveStackEnvironment } from "./stack/naming.ts";

const repoRoot = join(import.meta.dir, "..");
const stateFile = join(repoRoot, ".agents", "smoke-state.json");

function flagValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}
const dryRun = process.argv.includes("--dry-run");

// The default is DELIBERATELY longer than the e2e job's own ceiling (105
// minutes, e2e.yml `timeout-minutes`). A threshold shorter than the longest
// legitimate job would let one CI run reap another's live stack — the age gate
// is only a safety property if no honest container can reach it.
const DEFAULT_OLDER_THAN = "6h";
let olderThanMs: number;
const olderThanRaw = flagValue("--older-than") ?? DEFAULT_OLDER_THAN;
try {
  olderThanMs = parseDuration(olderThanRaw);
} catch (err) {
  console.error(`[smoke:reap] ${err instanceof Error ? err.message : err}`);
  process.exit(2);
}

const envClassRaw = (flagValue("--env-class") ?? "all").trim();
if (envClassRaw !== "ci" && envClassRaw !== "local" && envClassRaw !== "all") {
  console.error(`[smoke:reap] invalid --env-class ${JSON.stringify(envClassRaw)} — expected ci | local | all`);
  process.exit(2);
}
const envClass = envClassRaw as EnvClassSelector;

// G3: under Actions the env hash is STABLE for every container started anywhere
// inside one job (scripts/stack/naming.ts), so it identifies "our own stack"
// exactly. Locally it is drawn from a fresh random seed on every call, so it
// identifies nothing and must NOT be used — a random hash would match no
// container and merely give a false sense of a guard.
const selfEnvHash = isGithubActions(process.env) ? resolveStackEnvironment(process.env).hash : undefined;

const active = readActiveProjects(stateFile);

console.log(`[smoke:reap] ${dryRun ? "DRY RUN — nothing will be removed" : "REAPING"}`);
console.log(`[smoke:reap]   scope:      robotmoney.env=${envClass === "all" ? "<any> (label present)" : envClass}`);
console.log(`[smoke:reap]   threshold:  older than ${formatAge(olderThanMs)} (--older-than ${olderThanRaw})`);
console.log(`[smoke:reap]   ${active.note}`);
if (selfEnvHash) console.log(`[smoke:reap]   G3 protects this job's own environment (robotmoney.env.hash=${selfEnvHash})`);

const run = makeDockerRunner();

let containers;
let networks;
try {
  containers = listLabeledContainers(run, envClass);
  // Deliberately independent of the container result: interrupted Compose
  // teardown commonly leaves `<project>_default` after every container is gone.
  networks = listManagedNetworks(run, envClass);
} catch (err) {
  // A dead daemon or incomplete discovery must never read as "no leaks".
  console.error(`[smoke:reap] could not enumerate managed resources: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}

if (containers.length === 0 && networks.length === 0) {
  console.log("[smoke:reap] no labelled containers or managed networks in scope — nothing to consider.");
  process.exit(0);
}

const plan = planReap(containers, {
  now: new Date(),
  olderThanMs,
  activeProjects: active.projects,
  selfEnvHash,
}, networks);

// Loud on BOTH sides: every candidate is accounted for with a reason, so "the
// reaper found nothing" and "the reaper refused to act" never look alike.
const kept = plan.verdicts.filter((v) => !v.reap);
console.log(`[smoke:reap] considered ${containers.length} labelled container(s): ${plan.doomed.length} to remove, ${kept.length} kept.`);
if (kept.length) {
  console.log("[smoke:reap] KEPT:");
  for (const v of kept) console.log(`  · ${v.container.name} [${v.container.envClass ?? "?"}/${v.container.envHash ?? "?"}] — ${v.reason}`);
}
const keptNetworks = plan.networkVerdicts.filter((verdict) => !verdict.reap);
console.log(`[smoke:reap] considered ${networks.length} managed network(s): ${plan.doomedNetworks.length} to remove, ${keptNetworks.length} kept.`);
if (keptNetworks.length) {
  console.log("[smoke:reap] KEPT NETWORKS:");
  for (const verdict of keptNetworks) console.log(`  · ${verdict.network.name || verdict.network.id} — ${verdict.reason}`);
}
if (plan.doomedNetworks.length) {
  console.log(`[smoke:reap] ${dryRun ? "WOULD REMOVE NETWORKS" : "REMOVING NETWORKS"}:`);
  for (const verdict of plan.networkVerdicts.filter((candidate) => candidate.reap)) {
    console.log(`  ✗ ${verdict.network.name} [${verdict.network.envClass ?? "?"}/${verdict.network.envHash ?? "?"}] project=${verdict.network.project ?? "<none>"} — ${verdict.reason}`);
  }
}
if (plan.doomed.length) {
  console.log(`[smoke:reap] ${dryRun ? "WOULD REMOVE" : "REMOVING"}:`);
  for (const v of plan.verdicts.filter((x) => x.reap)) {
    console.log(`  ✗ ${v.container.name} [${v.container.envClass ?? "?"}/${v.container.envHash ?? "?"}] project=${v.container.project ?? "<none>"} — ${v.reason}`);
  }
}

const outcome = executeReap(run, plan, { dryRun });

if (outcome.removedContainers.length) {
  console.log(`[smoke:reap] ${dryRun ? "would remove" : "removed"} ${outcome.removedContainers.length} container(s): ${outcome.removedContainers.join(", ")}`);
}
if (outcome.removedNetworks.length) {
  console.log(`[smoke:reap] ${dryRun ? "would remove" : "removed"} ${outcome.removedNetworks.length} compose network(s): ${outcome.removedNetworks.join(", ")}`);
}
if (outcome.removedVolumes.length) {
  console.log(`[smoke:reap] ${dryRun ? "would reclaim" : "reclaimed"} ${outcome.removedVolumes.length} volume(s): ${outcome.removedVolumes.join(", ")}`);
}
if (!outcome.removedContainers.length && !outcome.removedNetworks.length && !outcome.removedVolumes.length) {
  console.log("[smoke:reap] nothing to reap — every candidate was protected by a guard or is younger than the threshold.");
}

let failed = 0;
for (const f of outcome.failedContainers) {
  console.error(`[smoke:reap] FAILED to remove container ${f.name} — ${f.reason}`);
  failed++;
}
for (const f of outcome.failedNetworks) {
  console.error(`[smoke:reap] FAILED to remove network ${f.name} — ${f.reason}`);
  failed++;
}
for (const s of outcome.skippedVolumes) {
  console.error(`[smoke:reap] FAILED to reclaim volume ${s.name} — ${s.reason}`);
  failed++;
}
if (failed > 0) {
  console.error(`[smoke:reap] ${failed} removal(s) were attempted and did NOT succeed — the leak survives. Exiting non-zero.`);
  process.exit(1);
}

if (dryRun) console.log("[smoke:reap] dry run complete — nothing was changed. Re-run without --dry-run to apply.");
process.exit(0);
