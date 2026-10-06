#!/usr/bin/env bun
// `bun run twin:accelerate` — put a stage twin's sessions on an accelerated schedule.
//
// WHY THIS EXISTS. A twin restored from production carries production's subjects, and
// with them production's 6 h epochs (B3 keeps them, and a boot on a populated database
// changes no scheduling column: system-scheduler-spec.md §8). So a rehearsal waited up
// to six hours for its first publish, and every lifecycle check (judge, receipt,
// twin:gate, the soak window) waited with it. The specs name the remedy:
// "A rehearsal that wants short epochs or a short judging wait on a copy of production
// changes the subjects through the admin API" (system-scheduler-spec.md §2.3, §8;
// smoke-production-spec.md §4.4). Nothing did that. This command does, as an explicit
// operator step of the stage runbook (standing check SR.9), never as part of a boot.
//
// WHAT IT DOES, per active subject i of n, with E the epoch and now the database clock:
//   1. Pulls the twin's open (`collecting`) window in to close_i = now + (i+1)·E/n, so
//      the subjects publish spread across one epoch instead of hours out. It only moves
//      a close EARLIER, on the twin's own restored container (the same rule as the CI
//      dump re-time, restore-container.ts retimeAdoptedWindows).
//   2. Sets epochDuration = E (and judgingDurationSeconds, when asked) through the admin
//      API with epochAnchor = close_i, so every later close is close_i + k·E: the real
//      scheduler runs the real grid, only shorter.
//   3. Restarts the system-scheduler container. Its timers are armed only by a rebuild
//      (clock.ts), and an `updated` subject.changed event deliberately re-arms nothing,
//      so without the restart the scheduler would keep production's six-hour timers.
//   4. Waits for the scheduler to report healthy and writes a receipt in the instance's
//      state directory.
//
// REFUSES (exit 2, nothing written) unless the instance's stack is a smoke-twin
// (`--local dump`), and whenever RM_ENV is prod. A deployment's database is never
// touched: the re-time runs inside the twin's own restore container.
//
// Run it AFTER the realistic-grid checks that need production's epochs (R3.5's B3
// proof: epoch_duration_seconds = 21600, closes on the continued grid), and BEFORE the
// checks that need sessions to publish (twin:gate, soak window, the judge).
//
//   bun run twin:accelerate --instance NAME [--epoch SECONDS] [--judging SECONDS]

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Buffer } from "node:buffer";
import { ROUTES, path as routePath } from "@robotmoney/contract";
import { resolveGateStack } from "./lib/gate/stack.ts";
import { serviceContainer, sh } from "./lib/gate/io.ts";
import { readServiceToken } from "./lib/smoke-secret.ts";

const NAME = "twin:accelerate";
const log = (m: string) => console.log(`[${NAME}] ${m}`);

export const DEFAULT_EPOCH_SECONDS = 900;
/** Below this a window cannot hold one round of takes from a full roster plus the judge. */
export const MIN_EPOCH_SECONDS = 300;

export interface Args { epoch: number; judging: number | null }

export function parseArgs(argv: readonly string[]): Args | { error: string } {
  const val = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };
  const whole = (flag: string): number | null | { error: string } => {
    if (!argv.includes(flag)) return null;
    const v = val(flag);
    if (v === undefined || !/^\d+$/.test(v)) return { error: `${flag} takes a whole number of seconds.` };
    return Number(v);
  };
  const epoch = whole("--epoch");
  if (epoch !== null && typeof epoch === "object") return epoch;
  const judging = whole("--judging");
  if (judging !== null && typeof judging === "object") return judging;
  const e = epoch ?? DEFAULT_EPOCH_SECONDS;
  if (e < MIN_EPOCH_SECONDS) return { error: `--epoch ${e} is under ${MIN_EPOCH_SECONDS} s: one round of takes and a judgement does not fit.` };
  if (judging !== null && judging < 60) return { error: `--judging ${judging} is under 60 s.` };
  return { epoch: e, judging };
}

/** PURE. Subject i of n closes at now + (i+1)·E/n: the subjects spread across one epoch. */
export function planCloses(nowMs: number, epochSeconds: number, subjectIds: readonly string[]): Array<{ subjectId: string; closeMs: number }> {
  const n = subjectIds.length;
  return subjectIds.map((subjectId, i) => ({ subjectId, closeMs: nowMs + Math.round(((i + 1) * epochSeconds * 1000) / n) }));
}

/** PURE. The re-time: only a `collecting` window of this subject, only ever EARLIER. psql variables, never spliced. */
export const RETIME_SQL =
  "UPDATE swarm_sessions SET window_closes_at = :'close'::timestamptz " +
  "WHERE state = 'collecting' AND subject_id = :'sid' AND window_closes_at > :'close'::timestamptz " +
  "RETURNING id, window_closes_at";

/**
 * PURE. The re-time's psql argv. The SQL goes on STDIN (`-f -`): psql substitutes
 * `:'var'` only in input it reads, never in a `-c` command (stage-2, 2026-10-06:
 * "syntax error at or near ':'").
 */
export function retimeArgv(twin: string, close: string, subjectId: string): string[] {
  return ["docker", "exec", "-i", twin, "psql", "-U", "restore_check", "-d", "rm_restore_check", "-X", "-A", "-t", "-F", "\t",
    "-v", "ON_ERROR_STOP=1", "-v", `close=${close}`, "-v", `sid=${subjectId}`, "-f", "-"];
}

