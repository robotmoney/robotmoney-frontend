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
// It reads the twin through `docker exec` into the restore container and
// `docker logs`, using .agents/smoke-state.json — run it on the twin's host.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SMOKE_SUBJECTS } from "./lib/smoke-mode.ts";

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
  minAttendance: number;
  stuckAfterMin: number;
  waitMin: number;
  since?: string;
  waive: string[];
  /** The driver's own output (smoke:twin tee'd to a file): per-session published/judge lines. */
  driverLog?: string;
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
      case "--stuck-after":
      case "--wait": {
        const e = need();
        if (e) return { error: e };
        const n = num(0, 10_000);
        if (n === null) return { error: `${a} takes a number, got "${v}".` };
        if (a === "--min-sessions") out.minSessions = Math.max(1, Math.floor(n));
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
  args: Pick<GateArgs, "minSessions" | "minAttendance" | "stuckAfterMin">,
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
  for (const s of subjects) {
    const n = publishedBySubject.get(s) ?? 0;
    if (n < args.minSessions) failures.push(`subject ${s}: ${n} session(s) convened and published this boot; need ${args.minSessions}`);
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
  args: Pick<GateArgs, "minSessions" | "minAttendance">,
): string[] {
  const failures: string[] = [];
  for (const s of subjects) {
    const good = sessions.filter(
      (d) => d.subject === s && d.state === "published" && d.judge === "enforce" && d.takes >= Math.max(1, Math.ceil(d.active * args.minAttendance)),
    ).length;
    if (good < args.minSessions) failures.push(`driver log: subject ${s} logged ${good} published+judged+attended session(s); need ${args.minSessions}`);
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
       FROM swarm_sessions s WHERE s.convened_at >= '${t0}'::timestamptz ORDER BY s.convened_at`,
  ).map(([id, subject, state, age, takes, judged, receipt]) => ({
    id: id!, subject: subject!, state: state!, ageMin: Number(age), takes: Number(takes), judged: judged === "t", receipt: receipt === "t",
  }));
}

function projectContainers(project: string): string[] {
  const r = sh(["docker", "ps", "-a", "--filter", `label=com.docker.compose.project=${project}`, "--format", "{{.Names}}"]);
  // One-shot `run` containers (migrations, member agents) exit by design.
  return r.out.split("\n").filter((n) => n && !/-run-|member-agent/.test(n));
}

interface ContainerState { name: string; running: boolean; health: string; restarts: number }
function containerState(name: string): ContainerState {
  const r = sh(["docker", "inspect", name, "--format", "{{.State.Running}}\t{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}\t{{.RestartCount}}"]);
  const [running, health, restarts] = r.out.trim().split("\t");
  return { name, running: running === "true", health: health ?? "?", restarts: Number(restarts ?? 0) };
}

function log(m: string) { console.log(`[${NAME}] ${m}`); }

async function main(): Promise<number> {
  const parsed = parseGateArgs(process.argv.slice(2));
  if ("error" in parsed) {
    console.error(`[${NAME}] ${parsed.error}`);
    console.error(`[${NAME}] usage: bun run twin:gate [--driver-log FILE] [--wait MIN] [--min-sessions N] [--min-attendance 0..1] [--stuck-after MIN] [--since ISO] [--waive PATTERN]...`);
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
  let verdict = evaluateSessions(sessionRows(state.smokeTwinContainer, t0), subjects, active, parsed);
  const deadline = Date.now() + parsed.waitMin * 60_000;
  while (verdict.failures.length > 0 && Date.now() < deadline) {
    log(`waiting: ${verdict.failures.length} session condition(s) unmet — ${[...verdict.publishedBySubject].map(([s, n]) => `${s}=${n}`).join(" ")}`);
    await Bun.sleep(30_000);
    verdict = evaluateSessions(sessionRows(state.smokeTwinContainer, t0), subjects, active, parsed);
  }

  const failures: string[] = [...verdict.failures];
  const driverLines: string[] = [];
  if (parsed.driverLog) {
    if (!existsSync(parsed.driverLog)) failures.push(`driver log ${parsed.driverLog} not found`);
    else {
      driverLines.push(...readFileSync(parsed.driverLog, "utf8").split("\n"));
      const ds = parseDriverSessions(driverLines);
      log(`driver log: ${ds.length} published session line(s); judged=${ds.filter((d) => d.judge === "enforce").length}`);
      failures.push(...evaluateDriverSessions(ds, subjects, parsed));
    }
  } else {
    log("warn: no --driver-log — the log-side session/judge check did not run (the runbook requires it)");
  }
  log(`sessions: ${[...verdict.publishedBySubject].map(([s, n]) => `${s}=${n} published`).join(", ")} (active analysts ${active}; judges file no takes)`);

  for (const [kind, n] of psql(state.smokeTwinContainer, `SELECT kind, count(*) FROM jobs WHERE status = 'dead' AND created_at >= '${t0}'::timestamptz GROUP BY kind`)) {
    failures.push(`jobs: ${n} dead '${kind}' job(s) since T0`);
  }

  const names = projectContainers(state.project);
  if (names.length === 0) failures.push(`containers: none found for project ${state.project}`);
  const logLines: string[] = [];
  for (const name of names) {
    const c = containerState(name);
    if (!c.running) failures.push(`container ${name}: not running`);
    if (c.health !== "none" && c.health !== "healthy") failures.push(`container ${name}: health '${c.health}'`);
    if (c.restarts > 0) failures.push(`container ${name}: restarted ${c.restarts} time(s)`);
    logLines.push(...sh(["docker", "logs", "--since", t0, name]).out.split("\n"));
  }
  logLines.push(...sh(["docker", "logs", "--since", t0, state.smokeTwinContainer]).out.split("\n"));
  logLines.push(...driverLines);
  const logs = classifyLog(logLines, parsed.waive);
  for (const [p, n] of logs.fatal) failures.push(`logs: ${n} line(s) matching "${p}"`);
  for (const [p, n] of logs.waived) log(`WAIVED: ${n} line(s) matching "${p}" (--waive)`);
  for (const [p, n] of logs.warn) log(`warn: ${n} line(s) matching "${p}"`);

  if (failures.length > 0) {
    for (const f of failures) console.error(`[${NAME}] FAIL ${f}`);
    console.error(`[${NAME}] FAIL — ${failures.length} problem(s). This rehearsal does NOT support the release.`);
    return 1;
  }
  log("PASS — every subject closed a session this boot, no job died, no container restarted, no fatal log line.");
  return 0;
}

if (import.meta.main) process.exit(await main());
