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
import { RELEASE_STEPS, renderStep, stepListHash, templateValues } from "../../release/steps.ts";
import { rollingMigrationProblems } from "../../release/baseline.ts";
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
    expect(() => parseTemplate(text.replace('  - id: "P03-install"', '  - id: "P02-identity"'), "kitchen-sink")).toThrow("P02-identity appears twice");
    expect(() => parseTemplate(text.replace(/\n    irreversible: true\n/, "\n"), "kitchen-sink")).toThrow("irreversible is a boolean");
 
  });

  test("the phases (D70 as amended 2026-10-15): every step names one, its id says which, and they run qa, preflight, cutover, soak, version", () => {
    const text = readFileSync(templatePath("kitchen-sink"), "utf8");
    const order = ["qa", "preflight", "cutover", "soak", "version"];
    expect(template.steps.map((s) => s.phase)).toEqual([...template.steps.map((s) => s.phase)].sort((a, b) => order.indexOf(a) - order.indexOf(b)));
    // red: a missing or unknown phase.
    expect(() => parseTemplate(text.replace('  - id: "P03-install"\n    standing: ["SP.1"]\n    host: "target"\n    phase: "preflight"\n', '  - id: "P03-install"\n    standing: ["SP.1"]\n    host: "target"\n'), "kitchen-sink")).toThrow("phase is one of qa, preflight, cutover, soak, version");
    expect(() => parseTemplate(text.replace('    phase: "preflight"\n', '    phase: "warmup"\n'), "kitchen-sink")).toThrow("phase is one of");
    // red: an id whose letter is not its phase's.
    expect(() => parseTemplate(text.replace('  - id: "P03-install"', '  - id: "C99-install"'), "kitchen-sink")).toThrow("a preflight step's id starts with P");
    // red: a cutover step moved before a preflight one.
    const p08 = text.indexOf('  - id: "P08-log-baseline"');
    const c01 = text.indexOf('  - id: "C01-backup"');
    const c02 = text.indexOf('  - id: "C02-backup-sums"');
    const moved = text.slice(0, p08) + text.slice(c01, c02) + text.slice(p08, c01) + text.slice(c02);
    expect(() => parseTemplate(moved, "kitchen-sink")).toThrow("P08-log-baseline (preflight) comes after C01-backup (cutover)");
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
    const marked = template.steps.map((s) => (s.id === "S07-soak-gate" ? { ...s, added: "v9.9.9" } : s));
    expect(checkAddOnly(template, runbook(marked)).join()).toContain("S07-soak-gate is a template step, so it carries no added");
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
    const r25 = steps.indexOf('  - id: "P08-log-baseline"');
    const c01 = steps.indexOf('  - id: "C01-backup"');
    writeFileSync(releaseRunbookPath("v9.9.9", dir), `release: v9.9.9\nrecovery: fix forward\n${SCOPE}${steps.slice(0, r25)}${steps.slice(c01)}`);
    expect(() => loadReleaseRunbook("v9.9.9", dir)).toThrow("template step P08-log-baseline is missing");
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
  const steps = [{ id: "V01-a" }, { id: "S01-b" }];
  test("an entry names its PR and exactly one of check: <step of this runbook> or none: <reason>", () => {
    expect(scopeProblems([{ pr: 1, what: "x", check: "V01-a" }, { pr: 2, what: "y", none: "docs only" }], steps, "w")).toEqual([]);
    // red: none at all, both, a check that is no step, a duplicate PR, an unknown key, an empty list.
    expect(scopeProblems([{ pr: 1, what: "x" }], steps, "w").join()).toContain("exactly one of");
    expect(scopeProblems([{ pr: 1, what: "x", check: "V01-a", none: "r" }], steps, "w").join()).toContain("exactly one of");
    expect(scopeProblems([{ pr: 1, what: "x", check: "V09-gone" }], steps, "w").join()).toContain("V09-gone is no step");
    expect(scopeProblems([{ pr: 1, what: "x", none: "r" }, { pr: 1, what: "x", none: "r" }], steps, "w").join()).toContain("appears twice");
    expect(scopeProblems([{ pr: 1, what: "x", none: "r", owner: "z" }], steps, "w").join()).toContain("unknown key owner");
    expect(scopeProblems([], steps, "w").join()).toContain("scope lists every PR");
    expect(scopeProblems(undefined, steps, "w").join()).toContain("scope lists every PR");
  });

  test("the PRs a range ships are its subjects' (#n), and the scope must list exactly them", () => {
    expect(prsOf(["fix(x): a thing (#1338)", "Merge branch 'a' into b", "feat: two (#12) and (#13)", "again (#1338)"])).toEqual([12, 13, 1338]);
    const scope = [{ pr: 12, what: "a", none: "docs" }, { pr: 13, what: "b", check: "V01-a" }];
    expect(scopeCoverage([12, 13], scope)).toEqual([]);
    // red: a shipped PR the scope misses, and a listed PR no commit carries.
    expect(scopeCoverage([12, 13, 14], scope).join()).toContain("PR 14 ships in this release");
    expect(scopeCoverage([12], scope).join()).toContain("scope lists PR 13");
  });

  test("v0.6.2's scope checks every product change with a version step, and the template holds no version step", () => {
    const v062 = loadReleaseRunbook("v0.6.2");
    const versionIds = v062.steps.filter((s) => s.phase === "version").map((s) => s.id);
    expect(versionIds.length).toBeGreaterThanOrEqual(11);
    for (const id of versionIds) expect(v062.scope.some((e) => e.check === id), id).toBe(true);
    expect(v062.steps.filter((s) => s.phase === "version").every((s) => s.added === "v0.6.2")).toBe(true);
    expect(template.steps.some((s) => s.phase === "version")).toBe(false);
    // red: a template that carries a version step refuses.
    const text = readFileSync(templatePath("kitchen-sink"), "utf8");
    expect(() => parseTemplate(text.replace('  - id: "S09-collect-logs"\n    standing: ["SW.4"]\n    host: "target"\n    phase: "soak"', '  - id: "V09-collect-logs"\n    standing: ["SW.4"]\n    host: "target"\n    phase: "version"'), "kitchen-sink")).toThrow("a template has no version checks");
  });
});

