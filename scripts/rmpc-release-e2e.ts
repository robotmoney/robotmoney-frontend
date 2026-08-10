// Proves docs/architecture.md §11's onboarding sequence end-to-end against a
// RELEASED rmpc binary — never built from source here (issue #104). This is
// the no-inference proof: no model, no OpenCode container — a script drives
// every step a real member agent's TOOLING must be able to do, using the
// SAME rmpc release binary and the SAME public REST API a real agent would use
// (D21 — the MCP transport is retired; see docs/decisions.md D21).
// robotmoney-core unit/integration tests prove rmpc's own crypto/CLI behavior
// in isolation; scripts/tests/integration/rmpc-canonical-apply.test.ts proves the JS
// canonical serializer and rmpc's signing are byte-exact against Stage 0's
// golden fixtures; THIS script is the only thing that proves a released binary
// drives the full chain against a LIVE robotmoney-frontend backend stack:
//   rmpc committee-identity create/show-public-key
//   → signed POST /api/swarm/apply (server mints the memberId, §11 R2/R6)
//   → GET /api/swarm/apply/:id (applied)
//   → POST /api/swarm/admin/activate (admin; still claimRequired, no
//     token minted here — §11 R7 approval, unchanged by this stage)
//   → GET /api/swarm/apply/:id (approved)
//   → POST token-claim/challenge → rmpc-signed POST token-claim (claim, §6/#205)
//   → GET /api/swarm/apply/:id (claimed)
//   → canonicalizeSubmission → rmpc sign → POST /api/swarm/submit
// then reads the result back and independently re-verifies the signature.
//
// Run standalone against a locally booted `bun run demo` stack (use the
// compose project printed by the demo):
//   BACKEND_URL=http://127.0.0.1:<web-port> DEMO_PROJECT=<project> bun run scripts/rmpc-release-e2e.ts
// (same BACKEND_URL convention as scripts/lib/swarm/session.ts — defaults
// to the standard demo port when unset.) In CI, scripts/lib/demo-main.ts runs
// this script against the SAME stack it just booted when RMPC_RELEASE_E2E=1 is
// set (see .github/workflows/rmpc-release-e2e-nightly.yml) — no parallel stack.
//
// Loud-skip-never (test-coverage-policy): every step below either gets a 2xx/ok
// response or calls fail()/throws, which exits the process non-zero. Nothing
// here silently skips a missing binary, a failed download, or a failed check.
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalizeApplication, canonicalizeClaimChallenge, canonicalizeSubmission, path as routePath, ROUTES } from "@robotmoney/contract";
import { fetchRmpc, runRmpcJson, RMPC_VERSION, resolveRmpcAsset, missingCommitteeIdentitySubcommands } from "./lib/rmpc-fetch.ts";
import { admin, enqueueLifecycleJob, runRegimeClassify, waitForSessionState } from "./lib/swarm/session.ts";
import { DEFAULT_COMPOSE_FILES } from "./stack/config.ts";

// Re-exported so this script's own boot logic can be tested in isolation.
// unit tests) can keep importing the pure asset/subcommand helpers from
// here; the implementations now live in scripts/lib/rmpc-fetch.ts (Stage 3),
// shared with scripts/tests/integration/rmpc-canonical-apply.test.ts.
export { resolveRmpcAsset, missingCommitteeIdentitySubcommands };

const BACKEND_URL = process.env.BACKEND_URL ?? "http://localhost:8787";
const AUTOMATION_TOKEN = process.env.AUTOMATION_TOKEN;
const adminHeaders: Record<string, string> = {
  ...(AUTOMATION_TOKEN ? { "X-Automation-Token": AUTOMATION_TOKEN } : {})
};

