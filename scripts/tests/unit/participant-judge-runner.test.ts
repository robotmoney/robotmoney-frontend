// The JUDGE's one-shot runner (scripts/agent/participant/judge-runner.ts,
// smoke-production-spec.md §6.2, issue #1026 W3.4).
//
// THE GATE (spec §10 W3): "Judge runs as a participant; nothing judges
// inline." The judge is a keyed persona in the `judges` namespace of the
// credential file (§6.1) running the same standing-container loop an agent
// runs, with this shim as its one-shot.
//
// THE FOUR RULES THESE PIN, EACH LEARNED FROM A REAL FAILURE:
//
//   1. THE ANSWER UNION, AND ITS TWO FAILURE ARMS NEVER COLLAPSE.
//      `model_status` is the VENDOR refusing — a product fact that feeds the
//      D-A7 taxonomy and tells an operator to add credit or fix a key.
//      `runner` is THIS SHIM, its network or its launch failing — an
//      infrastructure fact about our own deployment. Collapse them and a rail
//      fault sends an operator to top up an account that was never charged,
//      while a vendor refusal sends them to debug a container that worked.
//      A TIMEOUT is its own arm (`timeout`, D-A7's `model_timeout`): the vendor
//      was asked and did not answer, which is neither of the other two.
//   2. THE PROMPT ARRIVES AS A FILE. A judge prompt carries every take in the
//      session; Linux caps one argv/env string at MAX_ARG_STRLEN (128 KiB) and
//      `execve` then returns E2BIG — the process never starts. A judge that
//      silently stops working once a session has enough members is exactly
//      what the file rule prevents.
//   3. ONE POST, NO RETRY. A retry inside the shim hides how many times the
//      vendor was actually asked, which is the number an operator needs when
//      reading a credit-exhaustion incident.
//   4. ALWAYS EXIT 0 WITH A LINE, AND THE LAST TAGGED LINE WINS. A non-zero
//      exit cannot distinguish "the vendor refused" from "this shim crashed".
//      The reading order is fixed: timeout, then answer line, then never
//      launched — and a TORN line is not an answer.
//
// Cost class `unit` (docs/architecture.md §3 L1): a stubbed `fetch`, a temp
// prompt file and one subprocess — no container and no network.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  JUDGE_ANSWER_TAG,
  formatAnswerLine,
  parseAnswerLine,
  readPromptFile,
  runJudge,
  type JudgeAnswer,
  type JudgeRunnerOptions,
} from "../../agent/participant/judge-runner.ts";
import { failureCodeForAnswer, type JudgeFailureCode } from "../../agent/participant/judge-reasons.ts";
import { parseJudgeResponse, renderJudgePrompt, type JudgeInput } from "../../../backend/src/swarm/judge.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "rm-judge-runner-"));
}

const options = (over: Partial<JudgeRunnerOptions> = {}): JudgeRunnerOptions => ({
  promptFile: "/tmp/does-not-matter.txt",
  endpoint: "https://judge.invalid/v1",
  model: "big-pickle",
  apiKey: "zen-key",
  timeoutMs: 5_000,
  ...over,
});

/** The caller's fixed reading order: the LAST tagged line is the answer. */
function lastAnswer(stdout: string): JudgeAnswer | null {
  let found: JudgeAnswer | null = null;
  for (const line of stdout.split("\n")) {
    const parsed = parseAnswerLine(line);
    if (parsed) found = parsed;
  }
  return found;
}

