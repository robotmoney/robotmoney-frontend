// Stage 2 (docs/plans/onboarding-ic-workflow.md Phase 3 / docs/architecture.md
// §11 R5/R6) — the MCP server's anonymous, pre-credential discovery surface.
// A session with NO bearer must initialize (not be rejected) and expose
// EXACTLY two tools: `apply-how-to` and `apply`. Every member tool
// (get_brief, submit_recommendation, ...) must stay absent from that session
// AND the pre-existing "no bearer / bad bearer" rejection for the member
// toolset must still hold — this file pins BOTH behaviors so Stage 2 cannot
// silently weaken auth while adding discovery.
//
// Hermetic: this test starts the REAL mcp/src/server.ts (real McpServer
// instances, real Streamable HTTP transport, real MCP Client) against a tiny
// in-process fixture backend that implements only what apply/verify-token
// need — including REAL ed25519 verification (crypto.subtle), so a validly
// signed `apply` call and a badly-signed one exercise the actual signature
// check, not a mock of it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  APPLY_HOW_TO_STEPS,
  canonicalizeApplication,
  COMMITTEE_ONBOARDING_SKILL_URL,
  ROUTES,
} from "@robotmoney/contract";
import { generateKeyPair, sign } from "../src/crypto.ts";

// Dedicated, unused port for this file's real MCP server instance (module-level
// side effect on import — see below). Not 0/ephemeral: server.ts's own Bun.serve
// call reads process.env.MCP_PORT once at import time and nothing in this file
// can observe an OS-assigned port afterwards.
const MCP_TEST_PORT = 18799;
const MCP_URL = `http://localhost:${MCP_TEST_PORT}/mcp`;
const VALID_MEMBER_TOKEN = "capacity-test-member-token";

// ── Fixture backend: only what `apply`/`verify-token` need ──────────────────
// Real signature verification (crypto.subtle), matching backend/src/lib/
// signing.ts's contract shapes exactly (Stage 1 interface): 201 {ok,status,
// memberId,memberStatus} / 400 {ok:false,status:400,error}. Everything else is
// unused by this file's tests and 404s loudly rather than silently no-op'ing.
let fixtureBackend: ReturnType<typeof Bun.serve>;
let server: typeof import("../src/server.ts");

beforeAll(async () => {
  fixtureBackend = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === ROUTES.committee.apply && req.method === "POST") {
        const body = (await req.json()) as { name?: string; contact?: string; lens?: string; publicKey?: string; signature?: string };
        let verified = false;
        try {
          const pub = await crypto.subtle.importKey(
            "raw",
            Uint8Array.from(Buffer.from(body.publicKey ?? "", "base64")),
            { name: "Ed25519" },
            false,
            ["verify"],
          );
          const msg = new TextEncoder().encode(
            canonicalizeApplication({ name: body.name ?? "", contact: body.contact ?? "", lens: body.lens, publicKey: body.publicKey ?? "" }),
          );
          verified = await crypto.subtle.verify(
            { name: "Ed25519" },
            pub,
            Uint8Array.from(Buffer.from(body.signature ?? "", "base64")),
            msg,
          );
        } catch {
          verified = false;
        }
        if (!verified) {
          return Response.json({ ok: false, status: 400, error: "invalid signature over the canonical application payload" }, { status: 400 });
        }
        return Response.json({ ok: true, status: 201, memberId: crypto.randomUUID(), memberStatus: "applied" }, { status: 201 });
      }
      if (url.pathname === ROUTES.committee.verifyToken) {
        // Exactly one legacy bearer resolves, for the capacity-isolation test
        // below, which needs a real authenticated session to open. Every other
        // bearer fails to resolve, so the "authenticated-but-not-yet-OAuth'd"
        // pin further down still holds.
        const presented = (req.headers.get("Authorization") ?? "").replace(/^Bearer /, "");
        if (presented === VALID_MEMBER_TOKEN) return Response.json({ memberId: "capacity-test-member" });
        return Response.json({ error: "invalid token" }, { status: 401 });
      }
      return Response.json({ error: `unhandled fixture route: ${req.method} ${url.pathname}` }, { status: 404 });
    },
  });

  process.env.BACKEND_URL = `http://localhost:${fixtureBackend.port}`;
  process.env.MCP_PORT = String(MCP_TEST_PORT);
  // Side-effecting import: this is the REAL server.ts, started once for the
  // whole file (module cache — importing it again elsewhere would be a no-op).
  server = await import("../src/server.ts");
});

afterAll(() => {
  clearInterval(server.idleSweepInterval);
  server.httpServer.stop(true);
  fixtureBackend.stop(true);
});

async function connect(bearer: string | null): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: bearer ? { headers: { Authorization: `Bearer ${bearer}` } } : {},
  });
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

const MEMBER_TOOLS = [
  "get_regime", "get_open_session", "list_sessions", "get_brief", "get_subject_snapshot",
  "get_session", "get_signing_payload", "submit_recommendation", "post_memo",
  "classify_regime", "concentration_metrics",
];

