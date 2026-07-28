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
import { DEFAULT_COMPOSE_FILES } from "../../lib/onboarding-eval.ts";
import {
  allocatePorts,
  createStack,
  DEFAULT_STACK_DATABASE,
  generateStackCredentials,
  type Stack,
} from "../../stack/index.ts";
import { makeDockerRunner, purgeDemoEvalContainers } from "../../lib/demo-volumes.ts";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const repoRoot = join(import.meta.dir, "..", "..", "..");

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

