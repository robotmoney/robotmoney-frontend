// The audit tools, run against SYNTHETIC backup repos built at test time (tests/support/audit-fixture.ts). In
// robotmoney/csv-backups these ran against the production baseline committed there; production data is never
// committed to robotmoney-frontend (issue 1477), so the expected numbers here are facts about the synthetic ledger,
// chosen by hand: a change to the analysis code that alters a finding fails here. The replay runs the analyst SDK
// beside this package (packages/analyst-sdk), so it is never skipped.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openCtx } from "../src/audit/data.ts";
import { analyseDrift } from "../src/audit/drift.ts";
import { writeReport } from "../src/audit/report.ts";
import { replayRun, SDK_TOO_OLD } from "../src/audit/replay.ts";
import { CURRENT_REGIME_VERSION, REGIME_PUBLISHED_PANELS } from "@robotmoney/analyst-sdk/src/analyze/regime-versions.ts";
import { analyseRevisions } from "../src/audit/revisions.ts";
import { analyseRuns, loadRuns } from "../src/audit/runs.ts";
import { LEDGER_BACKUP, ledgerRepo, PUBLISHED_DAYS, putAppendTable, readAppendTable, REPLAY_BACKUP, REPLAY_RUNS, replayRepo } from "./support/audit-fixture.ts";

const PKG = join(import.meta.dir, "..");
const SDK = resolve(PKG, "..", "analyst-sdk");
const made: string[] = [];
const tempDir = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  made.push(d);
  return d;
};
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true }); // the directories this test made, never a parent
});

const LEDGER = join(tempDir("csvb-audit-ledger-"), "repo");
ledgerRepo(LEDGER);
const ctx = openCtx(LEDGER, LEDGER_BACKUP);

describe("run ledger health", () => {
  test("finds the 09-22 outage streak and its recovery, the day with no successful run, and the research streak", async () => {
    const runs = await loadRuns(ctx);
    const reg = analyseRuns(runs, "regime");
    expect({ total: reg.total, ok: reg.succeeded, failed: reg.failed, unfinished: reg.unfinished }).toEqual({ total: 14, ok: 7, failed: 6, unfinished: 1 });
    expect(reg.missedDays).toEqual(["2026-09-22"]);
    expect(reg.streaks).toHaveLength(1); // runs 10 and 11 failed too, but two is not a streak
    expect(reg.streaks[0]).toMatchObject({ firstRunId: 3, lastRunId: 6, runs: 4, firstError: "The operation timed out.", recoveredByRunId: 7, recoveredAsof: "2026-09-23" });
    expect(reg.streaks[0]!.start.startsWith("2026-09-20 13:00")).toBe(true);
    expect(reg.perDay.find((d) => d.asof === "2026-09-24")).toEqual({ asof: "2026-09-24", succeeded: 2, failed: 0 });
    const res = analyseRuns(runs, "research");
    expect(res.streaks).toHaveLength(1);
    expect(res.streaks[0]).toMatchObject({ firstRunId: 15, lastRunId: 17, runs: 3, recoveredByRunId: 18 });
    expect(res.missedDays).toEqual(["2026-09-22"]); // the research runs of 09-22 all failed too
  }, 60_000);

  test("a streak needs the minimum length, and a recovered streak names its recovery", () => {
    const mk = (id: number, status: "succeeded" | "failed") => ({ id, asof: "2026-01-01", tool: "t", source: "live", createdAt: `2026-01-01 00:00:0${id}+00`, status, error: status === "failed" ? "boom" : "", finishedAt: `2026-01-01 00:00:0${id}+00` });
    const a = analyseRuns([mk(1, "succeeded"), mk(2, "failed"), mk(3, "failed"), mk(4, "succeeded"), mk(5, "failed"), mk(6, "failed"), mk(7, "failed")], "t", 3);
    expect(a.streaks).toHaveLength(1);
    expect(a.streaks[0]).toMatchObject({ firstRunId: 5, lastRunId: 7, runs: 3, recoveredByRunId: null });
  });
});

