// THE JUDGE'S TRANSPORT AFTER IT STOPPED CALLING THE MODEL IN-PROCESS (#1012).
//
// resolveJudgeTransport() no longer fetches Zen. It asks the agent-launcher
// service to run ONE short-lived container per judging call and reads that
// container's single answer line back. The launcher hop is the new thing that
// can fail, and this file is about the one question that move raises:
//
//   WHEN THE RAIL BREAKS, IS IT REPORTED AS THE RAIL?
//
// It matters because three failures now arrive down the same `await`, and two
// of them already had meanings that must not change:
//
//   - the MODEL refused (402 no credit, 401 bad key, 401 unknown id). The
//     container relays the status and the bounded body, and this must still
//     become a `JudgeTransportError` that judgeTransportGap() classifies exactly
//     as it did when the fetch was in-process. A judging that stops being able
//     to tell an exhausted account from an outage is how a signed consensus
//     receipt gets manufactured (QA plan §4.1) — the whole reason that taxonomy
//     exists.
//   - the RAIL broke (launcher unreachable, non-2xx, unreadable body, a
//     container that never launched / hung / wrote nothing). New, and it must
//     be `launcher_unavailable` — not `model_unavailable:` (which would publish
//     template prose under the judge's name on every session for as long as the
//     launcher is down) and not `credential_rejected` (which would send an
//     operator to rotate a key that is fine).
//   - the CALLER's own deadline fired. Unchanged: `model_timeout`, the
//     deterministic-fallback path.
//
// EVERY CASE HERE STUBS `fetch` — there is no launcher, no daemon and no
// network in this file. The container-launch behaviour itself is exercised
// against a real Docker daemon in
// scripts/tests/integration/judge-container-launch.test.ts; this file is the
// classification half, which is the half that must be right when everything
// else is at its worst.
import { afterEach, expect, test } from "bun:test";
import {
  JudgeLauncherError,
  JudgeTransportError,
  judgeTransportGap,
  JudgeUnavailableError,
  resolveJudgeTransport,
  DEFAULT_JUDGE_LAUNCHER_URL,
  JUDGE_LAUNCH_PATH,
  judge,
  type JudgeInput,
} from "../src/swarm/judge.ts";

// Development path (D13): a stub model id is allowed to build a transport here,
// which is what lets this file assert classification without pinning itself to
// the production model.
const ENV = { RM_ENV: "ephemeral", OPENCODE_API_KEY: "sk-test-not-real" } as const;

const savedFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = savedFetch; });

/** Replace `fetch` and record exactly what the transport asked the launcher for. */
function stubLauncher(handler: (req: { url: string; body: any }) => Response | Promise<Response>) {
  const calls: { url: string; body: any }[] = [];
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : String(input?.url ?? input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, body });
    return handler({ url, body });
  }) as unknown as typeof fetch;
  return calls;
}

function transport() {
  const t = resolveJudgeTransport("test/judge-model", ENV);
  expect(t).not.toBeNull();
  return t!;
}

async function completeThrows(t: ReturnType<typeof transport>): Promise<unknown> {
  try {
    await t.complete("the rendered judge prompt", new AbortController().signal);
    return null;
  } catch (err) {
    return err;
  }
}

test("the transport asks the LAUNCHER, not the vendor, and never sends the key", async () => {
  const calls = stubLauncher(() =>
    Response.json({ ok: true, text: "the judge's prose", providerUsage: { usage: { total_tokens: 12 }, cost: "0.5" } }));
  const out = await transport().complete("the rendered judge prompt", new AbortController().signal);

  expect(calls).toHaveLength(1);
  expect(calls[0]!.url).toBe(`${DEFAULT_JUDGE_LAUNCHER_URL}${JUDGE_LAUNCH_PATH}`);
  // THE POINT OF THE WHOLE MOVE: this process posts a prompt to an internal
  // service. It does not post to opencode.ai, and it does not hand the
  // credential across the hop — the launcher holds its own copy and injects it
  // into the container it starts, exactly as a member agent's is injected.
  expect(calls[0]!.url).not.toContain("opencode.ai");
  expect(JSON.stringify(calls[0]!.body)).not.toContain("sk-test-not-real");
  expect(calls[0]!.body).toMatchObject({ model: "test/judge-model", prompt: "the rendered judge prompt" });
  expect(calls[0]!.body.timeoutMs).toBeGreaterThan(0);

  // The provider's own cost report survives the extra hop UNPARSED and is read
  // by the same host-side parseJudgeUsage() that read it out of a fetch body
  // (R19: the spend must still be recordable).
  expect(out).toEqual({ text: "the judge's prose", usage: { inputTokens: null, outputTokens: null, totalTokens: 12, costUsd: 0.5 } });
});

