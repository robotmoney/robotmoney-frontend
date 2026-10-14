// scripts/tests/unit/release-runbook.test.ts — the release runbooks as YAML
// (scripts/release/runbook.ts, D70): a template is the general runbook, and a
// release's runbook is a copy of one template that only adds steps.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_TEMPLATE, checkAddOnly, loadReleaseRunbook, loadTemplate, parseReleaseRunbook, parseTemplate, releaseRunbookNames,
  releaseRunbookPath, templatePath, type ReleaseRunbook, type RunbookStep,
} from "../../release/runbook.ts";
import { RELEASE_STEPS, stepListHash } from "../../release/steps.ts";
import { loadTarget } from "../../release/target.ts";

const repoRoot = join(import.meta.dir, "..", "..", "..");
const template = loadTemplate();
const added = (id: string, release = "v9.9.9"): RunbookStep => ({
  id, added: release, standing: [], description: `check ${id}`, host: "target", irreversible: false, expectExit: 0, receipts: [],
  cmds: [["bun", "scripts/release/schedule-parity.ts", "--instance", "{instance}"]],
});
const runbook = (steps: readonly RunbookStep[], release = "v9.9.9"): ReleaseRunbook => ({ release, template: "kitchen-sink", recovery: "fix forward", steps });
const ids = template.steps.map((s) => s.id);

