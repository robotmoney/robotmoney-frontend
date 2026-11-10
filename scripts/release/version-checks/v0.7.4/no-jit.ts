// Q39-no-jit/C27-no-jit (PR 1595, issue 1579): the api's database pools open every session with
// jit off. Read-only.
//
// WHY. On production an unanalyzed one-row swarm_dormancy_baseline pushed readSeatSilence's plan
// past the JIT cost thresholds. Each GET /api/swarm/members/<ref> and each admin page then spent
// 1 to 3 s compiling, which crossed the request pool's statement timeout when every house agent
// asked at once (the six-hour cycle). PR 1595 sets `jit: off` as a startup parameter on every pool
// backend/src/db/client.ts builds (NO_JIT). The timeouts came and went with the planner's
// statistics, so a latency read would pass on v0.7.3 most of the time and proves nothing.
//
// WHAT IT READS. Inside each running api container (docker exec, the image's own code and its own
// DATABASE_URL, rm_app): `SHOW jit` on the general pool of /app/src/db/client.ts, which makePool
// builds exactly as it builds the request and batch pools, and `SHOW jit` on a plain connection
// with no startup parameter (the server default, the control). The pool must answer `off`. A
// v0.7.3 image's pool answers the server default. A server whose default is already off passes
// either way: `found.serverDefault` says so, and the check then proves only that the pool is off.
// One extra connection each, for under a second. Nothing is written.
import type { VersionCheck } from "../../version-check.ts";

/** The marker the in-container script prints before its JSON result. */
export const RESULT_MARKER = "NO_JIT_RESULT ";

/** Run by `bun -e` in the api container's working directory (/app), where client.ts and postgres resolve. */
export const IN_CONTAINER_SCRIPT = [
  "const kill = setTimeout(() => { console.error('no-jit: timed out after 30 s'); process.exit(3); }, 30000);",
  "const { sql } = await import('/app/src/db/client.ts');",
  "const pool = (await sql`SHOW jit`)[0].jit;",
  "const postgres = (await import('postgres')).default;",
  "const control = postgres(process.env.DATABASE_URL, { max: 1, connect_timeout: 10, onnotice: () => {} });",
  "const serverDefault = (await control`SHOW jit`)[0].jit;",
  "await control.end({ timeout: 5 });",
  "await sql.end({ timeout: 5 });",
  "clearTimeout(kill);",
  `console.log(${JSON.stringify(RESULT_MARKER)} + JSON.stringify({ pool, serverDefault }));`,
  "process.exit(0);",
].join("\n");

export interface ContainerRead {
  readonly container: string;
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** PURE. The `{ pool, serverDefault }` the script printed, or null when it printed none. */
export function parseResult(stdout: string): { pool: string; serverDefault: string } | null {
  const line = stdout.split("\n").find((l) => l.startsWith(RESULT_MARKER));
  if (!line) return null;
  try {
    const v = JSON.parse(line.slice(RESULT_MARKER.length)) as { pool?: unknown; serverDefault?: unknown };
    return typeof v.pool === "string" && typeof v.serverDefault === "string" ? { pool: v.pool, serverDefault: v.serverDefault } : null;
  } catch {
    return null;
  }
}

/** PURE. Why the api's pools do not open with jit off; empty when every api container's pool does. */
export function noJitProblems(reads: readonly ContainerRead[]): string[] {
  if (reads.length === 0) return ["no running api container in the instance's compose project"];
  const problems: string[] = [];
  for (const r of reads) {
    const result = parseResult(r.stdout);
    if (r.code !== 0 || result === null) {
      problems.push(`${r.container}: the jit read did not run (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
      continue;
    }
    if (result.pool !== "off") problems.push(`${r.container}: the api's pool runs with jit ${result.pool}, not off (server default ${result.serverDefault}): the client before PR 1595 is still running`);
  }
  return problems;
}

export default (async (ctx) => {
  const project = ctx.project();
  const names = ctx
    .docker(["ps", "--filter", `label=com.docker.compose.project=${project}`, "--filter", "label=com.docker.compose.service=api", "--format", "{{.Names}}"])
    .stdout.split("\n").map((s) => s.trim()).filter(Boolean).sort();
  const reads: ContainerRead[] = names.map((container) => ({ container, ...ctx.docker(["exec", container, "bun", "-e", IN_CONTAINER_SCRIPT]) }));
  return {
    found: { project, containers: reads.map((r) => ({ container: r.container, exit: r.code, result: parseResult(r.stdout) })) },
    problems: noJitProblems(reads),
  };
}) satisfies VersionCheck;
