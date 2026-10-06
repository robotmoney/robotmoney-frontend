// The pure decisions both gates share (twin:gate, prod:gate). No IO.
//
// The model-outcome rule lives here and in log-classifications.json, and both
// halves say the same thing:
//   - a model timing out, or returning a take the server rejects, is a model
//     outcome (owner, 2026-09-25): the member is absent from that session, the
//     gate reports it and does not fail on it;
//   - a dead judge, or a session that published without a model judgement and a
//     receipt, is a platform failure and always fails.

import type { ContainerState } from "./io.ts";

export type CheckStatus = "PASS" | "FAIL" | "WARN";
export interface CheckRecord { id: string; title: string; status: CheckStatus; detail: string[] }

/** A session as the database records it. */
export interface SessionRow {
  id: string;
  subject: string;
  state: string;
  /** `swarm_sessions.judging_outcome`: judged | no_consensus | not_judged, null until published. */
  outcome: string | null;
  /** Minutes since the session convened. */
  ageMin: number;
  /** Epoch ms the session published at, or null. */
  publishedAtMs: number | null;
  /** Distinct members with a signed take (swarm_recommendations). */
  takes: number;
  /** An applied model/enforce judgement exists. */
  judged: boolean;
  /** A consensus receipt exists. */
  receipt: boolean;
}

export interface SessionGradeOptions {
  minSessions: number;
  /** N good sessions in total, whatever their subjects, instead of minSessions per subject. */
  totalSessions?: number;
  minAttendance: number;
  stuckAfterMin: number;
  /** FAIL when nothing has published for this many hours. Omit to skip. */
  livenessHours?: number;
  nowMs: number;
}

export interface SessionVerdict {
  failures: string[];
  warnings: string[];
  goodBySubject: Map<string, number>;
}

/**
 * PURE. Grade the sessions of the window.
 *
 *  - published `no_consensus` is an acceptable outcome (owner, 2026-10-06; runbook
 *    R7.6): it is a WARNING, it needs no judgement or receipt, and it is never
 *    counted as a good session, so a judge that never forms a consensus still
 *    fails the per-subject minimum and the participants check;
 *  - published with any other outcome than `judged` (judge off, `not_judged`, none)
 *    FAILS, as does `judged` without an applied model judgement or a consensus
 *    receipt: an unjudged publish is a platform failure;
 *  - a session still open past `stuckAfterMin` FAILS;
 *  - a session under the attendance bar is a WARNING, not a failure: a take that
 *    timed out or was rejected is a model outcome;
 *  - a subject needs `minSessions` good (judged, receipted, attended) sessions,
 *    or `totalSessions` good sessions across all subjects;
 *  - with `livenessHours`, nothing published for that long FAILS.
 */
