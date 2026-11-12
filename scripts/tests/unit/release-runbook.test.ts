// scripts/tests/unit/release-runbook.test.ts — the release runbooks as YAML
// (scripts/release/runbook.ts, D70): a template is the general runbook, and a
// release's runbook is a copy of one template that only adds steps.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_TEMPLATE, checkAddOnly, loadReleaseRunbook, loadTemplate, parseReleaseRunbook, parseTemplate, releaseBefore, releaseRunbookNames,
  releaseRunbookPath, templatePath, TEMPLATE_NAMES, type ReleaseRunbook, type RunbookStep,
  scopeProblems, parseStep, twinProblems,
} from "../../release/runbook.ts";
import { prsOf, scopeCoverage } from "../../release/scope.ts";
import { RELEASE_STEPS, renderStep, stepListHash, templateValues } from "../../release/steps.ts";
import { rollingMigrationProblems } from "../../release/baseline.ts";
import { loadTarget } from "../../release/target.ts";

const repoRoot = join(import.meta.dir, "..", "..", "..");
const template = loadTemplate();
/** The template's steps a release binds: those with no `since`, or a `since` at or before it. */
const boundBy = (release: string): RunbookStep[] => template.steps.filter((s) => s.since === undefined || !releaseBefore(release, s.since));
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
    expect(() => parseReleaseRunbook(`release: v9.9.9\nrecovery: fix forward\ntemplate: website-only\n${SCOPE}${steps}`, "v9.9.9")).toThrow("template website-only is not one of kitchen-sink, web");
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

  // Each release runbook is held to the template it names, not to kitchen-sink.
  for (const release of releaseRunbookNames()) {
    test(`${release} names a known template and only adds to that one`, () => {
      const rb = loadReleaseRunbook(release);
      expect(TEMPLATE_NAMES).toContain(rb.template);
      expect(checkAddOnly(loadTemplate(rb.template), rb)).toEqual([]);
    });
  }
});

// ── the web template (owner, 2026-11-11: "The web release is a variation of the kitchen sink release") ──
describe("the web template", () => {
  const web = loadTemplate("web");
  /** The identity check reads the site only (the backend is not restarted). */
  const SITE_ONLY = ["Q26-verify-version", "C14-verify-version"];
  /** The log verdict grades since the run's window start: a web-only release has no READY (issue 1613). */
  const SINCE_WINDOW = ["Q28-log-verdict", "C16-log-verdict"];
  const KEPT = [
    "Q01-lockfile", "Q02-dump", "Q03-stage-up", "Q04-role-passwords", "Q05-scope", "Q06-checkout", "Q07-host-identity", "Q08-install",
    "Q13-log-baseline", "Q17-probe-start", "Q24-site", "Q25-probe-grade", "Q26-verify-version", "Q27-verify-product", "Q28-log-verdict",
    "P01-checkout", "P02-host-identity", "P03-install", "P08-log-baseline",
    "C04-probe-start", "C06-version-tag", "C12-site", "C13-probe-grade", "C14-verify-version", "C15-verify-product", "C16-log-verdict",
  ];

  test("is an ordered subset of kitchen-sink, every step identical but the documented adjustments", () => {
    expect(web.steps.map((s) => s.id)).toEqual(KEPT);
    const at = web.steps.map((s) => template.steps.findIndex((t) => t.id === s.id));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    for (const s of web.steps) {
      const k = template.steps.find((t) => t.id === s.id)!;
      if (!SITE_ONLY.includes(s.id) && !SINCE_WINDOW.includes(s.id)) {
        expect(s).toEqual(k);
        continue;
      }
      const { cmds, description, ...rest } = s;
      const { cmds: kCmds, description: _kDescription, ...kRest } = k;
      expect(rest).toEqual(kRest);
      if (SITE_ONLY.includes(s.id)) {
        // the same step but for --site-only before --receipt-dir, and a description that says so.
        const flag = kCmds[0]!.indexOf("--receipt-dir");
        expect(cmds).toEqual([[...kCmds[0]!.slice(0, flag), "--site-only", ...kCmds[0]!.slice(flag)]]);
        expect(description).toContain("site only");
      } else {
        // the same step but for --since {windowStartIso} before --report (issue 1613).
        const flag = kCmds[0]!.indexOf("--report");
        expect(cmds).toEqual([[...kCmds[0]!.slice(0, flag), "--since", "{windowStartIso}", ...kCmds[0]!.slice(flag)]]);
        expect(description).toContain("window start");
      }
    }
  });

  test("the log verdicts pass --since the window start; kitchen-sink's carry none (they grade since their own READY)", () => {
    for (const id of SINCE_WINDOW) {
      const cmd = web.steps.find((s) => s.id === id)!.cmds[0]!;
      expect(cmd[cmd.indexOf("--since") + 1]).toBe("{windowStartIso}");
      expect(template.steps.find((s) => s.id === id)!.cmds[0]).not.toContain("--since");
    }
  });

  test("carries no database or backend step: no migrate, boot, READY, backup, soak or irreversible step", () => {
    expect(web.steps.some((s) => /migrate|boot|ready|backup|restore|soak|env-rewrite|tokens|capture|state-baseline|archive|sdk/.test(s.id))).toBe(false);
    expect(web.steps.some((s) => s.irreversible || s.breakingOnly === true || s.after !== undefined || s.notBefore !== undefined)).toBe(false);
  });
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
});

