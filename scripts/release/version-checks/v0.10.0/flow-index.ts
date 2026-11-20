// Q39-flow-index/C27-flow-index (PR 1658, migration 0132_flow_index, issue 1693): the deposit-flow index tables exist and
// the indexer lane is idle, not erroring, where its compose keys are unset. Production does not get the FLOW_* keys in
// v0.10.0 (owner, 2026-11-19), so the seeded flow.index schedule stays disabled (backend/src/db/seed.ts) and the
// flow health answers 200 "idle", the data routes 404. Read-only: the ledger and four counts as rm_readonly, the api container's
// environment, and one GET through the public origin.
//
// WHAT IT REQUIRES:
//   - schema_migrations records 0132_flow_index.sql, and flow_index_deployment, flow_index_blocks and flow_index_logs exist;
//   - with FLOW_QUEUE_ADDRESS or FLOW_FUND_ADDRESS unset in the api container (the idle lane): every flow.index schedule is
//     disabled, no flow.index job exists in any state (none failed, none dead), the index holds no block and no log, and
//     GET /api/public/flow/health answers 200 status "idle" with enabled false and the reason "flow index is not configured"
//     (never a 5xx), and one data route (/api/public/flow/vault) answers 404 enabled false;
//   - with both set (a stage that configures the lane): no flow.index job failed or died, and the health route answers
//     200 or 503 with a JSON body, never any other status.
import type { VersionCheck } from "../../version-check.ts";
import { apiEnv } from "./_flow.ts";

export const MIGRATION = "0132_flow_index.sql";
export const TABLES = ["flow_index_deployment", "flow_index_blocks", "flow_index_logs"] as const;

export interface FlowRead {
  readonly ledger: readonly string[];
  readonly tables: readonly string[];
  /** Whether both FLOW_QUEUE_ADDRESS and FLOW_FUND_ADDRESS are non-empty in the api container; null when the container could not be read. */
  readonly configured: boolean | null;
  readonly enabledSchedules: number;
  readonly jobsByStatus: Readonly<Record<string, number>>;
  readonly blocks: number;
  readonly logs: number;
  readonly health: { readonly status: number; readonly state: string | null; readonly reason: string | null } | null;
  /** The dormant data route's status (GET /api/public/flow/vault); null when not read. */
  readonly vaultStatus?: number | null;
}

/** PURE. Why the flow lane is not idle-and-clean for its configuration; empty when it is. */
export function flowProblems(r: FlowRead): string[] {
  const out: string[] = [];
  if (!r.ledger.includes(MIGRATION) && !r.ledger.includes(MIGRATION.replace(/\.sql$/, ""))) out.push(`the ledger does not record ${MIGRATION}`);
  for (const t of TABLES) if (!r.tables.includes(t)) out.push(`table ${t} does not exist`);
  if (r.configured === null) return [...out, "the api container's environment could not be read"];
  const failed = (r.jobsByStatus.failed ?? 0) + (r.jobsByStatus.dead ?? 0);
  if (failed > 0) out.push(`${failed} flow.index job(s) failed or died: the lane is erroring`);
  if (!r.configured) {
    if (r.enabledSchedules > 0) out.push(`${r.enabledSchedules} flow.index schedule(s) are enabled with the FLOW keys unset: the lane would run unconfigured`);
    const jobs = Object.values(r.jobsByStatus).reduce((a, b) => a + b, 0);
    if (jobs > 0) out.push(`${jobs} flow.index job(s) exist with the FLOW keys unset; the lane should be idle`);
    if (r.blocks > 0 || r.logs > 0) out.push(`the index holds ${r.blocks} block(s) and ${r.logs} log(s) with the FLOW keys unset`);
    if (r.health === null) out.push("GET /api/public/flow/health was not read");
    else if (r.health.status !== 200 || r.health.state !== "idle" || r.health.reason !== "flow index is not configured") out.push(`flow health answered ${r.health.status} ${JSON.stringify(r.health.state)} ${JSON.stringify(r.health.reason)}, not 200 "idle" "flow index is not configured"`);
    if (r.vaultStatus !== 404) out.push(`flow vault answered ${r.vaultStatus ?? "nothing"} with the FLOW keys unset, not 404`);
  } else if (r.health === null || (r.health.status !== 200 && r.health.status !== 503)) {
    out.push(`flow health answered ${r.health?.status ?? "nothing"} with the FLOW keys set; only 200 or 503 is a healthy answer`);
  }
  return out;
}

export default (async (ctx) => {
  const db = await ctx.db();
  const ledger = (await db.query<{ name: string }>("SELECT name FROM schema_migrations")).map((x) => x.name);
  const tables = (await db.query<{ t: string }>(`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE 'flow\\_index\\_%'`)).map((x) => x.t);
  const [sched] = await db.query<{ n: string }>("SELECT count(*)::text AS n FROM job_schedules WHERE kind = 'flow.index' AND enabled");
  const jobs = await db.query<{ status: string; n: string }>("SELECT status, count(*)::text AS n FROM jobs WHERE kind = 'flow.index' GROUP BY status");
  const has = (t: string) => tables.includes(t);
  const count = async (t: string): Promise<number> => (has(t) ? Number((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${t}`))[0]?.n ?? 0) : 0);
  const env = apiEnv(ctx);
  const res = await ctx.http(`/api/public/flow/health?rm-v0100-flow=${Date.now()}`);
  let state: string | null = null;
  let reason: string | null = null;
  try {
    const body = JSON.parse(res.text) as { status?: unknown; reason?: unknown };
    state = typeof body.status === "string" ? body.status : null;
    reason = typeof body.reason === "string" ? body.reason : null;
  } catch {
    state = reason = null;
  }
  const vault = await ctx.http(`/api/public/flow/vault?rm-v0100-flow=${Date.now()}`);
  const read: FlowRead = {
    ledger,
    tables,
    configured: env === null ? null : Boolean(env.get("FLOW_QUEUE_ADDRESS")) && Boolean(env.get("FLOW_FUND_ADDRESS")),
    enabledSchedules: Number(sched?.n ?? 0),
    jobsByStatus: Object.fromEntries(jobs.map((j) => [j.status, Number(j.n)])),
    blocks: await count("flow_index_blocks"),
    logs: await count("flow_index_logs"),
    health: { status: res.status, state, reason },
    vaultStatus: vault.status,
  };
  return { found: { ...read, ledger: undefined, migrationRecorded: ledger.includes(MIGRATION) }, problems: flowProblems(read) };
}) satisfies VersionCheck;
