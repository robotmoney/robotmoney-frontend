// W4 part 3 — THE JUDGE CONTAINER'S CALLER (issue #1026).
//
// AUTHORITY: docs/technical/smoke-production-spec.md §6.1, §6.2 and §6.3, and
// docs/technical/system-scheduler-spec.md §4.4.
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
// an injected `runJudge` that stands in for the model. Both are needed and they
// are needed for different reasons: the fetch is how "it submits through those
// routes" becomes checkable at all, and the model stub is how the refusal arms
// get exercised without a credential or a network.
//
// THE REFUSAL ARMS ARE THE POINT OF THIS FILE. "A judge refuses rather than
// fakes" is only worth asserting on the paths where faking would be easy: the
// vendor answered a status, the rail never reached the vendor, the session
// could not be read. Each is tested, and each asserts that NO POST was made —
// not merely that the outcome was labelled a refusal, because an implementation
// that submitted a placeholder AND reported a refusal would pass the weaker
// assertion.
import { describe, expect, test } from "bun:test";
import { ROUTES } from "@robotmoney/contract";
import {
  buildPrompt,
  JUDGE_INSTRUCTION,
  judgeOne,
  readJudgeClientConfig,
  readPendingFrames,
  runJudgeClient,
  submitJudgement,
  type JudgeClientConfig,
  type PendingJudging,
} from "../../agent/participant/judge-client.ts";
import type { JudgeAnswer } from "../../agent/participant/judge-runner.ts";

const CONFIG: JudgeClientConfig = {
  apiUrl: "http://api:3000",
  token: "judge-bearer",
  memberId: "m-judge",
  name: "judge-one",
  model: "vendor/model-x",
  endpoint: "https://models.example/v1",
  apiKey: "key",
  timeoutMs: 1_000,
  reconnectMs: 1,
};

const PENDING: PendingJudging = {
  sessionId: "s-1",
  subjectId: "sub-a",
  date: "2026-09-24",
  judgingDeadlineAt: "2026-09-24T10:00:00.000Z",
  judgingRequestedAt: "2026-09-24T09:45:00.000Z",
};

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

const sessionAnswer = () => Response.json({ session: { id: "s-1", state: "judging" }, takes: [] });

describe("configuration", () => {
  test("a missing model, endpoint or credential refuses at startup rather than at the deadline", () => {
    const base = {
      RM_API_URL: "http://api",
      RM_MEMBER_TOKEN: "t",
      RM_MEMBER_ID: "m",
      RM_MEMBER_NAME: "n",
      RM_JUDGE_MODEL: "vendor/m",
      RM_JUDGE_BASE_URL: "https://x",
      OPENCODE_API_KEY: "k",
    };
    expect(() => readJudgeClientConfig(base)).not.toThrow();
    for (const missing of ["RM_JUDGE_MODEL", "RM_JUDGE_BASE_URL", "OPENCODE_API_KEY", "RM_MEMBER_TOKEN"]) {
      const env: Record<string, string | undefined> = { ...base, [missing]: "" };
      expect(() => readJudgeClientConfig(env)).toThrow(missing);
    }
  });
});

describe("the prompt", () => {
  test("says in its own words that refusing is an allowed answer", () => {
    expect(JUDGE_INSTRUCTION).toContain("insufficient");
    expect(JUDGE_INSTRUCTION).toContain("Do not invent facts");
  });

  test("carries the session's record and the instruction, and nothing else", () => {
    const prompt = buildPrompt({ session: { id: "s-1" } });
    expect(prompt.startsWith(JUDGE_INSTRUCTION)).toBe(true);
    expect(prompt).toContain('"id": "s-1"');
  });
});

