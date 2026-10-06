#!/usr/bin/env bun
// `bun run twin:gate` — the PASS/FAIL verdict a twin rehearsal (`bun smoke` on a
// restored production dump) never had.
//
// WHY THIS EXISTS. The v0.5.0 rehearsal reported success while production could
// not run a session to its close. Nothing in the twin said so: the boot printed
// READY, the swarm checks counted published sessions (a restored production
// database already holds hundreds), nothing queried `jobs` for dead rows, and
// nothing read a container log. This gate grades only what THIS boot did.
//
// WHICH STACK. The deployment instance's own stack record
// (scripts/lib/smoke-state.ts): `--instance <name>`, or the only instance with
// state on this host. The compose project comes from that record, the database
// is reached through the project's api container, and every service's log is a
// container log (participants included: a participant is a standing container).
// No SMOKE_PROJECT, no --db, no host driver, no Docker socket, no admin token.
//
//   1. sessions     Every SMOKE_SUBJECTS subject has at least --min-sessions
//                   sessions that published after the boot started (T0) with
//                   judging outcome `judged`, an applied model/enforce
//                   judgement, a consensus receipt and enough takes. A session
//                   that published unjudged FAILS; one that published
//                   `no_consensus` is an acceptable outcome (a warning, never
//                   counted as good). A session open longer than
//                   --stuck-after minutes is stuck.
//   2. participants At least one judge and one agent participant container is
//                   running and has never restarted.
//   3. judge        swarm_judge_config is `enforce`.
//   4. jobs         No job created after T0 is `dead`.
//   5. containers   Every service container is running, healthy and never
//                   restarted.
//   6. inventory    DEFAULT DENY: every distinct error in every log must match a
//                   committed classification (scripts/lib/gate/
//                   log-classifications.json) that says why it is acceptable.
//   7. logs         No container logged a FATAL pattern since T0. A known defect
//                   can be waived only by naming it: --waive "<pattern>".
//
// With --wait N it polls the session check until it passes or N minutes
// elapse, then grades everything once. Exit 0 only when every check passes.
//
// EVERY RUN WRITES A REPORT (--report, default ~/twin-gate-reports/): markdown
// with a .json sibling, listing each check, every container, and the full
// classified inventory for every log source read.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SMOKE_SUBJECTS } from "./lib/smoke-mode.ts";
import { classify, inventory, inventoryVerdict, renderInventory, validateRules, type ClassifiedGroup, type RawLine } from "./lib/gate/log-inventory.ts";
import { containerLogs, dbQuery, projectContainers, sh, type ContainerState } from "./lib/gate/io.ts";
import { evaluateContainers, evaluateJudgeConfig, evaluateParticipants, evaluateSessions, type CheckRecord, type SessionRow } from "./lib/gate/grade.ts";
import { resolveGateStack } from "./lib/gate/stack.ts";

export type { CheckRecord, SessionRow } from "./lib/gate/grade.ts";
export { evaluateSessions } from "./lib/gate/grade.ts";

/** The committed error classifications both gates grade against. */
export const CLASSIFICATIONS_PATH = join(dirname(fileURLToPath(import.meta.url)), "lib", "gate", "log-classifications.json");

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const NAME = "twin:gate";

/** A match fails the gate unless waived. Case-sensitive, as the sources log them. */
export const FATAL_LOG_PATTERNS: readonly string[] = [
  "REFUSING the boot", // api boot guards (handle-namespace, append-only, analytics-ledger)
  "— DEAD", // worker/loop.ts: a job exhausted its retries
  "refuses to poll", // scripts/agent/participant/main.ts: an agent participant that cannot start work
  "refuses to subscribe", // the same, for a judge participant: nothing can be judged
  "No space left on device", // e.g. Postgres shared memory (/dev/shm)
  "could not resize shared memory",
  "getaddrinfo", // a service pointed at a host this stack does not have
  "out of memory",
  "unsupported Unicode escape sequence", // parity writes failing (seen in production 2026-09-23/24)
  "Insufficient account funds", // the inference account is empty: no member can take, no judge can judge
  "HTTP 402",
];

