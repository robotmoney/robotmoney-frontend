#!/usr/bin/env bun
// `bun run soak:checks` — the CUMULATIVE standing soak checks (runbook R8.a to R8.y), read-only,
// run beside `twin:gate` and `prod:gate` at every gate. Standing-runbook rows SR.7 and SW.2.
//
// WHY THIS EXISTS. The 0.5.x line ran `upgrades/0.5.3-to-0.5.4/soak-checks.sh` at every gate.
// It never reached main, so a 0.6 gate had no tool for the standing invariants (issue 1179,
// blocker B16). This is that script, ported to the instance model. The rule is unchanged: checks
// are cumulative, and one is dropped only by a recorded owner decision (standing runbook §6).
//
// WHICH STACK. Exactly like the gates (scripts/lib/gate/stack.ts): the deployment instance's own
// stack record, selected by `--instance <name>` or the only instance with state on this host. The
// compose project comes from that record. Every query runs through that project's api container on a
// session forced READ-ONLY (scripts/lib/gate/io.ts dbQuery). Logs are container logs. Settings come
// from `docker inspect`. No SMOKE_PROJECT, no --db, no Docker socket in any container, no admin
// token, no superuser, no credential read. Nothing is ever written to a database.
//
// BASELINE. R8.d (growth) and R8.p (schema_migrations) compare with what the instance looked like at
// READY. Run once with `--record` at READY: the baseline is saved in the instance's state directory
// (`soak-baseline.json`). Without a baseline R8.p FAILS and R8.d is UNVERIFIED.
//
//   bun run soak:checks --instance NAME --since ISO [--full] [--record] [--report FILE.md]
//                       [--base-url URL] [--opened-at-from YYYY-MM-DD]
//
// `--since` is T0, the instant the stack under test became READY (default: the api container's start).
// `--full` also runs the slow full vintage join (R8.l; about 2 min on production).
// Exit 0 when nothing FAILs. A WARN is not a pass: read it.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { containerEnv, containerLogs, dbQuery, projectContainers, serviceContainer, sh } from "./lib/gate/io.ts";
import { resolveGateStack } from "./lib/gate/stack.ts";
import {
  CHAIN_STATE_TABLES, LEDGER_GUARDS, evalApiLogs, evalBuyback, evalCadence, evalConnections, evalDisk, evalErrorLike, evalGecko, evalGrowth, evalGrants,
  evalGuards, evalHealth, evalJudgeConfig, evalLedgerNoise, evalMigrations, evalOpenedAt, evalParity, evalPayloadsGone, evalProducerFailures, evalQuorum,
  evalRegimeDay, evalSessionsComplete, evalVintage, evalWebsite, evalWedged, expandCronSlots, unreadable, verdict, type StandingCheck,
} from "./lib/gate/standing.ts";

const NAME = "soak:checks";

/** docker-compose.yml's defaults for the producer crons (a unit test keeps these equal to the compose file). */
export const DEFAULT_REGIME_CRON = "30 22 * * *";
export const DEFAULT_RESEARCH_CRON = "0 23 * * *";
/** A slot counts once it is 20 minutes old: the run has had that long to write its artifact. */
const GRACE_MS = 20 * 60_000;

export interface Baseline { sizeMb: number; migrations: string[]; recordedAt: string }

/** Everything the checks read. The real one is below; a test passes a fake that violates a check. */
export interface StandingIo {
  /** A SELECT through the api container, read-only. Throws on any error. */
  query<T = Record<string, unknown>>(sql: string, opts?: { timeoutMs?: number }): T[];
  /** Log lines of one compose service since T0, or null when the stack has no such container. */
  logs(service: string, since: string): Array<{ ts: string | null; text: string }> | null;
  /** The compose services that are task-queue worker lanes (`worker-*`). */
  workerServices(): string[];
  /** One service's configured environment (`docker inspect`), or null when there is no such container. */
  env(service: string): Record<string, string> | null;
  /** GET a path of the stack's api, or null when it is unreachable. */
  http(path: string): Promise<{ status: number; body: string } | null>;
  diskFreeGb(): number | null;
  /** Every service container name of the project, for the per-container error counts. */
  containerNames(): Array<{ service: string; logs: Array<{ ts: string | null; text: string }> }>;
}

