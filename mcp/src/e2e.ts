// MCP-path end-to-end demo. Drives one or more full committee sessions where N
// independent agents participate THROUGH the MCP server (each its own key + token
// + MCP session). One member per session is a deliberate no-show. The session
// lifecycle is driven through the worker job queue (admin enqueue-job → worker
// handler → domain) so the demo exercises the real FOR UPDATE SKIP LOCKED claim
// loop. Multi-session: the second session's brief references the first session's
// outcome, demonstrating rotation awareness.
import { runAgent, enroll, stanceFor, textOf, ExistingCredentials } from "./agent.ts";
import { generateKeyPair, sign } from "./crypto.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ClientCredentialsProvider } from "@modelcontextprotocol/sdk/client/auth-extensions.js";

const BACKEND = process.env.BACKEND_URL ?? "http://localhost:8787";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const MEMBERS = [
  { memberId: "athena", name: "Athena", lens: "macro risk", bias: -0.1, present: true },
  { memberId: "boreas", name: "Boreas", lens: "on-chain flows", bias: 0.0, present: true },
  { memberId: "cygnus", name: "Cygnus", lens: "momentum", bias: 0.15, present: true },
  { memberId: "draco", name: "Draco", lens: "contrarian", bias: 0.0, present: false }, // absent
];
export const SUBJECTS = [
  { id: "woon", name: "Woon Treasury" },
  { id: "mav", name: "Mav Holdings" },
];

const adminHeaders = process.env.ADMIN_TOKEN ? { "X-Admin-Token": process.env.ADMIN_TOKEN } : {};

export async function admin(action: string, body: unknown = {}) {
  const r = await fetch(`${BACKEND}/api/committee/admin/${action}`, {
    method: "POST", headers: { "Content-Type": "application/json", ...adminHeaders }, body: JSON.stringify(body),
  });
  return r.json();
}

async function waitForSessionState(date: string, subject: string, expectedState: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await fetch(`${BACKEND}/api/committee/sessions/${date}/${subject}`);
    if (r.ok) {
      const data = await r.json();
      if (data.session?.state === expectedState) return data;
    }
    await sleep(500);
  }
  throw new Error(`session ${date}/${subject} did not reach '${expectedState}' within ${timeoutMs}ms`);
}

async function enqueueLifecycleJob(action: string, payload: unknown = {}) {
  const result = await admin("enqueue-job", { action, ...payload });
  console.log(`  enqueued ${result.kind} (job #${result.jobId})`);
  return result;
}

