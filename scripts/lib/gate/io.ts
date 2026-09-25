// IO for the gates (twin:gate, prod:gate): docker state, docker logs, files,
// and read-only database queries. Everything here runs ON the host being
// graded — stage-2 for a twin, the production droplet for production.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { RawLine } from "./log-inventory.ts";

export function sh(cmd: string[]): { code: number; out: string } {
  const p = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode ?? 1, out: `${p.stdout.toString()}${p.stderr.toString()}` };
}

export interface ContainerState {
  name: string;
  running: boolean;
  health: string;
  restarts: number;
  startedAt: string;
  oneShot: boolean;
}

/** Every container of a compose project, one-shots included while Docker still has them. */
export function projectContainers(project: string): ContainerState[] {
  const names = sh(["docker", "ps", "-a", "--filter", `label=com.docker.compose.project=${project}`, "--format", "{{.Names}}"])
    .out.split("\n").filter(Boolean);
  return names.map((name) => {
    const r = sh(["docker", "inspect", name, "--format",
      "{{.State.Running}}\t{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}\t{{.RestartCount}}\t{{.State.StartedAt}}"]);
    const [running, health, restarts, startedAt] = r.out.trim().split("\t");
    // One-shot `run` containers (migrations, member agents) exit by design:
    // their logs are read, their running/health state is not graded.
    return { name, running: running === "true", health: health ?? "?", restarts: Number(restarts ?? 0), startedAt: startedAt ?? "", oneShot: /-run-|member-agent/.test(name) };
  });
}

/** `docker logs --timestamps --since` as raw lines, timestamp split off. */
export function containerLogs(name: string, since: string): RawLine[] {
  return sh(["docker", "logs", "--timestamps", "--since", since, name]).out.split("\n").filter(Boolean).map((l) => {
    const m = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z) (.*)$/.exec(l);
    return m ? { ts: m[1]!, text: m[2]! } : { ts: null, text: l };
  });
}

/** A plain log file (the host driver's tee'd output) as raw lines. */
export function fileLines(path: string): RawLine[] {
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((text) => ({ ts: null, text }));
}

/**
 * Every member container's own stderr for sessions run since `sinceMs`, one
 * source per member. A member container is removed when it exits, and the
 * driver log keeps only a truncated transcript tail, so a member's real failure
 * (an inference timeout, a refused take) exists ONLY in the artifact the driver
 * keeps at `.agents/swarm-sessions/<project>/<session>/<member>/<run>/stderr.log`.
 * On 2026-09-25 a member's "inference timed out after 120000ms" was in no log
 * either gate read.
 */
export function memberSessionLogs(repoRoot: string, project: string, sinceMs: number): { source: string; lines: RawLine[] }[] {
  const root = join(repoRoot, ".agents", "swarm-sessions", project);
  if (!existsSync(root)) return [];
  const byMember = new Map<string, RawLine[]>();
  const dirs = (p: string) => readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  for (const session of dirs(root)) {
    for (const member of dirs(join(root, session))) {
      for (const run of dirs(join(root, session, member))) {
        const file = join(root, session, member, run, "stderr.log");
        if (!existsSync(file) || statSync(file).mtimeMs < sinceMs) continue;
        const lines = fileLines(file);
        byMember.set(member, [...(byMember.get(member) ?? []), ...lines]);
      }
    }
  }
  return [...byMember].map(([member, lines]) => ({ source: `member: ${member}`, lines }));
}

/**
 * Run one SELECT through the boot's own api container, on a session forced
 * READ-ONLY: the gate can never write, whatever it is pointed at. The api
 * container already holds the right DATABASE_URL (the restored twin, or
 * production's rm_app) and the postgres client, so the gate needs no
 * credential of its own. The SQL travels in an env var, never in argv.
 */
export function dbQuery<T = Record<string, unknown>>(
  apiContainer: string,
  query: string,
  opts: { observeServerDefault?: boolean } = {},
): T[] {
  // observeServerDefault: open the session WITHOUT forcing read-only, so a
  // `SHOW default_transaction_read_only` reports the SERVER's setting (a forced
  // session would always say "on"). Only for SHOW; it is still a read.
  if (opts.observeServerDefault && !/^\s*SHOW\s+\w+\s*;?\s*$/i.test(query)) throw new Error("observeServerDefault is for a single SHOW statement only");
  const connection = opts.observeServerDefault ? "{}" : "{ default_transaction_read_only: true }";
  const script =
    'import postgres from "postgres";' +
    `const sql = postgres(process.env.DATABASE_URL, { max: 1, connect_timeout: 15, onnotice: () => {}, connection: ${connection} });` +
    "try { const rows = await sql.unsafe(process.env.GATE_SQL); console.log(JSON.stringify(rows)); } finally { await sql.end({ timeout: 5 }); }";
  const r = sh(["docker", "exec", "-e", `GATE_SQL=${query}`, "-w", "/app", apiContainer, "bun", "-e", script]);
  const line = r.out.split("\n").reverse().find((l) => l.startsWith("["));
  if (r.code !== 0 || !line) throw new Error(`gate query failed in ${apiContainer}: ${r.out.trim().slice(0, 400)}`);
  return JSON.parse(line) as T[];
}
