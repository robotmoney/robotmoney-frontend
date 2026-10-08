#!/usr/bin/env bun
// `bun run prod:gate` — the production twin of twin:gate: read-only checks of a
// running production stack, and a report of every check it ran.
//
// WHY. On 2026-09-25 production had been failing for a day — workers refused
// writes in read-only windows, the database disk was full, 268 wallet-backfill
// jobs and 23 parity sweeps were dead, sessions sat unpublished — and no
// runbook step looked, because the v0.5.0 runbook checked schema rows after the
// cutover and never read a log or the jobs table. This gate is run BEFORE an
// upgrade (--mode baseline: what is broken now, triaged before anything
// changes) and AFTER it (--mode post-release: what this release was meant to fix
// is gone, and the swarm closes judged sessions again).
//
// WHICH STACK. The deployment instance's own stack record
// (scripts/lib/smoke-state.ts): `--instance <name>`, or the only instance with
// state on this host. The compose project comes from that record, the database
// is reached through the project's api container, and every service's log is a
// container log, participants included. No SMOKE_PROJECT, no --db, no host
// driver, no Docker socket, no admin token.
//
// Checks, each recorded in the report:
//   containers    every service of the compose project running and healthy;
//                 a restart fails after a release, and is listed in a baseline
//   participants  a judge and an agent participant container are running (and,
//                 after a release, never restarted): a dead judge fails
//   read-only     the database answers writable (a managed cluster flips to
//                 read-only as its disk fills)
//   capacity      REPORT-ONLY: database size, against --db-capacity-gb when
//                 given, and growth since the previous report
//   judge         swarm_judge_config is `enforce`
//   jobs          dead jobs in the window, each last_error classified with the
//                 same rules as the logs; after a release any dead job fails
//   sessions      baseline: no session stuck past --stuck-after; post-release:
//                 every subject publishes --min-sessions judged, attended
//                 sessions in the window, and sessions have not stopped. A
//                 session that published unjudged (not_judged, no model
//                 judgement, no receipt) fails; `no_consensus` is an acceptable
//                 outcome, listed as a warning and never counted as good
//   inventory     every distinct error/warning of every container, default deny
//
// Read-only by construction: every query runs through the api container on a
// session with default_transaction_read_only (io.ts dbQuery). Run it on the
// production host.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SMOKE_SUBJECTS } from "./lib/smoke-mode.ts";
import { classify, inventory, inventoryVerdict, renderInventory, validateRules, type ClassifiedGroup, type InventoryMode } from "./lib/gate/log-inventory.ts";
import { containerLogs, dbQuery, projectContainers, sh, type ContainerState } from "./lib/gate/io.ts";
import { evaluateContainers, evaluateJudgeConfig, evaluateParticipants, evaluateSessions, type CheckRecord, type SessionRow } from "./lib/gate/grade.ts";
import { resolveGateStack } from "./lib/gate/stack.ts";
import { CLASSIFICATIONS_PATH, toSessionRow } from "./twin-gate.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const NAME = "prod:gate";
const GB = 1024 ** 3;

export interface ProdGateArgs {
  mode: InventoryMode;
  since?: string;
  windowHours: number;
  capacityGb?: number;
  report?: string;
  /** post-release only: grade sessions later (the first session can publish hours after the cutover). */
  deferSessions: boolean;
  minSessions: number;
  minAttendance: number;
  stuckAfterMin: number;
  /** The release being graded; a known issue fixed by no release up to it is a warning, not a failure (default v0.6.0). */
  release: string;
  /** post-release: FAIL when no session has published for this many hours (sessions stopped). */
  livenessHours: number;
}

