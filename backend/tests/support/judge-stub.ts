// A REAL judge rail, served locally, for tests that drive the judge through a
// seam with no injectable transport (issue #969).
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
// WHAT IT STANDS IN FOR CHANGED IN #1012, AND ONLY HERE. The judge no longer
// calls the model in-process: it asks the `agent-launcher` service to run one
// short-lived container per judging and reads that container's single answer
// line back. So this stub now serves the LAUNCHER's route rather than the
// vendor's `/chat/completions`. Every caller is unchanged — `setJudgeStubAnswer`
// still takes the raw assistant content — which is the point: the move was
// meant to change how the judge's model call is CARRIED, not what any caller of
// judge() sees, and a stub that had to be re-taught at every call site would
// have been evidence that it did not hold.
//
// The answer is member-independent: an empty `disagreements` array is valid and
// needs no knowledge of the take set, so one stub serves every session.
import { JUDGE_LAUNCH_PATH } from "../../src/swarm/judge-launcher.ts";

/** Model id these tests configure. Any non-empty string works; this one is legible. */
export const STUB_JUDGE_MODEL = "test/judge-model";

export const STUB_JUDGE_ANSWER = JSON.stringify({
  rationale: "The submitted takes converge; this is the local stub judge's opinion.",
  disagreements: [],
  release_safety: { release: "safe", concerns: [] },
});

let server: ReturnType<typeof Bun.serve> | null = null;
let saved: { launcherUrl?: string; apiKey?: string } = {};
let answer = STUB_JUDGE_ANSWER;

/**
 * Serve a DIFFERENT answer until `resetJudgeStubAnswer()`. The one caller that
 * needs this is the weight-smuggling boundary (judge.ts's WEIGHT_LIKE_KEYS):
 * proving that a model which TRIES to author an allocation cannot move the
 * receipt's vector needs a model that actually tries. Pass the raw assistant
 * content, exactly as the container would have read off the model.
 */
export function setJudgeStubAnswer(content: string): void { answer = content; }
export function resetJudgeStubAnswer(): void { answer = STUB_JUDGE_ANSWER; }

/** Start the stub and point the judge transport at it. Call from `beforeAll`. */
export function installJudgeStub(): void {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      // The transport posts `{model, prompt, timeoutMs}` to the launcher's one
      // route and reads back one `JudgeLaunchAnswer`; answer in kind. Anything
      // else is a 404 so a transport that started calling a DIFFERENT endpoint
      // fails loudly here instead of quietly falling back to template prose.
      if (new URL(req.url).pathname !== JUDGE_LAUNCH_PATH) return new Response("not found", { status: 404 });
      return Response.json({ ok: true, text: answer });
    },
  });
  saved = { launcherUrl: process.env.SWARM_AGENT_LAUNCHER_URL, apiKey: process.env.OPENCODE_API_KEY };
  process.env.SWARM_AGENT_LAUNCHER_URL = `http://127.0.0.1:${server.port}`;
  // resolveJudgeTransport() needs BOTH a credential and a model. The stub never
  // checks the key; its ABSENCE is one of the refusals under test elsewhere —
  // and the process-level credential gate is deliberately unchanged by #1012,
  // because a deployment that cannot reach a funded model must still fail closed
  // before it starts a container that would only 401.
  process.env.OPENCODE_API_KEY = "test-key-not-a-real-credential";
}

/** Stop the stub and restore the environment. Call from `afterAll`. */
export function removeJudgeStub(): void {
  answer = STUB_JUDGE_ANSWER;
  server?.stop(true);
  server = null;
  if (saved.launcherUrl === undefined) delete process.env.SWARM_AGENT_LAUNCHER_URL;
  else process.env.SWARM_AGENT_LAUNCHER_URL = saved.launcherUrl;
  if (saved.apiKey === undefined) delete process.env.OPENCODE_API_KEY;
  else process.env.OPENCODE_API_KEY = saved.apiKey;
}
