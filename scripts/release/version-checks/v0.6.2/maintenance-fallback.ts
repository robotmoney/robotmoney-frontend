// V02-maintenance-fallback (PR 1293, migration 0120): rollouts keep the website
// up. Reads, on the target host:
//   - the website-server container's LOADED nginx config (`nginx -T`): /api/
//     answers @maintenance_body on 502/503/504, /api/status/maintenance falls
//     back to /maintenance.json then @maintenance_body, and @maintenance_body
//     returns the 503 JSON maintenance answer (website-server/nginx.conf);
//   - maintenance_windows exists, and rm_app may INSERT into it and never
//     UPDATE, DELETE or TRUNCATE it (an append-only event log);
//   - GET /api/status/maintenance answers 200 through the public origin.
// Not observable from the host: the off-host fallback page is Cloudflare's
// custom error page (ops/cloudflare/offhost-fallback.html), served only when
// the origin itself is unreachable; `found.offhostFallback` says so.
import type { VersionCheck } from "../../version-check.ts";

export interface MaintenanceObservation {
  /** `nginx -T` output, or null when it could not be read. */
  readonly conf: string | null;
  readonly table: { exists: boolean; insert: boolean; update: boolean; delete: boolean; truncate: boolean };
  readonly statusCode: number | null;
}

const RULES: readonly [string, RegExp][] = [
  ["/api/ answers @maintenance_body on 502/503/504", /location\s+\^~\s+\/api\/\s*\{[^}]*error_page\s+502\s+503\s+504\s+=\s+@maintenance_body;/],
  ["/api/status/maintenance falls back to @maintenance_file", /location\s*=\s*\/api\/status\/maintenance\s*\{[^}]*error_page\s+502\s+503\s+504\s+=\s+@maintenance_file;/],
  ["@maintenance_file serves /maintenance.json, else @maintenance_body", /location\s+@maintenance_file\s*\{[^}]*try_files\s+\/maintenance\.json\s+@maintenance_body;/],
  ["@maintenance_body returns the 503 maintenance JSON", /location\s+@maintenance_body\s*\{[^}]*return\s+503\s+'\{"error":"maintenance"/],
];

/** PURE. Every way the shipped maintenance fallback is not in place. */
export function maintenanceProblems(o: MaintenanceObservation): string[] {
  const out: string[] = [];
  if (o.conf === null) out.push("the website-server container's nginx config could not be read (nginx -T)");
  else for (const [what, re] of RULES) if (!re.test(o.conf)) out.push(`nginx config: ${what} is missing`);
  if (!o.table.exists) out.push("maintenance_windows does not exist (migration 0120)");
  else {
    if (!o.table.insert) out.push("rm_app cannot INSERT into maintenance_windows");
    for (const p of ["update", "delete", "truncate"] as const) if (o.table[p]) out.push(`rm_app may ${p.toUpperCase()} maintenance_windows; it is an insert-only event log`);
  }
  if (o.statusCode !== 200) out.push(`GET /api/status/maintenance answered ${o.statusCode ?? "nothing"}, not 200`);
  return out;
}

export default (async (ctx) => {
  const container = `${ctx.project()}-website-server-1`;
  const nginx = ctx.docker(["exec", container, "nginx", "-T"]);
  // nginx -T prints the test verdict on stderr and the config on stdout.
  const conf = nginx.code === 0 ? nginx.stdout : null;
  const db = await ctx.db();
  const [reg] = await db.query<{ exists: boolean }>("SELECT to_regclass('public.maintenance_windows') IS NOT NULL AS exists");
  let table = { exists: reg?.exists === true, insert: false, update: false, delete: false, truncate: false };
  if (table.exists) {
    const [p] = await db.query<{ i: boolean; u: boolean; d: boolean; t: boolean }>(
      "SELECT has_table_privilege('rm_app', 'public.maintenance_windows', 'INSERT') AS i, " +
        "has_table_privilege('rm_app', 'public.maintenance_windows', 'UPDATE') AS u, " +
        "has_table_privilege('rm_app', 'public.maintenance_windows', 'DELETE') AS d, " +
        "has_table_privilege('rm_app', 'public.maintenance_windows', 'TRUNCATE') AS t",
    );
    table = { exists: true, insert: p?.i === true, update: p?.u === true, delete: p?.d === true, truncate: p?.t === true };
  }
  let statusCode: number | null = null;
  try {
    statusCode = (await ctx.http("/api/status/maintenance")).status;
  } catch {
    statusCode = null;
  }
  const observation: MaintenanceObservation = { conf, table, statusCode };
  return {
    found: {
      container,
      nginxT: nginx.code === 0 ? "read" : `exit ${nginx.code}: ${nginx.stderr.trim().slice(0, 200)}`,
      rules: RULES.map(([what, re]) => ({ rule: what, present: conf !== null && re.test(conf) })),
      maintenanceWindows: table,
      statusMaintenance: statusCode,
      offhostFallback: "Cloudflare's custom error page (ops/cloudflare/offhost-fallback.html): served only when the origin is down, so not observable from the host",
    },
    problems: maintenanceProblems(observation),
  };
}) satisfies VersionCheck;
