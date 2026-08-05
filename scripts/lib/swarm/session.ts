// REST-path end-to-end swarm demo (D21 — the MCP transport is retired; see
// docs/decisions.md D21). Drives one or more full swarm sessions where N
// independent agents participate over the swarm REST API (each its own key
// + token). One member per session is a deliberate no-show. The session
// lifecycle is driven through the worker job queue (admin enqueue-job → worker
// handler → domain) so the demo exercises the real FOR UPDATE SKIP LOCKED claim
// loop. Multi-session: the second session's brief references the first session's
// outcome, demonstrating rotation awareness.
//
// This module replaces the retired mcp/src/e2e.ts. The lifecycle was always
// driven over the REST admin API; only the per-member participation (./agent.ts)
// and the standalone main()'s former MCP-OAuth assertions changed.
import { demoAttends, path as routePath, ROUTES, STANCES } from "@robotmoney/contract";
import { runAgent, enroll, railFromEnv } from "./agent.ts";
import type { AgentStage, SessionRail } from "./agent.ts";
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
    for (const lead of ["**REGIME**", "**ALLOCATION**", "**SUBJECT**"]) {
      if (!t.body.includes(lead)) {
        throw new Error(`${tag}: take for ${who} is missing the ${lead} lead-in`);
      }
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

// Deterministic attendance comes from the SHARED demo no-show rule in
// @robotmoney/contract (contract/src/swarm.js) — the backend demo e2e
// consumes the same rule, so the two drivers can no longer drift (finding 008
// retired the comment-enforced mirror). The roster outcome stays fixed (draco
// absent; athena/boreas/cygnus present) so the required hermetic e2e and any
// goldens stay reproducible.

export const MEMBERS = [
  { memberId: "athena", name: "Athena", lens: "macro risk", bias: -0.1, present: demoAttends("athena") },
  { memberId: "boreas", name: "Boreas", lens: "on-chain flows", bias: 0.0, present: demoAttends("boreas") },
  { memberId: "cygnus", name: "Cygnus", lens: "momentum", bias: 0.15, present: demoAttends("cygnus") },
  { memberId: "draco", name: "Draco", lens: "contrarian", bias: 0.0, present: demoAttends("draco") },
];
export const SUBJECTS = [
  { id: "woon", name: "Woon Treasury" },
  { id: "mav", name: "Mav Holdings" },
];

// The standing-demo roster cap now lives in @robotmoney/contract
// (SWARM_ROSTER_CAP) — the mirror this module used to carry is gone;
// consumers (scripts/lib/demo-main.ts, backend domain) import the contract.

// Issue #456: `token` lets an in-process caller (the demo's dynamically
// imported swarm driver) pass its admin credential explicitly instead of
// relying on a process.env.ADMIN_TOKEN mutation shared across the same
// process. The process.env fallback stays for this module's own standalone
// entry point (main(), below), which genuinely runs as its own child process
// with ADMIN_TOKEN set on its own environment at spawn time — reading that is
// normal env inheritance, not the global-mutation antipattern the token
// parameter replaces.
export function getAdminHeaders(token?: string): Record<string, string> {
  const t = token ?? process.env.ADMIN_TOKEN;
  return t ? { "X-Admin-Token": t } : {};
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

export async function admin(action: string, body: unknown = {}, adminToken?: string) {
  const r = await fetch(`${backendUrl()}${routePath(ROUTES.swarm.admin.action, { action })}`, {
    method: "POST", headers: { "Content-Type": "application/json", ...getAdminHeaders(adminToken) }, body: JSON.stringify(body),
  });
  return responseJson(r);
}

// Active swarm roster size, read from the backend — the gate the standing
// demo checks against SWARM_ROSTER_CAP before admitting a newcomer. A read
// failure (network blip, backend momentarily busy) must NEVER be treated as
// "roster is empty" — that silently waves admission through regardless of the
// TRUE count, which is exactly what let the demo's onboarding driver keep
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
 * The demo admits a FIXED, finite list of named newcomers (Helios, Selene, …)
 * indexed by a counter that starts at 0 in each process. Against a throwaway
 * database that was right; against a persistent one it re-admits Helios on every
 * boot, and the roster grows a duplicate Helios per restart (four of them were
 * observed on the standing demo — two active, two stuck in `applied`).
 *
 * Names are the identity here because the SERVER mints the member id: the demo
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
  name: string;
  lens: string | null;
  status: string;
}

/** The full roster (every status), or null when it cannot be read. */
export async function rosterMembers(targetUrl: string = backendUrl(), adminToken?: string): Promise<RosterMember[] | null> {
  try {
    const r = await fetch(`${targetUrl}${ROUTES.swarm.admin.members}`, { headers: getAdminHeaders(adminToken) });
    if (!r.ok) throw new Error(`GET ${ROUTES.swarm.admin.members} -> ${r.status}`);
    const body = await responseJson(r) as { members?: { id?: string; name?: string; lens?: string | null; status?: string }[] };
    if (!Array.isArray(body.members)) throw new Error("admin members response has no members array");
    return body.members
      .filter((m) => m?.id && m?.name)
      .map((m) => ({ id: String(m.id), name: String(m.name), lens: m.lens ?? null, status: String(m.status ?? "") }));
  } catch (err) {
    console.error(`[e2e] rosterMembers: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/** Lower-cased names on the roster, or null when the roster cannot be read. */
export async function existingMemberNames(targetUrl: string = backendUrl(), adminToken?: string): Promise<Set<string> | null> {
  const members = await rosterMembers(targetUrl, adminToken);
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
      `(the worker may still be draining an earlier job — check 'bun run demo:status' or the worker container logs)`,
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
export async function waitForSubjectSession(subject: string, expectedState: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await fetch(`${backendUrl()}${ROUTES.swarm.sessions}`);
    if (r.ok) {
      const data = await responseJson(r);
      // The list is newest-first, so the first row for this subject is the one
      // just convened. Matching on subject alone (not date) is the whole point.
      const s = (data.sessions ?? []).find((x: { subjectId?: string }) => x.subjectId === subject);
      if (s?.state === expectedState) return { session: s };
    }
    await sleep(500);
  }
  throw new Error(
    `no session for subject '${subject}' reached '${expectedState}' within ${timeoutMs}ms ` +
      `(the worker may still be draining an earlier job — check 'bun run demo:status' or the worker container logs)`,
  );
}

export async function enqueueLifecycleJob(action: string, payload: Record<string, unknown> = {}, adminToken?: string) {
  const result = await admin("enqueue-job", { action, ...payload }, adminToken);
  console.log(`  enqueued ${result.kind} (job #${result.jobId})`);
  return result;
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
// demo's exact compose env).
export async function runSession(
  subject: typeof SUBJECTS[0],
  sessionIndex: number,
  opts?: { prevOutcome?: string; rail?: SessionRail; onProgress?: SessionProgress; regimeAsof?: string },
) {
  const prevOutcome = opts?.prevOutcome;
  const onProgress = opts?.onProgress;
  const rail = opts?.rail ?? railFromEnv();

  // THE DATE IS NOT AN INPUT. It used to be — the demo passed `today + N days`
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
  await admin("subject", subject, rail.adminToken);
  await enqueueLifecycleJob("open_session", { subjectId: subject.id }, rail.adminToken);
  const opened = await waitForSubjectSession(subject.id, "scheduled");
  const date: string = opened.session.date;
  const sessionId = opened.session.id;
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
  // with any demo-narrative date, including tomorrow. It no longer can be:
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
  await admin("subject_fixtures", { id: subject.id, name: subject.name, date }, rail.adminToken);

  emitSession("scheduled", sessionId);

  await enqueueLifecycleJob("publish_brief", { sessionId, windowMinutes: 60, prevOutcome }, rail.adminToken);
  await waitForSessionState(date, subject.id, "collecting");
  emitSession("collecting", sessionId);
  console.log(`${tag} session ${sessionId}: brief published, window open`);

  // Enroll the no-show (own container + persistent keystore — the harness
  // never generates a key for it), then run present members, each in its OWN
  // container on the member-agent rail.
  const absent = MEMBERS.filter((m) => !m.present);
  await Promise.all(absent.map((m) => enroll(rail, m).catch((err) => {
    // A failed no-show enrollment must not sink the session: absence is
    // already this member's outcome either way. Logged, never fatal.
    console.log(`  ${m.memberId}: no-show enrollment failed (absent regardless) — ${err instanceof Error ? err.message : err}`);
  })));
  for (const m of absent) onProgress?.({ type: "member", memberId: m.memberId, stage: "absent" });
  const present = MEMBERS.filter((m) => m.present);
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
  // surfaced to the demo pane as a no-show ('absent') instead of a frozen row, so
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

  await enqueueLifecycleJob("close_window", { sessionId }, rail.adminToken);
  await waitForSessionState(date, subject.id, "window_closed");
  emitSession("window_closed", sessionId);

  await enqueueLifecycleJob("aggregate", { sessionId }, rail.adminToken);
  await waitForSessionState(date, subject.id, "aggregated");
  emitSession("aggregated", sessionId);

  await enqueueLifecycleJob("publish", { sessionId }, rail.adminToken);
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
  // once from this process's environment — the demo readiness gate hands this
  // entry point the stack's exact compose env.
  const rail = railFromEnv();

  // Setup (subject is a direct admin call; the regime snapshot is the
  // PRODUCER's own job — issue #361 Phase 4). NOTHING IS WIPED: the
  // session-wiping admin("reset") that used to open this entry point is gone
  // along with the endpoint behind it — an ephemeral database is deleted or
  // inspected whole, and no bring-up may TRUNCATE rows it did not create.
  await runRegimeClassify(today, rail);
  await admin("subject", SUBJECTS[0], rail.adminToken);

  // Session 1: today's subject
  const s1 = await runSession(SUBJECTS[0], 1, { rail });

  // ── New member added mid-run ──────────────────────────────────────────────
  // Demonstrates a member added AFTER session 1, participating in session 2
  // alongside the original roster (cross-session rotation awareness). Pushed
  // WITHOUT any host-held credential: eos enrolls on the container rail at its
  // first session — its key is generated inside its own container, the
  // harness registers only the PUBLIC key (the RM-operator half of seeding a
  // demo roster; the real §11 public apply→approve→claim flow is exercised by
  // the real-inference eval harness in scripts/lib/onboarding-eval.ts and the
  // no-inference proof in scripts/rmpc-release-e2e.ts).
  MEMBERS.push({ memberId: "eos", name: "Eos", lens: "newcomer", bias: 0.05, present: true });
  console.log(`\n  new member eos: joins the roster — enrolls in its own container at session 2`);

  // ── Cross-role denial assertions ─────────────────────────────────────────
  // Register a test member and verify identity-layer checks (always enforced
  // regardless of RM_ALLOW_INSECURE). The demo runs in insecure mode so role
  // gates on regime write (analyticsProvider) and admin lifecycle (privileged)
  // are open — the identity-layer submit checks are the universal enforcement.
  const testReg = await fetch(`${backendUrl()}${ROUTES.swarm.register}`, {
    method: "POST", headers: { "Content-Type": "application/json", ...getAdminHeaders() },
    body: JSON.stringify({ memberId: "cross-role-test", name: "Cross Role Test", publicKey: (await generateKeyPair()).publicKeyB64 }),
  }).then(responseJson);
  const testToken: string = testReg.token;

  // 5a. Unknown token → 401 with "unknown member token"
  const badTokenRes = await fetch(`${backendUrl()}${ROUTES.swarm.submit}`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer nonexistent" },
    body: JSON.stringify({ memberId: "cross-role-test", date: today, subjectId: SUBJECTS[0].id, nonce: crypto.randomUUID(), stance: "neutral", confidence: 0.5, signature: "bad" }),
  }).then(responseJson);
  console.log(`  cross-role: unknown token → ${badTokenRes.status} "${badTokenRes.error}"`);
  const badTokenOk = badTokenRes.status === 401 && String(badTokenRes.error).includes("unknown member token");
  if (!badTokenOk) throw new Error(`expected 401 unknown token, got ${badTokenRes.status}`);

  // 5b. Known token but wrong memberId in body → 403 with "token/member mismatch"
  const mismatchRes = await fetch(`${backendUrl()}${ROUTES.swarm.submit}`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${testToken}` },
    body: JSON.stringify({ memberId: "someone-else", date: today, subjectId: SUBJECTS[0].id, nonce: crypto.randomUUID(), stance: "neutral", confidence: 0.5, signature: "bad" }),
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

  // Session 2: a SECOND sitting, different subject (demonstrates rotation +
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
  await runSession(SUBJECTS[1], 2, { prevOutcome: s1.pub.session.synthesis, rail });

  // Verify list_sessions returns both sessions
  const all = await fetch(`${backendUrl()}${ROUTES.swarm.sessions}`).then((r) => r.json());
  console.log(`\nsessions listed: ${all.sessions.length} total (expected ≥2)`);

  console.log("\n=== done ===\n");
}

// Only run the full E2E flow (reset + 2 sessions + cross-role checks) when this
// file is the entry point (e.g. CI's `bun run session.ts`). Guarded so the
// standing demo can `import { runSession, admin, SUBJECTS }` WITHOUT triggering
// a reset that would wipe accumulating demo history. main()'s behaviour as an
// entry point is unchanged.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