function psqlStdin(argv: string[], sqlText: string): { code: number; out: string } {
  const p = Bun.spawnSync(argv, { stdin: Buffer.from(sqlText + "\n"), stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode ?? 1, out: `${p.stdout.toString()}${p.stderr.toString()}` };
}

/** The refusal for this environment, or null. */
export function refusal(env: Record<string, string | undefined>): string | null {
  if ((env.RM_ENV ?? "").trim().toLowerCase() === "prod") {
    return "Refusing: RM_ENV is prod. twin:accelerate changes a twin's schedule only; production keeps its epochs.";
  }
  return null;
}

interface AdminSubject { id: string; status: string; version: number; epochDuration: number | null; judgingDurationSeconds: number | null }

async function main(argv: string[]): Promise<number> {
  const env = process.env as Record<string, string | undefined>;
  const refused = refusal(env);
  if (refused) { console.error(`[${NAME}] ${refused}`); return 2; }
  const args = parseArgs(argv);
  if ("error" in args) { console.error(`[${NAME}] ${args.error}`); return 2; }

  let stack;
  try {
    stack = resolveGateStack(argv, env, ["smoke-twin"]);
  } catch (err) {
    console.error(`[${NAME}] ${(err as Error).message}`);
    return 2;
  }
  const twin = stack.record.smokeTwinContainer;
  if (!twin) { console.error(`[${NAME}] Refusing: the stack record names no smoke-twin container.`); return 2; }
  const base = `http://127.0.0.1:${stack.record.apiPort}`;
  const token = readServiceToken(stack.paths, "operator");
  const headers = { "X-Automation-Token": token };

  const listRes = await fetch(`${base}${ROUTES.swarm.admin.subjects}`, { headers });
  if (!listRes.ok) { console.error(`[${NAME}] GET ${ROUTES.swarm.admin.subjects} -> ${listRes.status}`); return 1; }
  const subjects = ((await listRes.json()) as { subjects?: AdminSubject[] }).subjects ?? [];
  const active = subjects.filter((s) => s.status === "active").sort((a, b) => a.id.localeCompare(b.id));
  if (active.length === 0) { console.error(`[${NAME}] no active subject on this twin`); return 1; }

  // The database's clock, not this host's: every close the scheduler compares is the database's.
  const nowRes = sh(["docker", "exec", twin, "psql", "-U", "restore_check", "-d", "rm_restore_check", "-X", "-A", "-t", "-c", "SELECT (extract(epoch FROM clock_timestamp()) * 1000)::bigint"]);
  if (nowRes.code !== 0) { console.error(`[${NAME}] could not read the twin's clock: ${nowRes.out}`); return 1; }
  const nowMs = Number(nowRes.out.trim());
  const plan = planCloses(nowMs, args.epoch, active.map((s) => s.id));

  log(`instance ${stack.instance}, project ${stack.project}, twin ${twin}: epoch ${args.epoch} s${args.judging !== null ? `, judging ${args.judging} s` : ""}, ${active.length} active subject(s)`);
  const results: Array<Record<string, unknown>> = [];
  for (const { subjectId, closeMs } of plan) {
    const subject = active.find((s) => s.id === subjectId)!;
    const close = new Date(closeMs).toISOString();
    const r = psqlStdin(retimeArgv(twin, close, subjectId), RETIME_SQL);
    if (r.code !== 0) { console.error(`[${NAME}] re-time of ${subjectId} failed: ${r.out}`); return 1; }
    const retimed = r.out.split("\n").filter((l) => /^[0-9a-f-]{36}\t/.test(l)).map((l) => l.split("\t")[0]);
    const body: Record<string, unknown> = { expectedVersion: subject.version, epochDuration: args.epoch, epochAnchor: close };
    if (args.judging !== null) body.judgingDurationSeconds = args.judging;
    const path = routePath(ROUTES.swarm.admin.subjectUpdate, { id: subjectId });
    const u = await fetch(`${base}${path}`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!u.ok) { console.error(`[${NAME}] POST ${path} -> ${u.status}: ${await u.text()}`); return 1; }
    log(`${subjectId}: epoch ${subject.epochDuration ?? "unset"} s -> ${args.epoch} s, anchor ${close}; open window ${retimed.length ? `re-timed to ${close}` : "already closes sooner (or none open)"}`);
    results.push({ subjectId, previousEpochSeconds: subject.epochDuration, epochSeconds: args.epoch, anchor: close, retimedSessions: retimed, judgingSeconds: args.judging ?? subject.judgingDurationSeconds });
  }

  const scheduler = serviceContainer(stack.project, "system-scheduler");
  if (!scheduler) { console.error(`[${NAME}] project ${stack.project} has no system-scheduler container`); return 1; }
  log(`restarting ${scheduler} so it rebuilds its timers from the new closes`);
  const restart = sh(["docker", "restart", scheduler]);
  if (restart.code !== 0) { console.error(`[${NAME}] docker restart failed: ${restart.out}`); return 1; }
  let health = "";
  for (let i = 0; i < 60; i++) {
    health = sh(["docker", "inspect", "-f", "{{.State.Health.Status}}", scheduler]).out.trim();
    if (health === "healthy") break;
    await Bun.sleep(2000);
  }
  if (health !== "healthy") { console.error(`[${NAME}] the scheduler did not report healthy after the restart (last: ${health || "unknown"})`); return 1; }
  log(`scheduler healthy; first close ${new Date(plan[0]!.closeMs).toISOString()}, then one subject every ${Math.round(args.epoch / active.length)} s`);

  const receipt = join(stack.paths.dir, `twin-accelerate-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(receipt, JSON.stringify({ instance: stack.instance, project: stack.project, twin, at: new Date(nowMs).toISOString(), epochSeconds: args.epoch, judgingSeconds: args.judging, subjects: results, schedulerRestarted: scheduler }, null, 2) + "\n", { mode: 0o600 });
  log(`receipt: ${receipt}`);
  return 0;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
