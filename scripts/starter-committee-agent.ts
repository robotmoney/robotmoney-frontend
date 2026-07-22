#!/usr/bin/env bun
/**
 * Runnable, model-free starter for one Robot Money committee member.
 *
 * Import `runStarterCommitteeAgent` and provide your own `AuthorTake` callback
 * to connect an inference runtime. The CLI deliberately defaults to a
 * deterministic author so the signing and transport path can be exercised
 * without a model, API key, or hidden fallback.
 */
import { canonicalizeSubmission, path as routePath, ROUTES } from "@robotmoney/contract";
import type { CommitteeBrief, CommitteeSession, CommitteeTake } from "@robotmoney/contract";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ClientCredentialsProvider } from "@modelcontextprotocol/sdk/client/auth-extensions.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export type StarterTransport = "rest" | "mcp";

export interface StarterSession extends Omit<CommitteeSession, "id"> {
  id: string | number;
}

export interface AuthorTakeInput {
  session: StarterSession;
  brief: CommitteeBrief;
}

export interface AuthoredTake {
  stance: "bearish" | "cautious" | "neutral" | "constructive" | "bullish";
  confidence: number;
  body: string;
}

export type AuthorTake = (input: AuthorTakeInput) => AuthoredTake | Promise<AuthoredTake>;

export interface SubmissionDraft extends AuthoredTake {
  memberId: string;
  date: string;
  subjectId: string;
  nonce: string;
  memoUrl?: string;
}

export interface StarterCredentials {
  memberId: string;
  memberToken: string;
  privateKey: CryptoKey;
}

export interface StarterOptions extends StarterCredentials {
  transport: StarterTransport;
  backendUrl: string;
  mcpUrl?: string;
  authorTake?: AuthorTake;
}

export interface StarterResult {
  transport: StarterTransport;
  draft: SubmissionDraft;
  canonical: string;
  signature: string;
  take: CommitteeTake;
}

/** A stable, model-free default. Replace this callback in a real agent. */
export const deterministicAuthorTake: AuthorTake = ({ session, brief }) => ({
  stance: "neutral",
  confidence: 0.5,
  body:
    `Deterministic starter take for ${session.subjectId} on ${session.date}. ` +
    `Brief ${brief.id} was read successfully; replace deterministicAuthorTake with your model callback.`,
});

/**
 * Both adapters deliberately enter the same repo-owned canonicalization path.
 * The MCP adapter also compares these bytes with get_signing_payload before it
 * signs, making contract/server drift a loud failure.
 */
export function canonicalizeDraftForTransport(
  _transport: StarterTransport,
  draft: SubmissionDraft,
): string {
  return canonicalizeSubmission(draft);
}

const encoder = new TextEncoder();
const asBase64 = (value: ArrayBuffer | Uint8Array): string =>
  Buffer.from(value instanceof Uint8Array ? value : new Uint8Array(value)).toString("base64");

export async function signDraft(
  transport: StarterTransport,
  draft: SubmissionDraft,
  privateKey: CryptoKey,
): Promise<{ canonical: string; signature: string }> {
  const canonical = canonicalizeDraftForTransport(transport, draft);
  const bytes = await crypto.subtle.sign("Ed25519", privateKey, encoder.encode(canonical));
  return { canonical, signature: asBase64(bytes) };
}

function normalizedBaseUrl(value: string, name: string): string {
  const trimmed = value.trim().replace(/\/$/, "");
  if (!trimmed) throw new Error(`${name} must not be empty`);
  try {
    return new URL(trimmed).toString().replace(/\/$/, "");
  } catch {
    throw new Error(`${name} must be an absolute URL`);
  }
}

async function responseJson<T>(response: Response, operation: string): Promise<T> {
  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`${operation} returned non-JSON HTTP ${response.status}`);
  }
  if (!response.ok) {
    throw new Error(`${operation} failed with HTTP ${response.status}: ${JSON.stringify(body)}`);
  }
  return body as T;
}

async function restJson<T>(
  backendUrl: string,
  route: string,
  operation: string,
  init?: RequestInit,
): Promise<T> {
  return responseJson<T>(await fetch(`${backendUrl}${route}`, init), operation);
}

function mcpText<T>(result: unknown): T {
  if (typeof result !== "object" || result === null) {
    throw new Error("MCP tool returned an invalid result");
  }
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content) || typeof content[0] !== "object" || content[0] === null) {
    throw new Error("MCP tool returned no text content");
  }
  const text = (content[0] as { text?: unknown }).text;
  if (typeof text !== "string") throw new Error("MCP tool returned non-text content");
  return JSON.parse(text) as T;
}

function assertAuthoredTake(take: AuthoredTake): void {
  if (!take.body.trim()) throw new Error("AuthorTake returned an empty body");
  if (!Number.isFinite(take.confidence) || take.confidence < 0 || take.confidence > 1) {
    throw new Error(`AuthorTake confidence must be between 0 and 1 (got ${take.confidence})`);
  }
}

