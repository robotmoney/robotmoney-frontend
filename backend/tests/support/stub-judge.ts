// A local stand-in for the OpenCode Zen endpoint, for tests that need a
// judgement to EXIST.
//
// WHY THIS HAS TO EXIST NOW. The judge has no modelless path any more: it
// returns a model's opinion or throws (see judge.ts, "NO FALLBACK"). Before
// that, a test could reach a recorded judgement with `transport: null` and get
// template prose — which is exactly the thing the product must never record, so
// it could not stay as the tests' cheap default either. Everything that needs a
// judgement on file now answers with this.
//
// It speaks the chat-completions shape the real transport posts to, so
// `resolveJudgeTransport()` and `wireModelId()` run for real rather than being
// stubbed around — the bare-vs-qualified model id bug that cost this release a
// day (Zen answers a qualified id with HTTP 401) would surface here.
import { afterAll } from "bun:test";

/** The selector to put in `swarm_judge_config.model` to reach this server. */
export const STUB_JUDGE_MODEL = "stub/judge";

/** A valid judge response. `disagreements` is empty so one reply serves every
 *  session — an empty array is a correct answer, and it needs no real member
 *  ids, which a `positions[]` entry would. */
export const STUB_JUDGE_REPLY = JSON.stringify({
  rationale: "Stub judge: the submitted takes support the session's read.",
  disagreements: [],
  release_safety: { release: "safe", concerns: [] },
});

let body = STUB_JUDGE_REPLY;

/** Make the next answers something else — malformed output, a refusal, a
 *  smuggled weight. Resets with `stubJudgeReset()`. */
export function stubJudgeAnswers(text: string): void {
  body = text;
}

export function stubJudgeReset(): void {
  body = STUB_JUDGE_REPLY;
}

const server = Bun.serve({
  port: 0,
  fetch: async () => Response.json({ choices: [{ message: { content: body } }] }),
});

/**
 * Point the judge at this server. Call once per suite, at import time — it sets
 * the two environment variables `resolveJudgeTransport()` reads.
 *
 * The key is only set when absent, so a runner that carries a real
 * OPENCODE_API_KEY keeps it (the base URL still redirects the call here, so no
 * test spends money).
 */
export function useStubJudge(): void {
  process.env.SWARM_JUDGE_BASE_URL = `http://127.0.0.1:${server.port}`;
  process.env.OPENCODE_API_KEY ||= "sk-stub-judge-key";
}

afterAll(() => server.stop(true));
