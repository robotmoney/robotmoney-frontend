// Shared demo-volume discovery + deletion. Single source of truth for what
// counts as "one of the demo's postgres volumes", used by BOTH the operator CLI
// (scripts/demo-clean.ts) and the CI teardown path (scripts/lib/demo-main.ts).
//
// Lifecycle context (issue: demo persistent volumes): teardown no longer deletes
// the pgdata volume — `bun run demo` (SIGTERM/Ctrl-C) and `bun run demo:down`
// both run `docker compose down` WITHOUT `-v`, so demo data survives a reboot.
// Deleting a demo volume is now an EXPLICIT act, and this module is the only code
// that does it. Everything here is side-effect free at import time (no docker
// calls run until a function is invoked) so demo-main.ts can import it safely.
//
// Namespacing (docker-compose.demo.yml): every demo pgdata volume carries the
// label robotmoney.demo=1 (plus robotmoney.demo.project=<project>). We filter by
// LABEL, never by name-substring — a name like "…_pgdata" could belong to a
// non-demo stack, but the label is applied only by our overlay.
//
// A `--pg-data <host-dir>` boot bind-mounts postgres to a host directory and
// creates NO named volume (verified empirically: docker compose does not create a
// declared-but-unreferenced named volume). So a bind-mode run has nothing here to
// find, and this module can never delete a user's --pg-data host directory.

export const DEMO_VOLUME_LABEL = "robotmoney.demo=1";
export const DEMO_VOLUME_PROJECT_LABEL = "robotmoney.demo.project";

export interface DemoVolume {
  name: string;
  /** Value of the robotmoney.demo.project label, if present. */
  project: string | null;
}

export interface CleanResult {
  removed: string[];
  /** Volumes we refused to delete, each with a loud human reason (e.g. in-use). */
  skipped: { name: string; reason: string }[];
}

// Minimal shape of `docker`'s spawn result we depend on — lets tests inject a
// fake runner instead of shelling out to a real daemon.
export interface DockerRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}
export type DockerRunner = (args: string[]) => DockerRunResult;

// Default runner: shell out to the real docker CLI. `env` pins DOCKER_* / PATH so
// the same daemon the demo used is targeted.
export function makeDockerRunner(env: Record<string, string> = process.env as Record<string, string>): DockerRunner {
  return (args: string[]): DockerRunResult => {
    const r = Bun.spawnSync(["docker", ...args], { env, stdout: "pipe", stderr: "pipe" });
    return {
      exitCode: r.exitCode,
      stdout: new TextDecoder().decode(r.stdout),
      stderr: new TextDecoder().decode(r.stderr),
    };
  };
}

// Parse one line of `docker volume ls --format json`. Labels come back as a flat
// comma-joined "k=v,k2=v2" string; pull the project label out of it.
export function parseVolumeLine(line: string): DemoVolume | null {
  const t = line.trim();
  if (!t) return null;
  const obj = JSON.parse(t) as { Name?: string; Labels?: string };
  if (!obj.Name) return null;
  const labels = new Map<string, string>();
  for (const pair of (obj.Labels ?? "").split(",")) {
    const eq = pair.indexOf("=");
    if (eq > 0) labels.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
  return { name: obj.Name, project: labels.get(DEMO_VOLUME_PROJECT_LABEL) ?? null };
}

// List every demo pgdata volume (label robotmoney.demo=1). Pass a project to
// scope to a single run's volume (CI teardown deletes ONLY its own run's volume,
// never a co-tenant standing demo's). A missing docker CLI / daemon fails loudly
// (throws) — never a silent empty list that would mask a leak.
export function listDemoVolumes(run: DockerRunner, opts: { project?: string } = {}): DemoVolume[] {
  const args = ["volume", "ls", "--filter", `label=${DEMO_VOLUME_LABEL}`];
  if (opts.project) args.push("--filter", `label=${DEMO_VOLUME_PROJECT_LABEL}=${opts.project}`);
  args.push("--format", "json");
  const r = run(args);
  if (r.exitCode !== 0) {
    throw new Error(`docker volume ls failed (exit ${r.exitCode}): ${r.stderr.trim() || r.stdout.trim()}`);
  }
  const out: DemoVolume[] = [];
  for (const line of r.stdout.split("\n")) {
    const v = parseVolumeLine(line);
    if (v) out.push(v);
  }
  return out;
}

// Delete the named volumes, one at a time so a single in-use volume never aborts
// the rest. An in-use volume is SKIPPED with a loud reason (never force-removed:
// `-f` on an in-use volume still fails, and force-removing a volume out from under
// a running container is exactly the foot-gun this refuses to do). Any other
// non-zero exit is surfaced as a skip reason too — nothing fails silently.
export function removeDemoVolumes(run: DockerRunner, names: string[]): CleanResult {
  const removed: string[] = [];
  const skipped: { name: string; reason: string }[] = [];
  for (const name of names) {
    const r = run(["volume", "rm", name]);
    if (r.exitCode === 0) {
      removed.push(name);
      continue;
    }
    const msg = (r.stderr.trim() || r.stdout.trim()).replace(/\s+/g, " ");
    const reason = /volume is in use/i.test(msg) ? `in use (a container still references it): ${msg}` : msg;
    skipped.push({ name, reason });
  }
  return { removed, skipped };
}

// Purge dynamic member-agent evaluation containers (e.g. `<project>-member-agent-eval-*`).
// These are spawned dynamically during demo runs and must be force-removed before network/stack
// teardown to prevent zombie containers from holding compose networks in use.
export function purgeDemoEvalContainers(
  run: DockerRunner,
  opts: { project?: string } = {},
): CleanResult {
  const r = run(["ps", "-a", "--format", "json"]);
  if (r.exitCode !== 0) {
    return { removed: [], skipped: [] };
  }

  const foundNames = new Set<string>();
  for (const line of r.stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let names: string[] = [];
    if (trimmed.startsWith("{")) {
      try {
        const obj = JSON.parse(trimmed) as { Names?: string | string[]; Name?: string };
        if (typeof obj.Names === "string") {
          names = obj.Names.split(",").map((s) => s.trim());
        } else if (Array.isArray(obj.Names)) {
          names = obj.Names.map((s) => String(s).trim());
        } else if (obj.Name) {
          names = [obj.Name.trim()];
        }
      } catch {
        names = [trimmed];
      }
    } else {
      names = [trimmed];
    }

    for (const name of names) {
      const cleanName = name.replace(/^\//, "");
      if (!cleanName) continue;
      let matches = false;
      if (opts.project) {
        const prefix = `${opts.project}-member-agent-eval-`;
        matches = cleanName.startsWith(prefix) || cleanName.includes(prefix);
      } else {
        matches = cleanName.includes("-member-agent-eval-") || cleanName.includes("member-agent-eval-");
      }
      if (matches) {
        foundNames.add(cleanName);
      }
    }
  }

  const removed: string[] = [];
  const skipped: { name: string; reason: string }[] = [];

  for (const name of foundNames) {
    const res = run(["rm", "-f", name]);
    if (res.exitCode === 0) {
      removed.push(name);
    } else {
      const msg = (res.stderr.trim() || res.stdout.trim()).replace(/\s+/g, " ");
      skipped.push({ name, reason: msg || `exit code ${res.exitCode}` });
    }
  }

  return { removed, skipped };
}

