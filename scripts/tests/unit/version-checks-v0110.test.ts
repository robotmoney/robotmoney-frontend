// v0.11.0 version checks Q38 to Q41 (C26 to C29) (scripts/release/version-checks/v0.11.0/, tracking issue 1754): each check's
// decision with a passing case and a red control, plus the runbook's scope and added steps. The reads (the database,
// HTTP) are thin; the decisions are pure and tested here.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { apiContractProblems, EXPECTED_CONTRACT } from "../../release/version-checks/v0.11.0/api-contract.ts";
import { CONSTRAINT_0136, DROPPED_0135, INDEXES_0134, MIGRATIONS, migrationsProblems, type MigrationsRead } from "../../release/version-checks/v0.11.0/migrations.ts";
import { besideLedgerProblems, methodologyAnswerProblems } from "../../release/version-checks/v0.11.0/regime-methodology.ts";
import { mainLineAnswerProblems, mainLineLedgerProblems } from "../../release/version-checks/v0.11.0/regime-main-line.ts";
import { loadReleaseRunbook, loadTemplate } from "../../release/runbook.ts";

const repoRoot = join(import.meta.dir, "..", "..", "..");

describe("Q38-api-contract/C26-api-contract (PR 1755)", () => {
  test("the expected contract is contract/package.json's", () => {
    expect(EXPECTED_CONTRACT).toBe((JSON.parse(readFileSync(join(repoRoot, "contract/package.json"), "utf8")) as { version: string }).version);
  });
  test("passes: api 0.5.12, and the release commit when one is named", () => {
    const sha = "a".repeat(40);
    const res = { status: 200, text: JSON.stringify({ api: "0.5.12", commit: sha }) };
    expect(apiContractProblems(res, sha).problems).toEqual([]);
    expect(apiContractProblems(res, undefined).problems).toEqual([]);
  });
  test("red: v0.10.0's contract, another commit, a non-200 and a non-JSON body", () => {
    const sha = "a".repeat(40);
    expect(apiContractProblems({ status: 200, text: JSON.stringify({ api: "0.5.11", commit: sha }) }, sha).problems.join()).toContain("reports api 0.5.11");
    expect(apiContractProblems({ status: 200, text: JSON.stringify({ api: "0.5.12", commit: "b".repeat(40) }) }, sha).problems.join()).toContain("not the release commit");
    expect(apiContractProblems({ status: 503, text: "" }, sha).problems.join()).toContain("503");
    expect(apiContractProblems({ status: 200, text: "<html>" }, sha).problems.join()).toContain("not JSON");
  });
});

describe("Q39-migrations/C27-migrations (PRs 1736, 1740, 1755)", () => {
  const ok: MigrationsRead = {
    ledger: ["0133_buybacks_refresh_disabled.sql", ...MIGRATIONS],
    indexes: [...INDEXES_0134],
    kindCheck: "CHECK ((artifact_kind = ANY (ARRAY['regime_snapshots'::text, 'regime_beside_snapshots'::text, 'research_signals'::text, 'warnings'::text, 'logs'::text, 'exceptions'::text])))",
    kindCheckValidated: true,
  };
  test("the three migrations exist in backend/migrations", () => {
    const files = readdirSync(join(repoRoot, "backend/migrations"));
    for (const m of MIGRATIONS) expect(files, m).toContain(m);
  });
  test("passes: recorded, indexes in place, the CHECK widened and validated", () => {
    expect(migrationsProblems(ok)).toEqual([]);
    expect(migrationsProblems({ ...ok, ledger: MIGRATIONS.map((m) => m.replace(/\.sql$/, "")) })).toEqual([]);
  });
  test("red: an unrecorded migration, a missing index, the dropped index back, the CHECK old, gone or not valid", () => {
    expect(migrationsProblems({ ...ok, ledger: ok.ledger.filter((m) => !m.startsWith("0136")) }).join()).toContain("0136_regime_beside_snapshots");
    expect(migrationsProblems({ ...ok, indexes: INDEXES_0134.slice(1) }).join()).toContain(INDEXES_0134[0]);
    expect(migrationsProblems({ ...ok, indexes: [...INDEXES_0134, DROPPED_0135] }).join()).toContain("still exists");
    expect(migrationsProblems({ ...ok, kindCheck: ok.kindCheck!.replace("'regime_beside_snapshots'::text, ", "") }).join()).toContain("does not accept regime_beside_snapshots");
    expect(migrationsProblems({ ...ok, kindCheck: ok.kindCheck!.replace("'logs'::text, ", "") }).join()).toContain("no longer accepts logs");
    expect(migrationsProblems({ ...ok, kindCheck: null }).join()).toContain(`${CONSTRAINT_0136} does not exist`);
    expect(migrationsProblems({ ...ok, kindCheckValidated: false }).join()).toContain("NOT VALID");
  });
});

