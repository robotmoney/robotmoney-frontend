// The STANDING PARTICIPANT container's entrypoint
// (scripts/agent/participant/main.ts, smoke-production-spec.md §6.2/§7.2,
// issue #1026 W3.2).
//
// WHAT THESE PIN:
//
//   - THE STARTUP DIAGNOSTIC IS HTTP ONLY (spec §7.2). Three questions: is the
//     API reachable, is this token valid, and does it authenticate as the
//     member id this container was started for. No psql, no connection string,
//     no schema question. A participant is not entitled to know the database
//     exists — and if it held a database token, §6.3's "third parties may
//     supply every participant" would be a fiction, because our own
//     participants would ride a rail nobody outside can ride.
//   - AN IDENTITY MISMATCH REFUSES rather than adopting the server's answer. A
//     container that discovers it is authenticating as somebody else has been
//     handed the wrong key, and continuing would file one member's take under
//     another's name.
//   - ONE TAKE IN FLIGHT (spec §6.2). `pollForWork` returns AT MOST ONE item
//     even when the API offers several, because batching reintroduces the
//     overlap the idempotent `(session, member)` key exists to bound.
//   - A 401 IS TERMINAL, a transport error is not. The API restarting during a
//     deploy must not kill every participant; a revoked token or a rebound key
//     (spec §6.4 step 2) must.
//   - THE MODULE HOLDS NO DATABASE CREDENTIAL AND NO DOCKER SOCKET. Both were
//     true of predecessors; #1014's `agent-launcher` mounted
//     `/var/run/docker.sock`, which is root on the host handed to a process
//     that runs model-authored code.
//
// The environment variable NAMES below are this file's contract with the
// compose `participant` profile: RM_API_URL / RM_MEMBER_ID / RM_MEMBER_TOKEN /
// RM_MEMBER_NAME / RM_MEMBER_IDENTITY are the names the existing member rail
// already uses (scripts/lib/swarm/persona-keys.ts, scripts/agent/*), and the
// participant-only settings extend that same prefix.
//
// Cost class `unit` (docs/architecture.md §3 L1): a stubbed `fetch` and a
// source scan — no Docker, no database, no network.
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  pollForWork,
  readParticipantConfig,
  runStartupDiagnostic,
  type ParticipantConfig,
} from "../../agent/participant/main.ts";
import type { PersonaIdentity } from "../../lib/swarm/persona-keys.ts";

const IDENTITY: PersonaIdentity = {
  publicKeyB64: "pub-athena",
  privateJwk: { kty: "OKP", crv: "Ed25519", x: "pub-athena", d: "priv-athena" },
};

const ENV = {
  RM_API_URL: "http://website-server:8080",
  RM_MEMBER_NAME: "athena",
  RM_PARTICIPANT_KIND: "agent",
  RM_MEMBER_ID: "m-athena",
  RM_MEMBER_TOKEN: "member-bearer-token",
  RM_MEMBER_IDENTITY: JSON.stringify(IDENTITY),
  RM_POLL_INTERVAL_MS: "5000",
  RM_TAKE_TIMEOUT_MS: "600000",
  RM_WORKSPACE_ROOT: "/var/lib/rm/takes",
} as const;

const config = (over: Partial<ParticipantConfig> = {}): ParticipantConfig => ({
  apiUrl: "http://website-server:8080",
  name: "athena",
  kind: "agent",
  memberId: "m-athena",
  token: "member-bearer-token",
  identity: IDENTITY,
  pollIntervalMs: 5_000,
  takeTimeoutMs: 600_000,
  workspaceRoot: "/var/lib/rm/takes",
  ...over,
});

const MAIN_SOURCE = readFileSync(join(import.meta.dir, "..", "..", "agent", "participant", "main.ts"), "utf8");

