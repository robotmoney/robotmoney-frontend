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
//     participants would ride a rail nobody outside can ride. A 5xx is the API
//     failing, never an invalid token.
//   - AN IDENTITY MISMATCH REFUSES rather than adopting the server's answer. A
//     container that discovers it is authenticating as somebody else has been
//     handed the wrong key, and continuing would file one member's take under
//     another's name.
//   - ONE TAKE IN FLIGHT (spec §6.2). `pollForWork` returns AT MOST ONE item
//     even when the API offers several.
//   - A 401 IS TERMINAL, a transport error or a 5xx is not, and a 404 is an
//     ERROR: a missing pending route read as "no work" is how a participant
//     polled for ever in silence.
//   - THE PROCESS HOLDS NO DATABASE CREDENTIAL AND NO DOCKER SOCKET, proved at
//     runtime: every key and value of the environment is scanned, and a real
//     unix socket on disk refuses the boot. #1014's `agent-launcher` mounted
//     `/var/run/docker.sock`, which is root on the host handed to a process
//     that runs model-authored code.
//
// The environment variable NAMES below are this file's contract with the
// compose `participant` profile: RM_API_URL / RM_MEMBER_ID / RM_MEMBER_TOKEN /
// RM_MEMBER_NAME / RM_MEMBER_IDENTITY are the names the existing member rail
// already uses (scripts/lib/swarm/persona-keys.ts, scripts/agent/*), and the
// participant-only settings extend that same prefix.
//
// Cost class `unit` (docs/architecture.md §3 L1): a stubbed `fetch`, a temp
// directory and a unix socket bound inside it — no Docker, no database, no
// network.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertNoDockerSocket,
  defaultDockerSocketProbes,
  pollForWork,
  readParticipantConfig,
  runStartupDiagnostic,
  type ParticipantConfig,
} from "../../agent/participant/main.ts";
import { DB_CREDENTIAL_KEYS } from "../../lib/db-credential-keys.ts";
import type { PersonaIdentity } from "../../lib/swarm/persona-keys.ts";

const IDENTITY: PersonaIdentity = {
  publicKeyB64: "pub-athena",
  privateJwk: { kty: "OKP", crv: "Ed25519", x: "pub-athena", d: "priv-athena" },
};

const TAKE_COMMAND = ["bun", "/opt/rm/author-take.ts"];

const ENV = {
  RM_API_URL: "http://website-server:8080",
  RM_MEMBER_NAME: "athena",
  RM_PARTICIPANT_KIND: "agent",
  RM_MEMBER_ID: "m-athena",
  RM_MEMBER_TOKEN: "member-bearer-token",
  RM_MEMBER_IDENTITY: JSON.stringify(IDENTITY),
  RM_TAKE_COMMAND: JSON.stringify(TAKE_COMMAND),
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
  takeCommand: TAKE_COMMAND,
  pollIntervalMs: 5_000,
  takeTimeoutMs: 600_000,
  workspaceRoot: "/var/lib/rm/takes",
  ...over,
});

/**
 * Read a configuration with NO socket probes. The host running this suite may
 * itself have a Docker socket at the default paths (a CI runner does), and
 * that socket belongs to the host, not to the participant under test. The
 * probe cases below inject their own paths, including a real socket.
 */
const read = (env: Record<string, string | undefined>): ParticipantConfig =>
  readParticipantConfig(env, { dockerSocketProbePaths: [] });

const MAIN_SOURCE = readFileSync(join(import.meta.dir, "..", "..", "agent", "participant", "main.ts"), "utf8");

