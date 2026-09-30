// THE JUDGE'S IN-CONTAINER SHIM (issue #1012).
//
// One short-lived container per judging call, launched on the SAME rail a
// member agent rides (scripts/agent/member-agent.ts's runMemberAgent(), in the
// `commandMode` seam scripts/lib/swarm/agent.ts already uses for session
// participation). This file is the whole of what runs inside it: read one
// prompt, make one POST, write one line, exit.
//
// WHAT THIS DELIBERATELY IS NOT.
//
//   - NOT an opencode run. The judge has no tools, no session and no turn loop;
//     giving it the CLI would give it a filesystem, a network and a budget it
//     has no use for. `--entrypoint bun` replaces the image's `opencode`
//     entrypoint, which is the one thing that makes this rail reusable without
//     a second launch path.
//   - NOT a persona. No lens, no bias, no identity volume, no keystore — the
//     judge signs nothing and remembers nothing between calls, so the member
//     rail's persistent HOME volume is exactly what it must NOT be given.
//   - NOT an opinion parser. `parseJudgeResponse()`, `findWeightLikeKey()` and
//     the whole D-A7 error taxonomy stay in backend/src/swarm/judge.ts, on the
//     HOST. This file must never decide what the model meant: a container that
//     could grade its own answer is a container that could manufacture one.
//
// THE PROMPT ARRIVES AS A FILE, not as an argument or an environment variable.
// It carries every take body in the session and routinely runs to tens of
// kilobytes; Linux caps a single argv/env entry at 128 KiB (MAX_ARG_STRLEN), so
// an env-var prompt would work in development and truncate the first busy
// session in production. The launcher writes it into the shared spool directory
// and mounts that one file read-only.
//
// THE ANSWER IS ONE LINE, tagged, on stdout — the same RM_<TAG> protocol
// scripts/agent/member-session-client.ts uses, so the host reads the LAST
// tagged line and any noise the runtime prints around it (a Bun warning, a
// deprecation notice) cannot be mistaken for the answer.

/** The stdout tag the launcher greps for. One line, the last one wins. */
export const JUDGE_RUNNER_TAG = "RM_JUDGE";

/**
 * Exactly what this file may put on that line — and it is STRUCTURALLY THE SAME
 * type as backend/src/swarm/judge.ts's `JudgeLaunchAnswer`, deliberately, so
 * the launcher relays the container's line verbatim instead of translating it.
 * A translation layer between two three-case unions is a place for a case to go
 * missing, which for the `model_status` case would mean an exhausted account
 * reported as a rail fault.
 *
 * `model_status` is kept APART from `launcher` on purpose: the first is the
 * vendor refusing (a 402 with no credit, a 401 with a bad key, a 401 naming the
 * model), which the host must classify with its existing credit / credential /
 * unsupported-id taxonomy; the second is this shim, its network, or the launch
 * itself failing — the RAIL, which must never be reported as a verdict about
 * the model.
 */
export type JudgeRunnerLine =
  | { ok: true; text: string; providerUsage?: unknown }
  | { ok: false; kind: "model_status"; status: number; body: string }
  | { ok: false; kind: "launcher"; detail: string };

export const DEFAULT_RUNNER_BASE_URL = "https://opencode.ai/zen/v1";
/** Same bound the provider bodies get host-side — a body is a label, not a payload. */
const BODY_LABEL_MAX = 400;

export function encodeRunnerLine(line: JudgeRunnerLine): string {
  return `${JUDGE_RUNNER_TAG} ${JSON.stringify(line)}`;
}

/**
 * Read the LAST tagged line out of a container's stdout, or null when it wrote
 * none. Exported so the host parses the container's answer with the very
 * function that wrote it, rather than with a second regex that can drift.
 */
export function parseRunnerLine(stdout: string): JudgeRunnerLine | null {
  let found: JudgeRunnerLine | null = null;
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith(`${JUDGE_RUNNER_TAG} `)) continue;
    try {
      const parsed = JSON.parse(line.slice(JUDGE_RUNNER_TAG.length + 1)) as JudgeRunnerLine;
      if (parsed && typeof parsed === "object" && "ok" in parsed) found = parsed;
    } catch {
      // A half-written line (the container was killed mid-flush) is not an
      // answer. Keep looking; an absent answer is the launcher's problem to
      // report, and reporting a torn one as a verdict would be worse.
    }
  }
  return found;
}

