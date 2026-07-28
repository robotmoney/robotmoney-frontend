// Inference-OFF rails check for the real-inference onboarding eval
// (scripts/lib/onboarding-eval.ts, docs/architecture.md §11 R8, Stage 5 of
// docs/plans/onboarding-ic-workflow.md). This is a rails check, NOT a
// substitute for the eval: it proves every piece the eval rides on works — the
// member-agent image builds and starts, it can reach the committee REST API
// over the compose network, and a signed apply built with the real `rmpc`
// release binary (driven DIRECTLY by this test, never by an agent) lands
// end-to-end through POST /api/committee/apply — all without spending a single
// model token. (D21: the MCP transport is retired; the agent and this rails
// check use the REST API.) It is wired as an early fail-fast step ahead of the
// real-inference gate in .github/workflows/e2e.yml.
//
// The bring-up is the SHARED scripts/stack module on its `core` profile
// (postgres + api — docs/architecture.md §11.3 E5, docs/decisions.md D22):
// this file used to carry a forked `bringUpInfra()` because demo-main.ts does
// its setup at module scope and could not be imported. That fork is gone.
//
// Cost class `integration` (docs/architecture.md §3 L1, docs/decisions.md D23):
// a Docker daemon and network egress are hard dependencies, which is why this
// half lives here and its pure half lives in
// scripts/tests/unit/onboarding-eval-helpers.test.ts. Both halves still run on
// every PR — the split buys CI path-selectability, not less coverage.
//
// Loud-skip-never (test-coverage-policy): Docker, network egress to GitHub
// Releases (the `rmpc` binary, same as
// scripts/tests/integration/rmpc-canonical-apply.test.ts), and network egress
// to pull/build base images are all hard dependencies of the describe block
// below — same policy as
// scripts/tests/integration/demo-compose-config.test.ts. A missing or unusable
// Docker daemon THROWS out of `stack.up()`'s `assertDockerAvailable()` (which
// returns void or throws — there is no boolean a caller could turn into a
// skip), which fails every test in the block loudly; nothing here quietly
// skips.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  canonicalizeApplication,
  path as routePath,
  ROUTES,
} from "@robotmoney/contract";
import { fetchRmpc, runRmpcJson } from "../../lib/rmpc-fetch.ts";
import {
  buildAgentOpencodeConfig,
  buildAgentPrompt,
  DEFAULT_INFERENCE_MODEL,
  deriveSteps,
  fillPromptIdentity,
  generateIdentity,
  looksRateLimited,
  ONBOARDING_STEPS,
  type OnboardingEvalResult,
  resolveModelConfig,
  runOnboardingEvalWithRetry,
} from "../../lib/onboarding-eval.ts";
import { isKeylessModel, MODEL_FAMILIES, resolveAgentModel } from "../../lib/model-registry.ts";
import {
  allocatePorts,
  createStack,
  DEFAULT_COMPOSE_FILES,
  DEFAULT_STACK_DATABASE,
  generateStackCredentials,
  type Stack,
} from "../../stack/index.ts";
import { makeDockerRunner, purgeDemoEvalContainers } from "../../lib/demo-volumes.ts";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const repoRoot = join(import.meta.dir, "..", "..", "..");

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

  test("resolveModelConfig defaults to the funded registry default when AGENT_MODEL is unset", () => {
    const cfg = resolveModelConfig({ OPENCODE_API_KEY: "sk-zen" });
    expect(cfg.model).toBe(DEFAULT_INFERENCE_MODEL);
    expect(cfg.model).toBe("opencode/deepseek-v4-flash");
    expect(cfg).toEqual({ model: DEFAULT_INFERENCE_MODEL, apiKeyEnv: "OPENCODE_API_KEY", apiKey: "sk-zen", keyless: false });
  });

  test("resolveModelConfig throws loudly when a paid model is selected with no funded key — never a silent substitution", () => {
    // Caught here rather than ~20 minutes later at the far end of a stack boot.
    expect(() => resolveModelConfig({})).toThrow(/OPENCODE_API_KEY is not set/);
  });

  test("resolveModelConfig keeps a `free` selection genuinely keyless, even with a key present", () => {
    // A key set for an unrelated reason must never get pulled into a keyless run.
    const cfg = resolveModelConfig({ AGENT_MODEL: "free", OPENCODE_API_KEY: "sk-zen" });
    expect(cfg).toEqual({ model: "opencode/nemotron-3-ultra-free", apiKeyEnv: null, apiKey: null, keyless: true });
  });

  test("resolveModelConfig switches family by name and pins an exact member with family/model", () => {
    expect(resolveModelConfig({ AGENT_MODEL: "kimi", OPENCODE_API_KEY: "k" }).model).toBe("opencode/kimi-k2.7-code");
    expect(resolveModelConfig({ AGENT_MODEL: "kimi/k2.6", OPENCODE_API_KEY: "k" }).model).toBe("opencode/kimi-k2.6");
  });

  test("resolveAgentModel refuses an unknown family or member rather than falling back to the default", () => {
    // A run must use the model it was asked for; a silent fallback turns a
    // benchmark result into a lie about which agent produced it.
    expect(() => resolveAgentModel({ AGENT_MODEL: "notafamily" })).toThrow(/unknown model family/);
    expect(() => resolveAgentModel({ AGENT_MODEL: "kimi/notamodel" })).toThrow(/unknown model "notamodel"/);
    expect(() => resolveAgentModel({ AGENT_MODEL: "a/b/c" })).toThrow(/malformed/);
  });

  test("resolveAgentModel passes a fully-qualified opencode/<id> through unmapped (escape hatch)", () => {
    expect(resolveAgentModel({ AGENT_MODEL: "opencode/some-brand-new-model" })).toBe("opencode/some-brand-new-model");
  });

  test("every registry family default names a real member of that family", () => {
    // Guards the one typo that would make a whole family unusable.
    for (const [name, family] of Object.entries(MODEL_FAMILIES)) {
      expect(family.models[family.default], `${name}.default`).toBeDefined();
      expect(resolveAgentModel({ AGENT_MODEL: name })).toBe(`opencode/${family.models[family.default]}`);
    }
  });

  test("isKeylessModel is derived from the registry, and big-pickle stays reachable but is not the default", () => {
    expect(isKeylessModel("opencode/nemotron-3-ultra-free")).toBe(true);
    expect(isKeylessModel("opencode/big-pickle")).toBe(true);
    expect(isKeylessModel("opencode/deepseek-v4-flash")).toBe(false);
    // Saturated upstream with no paid tier — deliberately no longer the default.
    expect(DEFAULT_INFERENCE_MODEL).not.toBe("opencode/big-pickle");
  });

  test("buildAgentOpencodeConfig carries NO onboarding-specific knowledge and no Robot Money connectivity (D21 — REST via bash, no MCP client)", () => {
    const cfg = buildAgentOpencodeConfig("anthropic/claude-x") as any;
    expect(cfg.model).toBe("anthropic/claude-x");
    expect(cfg.permission).toEqual({ "*": "deny", bash: "allow", external_directory: "allow" });
    expect(cfg.mcp).toBeUndefined();
    expect(JSON.stringify(cfg)).not.toMatch(/rmpc|apply|committee|robotmoney/i);
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
      containerLaunched: false,
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
      env: { OPENCODE_API_KEY: "sk-zen" },
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
      env: { OPENCODE_API_KEY: "sk-zen" },
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
      env: { OPENCODE_API_KEY: "sk-zen" },
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
      env: { OPENCODE_API_KEY: "sk-zen" },
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
      env: { OPENCODE_API_KEY: "sk-zen" },
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

  test("a bare timeout (no rate-limit signal) IS retried on a KEYLESS model — the free tier is documented as slow/variable", async () => {
    let calls = 0;
    const result = await runOnboardingEvalWithRetry({
      repoRoot: "/tmp",
      composeProject: "p",
      backendUrl: "http://x",
      adminToken: "t",
      env: { AGENT_MODEL: "free" }, // keyless tier: slow, so a bare timeout says nothing
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

  test("a bare timeout is NOT retried on a FUNDED model — there, a timeout is a real result", async () => {
    let calls = 0;
    const result = await runOnboardingEvalWithRetry({
      repoRoot: "/tmp",
      composeProject: "p",
      backendUrl: "http://x",
      adminToken: "t",
      env: { OPENCODE_API_KEY: "sk-zen" }, // funded default model
      backoffMsSchedule: [0],
      runOnce: async () => {
        calls++;
        return fakeResult({ timedOut: true, transcript: "" });
      },
    });
    expect(result.admitted).toBe(false);
    expect(calls).toBe(1); // no retry — a timeout on a paid model is a real result
  });
});
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

  test("resolveModelConfig defaults to the funded registry default when AGENT_MODEL is unset", () => {
    const cfg = resolveModelConfig({ OPENCODE_API_KEY: "sk-zen" });
    expect(cfg.model).toBe(DEFAULT_INFERENCE_MODEL);
    expect(cfg.model).toBe("opencode/deepseek-v4-flash");
    expect(cfg).toEqual({ model: DEFAULT_INFERENCE_MODEL, apiKeyEnv: "OPENCODE_API_KEY", apiKey: "sk-zen", keyless: false });
  });

  test("resolveModelConfig throws loudly when a paid model is selected with no funded key — never a silent substitution", () => {
    // Caught here rather than ~20 minutes later at the far end of a stack boot.
    expect(() => resolveModelConfig({})).toThrow(/OPENCODE_API_KEY is not set/);
  });

  test("resolveModelConfig keeps a `free` selection genuinely keyless, even with a key present", () => {
    // A key set for an unrelated reason must never get pulled into a keyless run.
    const cfg = resolveModelConfig({ AGENT_MODEL: "free", OPENCODE_API_KEY: "sk-zen" });
    expect(cfg).toEqual({ model: "opencode/nemotron-3-ultra-free", apiKeyEnv: null, apiKey: null, keyless: true });
  });

  test("resolveModelConfig switches family by name and pins an exact member with family/model", () => {
    expect(resolveModelConfig({ AGENT_MODEL: "kimi", OPENCODE_API_KEY: "k" }).model).toBe("opencode/kimi-k2.7-code");
    expect(resolveModelConfig({ AGENT_MODEL: "kimi/k2.6", OPENCODE_API_KEY: "k" }).model).toBe("opencode/kimi-k2.6");
  });

  test("resolveAgentModel refuses an unknown family or member rather than falling back to the default", () => {
    // A run must use the model it was asked for; a silent fallback turns a
    // benchmark result into a lie about which agent produced it.
    expect(() => resolveAgentModel({ AGENT_MODEL: "notafamily" })).toThrow(/unknown model family/);
    expect(() => resolveAgentModel({ AGENT_MODEL: "kimi/notamodel" })).toThrow(/unknown model "notamodel"/);
    expect(() => resolveAgentModel({ AGENT_MODEL: "a/b/c" })).toThrow(/malformed/);
  });

  test("resolveAgentModel passes a fully-qualified opencode/<id> through unmapped (escape hatch)", () => {
    expect(resolveAgentModel({ AGENT_MODEL: "opencode/some-brand-new-model" })).toBe("opencode/some-brand-new-model");
  });

  test("every registry family default names a real member of that family", () => {
    // Guards the one typo that would make a whole family unusable.
    for (const [name, family] of Object.entries(MODEL_FAMILIES)) {
      expect(family.models[family.default], `${name}.default`).toBeDefined();
      expect(resolveAgentModel({ AGENT_MODEL: name })).toBe(`opencode/${family.models[family.default]}`);
    }
  });

  test("isKeylessModel is derived from the registry, and big-pickle stays reachable but is not the default", () => {
    expect(isKeylessModel("opencode/nemotron-3-ultra-free")).toBe(true);
    expect(isKeylessModel("opencode/big-pickle")).toBe(true);
    expect(isKeylessModel("opencode/deepseek-v4-flash")).toBe(false);
    // Saturated upstream with no paid tier — deliberately no longer the default.
    expect(DEFAULT_INFERENCE_MODEL).not.toBe("opencode/big-pickle");
  });

  test("buildAgentOpencodeConfig carries NO onboarding-specific knowledge and no Robot Money connectivity (D21 — REST via bash, no MCP client)", () => {
    const cfg = buildAgentOpencodeConfig("anthropic/claude-x") as any;
    expect(cfg.model).toBe("anthropic/claude-x");
    expect(cfg.permission).toEqual({ "*": "deny", bash: "allow", external_directory: "allow" });
    expect(cfg.mcp).toBeUndefined();
    expect(JSON.stringify(cfg)).not.toMatch(/rmpc|apply|committee|robotmoney/i);
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

// ── Docker-backed rails check ────────────────────────────────────────────────
const SETUP_TIMEOUT_MS = 5 * 60_000;
const TEST_TIMEOUT_MS = 2 * 60_000;

// DECLARATION ONLY at module scope — no port bound, no secret generated, no
// compose call — so the pure, Docker-free suites above still cost nothing to
// load. All of it happens in the beforeAll below.
let stack: Stack | null = null;

// A stack pointed at a daemon that cannot exist. Constructing it is free
// (createStack spawns nothing); only assertDockerAvailable() touches Docker.
function unreachableDaemonStack(): Stack {
  return createStack(
    {
      repoRoot,
      project: "rm_onboarding_infra_unreachable",
      profile: "core",
      apiPort: 1,
      pgPort: 2,
      composeFiles: DEFAULT_COMPOSE_FILES,
      database: DEFAULT_STACK_DATABASE,
      credentials: generateStackCredentials(),
    },
    { hostEnv: { PATH: process.env.PATH, DOCKER_HOST: "tcp://127.0.0.1:1" } },
  );
}

// beforeAll/afterAll are declared INSIDE the describe block below (not at
// module scope) — bun:test applies module-scope lifecycle hooks to every
// describe block in the file, which would otherwise force the pure,
// Docker-free unit tests above through this full Docker bring-up too.
describe("onboarding eval infra rails (Docker, no inference)", () => {
  beforeAll(async () => {
    const [apiPort, pgPort] = await allocatePorts([{}, {}]);
    // Minimal stack: the shared module's `core` profile — postgres (api's
    // dependency) + api, and NOTHING else. No worker lanes: applying/
    // activating a committee membership is pure Postgres CRUD + crypto
    // verification, never touches the job queue, so booting the worker images
    // would only slow this "fast, cheap" check down for nothing. (D21: no mcp
    // service — the committee surface is the api's REST API.)
    stack = createStack(
      {
        repoRoot,
        project: `rm_onboarding_infra_${crypto.randomUUID().slice(0, 8)}`,
        profile: "core",
        apiPort: apiPort!,
        pgPort: pgPort!,
        composeFiles: DEFAULT_COMPOSE_FILES,
        database: DEFAULT_STACK_DATABASE,
        credentials: generateStackCredentials(),
      },
      { hostEnv: process.env, io: { stdout: "pipe", stderr: "pipe" } },
    );
    // Throws (never skips) when Docker is missing/unusable, when postgres
    // never becomes ready, when migrations fail, or when /health never
    // answers.
    await stack.up();
    await stack.waitForHttp(`${stack.backendUrl}${ROUTES.committee.members}`, 30_000);

    // Build (never run yet — that's the inference-off "container starts" test
    // below) the member-agent image now so its cost is paid once in beforeAll,
    // not inside a single test's own timeout budget.
    await stack.build(["member-agent"]);
  }, SETUP_TIMEOUT_MS);

  afterAll(() => {
    if (!stack) return;
    try {
      purgeDemoEvalContainers(makeDockerRunner(stack.spawnEnv), { project: stack.config.project });
    } catch {}
    const r = stack.down({ removeVolumes: true, removeOrphans: true });
    if (r.exitCode !== 0) {
      // Never mask an earlier test failure by throwing here — but a failed
      // teardown leaves real docker resources behind, so it must be LOUD.
      console.error(
        `[onboarding-eval-infra] teardown for project ${stack.config.project} failed (exit ${r.exitCode}): ${r.stderr}`,
      );
    }
  }, SETUP_TIMEOUT_MS);

  test("assertDockerAvailable THROWS on an unusable daemon — it can never degrade into a skip", () => {
    expect(() => unreachableDaemonStack().assertDockerAvailable()).toThrow(/docker is required/);
  });

  test(
    "member-agent container starts — no Robot Money tooling, no model call needed",
    () => {
      // ENTRYPOINT is `opencode`; `--version` never touches a model or needs a
      // key, proving the image builds and the binary runs without spending any
      // inference budget.
      const r = stack!.compose(["run", "--rm", "--no-deps", "member-agent", "--version"]);
      expect(r.exitCode).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "member-agent reaches the api service's /health from INSIDE the compose network",
    () => {
      const r = stack!.compose(["run", "--rm", "--no-deps", "--entrypoint", "curl", "member-agent", "-fsS", "http://api:8787/health"]);
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(r.stdout)).toMatchObject({ status: "ok" });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a signed apply built with the REAL rmpc release binary lands end-to-end through POST /api/committee/apply",
    async () => {
      // Driven directly by this test — never by an agent — exactly like
      // scripts/rmpc-release-e2e.ts / scripts/tests/integration/rmpc-canonical-apply.test.ts.
      // No JS keygen fallback anywhere in this path (test-coverage policy #4).
      // (D21: over the REST API, not the retired MCP apply tool.)
      const rmpcPath = await fetchRmpc();
      const workDir = mkdtempSync(join(tmpdir(), "onboarding-eval-infra-"));
      try {
        const passphrase = crypto.randomUUID();
        const keystorePath = join(workDir, "identity.json");
        const rmpcEnv = { RMPC_COMMITTEE_IDENTITY_PASSPHRASE: passphrase };

        const created = runRmpcJson(rmpcPath, ["committee-identity", "--path", keystorePath, "create"], rmpcEnv);
        expect(created.ok).toBe(true);
        const publicKeyB64: string = created.public_key;

        const application = { name: "Infra Rails Check", contact: `infra-rails-${crypto.randomUUID().slice(0, 8)}@example.test`, publicKey: publicKeyB64 };
        const canonical = canonicalizeApplication(application);
        const payloadFile = join(workDir, "payload.txt");
        writeFileSync(payloadFile, canonical);
        const signed = runRmpcJson(rmpcPath, ["committee-identity", "--path", keystorePath, "sign", "--payload-file", payloadFile], rmpcEnv);
        expect(signed.ok).toBe(true);
        expect(signed.public_key).toBe(publicKeyB64);

        const applyRes = await fetch(`${stack!.backendUrl}${ROUTES.committee.apply}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...application, signature: signed.signature }),
        });
        expect(applyRes.status).toBe(201);
        const body = await applyRes.json();
        expect(body.ok).toBe(true);
        expect(body.memberStatus).toBe("applied");
        expect(body.memberId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
        const memberId: string = body.memberId;

        const statusPath = routePath(ROUTES.committee.applyStatus, { id: memberId });
        const statusRes = await fetch(`${stack!.backendUrl}${statusPath}`);
        expect(statusRes.status).toBe(200);
        const status = await statusRes.json();
        expect(status.state).toBe("applied");
        // Redaction: the status route never echoes contact/publicKey.
        expect(JSON.stringify(status)).not.toContain(application.contact);
        expect(JSON.stringify(status)).not.toContain(publicKeyB64);
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );
});

