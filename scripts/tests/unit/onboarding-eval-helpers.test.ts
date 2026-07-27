// PURE, Docker-free unit tests for the onboarding-eval harness's helpers
// (scripts/lib/onboarding-eval.ts, scripts/agent/member-agent.ts) — identity
// and prompt building, the keyless invariant (§11.3 E1: a constant model, no
// configuration surface that could select another one, no key in the container
// argv), step-state derivation, the GOLDEN member-agent argv, and
// runOnboardingEvalWithRetry's retry DECISION via its injectable `runOnce`
// seam.
//
// Cost class `unit` (docs/architecture.md §3 L1, docs/decisions.md D23): needs
// nothing but bun and the checkout — no Docker, no network — so it runs in
// `bun run test:unit` on every PR. The Docker-backed rails half of this suite
// lives in its cost-class sibling,
// scripts/tests/integration/onboarding-eval-infra.test.ts; the two were one
// file until D23's split, and the seam is exactly where that file already drew
// it (its lifecycle hooks were declared INSIDE the Docker describe precisely so
// these tests never paid the bring-up).
//
// The injectable `runOnce` seam exercised here is legitimate BECAUSE nothing in
// this file claims to be an eval: it is an inference-OFF rails check. §11.3 E2
// forbids such a seam on an eval's own path, which is under evals/ — and that
// is enforced separately by scripts/checks/check-eval-keyless.sh.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  buildAgentOpencodeConfig,
  buildAgentPrompt,
  buildMemberAgentArgv,
  DEFAULT_COMPOSE_FILES,
  deriveSteps,
  EVAL_MODEL,
  fillPromptIdentity,
  generateIdentity,
  looksRateLimited,
  memberAgentContainerName,
  memberAgentSpawnEnv,
  ONBOARDING_STEPS,
  type OnboardingEvalResult,
  retryIdentity,
  runOnboardingEvalWithRetry,
} from "../../lib/onboarding-eval.ts";
import * as evalMod from "../../lib/onboarding-eval.ts";
import { readFileSync } from "node:fs";

const repoRoot = join(import.meta.dir, "..", "..", "..");

// Temporarily set (and always restore) ambient env vars. Used ONLY by the
// keyless-invariant tests, to prove that a paid model / provider key sitting in
// the environment cannot influence the eval path at all — the whole point of
// §11.3 E1 is that nothing on that path reads the environment.
function withEnv<T>(vars: Record<string, string>, fn: () => T): T {
  const saved = setEnv(vars);
  try {
    return fn();
  } finally {
    restoreEnv(saved);
  }
}

// Async twin: the vars must stay set for the WHOLE awaited call, not just until
// the promise is constructed.
async function withEnvAsync<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved = setEnv(vars);
  try {
    return await fn();
  } finally {
    restoreEnv(saved);
  }
}

function setEnv(vars: Record<string, string>): Map<string, string | undefined> {
  const saved = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(vars)) {
    saved.set(k, process.env[k]);
    process.env[k] = v;
  }
  return saved;
}

