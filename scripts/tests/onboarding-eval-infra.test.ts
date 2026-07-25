// Fast(er), inference-OFF companion check for the real-inference onboarding
// eval harness (scripts/lib/onboarding-eval.ts, docs/architecture.md §11 R8,
// Stage 5 of docs/plans/onboarding-ic-workflow.md). This is a rails check, NOT
// a substitute for the real-inference eval: it proves every piece the eval
// rides on works — the member-agent image builds and starts, it can reach the
// committee REST API over the compose network, and a signed apply built with
// the real `rmpc` release binary (driven DIRECTLY by this test, never by an
// agent) lands end-to-end through POST /api/committee/apply — all without
// spending a single model token. (D21: the MCP transport is retired; the agent
// and this rails check use the REST API.) Wiring this as an early fail-fast
// step ahead of the real-inference eval in CI is Stage 7's job
// (.github/workflows/e2e.yml), not this file's.
//
// The bring-up is the SHARED scripts/stack module on its `core` profile
// (postgres + api — docs/architecture.md §11.3 E5, docs/decisions.md D22):
// this file used to carry a forked `bringUpInfra()` because demo-main.ts does
// its setup at module scope and could not be imported. That fork is gone.
//
// Loud-skip-never (test-coverage-policy): Docker, network egress to GitHub
// Releases (the `rmpc` binary, same as scripts/tests/rmpc-canonical-apply.test.ts),
// and network egress to pull/build base images are all hard dependencies of
// the describe block below — same policy as
// scripts/tests/demo-compose-config.test.ts. A missing or unusable Docker
// daemon THROWS out of `stack.up()`'s `assertDockerAvailable()` (which returns
// void or throws — there is no boolean a caller could turn into a skip), which
// fails every test in the block loudly; nothing here quietly skips.
//
// This file also carries fast, Docker-free unit tests for
// scripts/lib/onboarding-eval.ts's pure helpers (identity/prompt building,
// the keyless invariant (§11.3 E1): a constant model, no configuration surface
// that could select another one, and no key in the container argv — plus
// step-state derivation) so those stay covered even in an environment where
// the Docker-backed block can't run.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  canonicalizeApplication,
  path as routePath,
  ROUTES,
} from "@robotmoney/contract";
import { fetchRmpc, runRmpcJson } from "../lib/rmpc-fetch.ts";
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
  ONBOARDING_STEPS,
  type OnboardingEvalResult,
  retryIdentity,
  runOnboardingEvalWithRetry,
} from "../lib/onboarding-eval.ts";
import * as evalMod from "../lib/onboarding-eval.ts";
import {
  allocatePorts,
  createStack,
  DEFAULT_STACK_DATABASE,
  generateStackCredentials,
  type Stack,
} from "../stack/index.ts";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const repoRoot = join(import.meta.dir, "..", "..");

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
    expect(cfg.permission).toEqual({ "*": "deny", bash: "allow" });
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
  // false-positive guards) in scripts/tests/member-agent-classify.test.ts;
  // these three cases test only what THIS wrapper does with its verdict.
  const refusalTranscript =
    `--- stdout ---\n${readFileSync(join(import.meta.dir, "fixtures", "member-agent-refusal.ndjson"), "utf8")}\n--- stderr ---\n`;

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
      // scripts/rmpc-release-e2e.ts / scripts/tests/rmpc-canonical-apply.test.ts.
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