function verifiedTake(readback: { takes?: CommitteeTake[] }, memberId: string): CommitteeTake {
  const take = readback.takes?.find((candidate) => candidate.memberId === memberId);
  if (!take) throw new Error(`verified readback did not contain member ${memberId}`);
  if (take.verified !== true) throw new Error(`readback for member ${memberId} was not server-verified`);
  return take;
}

async function runRest(options: StarterOptions): Promise<StarterResult> {
  const session = await restJson<StarterSession | null>(
    options.backendUrl,
    ROUTES.committee.openSession,
    "discover open session",
  );
  if (!session) throw new Error("no committee session is currently collecting");
  const brief = await restJson<CommitteeBrief | null>(
    options.backendUrl,
    `${ROUTES.committee.brief}?date=${encodeURIComponent(session.date)}&subject=${encodeURIComponent(session.subjectId)}`,
    "read committee brief",
  );
  if (!brief) throw new Error(`no brief exists for ${session.date}/${session.subjectId}`);

  const authored = await (options.authorTake ?? deterministicAuthorTake)({ session, brief });
  assertAuthoredTake(authored);
  const memo = await restJson<{ ok?: boolean; url?: string; error?: string }>(
    options.backendUrl,
    ROUTES.committee.memos,
    "post committee memo",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${options.memberToken}`,
      },
      body: JSON.stringify({
        sessionId: String(session.id),
        title: `Starter take for ${session.subjectId}`,
        body: authored.body,
      }),
    },
  );
  if (!memo.ok || !memo.url) throw new Error(`post committee memo was rejected: ${memo.error ?? "missing URL"}`);

  const draft: SubmissionDraft = {
    memberId: options.memberId,
    date: session.date,
    subjectId: session.subjectId,
    nonce: crypto.randomUUID(),
    ...authored,
    memoUrl: memo.url,
  };
  const { canonical, signature } = await signDraft("rest", draft, options.privateKey);
  const submitted = await restJson<{ ok?: boolean; verified?: boolean; error?: string }>(
    options.backendUrl,
    ROUTES.committee.submit,
    "submit REST recommendation",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${options.memberToken}`,
      },
      body: JSON.stringify({ ...draft, signature }),
    },
  );
  if (!submitted.ok || submitted.verified !== true) {
    throw new Error(`REST recommendation was not verified: ${submitted.error ?? JSON.stringify(submitted)}`);
  }
  const readback = await restJson<{ takes?: CommitteeTake[] }>(
    options.backendUrl,
    routePath(ROUTES.committee.session, { date: session.date, subject: session.subjectId }),
    "read back REST recommendation",
  );
  return { transport: "rest", draft, canonical, signature, take: verifiedTake(readback, options.memberId) };
}

async function runMcp(options: StarterOptions): Promise<StarterResult> {
  if (!options.mcpUrl) throw new Error("MCP_URL is required for --transport=mcp");
  const client = new Client({ name: `starter-${options.memberId}`, version: "0.1.0" });
  const authProvider = new ClientCredentialsProvider({
    clientId: options.memberId,
    clientSecret: options.memberToken,
  });
  const transport = new StreamableHTTPClientTransport(new URL(options.mcpUrl), { authProvider });
  await client.connect(transport);
  try {
    const session = mcpText<StarterSession | null>(
      await client.callTool({ name: "get_open_session", arguments: {} }),
    );
    if (!session) throw new Error("no committee session is currently collecting");
    const brief = mcpText<CommitteeBrief | null>(
      await client.callTool({
        name: "get_brief",
        arguments: { date: session.date, subject: session.subjectId },
      }),
    );
    if (!brief) throw new Error(`no brief exists for ${session.date}/${session.subjectId}`);

    const authored = await (options.authorTake ?? deterministicAuthorTake)({ session, brief });
    assertAuthoredTake(authored);
    const memo = mcpText<{ ok?: boolean; url?: string; error?: string }>(
      await client.callTool({
        name: "post_memo",
        arguments: {
          sessionId: String(session.id),
          title: `Starter take for ${session.subjectId}`,
          body: authored.body,
        },
      }),
    );
    if (!memo.ok || !memo.url) throw new Error(`post committee memo was rejected: ${memo.error ?? "missing URL"}`);

    const draft: SubmissionDraft = {
      memberId: options.memberId,
      date: session.date,
      subjectId: session.subjectId,
      nonce: crypto.randomUUID(),
      ...authored,
      memoUrl: memo.url,
    };
    const { canonical, signature } = await signDraft("mcp", draft, options.privateKey);
    const signingPayload = mcpText<{ canonical?: string }>(
      await client.callTool({ name: "get_signing_payload", arguments: { ...draft } }),
    );
    if (signingPayload.canonical !== canonical) {
      throw new Error("MCP get_signing_payload bytes differ from @robotmoney/contract canonicalizeSubmission");
    }
    const submitted = mcpText<{ ok?: boolean; verified?: boolean; error?: string }>(
      await client.callTool({
        name: "submit_recommendation",
        arguments: { ...draft, signature },
      }),
    );
    if (!submitted.ok || submitted.verified !== true) {
      throw new Error(`MCP recommendation was not verified: ${submitted.error ?? JSON.stringify(submitted)}`);
    }
    const readback = mcpText<{ takes?: CommitteeTake[] }>(
      await client.callTool({
        name: "get_session",
        arguments: { date: session.date, subject: session.subjectId },
      }),
    );
    return { transport: "mcp", draft, canonical, signature, take: verifiedTake(readback, options.memberId) };
  } finally {
    await client.close();
  }
}

