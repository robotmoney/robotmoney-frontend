// A committee member agent. It is an autonomous third party: generates its OWN
// ed25519 key, registers its public key (onboarding, REST), then participates
// entirely through the MCP server — read regime + brief, decide a stance, get
// the canonical signing payload, sign it with its own key, and submit. RM never
// sees the private key.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { generateKeyPair, sign } from "./crypto.ts";

const BACKEND = process.env.BACKEND_URL ?? "http://localhost:8787";
const MCP_URL = process.env.MCP_URL ?? "http://localhost:8788/mcp";

export interface AgentOpts {
  memberId: string; name: string; lens: string; bias: number;
  date: string; subjectId: string;
}

function stanceFor(composite: number, bias: number) {
  const x = composite + bias;
  const stance = x >= 0.67 ? "bullish" : x >= 0.55 ? "constructive" : x >= 0.45 ? "neutral" : x >= 0.33 ? "cautious" : "bearish";
  const confidence = Math.round(Math.min(1, Math.abs(x - 0.5) * 2 + 0.4) * 100) / 100;
  return { stance, confidence };
}

const textOf = (res: any) => JSON.parse(res.content?.[0]?.text ?? "null");

export async function runAgent(o: AgentOpts) {
  // 1. own keypair + onboarding (REST)
  const { publicKeyB64, privateKey } = await generateKeyPair();
  const adminHeaders = process.env.ADMIN_TOKEN ? { "X-Admin-Token": process.env.ADMIN_TOKEN } : {};
  const reg = await fetch(`${BACKEND}/api/committee/register`, {
    method: "POST", headers: { "Content-Type": "application/json", ...adminHeaders },
    body: JSON.stringify({ memberId: o.memberId, name: o.name, lens: o.lens, publicKey: publicKeyB64 }),
  }).then((r) => r.json());
  const token: string = reg.token;

  // 2. connect to the MCP server with the member's bearer token
  const client = new Client({ name: `agent-${o.memberId}`, version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);

  try {
    // 3. read context via MCP tools
    const regime = textOf(await client.callTool({ name: "get_regime", arguments: {} }));
    await client.callTool({ name: "get_brief", arguments: { date: o.date, subject: o.subjectId } });
    const composite = Number(regime?.composite ?? 0.5);

    // 4. decide, get canonical payload, sign, submit — all via MCP
    const { stance, confidence } = stanceFor(composite, o.bias);
    const draft = {
      memberId: o.memberId, date: o.date, subjectId: o.subjectId,
      nonce: crypto.randomUUID(), stance, confidence,
      body: `${o.name} (${o.lens}): regime composite ${composite.toFixed(2)} → ${stance}.`,
    };
    const { canonical } = textOf(await client.callTool({ name: "get_signing_payload", arguments: draft }));
    const signature = await sign(canonical, privateKey);
    const result = textOf(await client.callTool({ name: "submit_recommendation", arguments: { ...draft, signature } }));
    return { memberId: o.memberId, stance, confidence, result };
  } finally {
    await client.close();
  }
}