// ── THE ANSWER UNION ROUND-TRIPS, AND THE FAILURE ARMS STAY APART ──────────
describe("the answer union survives the stdout round trip", () => {
  test("`ok` round-trips with the model's raw answer text, uninterpreted", () => {
    const answer: JudgeAnswer = { kind: "ok", body: '{"weights":{"athena":0.4}}' };
    expect(parseAnswerLine(formatAnswerLine(answer))).toEqual(answer);
  });

  test("`model_status` round-trips with its status AND its body", () => {
    const answer: JudgeAnswer = { kind: "model_status", status: 402, body: "insufficient credit" };
    expect(parseAnswerLine(formatAnswerLine(answer))).toEqual(answer);
  });

  test("`runner` round-trips with its message", () => {
    const answer: JudgeAnswer = { kind: "runner", message: "prompt file unreadable" };
    expect(parseAnswerLine(formatAnswerLine(answer))).toEqual(answer);
  });

  test("`timeout` round-trips with the ceiling it hit", () => {
    const answer: JudgeAnswer = { kind: "timeout", timeoutMs: 300_000 };
    expect(parseAnswerLine(formatAnswerLine(answer))).toEqual(answer);
  });

  test("a TIMEOUT never comes back as a rail fault or a vendor status", () => {
    const parsed = parseAnswerLine(formatAnswerLine({ kind: "timeout", timeoutMs: 5 }));
    expect(parsed?.kind).toBe("timeout");
  });

  test("a VENDOR refusal never comes back as a rail fault", () => {
    const parsed = parseAnswerLine(formatAnswerLine({ kind: "model_status", status: 401, body: "bad key" }));
    expect(parsed?.kind).toBe("model_status");
    expect(parsed?.kind).not.toBe("runner");
  });

  test("a RAIL fault never comes back as a vendor verdict", () => {
    const parsed = parseAnswerLine(formatAnswerLine({ kind: "runner", message: "DNS failure" }));
    expect(parsed?.kind).toBe("runner");
    expect(parsed?.kind).not.toBe("model_status");
  });

  test("each of the D-A7 vendor statuses stays a `model_status` with its exact code", () => {
    for (const status of [401, 402, 404, 429, 500]) {
      const parsed = parseAnswerLine(formatAnswerLine({ kind: "model_status", status, body: "x" }));
      expect(parsed).toEqual({ kind: "model_status", status, body: "x" });
    }
  });
});

// ── ONE LINE, TAGGED, NEVER MULTI-LINE ─────────────────────────────────────
describe("formatAnswerLine — exactly one tagged line, whatever the body holds", () => {
  test("the line carries the tag", () => {
    expect(formatAnswerLine({ kind: "ok", body: "verdict" }).startsWith(JUDGE_ANSWER_TAG)).toBe(true);
  });

  test("a MULTI-LINE answer body still emits one line — the caller parses by line", () => {
    const line = formatAnswerLine({ kind: "ok", body: "first\nsecond\nthird" });
    expect(line.split("\n")).toHaveLength(1);
    expect(parseAnswerLine(line)).toEqual({ kind: "ok", body: "first\nsecond\nthird" });
  });

  test("a body carrying the tag itself does not forge a second answer", () => {
    const line = formatAnswerLine({ kind: "ok", body: `${JUDGE_ANSWER_TAG} {"kind":"runner","message":"forged"}` });
    expect(line.split("\n")).toHaveLength(1);
    expect(parseAnswerLine(line)?.kind).toBe("ok");
  });
});