describe("how published figures moved", () => {
  test("the last run of 5 of 6 days differs from the table now, and two labels flipped", async () => {
    const d = await analyseDrift(ctx);
    expect(d.runsCompared).toBe(7);
    expect(d.summary.days).toBe(6);
    expect(d.summary.daysWhoseLastRunDiffersFromNow).toBe(5);
    expect(d.summary.labelFlips).toBe(2);
    expect(d.summary.flippedDays).toEqual(["2026-09-21", "2026-09-24"]);
    expect(d.summary.maxLastDiff).toBeGreaterThan(0.0099);
    expect(d.summary.maxLastDiff).toBeLessThan(0.0101);
    const day = d.days.find((x) => x.asof === "2026-09-24")!;
    expect(day).toMatchObject({ runs: 2, lastLabel: "neutral", finalLabel: "risk_on", flipped: true });
    expect(d.days.find((x) => x.asof === "2026-09-26")!.lastDiff).toBe(0); // the newest day is the table's own
    expect(d.summary.runsThatRewroteHistory).toBe(6); // every run after the first moved history by 0.001
  }, 60_000);
});

describe("what the database revised in place", () => {
  test("counts revisions per table, and reads raw indicator changes", async () => {
    const r = await analyseRevisions(ctx);
    expect(r.totalEvents).toBe(11);
    expect(Object.fromEntries(r.byTable.map((t) => [t.table, t.events]))).toEqual({ raw_indicator_history: 7, regime_snapshots: 3, research_signals: 1 });
    expect(r.regimeEvents).toBe(3);
    expect(r.regimeLabelChanges).toBe(1);
    const defi = r.indicators.find((i) => i.indicator === "DEFI_TVL")!;
    expect(defi).toMatchObject({ events: 5, distinctRows: 3, tiny: 4 });
    expect(defi.medianRelChange).toBeLessThan(1e-5); // mostly provider restatement noise
    expect(defi.maxRelChange).toBeGreaterThan(0.02);
    expect(r.perDay.reduce((n, x) => n + x.events, 0)).toBe(r.totalEvents);
  }, 60_000);
});

describe("the report", () => {
  test("is written to the directory it is given, as markdown plus detail CSVs, and says what it found", async () => {
    const out = join(tempDir("csvb-report-"), "r");
    const runs = analyseRuns(await loadRuns(ctx), "regime");
    const files = writeReport(ctx, out, { runs: [runs], skipped: [{ part: "replay", why: "no --sdk given" }] });
    expect(files).toEqual(["runs-streaks.csv", "runs-days.csv", "report.md"]);
    expect(readdirSync(out).sort()).toEqual([...files].sort());
    const md = readFileSync(join(out, "report.md"), "utf8");
    expect(md).toContain(`# Audit report, as of backup ${LEDGER_BACKUP}`);
    expect(md).toContain("As-of days with no successful run:** 2026-09-22");
    expect(md).toContain("Not produced:** replay (no --sdk given)");
    expect(md).toContain("This report is not committed");
    expect(readFileSync(join(out, "runs-streaks.csv"), "utf8")).toContain("regime,3,6,4");
  }, 60_000);

  test("the command writes its report under the data checkout's reports/ (ignored there), never beside the tool", () => {
    const p = Bun.spawnSync(["bun", "run", "src/cli.ts", "audit", "runs", "--repo", LEDGER], { cwd: PKG, stdout: "pipe", stderr: "pipe" });
    expect(p.exitCode).toBe(0);
    expect(readdirSync(join(LEDGER, "reports", LEDGER_BACKUP)).sort()).toEqual(["report.md", "runs-days.csv", "runs-streaks.csv"]);
    expect(readdirSync(PKG)).not.toContain("reports");
  });
});

