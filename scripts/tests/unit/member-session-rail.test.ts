// Hermetic guards on the member-container SESSION rail (issue #361 Phase 2/3):
// the `docker compose run` argv the session-participation mode emits, the
// persistent-home volume naming, the client stdout protocol parser, and the
// standalone entry point's rail resolution. No Docker, no network, no model
// call — the live path is executed by the required e2e demo gate (every
// present member's take is containerized there and asserted post-publish by
// assertAuthoredTakes).
import { describe, expect, test } from "bun:test";
import {
  buildMemberAgentArgv,
  memberHomeVolumeName,
  type MemberAgentModel,
} from "../../agent/member-agent.ts";
import { parseClientLine, railFromEnv } from "../../lib/committee/agent.ts";

const FUNDED: MemberAgentModel = { model: "opencode/test-model", apiKeyEnv: "OPENCODE_API_KEY", apiKey: "sk-test" };

function sessionArgv(overrides: Record<string, unknown> = {}): string[] {
  return buildMemberAgentArgv({
    composeProject: "rm_ci_stack_x",
    containerName: "rm_ci_stack_x-member-agent-eval-athena-s1",
    modelConfig: FUNDED,
    entrypoint: "bun",
    command: ["/rm/scripts/agent/member-session-client.ts", "participate"],
    mounts: [
      { source: "/repo", target: "/rm", readonly: true },
      { source: "rm_ci_stack_x_member_home_athena", target: "/home/agent" },
    ],
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
    expect(argv.slice(serviceAt + 1)).toEqual(["/rm/scripts/agent/member-session-client.ts", "participate"]);
    // No opencode-mode remnants.
    expect(argv).not.toContain("--auto");
    expect(argv).not.toContain("--title");
    expect(argv.join(" ")).not.toContain("opencode.json");
  });

  test("mounts the client software read-only and the member home volume writable", () => {
    const argv = sessionArgv().join(" ");
    expect(argv).toContain("-v /repo:/rm:ro");
    expect(argv).toContain("-v rm_ci_stack_x_member_home_athena:/home/agent");
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
    expect(parseClientLine("RM_STAGE", 'RM_RESULT {"stage":"thinking"}')).toBeNull();
    expect(parseClientLine("RM_STAGE", "free-form log line")).toBeNull();
    expect(parseClientLine("RM_STAGE", "RM_STAGE not-json")).toBeNull();
  });
});

describe("railFromEnv — the standalone session driver's rail resolution", () => {
  test("throws loudly when DEMO_PROJECT is missing", () => {
    expect(() => railFromEnv({ AGENT_MODEL: "free" })).toThrow(/DEMO_PROJECT is required/);
  });

  test("resolves project, compose files, and a defined-only spawn env", () => {
    const rail = railFromEnv({
      DEMO_PROJECT: "rm_ci_stack_y",
      COMPOSE_FILE: "docker-compose.yml:docker-compose.demo.yml",
      AGENT_MODEL: "free",
      UNDEF: undefined,
    });
    expect(rail.composeProject).toBe("rm_ci_stack_y");
    expect(rail.composeFiles).toEqual(["docker-compose.yml", "docker-compose.demo.yml"]);
    expect("UNDEF" in rail.composeSpawnEnv).toBe(false);
    // Keyless selection resolves with no credential.
    expect(rail.modelConfig.apiKeyEnv).toBeNull();
  });
});