export interface StandingOpts {
  /** T0, ISO. */
  since: string;
  nowMs: number;
  full: boolean;
  /** The stack's database mode: `external` (production) or `smoke-twin`. */
  dbMode: string;
  /** R8.t grades only sessions dated on or after this day. */
  openedAtFrom: string;
  baseline: Baseline | null;
  /** Called with the facts read now when `--record` is set. */
  record: ((b: Baseline) => void) | null;
}

type Row = Record<string, unknown>;
const num = (v: unknown): number => Number(v);

const FAILED = Symbol("unreadable");
/** Run one read. A read that throws becomes a FAIL of its check (never a pass) and yields FAILED. */
function attempt<T>(id: string, title: string, out: StandingCheck[], fn: () => T): T | typeof FAILED {
  try { return fn(); } catch (e) { out.push(unreadable(id, title, e)); return FAILED; }
}

export async function runStandingChecks(io: StandingIo, o: StandingOpts): Promise<StandingCheck[]> {
  const out: StandingCheck[] = [];
  const since = new Date(o.since).toISOString();
  const t0 = Date.parse(since);
  const hours = Math.floor((o.nowMs - t0) / 3_600_000);
  const q = <T = Row>(sql: string, timeoutMs = 60_000): T[] => io.query<T>(sql, { timeoutMs });
  const lines = (service: string) => io.logs(service, since);
  const text = (service: string): string[] | null => lines(service)?.map((l) => l.text) ?? null;

  // R8.a / R8.b  the producer's scheduled runs each produced their output artifact. The cron is the
  // one the producer container is configured with (compose defaults to daily; production overrides it).
  const producerEnv = io.env("analytics-producer");
  const cadence = (id: string, title: string, tool: string, artifact: string, cron: string) => {
    const slots = expandCronSlots(cron, t0, o.nowMs - GRACE_MS);
    const produced = new Map<number, number>();
    if (slots && slots.length) {
      const rows = attempt(id, title, out, () => q<{ ts: string; n: number }>(
        `SELECT s.ts::text AS ts, (SELECT count(*) FROM analytics_ledger_runs r WHERE r.tool_id = '${tool}' AND r.created_at >= to_timestamp(s.ts) AND r.created_at < to_timestamp(s.ts) + interval '20 minutes' AND EXISTS (SELECT 1 FROM analytics_output_snapshots o WHERE o.run_id = r.id AND o.artifact_kind = '${artifact}'))::int AS n FROM unnest(ARRAY[${slots.join(",")}]::bigint[]) AS s(ts)`));
      if (rows === FAILED) return;
      for (const r of rows) produced.set(num(r.ts), num(r.n));
    }
    out.push(evalCadence(id, title, cron, slots, produced));
  };
  cadence("R8.a", "regime runs on their cron", "regime", "regime_snapshots", producerEnv?.PRODUCER_REGIME_CRON || DEFAULT_REGIME_CRON);
  cadence("R8.b", "research runs on their cron", "research", "regime_snapshots", producerEnv?.PRODUCER_RESEARCH_CRON || DEFAULT_RESEARCH_CRON);
  out.push(evalProducerFailures(text("analytics-producer")));

  // R8.d  growth, against the baseline. R8.p  schema_migrations equals the baseline.
  const size = attempt("R8.d", "database size", out, () => num(q("SELECT (pg_database_size(current_database()) / 1048576)::int AS mb")[0]?.mb));
  const migrations = attempt("R8.p", "schema_migrations", out, () => q("SELECT name FROM schema_migrations ORDER BY name").map((r) => String(r.name)));
  let base: Baseline | null = o.baseline;
  if (o.record && size !== FAILED && migrations !== FAILED) {
    base = { sizeMb: size, migrations, recordedAt: new Date(o.nowMs).toISOString() };
    o.record(base);
  }
  if (size !== FAILED) out.push(evalGrowth(size, base?.sizeMb ?? null, hours));
  if (migrations !== FAILED) out.push(evalMigrations(base?.migrations ?? null, migrations));

  // R8.e  writers record only real changes
  const noise = attempt("R8.e", "ledger versions written since T0", out, () => q(String.raw`WITH v AS (SELECT s.source_key, s.value, s.revision_kind, p.value AS pv FROM source_value_versions s LEFT JOIN source_value_versions p ON p.id = s.prior_version_id WHERE s.knowledge_time >= '${since}'::timestamptz)
    SELECT count(*)::int AS n, (count(*) FILTER (WHERE revision_kind = 'unchanged'))::int AS unchanged,
           (count(*) FILTER (WHERE revision_kind = 'revision' AND pv IS NOT NULL AND abs(value - pv) <= (CASE WHEN source_key ~ '(COPPER_GOLD|IWM_SPY|BTC_ETH|SPHB_SPLV|MTUM_SPY|IWF_IWD|XLU_SPY|XLP_XLY)$' THEN 5e-6 WHEN source_key ~ ':(VIX|SPX_TREND|ETH_TREND)$' OR source_key ~ '^(research|backtest):' AND source_key !~ ':(CONF|MARGIN|DTB3)$' THEN 1e-6 ELSE 0 END) * greatest(abs(value), abs(pv)) AND value <> pv))::int AS noise
      FROM v`)[0]);
  if (noise !== FAILED) out.push(evalLedgerNoise(noise && { n: num(noise.n), unchanged: num(noise.unchanged), noise: num(noise.noise) }));

  // R8.f  parity sweeps
  const parity = attempt("R8.f", "parity sweeps", out, () => q(`SELECT (count(*) FILTER (WHERE status = 'succeeded'))::int AS ok, (count(*) FILTER (WHERE status = 'dead'))::int AS dead,
      coalesce(round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM updated_at - created_at)) FILTER (WHERE status = 'succeeded'))::numeric), 0)::int AS p50,
      coalesce(round((max(extract(epoch FROM updated_at - created_at)) FILTER (WHERE status = 'succeeded'))::numeric), 0)::int AS max
      FROM jobs WHERE kind = 'analytics.parity_sweep' AND created_at >= '${since}'::timestamptz`)[0]);
  if (parity !== FAILED) out.push(evalParity(parity && { ok: num(parity.ok), dead: num(parity.dead), p50: num(parity.p50), max: num(parity.max) }));

  // R8.g  website server errors
  out.push(evalWebsite(text("website-server")));

  // R8.h / R8.i / R8.j  sessions
  const active = attempt("R8.h", "quorum vs analysts", out, () => num(q("SELECT count(*)::int AS n FROM swarm_members WHERE status = 'active' AND role = 'member'")[0]?.n));
  if (active !== FAILED) {
    const r = attempt("R8.h", "quorum vs analysts", out, () => q(`SELECT count(*)::int AS published, (count(*) FILTER (WHERE (swarm_recommendation->'quorum'->>'active')::int <> ${active}))::int AS bad_quorum FROM swarm_sessions WHERE state = 'published' AND published_at >= '${since}'::timestamptz`)[0]);
    if (r !== FAILED) out.push(evalQuorum(r && { published: num(r.published), badQuorum: num(r.bad_quorum) }, active));
  }
  const comp = attempt("R8.i", "published sessions complete", out, () => q(`SELECT count(*)::int AS published, (count(*) FILTER (WHERE t < 1))::int AS no_takes, (count(*) FILTER (WHERE j < 1))::int AS no_judgement, (count(*) FILTER (WHERE c < 1))::int AS no_receipt
      FROM (SELECT (SELECT count(*) FROM swarm_recommendations r WHERE r.session_id = s.id) t, (SELECT count(*) FROM swarm_session_judgements j WHERE j.session_id = s.id) j, (SELECT count(*) FROM swarm_consensus_receipts c WHERE c.session_id = s.id) c
              FROM swarm_sessions s WHERE s.state = 'published' AND s.published_at >= '${since}'::timestamptz) x`)[0]);
  if (comp !== FAILED) out.push(evalSessionsComplete(comp && { published: num(comp.published), noTakes: num(comp.no_takes), noJudgement: num(comp.no_judgement), noReceipt: num(comp.no_receipt) }));
  const wedged = attempt("R8.j", "no wedged session", out, () => num(q("SELECT count(*)::int AS n FROM swarm_sessions WHERE state IN ('scheduled', 'collecting') AND window_closes_at < now() - interval '30 minutes'")[0]?.n));
  if (wedged !== FAILED) out.push(evalWedged(wedged));

  // R8.k / R8.k2  guards armed, old payload table gone
  const guards = attempt("R8.k", "ledger guards", out, () => q(`SELECT count(*)::int AS found, (count(*) FILTER (WHERE tgenabled = 'A'))::int AS armed FROM pg_trigger WHERE NOT tgisinternal AND tgname IN (${LEDGER_GUARDS.map((g) => `'${g}'`).join(", ")})`)[0]);
  if (guards !== FAILED) out.push(evalGuards(guards && { found: num(guards.found), armed: num(guards.armed) }));
  const payloads = attempt("R8.k2", "source_payloads", out, () => String(q("SELECT coalesce(to_regclass('public.source_payloads')::text, 'absent') AS reg")[0]?.reg));
  if (payloads !== FAILED) out.push(evalPayloadsGone(payloads));

  // R8.l  newest vintage
  const vin = attempt("R8.l", "newest vintage integrity", out, () => q(`WITH v AS (SELECT id, member_count FROM analytics_data_vintages ORDER BY id DESC LIMIT 1)
      SELECT v.id::text AS id, v.member_count::text AS member_count, (SELECT coalesce(sum(coalesce(vm.last_source_value_version_id - vm.source_value_version_id + 1, 1)), 0) FROM analytics_vintage_members vm WHERE vm.vintage_id = v.id)::text AS covered FROM v`)[0]);
  if (vin !== FAILED) {
    const v = vin && { id: num(vin.id), memberCount: num(vin.member_count), covered: num(vin.covered) };
    let resolved: number | null | typeof FAILED = null;
    if (v && o.full && v.memberCount === v.covered) {
      resolved = attempt("R8.l", "newest vintage integrity", out, () => num(q(`SELECT count(*)::text AS n FROM analytics_vintage_members vm CROSS JOIN LATERAL generate_series(vm.source_value_version_id, COALESCE(vm.last_source_value_version_id, vm.source_value_version_id)) g(id) JOIN source_value_versions s ON s.id = g.id AND s.source_key = vm.source_key WHERE vm.vintage_id = ${v.id}`, 900_000)[0]?.n));
    }
    if (resolved !== FAILED) out.push(evalVintage(v, resolved, o.full));
  }

  // R8.m  connections
  const conn = attempt("R8.m", "connections", out, () => q("SELECT (count(*) FILTER (WHERE state = 'idle in transaction' AND now() - state_change > interval '60 seconds'))::int AS idle_in_tx, count(*)::int AS total, (count(*) FILTER (WHERE state IS NOT NULL))::int AS visible FROM pg_stat_activity WHERE datname = current_database()")[0]);
  if (conn !== FAILED) out.push(evalConnections(conn && { idleInTx: num(conn.idle_in_tx), total: num(conn.total), visible: num(conn.visible) }));

  // R8.n  host disk
  out.push(evalDisk(io.diskFreeGb()));

  // R8.q  judge config
  const jc = attempt("R8.q", "judge config", out, () => q("SELECT mode, model, third_party_enabled AS third_party FROM swarm_judge_config WHERE id = 1")[0]);
  if (jc !== FAILED) out.push(evalJudgeConfig(jc && { mode: String(jc.mode), model: jc.model === null ? null : String(jc.model), thirdParty: jc.third_party === true }));

  // R8.r  roles and grants (production only: a twin's dump carries none)
  if (o.dbMode !== "external") out.push(...evalGrants(o.dbMode, undefined));
  else {
    const g = attempt("R8.r", "grants", out, () => q(`SELECT (SELECT bool_and(has_table_privilege('rm_worker', t, 'INSERT')) FROM unnest(ARRAY[${CHAIN_STATE_TABLES.map((t) => `'${t}'`).join(", ")}]) AS t) AS worker_insert,
        current_user::text AS who,
        (SELECT coalesce(bool_and(has_sequence_privilege('rm_readonly', c.oid, 'SELECT')), true) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'S') AS readonly_seq`)[0]);
    if (g !== FAILED) out.push(...evalGrants(o.dbMode, g && { workerInsert: g.worker_insert as boolean | null, currentUser: g.who === null ? null : String(g.who), readonlySeq: g.readonly_seq as boolean | null }));
  }

  // R8.s / R8.t  api health, the judgements route, openedAt
  const h = await io.http("/health");
  const h2 = await io.http("/api/health");
  const sid = attempt("R8.s", "health and judgements", out, () => q("SELECT id::text AS id FROM swarm_sessions WHERE state = 'published' ORDER BY published_at DESC LIMIT 1")[0]?.id);
  if (sid !== FAILED) {
    const j = typeof sid === "string" ? await io.http(`/api/swarm/sessions/${encodeURIComponent(sid)}/judgements`) : null;
    out.push(evalHealth(h?.status ?? null, h2?.status ?? null, typeof sid === "string" ? (j?.status ?? 0) : null));
  }
  const list = await io.http("/api/swarm/sessions?limit=50");
  type SessionRowApi = { state?: string; openedAt?: string | null; date?: string };
  let sessions: SessionRowApi[] | null = null;
  try { if (list?.status === 200) { const b = JSON.parse(list.body) as { sessions?: unknown }; if (Array.isArray(b.sessions)) sessions = b.sessions as SessionRowApi[]; } } catch { /* unreadable */ }
  out.push(evalOpenedAt(sessions, o.openedAtFrom));

  // R8.u / R8.v / R8.w / R8.x  log-derived checks
  out.push(...evalApiLogs(text("api")));
  const workers = io.workerServices();
  const workerLogs = workers.map((s) => text(s)).filter((l): l is string[] => l !== null);
  out.push(evalBuyback(workerLogs.length ? workerLogs.flat() : null));
  const producerText = text("analytics-producer");
  const geckoSources = [...workerLogs, ...(producerText ? [producerText] : [])];
  const keyed = [...workers, "analytics-producer"].map((s) => io.env(s)).filter((e): e is Record<string, string> => e !== null);
  const ledgerKey = attempt("R8.w3", "key containment", out, () => num(q("SELECT count(*)::int AS n FROM source_fetches WHERE request_identity::text ~* 'x-cg-pro-api-key' AND request_identity::text !~ 'REDACTED'")[0]?.n));
  const exposed = ["api", "website-server"].map((s) => io.env(s)).filter((e): e is Record<string, string> => e !== null);
  const gecko = evalGecko({
    hasKey: keyed.length ? keyed.some((e) => (e.COINGECKO_API_KEY ?? "") !== "") : null,
    geckoLines: geckoSources.length ? geckoSources.flat() : null,
    unredactedLedgerRows: ledgerKey === FAILED ? undefined : ledgerKey,
    keyEnvHits: exposed.length ? exposed.reduce((n, e) => n + Object.keys(e).filter((k) => /COINGECKO/i.test(k)).length, 0) : null,
  });
  out.push(...gecko.filter((c) => !(c.id === "R8.w3" && ledgerKey === FAILED)));
  out.push(evalRegimeDay(lines("analytics-producer"), hours));

  // R8.o  informational error-like line counts
  out.push(...evalErrorLike(new Map(io.containerNames().map((c) => [c.service, c.logs.map((l) => l.text)]))));
  return out;
}

