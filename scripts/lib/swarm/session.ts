// REST-path end-to-end swarm smoke (D21 — the MCP transport is retired; see
// docs/decisions.md D21). Drives one or more full swarm sessions where N
// independent agents participate over the swarm REST API (each its own key
// + token). One member per session is a deliberate no-show. Multi-session: the
// second session's brief references the first session's outcome, smokenstrating
// rotation awareness.
//
// THE LIFECYCLE IS THE SCHEDULER'S, AND THIS DRIVER ONLY OBSERVES IT (issue
// #1026 W4, D55 (4)). It used to drive the five epoch transitions itself —
// `epochs/open`, `turnover`, `aggregate`, `request-judging`, `finalize` — with a
// shared automation token. Those routes now accept only `system-scheduler`'s
// `lifecycle_transitions` right, and system-scheduler-spec.md §8 says what a
// test does instead: it "sets short epoch and judging durations and runs the
// real scheduler; it does not bypass the scheduler." So this driver sets the
// subject's epoch duration through the admin API (the operator's `admin`
// right), waits for the epoch the REAL scheduler opens, runs its members
// inside that window, and watches the scheduler settle it. Its own polls are
// on public reads; §9's no-polling rule is the scheduler's, not a driver's.
//
// This module replaces the retired mcp/src/e2e.ts. Only the per-member
// participation (./agent.ts) and the standalone main()'s former MCP-OAuth
// assertions changed with that.
import { demoAttends, path as routePath, ROUTES, STANCES } from "@robotmoney/contract";
import { runAgent, enroll, railFromEnv } from "./agent.ts";
import type { AgentStage, SessionRail } from "./agent.ts";
import { resolveSmokeCadence } from "../smoke-cadence.ts";
import type { SmokeCadence } from "../smoke-cadence.ts";
import { missingSectionLeadIns } from "./inference.ts";
import { generateKeyPair } from "./crypto.ts";
// The one builder for a compose prefix — argv topology AND the `--env-file`
// that keeps the repo's own `.env` out of an interpolated container.
import { composeArgs } from "../../stack/config.ts";
import { operatorTokenFromEnv } from "../operator-token.ts";