// ── CONFIGURATION: explicit injection, own key only ────────────────────────
describe("readParticipantConfig — every value is an explicit injection", () => {
  test("a complete participant environment reads into the whole configuration", () => {
    expect(read({ ...ENV })).toEqual(config());
  });

  test("a JUDGE container is configured through the same function", () => {
    const cfg = read({
      ...ENV,
      RM_MEMBER_NAME: "themis",
      RM_PARTICIPANT_KIND: "judge",
      RM_MEMBER_ID: "m-themis",
    });
    expect(cfg.kind).toBe("judge");
    expect(cfg.name).toBe("themis");
  });

  test("an unknown participant kind refuses — there are exactly two namespaces", () => {
    expect(() => read({ ...ENV, RM_PARTICIPANT_KIND: "observer" })).toThrow(/observer/);
  });

  test("a spoof-keys generation is carried when present, and absent otherwise", () => {
    expect(read({ ...ENV, RM_SPOOF_GENERATION_ID: "gen-2" }).generationId).toBe("gen-2");
    expect(read({ ...ENV }).generationId).toBeUndefined();
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
    expect(() => read(env)).toThrow(new RegExp(key));
  });

  test("an EMPTY required value refuses as loudly as an absent one", () => {
    expect(() => read({ ...ENV, RM_MEMBER_TOKEN: "" })).toThrow(/RM_MEMBER_TOKEN/);
    expect(() => read({ ...ENV, RM_MEMBER_ID: "   " })).toThrow(/RM_MEMBER_ID/);
  });

  test("a malformed RM_MEMBER_IDENTITY refuses — a key it cannot sign with is not a key", () => {
    expect(() => read({ ...ENV, RM_MEMBER_IDENTITY: "not json" })).toThrow(/RM_MEMBER_IDENTITY/);
    expect(() => read({ ...ENV, RM_MEMBER_IDENTITY: JSON.stringify({ publicKeyB64: "pub" }) })).toThrow(/privateJwk/);
  });

  test("an AGENT without RM_TAKE_COMMAND refuses at boot — it could be offered work and never author it", () => {
    const env: Record<string, string | undefined> = { ...ENV };
    delete env.RM_TAKE_COMMAND;
    expect(() => read(env)).toThrow(/RM_TAKE_COMMAND/);
    expect(() => read({ ...ENV, RM_TAKE_COMMAND: "   " })).toThrow(/RM_TAKE_COMMAND/);
  });

  test("a JUDGE needs no take command — its model work is not a take", () => {
    const env: Record<string, string | undefined> = { ...ENV, RM_PARTICIPANT_KIND: "judge" };
    delete env.RM_TAKE_COMMAND;
    expect(read(env).takeCommand).toEqual([]);
  });

  test("RM_TAKE_COMMAND reads as a JSON argv or a plain command, and a broken array refuses", () => {
    expect(read({ ...ENV, RM_TAKE_COMMAND: "/usr/local/bin/author --once" }).takeCommand).toEqual([
      "/usr/local/bin/author",
      "--once",
    ]);
    expect(() => read({ ...ENV, RM_TAKE_COMMAND: '["bun", ' })).toThrow(/RM_TAKE_COMMAND/);
    expect(() => read({ ...ENV, RM_TAKE_COMMAND: "[]" })).toThrow(/RM_TAKE_COMMAND/);
    expect(() => read({ ...ENV, RM_TAKE_COMMAND: '["bun", 3]' })).toThrow(/RM_TAKE_COMMAND/);
  });
});