/** Reported, never failing: outside providers the twin cannot make reliable. */
export const WARN_LOG_PATTERNS: readonly string[] = ["DEGRADED", "429 Too Many Requests", "Base RPC HTTP", "STALE"];

export interface GateArgs {
  minSessions: number;
  /** --sessions N: N good sessions in TOTAL, whatever their subjects, instead of --min-sessions per subject. */
  totalSessions?: number;
  minAttendance: number;
  stuckAfterMin: number;
  waitMin: number;
  since?: string;
  waive: string[];
  /** The release being graded; a known issue fixed by no release up to it is a warning (default v0.6.0). */
  release: string;
  /** Where to write the report (markdown; a .json sibling is written beside it). */
  report?: string;
}

export function parseGateArgs(argv: readonly string[]): GateArgs | { error: string } {
  const out: GateArgs = { minSessions: 1, minAttendance: 0.5, stuckAfterMin: 780, waitMin: 0, waive: [], release: "v0.6.0" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const v = argv[i + 1];
    const need = () => (v === undefined || v.startsWith("--") ? `${a} requires a value.` : null);
    const num = (lo: number, hi: number) => {
      const n = Number(v);
      return Number.isFinite(n) && n >= lo && n <= hi ? n : null;
    };
    switch (a) {
      case "--instance": {
        // Read by resolveGateStack; accepted here so it is not an unknown flag.
        const e = need();
        if (e) return { error: e };
        i++;
        break;
      }
      case "--min-sessions":
      case "--sessions":
      case "--stuck-after":
      case "--wait": {
        const e = need();
        if (e) return { error: e };
        const n = num(0, 10_000);
        if (n === null) return { error: `${a} takes a number, got "${v}".` };
        if (a === "--min-sessions") out.minSessions = Math.max(1, Math.floor(n));
        else if (a === "--sessions") out.totalSessions = Math.max(1, Math.floor(n));
        else if (a === "--stuck-after") out.stuckAfterMin = n;
        else out.waitMin = n;
        i++;
        break;
      }
      case "--min-attendance": {
        const e = need();
        if (e) return { error: e };
        const n = num(0, 1);
        if (n === null) return { error: `--min-attendance takes a fraction 0..1, got "${v}".` };
        out.minAttendance = n;
        i++;
        break;
      }
      case "--since": {
        const e = need();
        if (e) return { error: e };
        if (Number.isNaN(Date.parse(v!))) return { error: `--since takes an ISO timestamp, got "${v}".` };
        out.since = new Date(v!).toISOString();
        i++;
        break;
      }
      case "--report": {
        const e = need();
        if (e) return { error: e };
        if (!v!.endsWith(".md")) return { error: "--report takes a .md path (a .json sibling is written beside it)." };
        out.report = v!;
        i++;
        break;
      }
      case "--release": {
        const e = need();
        if (e) return { error: e };
        out.release = v!;
        i++;
        break;
      }
      case "--waive": {
        const e = need();
        if (e) return { error: e };
        out.waive.push(v!);
        i++;
        break;
      }
      default:
        return { error: `unknown argument "${a}".` };
    }
  }
  return out;
}

export interface LogVerdict {
  fatal: Map<string, number>;
  waived: Map<string, number>;
  warn: Map<string, number>;
}

/** PURE. Grade log lines against the fatal/warn patterns. */
export function classifyLog(lines: readonly string[], waive: readonly string[]): LogVerdict {
  const v: LogVerdict = { fatal: new Map(), waived: new Map(), warn: new Map() };
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  for (const line of lines) {
    const fatal = FATAL_LOG_PATTERNS.find((p) => line.includes(p));
    if (fatal) {
      bump(waive.some((w) => line.includes(w)) ? v.waived : v.fatal, fatal);
      continue;
    }
    const warn = WARN_LOG_PATTERNS.find((p) => line.includes(p));
    if (warn) bump(v.warn, warn);
  }
  return v;
}

