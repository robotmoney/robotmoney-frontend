// v0.10.0 version checks Q38 to Q43 (C26 to C31) (scripts/release/version-checks/v0.10.0/, tracking issue 1693): each check's
// decision with a passing case and a red control. The reads (docker, the database, HTTP) are thin; the decisions are pure and tested here.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { apiContractProblems, EXPECTED_CONTRACT } from "../../release/version-checks/v0.10.0/api-contract.ts";
import { envMap } from "../../release/version-checks/v0.10.0/_flow.ts";
import { flowProblems, type FlowRead } from "../../release/version-checks/v0.10.0/flow-index.ts";
import { buybacksProblems, MIGRATION as BUYBACKS_MIGRATION } from "../../release/version-checks/v0.10.0/buybacks-disabled.ts";
import { bucketOf, cutsOf, labelProblems, ledgerProblems, readLedger } from "../../release/version-checks/v0.10.0/regime-v5.ts";
import { FILES, pageProblems } from "../../release/version-checks/v0.10.0/regime-page.ts";
import { baa10yProblems, compositeInputProblems, legProblems } from "../../release/version-checks/v0.10.0/source-data.ts";
import { loadReleaseRunbook } from "../../release/runbook.ts";
import { registryRatioLegs } from "../../../packages/analyst-sdk/src/extract/sources.ts";

const repoRoot = join(import.meta.dir, "..", "..", "..");

describe("Q38-api-contract/C26-api-contract (PR 1658)", () => {
  test("the expected contract is the one contract/package.json carries", () => {
    expect((JSON.parse(readFileSync(join(repoRoot, "contract", "package.json"), "utf8")) as { version: string }).version).toBe(EXPECTED_CONTRACT);
    expect(EXPECTED_CONTRACT).toBe("0.5.11");
  });
  test("passes: api 0.5.11, and the release commit when one is named", () => {
    const sha = "a".repeat(40);
    const res = { status: 200, text: JSON.stringify({ api: "0.5.11", commit: sha }) };
    expect(apiContractProblems(res, sha).problems).toEqual([]);
    expect(apiContractProblems(res, undefined).problems).toEqual([]);
  });
  test("red: the previous contract, another commit, a non-200 and a non-JSON body", () => {
    const sha = "a".repeat(40);
    expect(apiContractProblems({ status: 200, text: JSON.stringify({ api: "0.5.10", commit: sha }) }, sha).problems.join()).toContain("reports api 0.5.10");
    expect(apiContractProblems({ status: 200, text: JSON.stringify({ api: "0.5.11", commit: "b".repeat(40) }) }, sha).problems.join()).toContain("not the release commit");
    expect(apiContractProblems({ status: 503, text: "" }, sha).problems.join()).toContain("503");
    expect(apiContractProblems({ status: 200, text: "<html>" }, sha).problems.join()).toContain("not JSON");
  });
});

