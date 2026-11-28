// Issue 1431: replay EVERY published production regime run since 2026-09-21
// against its published record, from a format 1 local copy (D72).
//
// The production record is not in this repo: it lives in the private backups
// repo (robotmoney/csv-backups) and on the public archive routes (D73). This
// test reads a local copy whose path is in RM_FORMAT1_ARCHIVE (a clone of that
// repo, or an API fill), never the production database. Without the variable
// it SKIPS with the reason printed; the committed sample of published runs in
// regime-replay-published.test.ts is what required CI executes.
//
// For each regime run with an as-of day on or after 2026-09-21 it replays the
// run with the analyst SDK's replayRun (issue 1765) over the copy opened with
// the SDK's one archive reader (packages/analyst-sdk/bin/backups-dir.ts, the
// reader `bun run inputs` uses), with the network poisoned: the run's frozen
// vintage, under its own methodology label and the panels that version's
// published runs average (REGIME_PUBLISHED_PANELS: macro and onchain for a v3
// run, every panel for v4 and v5), against the rows it published under its
// line's artifact kind (REGIME_ARTIFACT_KIND), their payload checked against
// the stored SHA-256. The as-of row is compared field by field, exactly. Every
// run is reported (match, or every differing field and the first one's
// values). No tolerance anywhere.
//
// What fails the test:
//   - any as-of LABEL that differs from the published label (issue 1431);
//   - any field that differs by more than rounding on a run created after
//     issue 1421 merged (POST_1421): since then a run computes from the
//     committed values, so its replay must reproduce every field. Accepted
//     decision D78 (compensated arithmetic) moves numbers in their last bits,
//     so a run published before it replays up to rounding (status
//     "rounding": same labels, nulls and keys, numbers within rounding).
// Runs before issue 1421 computed from freshly fetched Yahoo values, which the
// ledger stored only to a relative tolerance (D56), so their numbers can differ
// from what they published (packages/analyst-sdk/README.md). Those differences
// are not failures of this test, but each one is reported per run, on the
// console and in RM_REPLAY_REPORT; none is hidden behind a tolerance.
//
//   RM_FORMAT1_ARCHIVE=~/tmp/csv-backups [RM_REPLAY_REPORT=<dir>] bun test tests/regime-replay-archive.test.ts
//
// RM_REPLAY_REPORT, when set, receives results.json and results.md (the per-run table).
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openBackupsDir } from "../../packages/analyst-sdk/bin/backups-dir.ts";
import { replayRun } from "../../packages/analyst-sdk/src/replay/index.ts";
import { REGIME_ARTIFACT_KIND } from "../../packages/analyst-sdk/src/analyze/regime-versions.ts";
import { poisonNetwork } from "./support/network-poison.ts";

const LEDGER_START = "2026-09-21";
// Issue 1421's fix (PR 1427) merged at 2026-10-23 18:32:15 UTC; a run created
// after that instant must replay every field exactly.
const POST_1421 = "2026-10-23 18:32:15+00";
const ARCHIVE = process.env.RM_FORMAT1_ARCHIVE;
const REPORT_DIR = process.env.RM_REPLAY_REPORT;
// The kinds a run's regime rows are frozen under, one per line.
const REGIME_KINDS: ReadonlySet<string> = new Set(Object.values(REGIME_ARTIFACT_KIND));

if (!ARCHIVE) {
  console.warn(
    "SKIP regime-replay-archive.test.ts: RM_FORMAT1_ARCHIVE is not set. The full production replay (issue 1431) needs a format 1 local copy " +
      "(a clone of robotmoney/csv-backups or a public API fill); CI has none. The committed sample in regime-replay-published.test.ts runs instead.",
  );
}

interface RunResult {
  runId: string;
  runKey: string;
  asof: string;
  createdAt: string;
  // The methodology label the run replayed under (null: none recorded, replayed under the current version).
  methodology: string | null;
  status: "match" | "rounding" | "mismatch" | "not published";
  firstDiff: string | null;
  differing: string[];
  publishedLabel: string | null;
  replayLabel: string | null;
}

function table(results: RunResult[]): string {
  const lines = ["| run key | run id | as-of | methodology | published label | replay label | result | first differing field (or reason) | all differing fields |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- |"];
  for (const r of results) {
    lines.push(`| \`${r.runKey}\` | ${r.runId} | ${r.asof} | ${r.methodology ?? "-"} | ${r.publishedLabel ?? "-"} | ${r.replayLabel ?? "-"} | ${r.status} | ${r.firstDiff ?? ""} | ${r.differing.join(", ")} |`);
  }
  return lines.join("\n") + "\n";
}

