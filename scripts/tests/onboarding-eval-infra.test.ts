// Fast(er), inference-OFF companion check for the real-inference onboarding
// eval harness (scripts/lib/onboarding-eval.ts, docs/architecture.md §11 R8,
// Stage 5 of docs/plans/onboarding-ic-workflow.md). This is a rails check, NOT
// a substitute for the real-inference eval: it proves every piece the eval
// rides on works — the member-agent image builds and starts, it can reach the
// Stage-2 anonymous MCP discovery surface over the compose network, and a
// signed apply built with Stage 3's real `rmpc` release binary (driven
// DIRECTLY by this test, never by an agent) lands end-to-end through the MCP
// `apply` tool — all without spending a single model token. Wiring this as an
// early fail-fast step ahead of the real-inference eval in CI is Stage 7's job
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
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  APPLY_HOW_TO_STEPS,
  canonicalizeApplication,
  COMMITTEE_ONBOARDING_SKILL_URL,
  path as routePath,
  ROUTES,
} from "@robotmoney/contract";
import { fetchRmpc, runRmpcJson } from "../lib/rmpc-fetch.ts";
import {
  buildAgentOpencodeConfig,
  buildAgentPrompt,
  deriveSteps,
  fillPromptIdentity,
  generateIdentity,
  ONBOARDING_STEPS,
  resolveModelConfig,
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
    expect(prompt).toContain("apply-how-to"); // canonical prompt content survives untouched
    expect(prompt).toContain("Demo harness note"); // clearly delimited, not blended into the canonical text
  });

  test("resolveModelConfig throws loudly (never falls back) when OPENCODE_MODEL is unset", () => {
    expect(() => resolveModelConfig({})).toThrow(/OPENCODE_MODEL/);
  });

  test("resolveModelConfig throws loudly when no known provider key is present", () => {
    expect(() => resolveModelConfig({ OPENCODE_MODEL: "anthropic/claude-x" })).toThrow(/model API key/);
  });

  test("resolveModelConfig resolves the configured model + whichever provider key is present", () => {
    const cfg = resolveModelConfig({ OPENCODE_MODEL: "anthropic/claude-x", ANTHROPIC_API_KEY: "secret" });
    expect(cfg).toEqual({ model: "anthropic/claude-x", apiKeyEnv: "ANTHROPIC_API_KEY", apiKey: "secret" });
  });

  test("buildAgentOpencodeConfig carries ONLY generic MCP connectivity — no onboarding-specific knowledge", () => {
    const cfg = buildAgentOpencodeConfig("anthropic/claude-x", "http://mcp:8788/mcp") as any;
    expect(cfg.mcp.robotmoney.url).toBe("http://mcp:8788/mcp");
    expect(JSON.stringify(cfg)).not.toMatch(/rmpc|apply|committee/i);
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
let mcpPort = 0;
let pgPort = 0;
let backendUrl = "";
let mcpUrl = "";
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
  mcpPort = await freePort();
  pgPort = await freePort();
  backendUrl = `http://127.0.0.1:${apiPort}`;
  mcpUrl = `http://127.0.0.1:${mcpPort}/mcp`;
  composeEnv = {
    COMPOSE_PROJECT_NAME: project,
    DEMO_PROJECT: project,
    DATABASE_URL: "postgres://robotmoney:robotmoney@postgres:5432/robotmoney",
    ADMIN_TOKEN: adminToken,
    WEB_PORT: String(apiPort),
    MCP_PORT: String(mcpPort),
    POSTGRES_PORT: String(pgPort),
  };

  // Minimal stack: postgres (api/mcp's dependency) + api + mcp. No worker
  // lanes — applying/activating a committee membership is pure Postgres CRUD
  // + crypto verification, never touches the job queue, so booting the worker
  // images would only slow this "fast, cheap" check down for nothing.
  const up = compose(["up", "-d", "postgres", "api", "mcp"]);
  if (up.exitCode !== 0) throw new Error(`docker compose up failed (exit ${up.exitCode}): ${up.stderr}`);

  const migrate = compose(["run", "--rm", "--no-deps", "api", "bun", "run", "src/db/migrate.ts"]);
  if (migrate.exitCode !== 0) throw new Error(`migrations failed (exit ${migrate.exitCode}): ${migrate.stderr}\n${migrate.stdout}`);

  await waitForOk(`${backendUrl}${ROUTES.health}`, 60_000);
  await waitForOk(`${backendUrl}${ROUTES.committee.members}`, 30_000);
  await waitForOk(`${mcpUrl.replace(/\/mcp$/, "")}/health`, 30_000);

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
    "member-agent reaches the mcp service's /health from INSIDE the compose network",
    () => {
      const r = compose(["run", "--rm", "--no-deps", "--entrypoint", "curl", "member-agent", "-fsS", "http://mcp:8788/health"]);
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(r.stdout)).toMatchObject({ status: "ok" });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "anonymous MCP discovery (apply-how-to) matches the Stage-0 contract constants",
    async () => {
      const client = new Client({ name: "onboarding-eval-infra-test", version: "0.1.0" });
      const transport = new StreamableHTTPClientTransport(new URL(mcpUrl));
      await client.connect(transport);
      try {
        const { tools } = await client.listTools();
        expect(tools.map((t) => t.name).sort()).toEqual(["apply", "apply-how-to"]);

        const result = await client.callTool({ name: "apply-how-to", arguments: {} });
        const body = JSON.parse((result.content as any[])[0].text);
        expect(body.steps).toEqual(APPLY_HOW_TO_STEPS);
        expect(body.routes.apply).toBe(ROUTES.committee.apply);
        expect(body.routes.applyStatus).toBe(ROUTES.committee.applyStatus);
        expect(body.skillUrl).toBe(COMMITTEE_ONBOARDING_SKILL_URL);
      } finally {
        await client.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a signed apply built with the REAL rmpc release binary lands end-to-end through the MCP apply tool",
    async () => {
      // Driven directly by this test — never by an agent — exactly like
      // scripts/rmpc-release-e2e.ts / scripts/tests/rmpc-canonical-apply.test.ts.
      // No JS keygen fallback anywhere in this path (test-coverage policy #4).
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

        const client = new Client({ name: "onboarding-eval-infra-test-apply", version: "0.1.0" });
        const transport = new StreamableHTTPClientTransport(new URL(mcpUrl));
        await client.connect(transport);
        let memberId: string;
        try {
          const result = await client.callTool({ name: "apply", arguments: { ...application, signature: signed.signature } });
          const body = JSON.parse((result.content as any[])[0].text);
          expect(body.ok).toBe(true);
          expect(body.status).toBe(201);
          expect(body.memberStatus).toBe("applied");
          expect(body.memberId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
          memberId = body.memberId;
        } finally {
          await client.close();
        }

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