function restoreEnv(saved: Map<string, string | undefined>): void {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

// ── Pure helper unit tests (no Docker) ──────────────────────────────────────
describe("onboarding-eval pure helpers", () => {
  test("generateIdentity produces a fresh, matching name/contact pair each call", () => {
    const a = generateIdentity();
    const b = generateIdentity();
    expect(a.runId).not.toBe(b.runId);
    expect(a.contact).toContain(a.runId);
    expect(a.name).toContain(a.runId);
  });

  test("fillPromptIdentity substitutes both placeholders and nothing else", () => {
    const identity = { runId: "abc123", name: "Test Applicant", contact: "test@example.test" };
    expect(fillPromptIdentity("I am <display name>, contact <email>.", identity)).toBe(
      "I am Test Applicant, contact test@example.test.",
    );
  });

  test("fillPromptIdentity throws loudly if the canonical prompt's placeholders ever disappear", () => {
    expect(() => fillPromptIdentity("no placeholders here", generateIdentity())).toThrow(/placeholders/);
  });

  test("buildAgentPrompt injects identity into the UNMODIFIED canonical prompt plus a clearly separate note", () => {
    const identity = generateIdentity("fixed-run");
    const prompt = buildAgentPrompt(identity);
    expect(prompt).toContain(identity.name);
    expect(prompt).toContain(identity.contact);
    expect(prompt).toContain("committee-onboarding"); // canonical prompt content survives untouched
    expect(prompt).toContain("Demo harness note"); // clearly delimited, not blended into the canonical text
  });

  // ── The keyless invariant (D22 rule 1 / §11.3 E1) ─────────────────────────
  // These three tests REPLACE (and invert) the four that used to assert
  // resolveModelConfig resolved an operator's paid-model opt-in and threw on an
  // incomplete one. The contract is no longer "mis-selecting a paid model
  // fails loudly" — it is "a paid model cannot be selected at all".
  test("the eval model is an in-code constant — no env can select a different one (D22 r1 / §11.3 E1)", () => {
    expect(EVAL_MODEL).toBe("opencode/big-pickle");
    // The configuration surface is GONE, not merely guarded: there is no
    // resolver to call and no key-name list to consult.
    expect("resolveModelConfig" in evalMod).toBe(false);
    expect("MODEL_API_KEY_ENV_CANDIDATES" in evalMod).toBe(false);
    withEnv({ ANTHROPIC_API_KEY: "secret", OPENAI_API_KEY: "secret", OPENCODE_MODEL: "anthropic/claude-x" }, () => {
      // Even with a key AND an explicit model request in the ambient
      // environment, the config written into the container is the constant.
      expect((buildAgentOpencodeConfig() as any).model).toBe(EVAL_MODEL);
    });
  });

  test("the member-agent argv carries no provider key and no model override, whatever the ambient environment says", () => {
    const argv = withEnv({ OPENCODE_MODEL: "anthropic/claude-x", ANTHROPIC_API_KEY: "secret" }, () =>
      buildMemberAgentArgv({
        composeProject: "rmdemo_abc",
        containerName: "rmdemo_abc-member-agent-eval-run1",
        opencodeConfigPath: "/tmp/wd/opencode.json",
        title: "onboarding-eval-run1",
        prompt: "PROMPT TEXT",
      }),
    );
    expect(argv).not.toContain("-e");
    const joined = argv.join(" ");
    expect(joined).not.toContain("ANTHROPIC_API_KEY");
    expect(joined).not.toContain("secret");
    expect(joined).not.toContain("claude");
    const i = argv.indexOf("--model");
    expect(i).toBeGreaterThan(-1);
    expect(argv[i + 1]).toBe(EVAL_MODEL);
  });

  test("buildAgentOpencodeConfig carries NO onboarding-specific knowledge and no Robot Money connectivity (D21 — REST via bash, no MCP client)", () => {
    const cfg = buildAgentOpencodeConfig() as any;
    expect(cfg.model).toBe(EVAL_MODEL);
    expect(cfg.permission).toEqual({ "*": "deny", bash: "allow", external_directory: "allow" });
    expect(cfg.mcp).toBeUndefined();
    expect(JSON.stringify(cfg)).not.toMatch(/rmpc|apply|committee|robotmoney/i);
  });

  // REGRESSION PIN for the 2026-07-27 layer-4 sweep. opencode's own defaults
  // set `external_directory: { "*": "ask", … }`, and the
  // `--dangerously-skip-permissions` the harness already passes does NOT lift
  // it — that run passed the flag and was rejected anyway, citing that rule.
  // In a non-interactive `opencode run` an "ask" has nobody to ask,
  // so it becomes a REJECTION — and an agent that discovered the
  // committee-onboarding skill by cloning the repo into /tmp could list the
  // directory but never read one byte of SKILL.md. That is the harness
  // depressing the admission rate, not the product being hard to navigate.
  test("the container agent is not stopped from reading files outside its own working directory", () => {
    expect((buildAgentOpencodeConfig() as any).permission.external_directory).toBe("allow");
  });

  test("deriveSteps: no member observed yet ⇒ every step pending", () => {
    const steps = deriveSteps({ memberId: null, applyState: null, onActiveRoster: false });
    expect(steps.every((s) => s.status === "pending")).toBe(true);
    expect(steps.map((s) => s.step)).toEqual([...ONBOARDING_STEPS]);
  });

  test("deriveSteps: a member row exists ⇒ connect/discover/toolchain/apply done, rest pending", () => {
    const steps = deriveSteps({ memberId: "m1", applyState: "applied", onActiveRoster: false });
    const byStep = Object.fromEntries(steps.map((s) => [s.step, s.status]));
    expect(byStep).toEqual({
      connect: "done", discover: "done", toolchain: "done", apply: "done",
      approve: "pending", claim: "pending", session: "pending",
    });
  });

  test("deriveSteps: approved but not yet claimed", () => {
    const byStep = Object.fromEntries(
      deriveSteps({ memberId: "m1", applyState: "approved", onActiveRoster: false }).map((s) => [s.step, s.status]),
    );
    expect(byStep.approve).toBe("done");
    expect(byStep.claim).toBe("pending");
  });

  test("deriveSteps: on the active roster ⇒ every step done (admitted)", () => {
    const steps = deriveSteps({ memberId: "m1", applyState: "claimed", onActiveRoster: true });
    expect(steps.every((s) => s.status === "done")).toBe(true);
  });
});

// ── GOLDEN member-agent argv (no Docker) ────────────────────────────────────
// The executed proof that extracting the container mechanics into the shared
// scripts/agent/member-agent.ts primitive did NOT change the command line the
// required per-PR e2e gate spends 20 minutes riding. Any drift here is a
// behaviour change to that gate, not a refactor.
describe("member-agent container primitive", () => {
  const base = {
    composeProject: "rmdemo_abc",
    containerName: "rmdemo_abc-member-agent-eval-run1",
    opencodeConfigPath: "/tmp/wd/opencode.json",
    title: "onboarding-eval-run1",
    prompt: "PROMPT TEXT",
  };

  test("memberAgentContainerName is the exact <project>-member-agent-eval-<runId> format cleanup targets", () => {
    expect(memberAgentContainerName("rmdemo_abc", "run1")).toBe("rmdemo_abc-member-agent-eval-run1");
  });

  test("keyless: the argv is byte-for-byte what the eval has always spawned", () => {
    expect(buildMemberAgentArgv(base)).toEqual([
      "docker",
      "compose", "-p", "rmdemo_abc",
      "-f", "docker-compose.yml",
      "-f", "docker-compose.demo.yml",
      "run",
      "--rm",
      "--no-deps",
      "--name", "rmdemo_abc-member-agent-eval-run1",
      "-v", "/tmp/wd/opencode.json:/home/agent/opencode.json:ro",
      "member-agent",
      "run",
      "--model", EVAL_MODEL,
      "--format", "json",
      "--dangerously-skip-permissions",
      "--title", "onboarding-eval-run1",
      "--dir", "/home/agent",
      "PROMPT TEXT",
    ]);
  });

  // INVERTED (D22 rule 1 / §11.3 E1): this used to assert that a keyed model
  // added exactly one `-e` flag. There is no keyed model now, and no argument
  // through which one could be requested — so the assertion is that NO `-e`
  // flag can ever appear, whatever `keep` is set to.
  test("no argv shape can produce a -e flag — there is no key to inject", () => {
    for (const keep of [false, true]) {
      const argv = buildMemberAgentArgv({ ...base, keep });
      expect(argv).not.toContain("-e");
      expect(argv.join(" ")).not.toMatch(/_API_KEY/);
    }
  });

  test("keep:true omits --rm (so a stopped container survives inspection) and changes nothing else", () => {
    const normal = buildMemberAgentArgv(base);
    const kept = buildMemberAgentArgv({ ...base, keep: true });
    expect(normal.filter((a) => a !== "--rm")).toEqual(kept);
    expect(kept).not.toContain("--rm");
  });

  test("composeFiles default to the single shared DEFAULT_COMPOSE_FILES definition", () => {
    const argv = buildMemberAgentArgv(base);
    for (const f of DEFAULT_COMPOSE_FILES) expect(argv).toContain(f);
  });

  // ── The compose child's environment (2026-07-27) ──────────────────────────
  // `docker compose run` re-resolves the WHOLE project, and docker-compose.demo.yml
  // labels the pgdata volume with ${DEMO_PROJECT}. A child without it hashes a
  // different volume definition than `stack.up()` recorded, and compose then
  // asks — interactively — whether to recreate the live database. Reproduced on
  // this repo's own compose files with compose 2.40.3; with a terminal on stdin
  // the invocation never returns.
  describe("memberAgentSpawnEnv", () => {
    test("always carries DEMO_PROJECT, and it is exactly the compose project name", () => {
      expect(memberAgentSpawnEnv("rmeval_layer4_abc", {}).DEMO_PROJECT).toBe("rmeval_layer4_abc");
    });

    test("a host value can never shadow it — the compose model must match the project it runs against", () => {
      const env = memberAgentSpawnEnv("rmeval_layer4_abc", { DEMO_PROJECT: "rmdemo_someone_elses_stack" });
      expect(env.DEMO_PROJECT).toBe("rmeval_layer4_abc");
    });

    test("docker-client plumbing from the host survives (a child that cannot find the daemon runs nothing)", () => {
      const env = memberAgentSpawnEnv("p", { PATH: "/usr/bin", DOCKER_HOST: "unix:///var/run/docker.sock", GONE: undefined });
      expect(env.PATH).toBe("/usr/bin");
      expect(env.DOCKER_HOST).toBe("unix:///var/run/docker.sock");
      expect("GONE" in env).toBe(false);
    });
  });
});

// ── Retry/backoff decision logic (no Docker, no model call — Stage 7, §11 R8)
// Exercises runOnboardingEvalWithRetry's OWN control flow via its injectable
// runOnce seam. The real admission path (runOnboardingEval itself) is proven
// separately by the Docker-backed block below and by the live CI run — this
// suite is deliberately narrow: it is testing the retry DECISION, not
// re-proving the eval.
describe("runOnboardingEvalWithRetry", () => {
  function fakeResult(overrides: Partial<OnboardingEvalResult> = {}): OnboardingEvalResult {
    return {
      identity: generateIdentity("fake"),
      memberId: null,
      steps: [],
      admitted: false,
      timedOut: false,
      containerExitCode: 1,
      containerLaunched: true,
      ...overrides,
    };
  }

  test("looksRateLimited matches known provider rate-limit/overload signals", () => {
    expect(looksRateLimited("Error: 429 Too Many Requests")).toBe(true);
    expect(looksRateLimited("anthropic rate_limit_error: slow down")).toBe(true);
    expect(looksRateLimited("upstream returned 529 overloaded_error")).toBe(true);
    expect(looksRateLimited(undefined)).toBe(false);
    expect(looksRateLimited("agent could not install the committee-onboarding skill")).toBe(false);
  });

  test("admitted on the first attempt — never retries", async () => {
    let calls = 0;
    const result = await runOnboardingEvalWithRetry({
      repoRoot: "/tmp",
      composeProject: "p",
      backendUrl: "http://x",
      adminToken: "t",
      backoffMsSchedule: [0],
      runOnce: async () => {
        calls++;
        return fakeResult({ admitted: true });
      },
    });
    expect(result.admitted).toBe(true);
    expect(calls).toBe(1);
  });

  test("a real (non-rate-limited) failure is returned as-is — no retry", async () => {
    let calls = 0;
    const result = await runOnboardingEvalWithRetry({
      repoRoot: "/tmp",
      composeProject: "p",
      backendUrl: "http://x",
      adminToken: "t",
      backoffMsSchedule: [0],
      runOnce: async () => {
        calls++;
        return fakeResult({ transcript: "agent never submitted a signed application" });
      },
    });
    expect(result.admitted).toBe(false);
    expect(calls).toBe(1); // no retry — this is a real eval result
  });

  test("a rate-limited failure IS retried, and a subsequent success is returned", async () => {
    let calls = 0;
    const result = await runOnboardingEvalWithRetry({
      repoRoot: "/tmp",
      composeProject: "p",
      backendUrl: "http://x",
      adminToken: "t",
      backoffMsSchedule: [0],
      runOnce: async () => {
        calls++;
        if (calls === 1) return fakeResult({ transcript: "429 rate_limit_error from provider" });
        return fakeResult({ admitted: true });
      },
    });
    expect(result.admitted).toBe(true);
    expect(calls).toBe(2);
  });

  test("exhausts maxAttempts and returns the last (still rate-limited) failure — never retries forever", async () => {
    let calls = 0;
    const result = await runOnboardingEvalWithRetry({
      repoRoot: "/tmp",
      composeProject: "p",
      backendUrl: "http://x",
      adminToken: "t",
      maxAttempts: 3,
      backoffMsSchedule: [0, 0],
      runOnce: async () => {
        calls++;
        return fakeResult({ transcript: "529 overloaded_error" });
      },
    });
    expect(result.admitted).toBe(false);
    expect(calls).toBe(3);
  });

  test("retries use a FRESH identity each attempt (never re-apply the same contact)", async () => {
    const identities: string[] = [];
    await runOnboardingEvalWithRetry({
      repoRoot: "/tmp",
      composeProject: "p",
      backendUrl: "http://x",
      adminToken: "t",
      backoffMsSchedule: [0],
      identity: generateIdentity("first-attempt"),
      runOnce: async (opts) => {
        identities.push(opts.identity!.contact);
        return fakeResult({ transcript: "429" });
      },
    });
    expect(identities.length).toBe(2);
    expect(new Set(identities).size).toBe(2); // no reused contact across attempts
  });

  test("a bare timeout (no rate-limit signal) IS retried — the keyless free tier is documented as slow/variable", async () => {
    let calls = 0;
    const result = await runOnboardingEvalWithRetry({
      repoRoot: "/tmp",
      composeProject: "p",
      backendUrl: "http://x",
      adminToken: "t",
      backoffMsSchedule: [0],
      runOnce: async () => {
        calls++;
        if (calls === 1) return fakeResult({ timedOut: true, transcript: "" });
        return fakeResult({ admitted: true });
      },
    });
    expect(result.admitted).toBe(true);
    expect(calls).toBe(2);
  });

  // ── Refusal is retryable (the 2026-07-25 zero-admission demo run) ─────────
  // The classifier itself is unit-tested exhaustively (positives AND five
  // false-positive guards) in scripts/tests/unit/member-agent-classify.test.ts;
  // these three cases test only what THIS wrapper does with its verdict.
  const refusalTranscript =
    `--- stdout ---\n${readFileSync(join(import.meta.dir, "..", "fixtures", "member-agent-refusal.ndjson"), "utf8")}\n--- stderr ---\n`;

  test("a classified REFUSAL is retried — the agent never attempted onboarding, so it is not a real eval result", async () => {
    let calls = 0;
    const result = await runOnboardingEvalWithRetry({
      repoRoot: "/tmp",
      composeProject: "p",
      backendUrl: "http://x",
      adminToken: "t",
      backoffMsSchedule: [0],
      runOnce: async () => {
        calls++;
        // The observed shape: clean exit, no member row, no timeout.
        if (calls === 1) return fakeResult({ containerExitCode: 0, transcript: refusalTranscript });
        return fakeResult({ admitted: true });
      },
    });
    expect(result.admitted).toBe(true);
    expect(calls).toBe(2);
  });

  test("the SAME refusal text with a member row already minted is NOT retried — that is a real (navigation) result", async () => {
    let calls = 0;
    const result = await runOnboardingEvalWithRetry({
      repoRoot: "/tmp",
      composeProject: "p",
      backendUrl: "http://x",
      adminToken: "t",
      backoffMsSchedule: [0],
      runOnce: async () => {
        calls++;
        return fakeResult({ memberId: "m1", containerExitCode: 0, transcript: refusalTranscript });
      },
    });
    expect(result.admitted).toBe(false);
    expect(calls).toBe(1);
  });

  test("a retry PRESERVES the caller's display name and only derives a fresh runId/contact", async () => {
    const planned = { runId: "ada", name: "Ada Lovelace", contact: "ada@example.test" };
    const seen: Array<{ name: string; contact: string; runId: string }> = [];
    await runOnboardingEvalWithRetry({
      repoRoot: "/tmp",
      composeProject: "p",
      backendUrl: "http://x",
      adminToken: "t",
      backoffMsSchedule: [0],
      identity: planned,
      runOnce: async (o) => {
        seen.push({ ...o.identity! });
        return fakeResult({ containerExitCode: 0, transcript: refusalTranscript });
      },
    });
    expect(seen.length).toBe(2);
    // The demo announces the planned newcomer by NAME and records it in
    // e2e.MEMBERS — a retry that admitted a generated name would put a
    // different person on the committee than the one it announced.
    expect(seen.map((s) => s.name)).toEqual(["Ada Lovelace", "Ada Lovelace"]);
    expect(seen[0]).toEqual(planned);
    expect(seen[1]!.runId).toBe("ada-r2");
    expect(seen[1]!.contact).toBe("ada-r2@example.test");
    expect(new Set(seen.map((s) => s.contact)).size).toBe(2); // never re-applies a used contact
  });

  test("retryIdentity falls back to a generated identity when the caller supplied none", () => {
    const a = retryIdentity(undefined, 1);
    const b = retryIdentity(undefined, 2);
    expect(a.contact).not.toBe(b.contact);
    expect(b.runId).toContain("ci-retry-2-");
  });

  // INVERTED (D22 rule 1 / §11.3 E1): this used to assert that a bare timeout
  // was NOT retried when an explicit paid model was configured. That premise no
  // longer exists — there is no `env` option and no configurable model — so the
  // replacement proves the opposite property: ambient paid-model/key env cannot
  // change the retry semantics, because nothing on this path reads it.
  test("a bare timeout is ALWAYS retried — there is no configuration under which it isn't", async () => {
    let calls = 0;
    const result = await withEnvAsync({ OPENCODE_MODEL: "anthropic/claude-x", ANTHROPIC_API_KEY: "secret" }, () =>
      runOnboardingEvalWithRetry({
        repoRoot: "/tmp",
        composeProject: "p",
        backendUrl: "http://x",
        adminToken: "t",
        backoffMsSchedule: [0],
        runOnce: async () => {
          calls++;
          if (calls === 1) return fakeResult({ timedOut: true, transcript: "" });
          return fakeResult({ admitted: true });
        },
      }),
    );
    expect(result.admitted).toBe(true);
    expect(calls).toBe(2);
  });
});
