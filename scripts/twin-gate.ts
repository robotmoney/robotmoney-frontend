#!/usr/bin/env bun
// `bun run twin:gate` — the PASS/FAIL verdict a `bun smoke:twin` rehearsal never had.
//
// WHY THIS EXISTS. The v0.5.0 rehearsal reported success while production could
// not run a session to its close. Nothing in the twin said so: smoke:twin prints
// READY and then only LOGS a failed session (smoke-main.ts, "swarm session failed
// (stack still running)"); the rehearsal's swarm checks count published sessions,
// and a restored production database already holds hundreds; nothing queried
// `jobs` for dead rows, and nothing read a container log. This gate grades only
// what THIS boot did:
//
//   1. sessions   Every SMOKE_SUBJECTS subject has at least --min-sessions sessions
//                 convened AFTER the boot started (T0) and `published`. Each such
//                 session carries takes (at least --min-attendance of the active
//                 roster), a model-sourced `enforce` judgement that was applied,
//                 and a consensus receipt. A new session older than --stuck-after
//                 minutes that is not published is stuck.
//   2. jobs       No job created after T0 is `dead`.
//   3. containers Every long-running container of the boot's compose project is
//                 running, healthy where it has a healthcheck, and never restarted.
//   4. logs       No container logged a FATAL pattern since T0 (boot refusals, dead
//                 jobs, judge refusals, DNS failures, out-of-memory). A known
//                 defect can be waived only by naming it: --waive "<pattern>".
//
//   5. driver    With --driver-log (smoke:twin's output tee'd to a file): every
//                 subject LOGGED at least --min-sessions sessions as
//                 `published ... judge=enforce` with attendance met, and no
//                 session logged `judge=none`. The driver log is also scanned
//                 for the fatal patterns (an empty inference account, a failed
//                 session, an expired judge wait).
//
// With --wait N it polls (1) until it passes or N minutes elapse, then grades
// everything once. Exit 0 only when every check passes.
//
// EVERY RUN WRITES A REPORT (--report, default ~/twin-gate-reports/): a markdown
// document, with a .json sibling, listing each check performed and its result,
// the sessions, the jobs, every container's state, and — for EVERY log source
// (each container of the boot, the restored database, the driver log) — the
// lines read and the counts of each fatal pattern, warn pattern, and generic
// error-like and warning-like line, with the most frequent error lines. It is
// the runbook's evidence that the logs of every service were actually read.
//
// It reads the twin through `docker exec` into the restore container and
// `docker logs`, using .agents/smoke-state.json — run it on the twin's host.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SMOKE_SUBJECTS } from "./lib/smoke-mode.ts";
import { classify, inventory, inventoryVerdict, renderInventory, validateRules, type ClassifiedGroup, type RawLine } from "./lib/gate/log-inventory.ts";
import { containerLogs, memberSessionLogs } from "./lib/gate/io.ts";

/** The committed error classifications both gates grade against. */
export const CLASSIFICATIONS_PATH = join(dirname(fileURLToPath(import.meta.url)), "lib", "gate", "log-classifications.json");

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const NAME = "twin:gate";

// Restore-container constants (scripts/lib/restore-container.ts LOCAL_USER/LOCAL_DB).
const TWIN_DB_USER = "restore_check";
const TWIN_DB_NAME = "rm_restore_check";

/** A match fails the gate unless waived. Case-sensitive, as the sources log them. */
export const FATAL_LOG_PATTERNS: readonly string[] = [
  "REFUSING the boot", // api boot guards (handle-namespace, append-only, analytics-ledger)
  "— DEAD", // worker/loop.ts: a job exhausted its retries
  "JudgeUnavailable", // the judge produced no judgement
  "No space left on device", // e.g. Postgres shared memory (/dev/shm)
  "could not resize shared memory",
  "getaddrinfo", // a lane pointed at a host this stack does not have
  "out of memory",
  "unsupported Unicode escape sequence", // parity writes failing (seen in production 2026-09-23/24)
  "Insufficient account funds", // the inference account is empty: no member can take, no judge can judge
  "HTTP 402",
  "swarm session failed", // smoke-main.ts: the driver gave up on a session and kept running
  "NO judgement row was recorded", // session.ts: the judging never landed and the session published unjudged
];