// ── the real IO ─────────────────────────────────────────────────────────────────

export function serviceOf(project: string, container: string): string {
  return container.startsWith(`${project}-`) ? container.slice(project.length + 1).replace(/-\d+$/, "") : container;
}

function realIo(project: string, api: string, baseUrl: string, diskPath: string, since: string): StandingIo {
  const container = (service: string): string | null => service === "api" ? api : serviceContainer(project, service);
  return {
    query: (sql, opts) => dbQuery(api, sql, { statementTimeoutMs: opts?.timeoutMs }),
    logs: (service) => { const c = container(service); return c ? containerLogs(c, since) : null; },
    workerServices: () => [...new Set(projectContainers(project).filter((c) => !c.oneShot).map((c) => serviceOf(project, c.name)).filter((s) => s.startsWith("worker-")))],
    env: (service) => { const c = container(service); return c ? containerEnv(c) : null; },
    http: async (path) => {
      try {
        const r = await fetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(15_000) });
        return { status: r.status, body: await r.text() };
      } catch { return null; }
    },
    diskFreeGb: () => {
      const r = sh(["df", "-BG", "--output=avail", diskPath]);
      const n = Number(r.out.split("\n").slice(1).join("").replace(/\D/g, ""));
      return r.code === 0 && Number.isFinite(n) && n > 0 ? n : null;
    },
    containerNames: () => projectContainers(project).map((c) => ({ service: serviceOf(project, c.name), logs: containerLogs(c.name, since) })),
  };
}

