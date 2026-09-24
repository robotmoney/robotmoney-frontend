// REST-path end-to-end swarm smoke (D21 — the MCP transport is retired; see
// docs/decisions.md D21). Drives one or more full swarm sessions where N
// independent agents participate over the swarm REST API (each its own key
// + token). One member per session is a deliberate no-show. Multi-session: the
// second session's brief references the first session's outcome, smokenstrating
// rotation awareness.
//
// THE LIFECYCLE IS FIVE SYNCHRONOUS ADMIN CALLS, NOT A QUEUE (issue #1026 W4).
// It used to be five `swarm.*` queue jobs driven through `admin enqueue-job`,
// plus an out-of-band `swarm.judge`. Every one of those handlers and the `swarm`
// worker lane are gone, and so is the endpoint that queued them. What replaces
// them is the epoch lifecycle of docs/technical/system-scheduler-spec.md §4 —
// `epochs/open`, `epochs/turnover`, `epochs/aggregate`,
// `epochs/request-judging`, `epochs/finalize` — each a state-guarded transition
// that has COMMITTED by the time it answers (§5). That single fact is why most
// of this file's former state polling is gone: a wait for a transition the
// response already reported can never fail, and a wait that cannot fail hides
// the missing transition it was supposed to catch.
//
// WHAT THIS DRIVER IS, RELATIVE TO `system-scheduler`. It is not the clock. §8
// says a test that needs a fast lifecycle "sets short epoch durations and runs
// the real scheduler"; this driver sets the duration the same way (§2.3, the
// admin subject update) and then drives the transitions itself, because it also
// has to interleave member containers, fixtures and assertions between them.
// Nothing here polls on an interval in the sense §9 forbids — that invariant is
// about `system-scheduler`, and the two waits that survive are both on something
// genuinely asynchronous.
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
// The epoch routes' RESPONSE SHAPES, from the module that already states them
// for `system-scheduler` (scripts/lib/system-scheduler/types.ts). A type-only
// import: this driver does not use that container's HTTP client — it has its
// own credential handling and its own failure policy — but the two must not
// drift about what `epochs/turnover` returns, and a second hand-written copy of
// these five interfaces is exactly how they would.
import type {
  AggregateBody,
  FinalizeBody,
  OpenBody,
  RequestJudgingBody,
  TurnoverBody,
} from "../system-scheduler/types.ts";

