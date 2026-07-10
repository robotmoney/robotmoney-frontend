// MCP-protocol helper for scripts/rmpc-release-e2e.ts (issue #104). Lives inside
// mcp/ (not scripts/) so it can use the already-installed MCP SDK — the exact
// OAuth 2.1 client_credentials + tool-call wiring mcp/src/agent.ts uses for the
// built-in demo agents — instead of hand-rolling a second MCP client at the repo
// root. scripts/rmpc-release-e2e.ts dynamically imports this file, mirroring how
// scripts/lib/demo-main.ts dynamically imports mcp/src/e2e.ts, so scripts/ never
// needs the MCP SDK as a direct dependency.
//
// The actual Ed25519 signing is NOT done here: it is delegated to the caller's
// `sign` callback, which in scripts/rmpc-release-e2e.ts shells out to the
// downloaded, RELEASED `rmpc committee-identity sign` binary — this file only
// drives the MCP-protocol half of the README "Attach a prospective agent" flow
// (OAuth handshake, get_signing_payload, submit_recommendation).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ClientCredentialsProvider } from "@modelcontextprotocol/sdk/client/auth-extensions.js";

export const textOf = (res: any) => JSON.parse(res.content?.[0]?.text ?? "null");

export interface SubmissionDraft {
  memberId: string;
  date: string;
  subjectId: string;
  nonce: string;
  stance: string;
  confidence: number;
  body?: string;
  memoUrl?: string;
}

export interface SubmitViaMcpOpts {
  mcpUrl: string;
  memberId: string;
  memberToken: string;
  draft: SubmissionDraft;
  // Given the exact canonical string MCP's get_signing_payload returns, produce
  // the base64 Ed25519 signature submit_recommendation expects.
  sign: (canonical: string) => Promise<string>;
}

export interface SubmitViaMcpResult {
  canonical: string;
  signature: string;
  result: any;
}

// Connects to the MCP server via OAuth 2.1 client_credentials (clientId=memberId,
// clientSecret=the member's admin/activate bearer token — exactly the credential
// exchange README.md's "Attach a prospective agent" prompt documents), calls
// get_signing_payload for `draft`, hands the returned canonical string to `sign`,
// then calls submit_recommendation with the produced signature. Throws (never
// silently no-ops) on a missing canonical payload or a rejected submission, so
// the driver script exits non-zero.
export async function submitViaMcp(opts: SubmitViaMcpOpts): Promise<SubmitViaMcpResult> {
  const client = new Client({ name: `rmpc-release-e2e-${opts.memberId}`, version: "0.1.0" });
  const authProvider = new ClientCredentialsProvider({
    clientId: opts.memberId,
    clientSecret: opts.memberToken,
  });
  const transport = new StreamableHTTPClientTransport(new URL(opts.mcpUrl), { authProvider });
  await client.connect(transport);
  try {
    const payloadRes = textOf(await client.callTool({ name: "get_signing_payload", arguments: opts.draft as unknown as Record<string, unknown> }));
    const canonical: string = payloadRes?.canonical;
    if (typeof canonical !== "string" || canonical.length === 0) {
      throw new Error(`get_signing_payload returned no canonical string: ${JSON.stringify(payloadRes)}`);
    }
    const signature = await opts.sign(canonical);
    const result = textOf(await client.callTool({
      name: "submit_recommendation",
      arguments: { ...opts.draft, signature } as unknown as Record<string, unknown>,
    }));
    if (!result?.ok) {
      throw new Error(`submit_recommendation rejected: ${JSON.stringify(result)}`);
    }
    return { canonical, signature, result };
  } finally {
    await client.close();
  }
}