/** PURE. Numeric compare of vA.B.C names. */
const semver = (v: string) => v.replace(/^v/, "").split(".").map(Number);
const atLeast = (a: string, b: string) => {
  const [x, y] = [semver(a), semver(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! > y[i]!;
  return true;
};

describe("the kitchen-sink template", () => {
  test("is the default and is the step list the runner and the runbook table read", () => {
    expect(DEFAULT_TEMPLATE).toBe("kitchen-sink");
    expect(template.steps).toEqual(RELEASE_STEPS);
    expect(template.steps.every((s) => (s as RunbookStep).added === undefined)).toBe(true);
  });

  test("refuses an unknown key, a missing field, an added step and a duplicate id", () => {
    const text = readFileSync(templatePath("kitchen-sink"), "utf8");
    expect(() => parseTemplate(text.replace('  - id: "R1.3"\n', '  - id: "R1.3"\n    bogus: 1\n'), "kitchen-sink")).toThrow("unknown key bogus");
    expect(() => parseTemplate(text.replace('  - id: "R1.3"\n', '  - id: "R1.3"\n    added: "v0.6.2"\n'), "kitchen-sink")).toThrow("carries no added");
    expect(() => parseTemplate(text.replace('  - id: "R1.3"', '  - id: "R1.2"'), "kitchen-sink")).toThrow("R1.2 appears twice");
    expect(() => parseTemplate(text.replace(/\n    irreversible: true\n/, "\n"), "kitchen-sink")).toThrow("irreversible is a boolean");
  });
});

describe("a release runbook only adds", () => {
  test("a full copy passes, and has the template's hash", () => {
    expect(checkAddOnly(template, runbook(template.steps))).toEqual([]);
  });

  test("an added step may sit anywhere: first, between two steps, last", () => {
    const steps = [added("X0"), ...template.steps.slice(0, 12), added("X1"), added("X2"), ...template.steps.slice(12), added("X3")];
    expect(checkAddOnly(template, runbook(steps))).toEqual([]);
    expect(stepListHash(steps)).not.toBe(stepListHash(template.steps));
  });

  test("red controls: a deletion, an edit, a reorder, and a step without its added mark each refuse", () => {
    const deleted = template.steps.filter((s) => s.id !== "R2.5");
    expect(checkAddOnly(template, runbook(deleted)).join()).toContain("template step R2.5 is missing");
    const edited = template.steps.map((s) => (s.id === "R6.3" ? { ...s, cmds: [[...s.cmds[0]!, "--skip-identity"]] } : s));
    expect(checkAddOnly(template, runbook(edited)).join()).toContain("R6.3 differs from the template's step");
    const softened = template.steps.map((s) => (s.id === "R6.3" ? { ...s, irreversible: false } : s));
    expect(checkAddOnly(template, runbook(softened)).join()).toContain("R6.3 differs");
    const reordered = [template.steps[1]!, template.steps[0]!, ...template.steps.slice(2)];
    expect(checkAddOnly(template, runbook(reordered)).join()).toContain("out of the template's order");
    const { added: _a, ...unmarked } = added("X1");
    expect(checkAddOnly(template, runbook([...template.steps, unmarked])).join()).toContain("carries added: v9.9.9");
    expect(checkAddOnly(template, runbook([...template.steps, added("X1", "v0.0.1")])).join()).toContain("carries added: v9.9.9");
    const marked = template.steps.map((s) => (s.id === "W1" ? { ...s, added: "v9.9.9" } : s));
    expect(checkAddOnly(template, runbook(marked)).join()).toContain("W1 is a template step, so it carries no added");
  });

  test("the key order a file writes never matters; the content does", () => {
    const reKeyed = template.steps.map((s) => Object.fromEntries(Object.entries(s).reverse()) as unknown as RunbookStep);
    expect(checkAddOnly(template, runbook(reKeyed))).toEqual([]);
  });

  test("the template defaults to kitchen-sink; an unknown template or release name refuses", () => {
    const body = readFileSync(templatePath("kitchen-sink"), "utf8");
    const steps = body.slice(body.indexOf("\nsteps:") + 1);
    expect(parseReleaseRunbook(`release: v9.9.9\nrecovery: fix forward\n${steps}`, "v9.9.9").template).toBe("kitchen-sink");
    expect(() => parseReleaseRunbook(`release: v9.9.9\nrecovery: fix forward\ntemplate: website-only\n${steps}`, "v9.9.9")).toThrow("template website-only is not one of kitchen-sink");
    expect(() => parseReleaseRunbook(`release: v9.9.8\nrecovery: fix forward\n${steps}`, "v9.9.9")).toThrow("names release v9.9.8");
  });

  test("loading refuses a missing runbook and one that drops a step", () => {
    const dir = mkdtempSync(join(tmpdir(), "runbooks-"));
    mkdirSync(join(dir, "templates"));
    mkdirSync(join(dir, "releases"));
    const text = readFileSync(templatePath("kitchen-sink"), "utf8");
    writeFileSync(join(dir, "templates", "kitchen-sink.yaml"), text);
    expect(() => loadReleaseRunbook("v9.9.9", dir)).toThrow("has no runbook");
    const steps = text.slice(text.indexOf("\nsteps:") + 1);
    writeFileSync(releaseRunbookPath("v9.9.9", dir), `release: v9.9.9\nrecovery: fix forward\ntemplate: kitchen-sink\n${steps}`);
    expect(loadReleaseRunbook("v9.9.9", dir).steps.map((s) => s.id)).toEqual(ids);
    const r25 = steps.indexOf('  - id: "R2.5"');
    const r61 = steps.indexOf("\n  # ── C/R6 cutover");
    writeFileSync(releaseRunbookPath("v9.9.9", dir), `release: v9.9.9\nrecovery: fix forward\n${steps.slice(0, r25)}${steps.slice(r61 + 1)}`);
    expect(() => loadReleaseRunbook("v9.9.9", dir)).toThrow("template step R2.5 is missing");
  });
});

describe("the committed release runbooks", () => {
  // A runbook for the release the targets name, or a later one, is in flight:
  // a step added to the template must reach it in the same pull request.
  const current = loadTarget(join(repoRoot, "scripts", "release", "targets", "prod.json")).release;
  const inFlight = releaseRunbookNames().filter((r) => atLeast(r, current));

  test("at least the next release has a runbook", () => {
    expect(inFlight.length).toBeGreaterThan(0);
  });

  for (const release of inFlight) {
    test(`${release} only adds to its template`, () => {
      expect(() => loadReleaseRunbook(release)).not.toThrow();
    });
  }
});
