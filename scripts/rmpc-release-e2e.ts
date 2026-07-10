// Proves README.md's "Attach a prospective agent" flow (~L87-125) end-to-end
// against a RELEASED rmpc binary — never built from source here (issue #104).
// robotmoney-core unit/integration-tests rmpc's own crypto/CLI behavior in
// isolation; this script is the ONLY thing that proves a released binary
// actually drives identity create → show-public-key → POST /api/committee/apply
// → POST /api/committee/admin/activate → MCP OAuth client_credentials →
// get_signing_payload → rmpc committee-identity sign → submit_recommendation
// against a LIVE robotmoney-frontend backend+MCP stack, then reads the result
// back and independently re-verifies the signature.
//
// Run standalone against a locally booted `bun run demo` stack:
//   BACKEND_URL=http://127.0.0.1:<web-port> MCP_URL=http://127.0.0.1:<mcp-port>/mcp \
//     bun run scripts/rmpc-release-e2e.ts
// (same BACKEND_URL/MCP_URL convention as mcp/src/e2e.ts — defaults to the
// standard demo ports when unset.) In CI, scripts/lib/demo-main.ts runs this
// script against the SAME stack it just booted when RMPC_RELEASE_E2E=1 is set
// (see .github/workflows/rmpc-release-e2e-nightly.yml) — no parallel stack.
//
// Loud-skip-never (test-coverage-policy): every step below either gets a 2xx/ok
// response or calls fail()/throws, which exits the process non-zero. Nothing
// here silently skips a missing binary, a failed download, or a failed check.
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..");

// Pinned release: robotmoney-core v0.3.2 is the first release whose rmpc binary
// ships a working `committee-identity create/show-public-key/sign` (implements
// robotmoney-core issue #1111/PR #1112; verified locally 2026-07-10 against
// rmpc-v0.3.2-linux-amd64.tar.gz's --help before this driver was written). Bump
// this constant (and re-run this script locally to confirm
// `rmpc committee-identity --help` still exposes those three subcommands) when
// adopting a newer rmpc release — no auto-discovery mechanism is needed for a
// once-in-a-while manual bump.
const RMPC_VERSION = process.env.RMPC_VERSION?.trim() || "v0.3.2";
const RMPC_REPO = "robotmoney/robotmoney-core";

const BACKEND_URL = process.env.BACKEND_URL ?? "http://localhost:8787";
const MCP_URL = process.env.MCP_URL ?? "http://localhost:8788/mcp";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const adminHeaders: Record<string, string> = ADMIN_TOKEN ? { "X-Admin-Token": ADMIN_TOKEN } : {};

// Distinctly namespaced identity + subject (issue #104) so this driver never
// collides with the demo's own built-in onboarding loop / committee roster /
// sessions (woon, mav, athena, boreas, …) when run against a standing local demo.
const RUN_ID = process.env.GITHUB_RUN_ID?.trim() || crypto.randomUUID().slice(0, 8);
const MEMBER_ID = `rmpc-e2e-${RUN_ID}`;
const SUBJECT_ID = "rmpc-release-e2e";
const TODAY = new Date().toISOString().slice(0, 10);

function fail(msg: string): never {
  console.error(`[rmpc-release-e2e] FAIL: ${msg}`);
  process.exit(1);
}
function log(msg: string): void {
  console.log(`[rmpc-release-e2e] ${msg}`);
}

// ── Pure helpers (unit-tested in scripts/tests/rmpc-release-e2e.test.ts) ──────

export interface RmpcAsset {
  os: string;
  arch: string;
  asset: string;
  url: string;
}

// Maps a Node/Bun `process.platform`/`process.arch` pair to the matching
// rmpc-core release asset name + download URL. Throws on an unsupported
// combination (robotmoney-core ships linux/macos amd64/arm64 only).
export function resolveRmpcAsset(version: string, platform: string, arch: string, repo = RMPC_REPO): RmpcAsset {
  const os = platform === "linux" ? "linux" : platform === "darwin" ? "macos" : null;
  const archName = arch === "x64" ? "amd64" : arch === "arm64" ? "arm64" : null;
  if (!os || !archName) {
    throw new Error(`unsupported runner platform ${platform}/${arch} — robotmoney-core ${version} ships linux/macos amd64/arm64 only`);
  }
  const asset = `rmpc-${version}-${os}-${archName}.tar.gz`;
  return { os, arch: archName, asset, url: `https://github.com/${repo}/releases/download/${version}/${asset}` };
}

