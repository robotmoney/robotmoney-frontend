// REST-path end-to-end committee demo (D21 — the MCP transport is retired; see
// docs/decisions.md D21). Drives one or more full committee sessions where N
// independent agents participate over the committee REST API (each its own key
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

// Run `fn` over `items` with at most `limit` invocations in flight, returning
// results in INPUT order as PromiseSettledResult — like Promise.allSettled but
// bounded. A rejecting item never sinks the batch (that is the whole point: one
// hung/failing committee member must NOT freeze the whole session). `limit <= 0`
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
// back into a live committee session — fail loudly.
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

// Deterministic attendance comes from the SHARED demo no-show rule in
// @robotmoney/contract (contract/src/committee.js) — the backend demo e2e
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
// (COMMITTEE_ROSTER_CAP) — the mirror this module used to carry is gone;
// consumers (scripts/lib/demo-main.ts, backend domain) import the contract.

export function getAdminHeaders(): Record<string, string> {
  return process.env.ADMIN_TOKEN ? { "X-Admin-Token": process.env.ADMIN_TOKEN } : {};
}

async function responseJson<T = any>(response: Response): Promise<T> {
  return await response.json() as T;
}

// Optional, additive progress stream for runSession. Emits real session-lifecycle
// transitions and per-member pipeline stages so a UI can render live committee
// state. Default undefined ⇒ zero behaviour change (standalone main() never passes
// it). Members that are deliberate no-shows surface as stage 'absent'.
export type SessionEvent =
  | { type: "session"; state: string; sessionId?: number; subject: string; date: string }
  | { type: "member"; memberId: string; stage: AgentStage | "absent"; stance?: string; confidence?: number };
export type SessionProgress = (ev: SessionEvent) => void;

export async function admin(action: string, body: unknown = {}) {
  const r = await fetch(`${backendUrl()}${routePath(ROUTES.committee.admin.action, { action })}`, {
    method: "POST", headers: { "Content-Type": "application/json", ...getAdminHeaders() }, body: JSON.stringify(body),
  });
  return responseJson(r);
}

// Active committee roster size, read from the backend — the gate the standing
// demo checks against COMMITTEE_ROSTER_CAP before admitting a newcomer. A read
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
  const r = await fetch(`${targetUrl}${ROUTES.committee.members}`)
    .then(responseJson)
    .catch((err) => {
      console.error(`[e2e] activeMemberCount: GET ${ROUTES.committee.members} failed — assuming roster is FULL, not empty: ${err instanceof Error ? err.message : err}`);
      return null;
    }) as { members?: { id: string }[] } | null;
  if (r === null) return Number.POSITIVE_INFINITY;
  return Array.isArray(r.members) ? r.members.length : Number.POSITIVE_INFINITY;
}