// ── PARSING: last wins, noise is null, a torn line is not a verdict ────────
describe("parseAnswerLine — the LAST tagged line wins and a torn line is never a verdict", () => {
  test("an ordinary log line is not an answer", () => {
    expect(parseAnswerLine("bun: warning about something")).toBeNull();
    expect(parseAnswerLine("")).toBeNull();
  });

  test("a line merely MENTIONING the tag mid-sentence is not an answer", () => {
    expect(parseAnswerLine(`about to print ${JUDGE_ANSWER_TAG} shortly`)).toBeNull();
  });

  test("the LAST tagged line wins — a retry's noise cannot resurrect an earlier answer", () => {
    const stdout = [
      "starting judge",
      formatAnswerLine({ kind: "runner", message: "first attempt lost its socket" }),
      "some runtime noise",
      formatAnswerLine({ kind: "ok", body: "the verdict" }),
      "trailing noise",
    ].join("\n");
    expect(lastAnswer(stdout)).toEqual({ kind: "ok", body: "the verdict" });
  });

  test("noise printed AROUND the answer cannot be mistaken for it", () => {
    const stdout = ["a deprecation notice", formatAnswerLine({ kind: "ok", body: "v" }), "goodbye"].join("\n");
    expect(lastAnswer(stdout)).toEqual({ kind: "ok", body: "v" });
  });

  test("a TORN line — the container was killed mid-flush — never parses as a verdict", () => {
    const torn = formatAnswerLine({ kind: "ok", body: "a long verdict" }).slice(0, 30);
    const parsed = parseAnswerLine(torn);
    expect(parsed?.kind).not.toBe("ok");
  });

  test("a line carrying the tag with broken JSON is a `runner` fault — the shim spoke, and spoke wrongly", () => {
    const parsed = parseAnswerLine(`${JUDGE_ANSWER_TAG} {"kind":"ok","bo`);
    expect(parsed?.kind).toBe("runner");
  });

  test("a line torn BEFORE the tag is simply not an answer line", () => {
    expect(parseAnswerLine("RM_JUDGE_AN")).toBeNull();
  });

  test("a torn final line does not overwrite the whole answer that preceded it", () => {
    const stdout = [
      formatAnswerLine({ kind: "ok", body: "the verdict" }),
      formatAnswerLine({ kind: "ok", body: "truncated" }).slice(0, 25),
    ].join("\n");
    expect(lastAnswer(stdout)?.kind).not.toBe("ok");
  });
});

