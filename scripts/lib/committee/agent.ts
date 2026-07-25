// A committee member agent, REST-only (D21 — the MCP transport is retired;
// see docs/decisions.md D21). It is an autonomous third party: generates its
// OWN ed25519 key, registers its public key (the privileged demo `register`
// shortcut), then participates entirely over the committee REST API — read
// regime + brief, decide a stance, canonicalize the payload with
// @robotmoney/contract, sign it with its own key, post a memo, and submit. RM
// never sees the private key.
//
// The optional `existingCredentials` parameter supports agents that have been
// onboarded through the public apply → admin activate flow (rather than the
// privileged register shortcut). When provided, the agent skips key generation
// and registration, using the externally-obtained token + private key.
//
// This module replaces the retired mcp/src/agent.ts. Each former MCP tool call
// has a direct REST equivalent, and the canonical signing payload is produced
// locally with @robotmoney/contract's canonicalizeSubmission (the same bytes
// the server's signing-payload endpoint returns) rather than fetched.
import {
  canonicalizeSubmission,
  classifyRegime,
  ROUTES,
  stanceFor,
} from "@robotmoney/contract";
import { generateKeyPair, sign } from "./crypto.ts";
import { buildMemo, type RegimeContext } from "./memo.ts";
import { authorTake } from "./inference.ts";

const BACKEND = process.env.BACKEND_URL ?? "http://localhost:8787";
const adminHeaders: Record<string, string> = process.env.ADMIN_TOKEN
  ? { "X-Admin-Token": process.env.ADMIN_TOKEN }
  : {};

// Gate the REAL keyless opencode-zen authoring path (./inference.ts). Off by
// default so the required per-PR e2e stays HERMETIC — it uses the deterministic
// stanceFor() + buildMemo() template below, calls NO live model, and needs NO
// secret. The nightly committee-opencode job sets COMMITTEE_REAL_INFERENCE=1 to
// exercise (and loudly assert) the real path.
const REAL_INFERENCE = process.env.COMMITTEE_REAL_INFERENCE === "1";

export interface AgentOpts {
  memberId: string; name: string; lens: string; bias: number;
  date: string; subjectId: string; sessionId: number;
}

export interface ExistingCredentials {
  token: string;
  privateKey: CryptoKey;
}

// Optional, additive progress callback. When provided, runAgent emits its real
// pipeline stages so a UI can show a member advancing connect → fetch → thinking
// → reporting → done. Default undefined ⇒ zero behaviour change (standalone e2e).
// "connect" now means "registered + credentials ready" (there is no MCP session
// handshake); the stage name is kept for the demo strip's stable vocabulary.
export type AgentStage = "connect" | "fetch" | "thinking" | "reporting" | "done";
export type AgentProgress = (stage: AgentStage, info?: { stance?: string; confidence?: number }) => void;

// Deterministic stance derivation from the composite + the member's directional
// bias. The HERMETIC per-PR default: no LLM, no secret. The ladder itself lives
// in @robotmoney/contract (contract/src/committee.js) so the backend demo e2e
// and this agent share ONE bucket rule; re-exported to keep this module the
// local reference point. The real keyless opencode path (REAL_INFERENCE) parses
// stance/confidence out of the authored take instead.
export { stanceFor };