// ── a template step with `since`: the release that gains it carries it, an earlier release's runbook stays as it ran (issue 1476) ──
describe("a template step's since", () => {
  // The breaking-cutover steps (issue 1484) are since v0.7.0 as well, so an earlier release does not carry them.
  const breakingSteps = ["Q18a-maintenance-on", "Q18b-smoke-down", "Q18c-migrate-breaking", "Q22a-full-boot", "Q24a-maintenance-off", "C05a-maintenance-on", "C05b-smoke-down", "C05c-migrate-breaking", "C10a-full-boot", "C12a-maintenance-off"];
  const sdkSteps = ["Q35-archive-routes", "Q36-sdk-quickstart", "Q37-sdk-tests", "C23-archive-routes", "C24-sdk-quickstart", "C25-sdk-tests"];
  // The analytics load check (issue 1514) is since v0.7.1, so no earlier release carries it.
  const laterSteps = template.steps.filter((s) => s.since !== undefined && releaseBefore("v0.7.0", s.since)).map((s) => s.id);

  test("the template's SDK steps name v0.7.0, and v0.6.2 (which predates them) still only adds", () => {
    for (const id of [...sdkSteps, ...breakingSteps]) expect(template.steps.find((s) => s.id === id)?.since).toBe("v0.7.0");
    expect(loadReleaseRunbook("v0.6.2").steps.some((s) => sdkSteps.includes(s.id))).toBe(false);
    expect(checkAddOnly(template, { ...runbook(template.steps.filter((s) => !sdkSteps.includes(s.id) && !breakingSteps.includes(s.id) && !laterSteps.includes(s.id)), "v0.6.9"), release: "v0.6.9" })).toEqual([]);
  });

  test("v0.7.0 carries the SDK steps unmarked, eleven added version checks, and every version step in its scope", () => {
    const v070 = loadReleaseRunbook("v0.7.0");
    for (const id of sdkSteps) expect(v070.steps.find((s) => s.id === id)?.added).toBeUndefined();
    const versions = v070.steps.filter((s) => s.added === "v0.7.0");
    expect(versions.length).toBe(22);
    expect(versions.map((s) => s.id.slice(0, 3))).toEqual([..."Q38 Q39 Q40 Q41 Q42 Q43 Q44 Q45 Q46 Q47 Q48 C26 C27 C28 C29 C30 C31 C32 C33 C34 C35 C36".split(" ")]);
    // Every version check is read-only against the target, so each QA step has a production twin of the same name.
    expect(versions.some((s) => (s as { stageOnly?: boolean }).stageOnly === true)).toBe(false);
    expect(versions.filter((s) => s.phase === "qa").map((s) => s.id.slice(4))).toEqual(versions.filter((s) => s.phase === "cutover").map((s) => s.id.slice(4)));
    // A scope entry names one check per PR. PR 1418 (D75) ships two: Q40 is its entry, Q41 is its second check (migrations 0126 and 0127).
    for (const s of versions.filter((x) => x.phase === "qa" && x.id !== "Q41-migration-ledger")) expect(v070.scope.some((e) => e.check === s.id), s.id).toBe(true);
    expect(v070.recovery.trim()).not.toBe("");
  });

  test("red: from v0.7.0 on, a runbook without an SDK step is refused; so is one that edits it; a bad since refuses", () => {
    const without = template.steps.filter((s) => s.id !== "Q36-sdk-quickstart");
    expect(checkAddOnly(template, runbook(without, "v0.7.0")).join()).toContain("template step Q36-sdk-quickstart is missing");
    expect(checkAddOnly(template, runbook(without, "v0.7.1")).join()).toContain("template step Q36-sdk-quickstart is missing");
    const edited = template.steps.map((s) => (s.id === "Q37-sdk-tests" ? { ...s, maxMinutes: 1 } : s));
    expect(checkAddOnly(template, runbook(edited, "v0.7.0")).join()).toContain("Q37-sdk-tests differs");
    const text = readFileSync(templatePath("kitchen-sink"), "utf8");
    expect(() => parseTemplate(text.replace('since: "v0.7.0"', 'since: "soon"'), "kitchen-sink")).toThrow("since is a release name");
  });

  test("a step the earlier release added under a template id it predates is still its own addition", () => {
    const early = [...template.steps.filter((s) => !sdkSteps.includes(s.id) && !breakingSteps.includes(s.id) && !laterSteps.includes(s.id)), { ...added("Q36-sdk-quickstart", "v0.6.9"), phase: "qa" as const }];
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
    // The baseline step reads it on stage and on production, so the QA run proves the declaration the cutover relies on.
    for (const id of ["Q12-state-baseline", "P07-state-baseline"]) {
      const rendered = renderStep(template.steps.find((s) => s.id === id)!, target, templateValues(target, "a".repeat(40), "20260101T000000Z"));
      expect(rendered.remote, id).toContain(`RM_RELEASE=${target.release}`);
    }
    // red: no other step gets the variable.
    const other = renderStep(template.steps.find((s) => s.id === "P08-log-baseline")!, target, templateValues(target, "a".repeat(40), "20260101T000000Z"));
    expect(other.remote).not.toContain("RM_RELEASE");
  });
});

