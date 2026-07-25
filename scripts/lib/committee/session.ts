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
import { runAgent, enroll } from "./agent.ts";
import type { ExistingCredentials, AgentStage } from "./agent.ts";
import { generateKeyPair } from "./crypto.ts";

const BACKEND = process.env.BACKEND_URL ?? "http://localhost:8787";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Whether this driver expects the backend's regime-write/admin gates to be OPEN
// (insecure) — used only to annotate the 5c/5d cross-role log lines truthfully.
// MUST mirror backend/src/config.ts allowInsecure's opt-IN polarity: insecure
// ONLY on an explicit RM_ALLOW_INSECURE === "1", and never when ANALYTICS_TOKEN
// is set (a configured analytics credential closes the regime-write gate in
// every env). SECURE BY DEFAULT — unset means "enforced". The demo harness
// (scripts/lib/demo-main.ts) passes RM_ALLOW_INSECURE=1 explicitly to this
// host-run driver, matching the api container docker-compose.demo.yml runs.
// Exported + env-injectable so the polarity is unit-testable hermetically
// (scripts/tests/committee-session-insecure.test.ts).
export function regimeWriteInsecure(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.RM_ALLOW_INSECURE === "1" && !env.ANALYTICS_TOKEN;
}

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

// ── Real-inference take invariants (issue #77) ──────────────────────────────
// Fingerprint of the deterministic buildMemo template: every templated REGIME
// section carries this exact clause. A real keyless opencode-zen take will not
// reproduce it verbatim, so under COMMITTEE_REAL_INFERENCE a body that still
// matches means the templated path leaked back into the real path — fail loudly.
const OLD_TEMPLATE_RE = /the spread, not the composite, is where the signal lives/i;
// Canonical stance vocabulary from the contract (finding 027) — never re-declared.
const VALID_STANCES = new Set<string>(STANCES);

// The authored-take structural assertions only apply to the REAL keyless
// opencode path. The hermetic per-PR default deliberately uses the deterministic
// buildMemo template (which DOES match OLD_TEMPLATE_RE), so the assertions run
// ONLY when COMMITTEE_REAL_INFERENCE=1 (the nightly committee-opencode job). This
// keeps the required per-PR e2e green and offline while still giving the nightly
// a loud, executed-in-CI check that every present member's take was really
// authored by a live model.
const REAL_INFERENCE = process.env.COMMITTEE_REAL_INFERENCE === "1";

