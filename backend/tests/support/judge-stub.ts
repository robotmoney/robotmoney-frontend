// A REAL judge endpoint, served locally, for tests that drive the judge
// through a seam with no injectable transport (issue #969).
//
// WHY THIS EXISTS NOW AND DID NOT BEFORE. Until #969 these tests leaned on
// `swarm_judge_config.model` being NULL: with no model there was no transport,
// judge() fell back to template prose, and an admin- or queue-driven judging
// produced "a complete, anchorable opinion" with no network involved. That is
// the production defect those tests were unknowingly modelling — a judging
// that never happened, recorded and then SIGNED as one. The judge now refuses
// without a model, so a test that wants a real judgement has to give it
// something real to talk to.
//
// The answer is member-independent: an empty `disagreements` array is valid and
// needs no knowledge of the take set, so one stub serves every session.

/** Model id these tests configure. Any non-empty string works; this one is legible. */
export const STUB_JUDGE_MODEL = "test/judge-model";

export const STUB_JUDGE_ANSWER = JSON.stringify({
  rationale: "The submitted takes converge; this is the local stub judge's opinion.",
  disagreements: [],
  release_safety: { release: "safe", concerns: [] },
});

let server: ReturnType<typeof Bun.serve> | null = null;
let saved: { baseUrl?: string; apiKey?: string } = {};

/** Start the stub and point the judge transport at it. Call from `beforeAll`. */
export function installJudgeStub(): void {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      // The transport posts OpenAI-shaped chat completions; answer in kind.
      if (!new URL(req.url).pathname.endsWith("/chat/completions")) {
        return new Response("not found", { status: 404 });
      }
      return Response.json({ choices: [{ message: { content: STUB_JUDGE_ANSWER } }] });
    },
  });
  saved = { baseUrl: process.env.SWARM_JUDGE_BASE_URL, apiKey: process.env.OPENCODE_API_KEY };
  process.env.SWARM_JUDGE_BASE_URL = `http://127.0.0.1:${server.port}`;
  // resolveJudgeTransport() needs BOTH a credential and a model. The stub never
  // checks the key; its ABSENCE is one of the refusals under test elsewhere.
  process.env.OPENCODE_API_KEY = "test-key-not-a-real-credential";
}

/** Stop the stub and restore the environment. Call from `afterAll`. */
export function removeJudgeStub(): void {
  server?.stop(true);
  server = null;
  if (saved.baseUrl === undefined) delete process.env.SWARM_JUDGE_BASE_URL;
  else process.env.SWARM_JUDGE_BASE_URL = saved.baseUrl;
  if (saved.apiKey === undefined) delete process.env.OPENCODE_API_KEY;
  else process.env.OPENCODE_API_KEY = saved.apiKey;
}
