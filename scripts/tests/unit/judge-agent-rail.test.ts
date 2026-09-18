// The PURE half of the judge's container rail (issue #1012) — the argv it
// builds, the ceiling it gives the container, and the one line the container
// writes. Its Docker-backed half is
// scripts/tests/integration/judge-container-launch.test.ts, which starts real
// containers against a real daemon; the split is the D23 cost-class rule
// (docs/architecture.md §3 L1), and both halves run on every PR.
//
// WHAT THIS FILE IS REALLY GUARDING. The issue's whole premise is that a judge
// and a member agent are the same kind of actor and must be started the same
// way — so the failures worth pinning are the ones where the judge quietly
// becomes a special case again:
//
//   1. It stops using the shared primitive and grows its own launch path.
//   2. It gains a persistent identity volume, or the opencode CLI, or a
//      persona — the three things a member has and a judge must not.
//   3. Its container ceiling drifts up to meet judge()'s own deadline, so a
//      hung container starts racing into `model_timeout` (a verdict about a
//      model that was never reached) instead of `launcher_unavailable`.
//   4. The container's answer line starts carrying an OPINION rather than text
//      — the moment a container could grade its own answer, it could
//      manufacture one.
//
// No Docker, no network, no model: every assertion here is over pure functions.
import { describe, expect, test } from "bun:test";
import { buildMemberAgentArgv } from "../../agent/member-agent.ts";
import {
  encodeRunnerLine,
  parseRunnerLine,
  runJudgeCompletion,
  main as runnerMain,
  JUDGE_RUNNER_TAG,
  type JudgeRunnerLine,
} from "../../agent/judge-runner.ts";
import {
  judgeContainerTimeoutMs,
  judgeRailFromEnv,
  launcherSpoolDir,
  readAnswer,
  JUDGE_PROMPT_ENTRY,
  JUDGE_RUNNER_ENTRY,
  LAUNCHER_RESPONSE_MARGIN_MS,
  MIN_JUDGE_CONTAINER_TIMEOUT_MS,
} from "../../agent/judge-agent.ts";
import { createUnavailableLauncherFetch, parseLaunchRequest } from "../../agent/agent-launcher.ts";
import { JUDGE_LAUNCH_PATH, JUDGE_LAUNCHER_HEALTH_PATH } from "../../../backend/src/swarm/judge-launcher.ts";

// The exact argv runJudgeAgent() hands Bun.spawn, reproduced here from the same
// builder. Reproducing the CALL rather than exporting the argv keeps this an
// assertion about the shared primitive's behaviour, not about a private helper.
function judgeArgv(overrides: Partial<Parameters<typeof buildMemberAgentArgv>[0]> = {}): string[] {
  return buildMemberAgentArgv({
    composeProject: "rm_smoke_judge",
    containerName: "rm_smoke_judge-member-agent-eval-judge-abc12345",
    entrypoint: "bun",
    command: [JUDGE_RUNNER_ENTRY],
    mounts: [
      { source: "/tmp/rm-agent-launcher/judge-abc12345/judge-runner.js", target: JUDGE_RUNNER_ENTRY, readonly: true },
      { source: "/tmp/rm-agent-launcher/judge-abc12345/judge-prompt.txt", target: JUDGE_PROMPT_ENTRY, readonly: true },
    ],
    extraEnv: { RM_JUDGE_MODEL: "deepseek-v4-flash", RM_JUDGE_PROMPT_FILE: JUDGE_PROMPT_ENTRY },
    modelConfig: { model: "deepseek-v4-flash", apiKeyEnv: "OPENCODE_API_KEY", apiKey: "sk-zen" },
    ...overrides,
  });
}

