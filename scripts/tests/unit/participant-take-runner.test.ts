// The PER-TAKE one-shot runner (scripts/agent/participant/take-runner.ts,
// smoke-production-spec.md §6.2, issue #1026 W3.2).
//
// THE GATES THESE EXIST FOR (spec §10 W3): "Participant crash after submit:
// one take" and "Roster change with overlapping containers: one take."
// Under D51/D52 both are closed by ONE rule — A RETRY IS IDENTIFIED BY ITS
// SIGNED NONCE. The participant writes its signed submission into its
// workspace BEFORE sending it; a crash-restart resends those same bytes, nonce
// and all, and never authors again; the server answers a recorded nonce with
// the EXISTING row, which the participant treats as SUCCESS. A NEW nonce is an
// amendment: its own row, marked final, the previous one unset. So a crash
// after submit costs one redundant request, and an overlap costs at most an
// amendment — never a second FINAL take.
//
// The other rules pinned here:
//   - A FRESH WORKSPACE PER TAKE, disposed once the take is settled. Reusing
//     one directory lets a prior session's residue reach the next session's
//     authoring call, and grows without bound in a container meant to run for
//     weeks. Only an UNCONFIRMED signed submission outlives its attempt.
//   - THE TIMEOUT KILLS THE PROCESS GROUP. The authoring CLI spawns children;
//     killing only the direct child leaves grandchildren holding the workspace
//     and the model credential until the container runs out of memory hours
//     later.
//   - THE CANONICAL BYTES ARE FETCHED, never reconstructed locally. A payload
//     that drifts by one byte produces a valid signature over the wrong
//     message.
//
// The end-to-end cases run a REAL take command — a shell script injected as
// `takeCommand` — so the chain workspace → one-shot → submit → disposal is
// executed, not assumed.
//
// Cost class `unit` (docs/architecture.md §3 L1): child processes and a
// stubbed `fetch` — no Docker, no daemon, no network. A take is a PROCESS, not
// a container (#1014's `agent-launcher` + `/var/run/docker.sock` is reverted),
// which is exactly why this runs at the unit tier at all.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { generateKeyPairSync, verify } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { ROUTES } from "@robotmoney/contract";
import {
  createTakeWorkspace,
  INFERENCE_KEY_ENV,
  REFUSAL_VERDICT_STATUSES,
  resendPendingSubmissions,
  runOneShot,
  runTake,
  sendSignedSubmission,
  SIGNED_SUBMISSION_FILE,
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
  modelKey: "athena-own-model-key-0123456789",
  takeCommand: ["/bin/false"],
  pollIntervalMs: 5_000,
  takeTimeoutMs: 60_000,
  workspaceRoot: "/tmp/rm-participant-workspaces",
  ...over,
});

const work: PendingWork = { sessionId: SESSION_ID, subjectId: "woon", date: "2026-09-23" };

