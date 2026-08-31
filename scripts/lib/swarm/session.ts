// REST-path end-to-end swarm smoke (D21 — the MCP transport is retired; see
// docs/decisions.md D21). Drives one or more full swarm sessions where N
// independent agents participate over the swarm REST API (each its own key
// + token). One member per session is a deliberate no-show. The session
// lifecycle is driven through the worker job queue (admin enqueue-job → worker
// handler → domain) so the smoke exercises the real FOR UPDATE SKIP LOCKED claim
// loop. Multi-session: the second session's brief references the first session's
// outcome, smokenstrating rotation awareness.
//
// This module replaces the retired mcp/src/e2e.ts. The lifecycle was always
// driven over the REST admin API; only the per-member participation (./agent.ts)
// and the standalone main()'s former MCP-OAuth assertions changed.
import { demoAttends, path as routePath, ROUTES, STANCES } from "@robotmoney/contract";
import { runAgent, enroll, railFromEnv } from "./agent.ts";
import type { AgentStage, SessionRail } from "./agent.ts";
import { resolveSmokeCadence, swarmWindowMinutes } from "../smoke-schedule.ts";
import type { SmokeCadence } from "../smoke-schedule.ts";
import type { ScenarioInitializer } from "../smoke-mode.ts";
import { missingSectionLeadIns } from "./inference.ts";
import { generateKeyPair } from "./crypto.ts";

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

// Post-publish structural assertions over every PRESENT member's authored take.
// Throws on any failure so the standalone `bun run session.ts` entrypoint exits
// non-zero (main() catches and process.exit(1)) — this is the required-CI signal
// that each take was authored by a real inference call, not a template.
export function assertAuthoredTakes(tag: string, takes: any[], expectedMemberIds: readonly string[]) {
  // Present-member takes are the ones that actually posted a body; absent
  // no-shows enrolled but never submitted, so they carry no body.
  const authored = (takes ?? []).filter(
    (t) => typeof t?.body === "string" && t.body.trim().length > 0,
  );
  if (authored.length === 0) {
    throw new Error(`${tag}: no authored takes to assert on (expected ≥1 present member)`);
  }
  const authoredIds = new Set(authored.map((t) => String(t.memberId)));
  for (const memberId of expectedMemberIds) {
    if (!authoredIds.has(memberId)) {
      throw new Error(`${tag}: present member ${memberId} has no live-authored take`);
    }
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
export type SessionEvent =
  | { type: "session"; state: string; sessionId?: number; subject: string; date: string }
  | { type: "member"; memberId: string; stage: AgentStage | "absent"; stance?: string; confidence?: number };
export type SessionProgress = (ev: SessionEvent) => void;

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
 * failed enqueue became `enqueued undefined (job #undefined)` and a 120-second
 * wait for a job that was never queued. Callers that must not proceed on a
 * failure use this and check `ok`; the ones that legitimately read an error
 * body keep `admin()`.
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

// Exported (in addition to standalone-main use) so scripts/rmpc-release-e2e.ts
// (issue #104) can drive the SAME proven job-queue session lifecycle this file's
// own runSession() uses, instead of hand-rolling a second one.
export async function waitForSessionState(date: string, subject: string, expectedState: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await fetch(`${backendUrl()}${routePath(ROUTES.swarm.session, { date, subject })}`);
    if (r.ok) {
      const data = await responseJson(r);
      if (data.session?.state === expectedState) return data;
    }
    await sleep(500);
  }
  throw new Error(
    `session ${date}/${subject} did not reach '${expectedState}' within ${timeoutMs}ms ` +
      `(the worker may still be draining an earlier job — check 'bun run smoke:status' or the worker container logs)`,
  );
}

/**
 * Wait for a subject's NEWEST session to reach a state, WITHOUT knowing its date.
 *
 * This is the bootstrap half of waitForSessionState: after `open_session` is
 * enqueued nobody knows the date yet, because Postgres has not stamped
 * convened_at. Polling the sessions list by subject is the only honest way to
 * learn it — the alternative is guessing a date locally, which is exactly the
 * habit migration 0022 removed. Once this returns, the caller has the real date
 * and every later poll can use the cheaper date-addressed route.
 */
export async function waitForSubjectSession(
  subject: string,
  expectedState: string | readonly string[],
  timeoutMs = 30_000,
) {
  // A SET of acceptable states, because openSession is idempotent per OPEN
  // session: it refuses to convene a second session while one is `scheduled` or
  // `collecting` and returns the existing row instead. With the window now one
  // full cadence interval long, "already collecting" is the NORMAL state of a
  // session this driver is re-adopting after a restart — demanding `scheduled`
  // wedged that subject permanently, one 30-second timeout per slot, for as
  // long as the (six-hour) window ran. See runSession's adoption branch.
  const wanted = typeof expectedState === "string" ? [expectedState] : [...expectedState];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await fetch(`${backendUrl()}${ROUTES.swarm.sessions}`);
    if (r.ok) {
      const data = await responseJson(r);
      // The list is newest-first, so the first row for this subject is the one
      // just convened. Matching on subject alone (not date) is the whole point.
      const s = (data.sessions ?? []).find((x: { subjectId?: string }) => x.subjectId === subject);
      if (s?.state && wanted.includes(s.state)) return { session: s };
    }
    await sleep(500);
  }
  throw new Error(
    `no session for subject '${subject}' reached ${wanted.map((w) => `'${w}'`).join(" or ")} within ${timeoutMs}ms ` +
      `(the worker may still be draining an earlier job — check 'bun run smoke:status' or the worker container logs)`,
  );
}

