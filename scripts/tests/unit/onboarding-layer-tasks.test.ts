// PURE, per-PR coverage for the layer task text (docs/architecture.md §11.3 E3).
//
// The single way a layered eval quietly stops measuring anything is by LEAKING
// THE ANSWER: a `curl` recipe in the layer-2 prompt turns "can the agent install
// rmpc for its own architecture?" into "can the agent run a command we wrote".
// These tests execute that property on every PR, cheaply, so the leak is caught
// at review time rather than by a mysteriously perfect nightly.
//
// They also pin the two structural facts §11.3 E3 depends on: the tasks are
// derived from the CANONICAL prompt (not paraphrased), and layer 4 uses
// ONBOARDING_PROMPT verbatim plus exactly the existing local-network note.
import { describe, expect, test } from "bun:test";
import { ONBOARDING_PROMPT } from "@robotmoney/contract";
import {
  buildLayer1Task,
  buildLayer2Task,
  buildLayer3Task,
  buildLayer3TaskWithNote,
  harnessNote,
  EVAL_PROBE_CONTENT,
  EVAL_PROBE_PATH,
  LAYER0_TASK,
  LAYER1_TASK,
  LAYER2_TASK,
  LAYER3_TASK_TEMPLATE,
} from "../../../evals/onboarding/support/layer-tasks.ts";
import { buildAgentPrompt, generateIdentity } from "../../lib/onboarding-eval.ts";

// Every step a layer claims to MEASURE must still be the agent's to discover.
const ANSWER_LEAKS: Array<[string, RegExp]> = [
  ["a curl/wget recipe", /\bcurl\b|\bwget\b/i],
  ["the rmpc release URL", /releases\/download|robotmoney-core\/releases/i],
  ["the install directory", /\.local\/bin|\/usr\/local\/bin/],
  ["an rmpc subcommand", /committee-identity|show-public-key/i],
  ["the apply endpoint", /\/api\/committee\/apply|POST\s+\/api/i],
  ["the canonical serializer", /canonicalizeApplication/],
];

const LAYER_TASKS: Array<[string, string]> = [
  ["LAYER1_TASK", LAYER1_TASK],
  ["LAYER2_TASK", LAYER2_TASK],
  ["LAYER3_TASK_TEMPLATE", LAYER3_TASK_TEMPLATE],
];

describe("layer tasks leak no how-to", () => {
  for (const [name, task] of LAYER_TASKS) {
    for (const [what, re] of ANSWER_LEAKS) {
      test(`${name} does not contain ${what}`, () => {
        expect(task).not.toMatch(re);
      });
    }
  }

  test("LAYER0_TASK mentions nothing about Robot Money — it must separate a DEAD runtime from a refusal of OUR prompt", () => {
    expect(LAYER0_TASK).not.toMatch(/robot ?money|committee|rmpc|investment|memo/i);
    expect(LAYER0_TASK).toContain(EVAL_PROBE_PATH);
    expect(LAYER0_TASK).toContain(EVAL_PROBE_CONTENT);
  });
});

// The harness note (identity + "nobody is here to answer you") is ENVIRONMENT
// info, and it is the one place a how-to hint could be smuggled into a layer
// without touching the canonical slices above. So every answer-leak assertion is
// re-run against the NOTED tasks, and the note is pinned to the two facts it
// exists to restore — nothing more.
describe("the harness note restores identity/non-interactivity without leaking how-to", () => {
  const identity = generateIdentity("note-check");
  const NOTED: Array<[string, string]> = [
    ["buildLayer1Task", buildLayer1Task(identity)],
    ["buildLayer2Task", buildLayer2Task(identity)],
    ["buildLayer3TaskWithNote", buildLayer3TaskWithNote(identity)],
  ];

  for (const [name, task] of NOTED) {
    for (const [what, re] of ANSWER_LEAKS) {
      test(`${name} does not contain ${what}`, () => {
        expect(task).not.toMatch(re);
      });
    }
    test(`${name} carries the owner identity the slice dropped`, () => {
      expect(task).toContain(identity.name);
      expect(task).toContain(identity.contact);
    });
    test(`${name} keeps the note clearly delimited from the task`, () => {
      expect(task).toContain("Harness note (environment, not part of your task)");
      expect(task.indexOf("Harness note")).toBeGreaterThan(0);
    });
  }

  test("the note tells the agent not to wait for an owner who cannot answer", () => {
    expect(harnessNote(identity)).toMatch(/non-interactively/i);
    expect(harnessNote(identity)).toMatch(/do not wait for confirmation/i);
  });

  test("the note never becomes the task — layer 1/2 still open with the canonical slice", () => {
    expect(buildLayer1Task(identity).startsWith(LAYER1_TASK)).toBe(true);
    expect(buildLayer2Task(identity).startsWith(LAYER2_TASK)).toBe(true);
  });
});

