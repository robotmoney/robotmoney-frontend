// IO for the gates (twin:gate, prod:gate): docker state, docker logs and
// read-only database queries. Everything here runs ON the host being graded and
// reaches a stack only through its compose project (the instance's stack
// record, scripts/lib/smoke-state.ts), never through a name the gate guesses.
// Nothing here mounts or asks for a Docker socket, a database credential or an
// admin token: it runs `docker` as the operator already does.

import type { RawLine } from "./log-inventory.ts";

/** The label every standing participant container carries (scripts/lib/participant-compose.ts). */
export const PARTICIPANT_KIND_LABEL = "robotmoney.participant.kind";

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
  /** `agent` or `judge` for a standing participant container, else null. */
  participantKind: string | null;
}

/** Every container of a compose project, one-shots included while Docker still has them. */
export function projectContainers(project: string): ContainerState[] {
  const names = sh(["docker", "ps", "-a", "--filter", `label=com.docker.compose.project=${project}`, "--format", "{{.Names}}"])
    .out.split("\n").filter(Boolean);
  return names.map((name) => {
    const r = sh(["docker", "inspect", name, "--format",
      `{{.State.Running}}\t{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}\t{{.RestartCount}}\t{{.State.StartedAt}}\t{{index .Config.Labels "${PARTICIPANT_KIND_LABEL}"}}`]);
    const [running, health, restarts, startedAt, kind] = r.out.trim().split("\t");
    // A `run` container (the typed migrate) exits by design: its logs are read,
    // its running/health state is not graded. A participant is a standing
    // service, so its stderr is simply its container's log.
    return {
      name,
      running: running === "true",
      health: health ?? "?",
      restarts: Number(restarts ?? 0),
      startedAt: startedAt ?? "",
      oneShot: /-run-/.test(name),
      participantKind: kind ? kind : null,
    };
  });
}

/** The container of one compose service of a project (e.g. `api`), or null when there is none. */
export function serviceContainer(project: string, service: string): string | null {
  const r = sh(["docker", "ps", "-a", "--filter", `label=com.docker.compose.project=${project}`, "--filter", `label=com.docker.compose.service=${service}`, "--format", "{{.Names}}"]);
  return r.out.split("\n").filter(Boolean)[0] ?? null;
}

/** `docker logs --timestamps --since` as raw lines (stdout and stderr), timestamp split off. */
export function containerLogs(name: string, since: string): RawLine[] {
  return sh(["docker", "logs", "--timestamps", "--since", since, name]).out.split("\n").filter(Boolean).map((l) => {
    const m = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z) (.*)$/.exec(l);
    return m ? { ts: m[1]!, text: m[2]! } : { ts: null, text: l };
  });
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
  opts: { observeServerDefault?: boolean; statementTimeoutMs?: number } = {},
): T[] {
  // observeServerDefault: open the session WITHOUT forcing read-only, so a
  // `SHOW default_transaction_read_only` reports the SERVER's setting (a forced
  // session would always say "on"). Only for SHOW; it is still a read.
  if (opts.observeServerDefault && !/^\s*SHOW\s+\w+\s*;?\s*$/i.test(query)) throw new Error("observeServerDefault is for a single SHOW statement only");
  const timeout = opts.statementTimeoutMs && Number.isInteger(opts.statementTimeoutMs) && opts.statementTimeoutMs > 0 ? `, statement_timeout: ${opts.statementTimeoutMs}` : "";
  const connection = opts.observeServerDefault ? "{}" : `{ default_transaction_read_only: true${timeout} }`;
  const script =
    'import postgres from "postgres";' +
    `const sql = postgres(process.env.DATABASE_URL, { max: 1, connect_timeout: 15, onnotice: () => {}, connection: ${connection} });` +
    "try { const rows = await sql.unsafe(process.env.GATE_SQL); console.log(JSON.stringify(rows)); } finally { await sql.end({ timeout: 5 }); }";
  const r = sh(["docker", "exec", "-e", `GATE_SQL=${query}`, "-w", "/app", apiContainer, "bun", "-e", script]);
  const line = r.out.split("\n").reverse().find((l) => l.startsWith("["));
  if (r.code !== 0 || !line) throw new Error(`gate query failed in ${apiContainer}: ${r.out.trim().slice(0, 400)}`);
  return JSON.parse(line) as T[];
}

/**
 * A container's configured environment, from `docker inspect` (a read: nothing is exec'd inside it).
 * The standing checks use it for presence and for non-secret settings (a cron). Callers must never print a value.
 */
export function containerEnv(name: string): Record<string, string> | null {
  const r = sh(["docker", "inspect", name, "--format", "{{json .Config.Env}}"]);
  if (r.code !== 0) return null;
  try {
    const list = JSON.parse(r.out.trim()) as string[] | null;
    const out: Record<string, string> = {};
    for (const kv of list ?? []) { const i = kv.indexOf("="); if (i > 0) out[kv.slice(0, i)] = kv.slice(i + 1); }
    return out;
  } catch { return null; }
}
