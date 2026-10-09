#!/usr/bin/env bun
// scripts/release/schedule-parity.ts — release step R7.4a, run ON THE TARGET HOST
// the watch length after READY (./watch.ts). Owner rule (v0-6-0-rollout.md section 0): an
// upgrade does not change usual schedules.
//
//   bun scripts/release/schedule-parity.ts --instance <name> --run <run-ts> [--sessions graded|deferred] --receipt-dir <dir>
//
// Read-only (rm_readonly on a proven read-only session, ./db-read.ts; docker
// inspect for one container's environment). It checks:
//   1. every active subject reads epoch_duration_seconds = 86400 (owner decision 2026-10-09);
//   2. every session in flight at R2.3 (baseline.json `inFlight`) published,
//      its window close unmoved, within its judging duration plus a grace
//      after that close;
//   3. the regime run lands at :30 (the analytics-producer container's
//      PRODUCER_REGIME_CRON, or the compose default, has minute 30);
//   4. it REPORTS the last parity sweep's duration, and fails a dead one.
// The stage target runs it unchanged: it is not accelerated.
//
// `--sessions` comes from the target's `watchSessions` (./target.ts). With
// `graded` (the default, and always production) check 2 runs in full. With
// `deferred` (stage's 15-minute watch, owner decision 2026-10-08) no in-flight
// session can have closed yet, so check 2 keeps only what holds at READY plus
// minutes: every in-flight session still exists and its close did not move.
// Checks 1, 3 and 4 run the same either way.
// Writes schedule-parity.json to --receipt-dir.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { instancePaths, readStackState, stateRoot } from "../lib/smoke-state.ts";
import { openReadOnly } from "./db-read.ts";
import { releaseStateDir } from "./release-state.ts";
import { PRODUCTION_EPOCH_SECONDS, PUBLISH_GRACE_SECONDS, WATCH_SESSIONS, type WatchSessions } from "./watch.ts";

// One source for the epoch and the grace: the watch length (./watch.ts) is derived from them.
export { PRODUCTION_EPOCH_SECONDS, PUBLISH_GRACE_SECONDS };
/** docker-compose.yml's default when PRODUCER_REGIME_CRON is unset (scripts/standing-soak.ts DEFAULT_REGIME_CRON). */
export const DEFAULT_REGIME_CRON = "30 22 * * *";

export interface BaselineSession { readonly id: string; readonly subject: string; readonly state: string; readonly window_closes_at: string | null }
export interface CurrentSession {
  readonly id: string; readonly state: string; readonly window_closes_at: string | null; readonly published_at: string | null;
  readonly judging_duration_seconds: number;
}

/** PURE. Active subjects whose epoch is not production's 6 h. */
export function epochProblems(subjects: readonly { id: string; epoch_duration_seconds: number }[]): string[] {
  return subjects.filter((s) => Number(s.epoch_duration_seconds) !== PRODUCTION_EPOCH_SECONDS)
    .map((s) => `subject ${s.id} epoch is ${s.epoch_duration_seconds} s, not ${PRODUCTION_EPOCH_SECONDS}`);
}

/** PURE. Every in-flight baseline session that did not publish on its normal close. */
export function inFlightProblems(baseline: readonly BaselineSession[], current: readonly CurrentSession[], graceSeconds = PUBLISH_GRACE_SECONDS): string[] {
  const out: string[] = [];
  const byId = new Map(current.map((c) => [c.id, c]));
  for (const b of baseline) {
    const c = byId.get(b.id);
    if (!c) { out.push(`session ${b.id} (${b.subject}) is gone`); continue; }
    if (c.state !== "published") { out.push(`session ${b.id} (${b.subject}) is ${c.state}, not published`); continue; }
    const was = b.window_closes_at ? Date.parse(b.window_closes_at) : NaN;
    const close = c.window_closes_at ? Date.parse(c.window_closes_at) : NaN;
    if (!Number.isNaN(was) && Math.abs(close - was) > 1000) out.push(`session ${b.id} (${b.subject}) close moved from ${b.window_closes_at} to ${c.window_closes_at}`);
    const pub = c.published_at ? Date.parse(c.published_at) : NaN;
    if (Number.isNaN(pub) || Number.isNaN(close)) { out.push(`session ${b.id} (${b.subject}) has no close or publish time`); continue; }
    const latest = close + (c.judging_duration_seconds + graceSeconds) * 1000;
    if (pub < close) out.push(`session ${b.id} (${b.subject}) published before its close`);
    else if (pub > latest) out.push(`session ${b.id} (${b.subject}) published ${Math.round((pub - close) / 60000)} min after its close`);
  }
  return out;
}