describe("layer tasks are derived from the canonical prompt, not paraphrased", () => {
  test("LAYER1_TASK is a verbatim PREFIX of ONBOARDING_PROMPT (framing + the skill sentence, nothing after)", () => {
    expect(ONBOARDING_PROMPT.startsWith(LAYER1_TASK)).toBe(true);
    expect(LAYER1_TASK).toContain("committee-onboarding");
    expect(LAYER1_TASK).not.toContain("In short:");
  });

  test("the layers are cumulative: 1 ⊂ 2 ⊂ 3", () => {
    expect(LAYER2_TASK.startsWith(LAYER1_TASK)).toBe(true);
    expect(LAYER3_TASK_TEMPLATE.startsWith(LAYER1_TASK)).toBe(true);
  });

  test("layer 2 adds only the TOOLCHAIN half of canonical step (a) — no keygen, no signing", () => {
    const added = LAYER2_TASK.slice(LAYER1_TASK.length);
    expect(added).toContain("install the rmpc message-signing client");
    expect(ONBOARDING_PROMPT).toContain("install the rmpc message-signing client");
    expect(added).not.toMatch(/generate your signing key|signed application/);
  });

  test("layer 3 adds canonical keygen + the signed application, and asks the agent to PRODUCE it (no server exists at layer 3)", () => {
    const added = LAYER3_TASK_TEMPLATE.slice(LAYER1_TASK.length);
    expect(added).toContain("generate your signing key");
    expect(added).toContain("it must be signed with your key");
    expect(added).toContain("produce the signed application");
    expect(added).not.toContain("submit the signed application");
  });
});

describe("layer 3 identity substitution", () => {
  const identity = generateIdentity("fixed-runid");
  const task = buildLayer3Task(identity);

  test("the filled task carries the real identity and leaves NO placeholder behind", () => {
    expect(task).toContain(identity.name);
    expect(task).toContain(identity.contact);
    expect(task).not.toContain("<display name>");
    expect(task).not.toContain("<email>");
    expect(task).not.toMatch(/<[a-z][a-z ]*>/);
  });

  test("filling the identity changes nothing else about the task", () => {
    const restored = task.replace(identity.name, "<display name>").replace(identity.contact, "<email>");
    expect(restored).toBe(LAYER3_TASK_TEMPLATE);
  });
});

describe("layer 4 uses the canonical prompt verbatim", () => {
  const identity = generateIdentity("l4-fixed");
  const prompt = buildAgentPrompt(identity, "http://api:8787");

  test("it is ONBOARDING_PROMPT modulo the two identity placeholders, plus exactly the delimited harness note", () => {
    const filled = ONBOARDING_PROMPT.replace("<display name>", identity.name).replace("<email>", identity.contact);
    expect(prompt.startsWith(filled)).toBe(true);
    const note = prompt.slice(filled.length);
    expect(note.startsWith("\n\n---\n")).toBe(true);
    expect(note).toContain("Demo harness note");
    expect(note).toContain("http://api:8787");
  });

  test("the harness note carries the base URL and NO onboarding how-to of its own", () => {
    const note = prompt.slice(prompt.indexOf("\n\n---\n"));
    for (const [, re] of ANSWER_LEAKS) expect(note).not.toMatch(re);
  });
});