describe("the judge rides the member rail, and is not a special case on it", () => {
  test("one short-lived container per call, started by `docker compose run --rm`", () => {
    const argv = judgeArgv();
    expect(argv.slice(0, 2)).toEqual(["docker", "compose"]);
    expect(argv).toContain("run");
    // `--rm` is the FIRST of the two cleanup mechanisms (runMemberAgent()'s
    // finally-bracketed `docker rm -f` is the second). Losing it would leave a
    // stopped container per judging on a box that judges daily.
    expect(argv).toContain("--rm");
    expect(argv).toContain("--no-deps");
    expect(argv).toContain("member-agent");
  });

  test("the entrypoint is bun and the argv is the shim — the opencode CLI never runs", () => {
    const argv = judgeArgv();
    const i = argv.indexOf("--entrypoint");
    expect(i).toBeGreaterThan(-1);
    expect(argv[i + 1]).toBe("bun");
    expect(argv[argv.length - 1]).toBe(JUDGE_RUNNER_ENTRY);
    // The image's own ENTRYPOINT is `opencode`; overriding it is the ONLY thing
    // that keeps a judging from being a full agent session with tools, a
    // filesystem and a turn loop it has no use for (an acceptance criterion).
    expect(argv).not.toContain("opencode");
    expect(argv.join(" ")).not.toContain("opencode run");
  });

  test("no persistent identity volume, and no repository, is ever mounted", () => {
    const mounts = judgeArgv().flatMap((a, i, all) => (all[i - 1] === "-v" ? [a] : []));
    expect(mounts).toHaveLength(2);
    for (const m of mounts) {
      // Two read-only FILES. A judge holds no key, signs nothing and must
      // remember nothing between calls, so the member rail's durable
      // `/home/agent` volume is exactly what it must not be given — and a
      // writable mount would be durable state by another name.
      expect(m.endsWith(":ro")).toBe(true);
      expect(m).not.toContain("member_home");
      expect(m).not.toContain("/home/agent");
    }
    expect(mounts.some((m) => m.endsWith(`${JUDGE_RUNNER_ENTRY}:ro`))).toBe(true);
    expect(mounts.some((m) => m.endsWith(`${JUDGE_PROMPT_ENTRY}:ro`))).toBe(true);
  });

  test("exactly one credential `-e`, and the prompt is NOT one of them", () => {
    const envPairs = judgeArgv().flatMap((a, i, all) => (all[i - 1] === "-e" ? [a] : []));
    expect(envPairs.filter((p) => p.startsWith("OPENCODE_API_KEY="))).toEqual(["OPENCODE_API_KEY=sk-zen"]);
    // The prompt carries every take body in the session and routinely exceeds
    // Linux's 128 KiB per-entry argv/env cap, so it travels as a mounted FILE.
    // An env-var prompt would work in development and truncate in production.
    expect(envPairs.some((p) => p.startsWith("RM_JUDGE_PROMPT_FILE="))).toBe(true);
    for (const p of envPairs) expect(p.length).toBeLessThan(4096);
  });

  test("a judge model with no credential is refused, never launched unauthenticated", () => {
    expect(() => judgeArgv({ modelConfig: { model: "deepseek-v4-flash", apiKeyEnv: "OPENCODE_API_KEY", apiKey: null } }))
      .toThrow(/carries no value/);
  });
});

describe("the container's ceiling sits BELOW the caller's deadline", () => {
  test("the margin is subtracted, so the launcher always answers first", () => {
    // Without this, a hung container and judge()'s own abort race, and a hang
    // is reported as `model_timeout` — a verdict about a model that was never
    // reached — roughly half the time.
    expect(judgeContainerTimeoutMs(300_000)).toBe(300_000 - LAUNCHER_RESPONSE_MARGIN_MS);
    expect(judgeContainerTimeoutMs(300_000)).toBeLessThan(300_000);
  });

  test("a small or nonsensical budget floors rather than going non-positive", () => {
    for (const requested of [1, 1_000, LAUNCHER_RESPONSE_MARGIN_MS]) {
      expect(judgeContainerTimeoutMs(requested)).toBe(MIN_JUDGE_CONTAINER_TIMEOUT_MS);
    }
    expect(judgeContainerTimeoutMs(0)).toBe(MIN_JUDGE_CONTAINER_TIMEOUT_MS);
    expect(judgeContainerTimeoutMs(-5)).toBe(MIN_JUDGE_CONTAINER_TIMEOUT_MS);
    expect(judgeContainerTimeoutMs(Number.NaN)).toBe(MIN_JUDGE_CONTAINER_TIMEOUT_MS);
  });
});

