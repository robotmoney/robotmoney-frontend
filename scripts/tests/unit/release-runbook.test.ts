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
  scopeProblems,
} from "../../release/runbook.ts";
import { prsOf, scopeCoverage } from "../../release/scope.ts";
import { RELEASE_STEPS, stepListHash } from "../../release/steps.ts";
import { loadTarget } from "../../release/target.ts";

const repoRoot = join(import.meta.dir, "..", "..", "..");
const template = loadTemplate();
const added = (id: string, release = "v9.9.9"): RunbookStep => ({
  id, added: release, standing: [], description: `check ${id}`, host: "target", phase: "cutover", irreversible: false, expectExit: 0, receipts: [],
  cmds: [["bun", "scripts/release/schedule-parity.ts", "--instance", "{instance}"]],
});
const runbook = (steps: readonly RunbookStep[], release = "v9.9.9"): ReleaseRunbook => ({ release, template: "kitchen-sink", recovery: "fix forward", scope: [], steps });
/** A one-entry scope, for release runbook texts the tests build. */
const SCOPE = "scope:\n  - {pr: 1, what: a test change, none: a test}\n";
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
    expect(() => parseTemplate(text.replace('  - id: "P03-install"\n', '  - id: "P03-install"\n    bogus: 1\n'), "kitchen-sink")).toThrow("unknown key bogus");
    expect(() => parseTemplate(text.replace('  - id: "P03-install"\n', '  - id: "P03-install"\n    added: "v0.6.2"\n'), "kitchen-sink")).toThrow("carries no added");
    expect(() => parseTemplate(text.replace('  - id: "P03-install"', '  - id: "P02-host-identity"'), "kitchen-sink")).toThrow("P02-host-identity appears twice");
    expect(() => parseTemplate(text.replace(/\n    irreversible: true\n/, "\n"), "kitchen-sink")).toThrow("irreversible is a boolean");
 
  });

  test("the phases (owner, 2026-10-16): every step names one, its id says which, and they run qa (stage), preflight, cutover (production)", () => {
    const text = readFileSync(templatePath("kitchen-sink"), "utf8");
    const order = ["qa", "preflight", "cutover"];
    expect(template.steps.map((s) => s.phase)).toEqual([...template.steps.map((s) => s.phase)].sort((a, b) => order.indexOf(a) - order.indexOf(b)));
    for (const s of template.steps) expect(s.onlyFor, s.id).toBe(s.phase === "qa" ? "stage" : "prod");
    // red: a missing or unknown phase.
    expect(() => parseTemplate(text.replace('  - id: "P03-install"\n    standing: ["SP.1"]\n    host: "target"\n    phase: "preflight"\n', '  - id: "P03-install"\n    standing: ["SP.1"]\n    host: "target"\n'), "kitchen-sink")).toThrow("phase is one of qa, preflight, cutover");
    expect(() => parseTemplate(text.replace('    phase: "preflight"\n', '    phase: "warmup"\n'), "kitchen-sink")).toThrow("phase is one of");
    expect(() => parseTemplate(text.replace('    phase: "preflight"\n', '    phase: "soak"\n'), "kitchen-sink")).toThrow("phase is one of qa, preflight, cutover");
    // red: an id whose letter is not its phase's.
    expect(() => parseTemplate(text.replace('  - id: "P03-install"', '  - id: "C99-install"'), "kitchen-sink")).toThrow("a preflight step's id starts with P");
    // red: a cutover step moved before a preflight one.
    const p08 = text.indexOf('  - id: "P08-log-baseline"');
    const c01 = text.indexOf('  - id: "C01-backup"');
    const c02 = text.indexOf('  - id: "C02-backup-sums"');
    const moved = text.slice(0, p08) + text.slice(c01, c02) + text.slice(p08, c01) + text.slice(c02);
    expect(() => parseTemplate(moved, "kitchen-sink")).toThrow("P08-log-baseline (preflight) comes after C01-backup (cutover)");
  });

  test("a step runs on one target: a qa step on stage only, a preflight or cutover step on production only", () => {
    const text = readFileSync(templatePath("kitchen-sink"), "utf8");
    expect(() => parseTemplate(text.replace('  - id: "Q06-checkout"', '  - id: "Q06-checkout"').replace(/(  - id: "Q08-install"[\s\S]*?onlyFor: )"stage"/, '$1"prod"'), "kitchen-sink")).toThrow("a qa step runs on stage only");
    expect(() => parseTemplate(text.replace(/(  - id: "C05-migrate"[\s\S]*?onlyFor: )"prod"/, '$1"stage"'), "kitchen-sink")).toThrow("a cutover step runs on prod only");
  });

  test("production runs only what stage ran: every P and C step has a Q twin of the same name and commands, in the same order", () => {
    const text = readFileSync(templatePath("kitchen-sink"), "utf8");
    // red: a production step whose stage twin is gone.
    const q = text.indexOf('  - id: "Q08-install"');
    const q2 = text.indexOf('  - id: "Q09-capture-checkout"');
    expect(() => parseTemplate(text.slice(0, q) + text.slice(q2), "kitchen-sink")).toThrow("P03-install has no QA twin named install");
    // red: a stage step with no production twin and no stageOnly mark.
    const p = text.indexOf('  - id: "P03-install"');
    const p2 = text.indexOf('  - id: "P04-capture-checkout"');
    expect(() => parseTemplate(text.slice(0, p) + text.slice(p2), "kitchen-sink")).toThrow("Q08-install has no production twin named install");
    // red: a twin whose commands differ.
    expect(() => parseTemplate(text.replace(/(  - id: "Q08-install"[\s\S]*?"--frozen-lockfile")/, '$1, "--silent"'), "kitchen-sink")).toThrow("Q08-install and P03-install differ");
    // the version tag is production's only step without a twin, and stage's preparation has none.
    const names = template.steps.map((st) => st.id);
    expect(names).toContain("C06-version-tag");
    expect(names.some((n) => n.endsWith("-version-tag") && n.startsWith("Q"))).toBe(false);
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
    const deleted = template.steps.filter((s) => s.id !== "P08-log-baseline");
    expect(checkAddOnly(template, runbook(deleted)).join()).toContain("template step P08-log-baseline is missing");
    const edited = template.steps.map((s) => (s.id === "C05-migrate" ? { ...s, cmds: [[...s.cmds[0]!, "--skip-identity"]] } : s));
    expect(checkAddOnly(template, runbook(edited)).join()).toContain("C05-migrate differs from the template's step");
    const softened = template.steps.map((s) => (s.id === "C05-migrate" ? { ...s, irreversible: false } : s));
    expect(checkAddOnly(template, runbook(softened)).join()).toContain("C05-migrate differs");
    const reordered = [template.steps[1]!, template.steps[0]!, ...template.steps.slice(2)];
    expect(checkAddOnly(template, runbook(reordered)).join()).toContain("out of the template's order");
    const { added: _a, ...unmarked } = added("X1");
    expect(checkAddOnly(template, runbook([...template.steps, unmarked])).join()).toContain("carries added: v9.9.9");
    expect(checkAddOnly(template, runbook([...template.steps, added("X1", "v0.0.1")])).join()).toContain("carries added: v9.9.9");
    const marked = template.steps.map((s) => (s.id === "C20-soak-gate" ? { ...s, added: "v9.9.9" } : s));
    expect(checkAddOnly(template, runbook(marked)).join()).toContain("C20-soak-gate is a template step, so it carries no added");
  });

  test("the key order a file writes never matters; the content does", () => {
    const reKeyed = template.steps.map((s) => Object.fromEntries(Object.entries(s).reverse()) as unknown as RunbookStep);
    expect(checkAddOnly(template, runbook(reKeyed))).toEqual([]);
  });

  test("the template defaults to kitchen-sink; an unknown template or release name refuses", () => {
    const body = readFileSync(templatePath("kitchen-sink"), "utf8");
    const steps = body.slice(body.indexOf("\nsteps:") + 1);
    expect(parseReleaseRunbook(`release: v9.9.9\nrecovery: fix forward\n${SCOPE}${steps}`, "v9.9.9").template).toBe("kitchen-sink");
    expect(() => parseReleaseRunbook(`release: v9.9.9\nrecovery: fix forward\ntemplate: website-only\n${SCOPE}${steps}`, "v9.9.9")).toThrow("template website-only is not one of kitchen-sink");
    expect(() => parseReleaseRunbook(`release: v9.9.8\nrecovery: fix forward\n${SCOPE}${steps}`, "v9.9.9")).toThrow("names release v9.9.8");
  });

  test("loading refuses a missing runbook and one that drops a step", () => {
    const dir = mkdtempSync(join(tmpdir(), "runbooks-"));
    mkdirSync(join(dir, "templates"));
    mkdirSync(join(dir, "releases"));
    const text = readFileSync(templatePath("kitchen-sink"), "utf8");
    writeFileSync(join(dir, "templates", "kitchen-sink.yaml"), text);
    expect(() => loadReleaseRunbook("v9.9.9", dir)).toThrow("has no runbook");
    const steps = text.slice(text.indexOf("\nsteps:") + 1);
    writeFileSync(releaseRunbookPath("v9.9.9", dir), `release: v9.9.9\nrecovery: fix forward\ntemplate: kitchen-sink\n${SCOPE}${steps}`);
    expect(loadReleaseRunbook("v9.9.9", dir).steps.map((s) => s.id)).toEqual(ids);
    const q01 = steps.indexOf('  - id: "Q01-lockfile"');
    const q02 = steps.indexOf('  - id: "Q02-dump"');
    writeFileSync(releaseRunbookPath("v9.9.9", dir), `release: v9.9.9\nrecovery: fix forward\n${SCOPE}${steps.slice(0, q01)}${steps.slice(q02)}`);
    expect(() => loadReleaseRunbook("v9.9.9", dir)).toThrow("template step Q01-lockfile is missing");
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

// ── scope: every PR a release ships, each with its check or a reason (owner, 2026-10-15) ──
describe("a release's scope", () => {
  const steps = [{ id: "Q35-a" }, { id: "C14-b" }];
  test("an entry names its PR and exactly one of check: <step of this runbook> or none: <reason>", () => {
    expect(scopeProblems([{ pr: 1, what: "x", check: "Q35-a" }, { pr: 2, what: "y", none: "docs only" }], steps, "w")).toEqual([]);
    // red: none at all, both, a check that is no step, a duplicate PR, an unknown key, an empty list.
    expect(scopeProblems([{ pr: 1, what: "x" }], steps, "w").join()).toContain("exactly one of");
    expect(scopeProblems([{ pr: 1, what: "x", check: "Q35-a", none: "r" }], steps, "w").join()).toContain("exactly one of");
    expect(scopeProblems([{ pr: 1, what: "x", check: "Q99-gone" }], steps, "w").join()).toContain("Q99-gone is no step");
    expect(scopeProblems([{ pr: 1, what: "x", none: "r" }, { pr: 1, what: "x", none: "r" }], steps, "w").join()).toContain("appears twice");
    expect(scopeProblems([{ pr: 1, what: "x", none: "r", owner: "z" }], steps, "w").join()).toContain("unknown key owner");
    expect(scopeProblems([], steps, "w").join()).toContain("scope lists every PR");
    expect(scopeProblems(undefined, steps, "w").join()).toContain("scope lists every PR");
  });

  test("the PRs a range ships are its subjects' (#n), and the scope must list exactly them", () => {
    expect(prsOf(["fix(x): a thing (#1338)", "Merge branch 'a' into b", "feat: two (#12) and (#13)", "again (#1338)"])).toEqual([12, 13, 1338]);
    const scope = [{ pr: 12, what: "a", none: "docs" }, { pr: 13, what: "b", check: "Q35-a" }];
    expect(scopeCoverage([12, 13], scope)).toEqual([]);
    // red: a shipped PR the scope misses, and a listed PR no commit carries.
    expect(scopeCoverage([12, 13, 14], scope).join()).toContain("PR 14 ships in this release");
    expect(scopeCoverage([12], scope).join()).toContain("scope lists PR 13");
  });

  test("v0.6.2's scope checks every product change with a version step: each is a Q step and a C twin, or a stage-only Q step", () => {
    const v062 = loadReleaseRunbook("v0.6.2");
    const addedSteps = v062.steps.filter((s) => (s as RunbookStep).added === "v0.6.2");
    expect(addedSteps.every((s) => s.phase === "qa" || s.phase === "cutover")).toBe(true);
    const qaChecks = addedSteps.filter((s) => s.phase === "qa");
    expect(qaChecks.length).toBeGreaterThanOrEqual(11);
    for (const s of qaChecks) expect(v062.scope.some((e) => e.check === s.id), s.id).toBe(true);
    // Production repeats every version check that does not write.
    const prodNames = new Set(addedSteps.filter((s) => s.phase === "cutover").map((s) => s.id.slice(4)));
    for (const s of qaChecks) expect(prodNames.has(s.id.slice(4)) !== ((s as { stageOnly?: boolean }).stageOnly === true), s.id).toBe(true);
    expect(template.steps.some((s) => (s as RunbookStep).added !== undefined)).toBe(false);
    // red: a release that drops a version check's production twin refuses.
    const text = readFileSync(join(repoRoot, "scripts", "release", "runbooks", "releases", "v0.6.2.yaml"), "utf8");
    const c23 = text.indexOf('  - id: "C23-subject-spacing"');
    const c24 = text.indexOf('  - id: "C24-maintenance-fallback"');
    expect(() => parseReleaseRunbook(text.slice(0, c23) + text.slice(c24), "v0.6.2")).toThrow("Q35-subject-spacing has no production twin named subject-spacing");
  });

  test("v0.6.3's three product changes (1393, 1406, 1388) each have a version step and a production twin", () => {
    const v063 = loadReleaseRunbook("v0.6.3");
    const added = v063.steps.filter((s) => (s as RunbookStep).added === "v0.6.3").map((s) => s.id);
    expect(added).toEqual(["Q35-member-avatar", "Q36-judge-draw", "Q37-home-monument", "C23-member-avatar", "C24-judge-draw", "C25-home-monument"]);
    expect(v063.scope.find((e) => e.pr === 1393)?.check).toBe("Q35-member-avatar");
    expect(v063.scope.find((e) => e.pr === 1406)?.check).toBe("Q36-judge-draw");
    expect(v063.scope.find((e) => e.pr === 1388)?.check).toBe("Q37-home-monument");
  });

  test("v0.6.4's runtime bump (1441) has a version step and a production twin", () => {
    const v064 = loadReleaseRunbook("v0.6.4");
    const added = v064.steps.filter((s) => (s as RunbookStep).added === "v0.6.4").map((s) => s.id);
    expect(added).toEqual(["Q35-runtime-bun", "C23-runtime-bun"]);
    expect(v064.scope).toEqual([{ pr: 1441, what: "the Bun runtime is 1.4.4 in the backend image, the member-agent image and CI", check: "Q35-runtime-bun" }]);
  });
});