export function parseProdGateArgs(argv: readonly string[]): ProdGateArgs | { error: string } {
  const out: ProdGateArgs = { mode: "baseline", windowHours: 24, deferSessions: false, minSessions: 1, minAttendance: 0.5, stuckAfterMin: 780, release: "v0.6.0", livenessHours: 12 };
  // `--sessions graded|deferred` is the value form of `--defer-sessions`: the
  // release run renders it from target data (`watchSessions`), so one step
  // template grades on production and defers on stage (D61 rule 2).
  let sessionsFlag: "graded" | "deferred" | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--defer-sessions") {
      if (sessionsFlag === "graded") return { error: "--defer-sessions contradicts --sessions graded." };
      out.deferSessions = true; sessionsFlag = "deferred"; continue;
    }
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) return { error: `${a} requires a value.` };
    const num = Number(v);
    switch (a) {
      case "--instance":
        // Read by resolveGateStack; accepted here so it is not an unknown flag.
        break;
      case "--mode":
        if (v !== "baseline" && v !== "post-release") return { error: "--mode is baseline or post-release." };
        out.mode = v;
        break;
      case "--since":
        if (Number.isNaN(Date.parse(v))) return { error: `--since takes an ISO timestamp, got "${v}".` };
        out.since = new Date(v).toISOString();
        break;
      case "--window-hours":
      case "--db-capacity-gb":
      case "--min-sessions":
      case "--min-attendance":
      case "--stuck-after":
      case "--liveness-hours":
        if (!Number.isFinite(num) || num <= 0) return { error: `${a} takes a positive number, got "${v}".` };
        if (a === "--window-hours") out.windowHours = num;
        else if (a === "--db-capacity-gb") out.capacityGb = num;
        else if (a === "--min-sessions") out.minSessions = Math.floor(num);
        else if (a === "--min-attendance") out.minAttendance = Math.min(1, num);
        else if (a === "--liveness-hours") out.livenessHours = num;
        else out.stuckAfterMin = num;
        break;
      case "--report":
        if (!v.endsWith(".md")) return { error: "--report takes a .md path (a .json sibling is written beside it)." };
        out.report = v;
        break;
      case "--release":
        out.release = v;
        break;
      case "--sessions":
        if (v !== "graded" && v !== "deferred") return { error: `--sessions is graded or deferred, got "${v}".` };
        if (sessionsFlag !== undefined && sessionsFlag !== v) return { error: `--sessions ${v} contradicts an earlier sessions flag.` };
        sessionsFlag = v;
        out.deferSessions = v === "deferred";
        break;
      default:
        return { error: `unknown argument "${a}".` };
    }
    i++;
  }
  return out;
}

export interface CapacityVerdict { status: CheckRecord["status"]; detail: string[] }

/**
 * PURE. Database size against the plan's disk, and the growth since the last
 * report. Missing capacity is a warning: a gate that cannot say how full the
 * disk is has not checked the thing that took production read-only.
 */
export function evaluateCapacity(
  sizeBytes: number,
  capacityGb: number | undefined,
  previous: { sizeBytes: number; at: string } | null,
  now: string,
): CapacityVerdict {
  const detail = [`database size ${(sizeBytes / GB).toFixed(2)} GB`];
  if (!capacityGb) return { status: "WARN", detail: ["--db-capacity-gb not given: size reported, fullness not graded", ...detail] };
  const cap = capacityGb * GB;
  const used = sizeBytes / cap;
  detail.push(`${(used * 100).toFixed(1)}% of the stated ${capacityGb} GB (database files only; WAL and temp files add to it)`);
  // Report-only (owner, 2026-09-25: storage is managed outside this gate): a
  // tight disk or a steep projection is a WARN in the report, never a FAIL.
  let status: CheckRecord["status"] = used > 0.7 ? "WARN" : "PASS";
  if (previous) {
    const days = (Date.parse(now) - Date.parse(previous.at)) / 86_400_000;
    if (days > 0.01) {
      const perDay = (sizeBytes - previous.sizeBytes) / days;
      detail.push(`growth ${(perDay / GB).toFixed(2)} GB/day since the previous report (${previous.at})`);
      if (perDay > 0) {
        const toNinety = (0.9 * cap - sizeBytes) / perDay;
        detail.push(`${toNinety.toFixed(1)} day(s) until 90% at that rate`);
        if (toNinety < 30) status = "WARN";
      }
    }
  } else detail.push("no previous report to measure growth against");
  return { status, detail };
}

function log(m: string) { console.log(`[${NAME}] ${m}`); }