// The replay runs the analyst SDK's replay module in packages/analyst-sdk over each run's frozen vintage (the repo
// opened with that SDK's archive reader) and compares the payload the fixture published (the SDK's publishedRows from
// exactly that vintage, with its payload_sha256) day by day with the rows the SDK computes.
describe("replay from the frozen vintage", () => {
  const REPLAY = join(tempDir("csvb-audit-replay-"), "repo");
  let members: Record<number, number> = {};
  let rctx: ReturnType<typeof openCtx>;
  beforeAll(async () => {
    members = (await replayRepo(REPLAY, SDK)).members;
    rctx = openCtx(REPLAY);
  }, 120_000);

  test("rebuilds the run's exact inputs and reproduces what was published", async () => {
    const r = await replayRun(rctx, { sdkDir: SDK });
    expect(r.run).toMatchObject({ id: REPLAY_RUNS.newest.id, asof: REPLAY_RUNS.newest.asof });
    // Every member of the vintage was read: the SDK refuses a copy that lacks one (the red control below).
    expect(r.vintage.memberCount).toBe(members[REPLAY_RUNS.newest.id]!);
    expect(r.daysCompared).toBe(PUBLISHED_DAYS);
    expect(r.inputs.extras).toMatchObject({ SPX: expect.any(Number), ETH: expect.any(Number), TBILL3M: expect.any(Number) });
    for (const m of r.metrics) expect({ metric: m.metric, exact: m.exact }).toEqual({ metric: m.metric, exact: m.compared });
    expect(r.backtestCorrelations!.leaves).toBeGreaterThan(0);
    expect(r.backtestCorrelations).toMatchObject({ exact: r.backtestCorrelations!.leaves, different: 0 });
    // The SDK's own comparison of the as-of rows (every compared field, exactly).
    expect(r.asofDiff).toEqual({ match: true, differing: [], beyondRounding: [] });
    // No methodology table: the run is on the main line and replays under the current version and its published panels.
    expect(r.methodology).toEqual({ label: null, version: CURRENT_REGIME_VERSION, line: "main", panels: [...REGIME_PUBLISHED_PANELS[CURRENT_REGIME_VERSION]] });
  }, 180_000);

  test("a run that failed has no vintage, and is refused with a clear message", async () => {
    await expect(replayRun(rctx, { sdkDir: SDK, runId: REPLAY_RUNS.failed.id })).rejects.toThrow("not a succeeded regime run with a vintage");
  }, 60_000);

  type Table = { header: string[]; rows: (string | number | null)[][] };
  /** A copy of the replay repo with append-only tables edited (a function of the table's rows) or added (a whole table). */
  const editedCopy = (prefix: string, edits: Record<string, Table | ((t: Table) => Table["rows"])>): string => {
    const dir = join(tempDir(prefix), "repo");
    cpSync(REPLAY, dir, { recursive: true });
    for (const [table, edit] of Object.entries(edits)) {
      if (typeof edit !== "function") putAppendTable(dir, REPLAY_BACKUP, table, edit);
      else {
        const t = readAppendTable(dir, REPLAY_BACKUP, table);
        putAppendTable(dir, REPLAY_BACKUP, table, { header: t.header, rows: edit(t) });
      }
    }
    return dir;
  };
  const col = (t: { header: string[] }, name: string): number => {
    const i = t.header.indexOf(name);
    if (i < 0) throw new Error(`no ${name} column`);
    return i;
  };

  test("red control: a published payload whose bytes do not match its payload_sha256 is refused, never compared", async () => {
    const tampered = editedCopy("csvb-audit-tampered-", {
      analytics_output_snapshots: (t) => t.rows.map((r) => (Number(r[col(t, "run_id")]) === REPLAY_RUNS.newest.id ? r.map((c, i) => (i === col(t, "payload_sha256") ? "0".repeat(64) : c)) : r)),
    });
    await expect(replayRun(openCtx(tampered), { sdkDir: SDK })).rejects.toThrow("does not match its stored payload_sha256");
  }, 120_000);

  test("red control: a copy that lacks one member of the vintage is refused (incomplete local copy), never replayed from part of it", async () => {
    let removed: string | null = null;
    const partial = editedCopy("csvb-audit-partial-", {
      // The first version dated on or before the newest run's as-of day: a member of that run's vintage.
      source_value_versions: (t) => {
        const at = t.rows.findIndex((r) => String(r[col(t, "market_date")]) <= REPLAY_RUNS.newest.asof);
        removed = String(t.rows[at]![col(t, "id")]);
        return t.rows.filter((_, i) => i !== at);
      },
    });
    expect(removed).not.toBeNull();
    await expect(replayRun(openCtx(partial), { sdkDir: SDK })).rejects.toThrow(`incomplete local copy: vintage ${100 + REPLAY_RUNS.newest.id}`);
    await expect(replayRun(openCtx(partial), { sdkDir: SDK })).rejects.toThrow(`first missing ids ${removed}`);
  }, 120_000);

  test("issue 1765 D-c: without --run the newest main-line run is replayed, and a newer beside run (v5) is never chosen", async () => {
    // A methodology table: run 1 is v4, and the newest run (2) is under methodology 2 with the label given.
    const labelled = (label2: string): string =>
      editedCopy("csvb-audit-lines-", {
        analytics_ledger_methodology_versions: {
          header: ["id", "tool_id", "version_label", "config", "config_digest", "created_at"],
          rows: [
            ["1", "regime", "v4", "{}", "d".repeat(64), "2026-06-01 00:00:00+00"],
            ["2", "regime", label2, "{}", "e".repeat(64), "2026-06-01 00:00:00+00"],
          ],
        },
        analytics_ledger_runs: (t) => t.rows.map((r) => (Number(r[col(t, "id")]) === REPLAY_RUNS.newest.id ? r.map((c, i) => (i === col(t, "methodology_version_id") ? "2" : c)) : r)),
      });
    const beside = await replayRun(openCtx(labelled("v5")), { sdkDir: SDK });
    expect(beside.run.id).toBe(REPLAY_RUNS.oldest.id);
    expect(beside.methodology).toEqual({ label: "v4", version: "v4", line: "main", panels: [...REGIME_PUBLISHED_PANELS.v4] });
    for (const m of beside.metrics) expect({ metric: m.metric, exact: m.exact }).toEqual({ metric: m.metric, exact: m.compared });
    // RED CONTROL: the same newest run labelled v4 is a main-line run, and it is the one chosen.
    const main = await replayRun(openCtx(labelled("v4")), { sdkDir: SDK });
    expect(main.run.id).toBe(REPLAY_RUNS.newest.id);
    // A label this SDK does not compute is the main line too: that run is chosen, and the SDK names its label.
    await expect(replayRun(openCtx(labelled("regime-v3")), { sdkDir: SDK })).rejects.toThrow(`could not replay run ${REPLAY_RUNS.newest.id}: methodology regime-v3 is not one this SDK computes`);
  }, 300_000);

  test("an --sdk dir without src/replay/index.ts (an SDK before issue 1765) is refused with the named message", async () => {
    // The SDK's src/ and bin/ without the replay module, as a commit before issue 1765 has them.
    const old = join(tempDir("csvb-audit-old-sdk-"), "analyst-sdk");
    cpSync(join(SDK, "src"), join(old, "src"), { recursive: true, filter: (p) => p !== join(SDK, "src", "replay") });
    cpSync(join(SDK, "bin"), join(old, "bin"), { recursive: true });
    expect(existsSync(join(old, "src", "index.ts"))).toBe(true);
    expect(existsSync(join(old, "src", "replay", "index.ts"))).toBe(false);
    await expect(replayRun(rctx, { sdkDir: old })).rejects.toThrow(SDK_TOO_OLD);
    // The command refuses it the same way, before it writes a report.
    const out = join(tempDir("csvb-audit-old-sdk-report-"), "r");
    const p = Bun.spawnSync(["bun", "run", "src/cli.ts", "audit", "replay", "--repo", REPLAY, "--sdk", old, "--out", out], { cwd: PKG, stdout: "pipe", stderr: "pipe" });
    expect(p.exitCode).toBe(1);
    expect(p.stderr.toString()).toContain(SDK_TOO_OLD);
    expect(existsSync(out)).toBe(false);
  }, 60_000);

  test("the oldest run replays from its own frozen vintage too (every member of that vintage is found)", async () => {
    const r = await replayRun(rctx, { sdkDir: SDK, runId: REPLAY_RUNS.oldest.id });
    expect(r.run).toMatchObject({ id: REPLAY_RUNS.oldest.id, asof: REPLAY_RUNS.oldest.asof });
    expect(r.vintage.memberCount).toBe(members[REPLAY_RUNS.oldest.id]!);
    expect(r.vintage.memberCount).toBeLessThan(members[REPLAY_RUNS.newest.id]!);
    expect(r.daysCompared).toBe(PUBLISHED_DAYS);
    const m = (k: string) => r.metrics.find((x) => x.metric === k)!;
    expect(m("composite").exact).toBe(m("composite").compared);
    expect(m("regime").labelMismatch).toBe(0);
  }, 120_000);
});