export function backendUrl(): string {
  return process.env.BACKEND_URL ?? "http://localhost:8787";
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The 5c/5d cross-role log lines below derive their annotation from the
// server's OBSERVED response status (issue #361 Phase 4), never from a mirror
// of the api's configuration: the analytics credential never reaches this
// driver (it belongs to the producer), and since D52 there is no env credential
// or insecure fallback left for a mirror to describe — every service bearer is
// validated against the api's token store.

// Run `fn` over `items` with at most `limit` invocations in flight, returning
// results in INPUT order as PromiseSettledResult — like Promise.allSettled but
// bounded. A rejecting item never sinks the batch (that is the whole point: one
// hung/failing swarm member must NOT freeze the whole session). `limit <= 0`
// or `Infinity` means unbounded (equivalent to Promise.allSettled). Pure and
// dependency-free so it is unit-testable hermetically.
export async function mapSettledWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results = new Array<PromiseSettledResult<R>>(items.length);
  const bound = limit > 0 && Number.isFinite(limit) ? limit : items.length;
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = { status: "fulfilled", value: await fn(items[i], i) };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  }
  // Spawn at most `bound` (and at most items.length) parallel workers, each
  // pulling the next index until the queue drains.
  const workers = Array.from({ length: Math.min(bound, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// ── Live-authored take invariants ───────────────────────────────────────────
// Fingerprint of the deterministic buildMemo template: every templated REGIME
// section carries this exact clause. A real keyless opencode-zen take will not
// reproduce it verbatim, so a match means the retired templated path leaked
// back into a live swarm session — fail loudly.
const OLD_TEMPLATE_RE = /the spread, not the composite, is where the signal lives/i;
// Canonical stance vocabulary from the contract (finding 027) — never re-declared.
const VALID_STANCES = new Set<string>(STANCES);

// Post-publish assertions over the LIVE-AUTHORED takes and the truthfulness of
// the attendance record. Throws on any failure so the standalone
// `bun run session.ts` entrypoint exits non-zero (main() catches and
// process.exit(1)) — this is the required-CI signal that the session ran
// through real inference (no template fallback) AND that the published absent
// list tells the truth about the members this driver ran.
//
// Deliberately NOT a per-member attendance requirement: a member whose model
// call times out or refuses the STANCE control line is DESIGNED to be absent
// (#301/#319), so the gate must not depend on every stochastic inference call
// succeeding (#803). It depends instead on the RECORD being truthful about
// the members the driver has ground truth on:
//
//  - `observedAbsent` — configured no-shows + containers that rejected. Every
//    one MUST appear in the published absent list; an under-report hides a
//    broken pipeline.
//  - `fulfilledMemberIds` — containers that resolved with a verified take.
//    Every one MUST have a live-authored take in the published payload and
//    MUST NOT appear in the published absent list; an over-report hides a take
//    that DID land.
//
// Members the driver did not run (e.g. a mid-run registered identity like the
// cross-role test fixture) carry no driver ground truth: the backend may
// legitimately count them absent for not submitting, and the gate says nothing
// about them.
// Which of the members this driver ran failed and which filed. `settled` is in
// `present`'s order (mapSettledWithConcurrency), so each result is read at its
// OWN index. Filtering first and then indexing the filtered list pinned a
// mid-list failure on the first member (boreas failed, athena was reported),
// which failed the attendance gate on the very runs it exists to tolerate.
export function settledAttendance(
  present: readonly { memberId: string }[],
  settled: readonly PromiseSettledResult<unknown>[],
): { failed: string[]; fulfilled: string[] } {
  const failed: string[] = [];
  const fulfilled: string[] = [];
  settled.forEach((s, i) => (s.status === "fulfilled" ? fulfilled : failed).push(present[i].memberId));
  return { failed, fulfilled };
}

export function assertAuthoredTakes(
  tag: string,
  takes: any[],
  attendance: AbsenceReport,
  observedAbsent: readonly string[],
  fulfilledMemberIds: readonly string[],
) {
  // Present-member takes are the ones that actually posted a body; absent
  // no-shows enrolled but never submitted, so they carry no body.
  const authored = (takes ?? []).filter(
    (t) => typeof t?.body === "string" && t.body.trim().length > 0,
  );
  if (authored.length === 0) {
    throw new Error(`${tag}: no authored takes to assert on (expected ≥1 present member)`);
  }
  const authoredIds = new Set(authored.map((t) => String(t.memberId)));
  const publishedAbsent = new Set(attendance.absent);
  // Directional attendance truthfulness over the members this driver ran.
  // Under-report: a member the driver saw fail is missing from the record.
  const unreported = observedAbsent.filter((id) => !publishedAbsent.has(id));
  if (unreported.length > 0) {
    throw new Error(
      `${tag}: published absent ${JSON.stringify([...publishedAbsent])} omits ` +
        `${JSON.stringify(unreported)} that this driver observed failing — an under-report hides ` +
        `a broken pipeline`,
    );
  }
  // Over-report: a member the driver saw submit is listed absent.
  const misreported = fulfilledMemberIds.filter((id) => publishedAbsent.has(id));
  if (misreported.length > 0) {
    throw new Error(
      `${tag}: published absent ${JSON.stringify([...publishedAbsent])} names ` +
        `${JSON.stringify(misreported)} that this driver saw submit — an over-report hides a take ` +
        `that DID land`,
    );
  }
  // A fulfilled container must have its take in the published payload.
  const missingTakes = fulfilledMemberIds.filter((id) => !authoredIds.has(id));
  if (missingTakes.length > 0) {
    throw new Error(
      `${tag}: fulfilled member ${JSON.stringify(missingTakes)} has no live-authored take in the ` +
        `published payload — a submission this driver verified did not land`,
    );
  }
  const seenBodies = new Map<string, string>();
  for (const t of authored) {
    const who = String(t.memberId);
    if (OLD_TEMPLATE_RE.test(t.body)) {
      throw new Error(`${tag}: take for ${who} matches the retired template fingerprint — not a real inference body`);
    }
    for (const lead of missingSectionLeadIns(t.body)) {
      throw new Error(`${tag}: take for ${who} is missing the ${lead} lead-in`);
    }
    if (!VALID_STANCES.has(String(t.stance))) {
      throw new Error(`${tag}: take for ${who} has stance '${t.stance}' outside {${[...STANCES].join(",")}}`);
    }
    const c = Number(t.confidence);
    if (!Number.isFinite(c) || c < 0 || c > 1) {
      throw new Error(`${tag}: take for ${who} has confidence ${t.confidence} outside [0,1]`);
    }
    for (const [otherWho, otherBody] of seenBodies) {
      if (otherBody === t.body) {
        throw new Error(`${tag}: take for ${who} is byte-identical to ${otherWho} — bodies must be distinct per member`);
      }
    }
    seenBodies.set(who, t.body);
  }
  console.log(`${tag}: authored-take invariants passed for ${authored.length} present member(s)`);
}

// ── Attendance reporting (issue #501) ───────────────────────────────────────
// Absence is a property of the SEATED ROSTER, never of the submitted takes.
// This report used to be derived from `pub.takes` — a filter over the rows that
// WERE submitted — so a member that produced no row at all could not appear in
// it by construction, and the driver logged `absent: []` for the very session
// it had just reported a take shortfall for. Every non-participation route ends
// the same way (no take row): a member container that fails or times out
// (mapSettledWithConcurrency rejects it below), and a control-line parse
// refusal — a live model answering `STANCE: cautiously constructive |
// CONFIDENCE: 0.65` is refused by parseStanceFromBody, which renders the member
// ABSENT rather than fabricating a neutral stance.
//
// The authoritative list is the backend's ROSTER-DERIVED
// `swarm_recommendation.absent` (backend/src/swarm/domain.ts aggregateSession:
// seated members minus submitters), whose `quorum` carries the same seated
// denominator the `takes=N of M` counter prints. Reading both from one object
// is what makes the counter and the list consistent by construction; the check
// below is the loud proof that they are.
export interface AbsenceReport {
  /** Seated roster size — the M in `takes=N of M` (quorum.active). */
  active: number;
  /** Seated members that submitted a take — the N (quorum.submitted). */
  submitted: number;
  /** Seated members that did NOT submit, by member id. */
  absent: string[];
}

// Throws when the published session cannot describe its own attendance (no
// rollup, malformed quorum) or when the counter and the list disagree. A
// session that under-reports absence is a failed session, not a quiet
// `absent: []`.
export function absenceReport(pub: any, tag = "session"): AbsenceReport {
  const rec = pub?.session?.swarmRecommendation;
  if (!rec) {
    throw new Error(
      `${tag}: published session carries no swarmRecommendation — attendance cannot be reported, ` +
        `and it must NEVER be re-derived from the submitted takes (a no-show has no take row at all).`,
    );
  }
  const quorum = rec.quorum;
  if (
    !quorum || typeof quorum.active !== "number" || typeof quorum.submitted !== "number" ||
    typeof quorum.absent !== "number"
  ) {
    throw new Error(`${tag}: swarmRecommendation.quorum is missing active/submitted/absent counts: ${JSON.stringify(quorum)}`);
  }
  if (!Array.isArray(rec.absent)) {
    throw new Error(`${tag}: swarmRecommendation.absent is not a list: ${JSON.stringify(rec.absent)}`);
  }
  const absent = rec.absent.map(String);
  const shortfall = quorum.active - quorum.submitted;
  if (shortfall !== absent.length || quorum.absent !== absent.length) {
    throw new Error(
      `${tag}: attendance is inconsistent — takes=${quorum.submitted} of ${quorum.active} (shortfall ${shortfall}), ` +
        `quorum.absent=${quorum.absent}, absent list has ${absent.length} member(s) ${JSON.stringify(absent)}`,
    );
  }
  return { active: quorum.active, submitted: quorum.submitted, absent };
}

// Deterministic attendance comes from the SHARED smoke no-show rule in
// @robotmoney/contract (contract/src/swarm.js) — the backend smoke e2e
// consumes the same rule, so the two drivers can no longer drift (finding 008
// retired the comment-enforced mirror). The roster outcome stays fixed (draco
// absent; athena/boreas/cygnus present) so the required hermetic e2e and any
// goldens stay reproducible.

export interface SessionMember {
  memberId: string;
  name: string;
  lens: string;
  bias: number;
  present: boolean;
}
export interface SessionSubject { id: string; name: string }

export const DEMO_MEMBERS: readonly SessionMember[] = Object.freeze([
  { memberId: "athena", name: "Athena", lens: "macro risk", bias: -0.1, present: demoAttends("athena") },
  { memberId: "boreas", name: "Boreas", lens: "on-chain flows", bias: 0.0, present: demoAttends("boreas") },
  { memberId: "cygnus", name: "Cygnus", lens: "momentum", bias: 0.15, present: demoAttends("cygnus") },
  { memberId: "draco", name: "Draco", lens: "contrarian", bias: 0.0, present: demoAttends("draco") },
  // Issue #922: smoke-local named-judge persona, kept in sync with the mirror
  // array in ../smoke-mode.ts. `memberId: "themis"` becomes both this driver's
  // registerMember() id AND (via deriveMemberHandle's slugify of the name
  // "Themis") her handle, which is what makes #918's judgeSessionAdmin —
  // hardcoded to resolve judgeMemberId by looking up handle 'themis' — find
  // her at all. Absent via the shared DEMO_NO_SHOWS rule, same as draco.
  { memberId: "themis", name: "Themis", lens: "consensus judge", bias: 0.0, present: demoAttends("themis") },
]);
export const DEMO_SUBJECTS: readonly SessionSubject[] = Object.freeze([
  { id: "woon", name: "Woon Treasury" },
  { id: "mav", name: "Mav Holdings" },
]);

// The standing-smoke roster cap now lives in @robotmoney/contract
// (SWARM_ROSTER_CAP) — the mirror this module used to carry is gone;
// consumers (scripts/lib/smoke-main.ts, backend domain) import the contract.

// The OPERATOR'S service token (smoke spec §3: the admin right) on an admin
// call. An in-process caller passes it explicitly. This module's standalone
// entry point runs as its own child process and reads it from the file
// RM_OPERATOR_TOKEN_FILE names (scripts/lib/operator-token.ts) — the file's
// path is in its environment, never the token.
export function operatorHeaders(token?: string): Record<string, string> {
  const operatorToken = token ?? operatorTokenFromEnv(process.env);
  return operatorToken ? { "X-Automation-Token": operatorToken } : {};
}

async function responseJson<T = any>(response: Response): Promise<T> {
  return await response.json() as T;
}

// Optional, additive progress stream for runSession. Emits real session-lifecycle
// transitions and per-member pipeline stages so a UI can render live swarm
// state. Default undefined ⇒ zero behaviour change (standalone main() never passes
// it). Members that are deliberate no-shows surface as stage 'absent'.
//
// `judgeMode` is carried ONLY by the `judged` event (issue #817). The state name
// alone cannot answer the question an operator watching the soak actually has —
// whether the session was settling under `enforce` at all, or was published
// `not_judged` because its captured mode was `off` (§4.4) — and encoding it into
// `state` would make the state string something no other consumer of this stream
// can match on. It is a separate optional field for that reason, and it is
// absent on every other event.
export type SessionEvent =
  // `judgeSource` (issue #969) says WHO AUTHORED the opinion — "model", or a
  // pre-#969 "fallback". The mode alone cannot draw that distinction: `judged
  // (enforce)` was equally true of a session whose opinion came from a template
  // because the judge had no model at all.
  | {
      type: "session"; state: string; sessionId?: string; subject: string; date: string;
      judgeMode?: string; judgeSource?: string;
    }
  | { type: "member"; memberId: string; stage: AgentStage | "absent"; stance?: string; confidence?: number };
export type SessionProgress = (ev: SessionEvent) => void;

/**
 * The session-lifecycle emitter runSession threads through its transitions —
 * one call per REAL state change, never a fabricated sub-step.
 *
 * It is a named export rather than a closure inside runSession because
 * runSession itself drives docker, the epoch admin API and live inference and
 * therefore cannot be executed in a unit test. The events it produces still
 * have to be gradeable, so the shape lives here and the tests drive the real
 * emitter; runSession's ORDER of calls is pinned separately by source-text
 * graders (scripts/tests/unit/swarm-session-judge-step.test.ts).
 */
export function sessionEmitter(
  onProgress: SessionProgress | undefined,
  subject: string,
  date: string,
): (state: string, sessionId?: string, extra?: { judgeMode?: string }) => void {
  return (state, sessionId, extra) =>
    onProgress?.({ type: "session", state, sessionId, subject, date, ...extra });
}

export async function admin(action: string, body: unknown = {}, operatorToken?: string) {
  return (await adminCall(action, body, operatorToken)).body;
}

/**
 * The same call, WITH ITS HTTP STATUS (issue #806).
 *
 * `admin()` returns the parsed body and nothing else, so a non-2xx — a 403
 * after an automation-token rotation, a 400 `unknown action`, a 500 — is
 * indistinguishable from a success at the call site, and every caller that only
 * reads fields off the body treats the error object as a result. That is how a
 * failed lifecycle call became a 120-second wait for work that was never
 * started. Callers that must not proceed on a failure use this and check `ok`;
 * the ones that legitimately read an error body keep `admin()`.
 */
export async function adminCall(
  action: string,
  body: unknown = {},
  operatorToken?: string,
): Promise<{ ok: boolean; status: number; body: any }> {
  const r = await fetch(`${backendUrl()}${routePath(ROUTES.swarm.admin.action, { action })}`, {
    method: "POST", headers: { "Content-Type": "application/json", ...operatorHeaders(operatorToken) }, body: JSON.stringify(body),
  });
  return { ok: r.ok, status: r.status, body: await responseJson(r) };
}

// ── The epoch lifecycle is the scheduler's (system-scheduler-spec.md §4, §8) ─
//
// This driver makes NO lifecycle transition. D55 (4): "system-scheduler is the
// only caller of the epoch lifecycle transitions (open, turnover, and
// settlement: aggregate, request-judging, finalize)", and every
// `/api/swarm/admin/epochs/*` route refuses any credential but the scheduler's
// `lifecycle_transitions` right. §8 says what a test does instead: it "sets
// short epoch and judging durations and runs the real scheduler; it does not
// bypass the scheduler." So the driver sets the subject's duration through the
// admin API, then OBSERVES — the epoch the scheduler opens, the window closing,
// the settlement the scheduler runs — through the public session reads.
//
// Polling a public read here is allowed: §9's "never polls the API on an
// interval" is an invariant of `system-scheduler`, whose design is the stream,
// and a test driver is not the scheduler.

/** How often the driver re-reads a session it is waiting on. */
export const OBSERVE_POLL_MS = 2_000;
/** Slack past a short epoch for the scheduler to open its successor or settle. */
export const OBSERVE_GRACE_MS = 30_000;

/** One `collecting` session as the public list reports it. */
export interface CollectingEpoch {
  sessionId: string;
  date: string;
  windowClosesAt: string | null;
}

export interface EpochAdoptionPlan {
  /** adopt = this is the epoch to run; wait = none yet; abort = refuse, loudly. */
  action: "adopt" | "wait" | "abort";
  reason: string;
}

/**
 * PURE. Decide whether the collecting epoch the scheduler holds for a subject is
 * one this driver can run a session in.
 *
 * The driver cannot shorten an epoch: there is no early turnover (scheduler spec
 * §9), and turnover is the scheduler's. So an epoch the scheduler opened under a
 * LONGER duration — before the admin update took effect — would keep this
 * driver waiting for that whole window. That is refused, naming the instant,
 * rather than waited out until a job timeout kills it.
 */
export function planEpochAdoption(
  serverNowMs: number,
  epoch: CollectingEpoch | null,
  limits: { epochSeconds: number; graceMs?: number },
): EpochAdoptionPlan {
  if (epoch === null) return { action: "wait", reason: "the scheduler has not opened an epoch for this subject yet" };
  const closesAt = epoch.windowClosesAt ? Date.parse(epoch.windowClosesAt) : NaN;
  if (!Number.isFinite(closesAt)) {
    return { action: "abort", reason: `session ${epoch.sessionId} advertises no parseable windowClosesAt (${epoch.windowClosesAt})` };
  }
  const bound = serverNowMs + limits.epochSeconds * 1000 + (limits.graceMs ?? OBSERVE_GRACE_MS);
  if (closesAt > bound) {
    return {
      action: "abort",
      reason:
        `session ${epoch.sessionId}'s window closes at ${epoch.windowClosesAt}, beyond this subject's ` +
        `${limits.epochSeconds}s epoch — the scheduler opened it under a longer duration, and nothing but the ` +
        "scheduler turns an epoch over (scheduler spec §9), so the driver will not wait it out",
    };
  }
  return { action: "adopt", reason: `session ${epoch.sessionId} is collecting until ${epoch.windowClosesAt}` };
}

/** The subject's `collecting` session and the API's clock, in one round trip; null epoch when there is none. */
export async function readCollectingEpoch(subjectId: string): Promise<{ epoch: CollectingEpoch | null; serverNowMs: number | null }> {
  const r = await fetch(`${backendUrl()}${ROUTES.swarm.sessions}?state=collecting&subject=${encodeURIComponent(subjectId)}&limit=5`);
  const header = r.headers.get("date");
  const headerMs = header ? Date.parse(header) : NaN;
  if (!r.ok) throw new Error(`GET ${ROUTES.swarm.sessions}?state=collecting&subject=${subjectId} -> HTTP ${r.status}`);
  const body = await responseJson<{ sessions?: { id: string; date: string; state: string; windowClosesAt: string | null }[] }>(r);
  const row = (body.sessions ?? []).find((s) => s.state === "collecting");
  return {
    epoch: row ? { sessionId: String(row.id), date: String(row.date), windowClosesAt: row.windowClosesAt ?? null } : null,
    serverNowMs: Number.isFinite(headerMs) ? headerMs : null,
  };
}

export interface ObserveDeps {
  readEpoch?: (subjectId: string) => Promise<{ epoch: CollectingEpoch | null; serverNowMs: number | null }>;
  readState?: (sessionId: string) => Promise<string | null>;
  wait?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Wait for the REAL scheduler to open this subject's epoch (§4.1: it opens the
 * first epoch from the subject's `subject.changed`), then return it. Throws at
 * the ceiling, or on an epoch this driver cannot run a session in.
 */
export async function waitForSchedulerEpoch(
  subjectId: string,
  limits: { epochSeconds: number; maxWaitMs: number },
  deps: ObserveDeps = {},
): Promise<CollectingEpoch> {
  const readEpoch = deps.readEpoch ?? readCollectingEpoch;
  const wait = deps.wait ?? sleep;
  const now = deps.now ?? Date.now;
  const startedAt = now();
  for (;;) {
    const { epoch, serverNowMs } = await readEpoch(subjectId);
    const plan = planEpochAdoption(serverNowMs ?? now(), epoch, { epochSeconds: limits.epochSeconds });
    if (plan.action === "adopt") return epoch!;
    if (plan.action === "abort") throw new Error(`subject ${subjectId}: ${plan.reason}`);
    if (now() - startedAt >= limits.maxWaitMs) {
      throw new Error(
        `subject ${subjectId}: the scheduler opened no epoch within ${Math.round(limits.maxWaitMs / 1000)}s — ` +
          "is system-scheduler running and authenticated? (bun smoke:status shows its health)",
      );
    }
    await wait(OBSERVE_POLL_MS);
  }
}

/** The settled states, in the order the scheduler moves a session through them (§4.3, §4.4). */
export const SETTLEMENT_STATES = ["window_closed", "aggregated", "judging", "judged", "published"] as const;

/**
 * Wait for the scheduler to settle a session whose window has closed — turnover,
 * aggregate, judging when the captured mode asks for it, finalize — and report
 * every state it was seen in, in order. `published` is the end; a
 * `no_consensus` or `not_judged` outcome is published too and is not a failure
 * (§4.4). Throws at the ceiling: a session the scheduler never settles is a
 * scheduler that is not working, and the readiness gate and `smoke:status`
 * say why.
 */
export async function waitForSettlement(
  sessionId: string,
  limits: { maxWaitMs: number },
  deps: ObserveDeps = {},
  onState?: (state: string) => void,
): Promise<{ states: string[]; waitedMs: number }> {
  const readState = deps.readState ?? readSessionState;
  const wait = deps.wait ?? sleep;
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const states: string[] = [];
  for (;;) {
    const state = await readState(sessionId);
    if (state !== null && state !== states[states.length - 1]) {
      states.push(state);
      onState?.(state);
    }
    if (state === "published") return { states, waitedMs: now() - startedAt };
    if (now() - startedAt >= limits.maxWaitMs) {
      throw new Error(
        `session ${sessionId} was not settled within ${Math.round(limits.maxWaitMs / 1000)}s ` +
          `(states seen: ${states.join(" → ") || "none"}) — settlement is system-scheduler's, so its health says why`,
      );
    }
    await wait(OBSERVE_POLL_MS);
  }
}

// ── The subject's one scheduling parameter (§2.2, §2.3) ─────────────────────

/**
 * The epoch duration this cadence profile asks for, in whole seconds.
 *
 * DERIVED FROM THE PROFILE'S OWN WINDOW, which is the same number the driver
 * has always used for the submission window — the profile never had two. What
 * changed is where it goes: it used to ride on each `publish_brief` as
 * `windowMinutes`, and §2.2 now says "each subject has one scheduling
 * parameter: its epoch duration … That is the entire schedule." A per-call
 * window is not expressible any more, and should not be: two sessions of one
 * subject with different windows is precisely the drift the column removes.
 */
export function epochDurationSecondsFor(cadence: SmokeCadence): number {
  const seconds = Math.round(cadence.swarmWindowMs / 1000);
  if (!Number.isInteger(seconds) || seconds <= 0) {
    throw new Error(
      `cadence profile '${cadence.profile}' has swarmWindowMs=${cadence.swarmWindowMs}, which is not a ` +
        "positive whole number of seconds; migration 0067's CHECK refuses it",
    );
  }
  return seconds;
}

/**
 * Make sure a subject exists, through the ADMIN SUBJECT ROUTE — the one path
 * that creates a subject and publishes its `subject.changed` in the same
 * transaction (scheduler spec §2.3, §6.2), so the scheduler hears of it and
 * opens its first epoch.
 *
 * It replaces the dispatcher's `subject` action, which upserted an active row
 * with no event and is gone (410). Idempotent the way that action was: an
 * existing subject is left exactly as it is (409 `subject id already exists`
 * is the "already there" answer, not a failure), so a driver restarted against
 * a persistent stack never rewrites a subject it did not create. Any other
 * refusal throws — a subject that could not be created is not a subject the
 * session below can open an epoch for.
 *
 * `recommendationType` defaults to `bucket_weights`, which is what the removed
 * action seeded, so every caller's subject asks for the same thing it did.
 *
 * `epochDurationSeconds` is sent IN THE CREATE BODY, so the subject is born on
 * its schedule. Setting it afterwards (setSubjectEpochDuration) leaves a window
 * in which the subject exists on the schema default: a scheduler holding a
 * token opens the first epoch on the create's `subject.changed`, at the default
 * length, and the driver's own open then adopts that epoch. The later
 * setSubjectEpochDuration call stays for a subject that already existed.
 */
export async function ensureSubjectViaAdmin(
  subject: SessionSubject,
  operatorToken?: string,
  opts: { recommendationType?: string; epochDurationSeconds?: number } = {},
): Promise<{ created: boolean }> {
  const r = await fetch(`${backendUrl()}${ROUTES.swarm.admin.subjects}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...operatorHeaders(operatorToken) },
    body: JSON.stringify({
      id: subject.id,
      name: subject.name,
      recommendationType: opts.recommendationType ?? "bucket_weights",
      ...(opts.epochDurationSeconds !== undefined ? { epochDuration: opts.epochDurationSeconds } : {}),
    }),
  });
  if (r.status === 201) return { created: true };
  const body = await responseJson<{ error?: string }>(r);
  if (r.status === 409 && body?.error === "subject id already exists") return { created: false };
  throw new Error(`POST ${ROUTES.swarm.admin.subjects} {id:${subject.id}} -> ${r.status}: ${JSON.stringify(body)}`);
}

/**
 * Set a subject's `epoch_duration_seconds` through the admin API — §2.3's only
 * supported route, and §8's stated way to make a test's lifecycle fast.
 *
 * VERSIONED, so the current version is read fresh immediately before the write:
 * the same subject row may be brand new on an
 * ephemeral database or carry version bumps on a persistent twin. A no-op when
 * the stored duration already matches — this runs once per session, and a write
 * per session would publish a `subject.changed` event per session for a value
 * that did not change.
 *
 * NOT restored afterwards. The duration is a property of the subject in this
 * deployment, not a flip borrowed for one session the way the judge mode is:
 * §2.3 says a rehearsal "changes the subjects through the admin API", and
 * changing them back would leave the next session on whatever the dump carried.
 */
export async function setSubjectEpochDuration(
  subjectId: string,
  seconds: number,
  operatorToken?: string,
): Promise<void> {
  const listRes = await fetch(`${backendUrl()}${ROUTES.swarm.admin.subjects}`, {
    headers: operatorHeaders(operatorToken),
  });
  if (!listRes.ok) throw new Error(`GET ${ROUTES.swarm.admin.subjects} -> ${listRes.status}`);
  const body = await responseJson<{
    subjects?: Array<{ id?: string; version?: number; epochDuration?: number | null }>;
  }>(listRes);
  const subject = body.subjects?.find((s) => s.id === subjectId);
  if (!subject) {
    throw new Error(
      `setSubjectEpochDuration: subject '${subjectId}' is not on the admin list — create it before ` +
        "setting its epoch duration",
    );
  }
  if (subject.epochDuration === seconds) return;
  const p = routePath(ROUTES.swarm.admin.subjectUpdate, { id: subjectId });
  const r = await fetch(`${backendUrl()}${p}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...operatorHeaders(operatorToken) },
    body: JSON.stringify({ expectedVersion: subject.version, epochDuration: seconds }),
  });
  if (!r.ok) throw new Error(`POST ${p} {epochDuration:${seconds}} -> ${r.status}: ${await r.text()}`);
}

// Active swarm roster size, read from the backend — the gate the standing
// smoke checks against SWARM_ROSTER_CAP before admitting a newcomer. A read
// failure (network blip, backend momentarily busy) must NEVER be treated as
// "roster is empty" — that silently waves admission through regardless of the
// TRUE count, which is exactly what let the smoke's onboarding driver keep
// admitting past its intended bound. Fail CONSERVATIVELY instead: report
// Infinity (always "full"), loudly logged, so a transient read problem pauses
// onboarding rather than silently bypassing the cap check.
// backendUrl override is for tests only (scripts/tests/unit/e2e-active-member-count.test.ts)
// — it sidesteps the process-wide `process.env.BACKEND_URL` that e2e.ts's own
// module-level BACKEND constant captures once at import time, which is unsafe
// to mutate from a test file when other test files in the same run also touch
// it. Real callers never pass this; they always get the real BACKEND.
export async function activeMemberCount(targetUrl: string = backendUrl()): Promise<number> {
  const r = await fetch(`${targetUrl}${ROUTES.swarm.members}`)
    .then(responseJson)
    .catch((err) => {
      console.error(`[e2e] activeMemberCount: GET ${ROUTES.swarm.members} failed — assuming roster is FULL, not empty: ${err instanceof Error ? err.message : err}`);
      return null;
    }) as { members?: { id: string }[] } | null;
  if (r === null) return Number.POSITIVE_INFINITY;
  return Array.isArray(r.members) ? r.members.length : Number.POSITIVE_INFINITY;
}

/**
 * Every member NAME already on the roster, in ANY status, lower-cased.
 *
 * The smoke admits a FIXED, finite list of named newcomers (Helios, Selene, …)
 * indexed by a counter that starts at 0 in each process. Against a throwaway
 * database that was right; against a persistent one it re-admits Helios on every
 * boot, and the roster grows a duplicate Helios per restart (four of them were
 * observed on the standing smoke — two active, two stuck in `applied`).
 *
 * Names are the identity here because the SERVER mints the member id: the smoke
 * cannot look up "did I already admit this one" by id, only by who they are.
 * The admin route is used because it lists every status — a newcomer stuck at
 * `applied` still owns its name, and re-admitting it just makes a second stuck
 * row.
 *
 * FAILS CONSERVATIVELY: an unreadable roster returns null, and the caller must
 * treat that as "cannot prove this name is free" and skip, exactly as
 * activeMemberCount() assumes FULL rather than empty.
 */
export interface RosterMember {
  id: string;
  /**
   * The member's public handle, as the admin route reports it (issue #685).
   * Carried alongside `id` — never instead of it — because seating a member
   * still keys on the id every child row holds, while an allowlist can only be
   * written against the handle: ids are generated per deployment now, so no
   * caller can name one in advance. Falls back to `id`, which is exactly what
   * migration 0030 backfilled for a row that predates handles.
   */
  handle: string;
  name: string;
  lens: string | null;
  status: string;
}

/** The full roster (every status), or null when it cannot be read. */
export async function rosterMembers(targetUrl: string = backendUrl(), operatorToken?: string): Promise<RosterMember[] | null> {
  try {
    const r = await fetch(`${targetUrl}${ROUTES.swarm.admin.members}`, { headers: operatorHeaders(operatorToken) });
    if (!r.ok) throw new Error(`GET ${ROUTES.swarm.admin.members} -> ${r.status}`);
    const body = await responseJson(r) as {
      members?: { id?: string; handle?: string; name?: string; lens?: string | null; status?: string }[];
    };
    if (!Array.isArray(body.members)) throw new Error("admin members response has no members array");
    return body.members
      .filter((m) => m?.id && m?.name)
      .map((m) => ({
        id: String(m.id),
        handle: String(m.handle ?? m.id),
        name: String(m.name),
        lens: m.lens ?? null,
        status: String(m.status ?? ""),
      }));
  } catch (err) {
    console.error(`[e2e] rosterMembers: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/** Lower-cased names on the roster, or null when the roster cannot be read. */
export async function existingMemberNames(targetUrl: string = backendUrl(), operatorToken?: string): Promise<Set<string> | null> {
  const members = await rosterMembers(targetUrl, operatorToken);
  if (members === null) {
    console.error(
      "[e2e] existingMemberNames: roster unreadable — cannot prove a newcomer name is unused; " +
        "the caller must SKIP rather than risk a duplicate",
    );
    return null;
  }
  return new Set(members.map((m) => m.name.trim().toLowerCase()).filter(Boolean));
}

/**
 * The DATE Postgres stamped on a session, looked up by the id `epochs/open`
 * returned. ONE read, never a poll.
 *
 * This replaces a 30-second `waitForSubjectSession` loop, and the reason it can
 * be one read is §4.1: opening an epoch "is one API call that does three things
 * atomically", so the row is committed before the response is written. There is
 * nothing left to wait for — a loop here could only ever succeed on its first
 * iteration, and a loop that cannot fail is a loop that hides the missing
 * transition it was meant to catch.
 *
 * The date still has to be READ rather than computed, for migration 0022's
 * reason: `convened_at` is the database's clock, and a date guessed on this host
 * is the habit 0022 removed. `epochs/open` answers with the session id and the
 * window instant but not the derived date, so the id-addressed session route
 * supplies it — addressed by id, not by subject, because the id is the thing the
 * open call actually returned and "the subject's newest row" is an inference.
 */
export async function readSessionDate(sessionId: string): Promise<string> {
  const path = routePath(ROUTES.swarm.sessionById, { id: sessionId });
  const r = await fetch(`${backendUrl()}${path}`);
  if (!r.ok) throw new Error(`GET ${path} -> HTTP ${r.status} — cannot learn session ${sessionId}'s date`);
  const data = await responseJson<{ session?: { date?: string } }>(r);
  const date = data.session?.date;
  if (!date) {
    throw new Error(
      `session ${sessionId} was opened but GET ${path} reports no date — the open transaction answered ` +
        "success, so this is a read-path fault rather than a lifecycle one",
    );
  }
  return String(date);
}

// ── Waiting out the advertised window (issue #570) ──────────────────────────
// The driver's own members finishing is NOT the window ending. It used to be
// treated as though it were: the window was closed the moment
// mapSettledWithConcurrency returned, which is 1-3 minutes after a brief that
// advertised an hour. That was invisible while the driver owned every member —
// its agents run inside the process that closes the window, so they always beat
// it — and became a defect the instant an external member joined the roster.
//
// Everything below is built so the DECISION is pure and unit-testable in the
// required per-PR `unit` job, while the loop that performs it stays a thin
// wrapper: a six-hour window can never be observed in CI, so the arithmetic has
// to be executed somewhere a CI clock can reach.

/** Extra time past the advertised instant before the epoch is turned over. */
export const WINDOW_WAIT_GRACE_MS = 1_000;
/** Longest single sleep; the server clock is re-read at least this often. */
export const WINDOW_WAIT_POLL_MS = 5_000;

export interface WindowWaitPlan {
  /** proceed = close it now; sleep = not yet; abort = refuse, loudly. */
  action: "proceed" | "sleep" | "abort";
  sleepMs: number;
  reason: string;
}

export interface WindowWaitLimits {
  /**
   * Ceiling on BOTH the remaining wait and the total elapsed wait. A window
   * further out than this is not one this driver published, so waiting it out
   * would hang the caller (in CI, until the job timeout kills it) and closing
   * early would recreate exactly the defect being fixed — so it aborts instead,
   * leaving the session `collecting` and still honestly accepting takes.
   */
  maxWaitMs: number;
  graceMs?: number;
  pollMs?: number;
}

/**
 * Default ceiling for a window this driver just published: two windows plus a
 * minute. Wide enough for clock skew and for a brief that was republished once,
 * narrow enough that a fast-profile CI run can never wait more than ~5 minutes.
 */
export function windowWaitCeilingMs(cadence: SmokeCadence): number {
  return cadence.swarmWindowMs * 2 + 60_000;
}

/**
 * PURE. Decide what to do at one instant, given the SERVER's clock rather than
 * this host's.
 *
 * Clock skew is a real hazard here. `window_closes_at` is now computed IN SQL
 * (`now() + the subject's duration`, see insertEpoch) against the same clock the
 * submit path compares it to — which removes the api-vs-Postgres half of the
 * old hazard but not this HOST's half. A driver that trusted its own clock could
 * still turn the epoch over before the database agreed the window had ended, and
 * a take that arrived in between would be accepted after the aggregate had been
 * computed.
 * So the caller feeds this the api's own clock (the HTTP `Date` response
 * header, which is the same host clock Postgres runs on in every deployment
 * this repo ships) and a grace period covers that header's one-second
 * resolution.
 */
export function planWindowWait(
  serverNowMs: number,
  windowClosesAtIso: string | null | undefined,
  limits: WindowWaitLimits,
): WindowWaitPlan {
  const grace = limits.graceMs ?? WINDOW_WAIT_GRACE_MS;
  const poll = limits.pollMs ?? WINDOW_WAIT_POLL_MS;
  if (!windowClosesAtIso) {
    return {
      action: "abort",
      sleepMs: 0,
      reason: "session advertises no windowClosesAt — the epoch open did not set one (§4.1 sets it in the same " +
        "transaction), so there is no deadline to honour",
    };
  }
  const closesAt = Date.parse(windowClosesAtIso);
  if (!Number.isFinite(closesAt)) {
    return { action: "abort", sleepMs: 0, reason: `windowClosesAt '${windowClosesAtIso}' is not a parseable instant` };
  }
  const remaining = closesAt + grace - serverNowMs;
  if (remaining <= 0) {
    return {
      action: "proceed",
      sleepMs: 0,
      reason: `window closed at ${windowClosesAtIso} (${Math.round(-remaining / 1000)}s ago by the server clock)`,
    };
  }
  if (remaining > limits.maxWaitMs) {
    return {
      action: "abort",
      sleepMs: 0,
      reason:
        `window closes at ${windowClosesAtIso}, ${Math.round(remaining / 1000)}s away — beyond the ` +
        `${Math.round(limits.maxWaitMs / 1000)}s ceiling for a window this driver published. Refusing to ` +
        "wait (it would hang) and refusing to close early (that is the defect this replaced)",
    };
  }
  return {
    action: "sleep",
    sleepMs: Math.min(remaining, poll),
    reason: `window closes at ${windowClosesAtIso}, ${Math.round(remaining / 1000)}s away`,
  };
}

export interface SessionWindowReading {
  windowClosesAt: string | null;
  /** The API's own clock, from the HTTP `Date` header; null when unreadable. */
  serverNowMs: number | null;
}

/**
 * Read the advertised deadline AND the server clock in one round trip.
 *
 * ADDRESSED BY SESSION ID, NOT BY (date, subject). It used to be the latter, and
 * that stopped being unambiguous the moment turnover began opening the successor
 * in the same transaction that closes N (§4.3): `getSession(date, subjectId)`
 * resolves to "the LATEST session that day" (backend/src/swarm/domain.ts), so a
 * subject mid-settlement has two rows for one date and the date route answers
 * with the wrong one. Every read in this driver that means "the session I am
 * driving" now names it.
 */
export async function readSessionWindow(sessionId: string): Promise<SessionWindowReading> {
  const path = routePath(ROUTES.swarm.sessionById, { id: sessionId });
  const r = await fetch(`${backendUrl()}${path}`);
  const header = r.headers.get("date");
  const headerMs = header ? Date.parse(header) : NaN;
  const serverNowMs = Number.isFinite(headerMs) ? headerMs : null;
  // A failed read says nothing about the session's stored deadline. Returning
  // null here used to conflate a transient proxy/API failure with a successful
  // response for a session with no window, so one 502 made the driver claim
  // that no deadline had been set and abort an otherwise healthy smoke run.
  if (!r.ok) throw new Error(`GET ${path} -> HTTP ${r.status}`);
  const data = await responseJson<{ session?: { windowClosesAt?: string | null } }>(r);
  return { windowClosesAt: data.session?.windowClosesAt ?? null, serverNowMs };
}

export interface WindowWaitDeps {
  read?: (sessionId: string) => Promise<SessionWindowReading>;
  wait?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (line: string) => void;
}

export interface WindowWaitOutcome {
  waitedMs: number;
  windowClosesAt: string | null;
  reason: string;
  /** Polls where the server clock was unreadable and the host's was used. */
  clockFallbacks: number;
}

/**
 * Block until the session's ADVERTISED window has elapsed, then return. Throws
 * on any condition where proceeding would be a lie (no deadline, unparseable
 * deadline, a deadline beyond the ceiling, or the ceiling reached).
 */
export async function waitUntilWindowCloses(
  sessionId: string,
  /** What to call this session in an error — `<date>/<subject>`, for a human. */
  label: string,
  limits: WindowWaitLimits,
  deps: WindowWaitDeps = {},
): Promise<WindowWaitOutcome> {
  const read = deps.read ?? readSessionWindow;
  const wait = deps.wait ?? sleep;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => console.log(line));
  const startedAt = now();
  let clockFallbacks = 0;
  let skewWarned = false;
  let readFailures = 0;
  for (;;) {
    let reading: SessionWindowReading;
    try {
      reading = await read(sessionId);
    } catch (error) {
      readFailures++;
      const elapsed = now() - startedAt;
      const detail = error instanceof Error ? error.message : String(error);
      if (elapsed >= limits.maxWaitMs) {
        throw new Error(
          `window wait for ${label} exceeded its ${Math.round(limits.maxWaitMs / 1000)}s ceiling ` +
            `while the session endpoint was unreadable (last error: ${detail})`,
        );
      }
      log(`  [window] session read failed (attempt ${readFailures}): ${detail}; retrying`);
      const poll = limits.pollMs ?? WINDOW_WAIT_POLL_MS;
      await wait(Math.min(poll, limits.maxWaitMs - elapsed));
      continue;
    }
    const hostNow = now();
    let serverNow = reading.serverNowMs;
    if (serverNow === null) {
      clockFallbacks++;
      serverNow = hostNow;
    } else if (!skewWarned && Math.abs(serverNow - hostNow) > 5_000) {
      skewWarned = true;
      log(
        `  [window] host clock differs from the API's by ${Math.round((hostNow - serverNow) / 1000)}s — ` +
          "the SERVER clock decides when this window closes",
      );
    }
    const plan = planWindowWait(serverNow, reading.windowClosesAt, limits);
    if (plan.action === "abort") {
      throw new Error(`window wait for ${label} refused: ${plan.reason}`);
    }
    if (plan.action === "proceed") {
      return { waitedMs: hostNow - startedAt, windowClosesAt: reading.windowClosesAt, reason: plan.reason, clockFallbacks };
    }
    if (hostNow - startedAt >= limits.maxWaitMs) {
      throw new Error(
        `window wait for ${label} exceeded its ${Math.round(limits.maxWaitMs / 1000)}s ceiling ` +
          `without the window closing (last read: ${plan.reason})`,
      );
    }
    await wait(plan.sleepMs);
  }
}

/**
 * How many judgement rows this session has on the append-only record
 * (issue #806). Read only on the expiry path, to tell an operator which of two
 * very different things happened. Never throws: it exists to make a log line
 * more honest, and must not turn a survivable timeout into a failed run.
 */
export async function countJudgements(
  sessionId: string | number,
  operatorToken?: string,
  opts?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<number | null> {
  try {
    const signal = opts?.signal ?? AbortSignal.timeout(opts?.timeoutMs ?? 5_000);
    const r = await fetch(
      `${backendUrl()}${routePath(ROUTES.swarm.admin.sessionJudgements, { id: String(sessionId) })}`,
      { headers: operatorHeaders(operatorToken), signal },
    );
    if (!r.ok) return null;
    const body = await responseJson<{ judgements?: unknown[] }>(r);
    return Array.isArray(body.judgements) ? body.judgements.length : null;
  } catch {
    return null;
  }
}

// ── What the judging did, read off the record after publish ────────────────
//
// The driver requests no judging (that is `request-judging`, a lifecycle
// transition, and the scheduler's alone — D55 (4)). What it can still say is
// what the published record holds: a judgement on file, and who authored it.

/** The session's lifecycle state, or null when it cannot be read. */
export async function readSessionState(sessionId: string): Promise<string | null> {
  try {
    const r = await fetch(`${backendUrl()}${routePath(ROUTES.swarm.sessionById, { id: sessionId })}`);
    if (!r.ok) return null;
    const body = await responseJson<{ session?: { state?: string } }>(r);
    return typeof body.session?.state === "string" ? body.session.state : null;
  } catch {
    return null;
  }
}

/** The judgement record of a published session, as the driver read it. */
export interface JudgeObservation {
  /** Judgement rows on the record; null when the record could not be read. */
  recorded: number | null;
  /** WHO AUTHORED the in-force opinion ("model"), or null when unreadable or absent. */
  source: string | null;
}

/**
 * Whether the PROGRESS STREAM reports a judgement for this session, and whose
 * (issue #817, #969). A judgement on the record is the only thing that fires
 * it: `not_judged` (mode `off`, §4.4 — never a failure) and `no_consensus`
 * both leave the record empty and the stream silent, so neither invents a
 * verdict. A judgement exists only under `enforce`, so that is the mode it
 * reports.
 */
export function judgedProgress(o: JudgeObservation): { judgeMode: string; judgeSource?: string } | null {
  if ((o.recorded ?? 0) <= 0) return null;
  return o.source ? { judgeMode: "enforce", judgeSource: o.source } : { judgeMode: "enforce" };
}

export type ProducerComposeRail = Pick<
  SessionRail,
  "repoRoot" | "composeProject" | "composeFiles" | "composeSpawnEnv" | "backendUrl"
>;

export interface ProducerInvocationDeps {
  runProducer?: (rail: ProducerComposeRail, asof: string) => Promise<void>;
  readLatest?: (baseUrl: string) => Promise<any>;
  wait?: (ms: number) => Promise<void>;
}

async function runProducerRegimeContainer(rail: ProducerComposeRail, asof: string): Promise<void> {
  // composeArgs(), not a hand-rolled prefix. This spawn CREATES a container, so
  // it interpolates the compose files — and the hand-rolled version omitted the
  // `--env-file /dev/null` that stops that interpolation reading the checkout's
  // `.env` (see scripts/stack/config.ts). Nothing broke here only because the
  // producer reads none of the names a deployment `.env` happens to carry.
  const producer = Bun.spawn(
    ["docker", ...composeArgs(rail.composeProject, [...rail.composeFiles]),
      "run", "--rm", "--no-deps", "analytics-producer", "bun", "run", "src/producer/index.ts", "regime", asof],
    { cwd: rail.repoRoot, env: rail.composeSpawnEnv, stdin: "ignore", stdout: "inherit", stderr: "inherit" },
  );
  const exit = await producer.exited;
  if (exit !== 0) throw new Error(`independent analytics producer exited ${exit} for regime ${asof}`);
}

// Ask the PRODUCER to land a regime snapshot for `asof`, then wait until it is
// served (issue #361 Phase 4). The former `admin("regime")` action ran the
// classifier INSIDE the api process under the admin token; that path is
// removed — this harness now launches the independent producer explicitly in
// the target stack, and the producer submits through the authenticated
// analytics boundary under its own provider credential. Waiting on
// the PUBLIC read keeps this a black-box observation: the snapshot is "landed"
// when the site would serve it.
//
// This polls `latest.date` (the served snapshot ROW's own date — the
// pipeline's write/asof target, always forced to `asof` once the run lands),
// never `staleness.asof`. Since issue #398, `staleness.asof` means the
// newest REAL raw observation date, which legitimately lags "today" for
// slow-publishing sources (FRED, weekends) even on a perfectly healthy run —
// polling on it here would wait for real-world data that may never arrive
// same-day and time out spuriously. "Did today's row land" and "is the
// underlying data fresh" are different questions; this function only asks
// the former.
export async function runRegimeClassify(
  asof: string,
  rail: ProducerComposeRail,
  timeoutMs = 300_000,
  deps: ProducerInvocationDeps = {},
) {
  await (deps.runProducer ?? runProducerRegimeContainer)(rail, asof);
  const readLatest = deps.readLatest ?? (async (baseUrl: string) =>
    fetch(`${baseUrl}${ROUTES.dashboards.regimeSnapshots}?range=1`).then(responseJson).catch(() => null));
  const wait = deps.wait ?? sleep;
  const baseUrl = rail.backendUrl ?? backendUrl();
  const deadline = Date.now() + timeoutMs;
  let last: any = null;
  while (Date.now() < deadline) {
    last = await readLatest(baseUrl);
    const servedAsof: string | null = last?.latest?.date ?? null;
    if (servedAsof && servedAsof >= asof) return last;
    await wait(2000);
  }
  throw new Error(
    `regime.classify for ${asof} did not land within ${timeoutMs}ms ` +
      `(served asof: ${last?.latest?.date ?? "none"}) — is the analytics producer configured for this stack?`,
  );
}

/** The in-force judgement's provenance: did a MODEL author it, or a template? */
export async function latestJudgementProvenance(
  sessionId: string | number,
  operatorToken?: string,
): Promise<{ source: string | null; fallbackReason: string | null; model: string | null }> {
  const r = await fetch(
    `${backendUrl()}${routePath(ROUTES.swarm.admin.sessionJudgements, { id: String(sessionId) })}`,
    { headers: operatorHeaders(operatorToken) },
  );
  if (!r.ok) throw new Error(`GET sessionJudgements ${sessionId} -> ${r.status}`);
  const body = await responseJson<{
    inForce?: { source?: string | null; fallbackReason?: string | null; model?: string | null } | null;
  }>(r);
  return {
    source: body.inForce?.source ?? null,
    fallbackReason: body.inForce?.fallbackReason ?? null,
    model: body.inForce?.model ?? null,
  };
}

// The member-container rail (issue #361 Phase 2): every present member runs in
// its OWN container via the shared runMemberAgent() primitive; this driver
// only drives the session lifecycle and observes. `rail` carries the compose
// coordinates of the already-running stack; when omitted it is resolved from
// this process's environment (the standalone CI entry point receives the
// smoke's exact compose env).
export async function runSession(
  subject: SessionSubject,
  sessionIndex: number,
  opts: {
    members: readonly SessionMember[];
    // `prevOutcome` USED TO BE HERE and is gone with the call that carried it.
    // It rode on `publish_brief`, and §4.1 folded the brief into the open:
    // `epochs/open` takes a subject id and nothing else, because the brief is
    // now written in the same transaction that creates the session and there is
    // no later step to hand a previous session's synthesis to. Keeping the
    // option would have left every caller passing a value that reaches nothing.
    rail?: SessionRail;
    /**
     * Is this a `--local dump` boot? Carried for the caller's log only: a twin's
     * restored epoch is the scheduler's to turn over like any other, so the
     * driver waits its window out or refuses it (planEpochAdoption).
     */
    twin?: boolean;
    onProgress?: SessionProgress;
    regimeAsof?: string;
    // Which scenario opened this session. The session BODY is identical either
    // way — same lifecycle, same member rail, same assertions; this selects
    // only whether the harness may author reference-shaped subject data before
    // the window opens.
    //
    // REQUIRED, and deliberately so. It used to default to "simulation" so
    // existing callers kept their behaviour — which made the DANGEROUS branch
    // the one you got by forgetting the parameter. The standing-session loop
    // did forget it, so a smoke boot restored the archive faithfully and then
    // wrote simulation fixtures over the restored subjects: exactly what the
    // block above says a continuity boot must never do. Stating it is now a
    // compile-time obligation.
    initializer: "simulation" | "adopt";
    // The CADENCE PROFILE this invocation resolved (scripts/lib/smoke-cadence.ts).
    // REQUIRED, for the same reason `initializer` is: the submission window is a
    // cadence timing, and a default would make the six-hour production value the
    // thing you get by forgetting the parameter — or, worse, make CI inherit it.
    // Every caller already knows which invocation it is: smoke-main resolved the
    // profile from `--static-port` at module load, and the standalone CI entry
    // point below is always the fast profile by definition.
    cadence: SmokeCadence;
  },
) {
  const onProgress = opts?.onProgress;
  const rail = opts?.rail ?? railFromEnv();
  const cadence = opts.cadence;
  const epochSeconds = epochDurationSecondsFor(cadence);

  // THE DATE IS NOT AN INPUT. It used to be — the smoke passed `today + N days`
  // so repeat runs would not collide on the old UNIQUE(date, subject_id), and
  // wiped session history when it wanted today back. Now the session is opened
  // first and its date is READ BACK from the row Postgres created (convened_at,
  // migration 0022). Everything downstream — fixtures, regime as-of, the
  // members' signed payloads, the state polls — uses that value, so there is
  // exactly one clock in the system and it is the database's.
  // The SUBJECT must exist before a session can reference it
  // (swarm_sessions_subject_fk). This is deliberately separate from the
  // dated `subject_fixtures` call further down: creating the subject needs no
  // date, while the fixtures are filed under the session's date and therefore
  // cannot run until the session exists. Ordering them the other way round is
  // what made a clean database fail its first two sessions with a foreign-key
  // violation while the boot still reported READY. Created through the admin
  // subject route, which publishes `subject.changed` (§6.2) — the retired
  // `subject` dispatcher action wrote an active subject the scheduler never
  // heard of.
  await ensureSubjectViaAdmin(subject, rail.operatorToken, { epochDurationSeconds: epochSeconds });
  // THE WINDOW LENGTH IS A COLUMN ON THE SUBJECT (§2.2, §2.3), set through the
  // admin API — §8's supported way to make a test fast: "a test that needs a
  // fast lifecycle sets short epoch and judging durations and runs the real
  // scheduler". A no-op when the stored duration already matches.
  await setSubjectEpochDuration(subject.id, epochSeconds, rail.operatorToken);
  // §4.1 — THE SCHEDULER OPENS THE EPOCH, from the subject's `subject.changed`
  // (or on its rebuild), in one transaction that creates the session, publishes
  // its brief and sets the window. This driver waits for it; it opens nothing.
  // From the second session of a subject onward the epoch is the successor the
  // scheduler's own turnover opened (§4.3), which is the same wait.
  const opened = await waitForSchedulerEpoch(subject.id, {
    epochSeconds,
    maxWaitMs: epochSeconds * 1000 + OBSERVE_GRACE_MS * 2,
  });
  const sessionId = opened.sessionId;
  // The date is Postgres's, read back from the row the scheduler's open created
  // (migration 0022) — never computed here.
  const date: string = await readSessionDate(sessionId);
  const tag = `[session ${sessionIndex}: ${date}/${subject.id}]`;
  console.log(`\n${tag}`);
  // Session-lifecycle emitter — one call per real state transition below.
  // The factory lives at module scope (sessionEmitter) so the events this
  // driver puts on the stream are gradeable without running docker.
  const emitSession = sessionEmitter(onProgress, subject.id, date);

  // Regime is already seeded by the first session; later ones self-seed. The
  // subject itself is ensured ABOVE, before the session that references it —
  // moving it here would reintroduce the foreign-key failure a clean database
  // hits on its first session.
  //
  // `regimeAsof` (defaulting to the session's own date) stays a SEPARATE knob
  // from the session date, and is still worth having after 0022 even though the
  // reason it was introduced is gone. A regime SNAPSHOT classifies real market
  // indicators, so it can never be produced for a date that has not happened —
  // fetchRegimeSnapshots enforces `date <= today` (issue #382). It used to be
  // possible to violate that from here, because a session could be LABELLED
  // with any smoke-narrative date, including tomorrow. It no longer can be:
  // Postgres stamps convened_at and derives the date, so a session date is
  // always "now" and can never run ahead of the boundary. What survives is the
  // ability to pin a classification to a different day than the sitting — e.g.
  // a session convened just after midnight UTC reading yesterday's snapshot.
  if (sessionIndex > 0) {
    await runRegimeClassify(opts?.regimeAsof ?? date, rail);
  }

  // Seed the reference-shaped subject fixtures (subject row + subject snapshot the
  // portfolio donut reads + trailing regime history for the sparkline) so the
  // subject/snapshot routes return data for the session date and the memo page
  // renders full charts. Idempotent; dated at the session date. This now runs
  // just AFTER the session row exists, because that row is what says what the
  // date is; the brief (which reads these fixtures) is still published after.
  //
  // ARCHIVE SCENARIOS DO NOT GET THIS. `ensureSmokeSubjectFixtures` synthesizes
  // a subject snapshot and a trailing regime history; under the archive
  // initializer those series were RESTORED from
  // backend/seed-data/v0-committee-archive.json.gz and are the real v0 record.
  // Writing simulation data over them is the one thing a continuity boot must
  // never do — it would republish fabricated history under the release
  // subjects' own ids. A restored subject already carries its snapshot, so
  // there is nothing to seed (issue #537).
  if (opts.initializer === "simulation") {
    await admin("subject_fixtures", { id: subject.id, name: subject.name, date }, rail.operatorToken);
  }

  // NO `scheduled` EVENT. §4.1: "There is no `scheduled` state and no 'brief
  // opens later.'" The scheduler's open committed the session as `collecting`.
  console.log(
    `${tag} session ${sessionId}: the scheduler's epoch, collecting until ${opened.windowClosesAt} ` +
      `(epoch duration ${epochSeconds}s)`,
  );
  emitSession("collecting", sessionId);

  // Enroll the no-show (own container + persistent keystore — the harness
  // never generates a key for it), then run present members, each in its OWN
  // container on the member-agent rail.
  const absent = opts.members.filter((m) => !m.present);
  await Promise.all(absent.map((m) => enroll(rail, m).catch((err) => {
    // A failed no-show enrollment must not sink the session: absence is
    // already this member's outcome either way. Logged, never fatal.
    console.log(`  ${m.memberId}: no-show enrollment failed (absent regardless) — ${err instanceof Error ? err.message : err}`);
  })));
  for (const m of absent) onProgress?.({ type: "member", memberId: m.memberId, stage: "absent" });
  const present = opts.members.filter((m) => m.present);
  // Settle so one failed member container cannot freeze the session lifecycle
  // (#122). Concurrency is preserved at the CONTAINER level: at most
  // SWARM_MAX_CONCURRENCY member containers in flight. Rejected members are
  // honestly absent — the post-publish assertion below verifies the published
  // absent list matches exactly this driver's observed failures, and that at
  // least one take is genuinely live-authored.
  const limit = Number(process.env.SWARM_MAX_CONCURRENCY ?? 4);
  const settled = await mapSettledWithConcurrency(present, limit, (m) => runAgent(
    rail,
    // agent.ts annotates this field `sessionId: number` (scripts/lib/swarm/
    // agent.ts), which has been wrong since migration 0022 made session ids
    // uuids — every use there is `String(o.sessionId)` or an interpolation, so
    // the runtime value passed has always been the uuid string this now names
    // explicitly. The narrowing is stated here rather than fixed there because
    // agent.ts is outside this change.
    { ...m, date, subjectId: subject.id, sessionId: sessionId as unknown as number },
    onProgress && ((stage, info) => onProgress({ type: "member", memberId: m.memberId, stage, ...info })),
  ));
  // Partition: fulfilled takes flow downstream; each rejected member is logged and
  // surfaced to the smoke pane as a no-show ('absent') instead of a frozen row, so
  // the session proceeds to close/aggregate/publish with whatever takes succeeded.
  const results: Awaited<ReturnType<typeof runAgent>>[] = [];
  settled.forEach((s, i) => {
    const m = present[i];
    if (s.status === "fulfilled") {
      results.push(s.value);
    } else {
      console.log(`  ${m.memberId}: FAILED — ${s.reason}`);
      onProgress?.({ type: "member", memberId: m.memberId, stage: "absent" });
    }
  });
  for (const r of results) {
    const ok = r.result?.verified ? "✓verified" : JSON.stringify(r.result);
    const memo = r.memoUrl ? ` memo=${r.memoUrl}` : "";
    console.log(`  ${r.memberId}: ${r.stance} c=${r.confidence} → ${ok}${memo}`);
  }

  // THE DRIVER'S MEMBERS FINISHING IS NOT THE WINDOW ENDING. External members
  // are on this roster now and they are not in this process; they get the whole
  // window the brief advertised, and this is where that promise is kept. The
  // wait is on the SERVER's clock against the SERVER's stored deadline — see
  // waitUntilWindowCloses — and it throws rather than closing early if the two
  // cannot be reconciled.
  //
  const closedWindow = await waitUntilWindowCloses(sessionId, tag, { maxWaitMs: windowWaitCeilingMs(cadence) });
  console.log(
    `${tag} window elapsed after ${Math.round(closedWindow.waitedMs / 1000)}s — ${closedWindow.reason}`,
  );
  // §4.3, §4.4 — THE SCHEDULER TURNS THE EPOCH OVER AND SETTLES IT: the
  // boundary closes this session (recording `absent` for each seated member
  // with no take) and opens the successor; then aggregate, judging when the
  // mode captured at turnover asks for it, and finalize, which decides the
  // outcome from stored instants. The driver watches each state go by. A
  // `no_consensus` or `not_judged` outcome is published and is not a failure.
  const settlement = await waitForSettlement(
    sessionId,
    { maxWaitMs: OBSERVE_GRACE_MS * 4 + epochSeconds * 1000 },
    {},
    (state) => {
      // `judged` and `published` are announced below, from the record, in
      // that order — so the stream reads aggregated → judged → published.
      if (state !== "collecting" && state !== "judged" && state !== "published") emitSession(state, sessionId);
    },
  );
  console.log(`${tag} settled by the scheduler after ${Math.round(settlement.waitedMs / 1000)}s: ${settlement.states.join(" → ")}`);
  // WHAT THE JUDGING DID, from the record (issue #817, #969): a judgement on
  // file, and who authored it. Silent when there is none.
  const recorded = await countJudgements(sessionId, rail.operatorToken);
  const provenance = (recorded ?? 0) > 0
    ? await latestJudgementProvenance(sessionId, rail.operatorToken).catch(() => ({ source: null, fallbackReason: null, model: null }))
    : { source: null };
  const judged = judgedProgress({ recorded, source: provenance.source });
  if (judged) emitSession("judged", sessionId, judged);
  emitSession("published", sessionId);

  // BY ID. `getSession(date, subjectId)` answers with "the LATEST session that
  // day", and turnover has just opened a successor for this subject — so the
  // date route now points at the fresh `collecting` epoch, not the one that was
  // published a moment ago. Reading the published session by the id this driver
  // has held all along is the only address that cannot drift.
  const pub = await fetch(`${backendUrl()}${routePath(ROUTES.swarm.sessionById, { id: sessionId })}`).then(responseJson);
  // ONE source for both lines (issue #501): the roster-derived rollup. The
  // counter's denominator and the absent list can no longer drift, and
  // absenceReport throws if they ever do.
  const attendance = absenceReport(pub, tag);
  console.log(`${tag} published: state=${pub.session.state}, takes=${attendance.submitted} of ${attendance.active}`);
  console.log(`${tag} synthesis: ${pub.session.synthesis}`);
  console.log(`${tag} absent: ${JSON.stringify(attendance.absent)}`);

  // Every present member's published take must be genuine live opencode
  // authoring (non-template body,
  // REGIME/ALLOCATION/SUBJECT lead-ins, stance in the five-value set, confidence
  // in [0,1], distinct across members). Throws → exit 1 on any failure.
  //
  // Absence is a DESIGNED outcome (#301/#319), so this does not require every
  // present member to have authored a take — a timed-out or control-line-refused
  // member is honestly absent, never fabricated. What it DOES require is that
  // the published record tells the truth about the members this driver ran:
  // every observed failure (configured no-shows like draco plus rejected
  // containers) must appear in the published absent list, and every fulfilled
  // container must have its take land in the published payload and never be
  // listed absent. Members the driver did not run (e.g. the mid-run
  // cross-role test identity) carry no ground truth and are not asserted on.
  const { failed, fulfilled } = settledAttendance(present, settled);
  const observedAbsent = [...absent.map((m) => m.memberId), ...failed];
  assertAuthoredTakes(tag, pub.takes, attendance, observedAbsent, fulfilled);

  // Verify memos
  for (const r of results) {
    if (!r.memoUrl) { console.log(`  ${r.memberId}: no memo`); continue; }
    const memoRes = await fetch(`${backendUrl()}${r.memoUrl}`);
    if (memoRes.ok) {
      const memo = await responseJson(memoRes);
      console.log(`  ${r.memberId}: memo verified (id=${memo.id})`);
      const take = pub.takes.find((t: any) => t.memberId === r.memberId);
      if (take?.memoUrl === r.memoUrl) console.log(`  ${r.memberId}: memoUrl in submission ✓`);
    } else {
      console.log(`  ${r.memberId}: memo fetch failed (${memoRes.status})`);
    }
  }

  return { sessionId, results, pub };
}

async function main() {
  // `today` is this run's regime as-of day, NOT a session date — the database
  // dates sessions (0022). The banner used to read `today → tomorrow` because
  // session 2 was labelled a day ahead; it no longer is, and printing a date
  // range the run cannot produce would be the first thing to mislead a reader
  // of the log.
  const today = new Date().toISOString().slice(0, 10);
  console.log(`\n=== Swarm REST E2E (regime as-of ${today}; sessions dated by the database) ===`);

  // The member-container rail for this stack (issue #361 Phase 2), resolved
  // once from this process's environment — the smoke readiness gate hands this
  // entry point the stack's exact compose env.
  const rail = railFromEnv();
  // This entry point IS the CI/e2e path (`bun run scripts/lib/swarm/session.ts`,
  // spawned by the smoke readiness gate) and a plain local run. Neither is the
  // standing/public smoke, so the profile is the fast one — resolved explicitly
  // rather than defaulted, so the window this run advertises is a stated
  // decision. Its window is two minutes, which is what keeps the e2e step's
  // two sessions inside `timeout-minutes: 105`.
  const cadence = resolveSmokeCadence({ stage: false });
  console.log(
    `  cadence profile: ${cadence.profile}; epoch duration ${epochDurationSecondsFor(cadence)}s ` +
      "(set on each subject through the admin API — §2.3)",
  );
  const subjects = DEMO_SUBJECTS.map((subject) => ({ ...subject }));
  const members: SessionMember[] = DEMO_MEMBERS.map((member) => ({ ...member }));

  // Setup (subject is a direct admin call; the regime snapshot is the
  // PRODUCER's own job — issue #361 Phase 4). NOTHING IS WIPED: the
  // session-wiping admin("reset") that used to open this entry point is gone
  // along with the endpoint behind it — an ephemeral database is deleted or
  // inspected whole, and no bring-up may TRUNCATE rows it did not create.
  await runRegimeClassify(today, rail);
  await ensureSubjectViaAdmin(subjects[0], rail.operatorToken, { epochDurationSeconds: epochDurationSecondsFor(cadence) });

  // Session 1: today's subject
  await runSession(subjects[0], 1, { rail, members, initializer: "simulation", cadence });

  // ── New member added mid-run ──────────────────────────────────────────────
  // Demonstrates a member added AFTER session 1, participating in session 2
  // alongside the original roster (cross-session rotation awareness). Pushed
  // WITHOUT any host-held credential: eos enrolls on the container rail at its
  // first session — its key is generated inside its own container, the
  // harness registers only the PUBLIC key (the RM-operator half of seeding a
  // smoke roster; the real §11 public apply→approve→claim flow is exercised by
  // the real-inference eval harness in scripts/lib/onboarding-eval.ts and the
  // no-inference proof in scripts/rmpc-release-e2e.ts).
  members.push({ memberId: "eos", name: "Eos", lens: "newcomer", bias: 0.05, present: true });
  console.log(`\n  new member eos: joins the roster — enrolls in its own container at session 2`);

  // ── Cross-role denial assertions ─────────────────────────────────────────
  // Register a test member and verify identity-layer checks (always enforced
  // regardless of RM_ALLOW_INSECURE). The smoke runs in insecure mode so role
  // gates on regime write (analyticsProvider) and admin lifecycle (privileged)
  // are open — the identity-layer submit checks are the universal enforcement.
  const testReg = await fetch(`${backendUrl()}${ROUTES.swarm.register}`, {
    method: "POST", headers: { "Content-Type": "application/json", ...operatorHeaders() },
    body: JSON.stringify({ memberId: "cross-role-test", name: "Cross Role Test", publicKey: (await generateKeyPair()).publicKeyB64 }),
  }).then(responseJson);
  const testToken: string = testReg.token;

  // 5a. Unknown token → 401 with "unknown member token"
  const badTokenRes = await fetch(`${backendUrl()}${ROUTES.swarm.submit}`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer nonexistent" },
    body: JSON.stringify({ memberId: "cross-role-test", date: today, subjectId: subjects[0].id, nonce: crypto.randomUUID(), stance: "neutral", confidence: 0.5, signature: "bad" }),
  }).then(responseJson);
  console.log(`  cross-role: unknown token → ${badTokenRes.status} "${badTokenRes.error}"`);
  const badTokenOk = badTokenRes.status === 401 && String(badTokenRes.error).includes("unknown member token");
  if (!badTokenOk) throw new Error(`expected 401 unknown token, got ${badTokenRes.status}`);

  // 5b. Known token but wrong memberId in body → 403 with "token/member mismatch"
  const mismatchRes = await fetch(`${backendUrl()}${ROUTES.swarm.submit}`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${testToken}` },
    body: JSON.stringify({ memberId: "someone-else", date: today, subjectId: subjects[0].id, nonce: crypto.randomUUID(), stance: "neutral", confidence: 0.5, signature: "bad" }),
  }).then((r) => r.json());
  console.log(`  cross-role: token/member mismatch → ${mismatchRes.status} "${mismatchRes.error}"`);
  const mismatchOk = mismatchRes.status === 403 && String(mismatchRes.error).includes("token/member mismatch");
  if (!mismatchOk) throw new Error(`expected 403 token/member mismatch, got ${mismatchRes.status}`);

  // 5c. Known member token calling regime write (would be 403 with
  // ANALYTICS_TOKEN set; in insecure mode the gate is open so we document
  // the expected behaviour rather than assert a specific status).
  const regimeWriteRes = await fetch(`${backendUrl()}${ROUTES.swarm.regime}`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${testToken}` },
    body: JSON.stringify({ asof: today }),
  });
  // A member token can only get past the analytics-role check when that gate
  // is open. The body intentionally has the retired trigger shape, so 400 is
  // positive evidence that authorization passed and payload validation ran;
  // 403 is the enforced-role result. Observe that boundary instead of reading
  // ANALYTICS_TOKEN in this harness process.
  const regimeGateOpen = regimeWriteRes.status !== 403;
  console.log(`  cross-role: member → regime write → ${regimeWriteRes.status}${regimeGateOpen ? " (insecure mode — gate open)" : " (enforced)"}`);

  // 5d. Known member token calling a lifecycle transition (same insecure-mode
  // caveat). The epoch turnover, not the retired `close` action: it is the
  // route that actually closes a window now (§4.3), so it is the one whose
  // gate is worth observing.
  const adminCloseRes = await fetch(`${backendUrl()}${ROUTES.swarm.admin.epochTurnover}`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${testToken}` },
    body: JSON.stringify({ subjectId: "cross-role-probe", expectedSessionId: "00000000-0000-4000-8000-000000000000" }),
  });
  console.log(`  cross-role: member → epoch turnover → ${adminCloseRes.status}${regimeGateOpen ? " (insecure mode — gate open)" : " (enforced)"}`);

  // NO JUDGE COVERAGE HERE (issue #1026, D48/D53). This used to grant `themis`
  // the judge role and flip `swarm_judge_config.mode` to `enforce` around
  // session 2, then assert a model-authored judgement landed. Nothing on a
  // booted stack judges inline any more — the judge is a participant (smoke
  // spec §6.2) — so that assertion could not pass, and the flip itself was the
  // one place a driver wrote judge mode at all. Judge coverage returns with
  // the participant judge.
  //
  // Session 2: a SECOND sitting, different subject (smokenstrates rotation +
  // cross-session awareness). Eos (added to the roster mid-run above) enrolls and
  // participates in its own container alongside the original members.
  //
  // It used to be dated `tomorrow` to prove the infra handles a session dated
  // ahead of session 1, with `regimeAsof: today` pinning the classification back
  // to a real day (a snapshot dated tomorrow can never be served — #382 enforces
  // `date <= today`). Neither is expressible now, and neither is needed: since
  // 0022 the DATABASE dates a session, so two sittings on one day are simply two
  // rows with different convened_at rather than one row relabelled to a day that
  // has not happened. The rotation this proves is the real one.
  await runSession(subjects[1], 2, { rail, members, initializer: "simulation", cadence });

  // Verify list_sessions returns both sessions
  const all = await fetch(`${backendUrl()}${ROUTES.swarm.sessions}`).then((r) => r.json());
  console.log(`\nsessions listed: ${all.sessions.length} total (expected ≥2)`);

  console.log("\n=== done ===\n");
}

// Only run the full E2E flow (reset + 2 sessions + cross-role checks) when this
// file is the entry point (e.g. CI's `bun run session.ts`). Guarded so the
// standing smoke can `import { runSession, admin, SUBJECTS }` WITHOUT triggering
// a reset that would wipe accumulating smoke history. main()'s behaviour as an
// entry point is unchanged.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
