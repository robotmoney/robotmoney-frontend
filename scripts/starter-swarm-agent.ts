#!/usr/bin/env bun
/**
 * Runnable, model-free starter for one Robot Money swarm member.
 *
 * Import `runStarterSwarmAgent` and provide your own `AuthorTake` callback
 * to connect an inference runtime. The CLI deliberately defaults to a
 * deterministic author so the signing and transport path can be exercised
 * without a model, API key, or hidden fallback.
 */
import { canonicalizeSubmission, path as routePath, ROUTES } from "@robotmoney/contract";
import type { SwarmBrief, SwarmSession, SwarmTake } from "@robotmoney/contract";

// D21 retired the MCP transport (docs/decisions.md D21); REST is the only
// transport. The type is kept (single-valued) so the exported signing helpers
// and their unit tests keep a stable shape.
export type StarterTransport = "rest";

export interface StarterSession extends Omit<SwarmSession, "id"> {
  id: string | number;
}

export interface AuthorTakeInput {
  session: StarterSession;
  brief: SwarmBrief;
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
  authorTake?: AuthorTake;
}

export interface StarterResult {
  transport: StarterTransport;
  draft: SubmissionDraft;
  canonical: string;
  signature: string;
  take: SwarmTake;
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
 * The submission enters the repo-owned canonicalization path (the same bytes
 * the backend verifier reconstructs). Retained as a named helper so its unit
 * test can pin the contract serializer directly.
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

function assertAuthoredTake(take: AuthoredTake): void {
  if (!take.body.trim()) throw new Error("AuthorTake returned an empty body");
  if (!Number.isFinite(take.confidence) || take.confidence < 0 || take.confidence > 1) {
    throw new Error(`AuthorTake confidence must be between 0 and 1 (got ${take.confidence})`);
  }
}

function verifiedTake(readback: { takes?: SwarmTake[] }, memberId: string): SwarmTake {
  const take = readback.takes?.find((candidate) => candidate.memberId === memberId);
  if (!take) throw new Error(`verified readback did not contain member ${memberId}`);
  if (take.verified !== true) throw new Error(`readback for member ${memberId} was not server-verified`);
  return take;
}

async function runRest(options: StarterOptions): Promise<StarterResult> {
  const session = await restJson<StarterSession | null>(
    options.backendUrl,
    ROUTES.swarm.openSession,
    "discover open session",
  );
  if (!session) throw new Error("no swarm session is currently collecting");
  const brief = await restJson<SwarmBrief | null>(
    options.backendUrl,
    `${ROUTES.swarm.brief}?date=${encodeURIComponent(session.date)}&subject=${encodeURIComponent(session.subjectId)}`,
    "read swarm brief",
  );
  if (!brief) throw new Error(`no brief exists for ${session.date}/${session.subjectId}`);

  const authored = await (options.authorTake ?? deterministicAuthorTake)({ session, brief });
  assertAuthoredTake(authored);
  const memo = await restJson<{ ok?: boolean; url?: string; error?: string }>(
    options.backendUrl,
    ROUTES.swarm.memos,
    "post swarm memo",
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
  if (!memo.ok || !memo.url) throw new Error(`post swarm memo was rejected: ${memo.error ?? "missing URL"}`);

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
    ROUTES.swarm.submit,
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
  const readback = await restJson<{ takes?: SwarmTake[] }>(
    options.backendUrl,
    routePath(ROUTES.swarm.session, { date: session.date, subject: session.subjectId }),
    "read back REST recommendation",
  );
  return { transport: "rest", draft, canonical, signature, take: verifiedTake(readback, options.memberId) };
}

export async function runStarterSwarmAgent(options: StarterOptions): Promise<StarterResult> {
  const normalized: StarterOptions = {
    ...options,
    backendUrl: normalizedBaseUrl(options.backendUrl, "BACKEND_URL"),
  };
  return runRest(normalized);
}

async function importPrivateKey(rawJwk: string): Promise<CryptoKey> {
  let jwk: JsonWebKey;
  try {
    jwk = JSON.parse(rawJwk) as JsonWebKey;
  } catch {
    throw new Error("SWARM_PRIVATE_KEY_JWK must contain valid JSON");
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
  // REST is the only transport (D21). A bare invocation (no flag) defaults to
  // it; --transport=rest stays accepted; anything else is rejected loudly so a
  // stale --transport=mcp invocation fails fast instead of silently.
  if (value !== undefined && value !== "rest") {
    throw new Error("only --transport=rest is supported (the MCP transport was retired, D21)");
  }
  return "rest";
}

async function adminJson<T>(backendUrl: string, automationToken: string, action: string, body: unknown): Promise<T> {
  return restJson<T>(backendUrl, routePath(ROUTES.swarm.admin.action, { action }), `starter e2e ${action}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Automation-Token": automationToken,
    },
    body: JSON.stringify(body),
  });
}

async function e2eCredentials(
  transport: StarterTransport,
  backendUrl: string,
  automationToken: string,
): Promise<StarterCredentials> {
  const memberId = `starter-${transport}`;
  const keys = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
  const publicKey = asBase64(await crypto.subtle.exportKey("raw", keys.publicKey));
  const registered = await restJson<{ token?: string; error?: string }>(
    backendUrl,
    ROUTES.swarm.register,
    `register ${memberId}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Automation-Token": automationToken,
      },
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

async function ensureE2eOpenSession(backendUrl: string, automationToken: string): Promise<void> {
  const open = await restJson<StarterSession | null>(
    backendUrl,
    ROUTES.swarm.openSession,
    "discover starter e2e session",
  );
  if (open) return;

  const date = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
  const subject = { id: "starter-agent", name: "Starter Agent Exercise" };
  await adminJson(backendUrl, automationToken, "subject_fixtures", { ...subject, date });
  const scheduled = await adminJson<{ id?: string | number }>(backendUrl, automationToken, "open", {
    date,
    subjectId: subject.id,
  });
  if (scheduled.id === undefined) throw new Error("starter e2e open returned no session id");
  await adminJson(backendUrl, automationToken, "brief", {
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
    const automationToken = requiredEnv("AUTOMATION_TOKEN");
    await ensureE2eOpenSession(backendUrl, automationToken);
    credentials = await e2eCredentials(transport, backendUrl, automationToken);
  } else {
    credentials = {
      memberId: requiredEnv("SWARM_MEMBER_ID"),
      memberToken: requiredEnv("SWARM_MEMBER_TOKEN"),
      privateKey: await importPrivateKey(requiredEnv("SWARM_PRIVATE_KEY_JWK")),
    };
  }

  const result = await runStarterSwarmAgent({
    ...credentials,
    transport,
    backendUrl,
  });
  console.log(
    `starter swarm agent (${result.transport}) submitted take ${result.take.id} ` +
      `for ${result.draft.date}/${result.draft.subjectId}: verified=true`,
  );
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`starter swarm agent failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