describe("the container writes ONE line, and it is never an opinion", () => {
  test("a round trip survives noise on either side of the answer", () => {
    const line: JudgeRunnerLine = { ok: true, text: "prose\nwith newlines", providerUsage: { usage: { total_tokens: 3 } } };
    const stdout = `bun: some warning\n${encodeRunnerLine(line)}\ntrailing noise\n`;
    expect(parseRunnerLine(stdout)).toEqual(line);
  });

  test("a torn line is not an answer, and the LAST whole line wins", () => {
    expect(parseRunnerLine(`${JUDGE_RUNNER_TAG} {"ok":tru`)).toBeNull();
    expect(parseRunnerLine("nothing tagged here")).toBeNull();
    const first = encodeRunnerLine({ ok: false, kind: "launcher", detail: "early" });
    const last = encodeRunnerLine({ ok: true, text: "final" });
    expect(parseRunnerLine(`${first}\n${last}`)).toEqual({ ok: true, text: "final" });
  });

  test("the line carries TEXT and the provider's unparsed usage — never a verdict", () => {
    const encoded = encodeRunnerLine({ ok: true, text: "the judge's prose", providerUsage: { usage: {}, cost: "0.1" } });
    // parseJudgeResponse(), findWeightLikeKey() and the D-A7 taxonomy all stay
    // host-side. A container that could grade its own answer could manufacture
    // one, so the wire shape must have nowhere to put a grade.
    for (const forbidden of ["rationale", "release_safety", "disagreements", "weights", "source"]) {
      expect(encoded).not.toContain(forbidden);
    }
  });
});

describe("the shim classifies the vendor apart from itself", () => {
  const savedFetch = globalThis.fetch;
  function stub(fn: () => Response | Promise<Response>) { globalThis.fetch = (async () => fn()) as any; }
  function restore() { globalThis.fetch = savedFetch; }

  test("a non-2xx is relayed as model_status with the bounded body", async () => {
    stub(() => new Response('{"error":{"message":"Insufficient balance"}}', { status: 402 }));
    try {
      const line = await runJudgeCompletion({ baseUrl: "http://stub/v1", model: "m", apiKey: "k", prompt: "p" });
      expect(line).toMatchObject({ ok: false, kind: "model_status", status: 402 });
      expect((line as any).body).toContain("Insufficient balance");
    } finally { restore(); }
  });

  test("an unreachable endpoint or an unusable body is the RAIL, not a model verdict", async () => {
    globalThis.fetch = (async () => { throw new Error("getaddrinfo ENOTFOUND opencode.ai"); }) as any;
    try {
      expect(await runJudgeCompletion({ baseUrl: "http://stub/v1", model: "m", apiKey: "k", prompt: "p" }))
        .toMatchObject({ ok: false, kind: "launcher" });
    } finally { restore(); }
    stub(() => new Response("{}", { status: 200 }));
    try {
      // A 200 with no assistant text is the endpoint misbehaving in a way the
      // status never revealed. Reporting it as `model_status` would invent a
      // status the vendor never sent.
      expect(await runJudgeCompletion({ baseUrl: "http://stub/v1", model: "m", apiKey: "k", prompt: "p" }))
        .toMatchObject({ ok: false, kind: "launcher", detail: "model answer carried no assistant text" });
    } finally { restore(); }
  });

  test("a container built without its injections says so instead of calling anything", async () => {
    let called = false;
    globalThis.fetch = (async () => { called = true; return new Response("{}"); }) as any;
    try {
      for (const env of [
        {},
        { RM_JUDGE_MODEL: "m" },
        { RM_JUDGE_MODEL: "m", OPENCODE_API_KEY: "k" },
      ]) {
        expect(await runnerMain(env)).toMatchObject({ ok: false, kind: "launcher" });
      }
      expect(called, "a misbuilt run must never reach the vendor").toBe(false);
    } finally { restore(); }
  });
});

describe("what the launcher will and will not act on", () => {
  test("the launch request needs a model, a prompt and a positive budget", () => {
    expect(parseLaunchRequest({ model: "m", prompt: "p", timeoutMs: 1000 }))
      .toEqual({ model: "m", prompt: "p", timeoutMs: 1000 });
    for (const bad of [
      null, {}, { model: "m" }, { model: "", prompt: "p", timeoutMs: 1 },
      { model: "m", prompt: "   ", timeoutMs: 1 }, { model: "m", prompt: "p", timeoutMs: 0 },
      { model: "m", prompt: "p", timeoutMs: "60s" },
    ]) {
      expect(parseLaunchRequest(bad)).toHaveProperty("error");
    }
  });

  test("the surface takes no image, command, entrypoint, mount or volume", () => {
    // The narrowness IS the security property: this service is the only thing
    // in the stack with the Docker socket, so a caller that could choose WHAT
    // runs would have root on the host over an unauthenticated internal route.
    const accepted = parseLaunchRequest({
      model: "m", prompt: "p", timeoutMs: 1000,
      image: "evil", command: ["sh"], entrypoint: "sh", mounts: ["/:/host"], volumes: ["/:/host"], privileged: true,
    });
    expect(Object.keys(accepted).sort()).toEqual(["model", "prompt", "timeoutMs"]);
  });
});