// ── Waiting out the advertised window (issue #570) ──────────────────────────
// The driver's own members finishing is NOT the window ending. It used to be
// treated as though it were: `close_window` was enqueued the moment
// mapSettledWithConcurrency returned, which is 1-3 minutes after a brief that
// advertised an hour. That was invisible while the driver owned every member —
// its agents run inside the process that closes the window, so they always beat
// it — and became a defect the instant an external member joined the roster.
//
// Everything below is built so the DECISION is pure and unit-testable in the
// required per-PR `unit` job, while the loop that performs it stays a thin
// wrapper: a six-hour window can never be observed in CI, so the arithmetic has
// to be executed somewhere a CI clock can reach.

/** Extra time past the advertised instant before the close is enqueued. */
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
 * Clock skew is a real hazard here and it is asymmetric: `window_closes_at` is
 * computed in JavaScript inside the api container (`publishBrief` does
 * `Date.now() + windowMinutes * 60_000`) while the submit path compares it
 * against Postgres `now()`. A driver that trusted its OWN clock could enqueue
 * the close before the database agreed the window had ended, and a take that
 * arrived in between would be accepted after the aggregate had been computed.
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
      reason: "session advertises no windowClosesAt — publish_brief did not land, so there is no deadline to honour",
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

/** Read the advertised deadline AND the server clock in one round trip. */
export async function readSessionWindow(date: string, subject: string): Promise<SessionWindowReading> {
  const r = await fetch(`${backendUrl()}${routePath(ROUTES.swarm.session, { date, subject })}`);
  const header = r.headers.get("date");
  const headerMs = header ? Date.parse(header) : NaN;
  const serverNowMs = Number.isFinite(headerMs) ? headerMs : null;
  if (!r.ok) return { windowClosesAt: null, serverNowMs };
  const data = await responseJson<{ session?: { windowClosesAt?: string | null } }>(r);
  return { windowClosesAt: data.session?.windowClosesAt ?? null, serverNowMs };
}

export interface WindowWaitDeps {
  read?: (date: string, subject: string) => Promise<SessionWindowReading>;
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
  date: string,
  subject: string,
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
  for (;;) {
    const reading = await read(date, subject);
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
      throw new Error(`window wait for ${date}/${subject} refused: ${plan.reason}`);
    }
    if (plan.action === "proceed") {
      return { waitedMs: hostNow - startedAt, windowClosesAt: reading.windowClosesAt, reason: plan.reason, clockFallbacks };
    }
    if (hostNow - startedAt >= limits.maxWaitMs) {
      throw new Error(
        `window wait for ${date}/${subject} exceeded its ${Math.round(limits.maxWaitMs / 1000)}s ceiling ` +
          `without the window closing (last read: ${plan.reason})`,
      );
    }
    await wait(plan.sleepMs);
  }
}

/**
 * Enqueue one lifecycle step, and FAIL LOUDLY IF IT DID NOT GET QUEUED
 * (issue #806).
 *
 * This used to read the response body without ever looking at the status. On
 * any non-2xx it printed `enqueued undefined (job #undefined)` and returned
 * normally, so the caller went on to wait for a state that nothing was going to
 * produce. For every step but the judge that wait throws and fails the run; the
 * judge's wait is CAUGHT and publishes anyway, so a rotated automation token
 * turned into "judge did not reach 'judged' in time … publishing anyway" — a
 * log line blaming a slow judge for a judging that was never queued.
 *
 * A throw is the right answer here for the same reason it is for the other
 * steps: the driver cannot do its job without the queue, and pretending
 * otherwise loses the one session it was running.
 */