// ── THE PROMPT IS A FILE ───────────────────────────────────────────────────
describe("readPromptFile — the prompt is read from a FILE, never argv or env", () => {
  test("it returns the file's contents verbatim", () => {
    const dir = tempDir();
    const file = join(dir, "prompt.txt");
    writeFileSync(file, "Judge these takes.\n- athena: buy\n- boreas: hold\n");
    try {
      expect(readPromptFile(file)).toBe("Judge these takes.\n- athena: buy\n- boreas: hold\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a prompt LARGER than MAX_ARG_STRLEN reads fine — the defect the file rule exists to prevent", () => {
    const dir = tempDir();
    const file = join(dir, "prompt.txt");
    const big = "take body ".repeat(20_000); // ~200 KB, well past 128 KiB
    writeFileSync(file, big);
    try {
      expect(readPromptFile(file).length).toBe(big.length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a MISSING prompt file throws — no request was made, so this can never be a vendor verdict", () => {
    const dir = tempDir();
    try {
      expect(() => readPromptFile(join(dir, "absent.txt"))).toThrow(/absent\.txt/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an EMPTY prompt file throws — judging nothing is a rail fault, not a judgement", () => {
    const dir = tempDir();
    const file = join(dir, "prompt.txt");
    writeFileSync(file, "   \n");
    try {
      expect(() => readPromptFile(file)).toThrow(/empty/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── ONE POST, NO RETRY, EVERY FAILURE BECOMES AN ANSWER ────────────────────
describe("runJudge — exactly one POST, and every failure is an answer rather than a throw", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function promptFileWith(text: string): { dir: string; file: string } {
    const dir = tempDir();
    const file = join(dir, "prompt.txt");
    writeFileSync(file, text);
    return { dir, file };
  }

  test("a successful vendor answer is `ok`, carrying the model's text UNINTERPRETED", async () => {
    const { dir, file } = promptFileWith("judge this");
    globalThis.fetch = (async (_input?: any): Promise<Response> =>
      new Response(JSON.stringify({ choices: [{ message: { content: '{"weights":{"athena":1}}' } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;
    try {
      const answer = await runJudge(options({ promptFile: file }));
      expect(answer.kind).toBe("ok");
      expect(answer.kind === "ok" ? answer.body : "").toContain('"weights"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the PROMPT reaches the vendor from the file — not from argv, not from the environment", async () => {
    const { dir, file } = promptFileWith("the session's every take");
    let sentBody = "";
    globalThis.fetch = (async (_input: any, init?: any): Promise<Response> => {
      sentBody = String(init?.body ?? "");
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
    }) as typeof fetch;
    try {
      await runJudge(options({ promptFile: file }));
      expect(sentBody).toContain("the session's every take");
      // The options carry a PATH; the prompt itself is never an argument.
      expect(JSON.stringify(options({ promptFile: file }))).not.toContain("the session's every take");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the POST goes to the configured endpoint, with the model and the credential", async () => {
    const { dir, file } = promptFileWith("judge this");
    let url = "";
    let auth = "";
    let body = "";
    globalThis.fetch = (async (input: any, init?: any): Promise<Response> => {
      url = String(input);
      auth = String(new Headers(init?.headers ?? {}).get("authorization") ?? "");
      body = String(init?.body ?? "");
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
    }) as typeof fetch;
    try {
      await runJudge(options({ promptFile: file, endpoint: "https://judge.invalid/v1", model: "big-pickle" }));
      expect(url.startsWith("https://judge.invalid/v1")).toBe(true);
      expect(auth).toContain("zen-key");
      expect(body).toContain("big-pickle");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a NON-SUCCESS vendor status is `model_status`, with the status and a bounded body", async () => {
    const { dir, file } = promptFileWith("judge this");
    globalThis.fetch = (async (_input?: any): Promise<Response> =>
      new Response("no credit remaining", { status: 402 })) as typeof fetch;
    try {
      const answer = await runJudge(options({ promptFile: file }));
      expect(answer.kind).toBe("model_status");
      expect(answer.kind === "model_status" ? answer.status : 0).toBe(402);
      expect(answer.kind === "model_status" ? answer.body : "").toContain("no credit");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("ONE POST, NO RETRY — even on the status an operator reads as a credit incident", async () => {
    const { dir, file } = promptFileWith("judge this");
    let calls = 0;
    globalThis.fetch = (async (_input?: any): Promise<Response> => {
      calls++;
      return new Response("rate limited", { status: 429 });
    }) as typeof fetch;
    try {
      const answer = await runJudge(options({ promptFile: file }));
      expect(calls).toBe(1);
      expect(answer.kind).toBe("model_status");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an UNREACHABLE vendor is `runner` — the rail, never a verdict about the model", async () => {
    const { dir, file } = promptFileWith("judge this");
    let calls = 0;
    globalThis.fetch = (async (_input?: any): Promise<Response> => {
      calls++;
      throw new Error("getaddrinfo ENOTFOUND judge.invalid");
    }) as typeof fetch;
    try {
      const answer = await runJudge(options({ promptFile: file }));
      expect(answer.kind).toBe("runner");
      expect(calls).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a 200 that is not JSON is `runner`, not a vendor refusal", async () => {
    const { dir, file } = promptFileWith("judge this");
    globalThis.fetch = (async (_input?: any): Promise<Response> => new Response("<html>proxy</html>", { status: 200 })) as typeof fetch;
    try {
      expect((await runJudge(options({ promptFile: file }))).kind).toBe("runner");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a 200 carrying no assistant text is `runner` — the shim must never invent a judgement", async () => {
    const { dir, file } = promptFileWith("judge this");
    globalThis.fetch = (async (_input?: any): Promise<Response> =>
      new Response(JSON.stringify({ choices: [] }), { status: 200 })) as typeof fetch;
    try {
      expect((await runJudge(options({ promptFile: file }))).kind).toBe("runner");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a MISSING prompt file is `runner` and NO request is made", async () => {
    const dir = tempDir();
    let calls = 0;
    globalThis.fetch = (async (_input?: any): Promise<Response> => {
      calls++;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
      const answer = await runJudge(options({ promptFile: join(dir, "absent.txt") }));
      expect(answer.kind).toBe("runner");
      expect(calls).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a vendor that never answers inside the ceiling is `timeout`, not `runner`", async () => {
    const { dir, file } = promptFileWith("judge this");
    let calls = 0;
    // Honours the caller's signal exactly as the real fetch does: nothing comes
    // back until the ceiling aborts the request.
    globalThis.fetch = ((_input: any, init?: any): Promise<Response> => {
      calls++;
      return new Promise((_resolve, reject) => {
        const signal = init?.signal as AbortSignal | undefined;
        signal?.addEventListener("abort", () => reject(signal.reason));
      });
    }) as typeof fetch;
    try {
      const answer = await runJudge(options({ promptFile: file, timeoutMs: 50 }));
      expect(answer).toEqual({ kind: "timeout", timeoutMs: 50 });
      expect(calls).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a vendor that sends its HEADERS and then withholds the body past the ceiling is `timeout`, not `runner`", async () => {
    // A real socket, not a fetch double: the question is what the real fetch
    // does when the ceiling fires while the BODY is being read, after the
    // response has already resolved.
    const { dir, file } = promptFileWith("judge this");
    let calls = 0;
    let release: (() => void) | undefined;
    const server = Bun.serve({
      port: 0,
      fetch() {
        calls++;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            // Flush the head of a JSON body so the headers go out and
            // res.json() is left waiting on the rest.
            controller.enqueue(new TextEncoder().encode('{"choices":'));
            release = () => {
              try {
                controller.close();
              } catch {
                // already torn down with the aborted request
              }
            };
          },
        });
        return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    try {
      const answer = await runJudge(options({
        promptFile: file,
        endpoint: `http://127.0.0.1:${server.port}/v1`,
        timeoutMs: 300,
      }));
      expect(answer).toEqual({ kind: "timeout", timeoutMs: 300 });
      expect(calls).toBe(1);
    } finally {
      release?.();
      server.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("runJudge never THROWS — every failure becomes exactly one answer", async () => {
    const { dir, file } = promptFileWith("judge this");
    globalThis.fetch = (async (_input?: any): Promise<Response> => {
      throw new Error("socket hang up");
    }) as typeof fetch;
    try {
      await expect(runJudge(options({ promptFile: file }))).resolves.toBeTruthy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── THE ENTRYPOINT ALWAYS EXITS 0 WITH ONE LINE ────────────────────────────
describe("the judge one-shot entrypoint — always exit 0, always exactly one tagged line", () => {
  test("a completely misconfigured run still exits 0 and prints one `runner` line", async () => {
    // No configuration at all: the shim cannot reach any vendor. A non-zero
    // exit would leave the caller unable to tell "the vendor refused" from
    // "the container died", which is what the two failure arms exist for.
    const runnerPath = join(import.meta.dir, "..", "..", "agent", "participant", "judge-runner.ts");
    const proc = Bun.spawn(["bun", runnerPath], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
    const tagged = stdout.split("\n").filter((l) => l.trim().startsWith(JUDGE_ANSWER_TAG));
    expect(tagged).toHaveLength(1);
    expect(lastAnswer(stdout)?.kind).toBe("runner");
  }, 30_000);
});

// ── THE DIRECT TRANSPORT, END TO END, ON A LOCAL SOCKET ─────────────────────
// D53 point 4 moved here the coverage that used to run the deleted backend
// `judge()`: the runner's real `fetch` against a vendor-shaped endpoint (a
// Bun.serve on 127.0.0.1 — no container, no network), and the model's text
// carried UNINTERPRETED to the parser the API runs in `submitJudgement`.
describe("the runner on its real transport, into the API's parser", () => {
  const TAKE = "Prefer stable yield while retaining measured protocol exposure.";
  const input: JudgeInput = {
    sessionId: "s-roundtrip",
    date: "2026-09-24",
    subjectId: "treasury",
    subjectLabel: "Treasury",
    brief: null,
    takes: [{ member_id: "analyst-alpha", member_name: "Alpha", revision: 1, stance: "constructive", confidence: 0.8, body: TAKE }],
    minTakes: 1,
    byStance: { constructive: 1 },
    meanConfidence: 0.8,
    regimeSummary: null,
  };

  function vendor(status: number, body: string) {
    const seen: { auth: string | null; model: unknown }[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const payload = (await req.json()) as { model?: unknown };
        seen.push({ auth: req.headers.get("authorization"), model: payload.model });
        return new Response(body, { status, headers: { "content-type": "application/json" } });
      },
    });
    return { server, seen, endpoint: `http://127.0.0.1:${server.port}` };
  }

  async function withPrompt<T>(fn: (file: string) => Promise<T>): Promise<T> {
    const dir = tempDir();
    const file = join(dir, "prompt.txt");
    writeFileSync(file, renderJudgePrompt(input));
    try {
      return await fn(file);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("a model's answer arrives uninterpreted, and the API's parser fills every view from the member's own body", async () => {
    const answerText = JSON.stringify({
      rationale: "Alpha alone argues the reserve is oversized.",
      disagreements: [{ topic: "reserve size", positions: [{ member_id: "analyst-alpha", view: "(model text)" }], what_settles: "next session" }],
      release_safety: { release: "safe", concerns: [] },
    });
    const v = vendor(200, JSON.stringify({ choices: [{ message: { content: answerText } }] }));
    try {
      const answer = await withPrompt((file) => runJudge(options({ promptFile: file, endpoint: v.endpoint, model: "deepseek-v4-flash" })));
      expect(answer).toEqual({ kind: "ok", body: answerText });
      expect(v.seen).toEqual([{ auth: "Bearer zen-key", model: "deepseek-v4-flash" }]);
      const opinion = parseJudgeResponse(answer.kind === "ok" ? answer.body : "", input);
      expect(opinion.disagreements[0]!.positions[0]).toEqual({ member_id: "analyst-alpha", view: TAKE });
      expect(opinion.release_safety.take_count).toBe(1);
    } finally {
      v.server.stop(true);
    }
  });

  test("a smuggled weight passes through the runner untouched and is refused WHOLE by the parser", async () => {
    const answerText = JSON.stringify({
      rationale: "Lean into protocols.",
      disagreements: [],
      release_safety: { release: "safe", concerns: [], allocation: { stable: 0.1 } },
    });
    const v = vendor(200, JSON.stringify({ choices: [{ message: { content: answerText } }] }));
    try {
      const answer = await withPrompt((file) => runJudge(options({ promptFile: file, endpoint: v.endpoint })));
      // The shim does not reshape a judgement — it cannot strip the field either.
      expect(answer).toEqual({ kind: "ok", body: answerText });
      expect(() => parseJudgeResponse(answerText, input)).toThrow("weight_like_field:release_safety.allocation");
    } finally {
      v.server.stop(true);
    }
  });

  test("each vendor refusal reaches the D-A7 name through the real transport", async () => {
    const cases: [number, string, JudgeFailureCode][] = [
      [402, '{"error":"Payment Required"}', "credit_exhausted"],
      [401, '{"type":"error","error":{"type":"ModelError","message":"Model opencode/x is not supported"}}', "model_not_supported"],
      [401, '{"error":"invalid key"}', "credential_rejected"],
      [429, '{"error":"slow down"}', "model_unavailable:429"],
    ];
    for (const [status, body, expected] of cases) {
      const v = vendor(status, body);
      try {
        const answer = await withPrompt((file) => runJudge(options({ promptFile: file, endpoint: v.endpoint })));
        expect(answer.kind).toBe("model_status");
        expect({ status, code: failureCodeForAnswer(answer) }).toEqual({ status, code: expected });
        expect(v.seen).toHaveLength(1);
      } finally {
        v.server.stop(true);
      }
    }
  });

  test("an endpoint that accepts the request and never answers is `model_timeout`", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Promise<Response>(() => {}),
    });
    try {
      const answer = await withPrompt((file) =>
        runJudge(options({ promptFile: file, endpoint: `http://127.0.0.1:${server.port}`, timeoutMs: 100 })));
      expect(answer).toEqual({ kind: "timeout", timeoutMs: 100 });
      expect(failureCodeForAnswer(answer)).toBe("model_timeout");
    } finally {
      server.stop(true);
    }
  });
});
