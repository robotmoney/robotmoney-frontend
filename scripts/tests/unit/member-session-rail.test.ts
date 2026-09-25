// Hermetic guards on the member-container SESSION rail (issue #361 Phase 2/3):
// the `docker compose run` argv the session-participation mode emits, the
// persistent-home volume naming, the client stdout protocol parser, and the
// standalone entry point's rail resolution. No Docker, no network, no model
// call — the live path is executed by the required e2e smoke gate (every
// present member's take is containerized there and asserted post-publish by
// assertAuthoredTakes).
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildMemberAgentArgv,
  memberHomeVolumeName,
  type MemberAgentModel,
} from "../../agent/member-agent.ts";
import {
  buildMemberSessionRuntime,
  CLIENT_ENTRY,
  memberSessionMounts,
  parseClientLine,
  railFromEnv,
} from "../../lib/swarm/agent.ts";

const FUNDED: MemberAgentModel = { model: "opencode/test-model", apiKeyEnv: "OPENCODE_API_KEY", apiKey: "sk-test" };

function sessionArgv(overrides: Record<string, unknown> = {}): string[] {
  return buildMemberAgentArgv({
    composeProject: "rm_ci_stack_x",
    containerName: "rm_ci_stack_x-member-agent-eval-athena-s1",
    modelConfig: FUNDED,
    entrypoint: "bun",
    command: [CLIENT_ENTRY, "participate"],
    mounts: memberSessionMounts(
      "/tmp/robotmoney-member-client-safe/member-session-client.js",
      "rm_ci_stack_x_member_home_athena",
    ),
    extraEnv: { RM_MEMBER_ID: "athena", AGENT_MODEL: "opencode/test-model" },
    ownerEnv: { RM_MEMBER_TOKEN: "tok_athena_secret" },
    ...overrides,
  } as any);
}