// Post-publish structural assertions over every PRESENT member's authored take.
// Throws on any failure so the standalone `bun run session.ts` entrypoint exits
// non-zero (main() catches and process.exit(1)) — this is the required-CI signal
// that each take was authored by a real inference call, not a template.
function assertAuthoredTakes(tag: string, takes: any[]) {
  // Present-member takes are the ones that actually posted a body; absent
  // no-shows enrolled but never submitted, so they carry no body.
  const authored = (takes ?? []).filter(
    (t) => typeof t?.body === "string" && t.body.trim().length > 0,
  );
  if (authored.length === 0) {
    throw new Error(`${tag}: no authored takes to assert on (expected ≥1 present member)`);
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

const adminHeaders: Record<string, string> = process.env.ADMIN_TOKEN
  ? { "X-Admin-Token": process.env.ADMIN_TOKEN }
  : {};

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
  const r = await fetch(`${BACKEND}${routePath(ROUTES.committee.admin.action, { action })}`, {
    method: "POST", headers: { "Content-Type": "application/json", ...adminHeaders }, body: JSON.stringify(body),
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
// backendUrl override is for tests only (scripts/tests/e2e-active-member-count.test.ts)
// — it sidesteps the process-wide `process.env.BACKEND_URL` that e2e.ts's own
// module-level BACKEND constant captures once at import time, which is unsafe
// to mutate from a test file when other test files in the same run also touch
// it. Real callers never pass this; they always get the real BACKEND.
export async function activeMemberCount(backendUrl: string = BACKEND): Promise<number> {
  const r = await fetch(`${backendUrl}${ROUTES.committee.members}`)
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
    const r = await fetch(`${BACKEND}${routePath(ROUTES.committee.session, { date, subject })}`);
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

export async function runSession(date: string, subject: typeof SUBJECTS[0], sessionIndex: number, prevOutcome?: string, existingCredentials?: Map<string, ExistingCredentials>, onProgress?: SessionProgress) {
  const tag = `[session ${sessionIndex}: ${date}/${subject.id}]`;
  console.log(`\n${tag}`);
  // Session-lifecycle emitter — one call per real state transition below.
  const emitSession = (state: string, sessionId?: number) =>
    onProgress?.({ type: "session", state, sessionId, subject: subject.id, date });

  // Ensure subject exists; regime is already seeded by the first session.
  if (sessionIndex > 0) {
    await admin("subject", subject);
    await admin("regime", { asof: date });
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

  // Enroll the no-show, then run present agents (some may have externally-
  // provisioned credentials from the public apply → activate path).
  const absent = MEMBERS.filter((m) => !m.present);
  await Promise.all(absent.map((m) => enroll(m)));
  for (const m of absent) onProgress?.({ type: "member", memberId: m.memberId, stage: "absent" });
  const present = MEMBERS.filter((m) => m.present);
  // Settle (not all-or-nothing) so ONE member's throw/hang can't reject the whole
  // batch and leave the session un-published. The hermetic default stays fully
  // parallel (limit = Infinity) — identical behaviour/timing to the old
  // Promise.all for the required e2e. Only the REAL keyless-inference path throttles
  // to COMMITTEE_MAX_CONCURRENCY (default 4) to ease free-tier zen flakiness.
  const limit = REAL_INFERENCE ? Number(process.env.COMMITTEE_MAX_CONCURRENCY ?? 4) : Infinity;
  const settled = await mapSettledWithConcurrency(present, limit, (m) => runAgent(
    { ...m, date, subjectId: subject.id, sessionId },
    existingCredentials?.get(m.memberId),
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

  const pub = await fetch(`${BACKEND}${routePath(ROUTES.committee.session, { date, subject: subject.id })}`).then(responseJson);
  console.log(`${tag} published: state=${pub.session.state}, takes=${pub.takes.length}`);
  console.log(`${tag} synthesis: ${pub.session.synthesis}`);
  console.log(`${tag} absent: ${JSON.stringify(pub.takes.filter((t: any) => t.verified === null || t.verified === false).map((t: any) => t.memberId))}`);

  // Real-inference invariants (nightly only): every present member's published
  // take must be a genuine keyless opencode-zen authoring (non-template body,
  // REGIME/ALLOCATION/SUBJECT lead-ins, stance in the five-value set, confidence
  // in [0,1], distinct across members). Throws → exit 1 on any failure. Skipped
  // in the hermetic per-PR default (deterministic buildMemo template).
  if (REAL_INFERENCE) assertAuthoredTakes(tag, pub.takes);

  // Verify memos
  for (const r of results) {
    if (!r.memoUrl) { console.log(`  ${r.memberId}: no memo`); continue; }
    const memoRes = await fetch(`${BACKEND}${r.memoUrl}`);
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

  // Setup (direct admin calls — not lifecycle state machine)
  await admin("reset");
  await admin("regime", { asof: today });
  await admin("subject", SUBJECTS[0]);

  // Session 1: today's subject
  const s1 = await runSession(today, SUBJECTS[0], 1);

  // ── New member added mid-run ──────────────────────────────────────────────
  // Demonstrates a member added AFTER session 1, participating in session 2
  // alongside the original roster (cross-session rotation awareness). This is
  // deliberately the PRIVILEGED register shortcut, not the real §11 public
  // apply→approve→claim onboarding flow: that flow requires an `rmpc`-signed
  // application from the applicant's own agent (R3/R6) — the real-inference
  // eval harness (scripts/lib/onboarding-eval.ts, driven by
  // scripts/lib/demo-main.ts) and the no-inference proof
  // (scripts/rmpc-release-e2e.ts) exercise that path; this standalone e2e
  // script only needs a NEW member to seed session 2, the same non-onboarding
  // use `enroll()`/the cross-role-test registration below already make of it.
  const { publicKeyB64: eosPub, privateKey: eosPriv } = await generateKeyPair();
  const eosReg = await fetch(`${BACKEND}${ROUTES.committee.register}`, {
    method: "POST", headers: { "Content-Type": "application/json", ...adminHeaders },
    body: JSON.stringify({ memberId: "eos", name: "Eos", lens: "newcomer", publicKey: eosPub }),
  }).then(responseJson) as { token?: string };
  console.log(`\n  new member eos: register → token=${eosReg.token ? "✓" : "✗"}`);
  if (!eosReg.token) throw new Error(`register failed for eos: ${JSON.stringify(eosReg)}`);

  const eosCreds: ExistingCredentials = { token: eosReg.token, privateKey: eosPriv };
  const existingCreds = new Map<string, ExistingCredentials>([["eos", eosCreds]]);
  MEMBERS.push({ memberId: "eos", name: "Eos", lens: "newcomer", bias: 0.05, present: true });

  // ── Cross-role denial assertions ─────────────────────────────────────────
  // Register a test member and verify identity-layer checks (always enforced
  // regardless of RM_ALLOW_INSECURE). The demo runs in insecure mode so role
  // gates on regime write (analyticsProvider) and admin lifecycle (privileged)
  // are open — the identity-layer submit checks are the universal enforcement.
  const testReg = await fetch(`${BACKEND}${ROUTES.committee.register}`, {
    method: "POST", headers: { "Content-Type": "application/json", ...adminHeaders },
    body: JSON.stringify({ memberId: "cross-role-test", name: "Cross Role Test", publicKey: (await generateKeyPair()).publicKeyB64 }),
  }).then(responseJson);
  const testToken: string = testReg.token;

  // 5a. Unknown token → 401 with "unknown member token"
  const badTokenRes = await fetch(`${BACKEND}${ROUTES.committee.submit}`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer nonexistent" },
    body: JSON.stringify({ memberId: "cross-role-test", date: today, subjectId: SUBJECTS[0].id, nonce: crypto.randomUUID(), stance: "neutral", confidence: 0.5, signature: "bad" }),
  }).then(responseJson);
  console.log(`  cross-role: unknown token → ${badTokenRes.status} "${badTokenRes.error}"`);
  const badTokenOk = badTokenRes.status === 401 && String(badTokenRes.error).includes("unknown member token");
  if (!badTokenOk) throw new Error(`expected 401 unknown token, got ${badTokenRes.status}`);

  // 5b. Known token but wrong memberId in body → 403 with "token/member mismatch"
  const mismatchRes = await fetch(`${BACKEND}${ROUTES.committee.submit}`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${testToken}` },
    body: JSON.stringify({ memberId: "someone-else", date: today, subjectId: SUBJECTS[0].id, nonce: crypto.randomUUID(), stance: "neutral", confidence: 0.5, signature: "bad" }),
  }).then((r) => r.json());
  console.log(`  cross-role: token/member mismatch → ${mismatchRes.status} "${mismatchRes.error}"`);
  const mismatchOk = mismatchRes.status === 403 && String(mismatchRes.error).includes("token/member mismatch");
  if (!mismatchOk) throw new Error(`expected 403 token/member mismatch, got ${mismatchRes.status}`);

  // 5c. Known member token calling regime write (would be 403 with
  // ANALYTICS_TOKEN set; in insecure mode the gate is open so we document
  // the expected behaviour rather than assert a specific status).
  const regimeWriteRes = await fetch(`${BACKEND}${ROUTES.committee.regime}`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${testToken}` },
    body: JSON.stringify({ asof: today }),
  });
  const regimeGateOpen = regimeWriteInsecure();
  console.log(`  cross-role: member → regime write → ${regimeWriteRes.status}${regimeGateOpen ? " (insecure mode — gate open)" : " (enforced)"}`);

  // 5d. Known member token calling admin lifecycle (same insecure-mode caveat).
  const adminCloseRes = await fetch(`${BACKEND}${ROUTES.committee.admin.close}`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${testToken}` },
    body: JSON.stringify({ sessionId: -1 }),
  });
  console.log(`  cross-role: member → admin close → ${adminCloseRes.status}${regimeGateOpen ? " (insecure mode — gate open)" : " (enforced)"}`);

  // Session 2: next day, different subject (demonstrates rotation + cross-session
  // awareness). Eos (registered mid-run above) participates alongside the
  // original members.
  await runSession(tomorrow, SUBJECTS[1], 2, s1.pub.session.synthesis, existingCreds);

  // Verify list_sessions returns both sessions
  const all = await fetch(`${BACKEND}${ROUTES.committee.sessions}`).then((r) => r.json());
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