/**
 * The sessions a twin boot is graded on, as one SELECT through the api
 * container. A session is admitted by what THIS boot did to it: it convened
 * after T0, it published after T0 (an adopted session the boot closed), or it
 * was judged after T0. Never by whether it was judged: a judged-only filter
 * hid exactly the session that published with no judgement (R4.8, 2026-09-25).
 * Takes are real takes (swarm_recommendations), outside members included.
 */
export function sessionsQuery(t0: string): string {
  return `SELECT s.id, s.subject_id AS subject, s.state, s.judging_outcome AS outcome,
            coalesce(extract(epoch FROM now() - s.convened_at) / 60, 0)::text AS age,
            (extract(epoch FROM s.published_at) * 1000)::text AS pub,
            (SELECT count(DISTINCT r.member_id) FROM swarm_recommendations r WHERE r.session_id = s.id)::text AS takes,
            EXISTS (SELECT 1 FROM swarm_session_judgements j WHERE j.session_id = s.id
                      AND j.source = 'model' AND j.mode = 'enforce' AND j.applied) AS judged,
            EXISTS (SELECT 1 FROM swarm_consensus_receipts r WHERE r.session_id = s.id) AS receipt
       FROM swarm_sessions s
      WHERE s.convened_at >= '${t0}'::timestamptz
         OR s.published_at >= '${t0}'::timestamptz
         OR EXISTS (SELECT 1 FROM swarm_session_judgements j WHERE j.session_id = s.id AND j.created_at >= '${t0}'::timestamptz)
      ORDER BY s.convened_at`;
}

interface SessionRaw { id: string; subject: string; state: string; outcome: string | null; age: string; pub: string | null; takes: string; judged: boolean; receipt: boolean }

/** PURE. A database row as a SessionRow. */
export function toSessionRow(r: SessionRaw): SessionRow {
  return {
    id: r.id, subject: r.subject, state: r.state, outcome: r.outcome, ageMin: Number(r.age),
    publishedAtMs: r.pub ? Number(r.pub) : null, takes: Number(r.takes), judged: r.judged, receipt: r.receipt,
  };
}

// ── The report ──────────────────────────────────────────────────────────────
// The document the runbook files as evidence: every check this run performed,
// what it looked at, and what it found, so "did anyone read the logs of every
// service?" has a written answer, not an assumption.

/** One log source, scanned: every fatal and warn pattern, plus generic error/warning lines. */
export interface LogScan {
  source: string;
  lines: number;
  fatal: Record<string, number>;
  waived: Record<string, number>;
  warn: Record<string, number>;
  errorLike: number;
  warningLike: number;
  topErrors: { line: string; count: number }[];
}

const ERROR_LIKE = /\b(error|exception|fatal|panic|fail(ed|ure|s)?|dead|refus(ed|ing)|denied|timeout|timed out)\b/i;
const WARNING_LIKE = /\bwarn(ing)?\b/i;

/** Collapse ids, numbers and timestamps so repeats of one message count as one. */
export function normalizeLogLine(line: string): string {
  return line
    .replace(/\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?/g, "<ts>")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
    .replace(/\b\d+\b/g, "<n>")
    .trim()
    .slice(0, 200);
}

/** PURE. Scan one source's lines. */
export function scanLog(source: string, lines: readonly string[], waive: readonly string[]): LogScan {
  const v = classifyLog(lines, waive);
  const top = new Map<string, number>();
  let errorLike = 0;
  let warningLike = 0;
  for (const line of lines) {
    if (ERROR_LIKE.test(line)) {
      errorLike++;
      const k = normalizeLogLine(line);
      top.set(k, (top.get(k) ?? 0) + 1);
    } else if (WARNING_LIKE.test(line)) warningLike++;
  }
  return {
    source,
    lines: lines.filter((l) => l.length > 0).length,
    fatal: Object.fromEntries(v.fatal),
    waived: Object.fromEntries(v.waived),
    warn: Object.fromEntries(v.warn),
    errorLike,
    warningLike,
    topErrors: [...top].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([line, count]) => ({ line, count })),
  };
}