test("a VENDOR refusal relayed by the container is still the typed, status-carrying error", async () => {
  // Each of these is the model/account saying no. The container did its job;
  // classifying them as a rail fault would tell an operator to look at the
  // launcher while an exhausted workspace kept publishing.
  const cases: [number, string, string][] = [
    [402, '{"error":{"message":"Insufficient balance"}}', "credit_exhausted"],
    [401, '{"error":{"message":"invalid api key"}}', "credential_rejected"],
    [401, '{"error":{"message":"ModelError: not supported"}}', "model_not_supported"],
  ];
  for (const [status, body, expected] of cases) {
    stubLauncher(() => Response.json({ ok: false, kind: "model_status", status, body }));
    const thrown = await completeThrows(transport());
    expect(thrown, `${status} ${body}`).toBeInstanceOf(JudgeTransportError);
    expect((thrown as JudgeTransportError).status).toBe(status);
    expect(judgeTransportGap(thrown)).toBe(expected as any);
  }
});

test("a LAUNCHER failure is launcher_unavailable — never a model or credential verdict", async () => {
  // The four shapes a broken rail arrives in. Every one of them used to be
  // impossible (there was no rail), and every one of them must classify away
  // from both the fallback path and the credential path.
  const shapes: [string, () => void][] = [
    ["connection refused", () => stubLauncher(() => { throw new Error("connect ECONNREFUSED 172.18.0.5:8799"); })],
    ["non-2xx from the launcher", () => stubLauncher(() => new Response("upstream boom", { status: 502 }))],
    ["a body that is not JSON", () => stubLauncher(() => new Response("<html>nope</html>", { status: 200 }))],
    ["the launcher reporting a dead container", () =>
      stubLauncher(() => Response.json({ ok: false, kind: "launcher", detail: "judge container never launched" }))],
    ["an ok answer with no text", () => stubLauncher(() => Response.json({ ok: true }))],
    ["an answer of no recognised shape", () => stubLauncher(() => Response.json({ surprise: true }))],
  ];
  for (const [label, arm] of shapes) {
    arm();
    const thrown = await completeThrows(transport());
    expect(thrown, label).toBeInstanceOf(JudgeLauncherError);
    expect(judgeTransportGap(thrown), label).toBe("launcher_unavailable");
    // NOT any of the neighbours. Spelled out rather than implied, because the
    // failure mode this guards against is a future refactor folding the new
    // reason back into one of them for tidiness.
    expect(["credit_exhausted", "credential_rejected", "model_not_supported"]).not.toContain(judgeTransportGap(thrown));
  }
});

// The reason has to survive the trip through judge() itself, not merely exist
// in the classifier — that is the difference between a taxonomy and a label.
test("judge() FAILS CLOSED on a launcher failure: no judgement, no prose, a named reason", async () => {
  const input: JudgeInput = {
    sessionId: "s", date: "2026-09-18", subjectId: "subj", subjectLabel: "Subj",
    brief: null, minTakes: 1, byStance: { bullish: 1 }, meanConfidence: 0.6, regimeSummary: null,
    takes: [{ member_id: "m1", member_name: "M", revision: 1, stance: "bullish", confidence: 0.6, body: "a real take body" }],
  };
  stubLauncher(() => Response.json({ ok: false, kind: "launcher", detail: "judge container never launched" }));
  let thrown: unknown;
  try {
    await judge(input, { transport: resolveJudgeTransport("test/judge-model", ENV), timeoutMs: 5_000 });
  } catch (err) {
    thrown = err;
  }
  // A THROW, not a fallback outcome. If this ever returns instead, a stack with
  // a dead launcher publishes deterministic prose on a signed receipt for every
  // session it judges — which is the D-A7 forgery, rebuilt one layer out.
  expect(thrown).toBeInstanceOf(JudgeUnavailableError);
  expect((thrown as JudgeUnavailableError).reason).toBe("launcher_unavailable");
  expect((thrown as JudgeUnavailableError).model).toBe("test/judge-model");
});

test("the CALLER's own deadline is still model_timeout, not a launcher fault", async () => {
  // The one failure that is neither the rail nor the vendor: judge() gave up
  // waiting. It keeps the deterministic fallback (AC-FE-05) it has always had,
  // so adding the launcher hop did not quietly turn every slow judging into a
  // fail-closed refusal.
  const input: JudgeInput = {
    sessionId: "s", date: "2026-09-18", subjectId: "subj", subjectLabel: "Subj",
    brief: null, minTakes: 1, byStance: { bullish: 1 }, meanConfidence: 0.6, regimeSummary: null,
    takes: [{ member_id: "m1", member_name: "M", revision: 1, stance: "bullish", confidence: 0.6, body: "a real take body" }],
  };
  globalThis.fetch = ((_input: any, init?: any) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    })) as unknown as typeof fetch;
  const outcome = await judge(input, { transport: resolveJudgeTransport("test/judge-model", ENV), timeoutMs: 30 });
  expect(outcome.source).toBe("fallback");
  expect(outcome.fallbackReason).toBe("model_timeout");
});

test("SWARM_AGENT_LAUNCHER_URL points the transport at a different launcher", async () => {
  const calls = stubLauncher(() => Response.json({ ok: true, text: "prose" }));
  const t = resolveJudgeTransport("test/judge-model", { ...ENV, SWARM_AGENT_LAUNCHER_URL: "http://elsewhere:9000/" });
  await t!.complete("p", new AbortController().signal);
  // Trailing slash normalised — a compose value with one must not produce a
  // double-slash path the launcher's router would 404.
  expect(calls[0]!.url).toBe(`http://elsewhere:9000${JUDGE_LAUNCH_PATH}`);
});