describe("Q39-flow-index/C27-flow-index (PR 1658, migration 0132)", () => {
  const idle: FlowRead = {
    ledger: ["0131_x.sql", "0132_flow_index.sql"],
    tables: ["flow_index_deployment", "flow_index_blocks", "flow_index_logs"],
    configured: false,
    enabledSchedules: 0,
    jobsByStatus: {},
    blocks: 0,
    logs: 0,
    health: { status: 200, state: "idle", reason: "flow index is not configured" },
    vaultStatus: 404,
  };
  test("envMap reads KEY=value lines and keeps an empty value empty", () => {
    const m = envMap(["PATH=/bin", "FLOW_FUND_ADDRESS=", "A=b=c", ""]);
    expect(m.get("FLOW_FUND_ADDRESS")).toBe("");
    expect(m.get("A")).toBe("b=c");
  });
  test("passes: the lane is idle where the keys are unset", () => {
    expect(flowProblems(idle)).toEqual([]);
  });
  test("passes: a configured lane that has indexed and is healthy", () => {
    expect(flowProblems({ ...idle, configured: true, enabledSchedules: 1, jobsByStatus: { succeeded: 9 }, blocks: 40, logs: 3, health: { status: 200, state: "ok", reason: null } })).toEqual([]);
  });
  test("red: the migration or a table is missing", () => {
    expect(flowProblems({ ...idle, ledger: [] }).join()).toContain("0132_flow_index.sql");
    expect(flowProblems({ ...idle, tables: ["flow_index_blocks"] }).join()).toContain("flow_index_deployment does not exist");
  });
  test("red: an unconfigured lane that is enabled, has jobs, holds rows or answers wrongly", () => {
    expect(flowProblems({ ...idle, enabledSchedules: 1 }).join()).toContain("enabled with the FLOW keys unset");
    expect(flowProblems({ ...idle, jobsByStatus: { succeeded: 1 } }).join()).toContain("should be idle");
    expect(flowProblems({ ...idle, blocks: 2 }).join()).toContain("holds 2 block(s)");
    expect(flowProblems({ ...idle, health: { status: 500, state: null, reason: null } }).join()).toContain("not 200");
    expect(flowProblems({ ...idle, health: { status: 503, state: "unavailable", reason: null } }).join()).toContain("not 200");
    expect(flowProblems({ ...idle, health: { status: 200, state: "ok", reason: null } }).join()).toContain("not 200");
    expect(flowProblems({ ...idle, vaultStatus: 503 }).join()).toContain("flow vault answered 503");
  });
  test("red: an erroring lane, in either configuration", () => {
    expect(flowProblems({ ...idle, jobsByStatus: { failed: 2 } }).join()).toContain("erroring");
    expect(flowProblems({ ...idle, configured: true, enabledSchedules: 1, jobsByStatus: { dead: 1 }, health: { status: 200, state: "ok", reason: null } }).join()).toContain("erroring");
    expect(flowProblems({ ...idle, configured: true, health: { status: 502, state: null, reason: null } }).join()).toContain("only 200 or 503");
  });
  test("red: an unreadable api container is a problem, not a pass", () => {
    expect(flowProblems({ ...idle, configured: null }).join()).toContain("environment could not be read");
  });
  test("the migration file is the one the check names, and it is additive", () => {
    expect(readFileSync(join(repoRoot, "backend", "migrations", "0132_flow_index.sql"), "utf8")).toContain("-- compat: additive");
  });
});

describe("Q40-buybacks-disabled/C28-buybacks-disabled (PR 1686, migration 0133)", () => {
  const ok = { ledger: [BUYBACKS_MIGRATION], enabledSchedules: 0, liveJobs: 0 };
  test("passes: migrated, no schedule enabled, no live job", () => {
    expect(buybacksProblems(ok)).toEqual([]);
  });
  test("red: not migrated, a schedule enabled, a job live", () => {
    expect(buybacksProblems({ ...ok, ledger: [] }).join()).toContain(BUYBACKS_MIGRATION);
    expect(buybacksProblems({ ...ok, enabledSchedules: 1 }).join()).toContain("still enabled");
    expect(buybacksProblems({ ...ok, liveJobs: 3 }).join()).toContain("pending or running");
  });
  test("the migration file exists under the name the check reads", () => {
    expect(readFileSync(join(repoRoot, "backend", "migrations", BUYBACKS_MIGRATION), "utf8")).toContain("buybacks.refresh");
  });
});