export interface GateReport {
  commit: string;
  host: string;
  instance: string;
  project: string;
  t0: string;
  finishedAt: string;
  args: GateArgs;
  verdict: "PASS" | "FAIL";
  checks: CheckRecord[];
  sessions: SessionRow[];
  jobs: { kind: string; status: string; count: number }[];
  containers: ContainerState[];
  logScans: LogScan[];
  /** Every distinct error/warning message of every source, classified. */
  inventory: ClassifiedGroup[];
}

/** PURE. The report as markdown. */
export function renderReport(r: GateReport): string {
  const out: string[] = [];
  const counts = (m: Record<string, number>) => Object.entries(m).map(([p, n]) => `\`${p}\` ×${n}`).join(", ") || "none";
  out.push(`# Twin rehearsal gate report — ${r.verdict}`, "");
  out.push(`| | |`, `|---|---|`);
  out.push(`| Commit | \`${r.commit}\` |`, `| Host | ${r.host} |`, `| Instance | \`${r.instance}\` |`, `| Compose project | \`${r.project}\` |`);
  out.push(`| T0 (api started) | ${r.t0} |`, `| Finished | ${r.finishedAt} |`);
  out.push(`| Thresholds | ${r.args.totalSessions !== undefined ? `sessions in total ${r.args.totalSessions}` : `min sessions/subject ${r.args.minSessions}`}, min attendance ${r.args.minAttendance}, stuck after ${r.args.stuckAfterMin} min, waited up to ${r.args.waitMin} min, release ${r.args.release} |`);
  out.push(`| Waivers | ${r.args.waive.length ? r.args.waive.map((w) => `\`${w}\``).join(", ") : "none"} |`, "");
  out.push(`## Checks`, "", `| # | Check | Result | Detail |`, `|---|---|---|---|`);
  r.checks.forEach((c, i) => out.push(`| ${i + 1} | ${c.title} | **${c.status}** | ${c.detail.join("<br>").replace(/\|/g, "\\|") || "—"} |`));
  out.push("", `## Sessions convened, published or judged after T0`, "", `| Session | Subject | State | Outcome | Takes | Judged (model/enforce) | Receipt |`, `|---|---|---|---|---|---|---|`);
  for (const s of r.sessions) out.push(`| \`${s.id}\` | ${s.subject} | ${s.state} | ${s.outcome ?? "—"} | ${s.takes} | ${s.judged ? "yes" : "no"} | ${s.receipt ? "yes" : "no"} |`);
  if (r.sessions.length === 0) out.push(`| — | — | — | — | — | — | — |`);
  out.push("", `## Jobs created after T0`, "", `| Kind | Status | Count |`, `|---|---|---|`);
  for (const j of r.jobs) out.push(`| ${j.kind} | ${j.status} | ${j.count} |`);
  out.push("", `## Containers`, "", `| Container | Kind | Running | Health | Restarts |`, `|---|---|---|---|---|`);
  for (const c of r.containers) out.push(`| \`${c.name}\` | ${c.participantKind ? `participant (${c.participantKind})` : c.oneShot ? "one-shot" : "service"} | ${c.oneShot ? "n/a" : c.running ? "yes" : "NO"} | ${c.health} | ${c.restarts} |`);
  out.push("", `## Log scan — every source read since T0`, "");
  out.push(`${r.logScans.length} source(s) scanned. Fatal patterns fail the gate; warn patterns and generic error/warning lines are reported.`, "");
  out.push(`| Source | Lines | Fatal | Waived | Warn patterns | Error-like lines | Warning-like lines |`, `|---|---|---|---|---|---|---|`);
  for (const l of r.logScans) out.push(`| \`${l.source}\` | ${l.lines} | ${counts(l.fatal)} | ${counts(l.waived)} | ${counts(l.warn)} | ${l.errorLike} | ${l.warningLike} |`);
  for (const l of r.logScans.filter((x) => x.topErrors.length > 0)) {
    out.push("", `### Most frequent error-like lines — \`${l.source}\``, "");
    for (const t of l.topErrors) out.push(`- ×${t.count} \`${t.line.replace(/`/g, "'")}\``);
  }
  out.push("", `Fatal patterns: ${FATAL_LOG_PATTERNS.map((p) => `\`${p}\``).join(", ")}.`, `Warn patterns: ${WARN_LOG_PATTERNS.map((p) => `\`${p}\``).join(", ")}.`, "");
  out.push("", "## Full inventory — every distinct error and warning, classified", "", ...renderInventory(r.inventory ?? []), "");
  return out.join("\n");
}

function log(m: string) { console.log(`[${NAME}] ${m}`); }

async function main(): Promise<number> {
  const parsed = parseGateArgs(process.argv.slice(2));
  if ("error" in parsed) {
    console.error(`[${NAME}] ${parsed.error}`);
    console.error(`[${NAME}] usage: bun run twin:gate [--instance NAME] [--report FILE.md] [--wait MIN] [--min-sessions N | --sessions N] [--min-attendance 0..1] [--stuck-after MIN] [--since ISO] [--release VERSION] [--waive PATTERN]...`);
    return 2;
  }
  let stack;
  try {
    stack = resolveGateStack(process.argv.slice(2), process.env, ["smoke-twin"]);
  } catch (e) {
    console.error(`[${NAME}] ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  const t0 = parsed.since ?? new Date(sh(["docker", "inspect", stack.api, "--format", "{{.State.StartedAt}}"]).out.trim()).toISOString();
  log(`instance ${stack.instance}, project ${stack.project}, T0 ${t0}`);

  const subjects = SMOKE_SUBJECTS.map((s) => s.id);
  const gradeOpts = (nowMs: number) => ({ ...parsed, nowMs });
  const active = Number(dbQuery<{ n: string }>(stack.api, "SELECT count(*)::text AS n FROM swarm_members WHERE status = 'active' AND role = 'member'")[0]?.n ?? 0);
  const readRows = () => dbQuery<SessionRaw>(stack.api, sessionsQuery(t0)).map(toSessionRow);
  let rows = readRows();
  let verdict = evaluateSessions(rows, subjects, active, gradeOpts(Date.now()));
  const deadline = Date.now() + parsed.waitMin * 60_000;
  while (verdict.failures.length > 0 && Date.now() < deadline) {
    log(`waiting: ${verdict.failures.length} session condition(s) unmet — ${[...verdict.goodBySubject].map(([s, n]) => `${s}=${n}`).join(" ")}`);
    await Bun.sleep(30_000);
    rows = readRows();
    verdict = evaluateSessions(rows, subjects, active, gradeOpts(Date.now()));
  }

  const checks: CheckRecord[] = [];
  const add = (id: string, title: string, failures: string[], detail: string[], warn = false) =>
    checks.push({ id, title, status: failures.length ? "FAIL" : warn ? "WARN" : "PASS", detail: [...failures, ...detail] });

  add("sessions", "Every subject published a judged, attended session after T0", verdict.failures,
    [...verdict.warnings, `${[...verdict.goodBySubject].map(([s, n]) => `${s}: ${n} good`).join("; ")}`, `active analysts ${active}`], verdict.warnings.length > 0);

  const containers = projectContainers(stack.project);
  const cv = evaluateContainers(containers, stack.project, true);
  const pv = evaluateParticipants(containers, true);
  add("participants", "A judge and an agent participant are running and never restarted", pv.failures, pv.detail);

  const [judgeRow] = dbQuery<{ mode: string }>(stack.api, "SELECT mode FROM swarm_judge_config WHERE id = 1");
  const jc = evaluateJudgeConfig(judgeRow);
  add("judge", "The judge is switched on (enforce)", jc.status === "FAIL" ? jc.detail : [], jc.status === "FAIL" ? [] : jc.detail);

  const jobs = dbQuery<{ kind: string; status: string; n: string }>(stack.api,
    `SELECT kind, status, count(*)::text AS n FROM jobs WHERE created_at >= '${t0}'::timestamptz GROUP BY 1, 2 ORDER BY 1, 2`)
    .map((j) => ({ kind: j.kind, status: j.status, count: Number(j.n) }));
  add("jobs", "No job created after T0 is dead", jobs.filter((j) => j.status === "dead").map((j) => `${j.count} dead '${j.kind}'`),
    [`${jobs.reduce((a, j) => a + j.count, 0)} job(s) across ${new Set(jobs.map((j) => j.kind)).size} kind(s)`]);

  add("containers", "Every service container is running, healthy and never restarted", cv.failures,
    [`${cv.services.length} service container(s), ${containers.length - cv.services.length} one-shot container(s) still present`]);

  // Every source, read ONCE: each container of the boot (participants
  // included) and the restore container the twin's database lives in.
  const sources: { source: string; lines: RawLine[] }[] = [
    ...containers.map((c) => ({ source: c.name, lines: containerLogs(c.name, t0) })),
    ...(stack.record.smokeTwinContainer && !containers.some((c) => c.name === stack.record.smokeTwinContainer)
      ? [{ source: stack.record.smokeTwinContainer, lines: containerLogs(stack.record.smokeTwinContainer, t0) }]
      : []),
  ];
  const logScans: LogScan[] = sources.map(({ source, lines }) => scanLog(source, lines.map((l) => l.text), parsed.waive));
  const rules = validateRules(JSON.parse(readFileSync(CLASSIFICATIONS_PATH, "utf8")));
  const classified = classify(sources.flatMap(({ source, lines }) => inventory(source, lines)), rules);
  const inv = inventoryVerdict(classified, "post-release", parsed.release);
  add("inventory", "Every distinct error in every log is classified (default deny), and no known issue this release fixes is still present",
    inv.failures,
    [`${classified.length} distinct message(s) across ${sources.length} source(s); ${inv.unclassifiedErrors} unclassified error(s)`,
      ...inv.warnings.map((w) => `warn: ${w}`)],
    inv.warnings.length > 0);
  for (const l of logScans) {
    const fatal = Object.entries(l.fatal).map(([p, n]) => `${n} line(s) matching "${p}"`);
    add(`logs:${l.source}`, `Log scan — ${l.source}`, fatal,
      [`${l.lines} line(s) read; ${l.errorLike} error-like, ${l.warningLike} warning-like`,
        ...Object.entries(l.waived).map(([p, n]) => `waived: ${n} × "${p}"`),
        ...Object.entries(l.warn).map(([p, n]) => `warn pattern: ${n} × "${p}"`)],
      Object.keys(l.warn).length > 0 || Object.keys(l.waived).length > 0);
  }

  const failed = checks.filter((c) => c.status === "FAIL");
  const report: GateReport = {
    commit: sh(["git", "-C", repoRoot, "rev-parse", "HEAD"]).out.trim(),
    host: sh(["hostname"]).out.trim(),
    instance: stack.instance,
    project: stack.project,
    t0,
    finishedAt: new Date().toISOString(),
    args: parsed,
    verdict: failed.length ? "FAIL" : "PASS",
    checks,
    sessions: rows,
    jobs,
    containers,
    logScans,
    inventory: classified,
  };
  const stamp = report.finishedAt.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const reportPath = parsed.report ?? join(process.env.HOME ?? "/tmp", "twin-gate-reports", `twin-gate-${report.commit.slice(0, 8)}-${stamp}.md`);
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, renderReport(report));
  writeFileSync(reportPath.replace(/\.md$/, "") + ".json", `${JSON.stringify(report, null, 2)}\n`);

  for (const c of checks) (c.status === "FAIL" ? console.error : console.log)(`[${NAME}] ${c.status} ${c.title}${c.status === "FAIL" ? ` — ${c.detail.join("; ")}` : ""}`);
  log(`report: ${reportPath} (+ .json) — ${checks.length} check(s), ${logScans.length} log source(s) scanned`);
  if (failed.length) {
    console.error(`[${NAME}] FAIL — ${failed.length} check(s) failed. This rehearsal does NOT support the release.`);
    return 1;
  }
  log("PASS — every subject closed a judged session this boot, no job died, no container restarted, no unclassified error.");
  return 0;
}

if (import.meta.main) process.exit(await main());