// Every committee-identity subcommand this flow depends on, per `--help` text.
// Returns the ones missing (empty ⇒ all present).
export function missingCommitteeIdentitySubcommands(helpText: string): string[] {
  return ["create", "show-public-key", "sign"].filter((sub) => !new RegExp(`\\b${sub}\\b`).test(helpText));
}

// ── Download + verify the released binary ──────────────────────────────────

async function downloadRmpc(): Promise<string> {
  const { asset, url } = resolveRmpcAsset(RMPC_VERSION, process.platform, process.arch);
  log(`downloading rmpc release asset: ${url}`);
  const res = await fetch(url);
  if (!res.ok) {
    fail(
      `rmpc release asset download failed: GET ${url} → ${res.status} ${res.statusText} ` +
        `(pinned RMPC_VERSION=${RMPC_VERSION} may not exist, or this platform's asset was renamed — ` +
        `check https://github.com/${RMPC_REPO}/releases/tag/${RMPC_VERSION})`,
    );
  }
  const dir = mkdtempSync(join(tmpdir(), "rmpc-release-e2e-"));
  const tarPath = join(dir, asset);
  writeFileSync(tarPath, new Uint8Array(await res.arrayBuffer()));
  const extract = Bun.spawnSync(["tar", "-xzf", tarPath, "-C", dir], { stdout: "inherit", stderr: "inherit" });
  if (extract.exitCode !== 0) fail(`extracting ${asset} failed (tar exit ${extract.exitCode})`);
  const binPath = join(dir, "rmpc");
  chmodSync(binPath, 0o755);
  log(`extracted rmpc ${RMPC_VERSION} → ${binPath}`);
  return binPath;
}

function verifyCommitteeIdentitySubcommand(rmpcPath: string): void {
  const r = Bun.spawnSync([rmpcPath, "committee-identity", "--help"], { stdout: "pipe", stderr: "pipe" });
  const out = new TextDecoder().decode(r.stdout) + new TextDecoder().decode(r.stderr);
  if (r.exitCode !== 0) fail(`rmpc committee-identity --help exited ${r.exitCode}: ${out}`);
  const missing = missingCommitteeIdentitySubcommands(out);
  if (missing.length > 0) {
    fail(`downloaded rmpc ${RMPC_VERSION} is missing committee-identity subcommand(s): ${missing.join(", ")} — output:\n${out}`);
  }
  log(`rmpc committee-identity exposes create/show-public-key/sign (${RMPC_VERSION})`);
}

function runRmpcJson(rmpcPath: string, args: string[], env: Record<string, string>): any {
  const r = Bun.spawnSync([rmpcPath, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env } as Record<string, string>,
  });
  const out = new TextDecoder().decode(r.stdout).trim();
  const err = new TextDecoder().decode(r.stderr).trim();
  if (r.exitCode !== 0) fail(`rmpc ${args.join(" ")} exited ${r.exitCode}: ${err || out}`);
  try {
    return JSON.parse(out);
  } catch {
    fail(`rmpc ${args.join(" ")} produced non-JSON stdout: ${out}`);
  }
}

async function readJson<T = any>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