// ── a template step with `since`: the release that gains it carries it, an earlier release's runbook stays as it ran (issue 1476) ──
describe("a template step's since", () => {
  const sdkSteps = ["S10-archive-routes", "S11-sdk-quickstart", "S12-sdk-tests"];

  test("the template's SDK steps name v0.7.0, and v0.6.2 (which predates them) still only adds", () => {
    for (const id of sdkSteps) expect(template.steps.find((s) => s.id === id)?.since).toBe("v0.7.0");
    expect(loadReleaseRunbook("v0.6.2").steps.some((s) => sdkSteps.includes(s.id))).toBe(false);
    expect(checkAddOnly(template, { ...runbook(template.steps.filter((s) => !sdkSteps.includes(s.id)), "v0.6.9"), release: "v0.6.9" })).toEqual([]);
  });

  test("v0.7.0 carries the SDK steps unmarked, ten added version checks, and every version step in its scope", () => {
    const v070 = loadReleaseRunbook("v0.7.0");
    for (const id of sdkSteps) expect(v070.steps.find((s) => s.id === id)?.added).toBeUndefined();
    const versions = v070.steps.filter((s) => s.phase === "version");
    expect(versions.length).toBe(10);
    expect(versions.every((s) => s.added === "v0.7.0")).toBe(true);
    // A scope entry names one check per PR. PR 1418 (D75) ships two: V03 is its entry, V04 is its second check (migrations 0126 and 0127).
    for (const s of versions.filter((x) => x.id !== "V04-migration-ledger")) expect(v070.scope.some((e) => e.check === s.id), s.id).toBe(true);
    expect(v070.recovery.trim()).not.toBe("");
  });

  test("red: from v0.7.0 on, a runbook without an SDK step is refused; so is one that edits it; a bad since refuses", () => {
    const without = template.steps.filter((s) => s.id !== "S11-sdk-quickstart");
    expect(checkAddOnly(template, runbook(without, "v0.7.0")).join()).toContain("template step S11-sdk-quickstart is missing");
    expect(checkAddOnly(template, runbook(without, "v0.7.1")).join()).toContain("template step S11-sdk-quickstart is missing");
    const edited = template.steps.map((s) => (s.id === "S12-sdk-tests" ? { ...s, maxMinutes: 1 } : s));
    expect(checkAddOnly(template, runbook(edited, "v0.7.0")).join()).toContain("S12-sdk-tests differs");
    const text = readFileSync(templatePath("kitchen-sink"), "utf8");
    expect(() => parseTemplate(text.replace('since: "v0.7.0"', 'since: "soon"'), "kitchen-sink")).toThrow("since is a release name");
  });

  test("a step the earlier release added under a template id it predates is still its own addition", () => {
    const early = [...template.steps.filter((s) => !sdkSteps.includes(s.id)), { ...added("S11-sdk-quickstart", "v0.6.9"), phase: "soak" as const }];
    expect(checkAddOnly(template, runbook(early, "v0.6.9"))).toEqual([]);
  });
});