describe("Q40-regime-methodology/C28-regime-methodology (PR 1755)", () => {
  const v5 = { status: 200, text: JSON.stringify({ methodology: "v5", latest: { version: "v5", date: "2026-11-26" }, history: [] }) };
  const unknown = { status: 400, text: JSON.stringify({ error: "methodology must be one of v3, v4, v5", allowed: ["v3", "v4", "v5"] }) };
  test("passes: a succeeded v5 run froze its own kind, nothing leaked, and the parameter answers", () => {
    expect(besideLedgerProblems({ succeeded: 2, leaked: 0, besideArtifacts: 2 })).toEqual([]);
    expect(methodologyAnswerProblems(v5, unknown)).toEqual([]);
  });
  test("red: no v5 run, no beside artifact, a v5 row in the main line's kind", () => {
    expect(besideLedgerProblems({ succeeded: 0, leaked: 0, besideArtifacts: 0 }).join()).toContain("no v5 regime run has succeeded");
    expect(besideLedgerProblems({ succeeded: 1, leaked: 0, besideArtifacts: 0 }).join()).toContain("regime_beside_snapshots");
    expect(besideLedgerProblems({ succeeded: 1, leaked: 1, besideArtifacts: 1 }).join()).toContain("main line's kind");
  });
  test("red: the parameter ignored, an empty line, another stamp, an unknown value accepted or unnamed", () => {
    expect(methodologyAnswerProblems({ status: 200, text: JSON.stringify({ latest: { version: "v4" } }) }, unknown).join()).toContain('not "v5"');
    expect(methodologyAnswerProblems({ status: 200, text: JSON.stringify({ methodology: "v5", latest: null }) }, unknown).join()).toContain("no latest snapshot");
    expect(methodologyAnswerProblems({ status: 200, text: JSON.stringify({ methodology: "v5", latest: { version: "v4" } }) }, unknown).join()).toContain("stamped v4");
    expect(methodologyAnswerProblems({ status: 400, text: "{}" }, unknown).join()).toContain("answered 400");
    expect(methodologyAnswerProblems(v5, { status: 200, text: "{}" }).join()).toContain("not 400");
    expect(methodologyAnswerProblems(v5, { status: 400, text: JSON.stringify({ allowed: ["v3", "v4"] }) }).join()).toContain("does not name v5");
  });
});