async function main(): Promise<void> {
  const rmpcPath = await downloadRmpc();
  verifyCommitteeIdentitySubcommand(rmpcPath);

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
  log(`rmpc identity created — memberId=${MEMBER_ID} publicKey=${publicKeyB64}`);

  // ── POST /api/committee/apply ──────────────────────────────────────────────
  const applyRes = await fetch(`${BACKEND_URL}/api/committee/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ memberId: MEMBER_ID, name: "RMPC Release E2E", lens: "release-proof", publicKey: publicKeyB64 }),
  });
  const applyBody = await readJson(applyRes);
  if (applyRes.status !== 201 || !applyBody.ok) fail(`POST /api/committee/apply → ${applyRes.status}: ${JSON.stringify(applyBody)}`);
  log(`applied as ${MEMBER_ID}`);

  // ── POST /api/committee/admin/activate ─────────────────────────────────────
  const activateRes = await fetch(`${BACKEND_URL}/api/committee/admin/activate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...adminHeaders },
    body: JSON.stringify({ memberId: MEMBER_ID }),
  });
  const activateBody = await readJson(activateRes);
  if (activateRes.status !== 200 || !activateBody.token) {
    fail(`POST /api/committee/admin/activate → ${activateRes.status}: ${JSON.stringify(activateBody)}`);
  }
  const memberToken: string = activateBody.token;
  log(`activated ${MEMBER_ID}`);

  // ── Open a distinctly-namespaced session (reuses mcp/src/e2e.ts's proven
  // job-queue lifecycle — the same path the required e2e + nightly committee
  // sessions drive — instead of a second, unproven direct-admin lifecycle) ────
  process.env.BACKEND_URL = BACKEND_URL; // e2e.ts reads BACKEND from env at module load
  const e2e = await import(join(repoRoot, "mcp", "src", "e2e.ts"));
  await e2e.admin("subject", { id: SUBJECT_ID, name: "RMPC Release E2E Subject" });
  // Idempotent, matches runSession()'s own pre-session regime seed — makes this
  // script self-sufficient even if run before any other regime seed exists.
  await e2e.admin("regime", { asof: TODAY });

  await e2e.enqueueLifecycleJob("open_session", { date: TODAY, subjectId: SUBJECT_ID });
  const scheduled = await e2e.waitForSessionState(TODAY, SUBJECT_ID, "scheduled");
  const sessionId = scheduled.session.id;

  await e2e.enqueueLifecycleJob("publish_brief", { sessionId, windowMinutes: 30 });
  await e2e.waitForSessionState(TODAY, SUBJECT_ID, "collecting");
  log(`session ${sessionId} open for ${TODAY}/${SUBJECT_ID}`);

  // ── MCP OAuth client_credentials + get_signing_payload + rmpc sign + submit ─
  const { submitViaMcp } = await import(join(repoRoot, "mcp", "src", "rmpc-client.ts"));
  const draft = {
    memberId: MEMBER_ID,
    date: TODAY,
    subjectId: SUBJECT_ID,
    nonce: crypto.randomUUID(),
    stance: "neutral",
    confidence: 0.5,
    body: "Released rmpc binary end-to-end proof (issue #104).",
  };
  const { canonical, signature } = await submitViaMcp({
    mcpUrl: MCP_URL,
    memberId: MEMBER_ID,
    memberToken,
    draft,
    sign: async (payload: string) => {
      const payloadFile = join(workDir, "payload.txt");
      writeFileSync(payloadFile, payload);
      const signed = runRmpcJson(rmpcPath, ["committee-identity", "--path", keystorePath, "sign", "--payload-file", payloadFile], rmpcEnv);
      if (!signed.ok || typeof signed.signature !== "string") fail(`committee-identity sign did not return a signature: ${JSON.stringify(signed)}`);
      if (signed.public_key !== publicKeyB64) fail(`sign's public_key (${signed.public_key}) does not match show-public-key's (${publicKeyB64})`);
      return signed.signature;
    },
  });
  log(`submit_recommendation accepted for ${MEMBER_ID}`);

  // ── Independent readback + signature re-verification ───────────────────────
  const sessionRes = await fetch(`${BACKEND_URL}/api/committee/sessions/${TODAY}/${SUBJECT_ID}`);
  const sessionBody = await readJson(sessionRes);
  if (sessionRes.status !== 200) fail(`GET /api/committee/sessions/${TODAY}/${SUBJECT_ID} → ${sessionRes.status}: ${JSON.stringify(sessionBody)}`);
  const take = (sessionBody.takes ?? []).find((t: any) => t.memberId === MEMBER_ID);
  if (!take) fail(`no take for ${MEMBER_ID} in GET /api/committee/sessions/${TODAY}/${SUBJECT_ID}: ${JSON.stringify(sessionBody.takes)}`);
  if (!take.verified) fail(`take for ${MEMBER_ID} is not server-verified: ${JSON.stringify(take)}`);

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
  if (!verified) fail(`independent signature re-verification FAILED for ${MEMBER_ID} against publicKey ${publicKeyB64}`);
  log(`independent signature re-verification passed for ${MEMBER_ID}`);

  rmSync(workDir, { recursive: true, force: true });
  log(`PASS — released rmpc ${RMPC_VERSION} completed the full README external-agent flow (memberId=${MEMBER_ID}, subject=${SUBJECT_ID}, date=${TODAY})`);
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(`[rmpc-release-e2e] FAIL: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    process.exit(1);
  });
}