// ── a release that declares a breaking migration (issue 1476; D75, spec 8.5) ──
describe("a release's breaking declaration", () => {
  const header = (compat: string) => `-- compat: ${compat}\n-- metadata_version: 1\nSELECT 1;\n`;
  const files: Record<string, string> = { "0126_a.sql": header("additive"), "0127_rm_worker_retired.sql": header("breaking") };
  const read = (n: string) => files[n]!;
  const pending = Object.keys(files);

  test("an undeclared breaking migration is still refused; the declared one passes; an additive one never needed it", () => {
    expect(rollingMigrationProblems(["0126_a.sql"], read)).toEqual([]);
    expect(rollingMigrationProblems(pending, read).join()).toContain("0127_rm_worker_retired.sql is breaking, not additive");
    expect(rollingMigrationProblems(pending, read, []).join()).toContain("names it in breaking:");
    expect(rollingMigrationProblems(pending, read, ["0127_rm_worker_retired.sql"])).toEqual([]);
    // red: naming another file does not pass this one; a declared file is honoured only if it is breaking, never to excuse an undeclared header.
    expect(rollingMigrationProblems(pending, read, ["0126_a.sql"]).join()).toContain("0127_rm_worker_retired.sql is breaking");
    files["0128_x.sql"] = "SELECT 1;\n";
    expect(rollingMigrationProblems([...pending, "0128_x.sql"], read, ["0127_rm_worker_retired.sql", "0128_x.sql"]).join()).toContain("0128_x.sql");
    delete files["0128_x.sql"];
  });

  test("the key parses on a release runbook and refuses a malformed list; a runbook without it declares nothing", () => {
    const body = readFileSync(templatePath("kitchen-sink"), "utf8");
    const steps = body.slice(body.indexOf("\nsteps:") + 1);
    const head = (extra: string) => `release: v9.9.9\nrecovery: fix forward\n${extra}${SCOPE}${steps}`;
    expect(parseReleaseRunbook(head("breaking:\n  - 0127_rm_worker_retired.sql\n"), "v9.9.9").breaking).toEqual(["0127_rm_worker_retired.sql"]);
    expect(parseReleaseRunbook(head(""), "v9.9.9").breaking).toBeUndefined();
    expect(() => parseReleaseRunbook(head("breaking: []\n"), "v9.9.9")).toThrow("breaking is a non-empty list");
    expect(() => parseReleaseRunbook(head("breaking:\n  - not a file\n"), "v9.9.9")).toThrow("breaking is a non-empty list");
  });

  test("v0.7.0 declares 0127, which is a real breaking file, and no earlier runbook declares anything; the runner exports RM_RELEASE", () => {
    const v070 = loadReleaseRunbook("v0.7.0");
    expect(v070.breaking).toEqual(["0127_rm_worker_retired.sql"]);
    const sql = readFileSync(join(repoRoot, "backend/migrations/0127_rm_worker_retired.sql"), "utf8");
    expect(sql.split("\n")[0]).toBe("-- compat: breaking");
    expect(loadReleaseRunbook("v0.6.2").breaking).toBeUndefined();
    const target = loadTarget(join(repoRoot, "scripts", "release", "targets", "stage.json"));
    const rendered = renderStep(template.steps.find((s) => s.id === "P07-baseline")!, target, templateValues(target, "a".repeat(40), "20260101T000000Z"));
    expect(rendered.remote).toContain(`RM_RELEASE=${target.release}`);
    // red: no other step gets the variable.
    const other = renderStep(template.steps.find((s) => s.id === "P08-log-baseline")!, target, templateValues(target, "a".repeat(40), "20260101T000000Z"));
    expect(other.remote).not.toContain("RM_RELEASE");
  });
});