/** The draft a one-shot authors: the submit route's own fields, no nonce yet. */
const draft = {
  memberId: MEMBER_ID,
  date: "2026-09-23",
  subjectId: "woon",
  stance: "neutral",
  confidence: 0.5,
  body: "a take",
};

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

  test("the model key the one-shot is handed never appears in its captured output", async () => {
    const root = tempDir();
    try {
      const ws = createTakeWorkspace(root, SESSION_ID, MEMBER_ID);
      const result = await runOneShot(
        ws,
        ["/bin/sh", "-c", 'printf "key=%s" "$RM_INFERENCE_KEY"; printf "key=%s" "$RM_INFERENCE_KEY" >&2'],
        { RM_INFERENCE_KEY: "sk-secret-model-key-123" },
        10_000,
      );
      expect(result.stdout).toBe("key=[redacted]");
      expect(result.stderr).toBe("key=[redacted]");
    } finally {
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

// ── A RETRY IS IDENTIFIED BY ITS SIGNED NONCE (D51, D52) ───────────────────
/**
 * A server that follows D51/D52, modelled on the real submit route's answers:
 *
 *   - identity is `(member, nonce)`: a nonce this member already recorded is a
 *     RETRY, answered with the EXISTING row (`alreadySubmitted: true`);
 *   - a NEW nonce for the same session is an AMENDMENT: its own row, marked
 *     final, and the member's previous final row for that session is unset;
 *   - every submission's signature is VERIFIED against the member's real
 *     public key over the canonical bytes, so "the same bytes" is checked, not
 *     assumed.
 *
 * `onSubmit` lets a test observe the moment of the POST (to prove the signed
 * submission was on disk before it) or lose the response after recording (a
 * crash after submit).
 */
interface Row {
  id: string;
  memberId: string;
  session: string;
  nonce: string;
  final: boolean;
  revision: number;
}

function canonicalOf(draft: Record<string, unknown>): string {
  const { signature: _signature, ...rest } = draft;
  return JSON.stringify(Object.fromEntries(Object.keys(rest).sort().map((k) => [k, rest[k]])));
}

function fakeApi(
  opts: {
    /** Called at the POST, before the server records anything. */
    beforeRecord?: (bytes: string) => void;
    /** Called after the row is recorded; a throw here is a response lost in flight. */
    afterRecord?: (bytes: string) => void;
    /**
     * Answers the submit INSTEAD of the server when it returns a response: a
     * rate limiter, a proxy or a token rotation in front of the handler. The
     * request still counts in `submits`; nothing is recorded.
     */
    intercept?: (bytes: string) => Response | undefined;
  } = {},
) {
  const rows: Row[] = [];
  const submits: string[] = [];
  const signingDrafts: Record<string, unknown>[] = [];
  const requests: string[] = [];
  globalThis.fetch = (async (input: any, init?: any): Promise<Response> => {
    const url = String(input);
    requests.push(url);
    const text = init?.body ? String(init.body) : "";
    if (url.includes(ROUTES.swarm.signingPayload)) {
      const draftBody = JSON.parse(text) as Record<string, unknown>;
      signingDrafts.push(draftBody);
      return new Response(JSON.stringify({ canonical: canonicalOf(draftBody) }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes(ROUTES.swarm.submit)) {
      submits.push(text);
      const intercepted = opts.intercept?.(text);
      if (intercepted) return intercepted;
      opts.beforeRecord?.(text);
      const body = JSON.parse(text) as Record<string, unknown>;
      const verified = verify(
        null,
        Buffer.from(canonicalOf(body)),
        REAL_KEYPAIR.publicKey,
        Buffer.from(String(body.signature ?? ""), "base64"),
      );
      if (!verified) {
        return new Response(JSON.stringify({ ok: false, error: "signature did not verify" }), { status: 400 });
      }
      const memberId = String(body.memberId);
      const nonce = String(body.nonce);
      const session = `${body.subjectId}/${body.date}`;
      const existing = rows.find((r) => r.memberId === memberId && r.nonce === nonce);
      if (existing) {
        return new Response(
          JSON.stringify({ ok: true, alreadySubmitted: true, recommendationId: existing.id, verified: true }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      const prior = rows.filter((r) => r.memberId === memberId && r.session === session);
      for (const r of prior) r.final = false;
      const row: Row = { id: `take-${rows.length + 1}`, memberId, session, nonce, final: true, revision: prior.length + 1 };
      rows.push(row);
      opts.afterRecord?.(text);
      return new Response(JSON.stringify({ ok: true, recommendationId: row.id, verified: true, revision: row.revision }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
  return { rows, submits, signingDrafts, requests };
}

/** The persisted signed submission in a workspace, parsed. */
function persistedIn(workspacePath: string): { sessionId: string; memberId: string; nonce: string; bytes: string } {
  return JSON.parse(readFileSync(join(workspacePath, SIGNED_SUBMISSION_FILE), "utf8"));
}

describe("submitTake — nonce minted once, signed, PERSISTED, then sent", () => {
  const realFetch = globalThis.fetch;
  const roots: string[] = [];
  afterEach(() => {
    globalThis.fetch = realFetch;
    while (roots.length) rmSync(roots.pop() as string, { recursive: true, force: true });
  });
  const workspace = () => {
    const root = tempDir();
    roots.push(root);
    return createTakeWorkspace(root, SESSION_ID, MEMBER_ID);
  };

  test("a first submission reports `submitted`, verified, with the server's record id", async () => {
    fakeApi();
    const result = await submitTake(config(), work, draft, workspace());
    expect(result.status).toBe("submitted");
    expect(result.takeId).toBe("take-1");
    expect(result.verified).toBe(true);
  });

  test("the canonical bytes are FETCHED from the signing-payload endpoint before the submit", async () => {
    const api = fakeApi();
    await submitTake(config(), work, draft, workspace());
    const payloadAt = api.requests.findIndex((u) => u.includes(ROUTES.swarm.signingPayload));
    const submitAt = api.requests.findIndex((u) => u.includes(ROUTES.swarm.submit));
    expect(payloadAt).toBeGreaterThanOrEqual(0);
    expect(submitAt).toBeGreaterThan(payloadAt);
  });

  test("the submit carries a REAL signature — the fake verifies it against the member's public key", async () => {
    const api = fakeApi();
    const result = await submitTake(config(), work, draft, workspace());
    // A missing or placeholder signature is refused by the fake, so `submitted`
    // here means the signature verified over the canonical bytes.
    expect(result.status).toBe("submitted");
    const sent = JSON.parse(api.submits[0] ?? "{}") as { signature?: unknown };
    expect(typeof sent.signature).toBe("string");
  });

  test("an identity whose key cannot be imported REFUSES before the POST — and nothing is persisted", async () => {
    const api = fakeApi();
    const ws = workspace();
    const broken = config({
      // Well-formed JWK shape, unusable `d`: an unusable key is a refusal,
      // never an empty signature reported as `submitted`.
      identity: { publicKeyB64: "pub-athena", privateJwk: { kty: "OKP", crv: "Ed25519", x: "pub", d: "priv" } },
    });
    await expect(submitTake(broken, work, draft, ws)).rejects.toThrow(/cannot import its own signing key/);
    expect(api.submits).toEqual([]);
    expect(api.rows).toHaveLength(0);
    expect(existsSync(join(ws.path, SIGNED_SUBMISSION_FILE))).toBe(false);
  });

  test("D52: the signed submission is ON DISK before the POST, byte-identical to what is sent, nonce included", async () => {
    const ws = workspace();
    let onDiskAtPost: { nonce: string; bytes: string } | null = null;
    const api = fakeApi({
      beforeRecord: () => {
        onDiskAtPost = existsSync(join(ws.path, SIGNED_SUBMISSION_FILE)) ? persistedIn(ws.path) : null;
      },
    });
    await submitTake(config(), work, draft, ws);
    expect(onDiskAtPost).not.toBeNull();
    const seen = onDiskAtPost as unknown as { nonce: string; bytes: string };
    expect(seen.bytes).toBe(api.submits[0] ?? "");
    expect(JSON.parse(seen.bytes).nonce).toBe(seen.nonce);
    expect(persistedIn(ws.path)).toMatchObject({ sessionId: SESSION_ID, memberId: MEMBER_ID });
  });

  test("a draft without a nonce gets ONE minted before signing — the signed bytes and the sent bytes carry it", async () => {
    const api = fakeApi();
    const ws = workspace();
    await submitTake(config(), work, draft, ws);
    const minted = persistedIn(ws.path).nonce;
    expect(minted).toMatch(/^[0-9a-f-]{36}$/);
    expect(api.signingDrafts[0]?.nonce).toBe(minted);
    expect(JSON.parse(api.submits[0] ?? "{}").nonce).toBe(minted);
  });

  test("a draft that carries its own nonce keeps it", async () => {
    const api = fakeApi();
    await submitTake(config(), work, { ...draft, nonce: "nonce-from-the-author" }, workspace());
    expect(JSON.parse(api.submits[0] ?? "{}").nonce).toBe("nonce-from-the-author");
  });

  test("GATE 'crash after submit: ONE take' — resending the SAME bytes returns the EXISTING row as SUCCESS", async () => {
    const api = fakeApi();
    const ws = workspace();
    const first = await submitTake(config(), work, draft, ws);
    // The container died here, restarted, and resent what its workspace held.
    const second = await sendSignedSubmission(config(), persistedIn(ws.path).bytes);
    expect(second.status).toBe("already_submitted");
    expect(second.takeId).toBe(first.takeId);
    expect(api.rows).toHaveLength(1);
    expect(api.submits[1]).toBe(api.submits[0]);
  });

  test("D51: a NEW nonce is an AMENDMENT — its own row, marked final, and the previous one unset", async () => {
    const api = fakeApi();
    await submitTake(config(), work, { ...draft, nonce: "n-1" }, workspace());
    const amended = await submitTake(config(), work, { ...draft, nonce: "n-2", stance: "bullish" }, workspace());
    expect(amended.status).toBe("submitted");
    expect(api.rows.map((r) => ({ nonce: r.nonce, final: r.final, revision: r.revision }))).toEqual([
      { nonce: "n-1", final: false, revision: 1 },
      { nonce: "n-2", final: true, revision: 2 },
    ]);
  });

  test("GATE 'roster change with overlapping containers' — two authors, an amendment, never two FINAL takes", async () => {
    const api = fakeApi();
    // Old and new container each author and mint their own nonce.
    const results = await Promise.all([
      submitTake(config(), work, draft, workspace()),
      submitTake(config(), work, draft, workspace()),
    ]);
    expect(results.every((r) => r.status === "submitted")).toBe(true);
    expect(api.rows).toHaveLength(2);
    expect(api.rows.filter((r) => r.final)).toHaveLength(1);
  });

  test("`already_submitted` is reached with NO retry — exactly one submit request per send", async () => {
    const api = fakeApi();
    const ws = workspace();
    await submitTake(config(), work, draft, ws);
    await sendSignedSubmission(config(), persistedIn(ws.path).bytes);
    expect(api.submits).toHaveLength(2);
  });

  test("a conflict status carrying the existing record is STILL success, not an error", async () => {
    // The wire status is not the authority; the existing record is.
    globalThis.fetch = (async (input: any): Promise<Response> => {
      const url = String(input);
      if (url.includes(ROUTES.swarm.signingPayload)) {
        return new Response(JSON.stringify({ canonical: "CANONICAL" }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ ok: false, alreadySubmitted: true, recommendationId: "take-7", error: "nonce already recorded" }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;
    const result = await submitTake(config(), work, draft, workspace());
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
    const result = await submitTake(config(), work, draft, workspace());
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
    const result = await submitTake(config(), work, draft, workspace());
    expect(result.status).toBe("refused");
  });

  test("a TRANSPORT error on the submit throws — and the signed bytes are already on disk to resend", async () => {
    const ws = workspace();
    fakeApi({
      beforeRecord: () => {
        throw new Error("ECONNREFUSED website-server:8080");
      },
    });
    await expect(submitTake(config(), work, draft, ws)).rejects.toThrow(/ECONNREFUSED/);
    expect(persistedIn(ws.path).bytes).not.toBe("");
  });

  test("a 5xx on the submit throws too — the server did not answer, so the bytes are resent, not refused", async () => {
    globalThis.fetch = (async (input: any): Promise<Response> => {
      const url = String(input);
      if (url.includes(ROUTES.swarm.signingPayload)) {
        return new Response(JSON.stringify({ canonical: "CANONICAL" }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: "upstream" }), { status: 503 });
    }) as typeof fetch;
    const ws = workspace();
    await expect(submitTake(config(), work, draft, ws)).rejects.toThrow(/503/);
    expect(existsSync(join(ws.path, SIGNED_SUBMISSION_FILE))).toBe(true);
  });

  test.each([401, 408, 425, 429])(
    "a %i is NOT a verdict on the signed bytes — `unconfirmed`, so they are kept and resent, never re-authored",
    async (status) => {
      globalThis.fetch = (async (_input?: any): Promise<Response> =>
        new Response(JSON.stringify({ error: "try later" }), { status })) as typeof fetch;
      const result = await sendSignedSubmission(config(), '{"nonce":"n-1"}');
      expect(result.status).toBe("unconfirmed");
      expect(result.reason).toContain(String(status));
      expect(REFUSAL_VERDICT_STATUSES.has(status)).toBe(false);
    },
  );

  test("a 2xx this client cannot read is `unconfirmed` too — an unreadable answer settles nothing", async () => {
    globalThis.fetch = (async (_input?: any): Promise<Response> =>
      new Response("<html>proxy</html>", { status: 200 })) as typeof fetch;
    expect((await sendSignedSubmission(config(), '{"nonce":"n-1"}')).status).toBe("unconfirmed");
  });

  test.each([400, 403, 404, 409, 410, 422])("a %i IS a verdict on the bytes — `refused`", async (status) => {
    globalThis.fetch = (async (_input?: any): Promise<Response> =>
      new Response(JSON.stringify({ ok: false, error: "verdict" }), { status })) as typeof fetch;
    expect((await sendSignedSubmission(config(), '{"nonce":"n-1"}')).status).toBe("refused");
  });

  test("a TRANSPORT error fetching the canonical bytes throws BEFORE anything is persisted", async () => {
    globalThis.fetch = (async (_input?: any): Promise<Response> => {
      throw new Error("ECONNREFUSED website-server:8080");
    }) as typeof fetch;
    const ws = workspace();
    await expect(submitTake(config(), work, draft, ws)).rejects.toThrow(/ECONNREFUSED/);
    expect(existsSync(join(ws.path, SIGNED_SUBMISSION_FILE))).toBe(false);
  });
});

// ── ONE TAKE END TO END, WITH A REAL TAKE COMMAND ──────────────────────────
// Every case here runs a REAL one-shot: a shell script written to a temp
// directory and injected as `takeCommand`, exactly as `RM_TAKE_COMMAND` is. The
// script records each authoring run in a marker directory OUTSIDE the take's
// workspace, so a test can count authoring and watch a grandchild after the
// workspace is gone.
describe("runTake — fresh workspace → one-shot → sign → persist → submit → dispose", () => {
  const realFetch = globalThis.fetch;
  const dirs: string[] = [];
  afterEach(() => {
    globalThis.fetch = realFetch;
    while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
  });
  const dir = (): string => {
    const d = tempDir();
    dirs.push(d);
    return d;
  };

  /** A take command that authors a real draft and counts its own runs. */
  function authoringCommand(markers: string): string[] {
    const script = join(markers, "author.sh");
    writeFileSync(
      script,
      [
        `echo run >> '${markers}/authored.log'`,
        `echo "$RM_WORKSPACE" > '${markers}/ws'`,
        `printf '%s' "$RM_INFERENCE_KEY" > '${markers}/model-key'`,
        `printf 'scratch' > "$RM_WORKSPACE/transcript.txt"`,
        `printf 'RM_TAKE_DRAFT {"memberId":"%s","date":"%s","subjectId":"%s","stance":"neutral","confidence":0.5,"body":"a take"}\\n' "$RM_MEMBER_ID" "$RM_SESSION_DATE" "$RM_SUBJECT_ID"`,
        "",
      ].join("\n"),
    );
    return ["/bin/sh", script];
  }

  const authoredRuns = (markers: string): number =>
    existsSync(join(markers, "authored.log")) ? readFileSync(join(markers, "authored.log"), "utf8").trim().split("\n").length : 0;

  test("the whole chain runs: a workspace, a one-shot, `ok`, then `submitted`, then disposal", async () => {
    const root = dir();
    const markers = dir();
    const events: string[] = [];
    const api = fakeApi({
      beforeRecord: () => {
        // At the POST the workspace still exists and holds the signed bytes.
        const ws = readFileSync(join(markers, "ws"), "utf8").trim();
        events.push(`submit:workspace=${existsSync(join(ws, SIGNED_SUBMISSION_FILE))}`);
      },
    });
    const outcome = await runTake(config({ workspaceRoot: root, takeCommand: authoringCommand(markers) }), work);
    const ws = readFileSync(join(markers, "ws"), "utf8").trim();
    events.push(`after:workspace=${existsSync(ws)}`);

    expect(outcome.oneShot).toBe("ok");
    expect(outcome.submission).toBe("submitted");
    expect(outcome.sessionId).toBe(SESSION_ID);
    expect(outcome.memberId).toBe(MEMBER_ID);
    expect(outcome.nonce).toBe(api.rows[0]?.nonce);
    expect(authoredRuns(markers)).toBe(1);
    // The workspace was REAL (under the root) and is gone now.
    expect(ws.startsWith(root)).toBe(true);
    expect(events).toEqual(["submit:workspace=true", "after:workspace=false"]);
    expect(readdirSync(root)).toEqual([]);
    expect(api.rows).toHaveLength(1);
  }, 30_000);

  test("a TIMED-OUT take is EXACTLY `timeout`: its grandchild is frozen, its workspace is gone, nothing is sent", async () => {
    const root = dir();
    const markers = dir();
    const script = join(markers, "hang.sh");
    writeFileSync(
      script,
      [
        `echo "$RM_WORKSPACE" > '${markers}/ws'`,
        `sh -c 'while true; do printf x >> ${markers}/grandchild.log; sleep 0.05; done' &`,
        `echo $! > '${markers}/grandchild.pid'`,
        "sleep 30",
        "",
      ].join("\n"),
    );
    const api = fakeApi();
    const outcome = await runTake(
      config({ workspaceRoot: root, takeTimeoutMs: 500, takeCommand: ["/bin/sh", script] }),
      work,
    );
    expect(outcome.oneShot).toBe("timeout");
    expect(outcome.submission).toBeNull();
    expect(api.submits).toEqual([]);

    // The one-shot really ran in a workspace under the root, which is now gone.
    const ws = readFileSync(join(markers, "ws"), "utf8").trim();
    expect(ws.startsWith(root)).toBe(true);
    expect(existsSync(ws)).toBe(false);
    expect(readdirSync(root)).toEqual([]);

    // No child survives: the grandchild wrote before the kill, and never after.
    const log = join(markers, "grandchild.log");
    const sizeAtReturn = statSync(log).size;
    expect(sizeAtReturn).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(statSync(log).size).toBe(sizeAtReturn);
    const pid = Number.parseInt(readFileSync(join(markers, "grandchild.pid"), "utf8").trim(), 10);
    expect(await eventuallyDead(pid)).toBe(true);
  }, 30_000);

  test("GATE 'crash after submit': the restart RESENDS the same bytes and nonce, and never authors again", async () => {
    const root = dir();
    const markers = dir();
    const cfg = config({ workspaceRoot: root, takeCommand: authoringCommand(markers) });
    // First life: the server records the take, then the response is lost.
    let loseResponse = true;
    const api = fakeApi({
      afterRecord: () => {
        if (loseResponse) throw new Error("ECONNRESET: container killed mid-response");
      },
    });
    const first = await runTake(cfg, work);
    expect(first.oneShot).toBe("ok");
    expect(first.submission).toBe("unconfirmed");
    // The signed submission survived in its workspace.
    expect(readdirSync(root)).toHaveLength(1);

    // Second life: same work offered again. It must resend, not re-author.
    loseResponse = false;
    const second = await runTake(cfg, work);
    expect(second.oneShot).toBeNull();
    expect(second.submission).toBe("already_submitted");
    expect(second.nonce).toBe(first.nonce);
    expect(authoredRuns(markers)).toBe(1);
    expect(api.submits).toHaveLength(2);
    expect(api.submits[1]).toBe(api.submits[0]);
    expect(api.rows).toHaveLength(1);
    // Confirmed, so the workspace is gone.
    expect(readdirSync(root)).toEqual([]);
  }, 30_000);

  test("a send that NEVER reached the server is resent as the same bytes and recorded ONCE", async () => {
    const root = dir();
    const markers = dir();
    const cfg = config({ workspaceRoot: root, takeCommand: authoringCommand(markers) });
    let down = true;
    const api = fakeApi({
      beforeRecord: () => {
        if (down) throw new Error("ECONNREFUSED website-server:8080");
      },
    });
    expect((await runTake(cfg, work)).submission).toBe("unconfirmed");
    down = false;
    const retried = await runTake(cfg, work);
    expect(retried.submission).toBe("submitted");
    expect(authoredRuns(markers)).toBe(1);
    expect(api.submits[1]).toBe(api.submits[0]);
    expect(api.rows).toHaveLength(1);
    expect(readdirSync(root)).toEqual([]);
  }, 30_000);

  test("resendPendingSubmissions resends a take whose session is no longer offered, then disposes it", async () => {
    // The server recorded the take before the crash, so the session is no
    // longer pending; only the sweep ever resends it.
    const root = dir();
    const markers = dir();
    const cfg = config({ workspaceRoot: root, takeCommand: authoringCommand(markers) });
    let loseResponse = true;
    const api = fakeApi({
      afterRecord: () => {
        if (loseResponse) throw new Error("ECONNRESET");
      },
    });
    await runTake(cfg, work);
    loseResponse = false;
    const outcomes = await resendPendingSubmissions(cfg);
    expect(outcomes.map((o) => ({ session: o.sessionId, oneShot: o.oneShot, submission: o.submission }))).toEqual([
      { session: SESSION_ID, oneShot: null, submission: "already_submitted" },
    ]);
    expect(authoredRuns(markers)).toBe(1);
    expect(api.rows).toHaveLength(1);
    expect(readdirSync(root)).toEqual([]);
    // Nothing left: a second sweep sends nothing.
    expect(await resendPendingSubmissions(cfg)).toEqual([]);
    expect(api.submits).toHaveLength(2);
  }, 30_000);

  test("the sweep leaves ANOTHER member's persisted submission alone", async () => {
    const root = dir();
    const markers = dir();
    let loseResponse = true;
    fakeApi({
      afterRecord: () => {
        if (loseResponse) throw new Error("ECONNRESET");
      },
    });
    await runTake(config({ workspaceRoot: root, takeCommand: authoringCommand(markers) }), work);
    loseResponse = false;
    expect(await resendPendingSubmissions(config({ workspaceRoot: root, memberId: "m-robot-money" }))).toEqual([]);
    expect(readdirSync(root)).toHaveLength(1);
  }, 30_000);

  test("a DEFINITIVE refusal after persisting settles the take — the workspace goes, nothing is resent", async () => {
    const root = dir();
    const markers = dir();
    globalThis.fetch = (async (input: any, init?: any): Promise<Response> => {
      const url = String(input);
      if (url.includes(ROUTES.swarm.signingPayload)) {
        return new Response(JSON.stringify({ canonical: canonicalOf(JSON.parse(String(init?.body))) }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: false, error: "window closed" }), { status: 409 });
    }) as typeof fetch;
    const outcome = await runTake(config({ workspaceRoot: root, takeCommand: authoringCommand(markers) }), work);
    expect(outcome.submission).toBe("refused");
    expect(outcome.reason).toContain("window closed");
    expect(readdirSync(root)).toEqual([]);
  }, 30_000);

  test("a resend that gets a 429, then a 401 during a token rotation, KEEPS the bytes — the take is recorded once, never re-authored", async () => {
    const root = dir();
    const markers = dir();
    const cfg = config({ workspaceRoot: root, takeCommand: authoringCommand(markers) });
    // The first POST never reaches the handler; the next two are answered by a
    // rate limiter and then by a rotating auth layer, neither a verdict.
    const answers: (Response | undefined)[] = [
      undefined,
      new Response(JSON.stringify({ error: "rate limited" }), { status: 429 }),
      new Response(JSON.stringify({ error: "unknown member token" }), { status: 401 }),
    ];
    let call = 0;
    const api = fakeApi({
      beforeRecord: () => {
        if (call === 1) throw new Error("ECONNREFUSED website-server:8080");
      },
      intercept: () => {
        call += 1;
        return answers[call - 1];
      },
    });
    const first = await runTake(cfg, work);
    expect(first.submission).toBe("unconfirmed");
    expect(readdirSync(root)).toHaveLength(1);

    const throttled = await runTake(cfg, work);
    expect(throttled.submission).toBe("unconfirmed");
    expect(throttled.reason).toContain("429");
    expect(readdirSync(root)).toHaveLength(1);

    const rotated = await resendPendingSubmissions(cfg);
    expect(rotated.map((o) => o.submission)).toEqual(["unconfirmed"]);
    expect(rotated[0]?.reason).toContain("401");
    expect(readdirSync(root)).toHaveLength(1);

    const settled = await runTake(cfg, work);
    expect(settled.submission).toBe("submitted");
    expect(settled.nonce).toBe(first.nonce);
    expect(authoredRuns(markers)).toBe(1);
    expect(new Set(api.submits).size).toBe(1);
    expect(api.submits).toHaveLength(4);
    expect(api.rows).toHaveLength(1);
    expect(readdirSync(root)).toEqual([]);
  }, 30_000);

  test("the one-shot receives THIS member's own model key as RM_INFERENCE_KEY — and nothing else of the container's", async () => {
    const root = dir();
    const markers = dir();
    fakeApi();
    const outcome = await runTake(
      config({ workspaceRoot: root, modelKey: "athena-key-only-hers-42", takeCommand: authoringCommand(markers) }),
      work,
    );
    expect(outcome.submission).toBe("submitted");
    expect(INFERENCE_KEY_ENV).toBe("RM_INFERENCE_KEY");
    expect(readFileSync(join(markers, "model-key"), "utf8")).toBe("athena-key-only-hers-42");
  }, 30_000);

  test("authoring RESIDUE of a crashed attempt (no signed submission) is removed, and the take is authored fresh", async () => {
    const root = dir();
    const markers = dir();
    const stale = createTakeWorkspace(root, SESSION_ID, MEMBER_ID);
    writeFileSync(join(stale.path, "transcript.txt"), "half an authoring run");
    // A different member whose id merely EXTENDS this one's is not residue.
    const neighbour = createTakeWorkspace(root, SESSION_ID, `${MEMBER_ID}-2`);
    fakeApi();
    const outcome = await runTake(config({ workspaceRoot: root, takeCommand: authoringCommand(markers) }), work);
    expect(outcome.submission).toBe("submitted");
    expect(authoredRuns(markers)).toBe(1);
    expect(existsSync(stale.path)).toBe(false);
    expect(readdirSync(root)).toEqual([basename(neighbour.path)]);
  }, 30_000);

  test("the one-shot's argv is the INJECTED take command, never an ambient environment variable", async () => {
    const root = dir();
    const markers = dir();
    process.env.RM_TAKE_COMMAND = "/bin/false";
    try {
      fakeApi();
      const outcome = await runTake(config({ workspaceRoot: root, takeCommand: authoringCommand(markers) }), work);
      expect(outcome.submission).toBe("submitted");
    } finally {
      delete process.env.RM_TAKE_COMMAND;
    }
  }, 30_000);

  test("with NO take command the take is `crashed`, naming the missing setting, and leaves nothing", async () => {
    const root = dir();
    const api = fakeApi();
    const outcome = await runTake(config({ workspaceRoot: root, takeCommand: [] }), work);
    expect(outcome.oneShot).toBe("crashed");
    expect(outcome.reason).toContain("RM_TAKE_COMMAND");
    expect(api.requests).toEqual([]);
    expect(readdirSync(root)).toEqual([]);
  });

  test("a failed take is a REPORTED OUTCOME, not a throw — one bad session must not kill the container", async () => {
    globalThis.fetch = (async (_input?: any): Promise<Response> => {
      return new Response(JSON.stringify({ ok: false, error: "no session for subject" }), { status: 404 });
    }) as typeof fetch;
    const root = dir();
    const markers = dir();
    const outcome = await runTake(
      config({ workspaceRoot: root, takeTimeoutMs: 10_000, takeCommand: authoringCommand(markers) }),
      work,
    );
    expect(outcome.sessionId).toBe(SESSION_ID);
    expect(outcome.oneShot).toBe("ok");
    expect(outcome.submission).toBe("refused");
    expect(readdirSync(root)).toEqual([]);
  }, 30_000);
});

/**
 * True once `pid` is gone. A killed process can linger as a zombie until its
 * new parent reaps it; a zombie holds no workspace and runs nothing, so it
 * counts as dead.
 */
async function eventuallyDead(pid: number): Promise<boolean> {
  for (let i = 0; i < 40; i += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    const stat = join("/proc", String(pid), "stat");
    if (existsSync(stat) && /\) Z /.test(readFileSync(stat, "utf8"))) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

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
