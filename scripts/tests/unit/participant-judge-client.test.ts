// W4 part 3 — THE JUDGE CONTAINER'S CALLER (issue #1026).
//
// AUTHORITY: docs/technical/smoke-production-spec.md §6.1, §6.2 and §6.3, and
// docs/technical/system-scheduler-spec.md §4.4; decision D53 point 4 ("the
// participant judge-client classifies failures with the D-A7 refusal taxonomy
// on the direct transport").
//
//   smoke §6.2 (as amended by scheduler spec §12): "agents poll; judges
//    subscribe and are served pending `judging` requests on every connect."
//
//   scheduler §4.4: "Nothing is fabricated: no template opinion, no placeholder
//    certificate, no default verdict."
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THE ASSERTIONS ARE MADE AGAINST
// ─────────────────────────────────────────────────────────────────────────────
//
// An injected `fetch` that RECORDS every request — method, path and body — and
// an injected `runJudge` that stands in for the model. The fetch is how "it
// submits through those routes, signed" becomes checkable at all, and the model
// stub is how every refusal arm gets exercised without a credential or a
// network. The runner's own transport — the real `fetch` against a vendor
// endpoint — is exercised in participant-judge-runner.test.ts.
//
// THE REFUSAL ARMS ARE THE POINT OF THIS FILE. "A judge refuses rather than
// fakes" is only worth asserting on the paths where faking would be easy. Each
// arm asserts its D-A7 NAME — the thing an operator acts on — and that NO POST
// was made, because an implementation that submitted a placeholder AND
// reported a refusal would pass a weaker assertion.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { canonicalizeJudgement, ROUTES } from "@robotmoney/contract";
import {
  judgeOne,
  JudgeClientConfigError,
  readJudgeClientConfig,
  readPendingFrames,
  runJudgeClient,
  submitJudgement,
  type JudgeClientConfig,
  type PendingJudging,
} from "../../agent/participant/judge-client.ts";
import { classifyModelStatus } from "../../agent/participant/judge-reasons.ts";
import type { JudgeAnswer } from "../../agent/participant/judge-runner.ts";
import {
  inputsDigest,
  JUDGE_PROMPT_HASH,
  JUDGE_PROMPT_TEMPLATE,
  renderJudgePrompt,
  type JudgeInput,
} from "../../../backend/src/swarm/judge.ts";

/** A real Ed25519 identity, in the credential-file shape (§6.1). */
const keyPair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
const IDENTITY = {
  publicKeyB64: Buffer.from(new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey))).toString("base64"),
  privateJwk: (await crypto.subtle.exportKey("jwk", keyPair.privateKey)) as Record<string, unknown>,
};

const CONFIG: JudgeClientConfig = {
  apiUrl: "http://api:3000",
  token: "judge-bearer",
  memberId: "m-judge",
  name: "judge-one",
  identity: IDENTITY,
  model: "vendor/model-x",
  endpoint: "https://models.example/v1",
  apiKey: "key",
  timeoutMs: 1_000,
  reconnectMs: 1,
};

const INPUT: JudgeInput = {
  sessionId: "s-1",
  date: "2026-09-24",
  subjectId: "sub-a",
  subjectLabel: "Subject A",
  brief: { prompt: "Assess the subject." },
  takes: [
    { member_id: "m-a", member_name: "A", revision: 1, stance: "bullish", confidence: 0.7, body: "the regime supports it", weights: null },
  ],
  minTakes: 1,
  byStance: { bullish: 1 },
  meanConfidence: 0.7,
  regimeSummary: null,
};

const PENDING: PendingJudging = {
  sessionId: "s-1",
  subjectId: "sub-a",
  date: "2026-09-24",
  judgingDeadlineAt: "2026-09-24T10:00:00.000Z",
  judgingRequestedAt: "2026-09-24T09:45:00.000Z",
  input: INPUT,
};

const ANSWER = JSON.stringify({ rationale: "the reasoning holds", disagreements: [], release_safety: { release: "safe", concerns: [] } });

interface Recorded {
  method: string;
  path: string;
  body: unknown;
  auth: string | null;
}

