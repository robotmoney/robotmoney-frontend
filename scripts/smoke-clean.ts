// `bun run smoke:clean` — the ONLY command that deletes smoke postgres data.
//
// Why it exists (issue: smoke persistent volumes): teardown stopped deleting
// volumes. `bun run smoke` (SIGTERM/Ctrl-C) and `bun run smoke:down` now run
// `docker compose down` WITHOUT `-v`, so a smoke's pgdata volume survives and a
// reboot resumes from where it left off. Over time that leaks named volumes
// (one per fresh-per-run boot — `rm_smoke_stack_<hash>` locally,
// `rm_ci_stack_<hash>` under Actions; see scripts/stack/naming.ts). This
// command reclaims them.
//
// What it removes: EXACTLY the volumes labeled robotmoney.smoke=1 (applied only by
// docker-compose.smoke.yml — see scripts/lib/smoke-volumes.ts). Never a
// name-substring match. With `--project <name>` it scopes to one run's volume
// (used by CI teardown so a shared self-hosted runner deletes only its own run,
// never a co-tenant standing smoke). Every volume also now carries
// robotmoney.env / robotmoney.env.hash, so a future reaper can scope to "this
// CI job" or "not this operator's shell" without inventing a name pattern.
//
// What it never touches: a `bun run smoke -- --pg-data <host-dir>` boot bind-mounts
// postgres to a HOST directory and creates no named volume, so it cannot appear
// here and this command can never delete your --pg-data data. Manage those dirs
// yourself (they are postgres-owned on disk; remove with your own tooling).
//
// Loud, never silent: it lists every volume it removed, and every one it SKIPPED
// (an in-use volume — a container still references it — is reported, not
// force-removed).
//
// EXIT CODE — deliberately different in the two roles this one script plays
// (incident 2026-07-29, e2e run 30406428674):
//
//   WITH --project (the CI backstop role). Any skip is a FAILURE. The flag is
//   only ever passed by a workflow's `if: always()` teardown, where the project
//   is that run's own and nothing else may legitimately be holding its volume —
//   so a skip means the run leaked. Run 30406428674 is the proof this matters:
//   its boot step was cancelled, its containers survived, this script found the
//   volume in-use, printed "SKIPPED 1 volume(s)" and EXITED 0. The step went
//   green; the leaked api container then held :48787 for an hour and took
//   stage.robotmoney-labs.dev down. A backstop that cannot fail in the exact
//   scenario its own comment cites is not a backstop. This is the repo's
//   loud-skip-never-silent-skip invariant applied to teardown.
//
//   WITHOUT --project (the operator role, bare `bun run smoke:clean`). An in-use
//   volume there almost always means "your smoke is running", which is not an
//   error and must not be reported as one. Skips are printed; exit stays 0.
//
// A docker/daemon failure is non-zero in BOTH roles — "could not look" never
// reads as "nothing to find".
import {
  listSmokeVolumes,
  makeDockerRunner,
  parseInUseContainerIds,
  purgeSmokeEvalContainers,
  removeSmokeVolumes,
} from "./lib/smoke-volumes.ts";

// --project <name> scopes the clean to a single run's volume; omitted = ALL smoke
// volumes on this host. A CLI flag, not an env var (per the smoke's no-per-property
// -env-config rule).
function flagValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}
const project = flagValue("--project")?.trim() || undefined;

const run = makeDockerRunner();
const scope = project ? `project=${project}` : "ALL smoke volumes (label robotmoney.smoke=1)";
console.log(`[smoke:clean] scanning for ${scope}…`);

// Collected across both phases; consulted once at the bottom. `--project` turns
// every entry here into a non-zero exit (see this file's header).
const leaks: string[] = [];

const evalPurged = purgeSmokeEvalContainers(run, { project });
if (evalPurged.removed.length > 0) {
  console.log(`[smoke:clean] purged ${evalPurged.removed.length} zombie evaluation container(s):`);
  for (const n of evalPurged.removed) console.log(`  ✓ ${n}`);
}
if (evalPurged.skipped.length > 0) {
  console.log(`[smoke:clean] SKIPPED ${evalPurged.skipped.length} evaluation container(s):`);
  for (const s of evalPurged.skipped) {
    console.log(`  ⚠ ${s.name} — ${s.reason}`);
    // A `docker rm -f` that fails is abnormal in any role, and in the CI role it
    // is the zombie-container half of the same leak.
    leaks.push(`evaluation container ${s.name} could not be removed: ${s.reason}`);
  }
}

