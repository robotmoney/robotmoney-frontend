#!/usr/bin/env bun
// The SITTING swarm member's own session client — runs INSIDE the
// member's container on the member-agent rail (issue #361 Phase 2; docs/
// decisions.md D25, docs/architecture.md §9.7). It is the member's "own
// software", the runnable analogue of the published starter client
// (scripts/starter-swarm-agent.ts): the harness never authors, signs, or
// submits on a member's behalf — it only launches this client in the member's
// container (scripts/lib/swarm/agent.ts runMemberSessionAgent) and
// observes the session from outside.
//
// Everything member-scoped happens in here, inside the container:
//   - the ed25519 identity lives in the member's HOME (a persistent named
//     volume — issue #361 Phase 3: the key that enrolled is the key that signs
//     every later take; the harness NEVER holds a member private key);
//   - the regime read and the session brief are fetched by THIS process over
//     REST (§11.3 E7 — the harness supplies no context);
//   - the take is authored by THIS process's own `opencode run` call
//     (scripts/lib/swarm/inference.ts — the same authoring library, now
//     executed inside the member's private filesystem, which makes the old
//     host-side concurrent-cold-start SQLite race structurally impossible);
//   - the canonical submission bytes are fetched from RM's signing-payload
//     endpoint and SIGNED exactly as returned in here, and the memo + submission
//     are POSTed from in here with the member's own bearer.
//
// TWO KEYSTORE SHAPES, one client:
//   - "client" — this client's own identity file (a private-key JWK) at
//     ~/.rm-member/identity.jwk.json, used by the fixed demo roster. Created
//     in `enroll` mode; the PUBLIC key is printed for the harness (playing the
//     RM operator) to register; the private key never leaves this container's
//     volume.
//   - "rmpc" — the swarm-onboarding skill's layout, created during a REAL
//     onboarding by the member's own vanilla agent inside this same HOME
//     volume: ~/robotmoney-identity.json (encrypted rmpc keystore),
//     ~/robotmoney-member-id, ~/robotmoney-member-token. Signing shells out to
//     the member's own `rmpc` install (also in the volume); the keystore
//     passphrase arrives as RMPC_COMMITTEE_IDENTITY_PASSPHRASE, exported by
//     the member's OWNER (the harness plays exactly that role, §11.3 E7).
//
// ENV CONTRACT (all RM_* injected explicitly by the harness at
// `docker compose run` time — a container inherits nothing):
//   RM_API_URL        swarm REST base (compose-internal, e.g. http://api:8787)
//   RM_MEMBER_ID      the member id this client acts as
//   RM_MEMBER_NAME / RM_MEMBER_LENS / RM_MEMBER_BIAS   persona facts
//   RM_SESSION_DATE / RM_SUBJECT_ID / RM_SESSION_ID    session coordinates
//   RM_MEMBER_TOKEN   (optional) freshly-minted bearer from enrollment; this
//                     client persists it in its keystore and later runs read
//                     it from there
//   AGENT_MODEL       resolved model id for the authoring call
//   OPENCODE_API_KEY  the single model credential (modelConfig `-e` injection)
//   RMPC_COMMITTEE_IDENTITY_PASSPHRASE  (optional) rmpc keystore passphrase
//
// STDOUT PROTOCOL (line-oriented; the harness parses these, everything else is
// free-form logging):
//   RM_ENROLL {json}   enroll-mode result: { keystoreKind, publicKey?, tokenValid, memberId? }
//   RM_STAGE  {json}   { stage: connect|fetch|thinking|reporting|done, stance?, confidence? }
//   RM_TELEMETRY {json} incremental, redacted OpenCode lifecycle milestone
//   RM_RESULT {json}   { memberId, stance, confidence, memoUrl?, verified }
//
// LOUD-FAILURE CONTRACT: any failure exits non-zero with the reason on
// stderr; the harness renders that member ABSENT (#122 semantics) and the
// session proceeds without it. There is no fallback of any kind in here.
import { classifyRegime, ROUTES } from "@robotmoney/contract";
import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { authorTake, type RegimeContext } from "../lib/swarm/inference.ts";

const HOME = process.env.HOME ?? "/home/agent";
const CLIENT_DIR = join(HOME, ".rm-member");
const CLIENT_IDENTITY = join(CLIENT_DIR, "identity.jwk.json");
const CLIENT_TOKEN = join(CLIENT_DIR, "token");
// The swarm-onboarding skill's own layout (created by a real onboarding
// run inside this HOME): see frontend/public/skills/swarm-onboarding/SKILL.md.
const RMPC_IDENTITY = join(HOME, "robotmoney-identity.json");
const RMPC_MEMBER_ID = join(HOME, "robotmoney-member-id");
const RMPC_MEMBER_TOKEN = join(HOME, "robotmoney-member-token");