// ── the analytics load check (issue 1514): a stage-only Q step with no production twin ──
describe("the template's analytics load step", () => {
  const LOAD = "Q34a-analytics-load";
  const step = template.steps.find((s) => s.id === LOAD)!;
  const text = readFileSync(templatePath("kitchen-sink"), "utf8");
  const block = text.slice(text.indexOf(`  - id: "${LOAD}"`), text.indexOf('  - id: "Q35-archive-routes"'));

  test("parses as a stage-only QA step on the target, after the soak's log collection, running the load check", () => {
    expect(step).toBeDefined();
    expect(step.phase).toBe("qa");
    expect(step.onlyFor).toBe("stage");
    expect(step.host).toBe("target");
    expect((step as { stageOnly?: boolean }).stageOnly).toBe(true);
    expect(step.since).toBe("v0.7.1");
    expect(step.cmds[0]!.slice(0, 2)).toEqual(["bun", "scripts/release/analytics-load-check.ts"]);
    expect(step.cmds[0]).toContain("--instance");
    // It starts no analytics run: the check only reads the api's log and /health.
    expect(step.cmds.flat().some((a) => /trigger|run-now|--run\b/.test(a))).toBe(false);
    expect(ids.indexOf(LOAD)).toBe(ids.indexOf("Q34-collect-logs") + 1);
    expect(step.receipts.map((r) => r.pattern)).toEqual(["analytics-load-check.*"]);
  });

  test("the runner accepts it without a C twin; a C twin, or the step without its stageOnly mark, refuses", () => {
    expect(template.steps.some((s) => s.phase !== "qa" && s.id.endsWith("-analytics-load"))).toBe(false);
    expect(() => parseTemplate(text, "kitchen-sink")).not.toThrow();
    expect(() => parseTemplate(text.replace(block, block.replace("    stageOnly: true\n", "")), "kitchen-sink")).toThrow(`${LOAD} has no production twin named analytics-load`);
    const twin = block.replace(`"${LOAD}"`, '"C22a-analytics-load"').replace('phase: "qa"', 'phase: "cutover"').replace('onlyFor: "stage"', 'onlyFor: "prod"').replace("    stageOnly: true\n", "");
    const withTwin = text.replace('  - id: "C23-archive-routes"', `${twin}  - id: "C23-archive-routes"`);
    expect(() => parseTemplate(withTwin, "kitchen-sink")).toThrow(`${LOAD} is stage-only but production has a step named analytics-load`);
  });

  test("a release from v0.7.1 on carries it, and v0.7.0's runbook, which predates it, still only adds", () => {
    expect(loadReleaseRunbook("v0.7.0").steps.some((s) => s.id === LOAD)).toBe(false);
    const without = template.steps.filter((s) => s.id !== LOAD);
    expect(checkAddOnly(template, runbook(without, "v0.7.1")).join()).toContain(`template step ${LOAD} is missing`);
    expect(checkAddOnly(template, runbook(boundBy("v0.7.1"), "v0.7.1"))).toEqual([]);
  });
});