/**
 * PURE. The deferred form of check 2: every in-flight baseline session still
 * exists and its window close did not move. Whether it published is left to
 * a graded watch: a 24 h epoch cannot close inside a short stage watch.
 */
export function inFlightCloseProblems(baseline: readonly BaselineSession[], current: readonly CurrentSession[]): string[] {
  const out: string[] = [];
  const byId = new Map(current.map((c) => [c.id, c]));
  for (const b of baseline) {
    const c = byId.get(b.id);
    if (!c) { out.push(`session ${b.id} (${b.subject}) is gone`); continue; }
    const was = b.window_closes_at ? Date.parse(b.window_closes_at) : NaN;
    const close = c.window_closes_at ? Date.parse(c.window_closes_at) : NaN;
    if (!Number.isNaN(was) && (Number.isNaN(close) || Math.abs(close - was) > 1000)) {
      out.push(`session ${b.id} (${b.subject}) close moved from ${b.window_closes_at} to ${c.window_closes_at}`);
    }
  }
  return out;
}

/** PURE. Check 2 for a watch mode: graded runs it in full, deferred only the close check. */
export function inFlightProblemsFor(sessions: WatchSessions, baseline: readonly BaselineSession[], current: readonly CurrentSession[]): string[] {
  return sessions === "graded" ? inFlightProblems(baseline, current) : inFlightCloseProblems(baseline, current);
}

/** PURE. The `--sessions` value; absent means graded. */
export function parseSessionsFlag(value: string | undefined): WatchSessions | { error: string } {
  if (value === undefined) return "graded";
  return (WATCH_SESSIONS as readonly string[]).includes(value) ? (value as WatchSessions) : { error: `--sessions is ${WATCH_SESSIONS.join(" or ")}, got "${value}"` };
}

/** PURE. The regime cron's minute must be 30. */
export function regimeCronProblems(cron: string): string[] {
  const minute = cron.trim().split(/\s+/)[0];
  return minute === "30" ? [] : [`the regime cron "${cron}" runs at minute ${minute ?? "?"}, not :30`];
}

/** PURE. The last parity sweep, for the report; a dead one fails. */
export function paritySweep(last: { status: string; secs: number | null } | undefined): { problems: string[]; detail: string } {
  if (!last) return { problems: [], detail: "no parity sweep has run" };
  const detail = `last parity sweep ${last.status}${last.secs === null ? "" : ` in ${Number(last.secs).toFixed(1)} s`}`;
  return { problems: last.status === "dead" ? [detail] : [], detail };
}

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

function producerCron(instance: string): { cron: string; source: string } | { error: string } {
  const record = readStackState(instancePaths(stateRoot(process.env), instance));
  if (!record) return { error: `instance ${instance} has no stack record` };
  const ps = spawnSync("docker", ["ps", "-q", "--filter", `label=com.docker.compose.project=${record.project}`,
    "--filter", "label=com.docker.compose.service=analytics-producer"], { encoding: "utf8" });
  const id = ps.stdout.split("\n").map((l) => l.trim()).filter(Boolean)[0];
  if (ps.status !== 0 || !id) return { error: `no running analytics-producer in ${record.project}` };
  const insp = spawnSync("docker", ["inspect", "--format", "{{json .Config.Env}}", id], { encoding: "utf8" });
  if (insp.status !== 0) return { error: "docker inspect failed" };
  const env = (JSON.parse(insp.stdout) as string[]).find((e) => e.startsWith("PRODUCER_REGIME_CRON="));
  const value = env?.slice("PRODUCER_REGIME_CRON=".length);
  return value ? { cron: value, source: "container" } : { cron: DEFAULT_REGIME_CRON, source: "compose default" };
}

