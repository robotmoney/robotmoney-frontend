// `bun run demo:clean` — the ONLY command that deletes demo postgres data.
//
// Why it exists (issue: demo persistent volumes): teardown stopped deleting
// volumes. `bun run demo` (SIGTERM/Ctrl-C) and `bun run demo:down` now run
// `docker compose down` WITHOUT `-v`, so a demo's pgdata volume survives and a
// reboot resumes from where it left off. Over time that leaks named volumes
// (one per fresh-per-run boot — `rm_demo_stack_<hash>` locally,
// `rm_ci_stack_<hash>` under Actions; see scripts/stack/naming.ts). This
// command reclaims them.
//
// What it removes: EXACTLY the volumes labeled robotmoney.demo=1 (applied only by
// docker-compose.demo.yml — see scripts/lib/demo-volumes.ts). Never a
// name-substring match. With `--project <name>` it scopes to one run's volume
// (used by CI teardown so a shared self-hosted runner deletes only its own run,
// never a co-tenant standing demo). Every volume also now carries
// robotmoney.env / robotmoney.env.hash, so a future reaper can scope to "this
// CI job" or "not this operator's shell" without inventing a name pattern.
//
// What it never touches: a `bun run demo -- --pg-data <host-dir>` boot bind-mounts
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
//   WITHOUT --project (the operator role, bare `bun run demo:clean`). An in-use
//   volume there almost always means "your demo is running", which is not an
//   error and must not be reported as one. Skips are printed; exit stays 0.
//
// A docker/daemon failure is non-zero in BOTH roles — "could not look" never
// reads as "nothing to find".
import {
  listDemoVolumes,
  makeDockerRunner,
  parseInUseContainerIds,
  purgeDemoEvalContainers,
  removeDemoVolumes,
} from "./lib/demo-volumes.ts";

// --project <name> scopes the clean to a single run's volume; omitted = ALL demo
// volumes on this host. A CLI flag, not an env var (per the demo's no-per-property
// -env-config rule).
function flagValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}
const project = flagValue("--project")?.trim() || undefined;

const run = makeDockerRunner();
const scope = project ? `project=${project}` : "ALL demo volumes (label robotmoney.demo=1)";
console.log(`[demo:clean] scanning for ${scope}…`);

// Collected across both phases; consulted once at the bottom. `--project` turns
// every entry here into a non-zero exit (see this file's header).
const leaks: string[] = [];

const evalPurged = purgeDemoEvalContainers(run, { project });
if (evalPurged.removed.length > 0) {
  console.log(`[demo:clean] purged ${evalPurged.removed.length} zombie evaluation container(s):`);
  for (const n of evalPurged.removed) console.log(`  ✓ ${n}`);
}
if (evalPurged.skipped.length > 0) {
  console.log(`[demo:clean] SKIPPED ${evalPurged.skipped.length} evaluation container(s):`);
  for (const s of evalPurged.skipped) {
    console.log(`  ⚠ ${s.name} — ${s.reason}`);
    // A `docker rm -f` that fails is abnormal in any role, and in the CI role it
    // is the zombie-container half of the same leak.
    leaks.push(`evaluation container ${s.name} could not be removed: ${s.reason}`);
  }
}

let volumes;
try {
  volumes = listDemoVolumes(run, { project });
} catch (err) {
  // A missing docker CLI / dead daemon is a loud failure, never a false "clean".
  console.error(`[demo:clean] could not list volumes: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}

// NOT an early `process.exit(0)`: a container-purge failure recorded above is a
// leak in its own right, and exiting here would hide it behind "no volumes
// found" — the same shape of false green this file's header is about.
if (volumes.length === 0) {
  console.log(`[demo:clean] no demo volumes found for ${scope} — nothing to remove.`);
  console.log("[demo:clean] note: --pg-data host directories are NOT docker volumes and are never listed here.");
} else {
  console.log(`[demo:clean] found ${volumes.length} demo volume(s):`);
  for (const v of volumes) console.log(`  - ${v.name}${v.project ? `  (project=${v.project})` : ""}`);
}

const { removed, skipped } = volumes.length === 0
  ? { removed: [] as string[], skipped: [] as { name: string; reason: string }[] }
  : removeDemoVolumes(run, volumes.map((v) => v.name));

if (removed.length) {
  console.log(`[demo:clean] removed ${removed.length} volume(s):`);
  for (const n of removed) console.log(`  ✓ ${n}`);
}
if (skipped.length) {
  // Loud skip (never silent): an in-use volume means a container still
  // references it. In the operator role that is usually "your demo is running";
  // in the CI role it is a leaked stack.
  console.log(`[demo:clean] SKIPPED ${skipped.length} volume(s) (left intact):`);
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
console.log("[demo:clean] --pg-data host directories are never touched by this command.");

if (project && leaks.length > 0) {
  // The CI-backstop role. Non-zero, with the exact commands that clear it —
  // naming the volume, its holders (printed above) and the two ways out. A
  // teardown failure that only whispers is how run 30406428674 shipped a green
  // step over a live leak.
  console.error("");
  console.error(`[demo:clean] TEARDOWN INCOMPLETE for project=${project} — ${leaks.length} resource(s) survived:`);
  for (const l of leaks) console.error(`  ✗ ${l}`);
  console.error("[demo:clean] --project means this is a CI teardown backstop: nothing else may legitimately hold this run's");
  console.error("[demo:clean] resources, so a skip here is a LEAK on a shared self-hosted runner, not a benign 'still running'.");
  console.error("[demo:clean] clear it with, in order:");
  console.error(`[demo:clean]   docker compose -p ${project} down -v --remove-orphans`);
  console.error(`[demo:clean]   bun run scripts/demo-clean.ts --project ${project}`);
  console.error("[demo:clean]   bun run demo:reap -- --env-class ci --dry-run     # then drop --dry-run");
  process.exit(1);
}

if (leaks.length > 0) {
  // Operator role: report, do not fail. An in-use demo volume here normally
  // just means the demo is up; `bun run demo:down` first if you meant to clean.
  console.log(`[demo:clean] ${leaks.length} resource(s) were left intact (see above). If you meant to reclaim them, stop the`);
  console.log("[demo:clean] demo first (`bun run demo:down`) and re-run. Exiting 0 — a running demo is not an error.");
}