async function restJson<T = any>(route: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BACKEND}${route}`, init);
  return (await res.json()) as T;
}

// Enroll a member (register their public key) WITHOUT submitting — used to put a
// deliberate no-show on the roster so absence is recorded at aggregation.
export async function enroll(o: { memberId: string; name: string; lens?: string }) {
  const { publicKeyB64 } = await generateKeyPair();
  await restJson(ROUTES.committee.register, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...adminHeaders },
    body: JSON.stringify({ memberId: o.memberId, name: o.name, lens: o.lens, publicKey: publicKeyB64 }),
  });
}

export async function runAgent(o: AgentOpts, existingCredentials?: ExistingCredentials, onProgress?: AgentProgress) {
  // 1. own keypair + registration (REST). Skip both when external credentials
  //    are provided (the apply → activate path handles these externally).
  const { publicKeyB64, privateKey } = existingCredentials
    ? { publicKeyB64: "", privateKey: existingCredentials.privateKey }
    : await generateKeyPair();
  const token = existingCredentials?.token ?? (await restJson<{ token: string }>(ROUTES.committee.register, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...adminHeaders },
    body: JSON.stringify({ memberId: o.memberId, name: o.name, lens: o.lens, publicKey: publicKeyB64 }),
  })).token;
  onProgress?.("connect"); // registered + member credentials in hand (REST — no session handshake)

  // 2. read context over REST: latest regime snapshot + the session brief.
  const regime = (await restJson<{ latest?: any }>(`${ROUTES.dashboards.regimeSnapshots}?range=1`)).latest ?? {};
  await restJson(`${ROUTES.committee.brief}?date=${o.date}&subject=${o.subjectId}`);
  const composite = Number(regime?.composite ?? 0.5);
  onProgress?.("fetch"); // regime + brief read

  // Optionally record a provenance footnote using RM's shared regime classifier
  // (@robotmoney/contract — the same canonical thresholds the retired
  // classify_regime tool wrapped). Locally computed; no RM-hosted call.
  let provenance: string[] = [];
  if (o.memberId === "cygnus") {
    provenance = [`RM classifier: composite ${composite.toFixed(3)} → ${classifyRegime(composite)}`];
  }

  // 3. author the take (two paths share the same regime context + provenance):
  //      • REAL_INFERENCE (nightly / opt-in): a REAL keyless opencode-zen call
  //        (./inference.ts) authors REGIME / ALLOCATION / SUBJECT prose ending
  //        in a STANCE/CONFIDENCE control line; parsed into stance/confidence
  //        and stripped from the stored body. NO template fallback — authorTake
  //        throws when opencode is unavailable, so the nightly fails loudly.
  //      • Default (HERMETIC per-PR): the deterministic stanceFor() +
  //        buildMemo() template — no LLM, no secret.
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
  let stance: string;
  let confidence: number;
  let body: string;
  if (REAL_INFERENCE) {
    onProgress?.("thinking"); // authoring the take via a real keyless opencode call
    const authored = await authorTake(
      { memberId: o.memberId, name: o.name, lens: o.lens, bias: o.bias },
      regimeCtx,
      o.subjectId,
    );
    stance = authored.stance;
    confidence = authored.confidence;
    const provenanceText = provenance.length ? `\n\n_Provenance: ${provenance.join("; ")}_` : "";
    body = `${authored.body}${provenanceText}`;
  } else {
    const decided = stanceFor(composite, o.bias);
    stance = decided.stance;
    confidence = decided.confidence;
    onProgress?.("thinking", { stance, confidence }); // stance decided (deterministic)
    const provenanceText = provenance.length ? ` [${provenance.join("; ")}]` : "";
    body = buildMemo({ name: o.name, lens: o.lens, subjectId: o.subjectId, stance, confidence }, regimeCtx, provenanceText);
  }
  onProgress?.("reporting", { stance, confidence }); // posting memo, signing, submitting

  // 4. post the memo (REST, bearer), canonicalize locally, sign, submit (REST).
  const memoResult = await restJson<{ ok?: boolean; url?: string }>(ROUTES.committee.memos, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ sessionId: o.sessionId, title: `${o.name}'s analysis of ${o.subjectId}`, body }),
  });
  const memoUrl = memoResult.ok ? memoResult.url : undefined;
  const draft = {
    memberId: o.memberId, date: o.date, subjectId: o.subjectId,
    nonce: crypto.randomUUID(), stance, confidence,
    body,
    memoUrl,
  };
  const canonical = canonicalizeSubmission(draft);
  const signature = await sign(canonical, privateKey);
  const result = await restJson(ROUTES.committee.submit, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ ...draft, signature }),
  });
  onProgress?.("done", { stance, confidence }); // recommendation submitted
  return { memberId: o.memberId, stance, confidence, memoUrl, provenance, result };
}
