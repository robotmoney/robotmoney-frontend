// A committee member agent. It is an autonomous third party: generates its OWN
// ed25519 key, registers its public key (onboarding, REST), then participates
// entirely through the MCP server — read regime + brief, decide a stance, get
// the canonical signing payload, sign it with its own key, and submit. RM never
// sees the private key.
//
// The optional `existingCredentials` parameter supports agents that have been
// onboarded through the public apply → admin activate flow (rather than the
// privileged register shortcut). When provided, the agent skips key generation
// and REST registration, using the externally-obtained token + private key.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ClientCredentialsProvider } from "@modelcontextprotocol/sdk/client/auth-extensions.js";
import { generateKeyPair, sign } from "./crypto.ts";
import { buildMemo, type RegimeContext } from "./memo.ts";
import { authorTake } from "./inference.ts";

const BACKEND = process.env.BACKEND_URL ?? "http://localhost:8787";
const MCP_URL = process.env.MCP_URL ?? "http://localhost:8788/mcp";
const adminHeaders: Record<string, string> = process.env.ADMIN_TOKEN
  ? { "X-Admin-Token": process.env.ADMIN_TOKEN }
  : {};

// Gate the REAL keyless opencode-zen authoring path (mcp/src/inference.ts). Off
// by default so the required per-PR e2e stays HERMETIC — it uses the
// deterministic stanceFor() + buildMemo() template below, calls NO live model,
// and needs NO secret. The nightly committee-opencode job sets
// COMMITTEE_REAL_INFERENCE=1 to exercise (and loudly assert) the real path.
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
export type AgentStage = "connect" | "fetch" | "thinking" | "reporting" | "done";
export type AgentProgress = (stage: AgentStage, info?: { stance?: string; confidence?: number }) => void;

// Deterministic stance derivation from the composite + the member's directional
// bias. The HERMETIC per-PR default: no LLM, no secret. The real keyless
// opencode path (REAL_INFERENCE) parses stance/confidence out of the authored
// take instead.
export function stanceFor(composite: number, bias: number) {
  const x = composite + bias;
  const stance = x >= 0.67 ? "bullish" : x >= 0.55 ? "constructive" : x >= 0.45 ? "neutral" : x >= 0.33 ? "cautious" : "bearish";
  const confidence = Math.round(Math.min(1, Math.abs(x - 0.5) * 2 + 0.4) * 100) / 100;
  return { stance, confidence };
}

export const textOf = (res: any) => JSON.parse(res.content?.[0]?.text ?? "null");

// Enroll a member (register their public key) WITHOUT submitting — used to put a
// deliberate no-show on the roster so absence is recorded at aggregation.
export async function enroll(o: { memberId: string; name: string; lens?: string }) {
  const { publicKeyB64 } = await generateKeyPair();
  await fetch(`${BACKEND}/api/committee/register`, {
    method: "POST", headers: { "Content-Type": "application/json", ...adminHeaders },
    body: JSON.stringify({ memberId: o.memberId, name: o.name, lens: o.lens, publicKey: publicKeyB64 }),
  });
}

export async function runAgent(o: AgentOpts, existingCredentials?: ExistingCredentials, onProgress?: AgentProgress) {
  // 1. own keypair + onboarding (REST). Skip both when external credentials are
  //    provided (the apply → activate path handles these externally).
  const { publicKeyB64, privateKey } = existingCredentials
    ? { publicKeyB64: "", privateKey: existingCredentials.privateKey }
    : await generateKeyPair();
  const token = existingCredentials?.token ?? (await fetch(`${BACKEND}/api/committee/register`, {
    method: "POST", headers: { "Content-Type": "application/json", ...adminHeaders },
    body: JSON.stringify({ memberId: o.memberId, name: o.name, lens: o.lens, publicKey: publicKeyB64 }),
  }).then(async (r) => (await r.json() as { token: string }))).token;

  // 2. connect to the MCP server via OAuth 2.1 client_credentials grant.
  // The ClientCredentialsProvider handles token acquisition, refresh, and
  // automatic retry on 401. The MCP server's token endpoint validates the
  // member credentials (memberId + bearer token) and issues short-lived
  // access tokens. This exercises the real OAuth 2.1 flow end-to-end.
  const client = new Client({ name: `agent-${o.memberId}`, version: "0.1.0" });
  // OAuth discovery needs the server origin (no path component) to find
  // /.well-known/oauth-authorization-server at the root.
  const authProvider = new ClientCredentialsProvider({
    clientId: o.memberId,
    clientSecret: token,
  });
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), { authProvider });
  await client.connect(transport);
  onProgress?.("connect"); // MCP session established (OAuth handshake done)

  try {
    // 3. read context via MCP tools
    const regime = textOf(await client.callTool({ name: "get_regime", arguments: {} }));
    await client.callTool({ name: "get_brief", arguments: { date: o.date, subject: o.subjectId } });
    const composite = Number(regime?.composite ?? 0.5);
    onProgress?.("fetch"); // regime + brief read

    // Optionally use RM's classify_regime helper for provenance
    let provenance: string[] = [];
    if (o.memberId === "cygnus") {
      const classification = textOf(await client.callTool({ name: "classify_regime", arguments: { composite } }));
      provenance = [`RM tool: classify_regime → ${classification.classification} (${classification.explanation})`];
    }

    // 4. author the take, get the canonical payload, sign, submit — all via MCP.
    //    Two paths share the same regime context and provenance footnote:
    //      • REAL_INFERENCE (nightly / opt-in): a REAL keyless opencode-zen call
    //        (mcp/src/inference.ts) authors REGIME / ALLOCATION / SUBJECT prose
    //        ending in a STANCE/CONFIDENCE control line; the line is parsed into
    //        stance/confidence and stripped from the stored body. There is NO
    //        template fallback — authorTake throws when opencode is unavailable
    //        or the transcript is empty, so the nightly fails loudly.
    //      • Default (HERMETIC per-PR): the deterministic stanceFor() +
    //        buildMemo() template — no LLM, no secret — keeps the required e2e
    //        stable and offline.
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
    const memoResult = textOf(await client.callTool({
      name: "post_memo",
      arguments: { sessionId: o.sessionId, title: `${o.name}'s analysis of ${o.subjectId}`, body },
    }));
    const memoUrl = memoResult.ok ? memoResult.url : undefined;
    const draft = {
      memberId: o.memberId, date: o.date, subjectId: o.subjectId,
      nonce: crypto.randomUUID(), stance, confidence,
      body,
      memoUrl,
    };
    const { canonical } = textOf(await client.callTool({ name: "get_signing_payload", arguments: draft }));
    const signature = await sign(canonical, privateKey);
    const result = textOf(await client.callTool({ name: "submit_recommendation", arguments: { ...draft, signature } }));
    onProgress?.("done", { stance, confidence }); // recommendation submitted
    return { memberId: o.memberId, stance, confidence, memoUrl, provenance, result };
  } finally {
    await client.close();
  }
}