export function evaluateSessions(
  rows: readonly SessionRow[],
  subjects: readonly string[],
  activeAnalysts: number,
  opts: SessionGradeOptions,
): SessionVerdict {
  const failures: string[] = [];
  const warnings: string[] = [];
  const need = Math.max(1, Math.ceil(activeAnalysts * opts.minAttendance));
  const goodBySubject = new Map(subjects.map((s) => [s, 0]));
  for (const r of rows) {
    if (r.state === "published") {
      if (r.outcome === "no_consensus") {
        warnings.push(`session ${r.id} (${r.subject}) published no_consensus: an acceptable outcome, not counted as a good session`);
      } else {
        if (r.outcome !== "judged") failures.push(`session ${r.id} (${r.subject}) published unjudged (judging outcome '${r.outcome ?? "none"}')`);
        if (!r.judged) failures.push(`session ${r.id} (${r.subject}) published without an applied model/enforce judgement`);
        if (!r.receipt) failures.push(`session ${r.id} (${r.subject}) published without a consensus receipt`);
      }
      if (r.takes < need) warnings.push(`session ${r.id} (${r.subject}) published with ${r.takes} take(s), under ${need} of ${activeAnalysts} active`);
      if (r.outcome === "judged" && r.judged && r.receipt && r.takes >= need) goodBySubject.set(r.subject, (goodBySubject.get(r.subject) ?? 0) + 1);
    } else if (r.state !== "cancelled" && r.ageMin > opts.stuckAfterMin) {
      failures.push(`session ${r.id} (${r.subject}) stuck in '${r.state}' for ${Math.round(r.ageMin)} min`);
    }
  }
  if (opts.totalSessions !== undefined) {
    const n = [...goodBySubject.values()].reduce((a, b) => a + b, 0);
    if (n < opts.totalSessions) failures.push(`${n} published, judged, attended session(s) in the window; need ${opts.totalSessions}`);
  } else {
    for (const [subject, n] of goodBySubject) {
      if (n < opts.minSessions) failures.push(`subject ${subject}: ${n} published, judged, attended session(s) in the window; need ${opts.minSessions}`);
    }
  }
  if (opts.livenessHours !== undefined) {
    const last = rows.reduce((m, r) => Math.max(m, r.state === "published" ? (r.publishedAtMs ?? 0) : 0), 0);
    const idleH = last ? (opts.nowMs - last) / 3_600_000 : Infinity;
    if (idleH > opts.livenessHours) {
      failures.push(`no session has published for ${Number.isFinite(idleH) ? `${idleH.toFixed(1)} h` : "the whole window"} (limit ${opts.livenessHours} h): sessions have stopped`);
    }
  }
  return { failures, warnings, goodBySubject };
}

/**
 * PURE. The standing participants: at least one judge and one agent must be a
 * running, unrestarted container. A crash-looping judge restarts under
 * `restart: unless-stopped`, so a restart count is how a dead judge shows here.
 */
export function evaluateParticipants(containers: readonly ContainerState[], strictRestarts = true): { failures: string[]; detail: string[] } {
  const failures: string[] = [];
  const kinds = ["judge", "agent"] as const;
  const detail: string[] = [];
  for (const kind of kinds) {
    const of = containers.filter((c) => c.participantKind === kind);
    detail.push(`${of.length} ${kind} participant container(s)`);
    if (of.length === 0) failures.push(`no ${kind} participant container in the project: ${kind === "judge" ? "no session can be judged" : "no session can gather a take"}`);
    for (const c of of) {
      if (!c.running) failures.push(`${c.name}: ${kind} participant not running`);
      else if (strictRestarts && c.restarts > 0) failures.push(`${c.name}: ${kind} participant restarted ${c.restarts} time(s)`);
    }
  }
  return { failures, detail };
}

/**
 * PURE. The judge config row. On main the judge is a participant, and a session
 * is judged only while the config is `enforce`; `off` publishes every session
 * `not_judged`, which is not what production does.
 */
export function evaluateJudgeConfig(row: { mode: string } | undefined): { status: CheckStatus; detail: string[] } {
  if (!row) return { status: "FAIL", detail: ["swarm_judge_config has no row"] };
  if (row.mode !== "enforce") return { status: "FAIL", detail: [`mode=${row.mode}: every session publishes unjudged; production runs enforce`] };
  return { status: "PASS", detail: ["mode=enforce"] };
}

/** Every service container of a project: running, healthy where it has a check, and (strict) never restarted. */
export function evaluateContainers(containers: readonly ContainerState[], project: string, strictRestarts: boolean): { failures: string[]; warnings: string[]; services: ContainerState[] } {
  const services = containers.filter((c) => !c.oneShot);
  const failures = services.length ? [] : [`no service containers found for project ${project}`];
  const warnings: string[] = [];
  for (const c of services) {
    if (!c.running) failures.push(`${c.name}: not running`);
    if (c.health !== "none" && c.health !== "healthy") failures.push(`${c.name}: health '${c.health}'`);
    if (c.restarts > 0) (strictRestarts ? failures : warnings).push(`${c.name}: restarted ${c.restarts} time(s)`);
  }
  return { failures, warnings, services };
}