export function backendUrl(): string {
  return process.env.BACKEND_URL ?? "http://localhost:8787";
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The 5c/5d cross-role log lines below used to be annotated by an env-mirror
// helper (regimeWriteInsecure) that required this HARNESS process to hold the
// producer credential just to describe the stack's posture. Retired (issue
// #361 Phase 4): the annotations now derive from the server's OBSERVED
// response status — strictly more truthful, and the analytics credential never
// reaches this driver at all (it belongs to the producer and its verifier).
// Keep the pure mirror exported for the hermetic polarity guard: callers must
// inject an environment explicitly, so production session code cannot use it
// as a reason to inspect or inherit the producer's credential.
export function regimeWriteInsecure(env: Record<string, string | undefined>): boolean {
  return env.RM_ALLOW_INSECURE === "1" && !env.ANALYTICS_TOKEN;
}

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

// `token` lets an in-process caller pass the dedicated automation credential
// explicitly instead of relying on a process.env mutation shared across the
// same process. The fallback stays for this module's standalone entry point,
// which runs as its own child process with AUTOMATION_TOKEN in its spawn env.
export function getAutomationHeaders(token?: string): Record<string, string> {
  const automationToken = token ?? process.env.AUTOMATION_TOKEN;
  return automationToken ? { "X-Automation-Token": automationToken } : {};
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

export async function admin(action: string, body: unknown = {}, automationToken?: string) {
  return (await adminCall(action, body, automationToken)).body;
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
  automationToken?: string,
): Promise<{ ok: boolean; status: number; body: any }> {
  const r = await fetch(`${backendUrl()}${routePath(ROUTES.swarm.admin.action, { action })}`, {
    method: "POST", headers: { "Content-Type": "application/json", ...getAutomationHeaders(automationToken) }, body: JSON.stringify(body),
  });
  return { ok: r.ok, status: r.status, body: await responseJson(r) };
}

// ── The epoch lifecycle (system-scheduler-spec.md §4) ───────────────────────
//
// Five POSTs under `/api/swarm/admin/epochs/`, each a state-guarded transition
// that has committed by the time it answers. There is no queue behind any of
// them and nothing to wait for afterwards.
//
// §5 IS THE WHOLE REASON THESE RETURN A UNION RATHER THAN THROWING. "Where the
// transition has already happened, the guard returns the original result rather
// than a bare refusal, so a caller can tell 'already done' from 'not allowed.'"
// An already-done answer is `{ ok: true, … }` carrying `created: false`,
// `replayed: true` or `transitioned: false` — a SUCCESS this driver continues
// from — while a reasoned refusal is `{ ok: false, status, error }`. Collapsing
// the two into an exception would lose exactly the distinction the guard exists
// to draw, and would make a re-run of an interrupted smoke fail on its first
// step.

/** A reasoned refusal (§4.6): final, carrying the machine-readable reason. */
export interface EpochRefusal {
  ok: false;
  status: number;
  error: string;
}

export type EpochResult<T> = ({ ok: true; status: number } & T) | EpochRefusal;

/** POST one epoch transition and hand back the API's own envelope, unflattened. */
async function epochCall<T>(
  route: string,
  body: Record<string, unknown>,
  automationToken?: string,
): Promise<EpochResult<T>> {
  const r = await fetch(`${backendUrl()}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...getAutomationHeaders(automationToken) },
    body: JSON.stringify(body),
  });
  const parsed = await responseJson<Record<string, unknown>>(r).catch(() => ({}) as Record<string, unknown>);
  if (!r.ok) {
    const error = typeof parsed.error === "string" ? parsed.error : `http_${r.status}`;
    return { ok: false, status: r.status, error };
  }
  return { ok: true, status: r.status, ...(parsed as T) };
}

/** Throw on a refusal, naming the route and the reason (§4.6: reasoned, final, not retried). */
function requireEpoch<T>(what: string, result: EpochResult<T>): { ok: true; status: number } & T {
  if (!result.ok) {
    throw new Error(
      `${what} was refused (HTTP ${result.status}): ${result.error} — a reasoned refusal is final ` +
        "(system-scheduler-spec.md §4.6), so the driver stops here rather than retrying into it",
    );
  }
  return result;
}

/** §4.1 — create the session, publish its brief and set `window_closes_at`, in one transaction. */
export function openEpoch(subjectId: string, automationToken?: string): Promise<EpochResult<OpenBody>> {
  return epochCall<OpenBody>(ROUTES.swarm.admin.epochOpen, { subjectId }, automationToken);
}

/** §4.3 — close the NAMED epoch and open its successor, in one transaction. */
export function turnOverEpoch(
  subjectId: string,
  expectedSessionId: string,
  automationToken?: string,
): Promise<EpochResult<TurnoverBody>> {
  // The epoch is named, always. §4.3: "Turnover is bound to the epoch, never to
  // 'whatever is open.'" There is deliberately no overload that omits it.
  return epochCall<TurnoverBody>(
    ROUTES.swarm.admin.epochTurnover,
    { subjectId, expectedSessionId },
    automationToken,
  );
}

/** §4.4 step 1 — roll the signed takes up into the recommendation. */
export function aggregateEpoch(sessionId: string, automationToken?: string): Promise<EpochResult<AggregateBody>> {
  return epochCall<AggregateBody>(ROUTES.swarm.admin.epochAggregate, { sessionId }, automationToken);
}

/** §4.4 step 2 under `enforce` — record the request and return the STORED absolute deadline. */
export function requestJudging(sessionId: string, automationToken?: string): Promise<EpochResult<RequestJudgingBody>> {
  return epochCall<RequestJudgingBody>(ROUTES.swarm.admin.epochRequestJudging, { sessionId }, automationToken);
}

/** §4.4 step 3 — decide the judging outcome from stored instants, then publish. */
export function finalizeEpoch(sessionId: string, automationToken?: string): Promise<EpochResult<FinalizeBody>> {
  return epochCall<FinalizeBody>(ROUTES.swarm.admin.epochFinalize, { sessionId }, automationToken);
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
  automationToken?: string,
): Promise<void> {
  const listRes = await fetch(`${backendUrl()}${ROUTES.swarm.admin.subjects}`, {
    headers: getAutomationHeaders(automationToken),
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
    headers: { "Content-Type": "application/json", ...getAutomationHeaders(automationToken) },
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
export async function rosterMembers(targetUrl: string = backendUrl(), automationToken?: string): Promise<RosterMember[] | null> {
  try {
    const r = await fetch(`${targetUrl}${ROUTES.swarm.admin.members}`, { headers: getAutomationHeaders(automationToken) });
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
export async function existingMemberNames(targetUrl: string = backendUrl(), automationToken?: string): Promise<Set<string> | null> {
  const members = await rosterMembers(targetUrl, automationToken);
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
 * The judge's runtime mode, read from the switch itself
 * (`GET /api/swarm/admin/judge`, `swarm_judge_config.mode`).
 *
 * Returns `null` when the switch cannot be read, and NEVER a guess: `off` and
 * "unknown" have to stay distinguishable because runJudgeStep branches on them
 * differently, and a mislabelled `off` would make the driver wait two minutes
 * per session for a judging that is never coming.
 */
export async function readJudgeMode(automationToken?: string): Promise<string | null> {
  try {
    const r = await fetch(`${backendUrl()}${ROUTES.swarm.admin.judgeConfig}`, {
      headers: getAutomationHeaders(automationToken),
    });
    if (!r.ok) throw new Error(`GET ${ROUTES.swarm.admin.judgeConfig} -> ${r.status}`);
    const body = await responseJson<{ judge?: { mode?: unknown } }>(r);
    return typeof body.judge?.mode === "string" ? body.judge.mode : null;
  } catch (err) {
    console.error(
      `[e2e] judge mode read failed — the judging is still queued, but this driver cannot wait for it: ${err instanceof Error ? err.message : err}`,
    );
    return null;
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
  automationToken?: string,
  opts?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<number | null> {
  try {
    const signal = opts?.signal ?? AbortSignal.timeout(opts?.timeoutMs ?? 5_000);
    const r = await fetch(
      `${backendUrl()}${routePath(ROUTES.swarm.admin.sessionJudgements, { id: String(sessionId) })}`,
      { headers: getAutomationHeaders(automationToken), signal },
    );
    if (!r.ok) return null;
    const body = await responseJson<{ judgements?: unknown[] }>(r);
    return Array.isArray(body.judgements) ? body.judgements.length : null;
  } catch {
    return null;
  }
}

// ── Waiting for a judgement, which is the ONE asynchronous step left ────────
//
// §4.4 under `enforce`: the API "records the request instant and the absolute
// deadline … and pushes the request to the judge participants", and the
// scheduler "waits for either `session.judged` or its deadline timer, whichever
// first, and then calls finalize."
//
// THIS DRIVER HAS NO EVENT STREAM, so it polls the session state for `judged`
// instead of holding a subscription. That is allowed: §9's "never polls the API
// on an interval" is an invariant of `system-scheduler`, whose whole design is
// the stream, and §11 says the no-polling rule "applies to the scheduler, not to
// participants." A test driver is neither. What it may NOT do is shorten the
// wait: §4.4's finalize is time-guarded, and "with no eligible consensus it
// refuses finalize as a reasoned no-op until the deadline has passed", so giving
// up before the STORED deadline would only earn a refusal. The deadline the API
// returned is therefore the bound — never a locally chosen ceiling, and never a
// fabricated judgement to escape it.

export interface JudgementWaitOutcome {
  /** True when the session reached `judged` before the stored deadline. */
  judged: boolean;
  /** Why the wait ended — a landed consensus, or the deadline the API stored. */
  reason: "judged" | "deadline";
  waitedMs: number;
}

export interface JudgementWaitDeps {
  readState?: (sessionId: string) => Promise<string | null>;
  wait?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** The session's current lifecycle state, or null when it cannot be read. */
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

/** How often the judgement poll re-reads the session. */
export const JUDGEMENT_POLL_MS = 2_000;

/**
 * Block until the session reaches `judged`, or the API's STORED deadline
 * passes — whichever comes first (§4.4).
 *
 * Never throws. Both endings are legitimate: a consensus that landed, and one
 * that did not. §4.4 is explicit that the second is published as `no_consensus`
 * and "nothing is fabricated", so the caller finalizes either way and the API
 * decides the outcome from its own stored instants.
 */
export async function waitForJudgement(
  sessionId: string,
  deadlineAtIso: string,
  deps: JudgementWaitDeps = {},
): Promise<JudgementWaitOutcome> {
  const readState = deps.readState ?? readSessionState;
  const wait = deps.wait ?? sleep;
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const deadline = Date.parse(deadlineAtIso);
  if (!Number.isFinite(deadline)) {
    throw new Error(
      `request-judging returned deadlineAt '${deadlineAtIso}', which is not a parseable instant — ` +
        "the driver will not substitute a deadline of its own (§9: the stored deadline is never restarted)",
    );
  }
  for (;;) {
    const state = await readState(sessionId);
    // `judged` is the lifecycle state a session holds between consensus being
    // recorded and finalize (§4.4); `published` means something already
    // finalized it, which is equally a reason to stop waiting.
    if (state === "judged" || state === "published") {
      return { judged: true, reason: "judged", waitedMs: now() - startedAt };
    }
    const remaining = deadline - now();
    if (remaining <= 0) return { judged: false, reason: "deadline", waitedMs: now() - startedAt };
    await wait(Math.min(remaining, JUDGEMENT_POLL_MS));
  }
}

/**
 * What the judge step actually did, as the driver observed it (issue #817).
 *
 * This is a RETURN VALUE THAT HAS TO BE READ. It used to be discarded at
 * runSession's call site, which is why a session that recorded a judgement was
 * indistinguishable, on the progress stream, from one that judged nothing:
 * every session emitted `aggregated` and then `published`.
 *
 * `recorded` is the judgement-row count, and it is read ONLY on the deadline
 * path (that is the only path that has to tell "no consensus arrived" apart
 * from "a judgement landed and the state read missed it"). It is `null`
 * everywhere else — including on the success path, where `judged` already says
 * the judging landed — and `null` also means "the record could not be read",
 * which is deliberately not the same as `0`.
 */
export interface JudgeStepOutcome {
  /**
   * The judge mode CAPTURED AT TURNOVER, not the one the switch reads now.
   *
   * §4.4: "Judge mode is captured at turnover. The session records the judge
   * mode in force … at the instant it closes. An admin changing the mode
   * afterwards affects later sessions, never one already settling." So this
   * comes off the turnover response, and the driver no longer reads the
   * `swarm_judge_config` switch to decide what this session's judging is —
   * that read raced the operator and could brief this step on a mode this
   * session was never settling under.
   */
  mode: JudgeMode;
  /** True when judging was requested — `enforce` only, never `off` (§4.4). */
  requested: boolean;
  waitedForJudged: boolean;
  judged: boolean;
  recorded: number | null;
  /** The API's STORED absolute deadline, when one was issued (§4.4). */
  deadlineAt: string | null;
  /**
   * WHO AUTHORED THE OPINION — "model", or a pre-#969 "fallback" (issue #969).
   * `judged (enforce)` was the strongest thing this stream could say, and it is
   * true of a judging that never happened: before #969 a session with no judge
   * model recorded template prose and transitioned exactly like a real one.
   * Null when unreadable, which is reported as unreadable rather than assumed
   * good.
   */
  source?: string | null;
}

/**
 * The two modes a SESSION can be settling under — §4.4, D48.
 *
 * `shadow` is absent on purpose. `swarm_judge_config.mode` still accepts it for
 * the historical rows, but `currentJudgeMode` (backend/src/swarm/domain.ts)
 * reduces it to `off` when it stamps the closing session, because D48 forbids
 * creating new shadow judgements. A driver carrying a third value here would be
 * describing a state no session can hold.
 */
export type JudgeMode = "off" | "enforce";

/**
 * Whether a judge outcome is something the PROGRESS STREAM must report, and
 * under which mode (issue #817).
 *
 * Three things an operator watching a session go by has to be able to tell
 * apart, and before this they all rendered as `aggregated -> published`:
 *
 *   1. `off` — the shipped default, and §4.4's "this is not a failure and is
 *      never presented as one". Nothing was judged and nothing should be
 *      claimed: this returns null, so the stream stays silent and
 *      `not_judged` remains distinguishable from a judgement that landed.
 *   2. `enforce` with a judgement on the record — the event fires, carrying the
 *      mode, because it is a different fact about the session than silence.
 *   3. a wait that reached the deadline with NOTHING recorded — §4.4's
 *      `no_consensus`. No judging landed, so no event: the stream says exactly
 *      what the log says, and neither invents a verdict.
 *
 * The landing test is `judged || recorded > 0`, NOT `judged` alone. A consensus
 * recorded at or before the stored deadline is eligible however late this
 * driver's state read noticed it (§10: "eligibility is decided by stored time,
 * not event arrival"), so an event keyed on the poll's opinion rather than on
 * the record would contradict the outcome finalize goes on to publish.
 */
export function judgedProgress(outcome: JudgeStepOutcome): { judgeMode: string; judgeSource?: string } | null {
  if (outcome.mode !== "enforce") return null;
  const landed = outcome.judged || (outcome.recorded ?? 0) > 0;
  if (!landed) return null;
  // The source rides along so the TUI can say WHO SPOKE, not merely that the
  // session reached `judged` (issue #969).
  return outcome.source ? { judgeMode: outcome.mode, judgeSource: outcome.source } : { judgeMode: outcome.mode };
}

/** Injection seam for runJudgeStep's effects. Real callers pass none. */
export interface JudgeStepDeps {
  readProvenance?: () => Promise<{ source: string | null; fallbackReason: string | null; model: string | null }>;
  requestJudging?: () => Promise<EpochResult<RequestJudgingBody>>;
  waitForJudgement?: (deadlineAt: string) => Promise<JudgementWaitOutcome>;
  countJudgements?: () => Promise<number | null>;
  log?: (line: string) => void;
}

/**
 * The judge step of the settlement chain — §4.4 step 2, between the aggregate
 * it reads and the finalize it must precede.
 *
 * IT BRANCHES ON THE MODE THE SESSION CAPTURED, and on nothing else.
 *
 * `off`: no judging is requested and nothing waits. §4.4 states it flatly —
 * "`aggregated → publish` directly, with judging outcome `not_judged`. This is
 * not a failure and is never presented as one." So there is no queued job that
 * drains as a skip any more, no wait to burn and no log line apologising for a
 * judge that was never asked.
 *
 * `enforce`: request judging, which stores the absolute deadline and pushes the
 * request to the judge participants; wait for a landed consensus or that
 * deadline; return. Finalize is the caller's, because finalize is what decides
 * the outcome and the caller is what publishes.
 *
 * WHY IT DOES NOT THROW WHEN NOTHING LANDS. `no_consensus` is an OUTCOME, not a
 * failure (§4.4: "a session with no consensus says so"), and the API decides it
 * from stored instants whatever this driver believes. Throwing here would turn
 * a legitimately published session into a red smoke run.
 *
 * WHY A `judge_mode_off` REFUSAL IS NOT ONE EITHER. Under `off` this step never
 * calls request-judging at all, so the refusal can only be reached when the
 * captured mode and the API's view disagree — a real disagreement worth naming
 * in the log, but one whose correct handling is the same as `off`: publish
 * through with `not_judged` rather than wedging the cadence.
 */
export async function runJudgeStep(
  sessionId: string,
  judgeMode: JudgeMode,
  automationToken?: string,
  deps: JudgeStepDeps = {},
): Promise<JudgeStepOutcome> {
  const request = deps.requestJudging ?? (() => requestJudging(sessionId, automationToken));
  const waitFor = deps.waitForJudgement ?? ((deadlineAt: string) => waitForJudgement(sessionId, deadlineAt));
  const judgementCount = deps.countJudgements ?? (() => countJudgements(sessionId, automationToken));
  const readProvenance = deps.readProvenance
    ?? (() => latestJudgementProvenance(sessionId, automationToken).catch(() => ({ source: null, fallbackReason: null, model: null })));
  const log = deps.log ?? ((line: string) => console.log(line));

  const idle = (note: string): JudgeStepOutcome => {
    log(note);
    return { mode: "off", requested: false, waitedForJudged: false, judged: false, recorded: null, deadlineAt: null };
  };

  if (judgeMode !== "enforce") {
    return idle(
      "  judge mode=off at turnover — no judging is requested and nothing waits; the session publishes " +
        "with outcome not_judged (§4.4), which is not a failure",
    );
  }

  const requested = await request();
  if (!requested.ok) {
    if (requested.error === "judge_mode_off") {
      return idle(
        `  request-judging refused judge_mode_off for session ${sessionId} although turnover captured ` +
          "`enforce` — the stored mode is what settles this session, so it publishes as not_judged",
      );
    }
    // Any other refusal is a reasoned, final one (§4.6) about a transition the
    // driver believed was legal. It is not survivable the way a missing
    // consensus is: nothing was requested, so nothing can land, and continuing
    // would publish a session whose judging step silently did not happen.
    throw new Error(
      `request-judging for session ${sessionId} was refused (HTTP ${requested.status}): ${requested.error}`,
    );
  }

  const deadlineAt = requested.deadlineAt;
  log(
    `  judging requested (mode=enforce, deadline ${deadlineAt}` +
      `${requested.transitioned ? "" : ", already requested — the STORED deadline is returned unchanged"})`,
  );
  const waited = await waitFor(deadlineAt);
  if (waited.judged) {
    // WHO SPOKE, not just that something did. A `source` other than "model" on
    // a post-#969 stack means a pre-#969 row is still in force; either way the
    // operator reads it here instead of inferring it from the mode.
    const provenance = await readProvenance();
    log(
      `  judged after ${Math.round(waited.waitedMs / 1000)}s (source=${provenance.source ?? "unreadable"}` +
        `${provenance.model ? `, model=${provenance.model}` : ""}` +
        `${provenance.fallbackReason ? `, ${provenance.fallbackReason}` : ""})`,
    );
    return {
      mode: "enforce", requested: true, waitedForJudged: true, judged: true,
      recorded: null, deadlineAt, source: provenance.source,
    };
  }

  // THE DEADLINE PASSED. Read the record, because the state poll and the record
  // can legitimately disagree: §10 says "a consensus recorded before the stored
  // deadline whose `session.judged` event arrives after it yields `judged`", so
  // a row may be on file that this driver's last read had not yet seen.
  // Finalize will decide from the stored instants regardless; the log just says
  // which of the two it is looking at.
  const recorded = await judgementCount();
  const record = recorded == null
    ? "could not read the judgement record"
    : recorded > 0
      ? `${recorded} judgement row(s) ARE recorded — finalize decides eligibility from the stored acceptance ` +
        "instant against the stored deadline, not from when this driver noticed"
      : "NO judgement row was recorded — finalize will publish this session as no_consensus, with no certificate " +
        "and nothing fabricated (§4.4)";
  log(
    `  judging deadline ${deadlineAt} reached after ${Math.round(waited.waitedMs / 1000)}s without a landed ` +
      `consensus — ${record}`,
  );
  const provenance = recorded != null && recorded > 0 ? await readProvenance() : { source: null };
  return {
    mode: "enforce", requested: true, waitedForJudged: true, judged: false,
    recorded, deadlineAt, source: provenance.source,
  };
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
  automationToken?: string,
): Promise<{ source: string | null; fallbackReason: string | null; model: string | null }> {
  const r = await fetch(
    `${backendUrl()}${routePath(ROUTES.swarm.admin.sessionJudgements, { id: String(sessionId) })}`,
    { headers: getAutomationHeaders(automationToken) },
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
     * Is this a `--db smoke-twin` boot? Only the window wait reads it — see the
     * adopted-window branch below.
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
  // violation while the boot still reported READY.
  await admin("subject", subject, rail.automationToken);
  // THE WINDOW LENGTH IS A COLUMN ON THE SUBJECT NOW (§2.2, §2.3), set through
  // the admin API before the epoch that will use it is opened. It used to be a
  // `windowMinutes` argument on every `publish_brief`, which meant two sessions
  // of one subject could advertise different windows and nothing recorded which
  // was intended. §8 names this as the supported way to make a test fast: "a
  // test that needs a fast lifecycle sets short epoch durations". The value is
  // the cadence profile's own window — the same number the old argument carried.
  await setSubjectEpochDuration(subject.id, epochSeconds, rail.automationToken);
  // §4.1 — ONE CALL CREATES THE SESSION, PUBLISHES ITS BRIEF AND SETS THE
  // WINDOW. There is no `scheduled` state any more and no separate brief step,
  // so the session is `collecting` from its first instant and there is nothing
  // to wait for: the transaction committed before this returned.
  //
  // IT IS ALSO HOW AN EPOCH ALREADY IN PROGRESS IS ADOPTED, with no pre-check.
  // Turnover opens the successor (§4.3), so from the second session onward this
  // subject's next epoch is ALREADY open before this driver asks for one — and a
  // driver that restarts mid-window meets the same thing. §4.1 answers it
  // directly: the uniqueness constraint "makes two concurrent first-openings for
  // one subject yield one session; the second call returns it", with
  // `created: false`. Reading the answer is strictly better than a "does one
  // exist?" read followed by an open, which is that same race with a window in
  // the middle of it.
  const opened = requireEpoch(`epochs/open for subject '${subject.id}'`, await openEpoch(subject.id, rail.automationToken));
  const sessionId = opened.sessionId;
  const adopted = !opened.created;
  // The date is Postgres's, read back from the row the open created (migration
  // 0022) — never computed here.
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
    await admin("subject_fixtures", { id: subject.id, name: subject.name, date }, rail.automationToken);
  }

  // NO `scheduled` EVENT. §4.1: "There is no `scheduled` state and no 'brief
  // opens later.'" The stream used to emit one between the open and the brief,
  // and emitting it now would put a state on the operator's screen that no
  // session can ever be read back in.
  if (adopted) {
    console.log(
      `${tag} session ${sessionId}: ADOPTING an epoch already open — turnover opened it (§4.3), and its ` +
        `advertised windowClosesAt ${opened.windowClosesAt} is left exactly as published, never extended`,
    );
  } else {
    // ASSERTED, NOT AWAITED. `epochs/open` answers `state: "collecting"` from a
    // transaction that has committed, so the state poll that used to follow it
    // could only ever pass on its first iteration. Checking the body instead
    // keeps the claim and drops the wait that could not fail.
    if (opened.state !== "collecting") {
      throw new Error(`${tag} epochs/open returned state '${opened.state}', expected 'collecting' (§4.1)`);
    }
    console.log(
      `${tag} session ${sessionId}: brief published, window open for ${epochSeconds}s ` +
        `(closes ${opened.windowClosesAt})`,
    );
  }
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
  // A TWIN THAT ADOPTED PRODUCTION'S EPOCH IS THE ONE EXCEPTION, and it is not
  // an exception to the promise — it is the absence of one. The deadline on an
  // adopted session was advertised by PRODUCTION, to production's members,
  // and arrived here inside a restored dump; this boot promised nobody
  // anything, and the members it seats are all in this process. Honouring it
  // means a twin cannot answer "does the judge run?" for another six hours —
  // and worse, planWindowWait ABORTS rather than waits when the remaining
  // window exceeds its ceiling ("refusing to wait (it would hang)"), so the
  // session stalls instead of completing. That is exactly how the standing
  // twin published no judgement and no receipt for weeks.
  //
  // So on a twin, an ADOPTED window is closed as soon as this boot's own seats
  // have filed. A window this boot published is still waited out in full, on
  // both twins and everything else: that one IS a promise.
  const skipAdoptedWindow = Boolean(opts.twin) && adopted;
  const closedWindow = skipAdoptedWindow
    ? { waitedMs: 0, reason: "twin adopted production's epoch — its deadline was advertised by another deployment, to members this boot does not seat" }
    : await waitUntilWindowCloses(sessionId, tag, { maxWaitMs: windowWaitCeilingMs(cadence) });
  console.log(
    `${tag} window elapsed after ${Math.round(closedWindow.waitedMs / 1000)}s — ${closedWindow.reason}`,
  );
  // §4.3 — THE BOUNDARY. One call, BOUND TO THIS EPOCH: it closes `sessionId`
  // (recording an `absent` for each seated member with no take before
  // `window_closes_at`) and opens N+1, in one transaction. Naming the epoch is
  // what makes it safe to repeat — "if the named session is no longer the
  // current collecting one … it never closes the successor" — so a re-run of an
  // interrupted smoke replays the original result instead of closing the fresh
  // window this same call just opened.
  //
  // The state poll that used to follow the close is gone with the queue: the
  // close committed inside this transaction, so a poll for it afterwards could
  // not fail and could not report anything the response has not already said.
  const turned = requireEpoch(`epochs/turnover for session ${sessionId}`, await turnOverEpoch(subject.id, sessionId, rail.automationToken));
  console.log(
    `${tag} epoch closed${turned.replayed ? " (replayed — this turnover had already happened)" : ""}; ` +
      `successor ${turned.openedSessionId} is open until ${turned.windowClosesAt}`,
  );
  emitSession("window_closed", sessionId);

  // §4.4 step 1. `transitioned: false` is the idempotent success a resumed
  // settlement gets (§5), not a refusal — the session is `aggregated` either way.
  const aggregated = requireEpoch(`epochs/aggregate for session ${sessionId}`, await aggregateEpoch(sessionId, rail.automationToken));
  if (aggregated.state !== "aggregated") {
    throw new Error(`${tag} epochs/aggregate returned state '${aggregated.state}', expected 'aggregated'`);
  }
  emitSession("aggregated", sessionId);

  // §4.4 step 2. The judge sits HERE — between the rollup it reads and the
  // finalize that publishes. The MODE IS THE ONE THE TURNOVER CAPTURED, not one
  // this driver re-reads off the switch: §4.4 pins the mode to the instant the
  // session closed, so an admin flipping it mid-settlement cannot reach this
  // session. Under `off` this returns at once with nothing requested.
  const judgeOutcome = await runJudgeStep(sessionId, turned.judgeMode, rail.automationToken);
  // AND THE STREAM HAS TO SAY SO (issue #817). This return used to be dropped
  // on the floor, so the one surface an operator actually watches went
  // `aggregated -> published` whether the soak had recorded a judgement or
  // judged nothing at all — which is the same thing as the judge not running.
  // `judgedProgress` decides from the RECORD, not from the wait's opinion: it
  // stays silent at the shipped `off`, and it still fires for a consensus that
  // was on file when the deadline came round — §10 decides eligibility from the
  // stored acceptance instant, never from when this driver noticed.
  const judged = judgedProgress(judgeOutcome);
  if (judged) emitSession("judged", sessionId, judged);

  // §4.4 step 3 — FINALIZE DECIDES THE OUTCOME AND PUBLISHES, in one call, from
  // stored instants. The driver does not compute the outcome and does not pass
  // one: "the API compares the stored consensus acceptance instant (if a
  // consensus was recorded) against the stored deadline."
  //
  // The lane-aware publish wait that used to follow is gone with the lane. So is
  // the plain state poll: `published` is this call's own committed result, and
  // `no_consensus` is one of the three outcomes it may legitimately publish
  // (§4.4), never a failure for this driver to raise.
  const published = requireEpoch(`epochs/finalize for session ${sessionId}`, await finalizeEpoch(sessionId, rail.automationToken));
  console.log(
    `${tag} finalized: outcome=${published.outcome}` +
      `${published.replayed ? " (replayed — the outcome was already decided)" : ""}`,
  );
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
  await admin("subject", subjects[0], rail.automationToken);

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
    method: "POST", headers: { "Content-Type": "application/json", ...getAutomationHeaders() },
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

  // 5d. Known member token calling admin lifecycle (same insecure-mode caveat).
  const adminCloseRes = await fetch(`${backendUrl()}${ROUTES.swarm.admin.close}`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${testToken}` },
    body: JSON.stringify({ sessionId: -1 }),
  });
  console.log(`  cross-role: member → admin close → ${adminCloseRes.status}${regimeGateOpen ? " (insecure mode — gate open)" : " (enforced)"}`);

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