// Exported (in addition to standalone-main use) so scripts/rmpc-release-e2e.ts
// (issue #104) can drive the SAME proven job-queue session lifecycle this file's
// own runSession() uses, instead of hand-rolling a second one.
export async function waitForSessionState(date: string, subject: string, expectedState: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await fetch(`${backendUrl()}${routePath(ROUTES.committee.session, { date, subject })}`);
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

export async function enqueueLifecycleJob(action: string, payload: Record<string, unknown> = {}) {
  const result = await admin("enqueue-job", { action, ...payload });
  console.log(`  enqueued ${result.kind} (job #${result.jobId})`);
  return result;
}

// Ask the PRODUCER to land a regime snapshot for `asof`, then wait until it is
// served (issue #361 Phase 4). The former `admin("regime")` action ran the
// classifier INSIDE the api process under the admin token; that path is
// removed — the platform now only SCHEDULES the producer's own `regime.classify`
// job, which the worker-analytics lane computes and submits back through the
// authenticated analytics boundary under the provider credential. Waiting on
// the PUBLIC read keeps this a black-box observation: the snapshot is "landed"
// when the site would serve it.
export async function runRegimeClassify(asof: string, timeoutMs = 300_000) {
  await enqueueLifecycleJob("regime_classify", { asof });
  const deadline = Date.now() + timeoutMs;
  let last: any = null;
  while (Date.now() < deadline) {
    last = await fetch(`${backendUrl()}${ROUTES.dashboards.regimeSnapshots}?range=1`)
      .then(responseJson)
      .catch(() => null);
    const servedAsof: string | null = last?.staleness?.asof ?? null;
    if (servedAsof && servedAsof >= asof) return last;
    await sleep(2000);
  }
  throw new Error(
    `regime.classify for ${asof} did not land within ${timeoutMs}ms ` +
      `(served asof: ${last?.staleness?.asof ?? "none"}) — is the worker-analytics lane running?`,
  );
}

// The member-container rail (issue #361 Phase 2): every present member runs in
// its OWN container via the shared runMemberAgent() primitive; this driver
// only drives the session lifecycle and observes. `rail` carries the compose
// coordinates of the already-running stack; when omitted it is resolved from
// this process's environment (the standalone CI entry point receives the
// demo's exact compose env).
export async function runSession(
  date: string,
  subject: typeof SUBJECTS[0],
  sessionIndex: number,
  opts?: { prevOutcome?: string; rail?: SessionRail; onProgress?: SessionProgress },
) {
  const prevOutcome = opts?.prevOutcome;
  const onProgress = opts?.onProgress;
  const rail = opts?.rail ?? railFromEnv();
  const tag = `[session ${sessionIndex}: ${date}/${subject.id}]`;
  console.log(`\n${tag}`);
  // Session-lifecycle emitter — one call per real state transition below.
  const emitSession = (state: string, sessionId?: number) =>
    onProgress?.({ type: "session", state, sessionId, subject: subject.id, date });

  // Ensure subject exists; regime is already seeded by the first session.
  if (sessionIndex > 0) {
    await admin("subject", subject);
    await runRegimeClassify(date);
  }

  // Seed the reference-shaped subject fixtures (subject row + subject snapshot the
  // portfolio donut reads + trailing regime history for the sparkline) BEFORE the
  // session opens, so the subject/snapshot routes return data for the session date
  // and the memo page renders full charts. Idempotent; dated at the session date.
  await admin("subject_fixtures", { id: subject.id, name: subject.name, date });

  // Lifecycle through worker job queue.
  await enqueueLifecycleJob("open_session", { date, subjectId: subject.id });
  const sd = await waitForSessionState(date, subject.id, "scheduled");
  const sessionId = sd.session.id;
  emitSession("scheduled", sessionId);

  await enqueueLifecycleJob("publish_brief", { sessionId, windowMinutes: 60, prevOutcome });
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
  // COMMITTEE_MAX_CONCURRENCY member containers in flight. The unconditional
  // post-publish assertion below still fails the run if any present member did
  // not produce a live-authored take.
  const limit = Number(process.env.COMMITTEE_MAX_CONCURRENCY ?? 4);
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

  await enqueueLifecycleJob("close_window", { sessionId });
  await waitForSessionState(date, subject.id, "window_closed");
  emitSession("window_closed", sessionId);

  await enqueueLifecycleJob("aggregate", { sessionId });
  await waitForSessionState(date, subject.id, "aggregated");
  emitSession("aggregated", sessionId);

  await enqueueLifecycleJob("publish", { sessionId });
  await waitForSessionState(date, subject.id, "published");
  emitSession("published", sessionId);

  const pub = await fetch(`${backendUrl()}${routePath(ROUTES.committee.session, { date, subject: subject.id })}`).then(responseJson);
  console.log(`${tag} published: state=${pub.session.state}, takes=${pub.takes.length}`);
  console.log(`${tag} synthesis: ${pub.session.synthesis}`);
  console.log(`${tag} absent: ${JSON.stringify(pub.takes.filter((t: any) => t.verified === null || t.verified === false).map((t: any) => t.memberId))}`);

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
  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 86400_000).toISOString().slice(0, 10);
  console.log(`\n=== Committee REST E2E (${today} → ${tomorrow}) ===`);

  // The member-container rail for this stack (issue #361 Phase 2), resolved
  // once from this process's environment — the demo readiness gate hands this
  // entry point the stack's exact compose env.
  const rail = railFromEnv();

  // Setup (reset + subject are direct admin calls; the regime snapshot is the
  // PRODUCER's own job — issue #361 Phase 4)
  await admin("reset");
  await runRegimeClassify(today);
  await admin("subject", SUBJECTS[0]);

  // Session 1: today's subject
  const s1 = await runSession(today, SUBJECTS[0], 1, { rail });

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
  const testReg = await fetch(`${backendUrl()}${ROUTES.committee.register}`, {
    method: "POST", headers: { "Content-Type": "application/json", ...getAdminHeaders() },
    body: JSON.stringify({ memberId: "cross-role-test", name: "Cross Role Test", publicKey: (await generateKeyPair()).publicKeyB64 }),
  }).then(responseJson);
  const testToken: string = testReg.token;

  // 5a. Unknown token → 401 with "unknown member token"
  const badTokenRes = await fetch(`${backendUrl()}${ROUTES.committee.submit}`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer nonexistent" },
    body: JSON.stringify({ memberId: "cross-role-test", date: today, subjectId: SUBJECTS[0].id, nonce: crypto.randomUUID(), stance: "neutral", confidence: 0.5, signature: "bad" }),
  }).then(responseJson);
  console.log(`  cross-role: unknown token → ${badTokenRes.status} "${badTokenRes.error}"`);
  const badTokenOk = badTokenRes.status === 401 && String(badTokenRes.error).includes("unknown member token");
  if (!badTokenOk) throw new Error(`expected 401 unknown token, got ${badTokenRes.status}`);

  // 5b. Known token but wrong memberId in body → 403 with "token/member mismatch"
  const mismatchRes = await fetch(`${backendUrl()}${ROUTES.committee.submit}`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${testToken}` },
    body: JSON.stringify({ memberId: "someone-else", date: today, subjectId: SUBJECTS[0].id, nonce: crypto.randomUUID(), stance: "neutral", confidence: 0.5, signature: "bad" }),
  }).then((r) => r.json());
  console.log(`  cross-role: token/member mismatch → ${mismatchRes.status} "${mismatchRes.error}"`);
  const mismatchOk = mismatchRes.status === 403 && String(mismatchRes.error).includes("token/member mismatch");
  if (!mismatchOk) throw new Error(`expected 403 token/member mismatch, got ${mismatchRes.status}`);

  // 5c. Known member token calling regime write (would be 403 with
  // ANALYTICS_TOKEN set; in insecure mode the gate is open so we document
  // the expected behaviour rather than assert a specific status).
  const regimeWriteRes = await fetch(`${backendUrl()}${ROUTES.committee.regime}`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${testToken}` },
    body: JSON.stringify({ asof: today }),
  });
  const regimeGateOpen = regimeWriteInsecure();
  console.log(`  cross-role: member → regime write → ${regimeWriteRes.status}${regimeGateOpen ? " (insecure mode — gate open)" : " (enforced)"}`);

  // 5d. Known member token calling admin lifecycle (same insecure-mode caveat).
  const adminCloseRes = await fetch(`${backendUrl()}${ROUTES.committee.admin.close}`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${testToken}` },
    body: JSON.stringify({ sessionId: -1 }),
  });
  console.log(`  cross-role: member → admin close → ${adminCloseRes.status}${regimeGateOpen ? " (insecure mode — gate open)" : " (enforced)"}`);

  // Session 2: next day, different subject (demonstrates rotation + cross-session
  // awareness). Eos (added to the roster mid-run above) enrolls and
  // participates in its own container alongside the original members.
  await runSession(tomorrow, SUBJECTS[1], 2, { prevOutcome: s1.pub.session.synthesis, rail });

  // Verify list_sessions returns both sessions
  const all = await fetch(`${backendUrl()}${ROUTES.committee.sessions}`).then((r) => r.json());
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