/** Reported, never failing: outside providers the twin cannot make reliable. */
export const WARN_LOG_PATTERNS: readonly string[] = ["DEGRADED", "429 Too Many Requests", "Base RPC HTTP", "STALE"];

export interface GateArgs {
  minSessions: number;
  /**
   * --sessions N: N published sessions in TOTAL, whatever their subjects,
   * instead of --min-sessions per subject. The twin's question is "do two
   * sessions back to back complete with every analyst filing", and a
   * one-at-a-time driver reaches its second subject in about two windows, not
   * after a whole round of every subject.
   */
  totalSessions?: number;
  minAttendance: number;
  stuckAfterMin: number;
  waitMin: number;
  since?: string;
  waive: string[];
  /** The driver's own output (smoke:twin tee'd to a file): per-session published/judge lines. */
  driverLog?: string;
  /** Where to write the report (markdown; a .json sibling is written beside it). */
  report?: string;
}

export function parseGateArgs(argv: readonly string[]): GateArgs | { error: string } {
  const out: GateArgs = { minSessions: 1, minAttendance: 0.5, stuckAfterMin: 30, waitMin: 0, waive: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const v = argv[i + 1];
    const need = () => (v === undefined || v.startsWith("--") ? `${a} requires a value.` : null);
    const num = (lo: number, hi: number) => {
      const n = Number(v);
      return Number.isFinite(n) && n >= lo && n <= hi ? n : null;
    };
    switch (a) {
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
      case "--driver-log": {
        const e = need();
        if (e) return { error: e };
        out.driverLog = v!;
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

export interface SessionRow {
  id: string;
  subject: string;
  state: string;
  ageMin: number;
  takes: number;
  judged: boolean;
  receipt: boolean;
}

export interface SessionVerdict {
  failures: string[];
  publishedBySubject: Map<string, number>;
}

/** PURE. Grade the sessions this boot convened. */
export function evaluateSessions(
  rows: readonly SessionRow[],
  subjects: readonly string[],
  activeMembers: number,
  args: Pick<GateArgs, "minSessions" | "minAttendance" | "stuckAfterMin" | "totalSessions">,
): SessionVerdict {
  const failures: string[] = [];
  const publishedBySubject = new Map(subjects.map((s) => [s, 0]));
  const needTakes = Math.max(1, Math.ceil(activeMembers * args.minAttendance));
  for (const r of rows) {
    if (r.state === "published") {
      publishedBySubject.set(r.subject, (publishedBySubject.get(r.subject) ?? 0) + 1);
      if (r.takes < needTakes) failures.push(`session ${r.id} (${r.subject}) published with ${r.takes} take(s); need ${needTakes} of ${activeMembers} active`);
      if (!r.judged) failures.push(`session ${r.id} (${r.subject}) published without an applied model/enforce judgement`);
      if (!r.receipt) failures.push(`session ${r.id} (${r.subject}) published without a consensus receipt`);
    } else if (r.state !== "cancelled" && r.ageMin > args.stuckAfterMin) {
      failures.push(`session ${r.id} (${r.subject}) stuck in '${r.state}' for ${Math.round(r.ageMin)} min`);
    }
  }
  if (args.totalSessions !== undefined) {
    const n = [...publishedBySubject.values()].reduce((a, b) => a + b, 0);
    if (n < args.totalSessions) failures.push(`${n} session(s) published this boot; need ${args.totalSessions}`);
  } else {
    for (const s of subjects) {
      const n = publishedBySubject.get(s) ?? 0;
      if (n < args.minSessions) failures.push(`subject ${s}: ${n} session(s) convened and published this boot; need ${args.minSessions}`);
    }
  }
  return { failures, publishedBySubject };
}

export interface DriverSession {
  subject: string;
  state: string;
  takes: number;
  active: number;
  judge: string;
}

const PUBLISHED_LINE = /\[session \d+: [0-9-]+\/([A-Za-z0-9_-]+)\] published: state=(\w+), takes=(\d+) of (\d+)(?:, judge=(\w+))?/;

/** PURE. The driver's per-session publish lines (scripts/lib/swarm/session.ts). */
export function parseDriverSessions(lines: readonly string[]): DriverSession[] {
  const out: DriverSession[] = [];
  for (const line of lines) {
    const m = PUBLISHED_LINE.exec(line);
    if (m) out.push({ subject: m[1]!, state: m[2]!, takes: Number(m[3]), active: Number(m[4]), judge: m[5] ?? "unlogged" });
  }
  return out;
}

/** PURE. The log-side verdict: every subject logged a published, judged, attended session. */
export function evaluateDriverSessions(
  sessions: readonly DriverSession[],
  subjects: readonly string[],
  args: Pick<GateArgs, "minSessions" | "minAttendance" | "totalSessions">,
): string[] {
  const failures: string[] = [];
  const good = (d: DriverSession) => d.state === "published" && d.judge === "enforce" && d.takes >= Math.max(1, Math.ceil(d.active * args.minAttendance));
  if (args.totalSessions !== undefined) {
    const n = sessions.filter(good).length;
    if (n < args.totalSessions) failures.push(`driver log: ${n} published+judged+attended session(s); need ${args.totalSessions}`);
  } else {
    for (const s of subjects) {
      const n = sessions.filter((d) => d.subject === s && good(d)).length;
      if (n < args.minSessions) failures.push(`driver log: subject ${s} logged ${n} published+judged+attended session(s); need ${args.minSessions}`);
    }
  }
  for (const d of sessions) {
    if (d.judge !== "enforce") failures.push(`driver log: a ${d.subject} session published with judge=${d.judge}, takes=${d.takes} of ${d.active}`);
  }
  return failures;
}

// ── IO ────────────────────────────────────────────────────────────────────────

function sh(cmd: string[]): { code: number; out: string } {
  const p = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode ?? 1, out: `${p.stdout.toString()}${p.stderr.toString()}` };
}

function psql(container: string, query: string): string[][] {
  const r = sh(["docker", "exec", container, "psql", "-U", TWIN_DB_USER, "-d", TWIN_DB_NAME, "-X", "-A", "-t", "-F", "\t", "-v", "ON_ERROR_STOP=1", "-c", query]);
  if (r.code !== 0) throw new Error(`psql failed: ${r.out.trim()}`);
  return r.out.split("\n").filter((l) => l.length > 0).map((l) => l.split("\t"));
}

function sessionRows(container: string, t0: string): SessionRow[] {
  return psql(
    container,
    `SELECT s.id, s.subject_id, s.state,
            extract(epoch FROM now() - s.convened_at) / 60,
            (SELECT count(DISTINCT m.member_id) FROM swarm_memos m WHERE m.session_id = s.id),
            EXISTS (SELECT 1 FROM swarm_session_judgements j WHERE j.session_id = s.id
                      AND j.source = 'model' AND j.mode = 'enforce' AND j.applied),
            EXISTS (SELECT 1 FROM swarm_consensus_receipts r WHERE r.session_id = s.id)
       FROM swarm_sessions s
      WHERE s.convened_at >= '${t0}'::timestamptz
         -- A session production opened and this boot ADOPTED (round 1 of a
         -- twin) counts too: it ran the whole path here (brief, takes, judge,
         -- publish). It is admitted by what THIS boot did to it — published it,
         -- or judged it — never by whether it was judged: the R4.8 run on
         -- 2026-09-25 published an adopted session with NO judgement, and a
         -- judged-only filter hid exactly that session from this check.
         OR s.published_at >= '${t0}'::timestamptz
         OR EXISTS (SELECT 1 FROM swarm_session_judgements j WHERE j.session_id = s.id AND j.created_at >= '${t0}'::timestamptz)
      ORDER BY s.convened_at`,
  ).map(([id, subject, state, age, takes, judged, receipt]) => ({
    id: id!, subject: subject!, state: state!, ageMin: Number(age), takes: Number(takes), judged: judged === "t", receipt: receipt === "t",
  }));
}

/** Every container of the boot's compose project, one-shots included when Docker still has them. */
function projectContainers(project: string): { name: string; oneShot: boolean }[] {
  const r = sh(["docker", "ps", "-a", "--filter", `label=com.docker.compose.project=${project}`, "--format", "{{.Names}}"]);
  // One-shot `run` containers (migrations, member agents) exit by design, so
  // they are scanned for log lines but not graded running/healthy.
  return r.out.split("\n").filter(Boolean).map((name) => ({ name, oneShot: /-run-|member-agent/.test(name) }));
}

export interface ContainerState { name: string; running: boolean; health: string; restarts: number }
function containerState(name: string): ContainerState {
  const r = sh(["docker", "inspect", name, "--format", "{{.State.Running}}\t{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}\t{{.RestartCount}}"]);
  const [running, health, restarts] = r.out.trim().split("\t");
  return { name, running: running === "true", health: health ?? "?", restarts: Number(restarts ?? 0) };
}

// ── The report ──────────────────────────────────────────────────────────────
// The document the runbook files as evidence: every check this run performed,
// what it looked at, and what it found — so "did anyone read the logs of every
// service?" has a written answer, not an assumption.

export type CheckStatus = "PASS" | "FAIL" | "WARN";
export interface CheckRecord { id: string; title: string; status: CheckStatus; detail: string[] }

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
  project: string;
  twinDb: string;
  t0: string;
  finishedAt: string;
  args: GateArgs;
  verdict: "PASS" | "FAIL";
  checks: CheckRecord[];
  sessions: SessionRow[];
  driverSessions: DriverSession[];
  jobs: { kind: string; status: string; count: number }[];
  containers: (ContainerState & { oneShot: boolean })[];
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
  out.push(`| Commit | \`${r.commit}\` |`, `| Host | ${r.host} |`, `| Compose project | \`${r.project}\` |`, `| Twin database | \`${r.twinDb}\` |`);
  out.push(`| T0 (api started) | ${r.t0} |`, `| Finished | ${r.finishedAt} |`);
  out.push(`| Thresholds | ${r.args.totalSessions !== undefined ? `sessions in total ${r.args.totalSessions}` : `min sessions/subject ${r.args.minSessions}`}, min attendance ${r.args.minAttendance}, stuck after ${r.args.stuckAfterMin} min, waited up to ${r.args.waitMin} min |`);
  out.push(`| Waivers | ${r.args.waive.length ? r.args.waive.map((w) => `\`${w}\``).join(", ") : "none"} |`, "");
  out.push(`## Checks`, "", `| # | Check | Result | Detail |`, `|---|---|---|---|`);
  r.checks.forEach((c, i) => out.push(`| ${i + 1} | ${c.title} | **${c.status}** | ${c.detail.join("<br>").replace(/\|/g, "\\|") || "—"} |`));
  out.push("", `## Sessions convened or judged after T0 (database)`, "", `| Session | Subject | State | Takes | Judged (model/enforce) | Receipt |`, `|---|---|---|---|---|---|`);
  for (const s of r.sessions) out.push(`| \`${s.id}\` | ${s.subject} | ${s.state} | ${s.takes} | ${s.judged ? "yes" : "no"} | ${s.receipt ? "yes" : "no"} |`);
  if (r.sessions.length === 0) out.push(`| — | — | — | — | — | — |`);
  out.push("", `## Sessions the driver logged as published`, "", `| Subject | State | Takes | Judge |`, `|---|---|---|---|`);
  for (const d of r.driverSessions) out.push(`| ${d.subject} | ${d.state} | ${d.takes} of ${d.active} | ${d.judge} |`);
  if (r.driverSessions.length === 0) out.push(`| — | — | — | — |`);
  out.push("", `## Jobs created after T0`, "", `| Kind | Status | Count |`, `|---|---|---|`);
  for (const j of r.jobs) out.push(`| ${j.kind} | ${j.status} | ${j.count} |`);
  out.push("", `## Containers`, "", `| Container | Kind | Running | Health | Restarts |`, `|---|---|---|---|---|`);
  for (const c of r.containers) out.push(`| \`${c.name}\` | ${c.oneShot ? "one-shot" : "service"} | ${c.oneShot ? "n/a" : c.running ? "yes" : "NO"} | ${c.health} | ${c.restarts} |`);
  out.push("", `## Log scan — every source read since T0`, "");
  out.push(`${r.logScans.length} source(s) scanned. Fatal patterns fail the gate; warn patterns and generic error/warning lines are reported. One-shot member-agent containers are removed on exit, so their output is covered by the driver log.`, "");
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
    console.error(`[${NAME}] usage: bun run twin:gate --driver-log FILE [--report FILE] [--wait MIN] [--min-sessions N | --sessions N] [--min-attendance 0..1] [--stuck-after MIN] [--since ISO] [--waive PATTERN]...`);
    return 2;
  }
  const stateFile = join(repoRoot, ".agents", "smoke-state.json");
  if (!existsSync(stateFile)) { console.error(`[${NAME}] no ${stateFile} — is a twin running on this host?`); return 2; }
  const state = JSON.parse(readFileSync(stateFile, "utf8")) as { project: string; db?: string; smokeTwinContainer?: string };
  if (state.db !== "smoke-twin" || !state.smokeTwinContainer) { console.error(`[${NAME}] the running boot is not a smoke-twin (db=${state.db}).`); return 2; }

  const api = `${state.project}-api-1`;
  const t0 = parsed.since ?? new Date(sh(["docker", "inspect", api, "--format", "{{.State.StartedAt}}"]).out.trim()).toISOString();
  log(`project ${state.project}, twin db ${state.smokeTwinContainer}, T0 ${t0}`);

  const subjects = SMOKE_SUBJECTS.map((s) => s.id);
  const active = Number(psql(state.smokeTwinContainer, "SELECT count(*) FROM swarm_members WHERE status = 'active' AND role = 'member'")[0]?.[0] ?? 0);
  let rows = sessionRows(state.smokeTwinContainer, t0);
  let verdict = evaluateSessions(rows, subjects, active, parsed);
  const deadline = Date.now() + parsed.waitMin * 60_000;
  while (verdict.failures.length > 0 && Date.now() < deadline) {
    log(`waiting: ${verdict.failures.length} session condition(s) unmet — ${[...verdict.publishedBySubject].map(([s, n]) => `${s}=${n}`).join(" ")}`);
    await Bun.sleep(30_000);
    rows = sessionRows(state.smokeTwinContainer, t0);
    verdict = evaluateSessions(rows, subjects, active, parsed);
  }

  const checks: CheckRecord[] = [];
  const add = (id: string, title: string, failures: string[], detail: string[], warn = false) =>
    checks.push({ id, title, status: failures.length ? "FAIL" : warn ? "WARN" : "PASS", detail: [...failures, ...detail] });

  add("sessions", "Every subject published a judged, attended session convened or judged after T0 (database)", verdict.failures,
    [`${[...verdict.publishedBySubject].map(([s, n]) => `${s}: ${n} published`).join("; ")}`, `active analysts ${active} (judges file no takes)`]);

  const driverLines: string[] = [];
  let driverSessions: DriverSession[] = [];
  if (!parsed.driverLog) {
    add("driver", "The driver logged every subject's session as published with judge=enforce", ["no --driver-log given: the service's own account of each session was not read"], []);
  } else if (!existsSync(parsed.driverLog)) {
    add("driver", "The driver logged every subject's session as published with judge=enforce", [`driver log ${parsed.driverLog} not found`], []);
  } else {
    driverLines.push(...readFileSync(parsed.driverLog, "utf8").split("\n"));
    driverSessions = parseDriverSessions(driverLines);
    add("driver", "The driver logged every subject's session as published with judge=enforce", evaluateDriverSessions(driverSessions, subjects, parsed),
      [`${driverSessions.length} published line(s), ${driverSessions.filter((d) => d.judge === "enforce").length} judged`, `source: ${parsed.driverLog}`]);
  }

  const jobs = psql(state.smokeTwinContainer, `SELECT kind, status, count(*) FROM jobs WHERE created_at >= '${t0}'::timestamptz GROUP BY 1, 2 ORDER BY 1, 2`)
    .map(([kind, status, n]) => ({ kind: kind!, status: status!, count: Number(n) }));
  add("jobs", "No job created after T0 is dead", jobs.filter((j) => j.status === "dead").map((j) => `${j.count} dead '${j.kind}'`),
    [`${jobs.reduce((a, j) => a + j.count, 0)} job(s) across ${new Set(jobs.map((j) => j.kind)).size} kind(s)`]);

  const found = projectContainers(state.project);
  const containers = found.map((c) => ({ ...containerState(c.name), oneShot: c.oneShot }));
  const services = containers.filter((c) => !c.oneShot);
  const cFail: string[] = services.length ? [] : [`no service containers found for project ${state.project}`];
  for (const c of services) {
    if (!c.running) cFail.push(`${c.name}: not running`);
    if (c.health !== "none" && c.health !== "healthy") cFail.push(`${c.name}: health '${c.health}'`);
    if (c.restarts > 0) cFail.push(`${c.name}: restarted ${c.restarts} time(s)`);
  }
  add("containers", "Every service container is running, healthy and never restarted", cFail,
    [`${services.length} service container(s), ${containers.length - services.length} one-shot container(s) still present`]);

  // Every source, read ONCE: each container of the boot, the restored
  // database, and the driver's own log.
  const sources: { source: string; lines: RawLine[] }[] = [
    ...containers.map((c) => ({ source: c.name, lines: containerLogs(c.name, t0) })),
    { source: state.smokeTwinContainer, lines: containerLogs(state.smokeTwinContainer, t0) },
    ...(parsed.driverLog && driverLines.length ? [{ source: `driver: ${parsed.driverLog}`, lines: driverLines.map((text) => ({ ts: null, text })) }] : []),
    ...memberSessionLogs(repoRoot, state.project, Date.parse(t0)),
  ];
  const logScans: LogScan[] = sources.map(({ source, lines }) => scanLog(source, lines.map((l) => l.text), parsed.waive));
  const rules = validateRules(JSON.parse(readFileSync(CLASSIFICATIONS_PATH, "utf8")));
  const classified = classify(sources.flatMap(({ source, lines }) => inventory(source, lines)), rules);
  const inv = inventoryVerdict(classified, "post-release");
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
    project: state.project,
    twinDb: state.smokeTwinContainer,
    t0,
    finishedAt: new Date().toISOString(),
    args: parsed,
    verdict: failed.length ? "FAIL" : "PASS",
    checks,
    sessions: rows,
    driverSessions,
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
  log("PASS — every subject closed a session this boot, no job died, no container restarted, no fatal log line.");
  return 0;
}

if (import.meta.main) process.exit(await main());