// ── after: a step that waits only for the steps it names (issue 1557) ──
describe("a step's after list", () => {
  const text = readFileSync(templatePath("kitchen-sink"), "utf8");
  /** The template text with one more line in the step `id`, right after its id line. */
  const withLine = (src: string, id: string, line: string) => {
    const head = `  - id: "${id}"\n`;
    expect(src).toContain(head);
    return src.replace(head, `${head}${line}\n`);
  };
  /** The template text with step `id`'s after list replaced. */
  const setAfter = (src: string, id: string, after: string) => src.replace(new RegExp(`(  - id: "${id}"[\\s\\S]*?    after: )\\[[^\\]]*\\]`), `$1${after}`);
  const SDK = ["Q35-archive-routes", "Q36-sdk-quickstart", "Q37-sdk-tests", "C23-archive-routes", "C24-sdk-quickstart", "C25-sdk-tests"];

  test("parseStep accepts after as a list of step ids, and refuses anything else", () => {
    const raw = { ...template.steps.find((s) => s.id === "Q36-sdk-quickstart")! };
    const ok = parseStep({ ...raw, after: ["Q23-ready", "Q35-archive-routes"] }, "t");
    expect("step" in ok && ok.step.after).toEqual(["Q23-ready", "Q35-archive-routes"]);
    for (const bad of [[], "Q23-ready", [1], [""]]) {
      const r = parseStep({ ...raw, after: bad }, "t");
      expect("errors" in r && r.errors.join(), JSON.stringify(bad)).toContain("t Q36-sdk-quickstart: after is a non-empty list of earlier step ids");
    }
    const irr = parseStep({ ...template.steps.find((s) => s.id === "Q18-migrate")!, after: ["Q17-probe-start"] }, "t");
    expect("errors" in irr && irr.errors.join()).toContain("t Q18-migrate: an irreversible step carries no after");
    const since = parseStep({ ...raw, after: undefined, afterSince: "v0.7.3" }, "t");
    expect("errors" in since && since.errors.join()).toContain("afterSince goes with after");
  });

  test("the template's read-only SDK checks wait only for READY, from release v0.7.3 on", () => {
    for (const id of SDK) {
      const s = template.steps.find((x) => x.id === id)!;
      expect(s.after, id).toEqual([id.startsWith("Q") ? "Q23-ready" : "C11-ready"]);
      expect(s.afterSince, id).toBe("v0.7.3");
      expect(s.irreversible, id).toBe(false);
    }
    // Every other template step waits for every earlier one, as before.
    expect(template.steps.filter((s) => s.after !== undefined).map((s) => s.id)).toEqual(SDK);
  });

  test("red: an after naming an unknown id, a later id, the step itself, or another phase's step refuses, naming the step", () => {
    const at = "template kitchen-sink";
    expect(() => parseTemplate(setAfter(text, "Q36-sdk-quickstart", '["Q99-nope"]'), "kitchen-sink")).toThrow(`${at} Q36-sdk-quickstart: after names Q99-nope, which is no step of this list`);
    expect(() => parseTemplate(setAfter(text, "Q35-archive-routes", '["Q36-sdk-quickstart"]'), "kitchen-sink")).toThrow(`${at} Q35-archive-routes: after names Q36-sdk-quickstart, which comes later`);
    expect(() => parseTemplate(setAfter(text, "Q36-sdk-quickstart", '["Q36-sdk-quickstart"]'), "kitchen-sink")).toThrow(`${at} Q36-sdk-quickstart: after names the step itself`);
    expect(() => parseTemplate(setAfter(text, "C24-sdk-quickstart", '["Q23-ready"]'), "kitchen-sink")).toThrow(`${at} C24-sdk-quickstart: after names Q23-ready, a qa step; it names steps of its own phase (cutover)`);
    expect(() => parseTemplate(withLine(text, "Q18-migrate", '    after: ["Q17-probe-start"]'), "kitchen-sink")).toThrow(`${at} Q18-migrate: an irreversible step carries no after`);
  });

  test("red: an after list that lets a step start before an earlier irreversible step ends refuses, naming both", () => {
    // Q24-site after Q17-probe-start could start while Q18-migrate (irreversible) runs.
    expect(() => parseTemplate(withLine(text, "Q24-site", '    after: ["Q17-probe-start"]'), "kitchen-sink"))
      .toThrow("template kitchen-sink Q24-site: its after list lets it start before the irreversible step Q18-migrate, Q18c-migrate-breaking ends");
    // Naming a step past the irreversible ones is safe: that step waited for them.
    expect(() => parseTemplate(setAfter(setAfter(text, "Q36-sdk-quickstart", '["Q35-archive-routes"]'), "C24-sdk-quickstart", '["C23-archive-routes"]'), "kitchen-sink")).not.toThrow();
    // A notBefore anchor the after list does not wait for refuses too.
    expect(() => parseTemplate(setAfter(text, "Q36-sdk-quickstart", '["Q22-rolling-boot"]'), "kitchen-sink")).toThrow("Q36-sdk-quickstart: its notBefore counts from Q23-ready, which its after list does not wait for");
  });

  test("twinProblems passes twins whose after lists match once the phase prefixes are stripped, and refuses when they differ", () => {
    expect(twinProblems(template.steps, "t")).toEqual([]);
    const differ = template.steps.map((s) => (s.id === "Q36-sdk-quickstart" ? { ...s, after: ["Q35-archive-routes"] } : s));
    expect(twinProblems(differ, "t")).toEqual(["t: Q36-sdk-quickstart and C24-sdk-quickstart differ; a QA step and its production twin run the same commands"]);
    const both = differ.map((s) => (s.id === "C24-sdk-quickstart" ? { ...s, after: ["C23-archive-routes"] } : s));
    expect(twinProblems(both, "t")).toEqual([]);
    const dropped = template.steps.map((s) => (s.id === "C25-sdk-tests" ? { ...s, after: undefined } : s));
    expect(twinProblems(dropped, "t").join()).toContain("Q37-sdk-tests and C25-sdk-tests differ");
  });

  test("add-only under afterSince: a release before v0.7.3 keeps the steps as it ran, a later one carries the after lists", () => {
    const noAfter = boundBy("v0.7.3").map((s) => (s.after === undefined ? s : (({ after: _a, ...rest }) => rest)(s) as RunbookStep));
    for (const release of ["v0.6.2", "v0.7.0", "v0.7.1", "v0.7.2"]) {
      const kept = noAfter.filter((s) => s.since === undefined || !releaseBefore(release, s.since));
      expect(checkAddOnly(template, runbook(kept, release)), release).toEqual([]);
    }
    // A release before afterSince may also adopt them early.
    expect(checkAddOnly(template, runbook(boundBy("v0.7.2"), "v0.7.2"))).toEqual([]);
    // From v0.7.3 on, a copy without them edits the template.
    expect(checkAddOnly(template, runbook(noAfter, "v0.7.3")).join()).toContain("Q35-archive-routes differs from the template's step");
    expect(checkAddOnly(template, runbook(boundBy("v0.7.3"), "v0.7.3"))).toEqual([]);
    // The committed runbooks of releases that ran carry no after and still load.
    for (const release of releaseRunbookNames().filter((r) => releaseBefore(r, "v0.7.3"))) {
      const rb = loadReleaseRunbook(release);
      expect(rb.steps.filter((s) => s.after !== undefined).map((s) => s.id), release).toEqual([]);
    }
  });

  test("stepListHash: a list with no after hashes as before the key existed (pinned); adding after changes it", () => {
    // Pinned before issue 1557: the v0.6.2 and v0.7.0 runbooks, which declare no after.
    expect(stepListHash(loadReleaseRunbook("v0.6.2").steps)).toBe("063950472adc89cbd00b2a359a419baecc8f9eaad54496e312c2fd5f81b11925");
    expect(stepListHash(loadReleaseRunbook("v0.7.0").steps)).toBe("1728492c5abbb19728e64bddbb22e7cd791ac99888f4c9f1454a0f2d1807234f");
    // The template without its after lists hashes as the template did before
    // them (and before the v0.7.4 steps of issue 1581, which bind later releases only).
    const noAfter = boundBy("v0.7.3").map((s) => (s.after === undefined ? s : (({ after: _a, afterSince: _s, ...rest }) => rest)(s) as RunbookStep));
    expect(stepListHash(noAfter)).toBe("d57de38d4dd3b30c97b76870fb60e05d4eb30a27d30bdda9a1f19d2703e079c3");
    // red: one after changes it, and afterSince alone never does.
    const v070 = loadReleaseRunbook("v0.7.0").steps;
    const one = v070.map((s) => (s.id === "Q37-sdk-tests" ? { ...s, after: ["Q23-ready"] } : s));
    expect(stepListHash(one)).not.toBe(stepListHash(v070));
    expect(stepListHash(template.steps)).not.toBe(stepListHash(noAfter));
    expect(stepListHash(v070.map((s) => (s.id === "Q37-sdk-tests" ? { ...s, afterSince: "v9.9.9" } : s)))).toBe(stepListHash(v070));
  });
});

