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
//   1. THE THREE-CASE UNION, AND ITS TWO FAILURE ARMS NEVER COLLAPSE.
//      `model_status` is the VENDOR refusing — a product fact that feeds the
//      D-A7 taxonomy and tells an operator to add credit or fix a key.
//      `runner` is THIS SHIM, its network or its launch failing — an
//      infrastructure fact about our own deployment. Collapse them and a rail
//      fault sends an operator to top up an account that was never charged,
//      while a vendor refusal sends them to debug a container that worked.
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
describe("the three-case answer union survives the stdout round trip", () => {
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