export async function runSession(date: string, subject: typeof SUBJECTS[0], sessionIndex: number, prevOutcome?: string, existingCredentials?: Map<string, ExistingCredentials>) {
  const tag = `[session ${sessionIndex}: ${date}/${subject.id}]`;
  console.log(`\n${tag}`);

  // Ensure subject exists; regime is already seeded by the first session.
  if (sessionIndex > 0) {
    await admin("subject", subject);
    await admin("regime", { asof: date });
  }

  // Lifecycle through worker job queue.
  await enqueueLifecycleJob("open_session", { date, subjectId: subject.id });
  const sd = await waitForSessionState(date, subject.id, "scheduled");
  const sessionId = sd.session.id;

  await enqueueLifecycleJob("publish_brief", { sessionId, windowMinutes: 60, prevOutcome });
  await waitForSessionState(date, subject.id, "collecting");
  console.log(`${tag} session ${sessionId}: brief published, window open`);

  // Enroll the no-show, then run present agents (some may have externally-
  // provisioned credentials from the public apply → activate path).
  await Promise.all(MEMBERS.filter((m) => !m.present).map((m) => enroll(m)));
  const present = MEMBERS.filter((m) => m.present);
  const results = await Promise.all(
    present.map((m) => runAgent({ ...m, date, subjectId: subject.id, sessionId }, existingCredentials?.get(m.memberId))),
  );
  for (const r of results) {
    const ok = r.result?.verified ? "✓verified" : JSON.stringify(r.result);
    const memo = r.memoUrl ? ` memo=${r.memoUrl}` : "";
    console.log(`  ${r.memberId}: ${r.stance} c=${r.confidence} → ${ok}${memo}`);
  }

  await enqueueLifecycleJob("close_window", { sessionId });
  await waitForSessionState(date, subject.id, "window_closed");

  await enqueueLifecycleJob("aggregate", { sessionId });
  await waitForSessionState(date, subject.id, "aggregated");

  await enqueueLifecycleJob("publish", { sessionId });
  await waitForSessionState(date, subject.id, "published");

  const pub = await fetch(`${BACKEND}/api/committee/sessions/${date}/${subject.id}`).then((r) => r.json());
  console.log(`${tag} published: state=${pub.session.state}, takes=${pub.takes.length}`);
  console.log(`${tag} synthesis: ${pub.session.synthesis}`);
  console.log(`${tag} absent: ${JSON.stringify(pub.takes.filter((t: any) => t.verified === null || t.verified === false).map((t: any) => t.member_id))}`);

  // Verify memos
  for (const r of results) {
    if (!r.memoUrl) { console.log(`  ${r.memberId}: no memo`); continue; }
    const memoRes = await fetch(`${BACKEND}${r.memoUrl}`);
    if (memoRes.ok) {
      const memo = await memoRes.json();
      console.log(`  ${r.memberId}: memo verified (id=${memo.id})`);
      const take = pub.takes.find((t: any) => t.member_id === r.memberId);
      if (take?.memo_url === r.memoUrl) console.log(`  ${r.memberId}: memo_url in submission ✓`);
    } else {
      console.log(`  ${r.memberId}: memo fetch failed (${memoRes.status})`);
    }
  }

  return { sessionId, results, pub };
}

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 86400_000).toISOString().slice(0, 10);
  console.log(`\n=== Committee MCP E2E (${today} → ${tomorrow}) ===`);

  // Setup (direct admin calls — not lifecycle state machine)
  await admin("reset");
  await admin("regime", { asof: today });
  await admin("subject", SUBJECTS[0]);

  // ── OAuth 2.1 assertions ──────────────────────────────────────────────
  const MCP_BASE = (process.env.MCP_URL ?? "http://localhost:8788/mcp").replace(/\/mcp\/?$/, "");
  // 1. Metadata endpoint
  const metaRes = await fetch(`${MCP_BASE}/.well-known/oauth-authorization-server`);
  const meta = metaRes.ok ? await metaRes.json() : {};
  console.log(`  OAuth metadata: token_endpoint=${meta.token_endpoint ? "✓" : "✗"}`);

  // 2. Register a member and exchange credentials for an OAuth access token
  const oauthMember = { memberId: "oauth-test", name: "OAuth Test", lens: "oauth-demo" };
  const oauthReg = await fetch(`${BACKEND}/api/committee/register`, {
    method: "POST", headers: { "Content-Type": "application/json", ...adminHeaders },
    body: JSON.stringify({ ...oauthMember, publicKey: (await generateKeyPair()).publicKeyB64 }),
  }).then((r) => r.json());
  const oauthToken = await fetch(`${MCP_BASE}/mcp/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: oauthMember.memberId,
      client_secret: oauthReg.token,
    }),
  }).then((r) => r.json());
  console.log(`  OAuth token exchange: access_token=${oauthToken.access_token ? "✓" : "✗"} expires_in=${oauthToken.expires_in}`);

  // 3. Invalid credentials are rejected
  const badToken = await fetch(`${MCP_BASE}/mcp/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: "nonexistent", client_secret: "bad" }),
  });
  console.log(`  OAuth invalid credentials: ${badToken.status === 401 ? "✓ rejected" : "✗ allowed"}`);

  // 4. Revoke the access token
  if (oauthToken.access_token) {
    const revokeRes = await fetch(`${MCP_BASE}/mcp/oauth/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: oauthToken.access_token }),
    });
    console.log(`  OAuth token revocation: ${revokeRes.ok ? "✓" : "✗"}`);
  }

  // Session 1: today's subject
  const s1 = await runSession(today, SUBJECTS[0], 1);

  // ── New agent onboarded from scratch ─────────────────────────────────────
  // Demonstrates the public apply → admin activate → MCP OAuth → submit flow.
  // The agent (eos) will participate in session 2 alongside existing members.
  const eosDate = today;
  const { publicKeyB64: eosPub, privateKey: eosPriv } = await generateKeyPair();

  // 4a. Public apply (no auth required) — member is recorded as 'applied'
  const applyRes = await fetch(`${BACKEND}/api/committee/apply`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ memberId: "eos", name: "Eos", lens: "newcomer", publicKey: eosPub }),
  }).then((r) => r.json());
  console.log(`\n  onboard eos: apply → status=${applyRes.status} memberStatus=${applyRes.memberStatus}`);
  if (applyRes.status !== 201) throw new Error(`apply failed: ${JSON.stringify(applyRes)}`);

  // 4b. Admin activates — flips applied→active, mints bearer token
  const activateRes = await fetch(`${BACKEND}/api/committee/admin/activate`, {
    method: "POST", headers: { "Content-Type": "application/json", ...adminHeaders },
    body: JSON.stringify({ memberId: "eos" }),
  }).then((r) => r.json());
  console.log(`  onboard eos: activate → status=${activateRes.status} token=${activateRes.token ? "✓" : "✗"}`);
  if (activateRes.status !== 200 || !activateRes.token) throw new Error(`activate failed: ${JSON.stringify(activateRes)}`);

  // 4c. Eos is now a full committee member. Add to the roster for session 2.
  const eosCreds: ExistingCredentials = { token: activateRes.token, privateKey: eosPriv };
  const existingCreds = new Map<string, ExistingCredentials>([["eos", eosCreds]]);
  MEMBERS.push({ memberId: "eos", name: "Eos", lens: "newcomer", bias: 0.05, present: true });

  // ── Cross-role denial assertions ─────────────────────────────────────────
  // Register a test member and verify identity-layer checks (always enforced
  // regardless of RM_ALLOW_INSECURE). The demo runs in insecure mode so role
  // gates on regime write (analyticsProvider) and admin lifecycle (privileged)
  // are open — the identity-layer submit checks are the universal enforcement.
  const testReg = await fetch(`${BACKEND}/api/committee/register`, {
    method: "POST", headers: { "Content-Type": "application/json", ...adminHeaders },
    body: JSON.stringify({ memberId: "cross-role-test", name: "Cross Role Test", publicKey: (await generateKeyPair()).publicKeyB64 }),
  }).then((r) => r.json());
  const testToken: string = testReg.token;

  // 5a. Unknown token → 401 with "unknown member token"
  const badTokenRes = await fetch(`${BACKEND}/api/committee/submit`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer nonexistent" },
    body: JSON.stringify({ memberId: "cross-role-test", date: today, subjectId: SUBJECTS[0].id, nonce: crypto.randomUUID(), stance: "neutral", confidence: 0.5, signature: "bad" }),
  }).then((r) => r.json());
  console.log(`  cross-role: unknown token → ${badTokenRes.status} "${badTokenRes.error}"`);
  const badTokenOk = badTokenRes.status === 401 && String(badTokenRes.error).includes("unknown member token");
  if (!badTokenOk) throw new Error(`expected 401 unknown token, got ${badTokenRes.status}`);

  // 5b. Known token but wrong memberId in body → 403 with "token/member mismatch"
  const mismatchRes = await fetch(`${BACKEND}/api/committee/submit`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${testToken}` },
    body: JSON.stringify({ memberId: "someone-else", date: today, subjectId: SUBJECTS[0].id, nonce: crypto.randomUUID(), stance: "neutral", confidence: 0.5, signature: "bad" }),
  }).then((r) => r.json());
  console.log(`  cross-role: token/member mismatch → ${mismatchRes.status} "${mismatchRes.error}"`);
  const mismatchOk = mismatchRes.status === 403 && String(mismatchRes.error).includes("token/member mismatch");
  if (!mismatchOk) throw new Error(`expected 403 token/member mismatch, got ${mismatchRes.status}`);

  // 5c. Known member token calling regime write (would be 403 with
  // ANALYTICS_TOKEN set; in insecure mode the gate is open so we document
  // the expected behaviour rather than assert a specific status).
  const regimeWriteRes = await fetch(`${BACKEND}/api/committee/regime`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${testToken}` },
    body: JSON.stringify({ asof: today }),
  });
  const regimeWriteInsecure = process.env.RM_ALLOW_INSECURE !== "0" && !process.env.ANALYTICS_TOKEN;
  console.log(`  cross-role: member → regime write → ${regimeWriteRes.status}${regimeWriteInsecure ? " (insecure mode — gate open)" : " (enforced)"}`);

  // 5d. Known member token calling admin lifecycle (same insecure-mode caveat).
  const adminCloseRes = await fetch(`${BACKEND}/api/committee/admin/close`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${testToken}` },
    body: JSON.stringify({ sessionId: -1 }),
  });
  console.log(`  cross-role: member → admin close → ${adminCloseRes.status}${regimeWriteInsecure ? " (insecure mode — gate open)" : " (enforced)"}`);

  // Session 2: next day, different subject (demonstrates rotation + cross-session
  // awareness). Eos (onboarded via public apply→activate) participates alongside
  // the original members, proving the from-scratch onboarding flow.
  const s2 = await runSession(tomorrow, SUBJECTS[1], 2, s1.pub.session.synthesis, existingCreds);

  // Verify list_sessions returns both sessions
  const all = await fetch(`${BACKEND}/api/committee/sessions`).then((r) => r.json());
  console.log(`\nsessions listed: ${all.sessions.length} total (expected ≥2)`);

  console.log("\n=== done ===\n");
}

// Only run the full E2E flow (reset + OAuth assertions + 2 sessions) when this
// file is the entry point (e.g. CI's `bun run src/e2e.ts`). Guarded so the
// standing demo can `import { runSession, admin, SUBJECTS }` WITHOUT triggering
// a reset that would wipe accumulating demo history. main()'s behaviour as an
// entry point is unchanged.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