describe("anonymous MCP session (no bearer at init)", () => {
  test("initializes successfully and lists EXACTLY apply-how-to and apply", async () => {
    const client = await connect(null);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["apply", "apply-how-to"]);
  });

  test("every member tool is absent — calling one by name is refused, not silently run", async () => {
    // The SDK reports an unregistered tool as a CallToolResult with
    // isError:true (a recoverable tool-execution error), not a rejected
    // promise/transport-level error — assert on that shape, not on `.rejects`.
    const client = await connect(null);
    for (const name of MEMBER_TOOLS) {
      const result = await client.callTool({ name, arguments: {} });
      expect(result.isError).toBe(true);
      expect((result.content as any[])[0].text).toMatch(/not found/i);
    }
  });

  test("apply-how-to content is sourced from the Stage 0 contract constants, not a copy-pasted string", async () => {
    const client = await connect(null);
    const result = await client.callTool({ name: "apply-how-to", arguments: {} });
    const body = JSON.parse((result.content as any[])[0].text);

    // §11.2 step names — deep-equal against the LIVE import, so this can never
    // silently drift from what Stage 0 actually exports.
    expect(body.steps).toEqual(APPLY_HOW_TO_STEPS);
    expect(body.steps.map((s: { step: string }) => s.step)).toEqual(["toolchain", "apply", "review", "claim"]);

    // Canonical payload description: field set derived from the SAME
    // canonicalizeApplication the backend verifies against.
    expect(body.payload.fields).toEqual(["name", "contact", "lens", "publicKey", "signature"]);
    expect(body.payload.description).toMatch(/canonical/i);
    expect(body.payload.description).toMatch(/signature/i);

    // Routes — against the live ROUTES import.
    expect(body.routes.apply).toBe(ROUTES.committee.apply);
    expect(body.routes.applyStatus).toBe(ROUTES.committee.applyStatus);

    // The (placeholder) skill link — against the live constant, never a copy.
    expect(body.skillUrl).toBe(COMMITTEE_ONBOARDING_SKILL_URL);
  });

  test("apply forwards a validly-signed payload to the backend and returns the server-minted UUID", async () => {
    const client = await connect(null);
    const { publicKeyB64, privateKey } = await generateKeyPair();
    const application = { name: "Nova Desk", contact: "nova@example.test", publicKey: publicKeyB64 };
    const signature = await sign(canonicalizeApplication(application), privateKey);

    const result = await client.callTool({ name: "apply", arguments: { ...application, signature } });
    const body = JSON.parse((result.content as any[])[0].text);

    expect(body.status).toBe(201);
    expect(body.ok).toBe(true);
    expect(body.memberStatus).toBe("applied");
    expect(body.memberId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  test("apply propagates the backend's 400 on a badly-signed payload — not swallowed into a success or a generic error", async () => {
    const client = await connect(null);
    const { publicKeyB64 } = await generateKeyPair();
    const bogusSignature = Buffer.alloc(64, 7).toString("base64");

    const result = await client.callTool({
      name: "apply",
      arguments: { name: "Ghost", contact: "ghost@example.test", publicKey: publicKeyB64, signature: bogusSignature },
    });
    const body = JSON.parse((result.content as any[])[0].text);

    expect(body.status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/invalid signature/i);
  });
});

describe("anonymous sessions cannot exhaust authenticated capacity (§11 R5 DoS boundary)", () => {
  test("flooding the anonymous pool to its cap is refused, but an AUTHENTICATED session still connects and works", async () => {
    // Bounded above by MAX_ANONYMOUS_SESSIONS (50 in src/server.ts) plus a
    // small margin for any anonymous sessions earlier tests in this file left
    // open — opened ONE AT A TIME until the pool-full error is actually
    // observed, so this doesn't assume a clean starting point or a specific
    // prior-test cleanup discipline; it just proves the cap is real.
    const clients: Client[] = [];
    let capacityErrorSeen = false;
    for (let i = 0; i < 60 && !capacityErrorSeen; i++) {
      try {
        clients.push(await connect(null));
      } catch (err) {
        expect(String(err)).toMatch(/anonymous session capacity/i);
        capacityErrorSeen = true;
      }
    }
    expect(capacityErrorSeen).toBe(true);

    // The actual property under test: real members are never affected by an
    // anonymous flood. An authenticated connection must still succeed and its
    // member tools must still work, proving the two capacity pools are
    // genuinely separate (not sharing MAX_SESSIONS).
    const memberClient = await connect(VALID_MEMBER_TOKEN);
    const { tools } = await memberClient.listTools();
    expect(tools.map((t) => t.name)).toContain("get_regime");

    for (const c of clients) await c.close();
    await memberClient.close();
  }, 20_000);
});

describe("authenticated-but-not-yet-OAuth'd session still refuses (existing behavior, unweakened)", () => {
  test("a bearer that fails to resolve (unknown/legacy-invalid token) gets 401, not the anonymous OR member surface", async () => {
    await expect(connect("not-a-real-token")).rejects.toThrow();
  });
});