describe.skipIf(!ARCHIVE)("replay of every published production regime run from a format 1 local copy", () => {
  test("every published run since 2026-09-21 replays to its published as-of row, field by field", () => {
    const copy = openBackupsDir(ARCHIVE!);
    const runs = copy.table("analytics_ledger_runs")
      .filter((r) => r.tool_id === "regime" && r.asof! >= LEDGER_START)
      .sort((a, b) => (a.asof! < b.asof! ? -1 : a.asof! > b.asof! ? 1 : Number(a.id) - Number(b.id)));
    expect(runs.length).toBeGreaterThan(0);
    const runIds = new Set(runs.map((r) => r.id!));

    // One pass over the artifacts: which runs froze a regime artifact (of
    // either line) and which failed (a failed run freezes warnings/logs/
    // exceptions instead, output-snapshots.ts). readRows keeps each file, so
    // every replayRun below reads the artifacts from memory.
    const hasRegimeArtifact = new Set<string>();
    const failed = new Set<string>();
    for (const f of copy.files("analytics_output_snapshots")) {
      for (const o of copy.readRows(f)) {
        if (!runIds.has(o.run_id!)) continue;
        if (o.artifact_kind === "exceptions") failed.add(o.run_id!);
        if (REGIME_KINDS.has(o.artifact_kind!)) hasRegimeArtifact.add(o.run_id!);
      }
    }

    const results: RunResult[] = [];
    const problems: string[] = [];
    const poison = poisonNetwork("during the archive replay");
    try {
      for (const run of runs) {
        const base = { runId: run.id!, runKey: run.run_key!, asof: run.asof!, createdAt: run.created_at! };
        if (!hasRegimeArtifact.has(run.id!)) {
          const why = failed.has(run.id!) ? "failed run (froze exceptions, no report)" : "no output package in the copy";
          results.push({ ...base, methodology: null, status: "not published", firstDiff: why, differing: [], publishedLabel: null, replayLabel: null });
          continue;
        }
        // The run's own label and published panels; its rows under its line's kind.
        const r = replayRun(copy, run.run_key!);
        const methodology = r.run.methodology.label;
        if (r.problems.length > 0 || r.diff === null) {
          problems.push(`${run.run_key} ${run.asof}: ${r.problems.join("; ") || "not replayed"}`);
          results.push({ ...base, methodology, status: "mismatch", firstDiff: r.problems.join("; ") || "not replayed", differing: r.diff?.differing ?? [], publishedLabel: r.published.asof?.regime ?? null, replayLabel: r.computed.asof?.regime ?? null });
          continue;
        }
        const d = r.diff;
        results.push({
          ...base,
          methodology,
          status: d.match ? "match" : d.beyondRounding.length === 0 ? "rounding" : "mismatch",
          firstDiff: d.firstDiff ? `${d.firstDiff.field} (published ${d.firstDiff.published.slice(0, 80)}, replay ${d.firstDiff.replay.slice(0, 80)})` : null,
          differing: d.differing,
          publishedLabel: r.published.asof?.regime ?? null,
          replayLabel: r.computed.asof?.regime ?? null,
        });
      }
    } finally {
      poison.restore();
    }
    expect(poison.attempts).toEqual([]);

    const count = (s: RunResult["status"]) => results.filter((r) => r.status === s).length;
    const labelMismatches = results.filter((r) => r.status !== "not published" && r.publishedLabel !== r.replayLabel);
    const summary =
      `backup ${copy.asOf.backup}: ${results.length} regime runs since ${LEDGER_START}; ${count("match")} match, ${count("rounding")} match up to rounding (D78), ${count("mismatch")} mismatch, ` +
      `${count("not published")} not published (no regime artifact); as-of label differs on ${labelMismatches.length}`;
    console.log(summary);
    for (const r of results) if (r.status === "mismatch") console.log(`MISMATCH run ${r.runKey} (id ${r.runId}) as of ${r.asof}: first differing field ${r.firstDiff}`);
    if (REPORT_DIR) {
      mkdirSync(REPORT_DIR, { recursive: true });
      writeFileSync(join(REPORT_DIR, "results.json"), JSON.stringify({ backup: copy.asOf.backup, summary, results }, null, 2) + "\n");
      writeFileSync(join(REPORT_DIR, "results.md"), `${summary}\n\n${table(results)}`);
    }
    // Every published run was replayed, its artifact verified, and every published label reproduced.
    expect(problems).toEqual([]);
    expect(count("match") + count("rounding") + count("mismatch")).toBe(hasRegimeArtifact.size);
    expect(labelMismatches.map((r) => `${r.runKey} ${r.asof}: published ${r.publishedLabel}, replay ${r.replayLabel}`)).toEqual([]);
    // A post-1421 run reproduces every field up to rounding (D78; created_at is COPY text in UTC, so it sorts as text).
    expect(results.filter((r) => r.status === "mismatch" && r.createdAt >= POST_1421).map((r) => `${r.runKey} ${r.asof}: ${r.firstDiff}`)).toEqual([]);
  }, 3_600_000);
});