async function main(): Promise<number> {
  const args = parseProdGateArgs(process.argv.slice(2));
  if ("error" in args) {
    console.error(`[${NAME}] ${args.error}`);
    console.error(`[${NAME}] usage: bun run prod:gate --mode baseline|post-release --db-capacity-gb N [--instance NAME] [--since ISO] [--defer-sessions | --sessions graded|deferred] [--window-hours H] [--report FILE.md] [--min-sessions N] [--min-attendance 0..1] [--stuck-after MIN] [--release VERSION]`);
    return 2;
  }
  let stack;
  try {
    stack = resolveGateStack(process.argv.slice(2), process.env, ["external"]);
  } catch (e) {
    console.error(`[${NAME}] ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  const api = stack.api;
  const now = new Date().toISOString();
  const since = args.since
    ?? (args.mode === "post-release"
      ? new Date(sh(["docker", "inspect", api, "--format", "{{.State.StartedAt}}"]).out.trim()).toISOString()
      : new Date(Date.now() - args.windowHours * 3_600_000).toISOString());
  log(`mode ${args.mode}, instance ${stack.instance}, project ${stack.project}, window since ${since}`);

  const checks: CheckRecord[] = [];
  const add = (id: string, title: string, status: CheckRecord["status"], detail: string[]) => checks.push({ id, title, status, detail });
  const rules = validateRules(JSON.parse(readFileSync(CLASSIFICATIONS_PATH, "utf8")));
  const strictRestarts = args.mode === "post-release";

  // containers and participants
  const containers: ContainerState[] = projectContainers(stack.project);
  const cv = evaluateContainers(containers, stack.project, strictRestarts);
  add("containers", "Every service container is running and healthy (no restarts after a release)", cv.failures.length ? "FAIL" : cv.warnings.length ? "WARN" : "PASS",
    [...cv.failures, ...cv.warnings, `${cv.services.length} service container(s)`]);
  const pv = evaluateParticipants(containers, strictRestarts);
  add("participants", "A judge and an agent participant are running (no restarts after a release)", pv.failures.length ? "FAIL" : "PASS", [...pv.failures, ...pv.detail]);

  // database: read-only, size, judge
  const [db] = dbQuery<{ ro: string; replica: boolean; size: string }>(api,
    "SELECT current_setting('transaction_read_only') AS ro, pg_is_in_recovery() AS replica, pg_database_size(current_database())::text AS size");
  // Our own sessions are forced read-only, so ask a plain session for the
  // SERVER's default (a managed cluster flips it on as the disk fills).
  const [dflt] = dbQuery<{ default_transaction_read_only: string }>(api, "SHOW default_transaction_read_only", { observeServerDefault: true });
  const serverRo = dflt?.default_transaction_read_only;
  add("read-only", "The database accepts writes (not in a read-only window)", serverRo === "on" || db?.replica ? "FAIL" : "PASS",
    [`server default_transaction_read_only=${serverRo ?? "?"}, in recovery=${db?.replica ?? "?"}`]);
  const sizeBytes = Number(db?.size ?? 0);
  const reportDir = args.report ? dirname(args.report) : join(process.env.HOME ?? "/root", "prod-gate-reports");
  const previous = latestPrevious(reportDir);
  const cap = evaluateCapacity(sizeBytes, args.capacityGb, previous, now);
  add("capacity", "Database size and growth (report-only)", cap.status, cap.detail);
  const [judgeRow] = dbQuery<{ mode: string }>(api, "SELECT mode FROM swarm_judge_config WHERE id = 1");
  const judge = evaluateJudgeConfig(judgeRow);
  add("judge", "The judge is switched on (enforce)", judge.status, judge.detail);

  // jobs
  const dead = dbQuery<{ kind: string; n: string; last_error: string | null }>(api,
    `SELECT kind, count(*)::text AS n, max(left(coalesce(last_error, ''), 400)) AS last_error FROM jobs WHERE status = 'dead' AND created_at >= '${since}'::timestamptz GROUP BY kind ORDER BY 2 DESC`);
  const deadGroups = classify(dead.map((d) => ({ source: `jobs:${d.kind}`, level: "ERROR" as const, key: d.last_error ?? "", count: Number(d.n), first: null, last: null, sample: d.last_error ?? "" })), rules);
  // A dead job is graded by its stored cause, like a log line: unclassified, or
  // a known issue THIS release claims to fix, fails; a known issue it does not
  // touch (issue 1035) or an external cause is a warning, and still listed.
  const deadVerdict = inventoryVerdict(deadGroups, args.mode, args.mode === "post-release" ? args.release : undefined);
  const anyDead = dead.length > 0;
  add("jobs", "Every dead job in the window has a cause that is not a regression of this release",
    deadVerdict.failures.length ? "FAIL" : anyDead ? "WARN" : "PASS",
    [...deadVerdict.failures, ...deadVerdict.warnings, ...dead.map((d) => `${d.n} dead '${d.kind}': ${(d.last_error ?? "").split("\n")[0]}`),
      `${dead.reduce((a, d) => a + Number(d.n), 0)} dead job(s) in the window`]);

  // sessions: published in the window (whenever convened), or still open
  const raw = dbQuery<Parameters<typeof toSessionRow>[0]>(api,
    `SELECT s.id, s.subject_id AS subject, s.state, s.judging_outcome AS outcome,
            coalesce(extract(epoch FROM now() - s.convened_at) / 60, 0)::text AS age,
            (extract(epoch FROM s.published_at) * 1000)::text AS pub,
            (SELECT count(DISTINCT r.member_id) FROM swarm_recommendations r WHERE r.session_id = s.id)::text AS takes,
            EXISTS (SELECT 1 FROM swarm_session_judgements j WHERE j.session_id = s.id AND j.source = 'model' AND j.mode = 'enforce' AND j.applied) AS judged,
            EXISTS (SELECT 1 FROM swarm_consensus_receipts r WHERE r.session_id = s.id) AS receipt
       FROM swarm_sessions s
      WHERE s.published_at >= '${since}'::timestamptz OR s.state NOT IN ('published', 'cancelled')
      ORDER BY s.convened_at`);
  const rows: SessionRow[] = raw.map(toSessionRow);
  const [{ n: activeRaw } = { n: "0" }] = dbQuery<{ n: string }>(api, "SELECT count(*)::text AS n FROM swarm_members WHERE status = 'active' AND role = 'member'");
  const active = Number(activeRaw);
  const subjects = SMOKE_SUBJECTS.map((s) => s.id);
  if (args.mode === "post-release" && args.deferSessions) {
    add("sessions", "Every subject published a judged, attended session in the window", "WARN",
      ["DEFERRED (--defer-sessions): the first session after the release can publish hours later; the soak grades this", `${rows.length} session(s) in or open during the window`]);
  } else if (args.mode === "post-release") {
    const v = evaluateSessions(rows, subjects, active, { ...args, livenessHours: args.livenessHours, nowMs: Date.parse(now) });
    add("sessions", "Every subject published a judged, attended session in the window, and sessions have not stopped", v.failures.length ? "FAIL" : v.warnings.length ? "WARN" : "PASS",
      [...v.failures, ...v.warnings, `${rows.filter((r) => r.state === "published").length} session(s) published in the window`, [...v.goodBySubject].map(([s, n]) => `${s}: ${n} good`).join("; "), `active analysts ${active}`]);
  } else {
    const v = evaluateSessions(rows, subjects, active, { ...args, minSessions: 0, nowMs: Date.parse(now) });
    add("sessions", `No session is stuck unpublished for more than ${args.stuckAfterMin} min, and none published unjudged`, v.failures.length ? "FAIL" : "PASS",
      [...v.failures, `${rows.length} session(s) in or open during the window`]);
  }

  // inventory: every container's log (participants included), default deny
  const sources = containers.map((c) => ({ source: c.name, lines: containerLogs(c.name, since) }));
  const classified: ClassifiedGroup[] = classify(sources.flatMap(({ source, lines }) => inventory(source, lines)), rules);
  const inv = inventoryVerdict(classified, args.mode, args.mode === "post-release" ? args.release : undefined);
  add("inventory", "Every distinct error in every log is classified (default deny)" + (args.mode === "post-release" ? ", and no known issue this release fixes is still present" : ""),
    inv.failures.length ? "FAIL" : inv.warnings.length ? "WARN" : "PASS",
    [...inv.failures, `${classified.length} distinct message(s) across ${sources.length} source(s); ${inv.unclassifiedErrors} unclassified error(s)`, ...inv.warnings.map((w) => `warn: ${w}`)]);

  // report
  const failed = checks.filter((c) => c.status === "FAIL");
  const commit = sh(["git", "-C", repoRoot, "describe", "--tags", "--always"]).out.trim();
  const stamp = now.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const reportPath = args.report ?? join(reportDir, `prod-gate-${args.mode}-${stamp}.md`);
  mkdirSync(dirname(reportPath), { recursive: true });
  const report = { mode: args.mode, verdict: failed.length ? "FAIL" : "PASS", host: sh(["hostname"]).out.trim(), commit, instance: stack.instance, project: stack.project, since, finishedAt: now, dbSizeBytes: sizeBytes, args, checks, sessions: rows, containers, inventory: classified };
  writeFileSync(reportPath, renderProdReport(report));
  writeFileSync(reportPath.replace(/\.md$/, "") + ".json", `${JSON.stringify(report, null, 2)}\n`);
  for (const c of checks) (c.status === "FAIL" ? console.error : console.log)(`[${NAME}] ${c.status} ${c.title}${c.status === "FAIL" ? ` — ${c.detail.slice(0, 3).join("; ")}` : ""}`);
  log(`report: ${reportPath} (+ .json) — ${checks.length} check(s), ${sources.length} log source(s), ${classified.length} distinct message(s)`);
  if (failed.length) {
    console.error(`[${NAME}] FAIL — ${failed.length} check(s) failed.${args.mode === "baseline" ? " Triage every failed check in the rollout report before the cutover." : " The release is not healthy."}`);
    return 1;
  }
  log("PASS");
  return 0;
}

/** The newest earlier prod-gate report's size and time, for the growth projection. */
function latestPrevious(dir: string): { sizeBytes: number; at: string } | null {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => /^prod-gate-.*\.json$/.test(f) || /^R[0-9.]+-.*\.json$/.test(f)).sort();
  for (const f of files.reverse()) {
    try {
      const j = JSON.parse(readFileSync(join(dir, f), "utf8")) as { dbSizeBytes?: number; finishedAt?: string };
      if (typeof j.dbSizeBytes === "number" && j.finishedAt) return { sizeBytes: j.dbSizeBytes, at: j.finishedAt };
    } catch { /* not a gate report */ }
  }
  return null;
}

export function renderProdReport(r: {
  mode: string; verdict: string; host: string; commit: string; instance: string; project: string; since: string; finishedAt: string; dbSizeBytes: number;
  checks: CheckRecord[]; sessions: SessionRow[]; containers: ContainerState[]; inventory: ClassifiedGroup[];
}): string {
  const out: string[] = [];
  const esc = (s: string) => s.replace(/\|/g, "\\|");
  out.push(`# Production gate report (${r.mode}) — ${r.verdict}`, "", "| | |", "|---|---|",
    `| Host | ${r.host} |`, `| Deployed | \`${r.commit}\` |`, `| Instance | \`${r.instance}\` |`, `| Compose project | \`${r.project}\` |`,
    `| Window since | ${r.since} |`, `| Finished | ${r.finishedAt} |`, `| Database size | ${(r.dbSizeBytes / GB).toFixed(2)} GB |`, "");
  out.push("## Checks", "", "| # | Check | Result | Detail |", "|---|---|---|---|");
  r.checks.forEach((c, i) => out.push(`| ${i + 1} | ${c.title} | **${c.status}** | ${esc(c.detail.join("<br>")) || "—"} |`));
  out.push("", "## Sessions (published in the window, or still open)", "", "| Session | Subject | State | Outcome | Age | Takes | Judged | Receipt |", "|---|---|---|---|---|---|---|---|");
  for (const s of r.sessions) out.push(`| \`${s.id}\` | ${s.subject} | ${s.state} | ${s.outcome ?? "—"} | ${Math.round(s.ageMin / 60)} h | ${s.takes} | ${s.judged ? "yes" : "no"} | ${s.receipt ? "yes" : "no"} |`);
  out.push("", "## Containers", "", "| Container | Kind | Running | Health | Restarts | Started |", "|---|---|---|---|---|---|");
  for (const c of r.containers) out.push(`| \`${c.name}\` | ${c.participantKind ? `participant (${c.participantKind})` : c.oneShot ? "one-shot" : "service"} | ${c.running ? "yes" : "no"} | ${c.health} | ${c.restarts} | ${c.startedAt} |`);
  out.push("", "## Full inventory — every distinct error and warning, classified", "", ...renderInventory(r.inventory), "");
  return out.join("\n");
}

if (import.meta.main) process.exit(await main());