// Distinctly namespaced identity + subject (issue #104) so this driver never
// collides with the demo's own built-in onboarding loop / swarm roster /
// sessions (woon, mav, athena, boreas, …) when run against a standing local
// demo. The server mints the real memberId (§11 R2) — RUN_LABEL only seeds
// the human-readable name/contact/subject so runs are identifiable, never a
// requested id.
const RUN_ID = process.env.GITHUB_RUN_ID?.trim() || crypto.randomUUID().slice(0, 8);
const RUN_LABEL = `rmpc-e2e-${RUN_ID}`;
const SUBJECT_ID = "rmpc-release-e2e";
const TODAY = new Date().toISOString().slice(0, 10);

function producerRail() {
  const composeProject = process.env.DEMO_PROJECT?.trim();
  if (!composeProject) {
    throw new Error("DEMO_PROJECT is required to run the analytics producer against the target stack");
  }
  const configuredComposeFiles = process.env.COMPOSE_FILE?.split(":").filter(Boolean) ?? [];
  return {
    repoRoot: new URL("..", import.meta.url).pathname,
    composeProject,
    composeFiles: configuredComposeFiles.length > 0 ? configuredComposeFiles : [...DEFAULT_COMPOSE_FILES],
    composeSpawnEnv: { ...process.env } as Record<string, string>,
    backendUrl: BACKEND_URL,
  };
}

function fail(msg: string): never {
  console.error(`[rmpc-release-e2e] FAIL: ${msg}`);
  process.exit(1);
}
function log(msg: string): void {
  console.log(`[rmpc-release-e2e] ${msg}`);
}

async function readJson<T = any>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