describe("a launcher that cannot launch serves, and says why", () => {
  // Exiting at start-up was the first shape of this and it is wrong: `restart:
  // unless-stopped` plus an immediate exit is a crash loop, and `up --wait`
  // then fails the WHOLE stack over a judge credential. A stack that will not
  // boot because one optional actor has no key is a far worse failure than a
  // judge that fails closed — and nothing is hidden, because the reason travels
  // in the answer and in the health body.
  const detail = "agent-launcher cannot launch: judgeRailFromEnv: OPENCODE_API_KEY is required";
  const fetchIt = createUnavailableLauncherFetch(detail);

  test("health is served (so compose can wait on it) but reports launchable: false", async () => {
    const res = await fetchIt(new Request(`http://launcher${JUDGE_LAUNCHER_HEALTH_PATH}`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", launchable: false, reason: detail });
  });

  test("every launch is refused as the RAIL, naming exactly what is missing", async () => {
    const res = await fetchIt(new Request(`http://launcher${JUDGE_LAUNCH_PATH}`, {
      method: "POST", body: JSON.stringify({ model: "m", prompt: "p", timeoutMs: 1000 }),
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, kind: "launcher", detail });
  });
});

describe("readAnswer: a dead container never wears the model's verdict", () => {
  const base = { stdout: "", exitCode: 0, timedOut: false, containerLaunched: true as boolean | null };

  test("never launched, hung, or silent — all three are the RAIL", () => {
    expect(readAnswer({ ...base, containerLaunched: false }, 5_000))
      .toEqual({ ok: false, kind: "launcher", detail: "judge container never launched" });
    expect(readAnswer({ ...base, timedOut: true }, 5_000))
      .toMatchObject({ ok: false, kind: "launcher", detail: "judge container exceeded its 5000ms ceiling" });
    expect(readAnswer({ ...base, exitCode: 137 }, 5_000))
      .toMatchObject({ ok: false, kind: "launcher", detail: "judge container produced no answer line (exit 137)" });
  });

  test("a partial line flushed by a container that then timed out is NOT the answer", () => {
    // Checked before the stdout scan on purpose: a container killed at its
    // ceiling can still have flushed a whole line, and returning that would let
    // a rail fault be recorded as a model's opinion.
    const stdout = encodeRunnerLine({ ok: true, text: "half an answer" });
    expect(readAnswer({ ...base, stdout, timedOut: true }, 5_000)).toMatchObject({ ok: false, kind: "launcher" });
    expect(readAnswer({ ...base, stdout }, 5_000)).toEqual({ ok: true, text: "half an answer" });
  });
});

describe("the rail refuses to start misconfigured rather than failing every call", () => {
  test("no compose project and no credential are both start-up errors", () => {
    expect(() => judgeRailFromEnv({ OPENCODE_API_KEY: "k" })).toThrow(/SMOKE_PROJECT/);
    // The launcher holds the credential; a launcher without one could never
    // inject it into a container, and answering `launcher` to every request for
    // the life of the deployment would look like an intermittent fault rather
    // than the misconfiguration it is.
    expect(() => judgeRailFromEnv({ SMOKE_PROJECT: "p" })).toThrow(/OPENCODE_API_KEY/);
  });

  test("a well-formed environment yields the stack's own project and spool", () => {
    const rail = judgeRailFromEnv({ SMOKE_PROJECT: "rm_smoke_x", OPENCODE_API_KEY: "sk-x", COMPOSE_FILE: "a.yml:b.yml" });
    expect(rail.composeProject).toBe("rm_smoke_x");
    expect(rail.composeFiles).toEqual(["a.yml", "b.yml"]);
    expect(rail.apiKey).toBe("sk-x");
    expect(rail.spoolDir).toBe(launcherSpoolDir({}));
  });
});
