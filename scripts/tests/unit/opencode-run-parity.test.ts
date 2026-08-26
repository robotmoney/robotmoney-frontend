import { describe, expect, test } from "bun:test";
import { buildMemberAgentArgv, type MemberAgentModel } from "../../agent/member-agent.ts";
import {
  buildOpenCodeConfig,
  buildOpenCodeRunArgs,
  buildOpenCodeSpawnEnv,
  resolveOpenCodeRun,
} from "../../agent/opencode-run.ts";
import { opencodeTimeoutEnv } from "../../lib/opencode-env.ts";
import { participateTimeoutMs } from "../../lib/swarm/agent.ts";
import { resolveInferenceOpenCodeRun } from "../../lib/swarm/inference.ts";

const PROMPT = "private prompt text that must not enter runtime metadata";

function directContainerTail(model: string, titleScope = "robotmoney-swarm"): string[] {
  const modelConfig: MemberAgentModel = {
    model,
    apiKeyEnv: "OPENCODE_API_KEY",
    apiKey: "sk-container-only",
  };
  const argv = buildMemberAgentArgv({
    composeProject: "rm_smoke_stack_parity",
    containerName: "rm_smoke_stack_parity-member-agent-eval-test",
    opencodeConfigPath: "/tmp/opencode.json",
    title: titleScope,
    prompt: PROMPT,
    modelConfig,
  });
  return argv.slice(argv.indexOf("member-agent") + 1);
}

describe("shared OpenCode run contract", () => {
  for (const [name, env, model] of [
    ["DeepSeek default", {}, "opencode/deepseek-v4-flash"],
    ["custom model", { AGENT_MODEL: "opencode/vendor-custom-7" }, "opencode/vendor-custom-7"],
  ] as const) {
    test(`${name}: direct onboarding and session inference have identical common argv`, () => {
      const inference = resolveInferenceOpenCodeRun(env);
      expect(inference.model).toBe(model);
      expect(directContainerTail(model)).toEqual(buildOpenCodeRunArgs(inference, PROMPT, { directory: "/home/agent" }));
      expect(inference.executable).toBe("opencode");
      expect(inference.provider).toBe("opencode");
    });
  }

  test("a deterministic title always suppresses the auxiliary GPT title call", () => {
    const run = resolveOpenCodeRun({
      env: {},
      model: "opencode/deepseek-v4-flash",
      titleScope: "robotmoney-swarm",
    });
    const argv = buildOpenCodeRunArgs(run, PROMPT);
    expect(argv.slice(argv.indexOf("--title"), argv.indexOf("--title") + 2)).toEqual([
      "--title", "robotmoney-swarm-opencode-deepseek-v4-flash",
    ]);
    expect(argv).not.toContain("gpt-5.4-nano");
    expect(argv.at(-1)).toBe(PROMPT);
    expect(argv).toContain("--print-logs");
    expect(argv.slice(argv.indexOf("--log-level"), argv.indexOf("--log-level") + 2)).toEqual([
      "--log-level", "DEBUG",
    ]);
  });

  test("invalid timeout values fail identically at inference, propagation, and outer ceiling boundaries", () => {
    for (const raw of ["0", "-1", "NaN", "1.5", "Infinity"]) {
      const env = { OPENCODE_TIMEOUT_MS: raw };
      expect(() => resolveInferenceOpenCodeRun(env)).toThrow(/positive integer/);
      expect(() => opencodeTimeoutEnv(env)).toThrow(/positive integer/);
      expect(() => participateTimeoutMs(env)).toThrow(/positive integer/);
    }
  });

  test("runtime metadata/config omit prompts and secrets; the subprocess env is a strict allowlist", () => {
    const hostEnv = {
      PATH: "/bin",
      HOME: "/home/agent",
      TERM: "xterm",
      AGENT_MODEL: "deepseek",
      OPENCODE_API_KEY: "sk-secret",
      ADMIN_TOKEN: "admin-secret",
      RM_MEMBER_TOKEN: "member-secret",
      PROMPT,
    };
    const run = resolveOpenCodeRun({ env: hostEnv, titleScope: "robotmoney-swarm" });
    const serialized = JSON.stringify({ run, config: buildOpenCodeConfig(run.model) });
    expect(serialized).not.toContain(PROMPT);
    expect(serialized).not.toContain("sk-secret");
    expect(serialized).not.toContain("admin-secret");
    expect(serialized).not.toContain("member-secret");
    expect(buildOpenCodeSpawnEnv(hostEnv)).toEqual({
      PATH: "/bin",
      HOME: "/home/agent",
      TERM: "xterm",
      OPENCODE_API_KEY: "sk-secret",
    });
    const argv = buildOpenCodeRunArgs(run, PROMPT);
    expect(argv.filter((value) => value === PROMPT)).toHaveLength(1);
    expect(argv.at(-1)).toBe(PROMPT);
    expect(argv.join(" ")).not.toContain("admin-secret");
    expect(argv.join(" ")).not.toContain("member-secret");
    expect(argv.join(" ")).not.toContain("sk-secret");
  });
});
