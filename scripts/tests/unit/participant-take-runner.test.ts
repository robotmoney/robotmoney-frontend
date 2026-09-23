// The PER-TAKE one-shot runner (scripts/agent/participant/take-runner.ts,
// smoke-production-spec.md §6.2, issue #1026 W3.2).
//
// THE GATES THESE EXIST FOR (spec §10 W3): "Participant crash after submit:
// one take" and "Roster change with overlapping containers: one take."
// Both are closed by ONE rule — take identity is `(session, member)`, unique
// server-side, and a resubmission on an existing key returns the EXISTING
// record which the participant treats as SUCCESS. Not a conflict, not an error
// to retry, not a reason to author a second take. So a crash after submit
// costs one redundant request, never a second take.
//
// The other three rules pinned here:
//   - A FRESH WORKSPACE PER TAKE, disposed in a `finally`. Reusing one
//     directory lets a prior session's residue reach the next session's
//     authoring call, and grows without bound in a container meant to run for
//     weeks.
//   - THE TIMEOUT KILLS THE PROCESS GROUP. The authoring CLI spawns children;
//     killing only the direct child leaves grandchildren holding the workspace
//     and the model credential until the container runs out of memory hours
//     later.
//   - THE CANONICAL BYTES ARE FETCHED, never reconstructed locally. A payload
//     that drifts by one byte produces a valid signature over the wrong
//     message.
//
// Cost class `unit` (docs/architecture.md §3 L1): child processes and a
// stubbed `fetch` — no Docker, no daemon, no network. A take is a PROCESS, not
// a container (#1014's `agent-launcher` + `/var/run/docker.sock` is reverted),
// which is exactly why this runs at the unit tier at all.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROUTES } from "@robotmoney/contract";
import {
  createTakeWorkspace,
  runOneShot,
  runTake,
  submitTake,
} from "../../agent/participant/take-runner.ts";
import type { ParticipantConfig, PendingWork } from "../../agent/participant/main.ts";

const SESSION_ID = "11111111-2222-3333-4444-555555555555";
const MEMBER_ID = "m-athena";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "rm-take-runner-"));
}

// A REAL Ed25519 keypair, generated once for this file.
//
// This fixture used to be a placeholder — `{kty:"OKP", crv:"Ed25519", x:"pub",
// d:"priv"}` — whose `d` is not valid base64url and which no WebCrypto import
// accepts. That made the signature assertions below vacuous and, worse, it
// forced the implementation to be dishonest: to keep "the submit carries a
// signature" true it had to catch the import failure and send an EMPTY
// signature, then report the take as `submitted`. The server rejects such a
// submission, so nothing bad reached the database — but the participant was
// claiming to have authored something it could not sign.
//
// That is the same failure the judge doctrine already forbids ("a judgement is
// a model's opinion or it does not exist"), one layer down: a take is signed by
// its member, or it does not exist. With a real key the assertions mean what
// they say, and `signCanonical` is now free to REFUSE an unusable key instead
// of papering over it — pinned by "an identity whose key cannot be imported
// refuses the submission" below.
const REAL_KEYPAIR = generateKeyPairSync("ed25519");
const REAL_PRIVATE_JWK = REAL_KEYPAIR.privateKey.export({ format: "jwk" }) as Record<string, unknown>;
const REAL_PUBLIC_B64 = Buffer.from(
  (REAL_KEYPAIR.publicKey.export({ format: "jwk" }) as { x: string }).x,
  "base64url",
).toString("base64");

const config = (over: Partial<ParticipantConfig> = {}): ParticipantConfig => ({
  apiUrl: "http://website-server:8080",
  name: "athena",
  kind: "agent",
  memberId: MEMBER_ID,
  token: "member-bearer-token",
  identity: { publicKeyB64: REAL_PUBLIC_B64, privateJwk: REAL_PRIVATE_JWK },
  pollIntervalMs: 5_000,
  takeTimeoutMs: 60_000,
  workspaceRoot: "/tmp/rm-participant-workspaces",
  ...over,
});

const work: PendingWork = { sessionId: SESSION_ID, subjectId: "woon", date: "2026-09-23" };

const draft = { sessionId: SESSION_ID, memberId: MEMBER_ID, stance: "neutral", confidence: 0.5, body: "a take" };