export async function runStarterCommitteeAgent(options: StarterOptions): Promise<StarterResult> {
  const normalized: StarterOptions = {
    ...options,
    backendUrl: normalizedBaseUrl(options.backendUrl, "BACKEND_URL"),
    mcpUrl: options.mcpUrl ? normalizedBaseUrl(options.mcpUrl, "MCP_URL") : undefined,
  };
  return normalized.transport === "rest" ? runRest(normalized) : runMcp(normalized);
}

async function importPrivateKey(rawJwk: string): Promise<CryptoKey> {
  let jwk: JsonWebKey;
  try {
    jwk = JSON.parse(rawJwk) as JsonWebKey;
  } catch {
    throw new Error("COMMITTEE_PRIVATE_KEY_JWK must contain valid JSON");
  }
  return crypto.subtle.importKey("jwk", jwk, "Ed25519", false, ["sign"]);
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parseTransport(argv: string[]): StarterTransport {
  const inline = argv.find((arg) => arg.startsWith("--transport="))?.split("=", 2)[1];
  const index = argv.indexOf("--transport");
  const value = inline ?? (index >= 0 ? argv[index + 1] : undefined);
  if (value !== "rest" && value !== "mcp") {
    throw new Error("pass --transport=rest or --transport=mcp");
  }
  return value;
}

async function adminJson<T>(backendUrl: string, adminToken: string, action: string, body: unknown): Promise<T> {
  return restJson<T>(backendUrl, routePath(ROUTES.committee.admin.action, { action }), `starter e2e ${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Admin-Token": adminToken },
    body: JSON.stringify(body),
  });
}

async function e2eCredentials(
  transport: StarterTransport,
  backendUrl: string,
  adminToken: string,
): Promise<StarterCredentials> {
  const memberId = `starter-${transport}`;
  const keys = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
  const publicKey = asBase64(await crypto.subtle.exportKey("raw", keys.publicKey));
  const registered = await restJson<{ token?: string; error?: string }>(
    backendUrl,
    ROUTES.committee.register,
    `register ${memberId}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Admin-Token": adminToken },
      body: JSON.stringify({
        memberId,
        name: `Starter ${transport.toUpperCase()}`,
        lens: "starter-agent-live-stack",
        publicKey,
      }),
    },
  );
  if (!registered.token) throw new Error(`register ${memberId} returned no token: ${registered.error ?? "unknown error"}`);
  return { memberId, memberToken: registered.token, privateKey: keys.privateKey };
}

async function ensureE2eOpenSession(backendUrl: string, adminToken: string): Promise<void> {
  const open = await restJson<StarterSession | null>(
    backendUrl,
    ROUTES.committee.openSession,
    "discover starter e2e session",
  );
  if (open) return;

  const date = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
  const subject = { id: "starter-agent", name: "Starter Agent Exercise" };
  await adminJson(backendUrl, adminToken, "subject_fixtures", { ...subject, date });
  const scheduled = await adminJson<{ id?: string | number }>(backendUrl, adminToken, "open", {
    date,
    subjectId: subject.id,
  });
  if (scheduled.id === undefined) throw new Error("starter e2e open returned no session id");
  await adminJson(backendUrl, adminToken, "brief", {
    sessionId: String(scheduled.id),
    windowMinutes: 60,
  });
}

async function main(): Promise<void> {
  const transport = parseTransport(process.argv.slice(2));
  const backendUrl = normalizedBaseUrl(requiredEnv("BACKEND_URL"), "BACKEND_URL");
  const e2e = process.argv.includes("--e2e");

  let credentials: StarterCredentials;
  if (e2e) {
    const adminToken = requiredEnv("ADMIN_TOKEN");
    await ensureE2eOpenSession(backendUrl, adminToken);
    credentials = await e2eCredentials(transport, backendUrl, adminToken);
  } else {
    credentials = {
      memberId: requiredEnv("COMMITTEE_MEMBER_ID"),
      memberToken: requiredEnv("COMMITTEE_MEMBER_TOKEN"),
      privateKey: await importPrivateKey(requiredEnv("COMMITTEE_PRIVATE_KEY_JWK")),
    };
  }

  const result = await runStarterCommitteeAgent({
    ...credentials,
    transport,
    backendUrl,
    mcpUrl: transport === "mcp" ? requiredEnv("MCP_URL") : process.env.MCP_URL,
  });
  console.log(
    `starter committee agent (${result.transport}) submitted take ${result.take.id} ` +
      `for ${result.draft.date}/${result.draft.subjectId}: verified=true`,
  );
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`starter committee agent failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
