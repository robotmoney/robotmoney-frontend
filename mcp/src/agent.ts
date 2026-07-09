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
import { authorTake, type RegimeContext } from "./inference.ts";

const BACKEND = process.env.BACKEND_URL ?? "http://localhost:8787";
const MCP_URL = process.env.MCP_URL ?? "http://localhost:8788/mcp";
const adminHeaders: Record<string, string> = process.env.ADMIN_TOKEN
  ? { "X-Admin-Token": process.env.ADMIN_TOKEN }
  : {};

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

    // 4. author the take via a REAL claude-opus-4-8 inference call, get the
    //    canonical payload, sign, submit — all via MCP. The member persona
    //    (name, lens, disposition) plus the regime/subject brief are fed to
    //    Claude; the returned prose (REGIME / ALLOCATION / SUBJECT sections
    //    ending in a STANCE/CONFIDENCE control line) is parsed into
    //    stance/confidence, and the control line is stripped from the stored
    //    body. There is NO deterministic/templated fallback: authorTake throws
    //    when ANTHROPIC_API_KEY is absent, so a keyless run fails loudly rather
    //    than emitting a fake take.
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
    onProgress?.("thinking"); // authoring the take via Claude inference
    const authored = await authorTake(
      { memberId: o.memberId, name: o.name, lens: o.lens, bias: o.bias },
      regimeCtx,
      o.subjectId,
    );
    const { stance, confidence } = authored;
    // Preserve the optional RM-tool provenance footnote (e.g. cygnus's
    // classify_regime read) by appending it to the authored body.
    const provenanceText = provenance.length ? `\n\n_Provenance: ${provenance.join("; ")}_` : "";
    const body = `${authored.body}${provenanceText}`;
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
