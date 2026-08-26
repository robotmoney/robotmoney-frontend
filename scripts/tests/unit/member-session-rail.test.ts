// Hermetic guards on the member-container SESSION rail (issue #361 Phase 2/3):
// the `docker compose run` argv the session-participation mode emits, the
// persistent-home volume naming, the client stdout protocol parser, and the
// standalone entry point's rail resolution. No Docker, no network, no model
// call — the live path is executed by the required e2e smoke gate (every
// present member's take is containerized there and asserted post-publish by
// assertAuthoredTakes).
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
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
    const rail = railFromEnv({
      SMOKE_PROJECT: "rm_ci_stack_y",
      COMPOSE_FILE: "docker-compose.yml:docker-compose.smoke.yml",
      AGENT_MODEL: "free",
      AUTOMATION_TOKEN: "automation-token",
      UNDEF: undefined,
    });
    expect(rail.composeProject).toBe("rm_ci_stack_y");
    expect(rail.composeFiles).toEqual(["docker-compose.yml", "docker-compose.smoke.yml"]);
    expect("UNDEF" in rail.composeSpawnEnv).toBe(false);
    expect(rail.automationToken).toBe("automation-token");
    // Keyless selection resolves with no credential.
    expect(rail.modelConfig.apiKeyEnv).toBeNull();
  });
});
