// T06 · THE POLICY IS RE-ASSERTED WHERE THE MODEL IS USED, NOT ONLY WHERE IT
// IS WRITTEN (AC-MODEL-01).
//
// setJudgeConfig() refuses a disqualified model, but it has never been the only
// writer swarm_judge_config has: a restored backup, a psql session, a migration
// and any release of this code older than the policy all bypass it. The read
// path used to post whatever the column held straight to Zen, so a keyless id
// that arrived by any of those routes produced judgements — which land in
// signed, append-only rows (migration 0040) and disqualify the whole run.
//
// It fails CLOSED with a NAMED reason rather than returning null: a null reads
// as "nothing was configured", which is a different operator problem with a
// different fix.
import { expect, test } from "bun:test";
import { JudgeUnavailableError, resolveJudgeTransport } from "../src/swarm/judge.ts";
import { PINNED_JUDGE_MODEL } from "../src/swarm/judge-model-policy.ts";

const KEY = { OPENCODE_API_KEY: "sk-not-real" };

test("a keyless free-family model is refused at USE, in every environment", () => {
  const envs: Record<string, string | undefined>[] = [
    { ...KEY, RM_ENV: "ephemeral" },
    { ...KEY, RM_ENV: "smoke" },
    { ...KEY, RM_ENV: "prod" },
    { ...KEY },
  ];
  for (const env of envs) {
    let thrown: unknown;
    try {
      resolveJudgeTransport("nemotron-3-ultra-free", env);
    } catch (err) {
      thrown = err;
    }
    expect(thrown, `RM_ENV=${env.RM_ENV ?? "<unset>"}`).toBeInstanceOf(JudgeUnavailableError);
    expect((thrown as JudgeUnavailableError).reason).toBe("model_disallowed");
    expect((thrown as JudgeUnavailableError).model).toBe("nemotron-3-ultra-free");
  }
});

test("on an acceptance path only the pinned model builds a transport", () => {
  expect(() => resolveJudgeTransport("kimi-k3", { ...KEY, RM_ENV: "prod" }))
    .toThrow(JudgeUnavailableError);
  // ...and an UNSET RM_ENV is an acceptance path too (D13) — the case a
  // container that never received the value would be in.
  expect(() => resolveJudgeTransport("kimi-k3", { ...KEY })).toThrow(JudgeUnavailableError);
  expect(resolveJudgeTransport(PINNED_JUDGE_MODEL, { ...KEY, RM_ENV: "prod" })?.model)
    .toBe(PINNED_JUDGE_MODEL);
});

test("development keeps its stub ids — its judgements are not evidence", () => {
  expect(resolveJudgeTransport("test/judge-model", { ...KEY, RM_ENV: "ephemeral" })?.model)
    .toBe("test/judge-model");
  expect(resolveJudgeTransport("stub-judge", { ...KEY, RM_ENV: "smoke" })?.model).toBe("stub-judge");
});

test("the long-standing gaps still return null, not a refusal", () => {
  // No model configured at all, and a model with no credential: both are
  // "nothing was configured", which judgeConfigGap() classifies for the
  // operator. Turning either into model_disallowed would misreport the fix.
  expect(resolveJudgeTransport(null, { ...KEY, RM_ENV: "prod" })).toBeNull();
  expect(resolveJudgeTransport("", { ...KEY, RM_ENV: "prod" })).toBeNull();
  expect(resolveJudgeTransport(PINNED_JUDGE_MODEL, { RM_ENV: "prod" })).toBeNull();
});