describe("a judgement that lands", () => {
  test("is POSTed to the contract's participant route, under the judge's own bearer", async () => {
    const { calls, impl } = recordingFetch({
      [ROUTES.swarm.sessionById.replace(":id", "s-1")]: sessionAnswer,
      [ROUTES.swarm.participants.judgement]: () =>
        Response.json({ sessionId: "s-1", judgementId: 7, state: "judged", duplicate: false, lateEvidence: false }),
    });
    const outcome = await judgeOne(CONFIG, PENDING, {
      fetchImpl: impl,
      runJudgeImpl: async (): Promise<JudgeAnswer> => ({ kind: "ok", body: "the reasoning holds" }),
    });

    expect(outcome).toEqual({
      kind: "submitted",
      sessionId: "s-1",
      judgementId: 7,
      duplicate: false,
      lateEvidence: false,
    });
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.path).toBe(ROUTES.swarm.participants.judgement);
    expect(post.auth).toBe("Bearer judge-bearer");
    expect(post.body).toEqual({ sessionId: "s-1", opinion: "the reasoning holds", model: "vendor/model-x" });
  });

  test("a redelivery answered `duplicate` is a SUCCESS, not something to retry", async () => {
    const { impl } = recordingFetch({
      [ROUTES.swarm.participants.judgement]: () =>
        Response.json({ sessionId: "s-1", judgementId: 7, state: "judged", duplicate: true, lateEvidence: false }),
    });
    const outcome = await submitJudgement(CONFIG, "s-1", "opinion", impl);
    expect(outcome).toMatchObject({ kind: "submitted", duplicate: true });
  });

  test("a submission after finalize is late evidence, and still a success (§4.4)", async () => {
    const { impl } = recordingFetch({
      [ROUTES.swarm.participants.judgement]: () =>
        Response.json({ sessionId: "s-1", judgementId: 8, state: "published", duplicate: false, lateEvidence: true }),
    });
    const outcome = await submitJudgement(CONFIG, "s-1", "opinion", impl);
    expect(outcome).toMatchObject({ kind: "submitted", lateEvidence: true });
  });
});

describe("a judge refuses rather than fakes", () => {
  test("a vendor status submits NOTHING and names the status", async () => {
    const { calls, impl } = recordingFetch({
      [ROUTES.swarm.sessionById.replace(":id", "s-1")]: sessionAnswer,
      [ROUTES.swarm.participants.judgement]: () => Response.json({ judgementId: 1 }),
    });
    const outcome = await judgeOne(CONFIG, PENDING, {
      fetchImpl: impl,
      runJudgeImpl: async (): Promise<JudgeAnswer> => ({ kind: "model_status", status: 429, body: "rate limited" }),
    });

    expect(outcome.kind).toBe("refused");
    expect((outcome as { reason: string }).reason).toContain("429");
    // THE LOAD-BEARING HALF: no POST at all. An implementation that submitted a
    // placeholder and ALSO reported a refusal would pass the line above.
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
  });

  test("a rail fault submits NOTHING and is reported apart from a vendor verdict", async () => {
    const { calls, impl } = recordingFetch({
      [ROUTES.swarm.sessionById.replace(":id", "s-1")]: sessionAnswer,
      [ROUTES.swarm.participants.judgement]: () => Response.json({ judgementId: 1 }),
    });
    const outcome = await judgeOne(CONFIG, PENDING, {
      fetchImpl: impl,
      runJudgeImpl: async (): Promise<JudgeAnswer> => ({ kind: "runner", message: "model endpoint unreachable" }),
    });

    expect(outcome.kind).toBe("refused");
    expect((outcome as { reason: string }).reason).toContain("runner fault");
    expect((outcome as { reason: string }).reason).not.toContain("HTTP");
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
  });

  test("an unreadable session refuses before the model is ever called", async () => {
    let modelCalled = false;
    const { calls, impl } = recordingFetch({
      [ROUTES.swarm.sessionById.replace(":id", "s-1")]: () => new Response("nope", { status: 500 }),
    });
    const outcome = await judgeOne(CONFIG, PENDING, {
      fetchImpl: impl,
      runJudgeImpl: async (): Promise<JudgeAnswer> => {
        modelCalled = true;
        return { kind: "ok", body: "x" };
      },
    });

    expect(outcome.kind).toBe("refused");
    expect(modelCalled).toBe(false);
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
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
      if (url.pathname === ROUTES.swarm.sessionById.replace(":id", "s-1")) return sessionAnswer();
      if (url.pathname === ROUTES.swarm.participants.judgement) {
        return Response.json({ sessionId: "s-1", judgementId: 3, duplicate: false, lateEvidence: false });
      }
      return new Response("nf", { status: 404 });
    }) as unknown as typeof globalThis.fetch;

    const controller = new AbortController();
    const done = runJudgeClient(CONFIG, controller.signal, {
      fetchImpl: impl,
      log: () => {},
      runJudgeImpl: async () => ({ kind: "ok", body: "the reasoning holds" }),
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
    expect(calls.some((c) => c.path === ROUTES.swarm.participants.judgement && c.method === "POST")).toBe(true);
  });

  test("a 403 on the subscription is terminal, not something to reconnect through", async () => {
    const impl = (async () => new Response("{}", { status: 403 })) as unknown as typeof globalThis.fetch;
    await expect(runJudgeClient(CONFIG, undefined, { fetchImpl: impl, log: () => {} })).rejects.toThrow("403");
  });
});
