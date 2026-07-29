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
// force-removed). Exit code is non-zero only on a docker/daemon failure, so
// "nothing to remove" is a clean exit 0.
import { listDemoVolumes, makeDockerRunner, purgeDemoEvalContainers, removeDemoVolumes } from "./lib/demo-volumes.ts";

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

const evalPurged = purgeDemoEvalContainers(run, { project });
if (evalPurged.removed.length > 0) {
  console.log(`[demo:clean] purged ${evalPurged.removed.length} zombie evaluation container(s):`);
  for (const n of evalPurged.removed) console.log(`  ✓ ${n}`);
}
if (evalPurged.skipped.length > 0) {
  console.log(`[demo:clean] SKIPPED ${evalPurged.skipped.length} evaluation container(s):`);
  for (const s of evalPurged.skipped) console.log(`  ⚠ ${s.name} — ${s.reason}`);
}

let volumes;
try {
  volumes = listDemoVolumes(run, { project });
} catch (err) {
  // A missing docker CLI / dead daemon is a loud failure, never a false "clean".
  console.error(`[demo:clean] could not list volumes: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}

if (volumes.length === 0) {
  console.log(`[demo:clean] no demo volumes found for ${scope} — nothing to remove.`);
  console.log("[demo:clean] note: --pg-data host directories are NOT docker volumes and are never listed here.");
  process.exit(0);
}

console.log(`[demo:clean] found ${volumes.length} demo volume(s):`);
for (const v of volumes) console.log(`  - ${v.name}${v.project ? `  (project=${v.project})` : ""}`);

const { removed, skipped } = removeDemoVolumes(run, volumes.map((v) => v.name));

if (removed.length) {
  console.log(`[demo:clean] removed ${removed.length} volume(s):`);
  for (const n of removed) console.log(`  ✓ ${n}`);
}
if (skipped.length) {
  // Loud skip (never silent): an in-use volume means a demo is still running on
  // it — stop that demo (`bun run demo:down`) before cleaning, or leave it.
  console.log(`[demo:clean] SKIPPED ${skipped.length} volume(s) (left intact):`);
  for (const s of skipped) console.log(`  ⚠ ${s.name} — ${s.reason}`);
}
console.log("[demo:clean] --pg-data host directories are never touched by this command.");