export async function enqueueLifecycleJob(action: string, payload: Record<string, unknown> = {}, automationToken?: string) {
  const { ok, status, body } = await adminCall("enqueue-job", { action, ...payload }, automationToken);
  if (!ok || body?.jobId == null) {
    throw new Error(
      `enqueue-job '${action}' failed (HTTP ${status}): ${JSON.stringify(body)} — ` +
        "nothing was queued, so nothing will happen; check AUTOMATION_TOKEN and the api container",
    );
  }
  const deduped = body.deduped === true ? ` (already queued, status=${body.existingStatus})` : "";
  console.log(`  enqueued ${body.kind} (job #${body.jobId})${deduped}`);
  return body;
}

// How long runJudgeStep will wait for a judging to land before publishing
// anyway. The model call itself is bounded at ~60s (SWARM_JUDGE_TIMEOUT_MS),
// and the judge job still has to be claimed off the swarm lane first, so this
// is deliberately generous. It is a CEILING, not a budget: with the mode `off`
// — the shipped default — nothing waits at all.
const JUDGE_WAIT_MS = 120_000;

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
export async function countJudgements(sessionId: string | number, automationToken?: string): Promise<number | null> {
  try {
    const r = await fetch(
      `${backendUrl()}${routePath(ROUTES.swarm.admin.sessionJudgements, { id: String(sessionId) })}`,
      { headers: getAutomationHeaders(automationToken) },
    );
    if (!r.ok) return null;
    const body = await responseJson<{ judgements?: unknown[] }>(r);
    return Array.isArray(body.judgements) ? body.judgements.length : null;
  } catch {
    return null;
  }
}

/** Injection seam for runJudgeStep's effects. Real callers pass none. */
export interface JudgeStepDeps {
  readMode?: () => Promise<string | null>;
  enqueue?: (action: string, payload: Record<string, unknown>) => Promise<unknown>;
  waitForJudged?: () => Promise<unknown>;
  countJudgements?: () => Promise<number | null>;
  log?: (line: string) => void;
}

/**
 * The judge step of THIS DRIVER'S cadence (issue #767).
 *
 * THERE ARE TWO SESSION-CREATION PATHS AND ONLY ONE OF THEM IS A SCHEDULER.
 * `createSessionAdmin` (POST /api/swarm/admin/sessions) enqueues all five
 * lifecycle jobs up front, at `run_after` instants derived from the session's
 * own timestamps. This driver — the one production actually runs, with
 * `SWARM_SCHEDULES_ENABLED=0` (see scripts/lib/smoke-schedule.ts) — does not go
 * through it: it opens a session with `open_session` (domain.openSession
 * enqueues NOTHING) and then enqueues each step by hand as the previous one
 * lands. So putting `swarm.judge` on `SESSION_JOB_KINDS` gave a judging to
 * admin-created sessions and to NO session this driver creates, however long
 * anyone waited. This function is the other half.
 *
 * WHY IT WAITS, WHEN IT WAITS. The other steps are enqueued and then awaited by
 * state, and the judge has to be too — but for a stronger reason than symmetry.
 * `swarm.publish` is an unconditional `UPDATE ... SET state='published'`, while
 * `judgeSessionAdmin` needs the `aggregated -> judged` transition to still be
 * legal when its model call returns up to a minute later. Enqueue both back to
 * back and the publish very often wins: the transition is refused, the whole
 * judging transaction rolls back, and the soak records NOTHING while the job
 * queue fills with `degraded` rows. Waiting for `judged` removes the race.
 *
 * WHY IT DOES NOT ALWAYS WAIT. `off` is the shipped default and must stay a
 * clean, instant no-op on the cadence: with the judge disabled the queued job
 * drains as `{ skipped: "judge_disabled" }` and the session never leaves
 * `aggregated`, so waiting for `judged` would burn the ceiling above on every
 * single session. The job is enqueued either way — that is what makes flipping
 * the database switch take effect on the next session with nothing redeployed
 * and this driver not restarted.
 *
 * WHY A TIMEOUT IS NOT FATAL. Publishing is this driver's job. A judge that is
 * slow, wedged, or misconfigured must never wedge the session cadence behind
 * it, so the wait is loud on expiry and then proceeds. The judging that lands
 * late is refused honestly by `applyOpinion`'s state check rather than writing
 * onto a published session.
 */