const out = (tag: string, payload: unknown) => console.log(`${tag} ${JSON.stringify(payload)}`);
const stage = (s: string, info?: Record<string, unknown>) => out("RM_STAGE", { stage: s, ...info });

function requiredEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`${name} is required in the member container environment`);
  return v;
}

function apiUrl(): string {
  return requiredEnv("RM_API_URL").replace(/\/+$/, "");
}

export interface RestJsonOptions {
  /** Expected non-success statuses a caller deliberately interprets. */
  allowStatuses?: readonly number[];
}

export async function restJson<T = any>(
  route: string,
  init?: RequestInit,
  options: RestJsonOptions = {},
): Promise<{ status: number; body: T }> {
  const res = await fetch(`${apiUrl()}${route}`, init);
  const text = await res.text();
  let body: T;
  try {
    body = (text ? JSON.parse(text) : null) as T;
  } catch {
    throw new Error(`${route} returned non-JSON HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  if (!res.ok && !options.allowStatuses?.includes(res.status)) {
    const error = body && typeof body === "object" && "error" in body
      ? String((body as { error?: unknown }).error)
      : text.slice(0, 200);
    throw new Error(`${route} failed with HTTP ${res.status}${error ? `: ${error}` : ""}`);
  }
  return { status: res.status, body };
}

/** Fetch the exact canonical byte string RM validated for this draft. */
export async function fetchSigningPayload(draft: Record<string, unknown>): Promise<string> {
  const { body } = await restJson<{ canonical?: unknown }>(ROUTES.swarm.signingPayload, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(draft),
  });
  if (typeof body?.canonical !== "string" || body.canonical.length === 0) {
    throw new Error(`${ROUTES.swarm.signingPayload} returned HTTP 200 without a non-empty .canonical string`);
  }
  // Do not trim, normalize, parse, or locally reconstruct this value: these
  // are the exact bytes the API promises to verify.
  return body.canonical;
}

const b64 = (b: ArrayBuffer | Uint8Array) =>
  Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString("base64");

type KeystoreKind = "client" | "rmpc";

function keystoreKind(): KeystoreKind {
  return existsSync(RMPC_IDENTITY) ? "rmpc" : "client";
}

function readStoredToken(kind: KeystoreKind): string | null {
  const path = kind === "rmpc" ? RMPC_MEMBER_TOKEN : CLIENT_TOKEN;
  if (!existsSync(path)) return null;
  const token = readFileSync(path, "utf8").trim();
  return token || null;
}

function persistToken(kind: KeystoreKind, token: string): void {
  const path = kind === "rmpc" ? RMPC_MEMBER_TOKEN : CLIENT_TOKEN;
  if (kind === "client") mkdirSync(CLIENT_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
}

async function verifyToken(token: string): Promise<string | null> {
  const { status, body } = await restJson<{ memberId?: string }>(ROUTES.swarm.verifyToken, {
    headers: { Authorization: `Bearer ${token}` },
  }, { allowStatuses: [401] });
  return status === 200 && body?.memberId ? body.memberId : null;
}

// ── client-native keystore (fixed demo roster) ──────────────────────────────
async function ensureClientKeyPair(): Promise<{ publicKeyB64: string; privateKey: CryptoKey }> {
  // A COMMITTED persona identity, when the harness supplies one
  // (scripts/lib/swarm/persona-keys.ts). It wins over whatever this
  // container's volume happens to hold, because the volume is per-boot and the
  // persona is not: adopting the known key is what lets a restarted demo sign as
  // a persona its persistent database already knows, instead of inventing a new
  // identity and duplicating the member. Seeded into the keystore so every later
  // run in this container reads it from the normal place.
  const supplied = process.env.RM_MEMBER_IDENTITY?.trim();
  if (supplied) {
    const { privateJwk, publicKeyB64 } = JSON.parse(supplied) as { privateJwk: JsonWebKey; publicKeyB64: string };
    const privateKey = await crypto.subtle.importKey("jwk", privateJwk, { name: "Ed25519" }, false, ["sign"]);
    mkdirSync(CLIENT_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(CLIENT_IDENTITY, JSON.stringify({ privateJwk, publicKeyB64 }), { mode: 0o600 });
    return { publicKeyB64, privateKey };
  }
  if (existsSync(CLIENT_IDENTITY)) {
    const stored = JSON.parse(readFileSync(CLIENT_IDENTITY, "utf8")) as { privateJwk: JsonWebKey; publicKeyB64: string };
    const privateKey = await crypto.subtle.importKey("jwk", stored.privateJwk, { name: "Ed25519" }, false, ["sign"]);
    return { publicKeyB64: stored.publicKeyB64, privateKey };
  }
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const publicKeyB64 = b64(await crypto.subtle.exportKey("raw", kp.publicKey));
  const privateJwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
  mkdirSync(CLIENT_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CLIENT_IDENTITY, JSON.stringify({ privateJwk, publicKeyB64 }), { mode: 0o600 });
  return { publicKeyB64, privateKey: kp.privateKey };
}

// ── rmpc keystore (real-onboarded members) ──────────────────────────────────
function rmpcSign(canonical: string): string {
  if (!process.env.RMPC_COMMITTEE_IDENTITY_PASSPHRASE) {
    throw new Error(
      "rmpc keystore present but RMPC_COMMITTEE_IDENTITY_PASSPHRASE is not set — the owner must export the passphrase for this session",
    );
  }
  const payloadFile = join(tmpdir(), `rm-signing-payload-${crypto.randomUUID()}.bin`);
  try {
    // EXACT canonical bytes: no trailing newline (rmpc refuses trailing
    // whitespace as a guardrail — see the swarm-onboarding skill).
    writeFileSync(payloadFile, canonical);
    const r = Bun.spawnSync(
      ["rmpc", "committee-identity", "--path", RMPC_IDENTITY, "sign", "--payload-file", payloadFile],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    if (r.exitCode !== 0) {
      throw new Error(`rmpc sign failed (exit ${r.exitCode}): ${new TextDecoder().decode(r.stderr as Uint8Array).slice(0, 300)}`);
    }
    const parsed = JSON.parse(new TextDecoder().decode(r.stdout as Uint8Array)) as { signature?: string };
    if (!parsed.signature) throw new Error("rmpc sign returned no .signature field");
    return parsed.signature;
  } finally {
    rmSync(payloadFile, { force: true });
  }
}

// ── enroll mode ─────────────────────────────────────────────────────────────
// Report this member-machine's identity state so the harness (playing the RM
// operator) can register the PUBLIC key when needed. Never prints, and never
// has, a private key.
async function enroll(): Promise<void> {
  const kind = keystoreKind();
  // A token minted at registration may arrive here exactly once (ownerEnv);
  // persist it in this member's own keystore — the same branch participate
  // mode has, exposed in enroll mode so the inference-off rails check can
  // prove credential persistence without a model call.
  const freshToken = process.env.RM_MEMBER_TOKEN?.trim();
  if (freshToken) persistToken(kind, freshToken);
  const stored = freshToken || readStoredToken(kind);
  const tokenMemberId = stored ? await verifyToken(stored) : null;
  if (kind === "rmpc") {
    // A real-onboarded identity: the pubkey is already registered (that IS
    // what admission verified); a re-register would rotate the identity, so
    // none is ever requested from here. Either the stored token still works,
    // or this member is honestly absent until its owner intervenes.
    out("RM_ENROLL", {
      keystoreKind: "rmpc",
      tokenValid: tokenMemberId !== null,
      memberId: tokenMemberId ?? (existsSync(RMPC_MEMBER_ID) ? readFileSync(RMPC_MEMBER_ID, "utf8").trim() : null),
    });
    return;
  }
  const { publicKeyB64 } = await ensureClientKeyPair();
  out("RM_ENROLL", {
    keystoreKind: "client",
    publicKey: publicKeyB64,
    tokenValid: tokenMemberId !== null && tokenMemberId === process.env.RM_MEMBER_ID,
    memberId: tokenMemberId,
  });
}

// ── participate mode ────────────────────────────────────────────────────────
async function participate(): Promise<void> {
  const memberId = requiredEnv("RM_MEMBER_ID");
  const name = requiredEnv("RM_MEMBER_NAME");
  const lens = process.env.RM_MEMBER_LENS ?? "";
  const bias = Number(process.env.RM_MEMBER_BIAS ?? "0");
  const date = requiredEnv("RM_SESSION_DATE");
  const subjectId = requiredEnv("RM_SUBJECT_ID");
  // Kept as the string the API's own validation expects (requiredString).
  const sessionId = requiredEnv("RM_SESSION_ID");

  const kind = keystoreKind();
  // A token minted at enrollment arrives ONCE via RM_MEMBER_TOKEN and is
  // persisted in this member's own keystore; later sessions read it from
  // there and the harness passes nothing.
  const freshToken = process.env.RM_MEMBER_TOKEN?.trim();
  if (freshToken) persistToken(kind, freshToken);
  const token = freshToken || readStoredToken(kind);
  if (!token) throw new Error(`no bearer token in the ${kind} keystore and none supplied — member cannot participate`);
  const verifiedMemberId = await verifyToken(token);
  if (verifiedMemberId !== memberId) {
    throw new Error(
      `bearer token does not authenticate as ${memberId} (server says: ${verifiedMemberId ?? "invalid"}) — refusing to submit`,
    );
  }
  stage("connect");

  // Read context over REST — this member's OWN fetch, not the harness's.
  const regime = (await restJson<{ latest?: any }>(`${ROUTES.dashboards.regimeSnapshots}?range=1`)).body?.latest ?? {};
  await restJson(`${ROUTES.swarm.brief}?date=${encodeURIComponent(date)}&subject=${encodeURIComponent(subjectId)}`);
  const composite = Number(regime?.composite ?? 0.5);
  const regimeCtx: RegimeContext = {
    composite,
    compositePercentile: regime?.compositePercentile ?? regime?.composite_percentile ?? null,
    regime: regime?.regime ?? null,
    macroRegime: regime?.macroRegime ?? regime?.macro_regime ?? null,
    onchainRegime: regime?.onchainRegime ?? regime?.onchain_regime ?? null,
    factorRegime: regime?.factorRegime ?? regime?.factor_regime ?? null,
    macroPercentile: regime?.macroPercentile ?? regime?.macro_percentile ?? null,
    onchainPercentile: regime?.onchainPercentile ?? regime?.onchain_percentile ?? null,
    factorPercentile: regime?.factorPercentile ?? regime?.factor_percentile ?? null,
  };
  stage("fetch");

  // Optional provenance footnote using RM's shared regime classifier — same
  // behavior the host-run driver had for this member.
  let provenance: string[] = [];
  if (memberId === "cygnus") {
    provenance = [`RM classifier: composite ${composite.toFixed(3)} → ${classifyRegime(composite)}`];
  }

  // Author the take with a REAL in-container opencode call. authorTake throws
  // on any failure (unavailable CLI, empty transcript, malformed control
  // line) — no fallback; the thrown error exits this process non-zero and the
  // member renders absent.
  stage("thinking");
  const authored = await authorTake(
    { memberId, name, lens, bias },
    regimeCtx,
    subjectId,
    {
      telemetry: (event) => out("RM_TELEMETRY", event),
      diagnosticArtifactPath: process.env.RM_DIAGNOSTIC_ARTIFACT,
    },
  );
  const provenanceText = provenance.length ? `\n\n_Provenance: ${provenance.join("; ")}_` : "";
  const body = `${authored.body}${provenanceText}`;
  stage("reporting", { stance: authored.stance, confidence: authored.confidence });

  // Post the memo, ask the API for the exact validated canonical byte string,
  // sign those bytes IN HERE, then submit. Local canonical reconstruction is
  // deliberately absent: the server response is the protocol authority.
  const memo = await restJson<{ ok?: boolean; url?: string }>(ROUTES.swarm.memos, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ sessionId, title: `${name}'s analysis of ${subjectId}`, body }),
  });
  const memoUrl = memo.body?.ok ? memo.body.url : undefined;
  const draft = {
    memberId,
    date,
    subjectId,
    nonce: crypto.randomUUID(),
    stance: authored.stance,
    confidence: authored.confidence,
    body,
    memoUrl,
  };
  const canonical = await fetchSigningPayload(draft);
  let signature: string;
  if (kind === "rmpc") {
    signature = rmpcSign(canonical);
  } else {
    const { privateKey } = await ensureClientKeyPair();
    signature = b64(await crypto.subtle.sign({ name: "Ed25519" }, privateKey, new TextEncoder().encode(canonical)));
  }
  const submitted = await restJson<{ ok?: boolean; verified?: boolean; error?: string }>(ROUTES.swarm.submit, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ ...draft, signature }),
  });
  if (!submitted.body?.ok || submitted.body.verified !== true) {
    throw new Error(`submission was not verified (HTTP ${submitted.status}): ${JSON.stringify(submitted.body).slice(0, 300)}`);
  }
  stage("done", { stance: authored.stance, confidence: authored.confidence });
  out("RM_RESULT", {
    memberId,
    stance: authored.stance,
    confidence: authored.confidence,
    memoUrl,
    verified: true,
  });
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode === "enroll") return enroll();
  if (mode === "participate") return participate();
  throw new Error(`usage: member-session-client.ts <enroll|participate> (got ${JSON.stringify(mode)})`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`member-session-client failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
