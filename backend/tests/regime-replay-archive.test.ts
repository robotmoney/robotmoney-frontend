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
// For each regime run with an as-of day on or after 2026-09-21 it takes the
// run's frozen vintage through the analyst SDK's one archive reader
// (packages/analyst-sdk/bin/local-copy.ts, the reader `bun run inputs` uses),
// replays it with the network poisoned and compares the as-of row field by
// field, exactly, with the regime_snapshots artifact the run published. Every
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
import { collectRunInputs, openLocalCopy } from "../../packages/analyst-sdk/bin/local-copy.ts";
import { serializeInputs, type Row } from "../../packages/analyst-sdk/src/archive/format1.ts";
import { poisonNetwork } from "./support/network-poison.ts";
import { publishedAsofRow, replayPublishedRun, type PublishedAsofRow } from "./support/published-replay.ts";

const LEDGER_START = "2026-09-21";
// Issue 1421's fix (PR 1427) merged at 2026-10-23 18:32:15 UTC; a run created
// after that instant must replay every field exactly.
const POST_1421 = "2026-10-23 18:32:15+00";
const ARCHIVE = process.env.RM_FORMAT1_ARCHIVE;
const REPORT_DIR = process.env.RM_REPLAY_REPORT;
const sha256 = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");

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
  status: "match" | "rounding" | "mismatch" | "not published";
  firstDiff: string | null;
  differing: string[];
  publishedLabel: string | null;
  replayLabel: string | null;
}

function table(results: RunResult[]): string {
  const lines = ["| run key | run id | as-of | published label | replay label | result | first differing field (or reason) | all differing fields |", "| --- | --- | --- | --- | --- | --- | --- | --- |"];
  for (const r of results) {
    lines.push(`| \`${r.runKey}\` | ${r.runId} | ${r.asof} | ${r.publishedLabel ?? "-"} | ${r.replayLabel ?? "-"} | ${r.status} | ${r.firstDiff ?? ""} | ${r.differing.join(", ")} |`);
  }
  return lines.join("\n") + "\n";
}

describe.skipIf(!ARCHIVE)("replay of every published production regime run from a format 1 local copy", () => {
  test("every published run since 2026-09-21 replays to its published as-of row, field by field", () => {
    const copy = openLocalCopy(ARCHIVE!);
    const runs = (copy.tables.analytics_ledger_runs ?? [])
      .filter((r) => r.tool_id === "regime" && r.asof! >= LEDGER_START)
      .sort((a, b) => (a.asof! < b.asof! ? -1 : a.asof! > b.asof! ? 1 : Number(a.id) - Number(b.id)));
    expect(runs.length).toBeGreaterThan(0);
    const runIds = new Set(runs.map((r) => r.id!));

    // Each run's published regime_snapshots artifact, as-of row only; its bytes
    // are checked against the stored SHA-256 first.
    // A failed run freezes warnings/logs/exceptions instead (output-snapshots.ts).
    const published = new Map<string, PublishedAsofRow | null>();
    const failed = new Set<string>();
    for (const f of copy.files("analytics_output_snapshots")) {
      for (const o of copy.readRows(f) as Row[]) {
        if (o.artifact_kind === "exceptions" && runIds.has(o.run_id!)) failed.add(o.run_id!);
        if (o.artifact_kind !== "regime_snapshots" || !runIds.has(o.run_id!)) continue;
        expect(published.has(o.run_id!), `run ${o.run_id} has two regime_snapshots artifacts`).toBe(false);
        expect(sha256(o.payload_json!), `run ${o.run_id}: published payload does not match its stored SHA-256`).toBe(o.payload_sha256!);
        const run = runs.find((r) => r.id === o.run_id)!;
        published.set(o.run_id!, publishedAsofRow(o.payload_json!, run.asof!));
      }
    }

    const results: RunResult[] = [];
    const poison = poisonNetwork("during the archive replay");
    try {
      for (const run of runs) {
        const base = { runId: run.id!, runKey: run.run_key!, asof: run.asof!, createdAt: run.created_at! };
        if (!published.has(run.id!)) {
          const why = failed.has(run.id!) ? "failed run (froze exceptions, no report)" : "no output package in the copy";
          results.push({ ...base, status: "not published", firstDiff: why, differing: [], publishedLabel: null, replayLabel: null });
          continue;
        }
        const inputs = collectRunInputs(copy, run.run_key!);
        const outcome = replayPublishedRun(serializeInputs(inputs.rows, "csv"), run.asof!, published.get(run.id!)!);
        results.push({
          ...base,
          status: outcome.match ? "match" : outcome.beyondRounding.length === 0 ? "rounding" : "mismatch",
          firstDiff: outcome.firstDiff ? `${outcome.firstDiff.field} (published ${outcome.firstDiff.published.slice(0, 80)}, replay ${outcome.firstDiff.replay.slice(0, 80)})` : null,
          differing: outcome.differing,
          publishedLabel: outcome.publishedLabel,
          replayLabel: outcome.replayLabel,
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
      `${count("not published")} not published (no regime_snapshots artifact); as-of label differs on ${labelMismatches.length}`;
    console.log(summary);
    for (const r of results) if (r.status === "mismatch") console.log(`MISMATCH run ${r.runKey} (id ${r.runId}) as of ${r.asof}: first differing field ${r.firstDiff}`);
    if (REPORT_DIR) {
      mkdirSync(REPORT_DIR, { recursive: true });
      writeFileSync(join(REPORT_DIR, "results.json"), JSON.stringify({ backup: copy.asOf.backup, summary, results }, null, 2) + "\n");
      writeFileSync(join(REPORT_DIR, "results.md"), `${summary}\n\n${table(results)}`);
    }
    // Every published run was replayed, and every published label reproduced.
    expect(count("match") + count("rounding") + count("mismatch")).toBe(published.size);
    expect(labelMismatches.map((r) => `${r.runKey} ${r.asof}: published ${r.publishedLabel}, replay ${r.replayLabel}`)).toEqual([]);
    // A post-1421 run reproduces every field up to rounding (D78; created_at is COPY text in UTC, so it sorts as text).
    expect(results.filter((r) => r.status === "mismatch" && r.createdAt >= POST_1421).map((r) => `${r.runKey} ${r.asof}: ${r.firstDiff}`)).toEqual([]);
  }, 3_600_000);
});