describe("Q41-regime-v5/C29-regime-v5 (PR 1665, D86)", () => {
  const p = (date: string, composite: number | null, regime: string | null) => ({ date, composite, regime });
  const day = (n: number) => new Date(Date.UTC(2026, 10, 1 + n)).toISOString().slice(0, 10);
  const run = (values: number[], regimes: string[]) => values.map((v, i) => p(day(i), v, regimes[i]!));
  test("the buckets follow the cuts, and the snapshot's own cuts win when plausible", () => {
    expect(bucketOf(0.2)).toBe("risk_off");
    expect(bucketOf(0.5)).toBe("neutral");
    expect(bucketOf(0.8)).toBe("risk_on");
    expect(cutsOf({ risk_off: 0.3, risk_on: 0.7 })).toEqual({ riskOff: 0.3, riskOn: 0.7 });
    expect(cutsOf({ risk_off: 0.9, risk_on: 0.1 })).toEqual({ riskOff: 0.33, riskOn: 0.67 });
    expect(cutsOf(undefined)).toEqual({ riskOff: 0.33, riskOn: 0.67 });
  });
  test("passes: from the fifth day in a bucket the label is the bucket; before it the old label may hold", () => {
    const h = run([0.5, 0.5, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8], ["neutral", "neutral", "neutral", "neutral", "neutral", "neutral", "risk_on", "risk_on"]);
    // 0.8 held on days 2..7: day index 6 is the fifth 0.8 day.
    const r = labelProblems(h, day(0));
    expect(r.problems).toEqual([]);
    expect(r.graded).toBe(2);
  });
  test("red: a label cut on a rank disagrees with the composite's bucket on a confirmed day", () => {
    const h = run([0.8, 0.8, 0.8, 0.8, 0.8, 0.8], ["risk_on", "risk_on", "risk_on", "risk_on", "neutral", "neutral"]);
    const r = labelProblems(h, day(0));
    expect(r.problems.join()).toContain("the label is neutral");
  });
  test("days before the first v5 run are frozen and not graded", () => {
    const h = run([0.8, 0.8, 0.8, 0.8, 0.8, 0.8], ["neutral", "neutral", "neutral", "neutral", "neutral", "neutral"]);
    expect(labelProblems(h, day(6)).problems).toEqual([]);
    expect(labelProblems(h, day(5)).problems.length).toBe(1);
  });
  test("a gap in the dates restarts the run, and a composite off the 0 to 1 scale is refused", () => {
    const h = [p(day(0), 0.8, "neutral"), p(day(1), 0.8, "neutral"), p(day(3), 0.8, "neutral"), p(day(4), 0.8, "neutral"), p(day(5), 0.8, "neutral")];
    expect(labelProblems(h, day(0)).problems).toEqual([]);
    expect(labelProblems([p(day(0), 1.4, "risk_on")], day(0)).problems.join()).toContain("outside 0 to 1");
  });
  test("the ledger must end at v5 with a succeeded v5 run", () => {
    expect(ledgerProblems({ newestLabel: "v5", v5Start: "2026-11-20" })).toEqual([]);
    expect(ledgerProblems({ newestLabel: "v3", v5Start: null }).join()).toContain("not v5");
    expect(ledgerProblems({ newestLabel: "v5", v5Start: null }).join()).toContain("no v5 run has succeeded");
  });
  test("grading starts at the first v5 regime run that published its own as-of day, never at a research run or an empty artifact", async () => {
    const seen: string[] = [];
    const db = { async query<T>(text: string): Promise<T[]> { seen.push(text); return [{ label: "v5", asof: "2026-11-20" }] as unknown as T[]; } };
    expect((await readLedger(db)).v5Start).toBe("2026-11-20");
    const start = seen.find((q) => q.includes("min(r.asof)"))!;
    expect(start).toContain("r.tool_id = 'regime'");
    expect(start).toContain("artifact_kind = 'regime_snapshots'");
    expect(start).toContain("natural_keys @> ARRAY[r.asof::text]");
    expect(start).toContain("'succeeded'");
  });
});

describe("Q42-regime-page/C30-regime-page (PR 1663)", () => {
  const served = () => FILES.map((f) => ({ path: f.path, status: 200, text: readFileSync(join(repoRoot, "frontend", "public", f.path), "utf8") }));
  test("passes on the files this commit serves", () => {
    expect(pageProblems(served())).toEqual([]);
  });
  test("red: a missing file, a 404, the old import and a dial that reads the percentile", () => {
    expect(pageProblems(served().slice(1)).join()).toContain("regime-scale.js was not read");
    expect(pageProblems(served().map((a, i) => (i === 0 ? { ...a, status: 404 } : a))).join()).toContain("404");
    expect(pageProblems(served().map((a, i) => (i === 1 ? { ...a, text: a.text.replace("readOnComposite", "x") } : a))).join()).toContain("imports readOnComposite");
    expect(pageProblems(served().map((a, i) => (i === 2 ? { ...a, text: `${a.text}\nconst v = model.percentile;` } : a))).join()).toContain("still reads the percentile");
  });
});