/** A fetch that records and answers from a script keyed on the path. */
function recordingFetch(
  answers: Record<string, (req: { body: unknown }) => Response>,
): { calls: Recorded[]; impl: typeof globalThis.fetch } {
  const calls: Recorded[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    let body: unknown = null;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const headers = new Headers(init?.headers as HeadersInit);
    calls.push({
      method: (init?.method ?? "GET").toUpperCase(),
      path: url.pathname,
      body,
      auth: headers.get("Authorization"),
    });
    const answer = answers[url.pathname];
    if (!answer) return new Response("not found", { status: 404 });
    return answer({ body });
  }) as unknown as typeof globalThis.fetch;
  return { calls, impl };
}

const accepted = () =>
  Response.json({ sessionId: "s-1", judgementId: 7, state: "judged", duplicate: false, lateEvidence: false });

/** Drive one judging with the model answering `answer`; return the outcome and every POST. */
async function judgeWith(answer: JudgeAnswer) {
  const { calls, impl } = recordingFetch({ [ROUTES.swarm.participants.judgement]: accepted });
  const outcome = await judgeOne(CONFIG, PENDING, { fetchImpl: impl, runJudgeImpl: async () => answer });
  return { outcome, posts: calls.filter((c) => c.method === "POST") };
}

describe("configuration refuses at startup, by the D-A7 name", () => {
  const base = {
    RM_API_URL: "http://api",
    RM_MEMBER_TOKEN: "t",
    RM_MEMBER_ID: "m",
    RM_MEMBER_NAME: "n",
    RM_MEMBER_IDENTITY: JSON.stringify(IDENTITY),
    RM_JUDGE_MODEL: "vendor/m",
    RM_JUDGE_BASE_URL: "https://x",
    OPENCODE_API_KEY: "k",
    // A development environment, where any non-keyless model is allowed.
    RM_ENV: "ephemeral",
  };

  const refusal = (env: Record<string, string | undefined>): JudgeClientConfigError => {
    try {
      readJudgeClientConfig(env);
    } catch (err) {
      return err as JudgeClientConfigError;
    }
    throw new Error("expected readJudgeClientConfig to refuse");
  };

  test("a complete configuration reads, with the judge's own signing identity", () => {
    const config = readJudgeClientConfig(base);
    expect(config.identity.publicKeyB64).toBe(IDENTITY.publicKeyB64);
  });

  test("no model is `model_unconfigured`", () => {
    const err = refusal({ ...base, RM_JUDGE_MODEL: "" });
    expect(err).toBeInstanceOf(JudgeClientConfigError);
    expect(err.reason).toBe("model_unconfigured");
  });

  test("a model with no credential is `credential_unconfigured`", () => {
    expect(refusal({ ...base, OPENCODE_API_KEY: "" }).reason).toBe("credential_unconfigured");
  });

  test("a keyless free-family model is `model_disallowed`, in every environment", () => {
    for (const RM_ENV of ["ephemeral", "prod", undefined]) {
      expect(refusal({ ...base, RM_ENV, RM_JUDGE_MODEL: "nemotron-3-ultra-free" }).reason).toBe("model_disallowed");
    }
  });

  test("on an acceptance path only the pinned model is allowed", () => {
    expect(refusal({ ...base, RM_ENV: "prod", RM_JUDGE_MODEL: "kimi-k3" }).reason).toBe("model_disallowed");
    expect(() => readJudgeClientConfig({ ...base, RM_ENV: "prod", RM_JUDGE_MODEL: "deepseek-v4-flash" })).not.toThrow();
  });

  test("a missing endpoint, bearer or signing identity refuses by the variable's name", () => {
    for (const missing of ["RM_JUDGE_BASE_URL", "RM_MEMBER_TOKEN", "RM_MEMBER_IDENTITY"]) {
      expect(() => readJudgeClientConfig({ ...base, [missing]: "" })).toThrow(missing);
    }
    expect(() => readJudgeClientConfig({ ...base, RM_MEMBER_IDENTITY: JSON.stringify({ publicKeyB64: "x" }) }))
      .toThrow("privateJwk");
  });
});

