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
// Loud-skip-never (test-coverage-policy): Docker, network egress to GitHub
// Releases (the `rmpc` binary, same as scripts/tests/rmpc-canonical-apply.test.ts),
// and network egress to pull/build base images are all hard dependencies of
// the describe block below — same policy as
// scripts/tests/demo-compose-config.test.ts. A missing docker CLI throws in
// beforeAll, which fails every test in the block loudly; nothing here quietly
// skips.
//
// This file also carries fast, Docker-free unit tests for
// scripts/lib/onboarding-eval.ts's pure helpers (identity/prompt building,
// the model-config fail-loud contract, step-state derivation) so those stay
// covered even in an environment where the Docker-backed block can't run.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
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
  DEFAULT_INFERENCE_MODEL,
  deriveSteps,
  fillPromptIdentity,
  generateIdentity,
  looksRateLimited,
  ONBOARDING_STEPS,
  type OnboardingEvalResult,
  resolveModelConfig,
  runOnboardingEvalWithRetry,
} from "../lib/onboarding-eval.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const repoRoot = join(import.meta.dir, "..", "..");

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

  test("resolveModelConfig defaults to the free keyless tier when OPENCODE_MODEL is unset — genuinely real inference, no secret needed", () => {
    const cfg = resolveModelConfig({});
    expect(cfg.model).toBe(DEFAULT_INFERENCE_MODEL);
    expect(cfg.apiKeyEnv).toBeNull();
    expect(cfg.apiKey).toBeNull();
  });

  test("resolveModelConfig ignores an incidentally-present key when using the keyless default", () => {
    // A key being SET for some unrelated reason must never get pulled into a
    // keyless run — the default model genuinely needs (and gets) no key.
    const cfg = resolveModelConfig({ ANTHROPIC_API_KEY: "unrelated-secret" });
    expect(cfg.model).toBe(DEFAULT_INFERENCE_MODEL);
    expect(cfg.apiKeyEnv).toBeNull();
  });

  test("resolveModelConfig throws loudly (never silently substitutes a different model) when an explicit non-default OPENCODE_MODEL has no matching key", () => {
    expect(() => resolveModelConfig({ OPENCODE_MODEL: "anthropic/claude-x" })).toThrow(/model API key|provider key/);
  });

  test("resolveModelConfig resolves an explicitly-requested paid model + whichever provider key is present", () => {
    const cfg = resolveModelConfig({ OPENCODE_MODEL: "anthropic/claude-x", ANTHROPIC_API_KEY: "secret" });
    expect(cfg).toEqual({ model: "anthropic/claude-x", apiKeyEnv: "ANTHROPIC_API_KEY", apiKey: "secret" });
  });

  test("buildAgentOpencodeConfig carries NO onboarding-specific knowledge and no Robot Money connectivity (D21 — REST via bash, no MCP client)", () => {
    const cfg = buildAgentOpencodeConfig("anthropic/claude-x") as any;
    expect(cfg.model).toBe("anthropic/claude-x");
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
      env: {},
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
      env: {},
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
      env: {},
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
      env: {},
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
      env: {},
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

  test("a bare timeout (no rate-limit signal) IS retried on the keyless default — the free tier is documented as slow/variable", async () => {
    let calls = 0;
    const result = await runOnboardingEvalWithRetry({
      repoRoot: "/tmp",
      composeProject: "p",
      backendUrl: "http://x",
      adminToken: "t",
      env: {}, // no OPENCODE_MODEL → resolves to the keyless default
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

  test("a bare timeout is NOT retried when an explicit paid model is configured — that stays a real result", async () => {
    let calls = 0;
    const result = await runOnboardingEvalWithRetry({
      repoRoot: "/tmp",
      composeProject: "p",
      backendUrl: "http://x",
      adminToken: "t",
      env: { OPENCODE_MODEL: "anthropic/claude-x", ANTHROPIC_API_KEY: "secret" },
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

// ── Docker-backed rails check ────────────────────────────────────────────────
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

const project = `rm_onboarding_infra_${crypto.randomUUID().slice(0, 8)}`;
const composeFiles = ["docker-compose.yml", "docker-compose.demo.yml"];
const adminToken = crypto.randomUUID();
let apiPort = 0;
let pgPort = 0;
let backendUrl = "";
let composeEnv: Record<string, string> = {};

function compose(args: string[]) {
  const r = Bun.spawnSync(["docker", "compose", "-p", project, ...composeFiles.flatMap((f) => ["-f", f]), ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...composeEnv } as Record<string, string>,
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: r.exitCode ?? -1, stdout: new TextDecoder().decode(r.stdout), stderr: new TextDecoder().decode(r.stderr) };
}

async function waitForOk(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
      lastErr = new Error(`${url} -> ${r.status}`);
    } catch (e) {
      lastErr = e;
    }
    await Bun.sleep(500);
  }
  throw new Error(`timed out waiting for ${url}: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
}

const SETUP_TIMEOUT_MS = 5 * 60_000;
const TEST_TIMEOUT_MS = 2 * 60_000;

// beforeAll/afterAll are declared INSIDE the describe block below (not at
// module scope) — bun:test applies module-scope lifecycle hooks to every
// describe block in the file, which would otherwise force the pure,
// Docker-free unit tests above through this full Docker bring-up too.
async function bringUpInfra(): Promise<void> {
  const dockerCheck = Bun.spawnSync(["docker", "version"], { stdout: "ignore", stderr: "pipe" });
  if (dockerCheck.exitCode !== 0) {
    throw new Error(
      `docker is required for the onboarding-eval infra rails check and is not usable in this environment ` +
        `(exit ${dockerCheck.exitCode}: ${new TextDecoder().decode(dockerCheck.stderr)})`,
    );
  }

  apiPort = await freePort();
  pgPort = await freePort();
  backendUrl = `http://127.0.0.1:${apiPort}`;
  composeEnv = {
    COMPOSE_PROJECT_NAME: project,
    DEMO_PROJECT: project,
    DATABASE_URL: "postgres://robotmoney:robotmoney@postgres:5432/robotmoney",
    ADMIN_TOKEN: adminToken,
    WEB_PORT: String(apiPort),
    POSTGRES_PORT: String(pgPort),
  };

  // Minimal stack: postgres (api's dependency) + api. No worker lanes —
  // applying/activating a committee membership is pure Postgres CRUD + crypto
  // verification, never touches the job queue, so booting the worker images
  // would only slow this "fast, cheap" check down for nothing. (D21: no mcp
  // service — the committee surface is the api's REST API.)
  const up = compose(["up", "-d", "postgres", "api"]);
  if (up.exitCode !== 0) throw new Error(`docker compose up failed (exit ${up.exitCode}): ${up.stderr}`);

  const migrate = compose(["run", "--rm", "--no-deps", "api", "bun", "run", "src/db/migrate.ts"]);
  if (migrate.exitCode !== 0) throw new Error(`migrations failed (exit ${migrate.exitCode}): ${migrate.stderr}\n${migrate.stdout}`);

  await waitForOk(`${backendUrl}${ROUTES.health}`, 60_000);
  await waitForOk(`${backendUrl}${ROUTES.committee.members}`, 30_000);

  // Build (never run yet — that's the inference-off "container starts" test
  // below) the member-agent image now so its cost is paid once in beforeAll,
  // not inside a single test's own timeout budget.
  const build = compose(["build", "member-agent"]);
  if (build.exitCode !== 0) throw new Error(`member-agent image build failed (exit ${build.exitCode}): ${build.stderr}`);
}

describe("onboarding eval infra rails (Docker, no inference)", () => {
  beforeAll(bringUpInfra, SETUP_TIMEOUT_MS);

  afterAll(() => {
    if (!project) return;
    const r = compose(["down", "--volumes", "--remove-orphans"]);
    if (r.exitCode !== 0) {
      // Never mask an earlier test failure by throwing here — but a failed
      // teardown leaves real docker resources behind, so it must be LOUD.
      console.error(`[onboarding-eval-infra] teardown for project ${project} failed (exit ${r.exitCode}): ${r.stderr}`);
    }
  }, SETUP_TIMEOUT_MS);

  test(
    "member-agent container starts — no Robot Money tooling, no model call needed",
    () => {
      // ENTRYPOINT is `opencode`; `--version` never touches a model or needs a
      // key, proving the image builds and the binary runs without spending any
      // inference budget.
      const r = compose(["run", "--rm", "--no-deps", "member-agent", "--version"]);
      expect(r.exitCode).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "member-agent reaches the api service's /health from INSIDE the compose network",
    () => {
      const r = compose(["run", "--rm", "--no-deps", "--entrypoint", "curl", "member-agent", "-fsS", "http://api:8787/health"]);
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

        const applyRes = await fetch(`${backendUrl}${ROUTES.committee.apply}`, {
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
        const statusRes = await fetch(`${backendUrl}${statusPath}`);
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