// ── CONFIGURATION: explicit injection, own key only ────────────────────────
describe("readParticipantConfig — every value is an explicit injection", () => {
  test("a complete participant environment reads into the whole configuration", () => {
    expect(readParticipantConfig({ ...ENV })).toEqual(config());
  });

  test("a JUDGE container is configured through the same function", () => {
    const cfg = readParticipantConfig({
      ...ENV,
      RM_MEMBER_NAME: "themis",
      RM_PARTICIPANT_KIND: "judge",
      RM_MEMBER_ID: "m-themis",
    });
    expect(cfg.kind).toBe("judge");
    expect(cfg.name).toBe("themis");
  });

  test("an unknown participant kind refuses — there are exactly two namespaces", () => {
    expect(() => readParticipantConfig({ ...ENV, RM_PARTICIPANT_KIND: "observer" })).toThrow(/observer/);
  });

  test("a spoof-keys generation is carried when present, and absent otherwise", () => {
    expect(readParticipantConfig({ ...ENV, RM_SPOOF_GENERATION_ID: "gen-2" }).generationId).toBe("gen-2");
    expect(readParticipantConfig({ ...ENV }).generationId).toBeUndefined();
  });

  test.each([
    "RM_API_URL",
    "RM_MEMBER_NAME",
    "RM_MEMBER_ID",
    "RM_MEMBER_TOKEN",
    "RM_MEMBER_IDENTITY",
  ])("a missing %s refuses — a container that polls and never takes is worse than a crash loop", (key) => {
    const env: Record<string, string | undefined> = { ...ENV };
    delete env[key];
    // The refusal NAMES the value that was not injected — a crash loop an
    // operator can read is the point.
    expect(() => readParticipantConfig(env)).toThrow(new RegExp(key));
  });

  test("an EMPTY required value refuses as loudly as an absent one", () => {
    expect(() => readParticipantConfig({ ...ENV, RM_MEMBER_TOKEN: "" })).toThrow(/RM_MEMBER_TOKEN/);
    expect(() => readParticipantConfig({ ...ENV, RM_MEMBER_ID: "   " })).toThrow(/RM_MEMBER_ID/);
  });

  test("a malformed RM_MEMBER_IDENTITY refuses — a key it cannot sign with is not a key", () => {
    expect(() => readParticipantConfig({ ...ENV, RM_MEMBER_IDENTITY: "not json" })).toThrow(/RM_MEMBER_IDENTITY/);
    expect(() =>
      readParticipantConfig({ ...ENV, RM_MEMBER_IDENTITY: JSON.stringify({ publicKeyB64: "pub" }) }),
    ).toThrow(/privateJwk/);
  });

  test("a DATABASE_URL in the environment REFUSES — the compose profile leaked a credential", () => {
    expect(() =>
      readParticipantConfig({ ...ENV, DATABASE_URL: "postgres://rm_app:secret@db:5432/robotmoney" }),
    ).toThrow(/DATABASE_URL/);
  });

  test("any connection string refuses, whatever it is called", () => {
    for (const key of ["DATABASE_URL", "RM_DATABASE_URL", "PREFLIGHT_DATABASE_URL", "POSTGRES_URL"]) {
      expect(() => readParticipantConfig({ ...ENV, [key]: "postgres://rm_worker:x@db:5432/robotmoney" })).toThrow(
        new RegExp(key),
      );
    }
  });
});