describe("Q43-source-data/C31-source-data (PR 1671, PR 1674)", () => {
  const want = registryRatioLegs().map((l) => l.id);
  const today = "2026-11-20";
  test("the registry names 28 ratio legs, both closes of both symbols of each ratio", () => {
    expect(want.length).toBe(28);
    expect(want).toContain("yahoo:HG=F.close");
    expect(want).toContain("yahoo:XLY.adjclose");
  });
  test("passes: every leg stored and fresh, BAA10Y full and fresh", () => {
    expect(legProblems(want, want.map((key) => ({ key, newest: "2026-11-19" })), today)).toEqual([]);
    expect(baa10yProblems({ first: "1986-01-02", newest: "2026-11-18", rows: 10_000 }, today)).toEqual([]);
  });
  test("red: a missing leg, a stale leg, a short BAA10Y history and a stale one", () => {
    expect(legProblems(want, want.slice(1).map((key) => ({ key, newest: "2026-11-19" })), today).join()).toContain("1 of 28");
    expect(legProblems(want, want.map((key, i) => ({ key, newest: i === 0 ? "2026-10-01" : "2026-11-19" })), today).join()).toContain("older than 10 days");
    expect(baa10yProblems({ first: "2020-01-01", newest: "2026-11-18", rows: 10_000 }, today).join()).toContain("not full");
    expect(baa10yProblems({ first: "1986-01-02", newest: "2026-11-18", rows: 100 }, today).join()).toContain("fewer than");
    expect(baa10yProblems({ first: "1986-01-02", newest: "2026-10-01", rows: 10_000 }, today).join()).toContain("older than");
    expect(baa10yProblems({ first: null, newest: null, rows: 0 }, today).join()).toContain("no BAA10Y row");
  });
  test("BAA10Y is no composite input in the SDK registry, and a registry that held it is refused", async () => {
    const { INDICATORS } = await import("../../../packages/analyst-sdk/src/analyze/indicators.ts");
    expect(compositeInputProblems(INDICATORS.map((i) => i.id))).toEqual([]);
    expect(compositeInputProblems(["VIX", "BAA10Y"]).join()).toContain("outside the composite");
  });
});

describe("the v0.10.0 runbook's scope and added steps (issue 1693)", () => {
  const rb = loadReleaseRunbook("v0.10.0");
  const scopeText = rb.scope.map((e) => `${e.what} ${"check" in e ? e.check : ""}`).join("\n");
  test("the scope names the migrations, the contract bump, the FLOW keys, the csvb install and the CoinGecko credit check", () => {
    for (const needle of ["0132_flow_index", "0133_buybacks_refresh_disabled", "0.5.11", "FLOW_*", "csvb", "P09-coingecko-credit"]) expect(scopeText, needle).toContain(needle);
  });
  test("every scope check names a step of the runbook, and a none states its reason", () => {
    const ids = new Set(rb.steps.map((s) => s.id));
    for (const e of rb.scope) {
      if ("check" in e && e.check !== undefined) expect(ids.has(e.check), `PR ${e.pr}`).toBe(true);
      else expect("none" in e && (e.none ?? "").length > 20, `PR ${e.pr}`).toBe(true);
    }
  });
  test("P09-coingecko-credit is in the copy, and every added step after READY declares after", () => {
    expect(rb.steps.some((s) => s.id === "P09-coingecko-credit")).toBe(true);
    const added = rb.steps.filter((s) => s.added === "v0.10.0");
    expect(added.length).toBe(14);
    for (const s of added.filter((x) => x.id.match(/^(Q3[89]|Q4|C2[6-9]|C3)/))) expect(s.after, s.id).toBeDefined();
  });
  test("each added version check has a file under version-checks/v0.10.0", () => {
    for (const s of rb.steps.filter((x) => x.added === "v0.10.0" && x.cmds[0]?.includes("version-check.ts"))) {
      const name = s.cmds[0]![s.cmds[0]!.indexOf("--check") + 1]!;
      expect(() => readFileSync(join(repoRoot, "scripts", "release", "version-checks", "v0.10.0", `${name}.ts`), "utf8"), s.id).not.toThrow();
    }
  });
});