/**
 * ONE POST. No retry, no backoff, no second endpoint.
 *
 * A retry here would be invisible to the host's timeout accounting and would
 * double-charge an exhausted account on the one status the QA plan makes a stop
 * condition. If the call fails the container says so and dies; the host decides
 * whether that was the model, the credential or the rail.
 */
export async function runJudgeCompletion(o: {
  baseUrl: string;
  model: string;
  apiKey: string;
  prompt: string;
  signal?: AbortSignal;
}): Promise<JudgeRunnerLine> {
  let res: Response;
  try {
    res = await fetch(`${o.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      ...(o.signal ? { signal: o.signal } : {}),
      headers: { "content-type": "application/json", authorization: `Bearer ${o.apiKey}` },
      body: JSON.stringify({
        model: o.model,
        temperature: 0,
        messages: [{ role: "user", content: o.prompt }],
      }),
    });
  } catch (err) {
    // The vendor was never reached. That is the RAIL, not a verdict about the
    // model — see this type's doc comment.
    return { ok: false, kind: "launcher", detail: `model endpoint unreachable: ${message(err)}` };
  }
  if (!res.ok) {
    let body = "";
    try { body = (await res.text()).slice(0, BODY_LABEL_MAX); } catch { body = ""; }
    return { ok: false, kind: "model_status", status: res.status, body };
  }
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch (err) {
    return { ok: false, kind: "launcher", detail: `model answer was not JSON: ${message(err)}` };
  }
  const content = (parsed as { choices?: { message?: { content?: unknown } }[] } | null)
    ?.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    return { ok: false, kind: "launcher", detail: "model answer carried no assistant text" };
  }
  // The provider's own cost report, RELAYED UNPARSED. parseJudgeUsage() lives
  // host-side and reads exactly these two fields; copying its rules here would
  // be a second source of truth for what one judgement cost.
  const providerUsage = {
    usage: (parsed as { usage?: unknown }).usage,
    cost: (parsed as { cost?: unknown }).cost,
  };
  return { ok: true, text: content, providerUsage };
}

function message(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, BODY_LABEL_MAX);
}

/** Env names this shim reads. The credential's name is the registry's, not ours. */
export const JUDGE_RUNNER_ENV = {
  model: "RM_JUDGE_MODEL",
  baseUrl: "RM_JUDGE_BASE_URL",
  promptFile: "RM_JUDGE_PROMPT_FILE",
  apiKey: "OPENCODE_API_KEY",
} as const;

export async function main(env: Record<string, string | undefined> = process.env): Promise<JudgeRunnerLine> {
  const model = (env[JUDGE_RUNNER_ENV.model] ?? "").trim();
  const apiKey = (env[JUDGE_RUNNER_ENV.apiKey] ?? "").trim();
  const promptFile = (env[JUDGE_RUNNER_ENV.promptFile] ?? "").trim();
  const baseUrl = (env[JUDGE_RUNNER_ENV.baseUrl] ?? "").trim() || DEFAULT_RUNNER_BASE_URL;
  // Each of these is the launcher having built the run wrong, which is the rail
  // failing before the vendor was ever involved — never a model verdict.
  if (!model) return { ok: false, kind: "launcher", detail: `${JUDGE_RUNNER_ENV.model} was not injected` };
  if (!apiKey) return { ok: false, kind: "launcher", detail: `${JUDGE_RUNNER_ENV.apiKey} was not injected` };
  if (!promptFile) return { ok: false, kind: "launcher", detail: `${JUDGE_RUNNER_ENV.promptFile} was not injected` };
  let prompt: string;
  try {
    prompt = await Bun.file(promptFile).text();
  } catch (err) {
    return { ok: false, kind: "launcher", detail: `prompt file unreadable: ${message(err)}` };
  }
  if (prompt.trim() === "") return { ok: false, kind: "launcher", detail: "prompt file was empty" };
  return runJudgeCompletion({ baseUrl, model, apiKey, prompt });
}

// `import.meta.main` is false when a test imports this file, so the helpers
// above are unit-testable without a container and without a network.
if (import.meta.main) {
  const line = await main();
  // ALWAYS exit 0 with a line. A non-zero exit carrying no line would leave the
  // launcher unable to tell "the vendor refused" from "the container died",
  // which is precisely the distinction the two `ok: false` kinds exist for.
  console.log(encodeRunnerLine(line));
}