describe("Q41-regime-main-line/C29-regime-main-line (PR 1755, D96)", () => {
  const latest = { version: "v4", date: "2026-11-26", composite: 0.5, macroIndex: 0.4, onchainIndex: 0.5, factorIndex: 0.6 };
  test("passes: the newest succeeded main-line run is v4 and the default answer is the v4 line, unchanged", () => {
    expect(mainLineLedgerProblems({ newestLabel: "v4" })).toEqual([]);
    expect(mainLineAnswerProblems({ status: 200, text: JSON.stringify({ latest, history: [], staleness: {}, source: "ledger" }) })).toEqual([]);
  });
  test("red: no main-line run, a v5 or v3 main line, a methodology field, a v5 latest, a composite off the mean", () => {
    expect(mainLineLedgerProblems({ newestLabel: null }).join()).toContain("no succeeded main-line");
    expect(mainLineLedgerProblems({ newestLabel: "v3" }).join()).toContain("stamped v3");
    expect(mainLineAnswerProblems({ status: 200, text: JSON.stringify({ latest, methodology: "v4" }) }).join()).toContain("carries a methodology field");
    expect(mainLineAnswerProblems({ status: 200, text: JSON.stringify({ latest: { ...latest, version: "v5" } }) }).join()).toContain("not v4");
    expect(mainLineAnswerProblems({ status: 200, text: JSON.stringify({ latest: { ...latest, composite: 0.7 } }) }).join()).toContain("1/n mean");
    expect(mainLineAnswerProblems({ status: 502, text: "" }).join()).toContain("502");
    expect(mainLineAnswerProblems({ status: 200, text: "<html>" }).join()).toContain("not JSON");
  });
});

describe("the v0.11.0 runbook's scope and added steps (issue 1754)", () => {
  const rb = loadReleaseRunbook("v0.11.0");
  test("the scope names every migration the range adds, each with a check", () => {
    const at0100 = 133; // the newest migration v0.10.0 shipped: 0133_buybacks_refresh_disabled
    const at0110 = 136; // the newest migration v0.11.0 shipped: 0136_regime_beside_snapshots. Bounded so a later migration on main does not turn this release's test red.
    const pending = readdirSync(join(repoRoot, "backend/migrations")).filter((f) => /^\d{4}_.*\.sql$/.test(f) && Number(f.slice(0, 4)) > at0100 && Number(f.slice(0, 4)) <= at0110).map((f) => f.replace(/\.sql$/, "")).sort();
    expect(pending).toEqual(["0134_read_path_indexes", "0135_drop_vintage_members_vintage_idx", "0136_regime_beside_snapshots"]);
    for (const m of pending) expect(rb.scope.some((e) => e.what.includes(m) && e.check !== undefined), m).toBe(true);
  });
  test("every scope check names a step of the runbook, and a none states its reason", () => {
    const ids = new Set(rb.steps.map((s) => s.id));
    for (const e of rb.scope) {
      if (e.check !== undefined) expect(ids.has(e.check), `${e.pr} ${e.check}`).toBe(true);
      else expect((e.none ?? "").length, String(e.pr)).toBeGreaterThan(5);
    }
  });
  test("every added step carries added: v0.11.0, every added step after READY declares after, and each version check has its file", () => {
    const template = new Set(loadTemplate().steps.map((s) => s.id));
    const added = rb.steps.filter((s) => !template.has(s.id));
    expect(added.map((s) => s.id)).toEqual([
      "Q16a-csvb-install", "Q38-api-contract", "Q39-migrations", "Q40-regime-methodology", "Q41-regime-main-line",
      "C03a-csvb-install", "C26-api-contract", "C27-migrations", "C28-regime-methodology", "C29-regime-main-line",
    ]);
    for (const s of added) expect(s.added, s.id).toBe("v0.11.0");
    const ready = { qa: rb.steps.findIndex((s) => s.id === "Q23-ready"), cutover: rb.steps.findIndex((s) => s.id === "C11-ready") };
    for (const s of added) {
      const i = rb.steps.indexOf(s);
      if (i > ready[s.phase as "qa" | "cutover"]) expect(s.after, s.id).toBeDefined();
    }
    for (const s of added.filter((x) => x.cmds[0]?.includes("scripts/release/version-check.ts"))) {
      const name = s.cmds[0]![s.cmds[0]!.indexOf("--check") + 1]!;
      expect(readdirSync(join(repoRoot, "scripts/release/version-checks/v0.11.0")), s.id).toContain(`${name}.ts`);
    }
  });
  test("the notes record the rolling-window rule for v5", () => {
    expect(rb.notes ?? "").toContain("No v5 run may start before the new image boots");
  });
});