async function main(): Promise<number> {
  const instance = flag("--instance");
  const run = flag("--run");
  const receiptDir = flag("--receipt-dir");
  const sessions = parseSessionsFlag(process.argv.includes("--sessions") ? (flag("--sessions") ?? "") : undefined);
  if (!instance || !run || !/^\d{8}T\d{6}Z$/.test(run) || !receiptDir || typeof sessions !== "string") {
    if (typeof sessions !== "string") console.error(`[schedule-parity] ${sessions.error}`);
    console.error("usage: bun scripts/release/schedule-parity.ts --instance <name> --run <run-ts> [--sessions graded|deferred] --receipt-dir <dir>");
    return 2;
  }
  let baseline: BaselineSession[];
  try {
    baseline = (JSON.parse(readFileSync(join(releaseStateDir(instance, run), "baseline.json"), "utf8")) as { inFlight?: BaselineSession[] }).inFlight ?? [];
  } catch (error) {
    console.error(`[schedule-parity] REFUSE: no R2.3 baseline for run ${run} (${error instanceof Error ? error.message : String(error)})`);
    return 1;
  }
  const safeIds = baseline.map((b) => b.id).filter((id) => /^[A-Za-z0-9_-]+$/.test(id));
  const db = await openReadOnly();
  let subjects: { id: string; epoch_duration_seconds: number }[];
  let current: CurrentSession[] = [];
  let last: { status: string; secs: number | null } | undefined;
  try {
    subjects = await db.query("SELECT id::text AS id, epoch_duration_seconds FROM swarm_subjects WHERE status = 'active' ORDER BY id");
    if (safeIds.length > 0) {
      current = (await db.query<CurrentSession>(
        `SELECT s.id::text AS id, s.state, s.window_closes_at, s.published_at, sub.judging_duration_seconds
           FROM swarm_sessions s JOIN swarm_subjects sub ON sub.id = s.subject_id
          WHERE s.id::text IN (${safeIds.map((id) => `'${id}'`).join(", ")})`,
      )).map((r) => ({
        ...r,
        window_closes_at: r.window_closes_at === null ? null : new Date(r.window_closes_at).toISOString(),
        published_at: r.published_at === null ? null : new Date(r.published_at).toISOString(),
        judging_duration_seconds: Number(r.judging_duration_seconds),
      }));
    }
    last = (await db.query<{ status: string; secs: number | null }>(
      "SELECT status, extract(epoch FROM updated_at - created_at)::float8 AS secs FROM jobs WHERE kind = 'analytics.parity_sweep' ORDER BY created_at DESC LIMIT 1",
    ))[0];
  } finally {
    await db.close();
  }
  const cron = producerCron(instance);
  const sweep = paritySweep(last);
  const problems = [
    ...epochProblems(subjects),
    ...inFlightProblemsFor(sessions, baseline, current),
    ...("error" in cron ? [cron.error] : regimeCronProblems(cron.cron)),
    ...sweep.problems,
  ];
  mkdirSync(receiptDir, { recursive: true, mode: 0o700 });
  const file = join(receiptDir, "schedule-parity.json");
  writeFileSync(file, `${JSON.stringify({
    step: "R7.4a", instance, run, sessions, subjects, inFlightAtBaseline: baseline, inFlightNow: current, regimeCron: cron, paritySweep: sweep.detail, problems, at: new Date().toISOString(),
  }, null, 2)}\n`, { mode: 0o600 });
  console.log(`[schedule-parity] ${subjects.length} active subject(s); ${baseline.length} session(s) in flight at R2.3 (sessions ${sessions}${sessions === "deferred" ? ": publish not checked, close unmoved checked" : ""}); regime cron ${"error" in cron ? "unread" : `${cron.cron} (${cron.source})`}; ${sweep.detail}`);
  console.log(`[schedule-parity] receipt: ${file}`);
  for (const p of problems) console.error(`[schedule-parity] FAIL: ${p}`);
  return problems.length === 0 ? 0 : 1;
}

if (import.meta.main) process.exitCode = await main();