describe("buildMemberAgentArgv — session-participation mode", () => {
  test("emits --entrypoint + the client command instead of the opencode run tail", () => {
    const argv = sessionArgv();
    const entrypointAt = argv.indexOf("--entrypoint");
    expect(entrypointAt).toBeGreaterThan(-1);
    expect(argv[entrypointAt + 1]).toBe("bun");
    // Command tail follows the service name.
    const serviceAt = argv.indexOf("member-agent");
    expect(argv.slice(serviceAt + 1)).toEqual([CLIENT_ENTRY, "participate"]);
    // No opencode-mode remnants.
    expect(argv).not.toContain("--auto");
    expect(argv).not.toContain("--title");
    // The shared full-stack bring-up prebuilds this image once. Individual
    // concurrent members must never request their own implicit build.
    expect(argv).not.toContain("--build");
    expect(argv.join(" ")).not.toContain("opencode.json");
  });

  test("mounts only the sanitized client artifact read-only and the member home volume writable", () => {
    const argv = sessionArgv().join(" ");
    expect(argv).toContain(`-v /tmp/robotmoney-member-client-safe/member-session-client.js:${CLIENT_ENTRY}:ro`);
    expect(argv).toContain("-v rm_ci_stack_x_member_home_athena:/home/agent");
  });

  test("mount set excludes the repo, .agents, .env, and analytics-token host path", () => {
    const repo = "/workspace/robotmoney-frontend";
    const analyticsTokenFile = "/tmp/robotmoney-smoke-secrets/analytics-token";
    const mounts = memberSessionMounts(
      "/tmp/robotmoney-member-client-safe/member-session-client.js",
      "rm_ci_stack_x_member_home_athena",
    );
    expect(mounts).toHaveLength(2);
    expect(mounts[0]).toMatchObject({ target: CLIENT_ENTRY, readonly: true });
    expect(mounts[1]).toEqual({ source: "rm_ci_stack_x_member_home_athena", target: "/home/agent" });
    const serialized = JSON.stringify(mounts);
    for (const forbidden of [repo, `${repo}/.agents`, `${repo}/.env`, analyticsTokenFile]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  test("builds the self-contained client artifact in OS temp space and brackets cleanup", async () => {
    const repoRoot = join(import.meta.dir, "../../..");
    const runtime = await buildMemberSessionRuntime(repoRoot);
    try {
      expect(existsSync(runtime.artifactPath)).toBe(true);
      expect(runtime.artifactPath.startsWith(repoRoot)).toBe(false);
      expect(runtime.artifactPath.startsWith(tmpdir())).toBe(true);
    } finally {
      const artifact = runtime.artifactPath;
      runtime.dispose();
      expect(existsSync(artifact)).toBe(false);
    }
  });

  test("injects exactly one model credential -e plus the declared extra/owner env", () => {
    const argv = sessionArgv();
    const envPairs = argv.filter((_, i) => argv[i - 1] === "-e");
    expect(envPairs).toEqual([
      "OPENCODE_API_KEY=sk-test",
      "AGENT_MODEL=opencode/test-model",
      "RM_MEMBER_ID=athena",
      "RM_MEMBER_TOKEN=tok_athena_secret",
    ]);
  });

  test("a keyless model emits no credential -e at all", () => {
    const argv = sessionArgv({ modelConfig: { model: "opencode/free-model", apiKeyEnv: null, apiKey: null } });
    expect(argv.filter((a) => a.startsWith("OPENCODE_API_KEY="))).toEqual([]);
  });

  test("command mode without an entrypoint throws instead of launching a broken container", () => {
    expect(() => sessionArgv({ entrypoint: undefined })).toThrow(/entrypoint/);
  });

  test("opencode mode still requires its own inputs", () => {
    expect(() =>
      buildMemberAgentArgv({
        composeProject: "p",
        containerName: "c",
        modelConfig: FUNDED,
      } as any),
    ).toThrow(/opencode mode requires/);
  });
});

describe("memberHomeVolumeName", () => {
  test("derives a docker-safe, project-scoped volume name", () => {
    expect(memberHomeVolumeName("rm_ci_stack_x", "athena")).toBe("rm_ci_stack_x_member_home_athena");
    expect(memberHomeVolumeName("p", "weird id/…!")).toBe("p_member_home_weird-id---");
  });
});

describe("parseClientLine — the RM_* stdout protocol", () => {
  test("parses a tagged JSON line and ignores everything else", () => {
    expect(parseClientLine("RM_STAGE", 'RM_STAGE {"stage":"thinking"}')).toEqual({ stage: "thinking" });
    expect(parseClientLine("RM_RESULT", '  RM_RESULT {"verified":true}  ')).toEqual({ verified: true });
    expect(parseClientLine("RM_ENROLL", 'RM_ENROLL {"keystoreKind":"client","tokenValid":false}')).toEqual({
      keystoreKind: "client",
      tokenValid: false,
    });
    expect(parseClientLine("RM_STAGE", 'RM_RESULT {"stage":"thinking"}')).toBeNull();
    expect(parseClientLine("RM_STAGE", "free-form log line")).toBeNull();
    expect(parseClientLine("RM_STAGE", "RM_STAGE not-json")).toBeNull();
  });
});

describe("railFromEnv — the standalone session driver's rail resolution", () => {
  test("throws loudly when SMOKE_PROJECT is missing", () => {
    expect(() => railFromEnv({ AGENT_MODEL: "free" })).toThrow(/SMOKE_PROJECT is required/);
  });

  test("resolves project, compose files, and a defined-only spawn env", () => {
    // The operator's token reaches the rail as a FILE the env names (smoke
    // spec §3), never as an env value.
    const tokenDir = mkdtempSync(join(tmpdir(), "rm-rail-operator-"));
    const tokenFile = join(tokenDir, "token");
    writeFileSync(tokenFile, "operator-token\n", { mode: 0o600 });
    const rail = railFromEnv({
      SMOKE_PROJECT: "rm_ci_stack_y",
      COMPOSE_FILE: "docker-compose.yml:docker-compose.smoke.yml",
      AGENT_MODEL: "free",
      // The stack states its own RM_ENV now (D13) and this rail is built from a
      // smoke stack's compose env, so it carries one. Unset would be the
      // acceptance path, where `free` is refused — see the RM_ENV cases below.
      RM_ENV: "smoke",
      RM_OPERATOR_TOKEN_FILE: tokenFile,
      UNDEF: undefined,
    });
    rmSync(tokenDir, { recursive: true, force: true });
    expect(rail.composeProject).toBe("rm_ci_stack_y");
    expect(rail.composeFiles).toEqual(["docker-compose.yml", "docker-compose.smoke.yml"]);
    expect("UNDEF" in rail.composeSpawnEnv).toBe(false);
    expect(rail.operatorToken).toBe("operator-token");
    // Keyless selection resolves with no credential — DEVELOPMENT only. This is
    // the contrast case for the two refusals below: it is legal here precisely
    // because nothing about this environment claims its output is evidence.
    expect(rail.modelConfig.apiKeyEnv).toBeNull();
  });

  // AC-MODEL-01's analyst/proposer half rested on ONE untested line —
  // scripts/lib/swarm/agent.ts's `modelConfig: resolveModelConfig(env)` — whose
  // comment claims it "is what makes resolveModelConfig() refuse a keyless model
  // and a raw-id override for the member containers it launches". The only
  // railFromEnv model assertion in the repo was the keyless case ABOVE, i.e. the
  // opposite claim, so a regression that stopped the member containers refusing
  // a free-family model would have gone entirely unnoticed. These two turn the
  // comment into a fact the suite defends.
  //
  // RM_ENV IS THE SIGNAL HERE, and deliberately the only one: railFromEnv() is a
  // child process handed the stack's compose env and cannot see the
  // `--static-port` standing-stack flag. Staging runs RM_ENV=prod (there is no
  // "staging" value — backend/src/config.ts refuses one), so the boundary these
  // pin is exactly the one checklist step 1.10 asserts on the host.
  test("an acceptance path REFUSES a keyless/free-family model", () => {
    expect(() => railFromEnv({ SMOKE_PROJECT: "p", AGENT_MODEL: "free", RM_ENV: "prod" }))
      .toThrow(/disqualified for acceptance/i);
    expect(() => railFromEnv({ SMOKE_PROJECT: "p", AGENT_MODEL: "free/nemotron-3-ultra", RM_ENV: "prod" }))
      .toThrow(/disqualified for acceptance/i);
  });

  test("an acceptance path with the pinned model and NO credential fails closed", () => {
    expect(() => railFromEnv({ SMOKE_PROJECT: "p", AGENT_MODEL: "deepseek", RM_ENV: "prod" }))
      .toThrow(/OPENCODE_API_KEY/);
    // The control: the same selection WITH a credential resolves, and resolves
    // to the pinned paid id rather than substituting anything.
    const rail = railFromEnv({ SMOKE_PROJECT: "p", AGENT_MODEL: "deepseek", RM_ENV: "prod", OPENCODE_API_KEY: "sk-not-real" });
    expect(rail.modelConfig.model).toBe("opencode/deepseek-v4-flash");
    expect(rail.modelConfig.apiKeyEnv).toBe("OPENCODE_API_KEY");
  });

  test("a raw opencode/<id> override is refused on an acceptance path (D22 rule 1)", () => {
    expect(() => railFromEnv({
      SMOKE_PROJECT: "p", AGENT_MODEL: "opencode/deepseek-v4-flash", RM_ENV: "prod", OPENCODE_API_KEY: "sk-not-real",
    })).toThrow();
  });

  // RM_ENV=smoke is what rm-frontend-stage-1 carried on 2026-09-13 (checklist
  // §3), so this records the boundary rather than leaving it to be rediscovered:
  // until step 1.10 changes RM_ENV on that host, a STANDALONE
  // `bun run scripts/lib/swarm/session.ts` against it still accepts a keyless
  // model. The stack's own `smoke:stage` boot does not — it refuses before any
  // container starts (scripts/lib/smoke-inference-preflight.ts).
  test("RM_ENV=smoke is a development path — the boundary step 1.10 closes", () => {
    const rail = railFromEnv({ SMOKE_PROJECT: "p", AGENT_MODEL: "free", RM_ENV: "smoke" });
    expect(rail.modelConfig.model).toBe("opencode/nemotron-3-ultra-free");
    expect(rail.modelConfig.apiKeyEnv).toBeNull();
  });
});