// ── THE HTTP-ONLY STARTUP DIAGNOSTIC (spec §7.2) ──────────────────────────
describe("runStartupDiagnostic — three HTTP questions, and no database question", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function api(handler: (url: string) => Response | Promise<Response>) {
    const urls: string[] = [];
    globalThis.fetch = (async (input: any): Promise<Response> => {
      const url = String(input);
      urls.push(url);
      return handler(url);
    }) as typeof fetch;
    return urls;
  }

  test("a reachable API, a valid token and a matching identity is all-green", async () => {
    api(() => new Response(JSON.stringify({ memberId: "m-athena" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    expect(await runStartupDiagnostic(config())).toEqual({
      apiReachable: true,
      tokenValid: true,
      serverMemberId: "m-athena",
      identityMatchesRoster: true,
    });
  });

  test("a 401 means the token is invalid while the API was reachable", async () => {
    api(() => new Response(JSON.stringify({ error: "unknown member token" }), { status: 401 }));
    const d = await runStartupDiagnostic(config());
    expect(d.apiReachable).toBe(true);
    expect(d.tokenValid).toBe(false);
    expect(d.serverMemberId).toBeNull();
    expect(d.identityMatchesRoster).toBe(false);
  });

  test("an unreachable API is reported as unreachable, not as an invalid token", async () => {
    api(() => {
      throw new Error("ECONNREFUSED website-server:8080");
    });
    const d = await runStartupDiagnostic(config());
    expect(d.apiReachable).toBe(false);
    expect(d.tokenValid).toBe(false);
  });

  test("an IDENTITY MISMATCH is reported, and the server's answer is NOT adopted", async () => {
    // Authenticating as somebody else means the wrong key was handed over.
    api(() => new Response(JSON.stringify({ memberId: "m-robot-money" }), { status: 200 }));
    const cfg = config({ memberId: "m-athena" });
    const d = await runStartupDiagnostic(cfg);
    expect(d.tokenValid).toBe(true);
    expect(d.serverMemberId).toBe("m-robot-money");
    expect(d.identityMatchesRoster).toBe(false);
    expect(cfg.memberId).toBe("m-athena");
  });

  test("the diagnostic sends its OWN bearer, never another participant's", async () => {
    let auth = "";
    globalThis.fetch = (async (_input: any, init?: any): Promise<Response> => {
      auth = String(new Headers(init?.headers ?? {}).get("authorization") ?? "");
      return new Response(JSON.stringify({ memberId: "m-athena" }), { status: 200 });
    }) as typeof fetch;
    await runStartupDiagnostic(config({ token: "athena-only-token" }));
    expect(auth).toContain("athena-only-token");
  });

  test("it speaks HTTP to the configured API and NOTHING else — no database endpoint is touched", async () => {
    const urls = api(() => new Response(JSON.stringify({ memberId: "m-athena" }), { status: 200 }));
    await runStartupDiagnostic(config());
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url.startsWith("http://website-server:8080")).toBe(true);
      expect(url).not.toContain("postgres");
      expect(url).not.toContain("5432");
    }
  });

  test("a judge's diagnostic is the same three questions — the judge is a participant", async () => {
    api(() => new Response(JSON.stringify({ memberId: "m-themis" }), { status: 200 }));
    const d = await runStartupDiagnostic(config({ kind: "judge", name: "themis", memberId: "m-themis" }));
    expect(d.identityMatchesRoster).toBe(true);
  });
});

// ── ONE TAKE IN FLIGHT ─────────────────────────────────────────────────────
describe("pollForWork — at most ONE item, and a 401 is terminal", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function respond(body: unknown, status = 200) {
    globalThis.fetch = (async (_input?: any): Promise<Response> =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })) as typeof fetch;
  }

  test("nothing to do is `null`, not an empty list the loop has to interpret", async () => {
    respond({ pending: [] });
    expect(await pollForWork(config())).toBeNull();
  });

  test("one pending session returns its coordinates — session, subject and date only", async () => {
    respond({
      pending: [{ sessionId: "s-1", subjectId: "woon", date: "2026-09-23" }],
    });
    expect(await pollForWork(config())).toEqual({ sessionId: "s-1", subjectId: "woon", date: "2026-09-23" });
  });

  test("THREE pending sessions still return exactly ONE — one take in flight per participant", async () => {
    respond({
      pending: [
        { sessionId: "s-1", subjectId: "woon", date: "2026-09-23" },
        { sessionId: "s-2", subjectId: "aave", date: "2026-09-23" },
        { sessionId: "s-3", subjectId: "eth", date: "2026-09-23" },
      ],
    });
    const work = await pollForWork(config());
    expect(work).not.toBeNull();
    expect(Array.isArray(work)).toBe(false);
    expect(work?.sessionId).toBe("s-1");
  });

  test("a TRANSPORT error is not a refusal — the API restarting during a deploy must not kill the container", async () => {
    globalThis.fetch = (async (_input?: any): Promise<Response> => {
      throw new Error("ECONNREFUSED website-server:8080");
    }) as typeof fetch;
    expect(await pollForWork(config())).toBeNull();
  });

  test("a 5xx is likewise survivable — the loop sleeps and retries", async () => {
    respond({ error: "upstream" }, 503);
    expect(await pollForWork(config())).toBeNull();
  });

  test("a 401 IS terminal — the token was revoked or the key was rebound (spec §6.4 step 2)", async () => {
    respond({ error: "unknown member token" }, 401);
    await expect(pollForWork(config())).rejects.toThrow(/401|token/);
  });

  test("the poll carries this participant's own bearer", async () => {
    let auth = "";
    globalThis.fetch = (async (_input: any, init?: any): Promise<Response> => {
      auth = String(new Headers(init?.headers ?? {}).get("authorization") ?? "");
      return new Response(JSON.stringify({ pending: [] }), { status: 200 });
    }) as typeof fetch;
    await pollForWork(config({ token: "athena-only-token" }));
    expect(auth).toContain("athena-only-token");
  });
});

// ── NO DATABASE CREDENTIAL, NO DOCKER SOCKET (spec §7.2, §6.2) ────────────
describe("the participant module holds no database credential and no Docker socket", () => {
  /** The module's CODE, with its prose stripped — the header discusses the
   * forbidden rails at length, and explaining one is not holding one. */
  const CODE = MAIN_SOURCE.replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");

  test("it imports nothing that opens a database connection, and REFUSES an environment that leaks one", () => {
    const imports = [...CODE.matchAll(/^\s*import\s+(?!type\b)[^;]*from\s+"([^"]+)"/gm)].map((m) => m[1] ?? "");
    for (const spec of imports) {
      expect(spec).not.toBe("postgres");
      expect(spec).not.toBe("pg");
      expect(spec).not.toContain("/db/");
      expect(spec).not.toContain("db-client");
      expect(spec).not.toContain("preflight");
    }
    // Holding none is only half of it: finding one means the compose profile
    // leaked a credential, and that refuses.
    expect(() =>
      readParticipantConfig({ ...ENV, DATABASE_URL: "postgres://rm_app:secret@db:5432/robotmoney" }),
    ).toThrow(/DATABASE_URL/);
  });

  test("no connection string appears in its code, nor in the configuration it accepts", () => {
    expect(CODE).not.toContain("postgres://");
    expect(CODE).not.toContain("postgresql://");
    const cfg = readParticipantConfig({ ...ENV });
    expect(JSON.stringify(cfg)).not.toContain("postgres://");
    expect(Object.keys(cfg)).not.toContain("databaseUrl");
  });

  test("it names no Docker socket in its code, and holds no socket in its configuration", () => {
    expect(CODE).not.toContain("/var/run/docker.sock");
    expect(CODE).not.toContain("dockerode");
    expect(Object.keys(readParticipantConfig({ ...ENV }))).not.toContain("dockerSocket");
  });
});