let volumes;
try {
  volumes = listSmokeVolumes(run, { project });
} catch (err) {
  // A missing docker CLI / dead daemon is a loud failure, never a false "clean".
  console.error(`[smoke:clean] could not list volumes: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}

// NOT an early `process.exit(0)`: a container-purge failure recorded above is a
// leak in its own right, and exiting here would hide it behind "no volumes
// found" — the same shape of false green this file's header is about.
if (volumes.length === 0) {
  console.log(`[smoke:clean] no smoke volumes found for ${scope} — nothing to remove.`);
  console.log("[smoke:clean] note: --pg-data host directories are NOT docker volumes and are never listed here.");
} else {
  console.log(`[smoke:clean] found ${volumes.length} smoke volume(s):`);
  for (const v of volumes) console.log(`  - ${v.name}${v.project ? `  (project=${v.project})` : ""}`);
}

const { removed, skipped } = volumes.length === 0
  ? { removed: [] as string[], skipped: [] as { name: string; reason: string }[] }
  : removeSmokeVolumes(run, volumes.map((v) => v.name));

if (removed.length) {
  console.log(`[smoke:clean] removed ${removed.length} volume(s):`);
  for (const n of removed) console.log(`  ✓ ${n}`);
}
if (skipped.length) {
  // Loud skip (never silent): an in-use volume means a container still
  // references it. In the operator role that is usually "your smoke is running";
  // in the CI role it is a leaked stack.
  console.log(`[smoke:clean] SKIPPED ${skipped.length} volume(s) (left intact):`);
  for (const s of skipped) {
    console.log(`  ⚠ ${s.name} — ${s.reason}`);
    const holders = parseInUseContainerIds(s.reason);
    if (holders.length) {
      console.log(`      still referenced by container(s): ${holders.join(", ")}`);
      console.log(`      inspect them with:  docker inspect --format '{{.Name}} {{.State.Status}} {{json .Config.Labels}}' ${holders.join(" ")}`);
    }
    leaks.push(`volume ${s.name} survived: ${s.reason}`);
  }
}
console.log("[smoke:clean] --pg-data host directories are never touched by this command.");

if (project && leaks.length > 0) {
  // The CI-backstop role. Non-zero, with the exact commands that clear it —
  // naming the volume, its holders (printed above) and the two ways out. A
  // teardown failure that only whispers is how run 30406428674 shipped a green
  // step over a live leak.
  console.error("");
  console.error(`[smoke:clean] TEARDOWN INCOMPLETE for project=${project} — ${leaks.length} resource(s) survived:`);
  for (const l of leaks) console.error(`  ✗ ${l}`);
  console.error("[smoke:clean] --project means this is a CI teardown backstop: nothing else may legitimately hold this run's");
  console.error("[smoke:clean] resources, so a skip here is a LEAK on a shared self-hosted runner, not a benign 'still running'.");
  console.error("[smoke:clean] clear it with, in order:");
  console.error(`[smoke:clean]   docker compose -p ${project} down -v --remove-orphans`);
  console.error(`[smoke:clean]   bun run scripts/smoke-clean.ts --project ${project}`);
  console.error("[smoke:clean]   bun run smoke:reap -- --env-class ci --dry-run     # then drop --dry-run");
  process.exit(1);
}

if (leaks.length > 0) {
  // Operator role: report, do not fail. An in-use smoke volume here normally
  // just means the smoke is up; `bun run smoke:down` first if you meant to clean.
  console.log(`[smoke:clean] ${leaks.length} resource(s) were left intact (see above). If you meant to reclaim them, stop the`);
  console.log("[smoke:clean] smoke first (`bun run smoke:down`) and re-run. Exiting 0 — a running smoke is not an error.");
}