// ── NO DATABASE CREDENTIAL: every key and every value (spec §7.2) ──────────
describe("readParticipantConfig — a database credential by any name or value refuses", () => {
  test("a DATABASE_URL in the environment REFUSES — the compose profile leaked a credential", () => {
    expect(() => read({ ...ENV, DATABASE_URL: "postgres://rm_app:secret@db:5432/robotmoney" })).toThrow(
      /DATABASE_URL/,
    );
  });

  test("any connection string refuses, whatever it is called", () => {
    for (const key of ["DATABASE_URL", "RM_DATABASE_URL", "PREFLIGHT_DATABASE_URL", "POSTGRES_URL"]) {
      expect(() => read({ ...ENV, [key]: "postgres://rm_worker:x@db:5432/robotmoney" })).toThrow(new RegExp(key));
    }
  });

  test("an INNOCUOUS key holding a postgres URL refuses — the value is the credential, not the name", () => {
    expect(() => read({ ...ENV, FOO: "postgres://rm_app:x@db/rm" })).toThrow(/FOO/);
    expect(() => read({ ...ENV, FOO: "  postgresql://rm_app:x@db:5432/rm  " })).toThrow(/FOO/);
  });

  test("a libpq keyword DSN under an innocuous key refuses — no URL scheme is needed to be a credential", () => {
    expect(() => read({ ...ENV, FOO: "host=db user=rm_app password=x" })).toThrow(/FOO/);
    expect(() => read({ ...ENV, BAR: "dbname=robotmoney user=rm_worker" })).toThrow(/BAR/);
  });

  test("the refusal names the KEY, never the secret in its value", () => {
    let message = "";
    try {
      read({ ...ENV, FOO: "host=db user=rm_app password=hunter2-secret" });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("FOO");
    expect(message).not.toContain("hunter2-secret");
  });

  test.each([...DB_CREDENTIAL_KEYS])("%s refuses BY NAME, even with a value that looks like nothing", (key) => {
    expect(() => read({ ...ENV, [key]: "x" })).toThrow(new RegExp(key));
  });

  test("the named libpq and per-role keys are all on the shared list", () => {
    for (const key of [
      "PGPASSWORD",
      "PGUSER",
      "PGPASSFILE",
      "RM_APP_PASSWORD",
      "RM_WORKER_PASSWORD",
      "RM_OWNER_PASSWORD",
      "RM_READONLY_PASSWORD",
    ]) {
      expect(DB_CREDENTIAL_KEYS as readonly string[]).toContain(key);
    }
  });

  test("POSTGRES_PASSWORD refuses too — the server's own variable has no business in a participant", () => {
    expect(() => read({ ...ENV, POSTGRES_PASSWORD: "x" })).toThrow(/POSTGRES_PASSWORD/);
  });

  test("ordinary values do not trip the value scan", () => {
    const cfg = read({
      ...ENV,
      NOTE: "user feedback: host was slow",
      HOSTNAME: "rm_participant_athena",
      LANG: "C.UTF-8",
    });
    expect(cfg.name).toBe("athena");
  });
});

// ── NO DOCKER SOCKET, PROVED AT RUNTIME (spec §6.2) ────────────────────────
describe("assertNoDockerSocket — a participant given a socket by ANY route refuses", () => {
  const cleanups: (() => void | Promise<void>)[] = [];
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.();
  });

  /** A REAL unix socket, bound by `net.createServer` inside a fresh temp dir. */
  async function realSocket(): Promise<{ dir: string; path: string }> {
    const dir = mkdtempSync(join(tmpdir(), "rm-participant-sock-"));
    const path = join(dir, "docker.sock");
    const server: Server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, () => resolve());
    });
    cleanups.push(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    });
    return { dir, path };
  }

  test("DOCKER_HOST=unix:///var/run/docker.sock refuses, naming DOCKER_HOST", () => {
    expect(() => read({ ...ENV, DOCKER_HOST: "unix:///var/run/docker.sock" })).toThrow(/DOCKER_HOST/);
  });

  test("DOCKER_HOST=tcp://h:2375 refuses — a remote daemon is the same root on a host", () => {
    expect(() => read({ ...ENV, DOCKER_HOST: "tcp://h:2375" })).toThrow(/DOCKER_HOST/);
  });

  test.each(["DOCKER_CONTEXT", "DOCKER_SOCK", "DOCKER_SOCKET", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH", "CONTAINER_HOST"])(
    "%s refuses — a daemon setting reaches a daemon",
    (key) => {
      expect(() => read({ ...ENV, [key]: "anything" })).toThrow(new RegExp(key));
    },
  );

  test("a value naming docker.sock under an innocuous key refuses", () => {
    expect(() => read({ ...ENV, SOME_MOUNT: "/var/run/docker.sock" })).toThrow(/SOME_MOUNT/);
    expect(() => read({ ...ENV, SOME_MOUNT: "/run/user/1000/podman/podman.sock" })).toThrow(/SOME_MOUNT/);
  });

  test("a REAL unix socket at a probe path refuses the boot, naming the path", async () => {
    const { path } = await realSocket();
    expect(() => readParticipantConfig({ ...ENV }, { dockerSocketProbePaths: [path] })).toThrow(
      new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
    expect(() => assertNoDockerSocket({}, [path])).toThrow(/socket/);
  });

  test("a SYMLINK to a real socket refuses too — a mount can arrive through a link", async () => {
    const { dir, path } = await realSocket();
    const link = join(dir, "linked.sock");
    symlinkSync(path, link);
    expect(() => assertNoDockerSocket({}, [link])).toThrow(/socket/);
  });

  test("a regular FILE named docker.sock is not a socket, and a missing path is not a finding", () => {
    const dir = mkdtempSync(join(tmpdir(), "rm-participant-sock-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, "docker.sock");
    writeFileSync(file, "");
    expect(() => assertNoDockerSocket({}, [file, join(dir, "absent.sock")])).not.toThrow();
  });

  test("a clean environment with no socket passes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rm-participant-sock-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const cfg = readParticipantConfig({ ...ENV }, { dockerSocketProbePaths: [join(dir, "docker.sock")] });
    expect(cfg.memberId).toBe("m-athena");
    expect(Object.keys(cfg)).not.toContain("dockerSocket");
  });

  test("the default probes cover the system paths and the rootless daemon's", () => {
    expect(defaultDockerSocketProbes({})).toEqual(["/var/run/docker.sock", "/run/docker.sock"]);
    expect(defaultDockerSocketProbes({ XDG_RUNTIME_DIR: "/run/user/1000" })).toEqual([
      "/run/user/1000/docker.sock",
      "/var/run/docker.sock",
      "/run/docker.sock",
    ]);
  });

  test("with no injected probe list, readParticipantConfig probes the defaults", async () => {
    // Driven through the XDG path, which is probed first, so the refusal names
    // OUR socket whether or not this host has one of its own at /var/run.
    const { path } = await realSocket();
    const dir = path.slice(0, -"/docker.sock".length);
    expect(() => readParticipantConfig({ ...ENV, XDG_RUNTIME_DIR: dir })).toThrow(
      new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
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

  test("a 5xx is the API FAILING, not an invalid token — nobody should rotate a good credential", async () => {
    for (const status of [500, 502, 503]) {
      api(() => new Response(JSON.stringify({ error: "upstream" }), { status }));
      const d = await runStartupDiagnostic(config());
      expect({ status, apiReachable: d.apiReachable }).toEqual({ status, apiReachable: false });
    }
  });

  test("a 404 on the verify route is not a token verdict either", async () => {
    api(() => new Response("not found", { status: 404 }));
    expect((await runStartupDiagnostic(config())).apiReachable).toBe(false);
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

// ── ONE TAKE IN FLIGHT, AND A MISSING ROUTE IS LOUD ───────────────────────
describe("pollForWork — at most ONE item, a 401 is terminal, a 404 is an error", () => {
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

  test("a 404 is an ERROR, not 'no work' — a missing pending route must not poll for ever in silence", async () => {
    respond({ error: "not found" }, 404);
    await expect(pollForWork(config())).rejects.toThrow(/404/);
    await expect(pollForWork(config())).rejects.toThrow(/does not exist/);
  });

  test("another 4xx is an error too — the API refuses this participant's poll", async () => {
    respond({ error: "token/member mismatch" }, 403);
    await expect(pollForWork(config())).rejects.toThrow(/403/);
  });

  test("a 2xx whose body is not { pending: [...] } is an error — an unreadable contract is not an empty queue", async () => {
    for (const body of [{}, { pending: null }, { pending: { sessionId: "s-1" } }, ["s-1"]]) {
      respond(body);
      await expect(pollForWork(config())).rejects.toThrow(/pending/);
    }
    globalThis.fetch = (async (_input?: any): Promise<Response> =>
      new Response("<html>proxy error</html>", { status: 200 })) as typeof fetch;
    await expect(pollForWork(config())).rejects.toThrow(/pending/);
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

// ── NO DATABASE CLIENT IN THE MODULE (spec §7.2) ──────────────────────────
describe("the participant module holds no database client", () => {
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
      expect(spec).not.toContain("dockerode");
    }
    // Holding none is only half of it: finding one means the compose profile
    // leaked a credential, and that refuses.
    expect(() => read({ ...ENV, DATABASE_URL: "postgres://rm_app:secret@db:5432/robotmoney" })).toThrow(
      /DATABASE_URL/,
    );
  });

  test("no connection string appears in its code, nor in the configuration it accepts", () => {
    expect(CODE).not.toContain("postgres://");
    expect(CODE).not.toContain("postgresql://");
    const cfg = read({ ...ENV });
    expect(JSON.stringify(cfg)).not.toContain("postgres://");
    expect(Object.keys(cfg)).not.toContain("databaseUrl");
  });
});