export interface SoakArgs { since?: string; full: boolean; record: boolean; report?: string; baseUrl?: string; openedAtFrom: string }

export function parseSoakArgs(argv: readonly string[]): SoakArgs | { error: string } {
  const out: SoakArgs = { full: false, record: false, openedAtFrom: "2026-09-22" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--full") { out.full = true; continue; }
    if (a === "--record") { out.record = true; continue; }
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) return { error: `${a} requires a value.` };
    switch (a) {
      case "--instance": break; // read by resolveGateStack
      case "--since":
        if (Number.isNaN(Date.parse(v))) return { error: `--since takes an ISO timestamp, got "${v}".` };
        out.since = new Date(v).toISOString();
        break;
      case "--report":
        if (!v.endsWith(".md")) return { error: "--report takes a .md path (a .json sibling is written beside it)." };
        out.report = v;
        break;
      case "--base-url":
        if (!/^https?:\/\/[^\s/]+$/.test(v)) return { error: `--base-url takes an origin like http://127.0.0.1:8787, got "${v}".` };
        out.baseUrl = v;
        break;
      case "--opened-at-from":
        if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return { error: `--opened-at-from takes YYYY-MM-DD, got "${v}".` };
        out.openedAtFrom = v;
        break;
      default:
        return { error: `unknown argument "${a}".` };
    }
    i++;
  }
  return out;
}

