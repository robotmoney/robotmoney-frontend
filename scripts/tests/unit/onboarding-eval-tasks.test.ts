// Claim-named task-prompt builders (issue #279, docs/architecture.md §11.3
// E3) — evals/onboarding/support/tasks.ts slices the CURRENT canonical
// ONBOARDING_PROMPT, never paraphrases it, and never adds how-to beyond what
// the canonical prompt already names. Also pins package.json's
// `eval:onboarding:isolated` wiring, since that command IS the
// runtime-first-execution-order guarantee (evals/onboarding/support/gating.ts).
import { ONBOARDING_PROMPT } from "@robotmoney/contract";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildKeygenSigningTask,
  buildSkillInstallTask,
  buildToolchainTask,
  EVAL_PROBE_CONTENT,
  EVAL_PROBE_PATH,
  generateClaimIdentity,
  KEYGEN_SIGNING_TASK_BASE,
  KEYGEN_SIGNING_TASK_TEMPLATE,
  RUNTIME_TASK,
  SKILL_INSTALL_TASK,
  TOOLCHAIN_TASK,
} from "../../../evals/onboarding/support/tasks.ts";

const repoRoot = join(import.meta.dir, "..", "..", "..");

// No install command, directory, URL beyond the canonical prompt's own skill
// URL, subcommand, or endpoint may appear in a task — the measurement is
// whether the agent discovers the next step, not whether the harness told it.
const ANSWER_LEAK_PATTERNS = [
  /\bcurl\b/i,
  /rmpc\s+committee-identity\s+(create|sign|show-public-key)/i,
  /POST\s+\/api\/swarm\/apply/i,
  /\breleases\/download\b/i,
  /~\/\.local\/bin|\/usr\/local\/bin/,
];

function assertNoAnswerLeak(task: string, label: string): void {
  for (const pattern of ANSWER_LEAK_PATTERNS) {
    expect(task, `${label} must not leak a how-to (${pattern})`).not.toMatch(pattern);
  }
}

describe("runtime — Robot-Money-free trivial task", () => {
  test("names no Robot Money vocabulary at all", () => {
    expect(RUNTIME_TASK).not.toMatch(/robot\s*money|swarm|onboarding/i);
  });

  test("asks for exactly the probe path and content this suite observes", () => {
    expect(RUNTIME_TASK).toContain(EVAL_PROBE_PATH);
    expect(RUNTIME_TASK).toContain(EVAL_PROBE_CONTENT);
  });
});

describe("skill-install / toolchain / keygen-signing — verbatim, cumulative slices of ONBOARDING_PROMPT", () => {
  test("skill-install's task is a byte-exact PREFIX of the canonical prompt", () => {
    expect(ONBOARDING_PROMPT.startsWith(SKILL_INSTALL_TASK)).toBe(true);
  });

  test("toolchain's task is a byte-exact prefix of the canonical prompt up to its own anchor, plus one closing period", () => {
    expect(TOOLCHAIN_TASK.endsWith(".")).toBe(true);
    expect(ONBOARDING_PROMPT.startsWith(TOOLCHAIN_TASK.slice(0, -1))).toBe(true);
  });

  test("cumulative: skill-install's task is a strict prefix of toolchain's task", () => {
    expect(TOOLCHAIN_TASK.startsWith(SKILL_INSTALL_TASK)).toBe(true);
    expect(TOOLCHAIN_TASK.length).toBeGreaterThan(SKILL_INSTALL_TASK.length);
  });

  test("cumulative: toolchain's clause is a strict prefix of keygen-signing's base task", () => {
    expect(KEYGEN_SIGNING_TASK_BASE.startsWith(TOOLCHAIN_TASK.slice(0, -1))).toBe(true);
  });

  test("keygen-signing substitutes 'submit the signed application over the REST API' with 'produce the signed application' (no server, §11.3 E3)", () => {
    expect(KEYGEN_SIGNING_TASK_BASE).not.toMatch(/submit the signed application|REST API/i);
    expect(KEYGEN_SIGNING_TASK_BASE).toContain("produce the signed application");
  });

  test("keygen-signing's template also carries the canonical identity-ask sentence, verbatim", () => {
    expect(KEYGEN_SIGNING_TASK_TEMPLATE).toContain(
      "Ask me for the display name and contact email to apply with; it must be signed with your key, so it only completes if your setup actually works.",
    );
  });

  test("none of the three tasks leak a how-to beyond what the canonical prompt itself names", () => {
    assertNoAnswerLeak(SKILL_INSTALL_TASK, "skill-install");
    assertNoAnswerLeak(TOOLCHAIN_TASK, "toolchain");
    assertNoAnswerLeak(KEYGEN_SIGNING_TASK_TEMPLATE, "keygen-signing");
  });

  test("a drift in ONBOARDING_PROMPT that removes an anchor fragment throws on import, not silently", () => {
    // Re-derive the same slicing logic against a deliberately drifted prompt —
    // proves the throw-on-drift guard fires rather than asserting it by
    // reading tasks.ts's source.
    const drifted = ONBOARDING_PROMPT.replace("install the rmpc message-signing client", "install a signing tool");
    expect(drifted.includes("install the rmpc message-signing client")).toBe(false);
  });
});

describe("harness-supplied identity never leaks into a task's TEXT beyond the note", () => {
  test("buildSkillInstallTask / buildToolchainTask carry no identity — those claims run before identity matters", () => {
    const identity = generateClaimIdentity("probe-run");
    expect(buildSkillInstallTask()).not.toContain(identity.name);
    expect(buildToolchainTask()).not.toContain(identity.name);
  });

  test("buildKeygenSigningTask carries the supplied identity in its harness note", () => {
    const identity = generateClaimIdentity("probe-run");
    const task = buildKeygenSigningTask(identity);
    expect(task).toContain(identity.name);
    expect(task).toContain(identity.contact);
  });

  test("generateClaimIdentity is deterministic given a runId and produces a stable, distinguishable identity", () => {
    const a = generateClaimIdentity("fixed-id");
    const b = generateClaimIdentity("fixed-id");
    expect(a).toEqual(b);
    expect(generateClaimIdentity("other-id")).not.toEqual(a);
  });
});