async function main(): Promise<void> {
  const rmpcPath = await fetchRmpc(RMPC_VERSION);
  log(`rmpc ${RMPC_VERSION} ready (fetched or reused from cache) — committee-identity create/show-public-key/sign confirmed`);

  // ── rmpc committee-identity create + show-public-key ─────────────────────
  const workDir = mkdtempSync(join(tmpdir(), "rmpc-release-e2e-identity-"));
  const keystorePath = join(workDir, "identity.json");
  const passphrase = crypto.randomUUID();
  const rmpcEnv = { RMPC_COMMITTEE_IDENTITY_PASSPHRASE: passphrase };

  const created = runRmpcJson(rmpcPath, ["committee-identity", "--path", keystorePath, "create"], rmpcEnv);
  if (!created.ok || typeof created.public_key !== "string") {
    fail(`committee-identity create did not return a public key: ${JSON.stringify(created)}`);
  }
  const shown = runRmpcJson(rmpcPath, ["committee-identity", "--path", keystorePath, "show-public-key"], rmpcEnv);
  if (!shown.ok || shown.public_key !== created.public_key) {
    fail(`show-public-key (${shown.public_key}) does not match create's public key (${created.public_key})`);
  }
  const publicKeyB64: string = shown.public_key;
  log(`rmpc identity created — publicKey=${publicKeyB64}`);

  function signCanonical(canonical: string, label: string): string {
    const payloadFile = join(workDir, `payload-${label}.txt`);
    writeFileSync(payloadFile, canonical);
    const signed = runRmpcJson(rmpcPath, ["committee-identity", "--path", keystorePath, "sign", "--payload-file", payloadFile], rmpcEnv);
    if (!signed.ok || typeof signed.signature !== "string") fail(`committee-identity sign (${label}) did not return a signature: ${JSON.stringify(signed)}`);
    if (signed.public_key !== publicKeyB64) fail(`sign (${label})'s public_key (${signed.public_key}) does not match show-public-key's (${publicKeyB64})`);
    return signed.signature;
  }

  // ── POST /api/swarm/apply — signed, setup-gated (§11 R1-R6) ──────────
  // The server mints the memberId; the request carries no id at all. `contact`
  // is required (server-enforced, issue #205).
  const application = { name: "RMPC Release E2E", contact: `${RUN_LABEL}@example.test`, lens: "release-proof", publicKey: publicKeyB64 };
  const applySignature = signCanonical(canonicalizeApplication(application), "apply");
  const applyRes = await fetch(`${BACKEND_URL}${ROUTES.swarm.apply}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...application, signature: applySignature }),
  });
  const applyBody = await readJson(applyRes);
  if (applyRes.status !== 201 || !applyBody.ok || typeof applyBody.memberId !== "string") {
    fail(`POST ${ROUTES.swarm.apply} → ${applyRes.status}: ${JSON.stringify(applyBody)}`);
  }
  const memberId: string = applyBody.memberId;
  log(`applied — server-minted memberId=${memberId}`);

  const applyStatusPath = routePath(ROUTES.swarm.applyStatus, { id: memberId });
  const appliedStatus = await readJson(await fetch(`${BACKEND_URL}${applyStatusPath}`));
  if (appliedStatus.state !== "applied") fail(`GET ${applyStatusPath} → expected state 'applied', got: ${JSON.stringify(appliedStatus)}`);

  // ── POST /api/swarm/admin/activate — approval (§11 R7). Unchanged: does
  // NOT mint a token; still requires the claim flow below (issue #205). ──────
  const activateRes = await fetch(`${BACKEND_URL}${ROUTES.swarm.admin.activate}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...adminHeaders },
    body: JSON.stringify({ memberId }),
  });
  const activateBody = await readJson(activateRes);
  if (activateRes.status !== 200 || !activateBody.claimRequired) {
    fail(`POST ${ROUTES.swarm.admin.activate} → ${activateRes.status}: ${JSON.stringify(activateBody)}`);
  }
  log(`activated ${memberId} (claimRequired=true)`);

  const approvedStatus = await readJson(await fetch(`${BACKEND_URL}${applyStatusPath}`));
  if (approvedStatus.state !== "approved") fail(`GET ${applyStatusPath} → expected state 'approved', got: ${JSON.stringify(approvedStatus)}`);

  // ── Claim the bearer token by signing the server's challenge (§6, issue #205) ─
  const challengeRes = await fetch(`${BACKEND_URL}${ROUTES.swarm.claimChallenge}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ memberId }),
  });
  const challenge = await readJson<{ memberId: string; challenge: string; expiresAt: string }>(challengeRes);
  if (challengeRes.status !== 200 || !challenge.challenge) {
    fail(`POST ${ROUTES.swarm.claimChallenge} → ${challengeRes.status}: ${JSON.stringify(challenge)}`);
  }
  const claimSignature = signCanonical(canonicalizeClaimChallenge(challenge), "claim");
  const claimRes = await fetch(`${BACKEND_URL}${ROUTES.swarm.claimToken}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...challenge, signature: claimSignature }),
  });
  const claimBody = await readJson(claimRes);
  if (claimRes.status !== 200 || typeof claimBody.token !== "string") {
    fail(`POST ${ROUTES.swarm.claimToken} → ${claimRes.status}: ${JSON.stringify(claimBody)}`);
  }
  const memberToken: string = claimBody.token;
  log(`claimed bearer token for ${memberId}`);

  const claimedStatus = await readJson(await fetch(`${BACKEND_URL}${applyStatusPath}`));
  if (claimedStatus.state !== "claimed") fail(`GET ${applyStatusPath} → expected state 'claimed', got: ${JSON.stringify(claimedStatus)}`);
  if (JSON.stringify(claimedStatus).includes(application.contact) || JSON.stringify(claimedStatus).includes(publicKeyB64)) {
    fail(`GET ${applyStatusPath} leaked contact/publicKey: ${JSON.stringify(claimedStatus)}`);
  }
  log(`applyStatus reflects applied → approved → claimed for ${memberId}, no contact/publicKey echoed`);

  // ── Open a distinctly-namespaced session (reuses the swarm session
  // driver's proven job-queue lifecycle — the same path the required e2e +
  // nightly swarm sessions drive — instead of a second, unproven
  // direct-admin lifecycle) ──────────────────────────────────────────────────
  // admin()/waitForSessionState() read BACKEND_URL from env at module load;
  // this script is invoked with BACKEND_URL already set (demo-main.ts or the
  // operator), so the import at the top of this file resolves the right base.
  await admin("subject", { id: SUBJECT_ID, name: "RMPC Release E2E Subject" });
  // Idempotent, matches runSession()'s own pre-session regime seed — makes this
  // script self-sufficient even if run before any other regime seed exists.
  // The snapshot is the PRODUCER's own regime.classify job (issue #361 Phase
  // 4); the removed admin("regime") classifier path no longer exists.
  await runRegimeClassify(TODAY, producerRail());

  await enqueueLifecycleJob("open_session", { date: TODAY, subjectId: SUBJECT_ID });
  const scheduled = await waitForSessionState(TODAY, SUBJECT_ID, "scheduled");
  const sessionId = scheduled.session.id;

  await enqueueLifecycleJob("publish_brief", { sessionId, windowMinutes: 30 });
  await waitForSessionState(TODAY, SUBJECT_ID, "collecting");
  log(`session ${sessionId} open for ${TODAY}/${SUBJECT_ID}`);

  // ── canonicalizeSubmission (contract) + rmpc sign + POST submit (REST) ─────
  const draft = {
    memberId,
    date: TODAY,
    subjectId: SUBJECT_ID,
    nonce: crypto.randomUUID(),
    stance: "neutral",
    confidence: 0.5,
    body: "Released rmpc binary end-to-end proof (issue #104, docs/architecture.md §11).",
  };
  // The canonical bytes come from the shared @robotmoney/contract serializer —
  // the same bytes the backend verifier reconstructs and the retired MCP
  // get_signing_payload tool used to return. rmpc signs them; the signature is
  // independently re-verified below.
  const canonical = canonicalizeSubmission(draft);
  const signature = signCanonical(canonical, "recommendation");
  const submitRes = await fetch(`${BACKEND_URL}${ROUTES.swarm.submit}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${memberToken}` },
    body: JSON.stringify({ ...draft, signature }),
  });
  const submitBody = await readJson(submitRes);
  if (submitRes.status !== 200 || submitBody.verified !== true) {
    fail(`POST ${ROUTES.swarm.submit} → ${submitRes.status}: ${JSON.stringify(submitBody)}`);
  }
  log(`submit accepted + server-verified for ${memberId}`);

  // ── Independent readback + signature re-verification ───────────────────────
  const sessionPath = routePath(ROUTES.swarm.session, { date: TODAY, subject: SUBJECT_ID });
  const sessionRes = await fetch(`${BACKEND_URL}${sessionPath}`);
  const sessionBody = await readJson(sessionRes);
  if (sessionRes.status !== 200) fail(`GET ${sessionPath} → ${sessionRes.status}: ${JSON.stringify(sessionBody)}`);
  const take = (sessionBody.takes ?? []).find((t: any) => t.memberId === memberId);
  if (!take) fail(`no take for ${memberId} in GET ${sessionPath}: ${JSON.stringify(sessionBody.takes)}`);
  if (!take.verified) fail(`take for ${memberId} is not server-verified: ${JSON.stringify(take)}`);

  // Never trust the server's `verified` bit alone: independently re-verify the
  // EXACT signature rmpc produced against the EXACT canonical payload MCP
  // returned, using the same base64-raw-Ed25519 convention the backend verifier
  // uses (backend/src/lib/signing.ts).
  const pub = await crypto.subtle.importKey("raw", Uint8Array.from(Buffer.from(publicKeyB64, "base64")), { name: "Ed25519" }, false, ["verify"]);
  const verified = await crypto.subtle.verify(
    { name: "Ed25519" },
    pub,
    Uint8Array.from(Buffer.from(signature, "base64")),
    new TextEncoder().encode(canonical),
  );
  if (!verified) fail(`independent signature re-verification FAILED for ${memberId} against publicKey ${publicKeyB64}`);
  log(`independent signature re-verification passed for ${memberId}`);

  rmSync(workDir, { recursive: true, force: true });
  log(`PASS — released rmpc ${RMPC_VERSION} completed the full §11 onboarding chain (memberId=${memberId}, subject=${SUBJECT_ID}, date=${TODAY})`);
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(`[rmpc-release-e2e] FAIL: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    process.exit(1);
  });
}