export function renderSoakReport(r: { instance: string; project: string; since: string; finishedAt: string; checks: StandingCheck[] }): string {
  const esc = (s: string) => s.replace(/\|/g, "\\|");
  const v = verdict(r.checks);
  return [
    `# Standing soak report — ${v.fails ? "FAIL" : "PASS"}`, "", "| | |", "|---|---|",
    `| Instance | \`${r.instance}\` |`, `| Compose project | \`${r.project}\` |`, `| T0 | ${r.since} |`, `| Finished | ${r.finishedAt} |`, `| Result | ${v.fails} FAIL, ${v.warns} WARN |`, "",
    "| ID | Check | Result | Detail |", "|---|---|---|---|",
    ...r.checks.map((c) => `| ${c.id} | ${esc(c.title)} | **${c.status}** | ${esc(c.detail.join("<br>")) || "—"} |`), "",
  ].join("\n");
}

function main(): Promise<number> {
  return (async () => {
    const argv = process.argv.slice(2);
    const args = parseSoakArgs(argv);
    if ("error" in args) {
      console.error(`[${NAME}] ${args.error}`);
      console.error(`[${NAME}] usage: bun run soak:checks [--instance NAME] [--since ISO] [--full] [--record] [--report FILE.md] [--base-url URL] [--opened-at-from YYYY-MM-DD]`);
      return 2;
    }
    let stack;
    try { stack = resolveGateStack(argv, process.env, ["external", "smoke-twin"]); } catch (e) {
      console.error(`[${NAME}] ${e instanceof Error ? e.message : String(e)}`);
      return 2;
    }
    const startedAt = sh(["docker", "inspect", stack.api, "--format", "{{.State.StartedAt}}"]).out.trim();
    const since = args.since ?? (Number.isNaN(Date.parse(startedAt)) ? null : new Date(startedAt).toISOString());
    if (!since) { console.error(`[${NAME}] cannot read the api container's start time: pass --since ISO (T0).`); return 2; }
    const baselinePath = join(stack.paths.dir, "soak-baseline.json");
    let baseline: Baseline | null = null;
    if (existsSync(baselinePath)) {
      try { baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as Baseline; } catch { console.error(`[${NAME}] ${baselinePath} is malformed: delete it and re-run with --record.`); return 2; }
    }
    const baseUrl = args.baseUrl ?? `http://127.0.0.1:${stack.record.apiPort}`;
    console.log(`[${NAME}] instance ${stack.instance}, project ${stack.project}, db ${stack.record.db}, T0 ${since}${args.record ? ", RECORDING the baseline" : ""}`);
    const now = new Date();
    const checks = await runStandingChecks(realIo(stack.project, stack.api, baseUrl, "/", since), {
      since, nowMs: now.getTime(), full: args.full, dbMode: stack.record.db, openedAtFrom: args.openedAtFrom, baseline,
      record: args.record ? (b) => { mkdirSync(dirname(baselinePath), { recursive: true }); writeFileSync(baselinePath, `${JSON.stringify(b, null, 2)}\n`); } : null,
    });
    for (const c of checks) (c.status === "FAIL" ? console.error : console.log)(`  [${c.status}] ${c.id} ${c.title}: ${c.detail.join("; ")}`);
    const v = verdict(checks);
    if (args.report) {
      mkdirSync(dirname(args.report), { recursive: true });
      const rep = { instance: stack.instance, project: stack.project, since, finishedAt: now.toISOString(), checks };
      writeFileSync(args.report, renderSoakReport(rep));
      writeFileSync(`${args.report.replace(/\.md$/, "")}.json`, `${JSON.stringify(rep, null, 2)}\n`);
    }
    console.log(`[${NAME}] result: ${v.fails} FAIL, ${v.warns} WARN`);
    return v.fails ? 1 : 0;
  })();
}

if (import.meta.main) process.exit(await main());