// Issue 1581: query statistics after every deploy, and the jobs-table plans on
// production's dump, from release v0.7.4 on.
describe("the template's database statistics and jobs-plan steps (issue 1581)", () => {
  const ids = ["Q37a-db-stats", "Q37b-jobs-plans", "C25a-db-stats"];

  test("they bind v0.7.4 on, and an earlier release keeps its runbook as it ran", () => {
    for (const id of ids) expect(template.steps.find((s) => s.id === id)?.since, id).toBe("v0.7.4");
    expect(boundBy("v0.7.3").some((s) => ids.includes(s.id))).toBe(false);
    expect(checkAddOnly(template, runbook(boundBy("v0.7.3"), "v0.7.3"))).toEqual([]);
    // A v0.7.4 runbook without them drops template steps; with them it only adds.
    expect(checkAddOnly(template, runbook(boundBy("v0.7.3"), "v0.7.4")).join()).toContain("template step Q37a-db-stats is missing");
    expect(checkAddOnly(template, runbook(boundBy("v0.7.4"), "v0.7.4"))).toEqual([]);
  });

  test("the postflight runs the stats check on stage and on production alike; the plan check is stage only", () => {
    const qa = template.steps.find((s) => s.id === "Q37a-db-stats")!;
    const prod = template.steps.find((s) => s.id === "C25a-db-stats")!;
    expect(qa.cmds).toEqual(prod.cmds);
    expect(qa.cmds[0]!.slice(0, 2)).toEqual(["bun", "scripts/release/db-stats-check.ts"]);
    expect([qa.onlyFor, prod.onlyFor, qa.expectExit, prod.expectExit]).toEqual(["stage", "prod", 0, 0]);
    const plans = template.steps.find((s) => s.id === "Q37b-jobs-plans")! as RunbookStep & { stageOnly?: boolean };
    expect(plans.stageOnly).toBe(true);
    expect(plans.cmds[0]!.slice(0, 2)).toEqual(["bun", "scripts/release/jobs-query-plans.ts"]);
    expect(twinProblems(template.steps, "t")).toEqual([]);
  });
});