export async function runJudgeStep(
  sessionId: string | number,
  date: string,
  subjectId: string,
  automationToken?: string,
  deps: JudgeStepDeps = {},
): Promise<{ mode: string | null; waitedForJudged: boolean; judged: boolean }> {
  const readMode = deps.readMode ?? (() => readJudgeMode(automationToken));
  const enqueue = deps.enqueue
    ?? ((action: string, payload: Record<string, unknown>) => enqueueLifecycleJob(action, payload, automationToken));
  const waitForJudged = deps.waitForJudged ?? (() => waitForSessionState(date, subjectId, "judged", JUDGE_WAIT_MS));
  const judgementCount = deps.countJudgements ?? (() => countJudgements(sessionId, automationToken));
  const log = deps.log ?? ((line: string) => console.log(line));

  // Read the switch BEFORE enqueueing, so the branch below is about the mode
  // that was in force when this step ran rather than one an operator flipped
  // while the job sat in the queue.
  const mode = await readMode();
  // NOT inside the try below, and that is deliberate. `enqueueLifecycleJob`
  // throws when nothing was queued (issue #806) — a failed enqueue is not a
  // slow judge and must not be absorbed by the wait's survivable-timeout
  // branch, which would publish the session and log the wrong cause.
  const queued = await enqueue("judge", { sessionId });
  const queuedJobId = (queued as { jobId?: unknown } | undefined)?.jobId;

  if (mode !== "shadow" && mode !== "enforce") {
    log(`  judge mode=${mode ?? "unreadable"} — the queued judging drains as a clean skip; not waiting for 'judged'`);
    return { mode, waitedForJudged: false, judged: false };
  }
  try {
    await waitForJudged();
    log(`  judged (mode=${mode})`);
    return { mode, waitedForJudged: true, judged: true };
  } catch (err) {
    // SAY WHICH FAILURE THIS IS (issue #806). "did not reach 'judged' in time"
    // asserts a slow judge, and on the single-worker swarm lane that is usually
    // untrue: publish is enqueued only after this wait returns and cannot be
    // claimed while the judge holds the lane, so an expiry here is more often a
    // judging that ran and was REFUSED, or one still queued behind a wedged
    // lane, than one that was merely slow. The record answers it — a judgement
    // row exists or it does not — so the log reports that instead of guessing.
    const recorded = await judgementCount();
    const record = recorded == null
      ? "could not read the judgement record"
      : recorded > 0
        ? `${recorded} judgement row(s) ARE recorded — the judging ran; the session did not transition`
        : "NO judgement row was recorded — the judging did not run to completion";
    log(
      `  judge job #${queuedJobId ?? "?"} was queued but the session did not reach 'judged' in time (mode=${mode}) — ` +
        `${record}; publishing anyway rather than wedging the cadence: ${err instanceof Error ? err.message : err}`,
    );
    return { mode, waitedForJudged: true, judged: false };
  }
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
  const producer = Bun.spawn(
    ["docker", "compose", "-p", rail.composeProject, ...rail.composeFiles.flatMap((f) => ["-f", f]),
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
    prevOutcome?: string;
    rail?: SessionRail;
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
    initializer: ScenarioInitializer;
    // The CADENCE PROFILE this invocation resolved (scripts/lib/smoke-schedule.ts).
    // REQUIRED, for the same reason `initializer` is: the submission window is a
    // cadence timing, and a default would make the six-hour production value the
    // thing you get by forgetting the parameter — or, worse, make CI inherit it.
    // Every caller already knows which invocation it is: smoke-main resolved the
    // profile from `--static-port` at module load, and the standalone CI entry
    // point below is always the fast profile by definition.
    cadence: SmokeCadence;
  },
) {
  const prevOutcome = opts?.prevOutcome;
  const onProgress = opts?.onProgress;
  const rail = opts?.rail ?? railFromEnv();
  const cadence = opts.cadence;
  const windowMinutes = swarmWindowMinutes(cadence);

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
  await enqueueLifecycleJob("open_session", { subjectId: subject.id }, rail.automationToken);
  // RECONCILING openSession's "one open session per subject" WITH A WINDOW THAT
  // IS ONE FULL INTERVAL (issue #570). openSession refuses to convene a second
  // session while one is `scheduled` or `collecting`, and returns the existing
  // row instead — that refusal is load-bearing and stays exactly as it is: it is
  // what makes "the subject's newest session" unambiguous for
  // submitRecommendation, which is the lookup an unsolicited take resolves
  // through. What changes is that `collecting` is now the LONG state: a session
  // sits in it for a whole cadence interval (six hours in production), so a
  // driver that restarts mid-window meets an open session for its subject on
  // every slot. Demanding `scheduled` here made that fatal — 30-second timeout,
  // logged as "swarm session failed", repeated forever — so the driver now
  // ADOPTS the epoch already in progress instead of demanding a fresh one.
  const opened = await waitForSubjectSession(subject.id, ["scheduled", "collecting"]);
  const date: string = opened.session.date;
  const sessionId = opened.session.id;
  // An adopted session already carries an advertised deadline. Re-publishing a
  // brief over it would push `windowClosesAt` out by another full interval —
  // moving a deadline external members have already been told, which is the
  // same class of lie this issue exists to remove.
  const adopted = opened.session.state === "collecting";
  const tag = `[session ${sessionIndex}: ${date}/${subject.id}]`;
  console.log(`\n${tag}`);
  // Session-lifecycle emitter — one call per real state transition below.
  const emitSession = (state: string, sid?: number) =>
    onProgress?.({ type: "session", state, sessionId: sid, subject: subject.id, date });

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

  emitSession("scheduled", sessionId);

  if (adopted) {
    console.log(
      `${tag} session ${sessionId}: ADOPTING an epoch already in progress — its advertised ` +
        "windowClosesAt is left exactly as published, never extended",
    );
  } else {
    // `windowMinutes` comes from the CADENCE PROFILE, never from a literal and
    // never from an env var. It was a hardcoded 60 here: an honest hour at the
    // instant it was written, and a lie by the time this driver closed the
    // window three minutes later.
    await enqueueLifecycleJob("publish_brief", { sessionId, windowMinutes, prevOutcome }, rail.automationToken);
    await waitForSessionState(date, subject.id, "collecting");
    console.log(`${tag} session ${sessionId}: brief published, window open for ${windowMinutes} min`);
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
  // SWARM_MAX_CONCURRENCY member containers in flight. The unconditional
  // post-publish assertion below still fails the run if any present member did
  // not produce a live-authored take.
  const limit = Number(process.env.SWARM_MAX_CONCURRENCY ?? 4);
  const settled = await mapSettledWithConcurrency(present, limit, (m) => runAgent(
    rail,
    { ...m, date, subjectId: subject.id, sessionId },
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
  const closedWindow = await waitUntilWindowCloses(date, subject.id, {
    maxWaitMs: windowWaitCeilingMs(cadence),
  });
  console.log(
    `${tag} window elapsed after ${Math.round(closedWindow.waitedMs / 1000)}s — ${closedWindow.reason}`,
  );
  await enqueueLifecycleJob("close_window", { sessionId }, rail.automationToken);
  await waitForSessionState(date, subject.id, "window_closed");
  emitSession("window_closed", sessionId);

  await enqueueLifecycleJob("aggregate", { sessionId }, rail.automationToken);
  await waitForSessionState(date, subject.id, "aggregated");
  emitSession("aggregated", sessionId);

  // The judge sits HERE — between the rollup it reads and the publish it must
  // beat (issue #767). Without this line the consensus judge reaches only
  // sessions created through POST /api/swarm/admin/sessions, which is not a
  // path this driver, or production's cadence, ever takes. See runJudgeStep for
  // why it waits in `shadow`/`enforce`, why it does not wait at the shipped
  // `off`, and why an expired wait publishes rather than wedging.
  await runJudgeStep(sessionId, date, subject.id, rail.automationToken);

  await enqueueLifecycleJob("publish", { sessionId }, rail.automationToken);
  await waitForSessionState(date, subject.id, "published");
  emitSession("published", sessionId);

  const pub = await fetch(`${backendUrl()}${routePath(ROUTES.swarm.session, { date, subject: subject.id })}`).then(responseJson);
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
  assertAuthoredTakes(tag, pub.takes, present.map((m) => m.memberId));

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
  console.log(`  cadence profile: ${cadence.profile}; submission window ${swarmWindowMinutes(cadence)} min`);
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
  const s1 = await runSession(subjects[0], 1, { rail, members, initializer: "simulation", cadence });

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
  await runSession(subjects[1], 2, { prevOutcome: s1.pub.session.synthesis, rail, members, initializer: "simulation", cadence });

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