describe("the prompt and the digest are the server's, over the served input", () => {
  test("the model is given renderJudgePrompt(input) — the frozen template and the fenced input — through a file", async () => {
    let prompt = "";
    const { impl } = recordingFetch({ [ROUTES.swarm.participants.judgement]: accepted });
    await judgeOne(CONFIG, PENDING, {
      fetchImpl: impl,
      runJudgeImpl: async (opts) => {
        prompt = readFileSync(opts.promptFile, "utf8");
        return { kind: "ok", body: ANSWER };
      },
    });
    expect(prompt).toBe(renderJudgePrompt(INPUT));
    expect(prompt.startsWith(JUDGE_PROMPT_TEMPLATE)).toBe(true);
    expect(prompt).toContain("the regime supports it");
  });

  test("a frame with no input refuses as a `runner` fault before any model is asked", async () => {
    let modelCalled = false;
    const { calls, impl } = recordingFetch({ [ROUTES.swarm.participants.judgement]: accepted });
    const outcome = await judgeOne(CONFIG, { ...PENDING, input: undefined as unknown as JudgeInput }, {
      fetchImpl: impl,
      runJudgeImpl: async () => {
        modelCalled = true;
        return { kind: "ok", body: ANSWER };
      },
    });
    expect(outcome).toMatchObject({ kind: "refused", reason: "runner" });
    expect(modelCalled).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe("a judgement that lands is SIGNED with the judge's own key", () => {
  test("it is POSTed to the contract's participant route, under the judge's own bearer, with a verifying signature", async () => {
    const { calls, impl } = recordingFetch({ [ROUTES.swarm.participants.judgement]: accepted });
    const outcome = await judgeOne(CONFIG, PENDING, {
      fetchImpl: impl,
      runJudgeImpl: async (): Promise<JudgeAnswer> => ({ kind: "ok", body: ANSWER }),
    });
    expect(outcome).toEqual({ kind: "submitted", sessionId: "s-1", judgementId: 7, duplicate: false, lateEvidence: false });

    const post = calls.find((c) => c.method === "POST")!;
    expect(post.path).toBe(ROUTES.swarm.participants.judgement);
    expect(post.auth).toBe("Bearer judge-bearer");
    const body = post.body as Record<string, string>;
    expect(body).toMatchObject({
      sessionId: "s-1",
      opinion: ANSWER,
      model: "vendor/model-x",
      promptHash: JUDGE_PROMPT_HASH,
      inputsDigest: inputsDigest(INPUT),
    });
    expect(body.nonce.length).toBeGreaterThan(0);

    // THE SIGNATURE VERIFIES against the judge's public key over the contract's
    // canonical bytes, with the member id the API adds from the bearer.
    const canonical = canonicalizeJudgement({
      memberId: CONFIG.memberId,
      sessionId: body.sessionId,
      nonce: body.nonce,
      model: body.model,
      promptHash: body.promptHash,
      inputsDigest: body.inputsDigest,
      opinion: body.opinion,
    });
    const ok = await crypto.subtle.verify(
      { name: "Ed25519" }, keyPair.publicKey, Buffer.from(body.signature, "base64"), new TextEncoder().encode(canonical),
    );
    expect(ok).toBe(true);
    // …and a signature over the same bytes under ANOTHER member id does not.
    const forged = canonicalizeJudgement({ ...JSON.parse(canonical), memberId: "someone-else" });
    expect(await crypto.subtle.verify(
      { name: "Ed25519" }, keyPair.publicKey, Buffer.from(body.signature, "base64"), new TextEncoder().encode(forged),
    )).toBe(false);
  });

  test("every submission carries a fresh nonce", async () => {
    const { calls, impl } = recordingFetch({ [ROUTES.swarm.participants.judgement]: accepted });
    await submitJudgement(CONFIG, PENDING, ANSWER, impl);
    await submitJudgement(CONFIG, PENDING, ANSWER, impl);
    const [a, b] = calls.map((c) => (c.body as { nonce: string }).nonce);
    expect(a).not.toBe(b);
  });

  test("a key the container cannot import refuses before any POST", async () => {
    const { calls, impl } = recordingFetch({ [ROUTES.swarm.participants.judgement]: accepted });
    const broken = { ...CONFIG, identity: { publicKeyB64: IDENTITY.publicKeyB64, privateJwk: { kty: "OKP" } } };
    await expect(submitJudgement(broken, PENDING, ANSWER, impl)).rejects.toThrow("signing key");
    expect(calls).toEqual([]);
  });

  test("a redelivery answered `duplicate` is a SUCCESS, not something to retry", async () => {
    const { impl } = recordingFetch({
      [ROUTES.swarm.participants.judgement]: () =>
        Response.json({ sessionId: "s-1", judgementId: 7, state: "judged", duplicate: true, lateEvidence: false }),
    });
    expect(await submitJudgement(CONFIG, PENDING, ANSWER, impl)).toMatchObject({ kind: "submitted", duplicate: true });
  });

  test("a submission after finalize is late evidence, and still a success (§4.4)", async () => {
    const { impl } = recordingFetch({
      [ROUTES.swarm.participants.judgement]: () =>
        Response.json({ sessionId: "s-1", judgementId: 8, state: "published", duplicate: false, lateEvidence: true }),
    });
    expect(await submitJudgement(CONFIG, PENDING, ANSWER, impl)).toMatchObject({ kind: "submitted", lateEvidence: true });
  });

  test("a server refusal is reported as submit_failed with the server's reason", async () => {
    const { impl } = recordingFetch({
      [ROUTES.swarm.participants.judgement]: () => Response.json({ error: "inputs_digest_mismatch" }, { status: 409 }),
    });
    expect(await submitJudgement(CONFIG, PENDING, ANSWER, impl))
      .toEqual({ kind: "submit_failed", sessionId: "s-1", status: 409, error: "inputs_digest_mismatch" });
  });
});

describe("a judge refuses rather than fakes — and says WHY, by the D-A7 name", () => {
  test("402 is `credit_exhausted`", async () => {
    const { outcome, posts } = await judgeWith({ kind: "model_status", status: 402, body: "Payment Required" });
    expect(outcome).toMatchObject({ kind: "refused", reason: "credit_exhausted" });
    // THE LOAD-BEARING HALF: no POST at all.
    expect(posts).toEqual([]);
  });

  test("a credit message under another status is `credit_exhausted` too", async () => {
    const { outcome, posts } = await judgeWith({
      kind: "model_status", status: 401, body: '{"type":"error","error":{"type":"CreditsError","message":"Insufficient balance"}}',
    });
    expect(outcome).toMatchObject({ kind: "refused", reason: "credit_exhausted" });
    expect(posts).toEqual([]);
  });

  test("401 with a ModelError body is `model_not_supported`, not a bad key", async () => {
    // Zen's answer to the `opencode/`-prefixed selector, captured 2026-09-13:
    // the status says "your key is bad" and the body says the model id is.
    const { outcome, posts } = await judgeWith({
      kind: "model_status",
      status: 401,
      body: '{"type":"error","error":{"type":"ModelError","message":"Model opencode/deepseek-v4-flash is not supported"}}',
    });
    expect(outcome).toMatchObject({ kind: "refused", reason: "model_not_supported" });
    expect(posts).toEqual([]);
  });

  test("a plain 401 is `credential_rejected`", async () => {
    const { outcome, posts } = await judgeWith({ kind: "model_status", status: 401, body: '{"error":"invalid api key"}' });
    expect(outcome).toMatchObject({ kind: "refused", reason: "credential_rejected" });
    expect(posts).toEqual([]);
  });

  test("403 with no model complaint is `credential_rejected`", async () => {
    expect(classifyModelStatus(403, "forbidden")).toBe("credential_rejected");
  });

  test("429 is `model_unavailable:429`, and a 5xx carries its own status", async () => {
    const { outcome, posts } = await judgeWith({ kind: "model_status", status: 429, body: "rate limited" });
    expect(outcome).toMatchObject({ kind: "refused", reason: "model_unavailable:429" });
    expect(posts).toEqual([]);
    expect(classifyModelStatus(503, "upstream overloaded")).toBe("model_unavailable:503");
  });

  test("a model that does not answer in time is `model_timeout`", async () => {
    const { outcome, posts } = await judgeWith({ kind: "timeout", timeoutMs: 1_000 });
    expect(outcome).toMatchObject({ kind: "refused", reason: "model_timeout" });
    expect(posts).toEqual([]);
  });

  test("the runner's own fault is `runner`, reported apart from every vendor verdict", async () => {
    const { outcome, posts } = await judgeWith({ kind: "runner", message: "model endpoint unreachable: ECONNREFUSED" });
    expect(outcome).toMatchObject({ kind: "refused", reason: "runner" });
    expect((outcome as { detail: string }).detail).toContain("ECONNREFUSED");
    expect((outcome as { reason: string }).reason).not.toMatch(/^model_|credit|credential/);
    expect(posts).toEqual([]);
  });

  test("the refusal detail is a bounded label, not the vendor's whole body", async () => {
    const { outcome } = await judgeWith({ kind: "model_status", status: 500, body: "x".repeat(5_000) });
    expect((outcome as { detail: string }).detail.length).toBeLessThanOrEqual(400);
  });
});

describe("the subscription", () => {
  test("`pending` frames are parsed and keepalives carry no work", async () => {
    const frames =
      `event: pending\ndata: ${JSON.stringify({ pending: [PENDING] })}\n\n` +
      `event: keepalive\ndata: {}\n\n` +
      `event: pending\ndata: ${JSON.stringify({ pending: [] })}\n\n`;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(frames));
        c.close();
      },
    });
    const seen: PendingJudging[][] = [];
    for await (const p of readPendingFrames(stream)) seen.push(p);
    expect(seen).toEqual([[PENDING], []]);
  });

  test("a frame split across two chunks is still parsed", async () => {
    const whole = `event: pending\ndata: ${JSON.stringify({ pending: [PENDING] })}\n\n`;
    const cut = Math.floor(whole.length / 2);
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        const enc = new TextEncoder();
        c.enqueue(enc.encode(whole.slice(0, cut)));
        c.enqueue(enc.encode(whole.slice(cut)));
        c.close();
      },
    });
    const seen: PendingJudging[][] = [];
    for await (const p of readPendingFrames(stream)) seen.push(p);
    expect(seen).toEqual([[PENDING]]);
  });

  test("the client subscribes to the contract's route with its own bearer, and judges what arrives", async () => {
    const calls: Recorded[] = [];
    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers as HeadersInit);
      let body: unknown = null;
      if (typeof init?.body === "string") body = JSON.parse(init.body);
      calls.push({ method: (init?.method ?? "GET").toUpperCase(), path: url.pathname, body, auth: headers.get("Authorization") });

      if (url.pathname === ROUTES.swarm.participants.judgeSubscribe) {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(new TextEncoder().encode(`event: pending\ndata: ${JSON.stringify({ pending: [PENDING] })}\n\n`));
              c.close();
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        );
      }
      if (url.pathname === ROUTES.swarm.participants.judgement) {
        return Response.json({ sessionId: "s-1", judgementId: 3, duplicate: false, lateEvidence: false });
      }
      return new Response("nf", { status: 404 });
    }) as unknown as typeof globalThis.fetch;

    const controller = new AbortController();
    const done = runJudgeClient(CONFIG, controller.signal, {
      fetchImpl: impl,
      log: () => {},
      runJudgeImpl: async () => ({ kind: "ok", body: ANSWER }),
    });
    // One pass through the stream is enough; stop before it reconnects.
    for (let i = 0; i < 100 && !calls.some((c) => c.path === ROUTES.swarm.participants.judgement); i += 1) {
      await Bun.sleep(5);
    }
    controller.abort();
    await done;

    const subscribe = calls.find((c) => c.path === ROUTES.swarm.participants.judgeSubscribe)!;
    expect(subscribe.method).toBe("GET");
    expect(subscribe.auth).toBe("Bearer judge-bearer");
    const post = calls.find((c) => c.path === ROUTES.swarm.participants.judgement && c.method === "POST");
    expect((post?.body as { signature?: string } | undefined)?.signature).toBeTruthy();
    // The judge reads what the subscription served — it fetched no session record of its own.
    expect(calls.map((c) => c.path).filter((p) => p.startsWith("/api/swarm/sessions"))).toEqual([]);
  });

  test("a 403 on the subscription is terminal, not something to reconnect through", async () => {
    const impl = (async () => new Response("{}", { status: 403 })) as unknown as typeof globalThis.fetch;
    await expect(runJudgeClient(CONFIG, undefined, { fetchImpl: impl, log: () => {} })).rejects.toThrow("403");
  });
});