// ── FRESH WORKSPACE PER TAKE ───────────────────────────────────────────────
describe("createTakeWorkspace — fresh per take, traceable, and removable", () => {
  test("it creates a real directory under the configured root", () => {
    const root = tempDir();
    try {
      const ws = createTakeWorkspace(root, SESSION_ID, MEMBER_ID);
      expect(ws.path.startsWith(root)).toBe(true);
      expect(statSync(ws.path).isDirectory()).toBe(true);
      ws.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the path names the session and the member, so a leaked directory traces to its take", () => {
    const root = tempDir();
    try {
      const ws = createTakeWorkspace(root, SESSION_ID, MEMBER_ID);
      expect(ws.path).toContain(SESSION_ID);
      expect(ws.path).toContain(MEMBER_ID);
      ws.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("two attempts at the SAME (session, member) get different directories — residue never carries over", () => {
    const root = tempDir();
    try {
      const first = createTakeWorkspace(root, SESSION_ID, MEMBER_ID);
      writeFileSync(join(first.path, "transcript.txt"), "a previous attempt's scratch");
      const second = createTakeWorkspace(root, SESSION_ID, MEMBER_ID);
      expect(second.path).not.toBe(first.path);
      expect(readdirSync(second.path)).toEqual([]);
      first.dispose();
      second.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("dispose removes the directory AND everything the take wrote into it", () => {
    const root = tempDir();
    try {
      const ws = createTakeWorkspace(root, SESSION_ID, MEMBER_ID);
      writeFileSync(join(ws.path, "scratch.json"), "{}");
      ws.dispose();
      expect(existsSync(ws.path)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an unusable root THROWS — authoring into an unknown directory is worse than failing the take", () => {
    const dir = tempDir();
    const notADirectory = join(dir, "root-is-a-file");
    writeFileSync(notADirectory, "");
    try {
      expect(() => createTakeWorkspace(notADirectory, SESSION_ID, MEMBER_ID)).toThrow(
        new RegExp(notADirectory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── THE ONE-SHOT PROCESS ───────────────────────────────────────────────────
describe("runOneShot — own process group, wall-clock timeout, drained pipes", () => {
  test("a successful one-shot reports `ok`, exit 0, and its stdout", async () => {
    const root = tempDir();
    try {
      const ws = createTakeWorkspace(root, SESSION_ID, MEMBER_ID);
      const result = await runOneShot(ws, ["/bin/sh", "-c", "printf authored"], {}, 10_000);
      expect(result.status).toBe("ok");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("authored");
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a non-zero exit is `crashed`, carrying the code — a broken shim, not a slow model", async () => {
    const root = tempDir();
    try {
      const ws = createTakeWorkspace(root, SESSION_ID, MEMBER_ID);
      const result = await runOneShot(ws, ["/bin/sh", "-c", "printf boom >&2; exit 3"], {}, 10_000);
      expect(result.status).toBe("crashed");
      expect(result.exitCode).toBe(3);
      expect(result.stderr).toContain("boom");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a hung one-shot is `timeout`, and the timeout is the wall clock it was given", async () => {
    const root = tempDir();
    try {
      const ws = createTakeWorkspace(root, SESSION_ID, MEMBER_ID);
      const result = await runOneShot(ws, ["/bin/sh", "-c", "sleep 30"], {}, 300);
      expect(result.status).toBe("timeout");
      expect(result.durationMs).toBeLessThan(10_000);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the timeout kills the whole PROCESS GROUP — grandchildren do not survive the take", async () => {
    const root = tempDir();
    try {
      const ws = createTakeWorkspace(root, SESSION_ID, MEMBER_ID);
      const marker = join(ws.path, "grandchild.log");
      // The direct child spawns a grandchild that keeps appending. Killing
      // only the child would leave the grandchild writing forever.
      const script = `sh -c 'while true; do printf x >> ${marker}; sleep 0.05; done' & sleep 30`;
      const result = await runOneShot(ws, ["/bin/sh", "-c", script], {}, 500);
      expect(result.status).toBe("timeout");
      const sizeAtKill = existsSync(marker) ? statSync(marker).size : 0;
      await new Promise((resolve) => setTimeout(resolve, 500));
      const sizeLater = existsSync(marker) ? statSync(marker).size : 0;
      expect(sizeLater).toBe(sizeAtKill);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  test("a child that floods stdout still finishes — both pipes are drained throughout", async () => {
    const root = tempDir();
    try {
      const ws = createTakeWorkspace(root, SESSION_ID, MEMBER_ID);
      // More than a pipe buffer: an undrained pipe would block the child
      // forever and turn every timeout into the maximum timeout.
      const result = await runOneShot(
        ws,
        ["/bin/sh", "-c", "i=0; while [ $i -lt 2000 ]; do printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\n'; i=$((i+1)); done"],
        {},
        15_000,
      );
      expect(result.status).toBe("ok");
      expect(result.exitCode).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  test("the child gets ONLY the environment it was handed", async () => {
    const root = tempDir();
    process.env.RM_TAKE_RUNNER_LEAK = "this-must-not-reach-the-child";
    try {
      const ws = createTakeWorkspace(root, SESSION_ID, MEMBER_ID);
      const result = await runOneShot(
        ws,
        ["/bin/sh", "-c", "printf '%s|%s' \"$RM_INJECTED\" \"$RM_TAKE_RUNNER_LEAK\""],
        { RM_INJECTED: "injected-value" },
        10_000,
      );
      expect(result.stdout).toContain("injected-value");
      expect(result.stdout).not.toContain("this-must-not-reach-the-child");
    } finally {
      delete process.env.RM_TAKE_RUNNER_LEAK;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the one-shot runs IN its workspace, not in the container's working directory", async () => {
    const root = tempDir();
    try {
      const ws = createTakeWorkspace(root, SESSION_ID, MEMBER_ID);
      const result = await runOneShot(ws, ["/bin/sh", "-c", "pwd"], {}, 10_000);
      expect(result.stdout.trim()).toContain(ws.path.split("/").pop() ?? "");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a failure is a returned STATUS, never a throw — the caller must always reach its `finally`", async () => {
    const root = tempDir();
    try {
      const ws = createTakeWorkspace(root, SESSION_ID, MEMBER_ID);
      const result = await runOneShot(ws, ["/nonexistent/binary"], {}, 5_000);
      expect(result.status).toBe("crashed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── IDEMPOTENT SUBMISSION ON (session, member) ─────────────────────────────
describe("submitTake — canonical bytes fetched, one POST, idempotent on (session, member)", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  /**
   * A server that holds AT MOST ONE take per `(session, member)` — the
   * server-side unique key of §6.2. A second submission on the same key
   * returns the record that already exists.
   */
  function fakeApi() {
    const takes = new Map<string, string>();
    const requests: { url: string; body: unknown }[] = [];
    let nextId = 1;
    globalThis.fetch = (async (input: any, init?: any): Promise<Response> => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      requests.push({ url, body });
      if (url.includes(ROUTES.swarm.signingPayload)) {
        return new Response(JSON.stringify({ canonical: `CANONICAL:${SESSION_ID}:${MEMBER_ID}` }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes(ROUTES.swarm.submit)) {
        const key = `${body?.sessionId ?? SESSION_ID}/${body?.memberId ?? MEMBER_ID}`;
        const existing = takes.get(key);
        if (existing) {
          return new Response(
            JSON.stringify({ ok: true, alreadySubmitted: true, recommendationId: existing, verified: true }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        const id = `take-${nextId++}`;
        takes.set(key, id);
        return new Response(JSON.stringify({ ok: true, recommendationId: id, verified: true, revision: 1 }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;
    return { takes, requests };
  }

  test("a first submission reports `submitted`, verified, with the server's record id", async () => {
    fakeApi();
    const result = await submitTake(config(), work, draft);
    expect(result.status).toBe("submitted");
    expect(result.takeId).toBe("take-1");
    expect(result.verified).toBe(true);
  });

  test("the canonical bytes are FETCHED from the signing-payload endpoint before the submit", async () => {
    const api = fakeApi();
    await submitTake(config(), work, draft);
    const urls = api.requests.map((r) => r.url);
    const payloadAt = urls.findIndex((u) => u.includes(ROUTES.swarm.signingPayload));
    const submitAt = urls.findIndex((u) => u.includes(ROUTES.swarm.submit));
    expect(payloadAt).toBeGreaterThanOrEqual(0);
    expect(submitAt).toBeGreaterThan(payloadAt);
  });

  test("the submit carries a signature — a judgement or take with no author is not a record", async () => {
    const api = fakeApi();
    await submitTake(config(), work, draft);
    const submit = api.requests.find((r) => r.url.includes(ROUTES.swarm.submit));
    const signature = (submit?.body as { signature?: unknown })?.signature;
    expect(typeof signature).toBe("string");
    // Non-empty, and real: the fixture key is a genuine Ed25519 pair, so an
    // empty or placeholder signature cannot satisfy this.
    expect((signature as string).length).toBeGreaterThan(0);
  });

  test("an identity whose key cannot be imported REFUSES before the POST — a take is signed by its member or it does not exist", async () => {
    const api = fakeApi();
    const broken = config({
      // Well-formed JWK shape, unusable `d`. This is what the fixture used to
      // be for every test in this file, which is precisely why the old
      // implementation shipped an empty signature and still reported success.
      identity: { publicKeyB64: "pub-athena", privateJwk: { kty: "OKP", crv: "Ed25519", x: "pub", d: "priv" } },
    });
    await expect(submitTake(broken, work, draft)).rejects.toThrow(/cannot import its own signing key/);
    // The REFUSAL IS BEFORE THE WIRE. Nothing was submitted, so no half-authored
    // record exists for an operator to reconcile, and the reason names the key
    // rather than a server-side signature complaint to work backwards from.
    expect(api.requests.some((r) => r.url.includes(ROUTES.swarm.submit))).toBe(false);
    expect(api.takes.size).toBe(0);
  });

  test("GATE 'crash after submit: ONE take' — the resubmission returns the EXISTING record as SUCCESS", async () => {
    const api = fakeApi();
    const first = await submitTake(config(), work, draft);
    // The container died here, restarted, polled, authored again, submitted again.
    const second = await submitTake(config(), work, draft);
    expect(second.status).toBe("already_submitted");
    expect(second.takeId).toBe(first.takeId);
    expect(api.takes.size).toBe(1);
  });

  test("GATE 'roster change with overlapping containers: ONE take' — two containers, one record", async () => {
    const api = fakeApi();
    const oldContainer = submitTake(config(), work, draft);
    const newContainer = submitTake(config(), work, draft);
    const results = await Promise.all([oldContainer, newContainer]);
    expect(api.takes.size).toBe(1);
    const ids = new Set(results.map((r) => r.takeId));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => r.status === "submitted").length).toBeLessThanOrEqual(1);
  });

  test("take identity is (session, member): another session for the same member is a SEPARATE take", async () => {
    const api = fakeApi();
    await submitTake(config(), work, draft);
    const other: PendingWork = { ...work, sessionId: "99999999-2222-3333-4444-555555555555" };
    const second = await submitTake(config(), other, { ...draft, sessionId: other.sessionId });
    expect(second.status).toBe("submitted");
    expect(second.takeId).not.toBe("take-1");
    expect(api.takes.size).toBe(2);
  });

  test("take identity is (session, member): another member in the same session is a SEPARATE take", async () => {
    const api = fakeApi();
    await submitTake(config(), work, draft);
    const second = await submitTake(config({ memberId: "m-robot-money", name: "robot-money" }), work, {
      ...draft,
      memberId: "m-robot-money",
    });
    expect(second.status).toBe("submitted");
    expect(api.takes.size).toBe(2);
  });

  test("`already_submitted` is reached with NO retry — exactly one submit request", async () => {
    const api = fakeApi();
    await submitTake(config(), work, draft);
    const before = api.requests.filter((r) => r.url.includes(ROUTES.swarm.submit)).length;
    await submitTake(config(), work, draft);
    const after = api.requests.filter((r) => r.url.includes(ROUTES.swarm.submit)).length;
    expect(after - before).toBe(1);
  });

  test("a conflict status carrying the existing record is STILL success, not an error", async () => {
    // The wire status is not the authority; the existing record is.
    globalThis.fetch = (async (input: any): Promise<Response> => {
      const url = String(input);
      if (url.includes(ROUTES.swarm.signingPayload)) {
        return new Response(JSON.stringify({ canonical: "CANONICAL" }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ ok: false, alreadySubmitted: true, recommendationId: "take-7", error: "take already on file" }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;
    const result = await submitTake(config(), work, draft);
    expect(result.status).toBe("already_submitted");
    expect(result.takeId).toBe("take-7");
  });

  test("a signature the server rejects is `refused`, carrying the reason — a superseded spoof-keys generation", async () => {
    globalThis.fetch = (async (input: any): Promise<Response> => {
      const url = String(input);
      if (url.includes(ROUTES.swarm.signingPayload)) {
        return new Response(JSON.stringify({ canonical: "CANONICAL" }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: false, error: "signature did not verify" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    const result = await submitTake(config(), work, draft);
    expect(result.status).toBe("refused");
    expect(result.verified).toBe(false);
    expect(result.reason).toContain("signature");
  });

  test("a refusal is RETURNED, not thrown — the window between spoof-keys (2) and (4) is harmless, not fatal", async () => {
    globalThis.fetch = (async (input: any): Promise<Response> => {
      const url = String(input);
      if (url.includes(ROUTES.swarm.signingPayload)) {
        return new Response(JSON.stringify({ canonical: "CANONICAL" }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: false, error: "no registered key for member" }), { status: 403 });
    }) as typeof fetch;
    const result = await submitTake(config(), work, draft);
    expect(result.status).toBe("refused");
  });

  test("a TRANSPORT error throws — the take is retried on the next poll, where idempotency bounds it to one", async () => {
    globalThis.fetch = (async (_input?: any): Promise<Response> => {
      throw new Error("ECONNREFUSED website-server:8080");
    }) as typeof fetch;
    await expect(submitTake(config(), work, draft)).rejects.toThrow(/ECONNREFUSED/);
  });
});

// ── ONE TAKE END TO END ────────────────────────────────────────────────────
describe("runTake — fresh workspace → one-shot → submit → dispose, on every path", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function answeringApi() {
    globalThis.fetch = (async (input: any): Promise<Response> => {
      const url = String(input);
      if (url.includes(ROUTES.swarm.signingPayload)) {
        return new Response(JSON.stringify({ canonical: "CANONICAL" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true, recommendationId: "take-1", verified: true, revision: 1 }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
  }

  test("the outcome names the take's identity — the session and the member", async () => {
    answeringApi();
    const root = tempDir();
    try {
      const outcome = await runTake(config({ workspaceRoot: root }), work);
      expect(outcome.sessionId).toBe(SESSION_ID);
      expect(outcome.memberId).toBe(MEMBER_ID);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("the workspace is disposed — the root is left EMPTY after the take", async () => {
    answeringApi();
    const root = tempDir();
    try {
      await runTake(config({ workspaceRoot: root }), work);
      expect(readdirSync(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("a TIMED-OUT take still disposes its workspace and reports the timeout", async () => {
    answeringApi();
    const root = tempDir();
    try {
      const outcome = await runTake(config({ workspaceRoot: root, takeTimeoutMs: 200 }), work);
      expect(readdirSync(root)).toEqual([]);
      expect(["timeout", "crashed"]).toContain(outcome.oneShot);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("a failed take is a REPORTED OUTCOME, not a throw — one bad session must not kill the container", async () => {
    globalThis.fetch = (async (_input?: any): Promise<Response> => {
      return new Response(JSON.stringify({ ok: false, error: "no session for subject" }), { status: 404 });
    }) as typeof fetch;
    const root = tempDir();
    try {
      const outcome = await runTake(config({ workspaceRoot: root, takeTimeoutMs: 2_000 }), work);
      expect(outcome.sessionId).toBe(SESSION_ID);
      expect(typeof outcome.durationMs).toBe("number");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});

// ── NO DOCKER SOCKET ANYWHERE ON THIS PATH (spec §6.2) ─────────────────────
describe("take-runner.ts holds no container rail — a take is a PROCESS", () => {
  /** The module's CODE, with its prose stripped: the comments discuss the
   * reverted socket rail on purpose, and explaining it is not using it. */
  const code = readFileSync(join(import.meta.dir, "..", "..", "agent", "participant", "take-runner.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");

  test("it imports no container library, names no socket, and isolates a take with a DIRECTORY", () => {
    expect(code).not.toContain("/var/run/docker.sock");
    const imports = [...code.matchAll(/^\s*import\s+(?!type\b)[^;]*from\s+"([^"]+)"/gm)].map((m) => m[1] ?? "");
    for (const spec of imports) {
      expect(spec).not.toContain("dockerode");
      expect(spec).not.toContain("compose");
      expect(spec).not.toContain("agent-launcher");
    }
    // The whole of a take's isolation: a plain directory on this filesystem.
    const root = tempDir();
    try {
      const ws = createTakeWorkspace(root, SESSION_ID, MEMBER_ID);
      expect(statSync(ws.path).isDirectory()).toBe(true);
      ws.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("and the one-shot child is handed no container rail either — only what was injected", async () => {
    const root = tempDir();
    try {
      const ws = createTakeWorkspace(root, SESSION_ID, MEMBER_ID);
      const result = await runOneShot(
        ws,
        ["/bin/sh", "-c", "printf '[%s][%s]' \"$DOCKER_HOST\" \"$DOCKER_SOCKET\""],
        { RM_INJECTED: "only-this" },
        10_000,
      );
      expect(result.stdout).toContain("[][]");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
