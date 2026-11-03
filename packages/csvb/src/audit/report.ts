// Writing an audit report: one markdown file that reads top to bottom, plus the detail as CSV files beside it.
// Reports are generated, never committed (`reports/` is gitignored).
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodeCsvRow } from "@robotmoney/analyst-sdk/src/archive/format1.ts";
import type { Ctx } from "./data.ts";
import type { DriftAnalysis } from "./drift.ts";
import type { ReplayResult } from "./replay.ts";
import type { RevisionsAnalysis } from "./revisions.ts";
import { hours, type RunsAnalysis } from "./runs.ts";

export interface Outputs {
  runs?: RunsAnalysis[];
  drift?: DriftAnalysis;
  revisions?: RevisionsAnalysis;
  replay?: ReplayResult;
  /** Why a requested part was not produced. */
  skipped: { part: string; why: string }[];
}

const csv = (header: string[], rows: (string | number | null)[][]): string => encodeCsvRow(header) + rows.map((r) => encodeCsvRow(r.map((v) => (v === null ? null : String(v))))).join("");
const e = (x: number, d = 2): string => (Number.isFinite(x) ? (x === 0 ? "0" : x.toExponential(d)) : "n/a");
const f = (x: number, d = 4): string => (Number.isFinite(x) ? x.toFixed(d) : "n/a");
const table = (head: string[], rows: (string | number)[][]): string => [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");

function repoCommit(root: string): string {
  try {
    return execFileSync("git", ["-C", root, "rev-parse", "--short", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "unknown";
  }
}

export function writeReport(ctx: Ctx, out: string, o: Outputs): string[] {
  mkdirSync(out, { recursive: true });
  const written: string[] = [];
  const put = (name: string, text: string): void => {
    writeFileSync(join(out, name), text);
    written.push(name);
  };
  const md: string[] = [];
  md.push(`# Audit report, as of backup ${ctx.asOf.backup}`);
  md.push(`Generated ${new Date().toISOString()} from the backups in this repo (commit ${repoCommit(ctx.layout.root)}), as of the database snapshot ${ctx.asOf.snapshot.exported_at_db}. Nothing here was read from the database. This report is not committed.`);
  if (o.skipped.length) md.push(`**Not produced:** ${o.skipped.map((s) => `${s.part} (${s.why})`).join("; ")}.`);

  if (o.runs) {
    md.push("## Run ledger health");
    for (const a of o.runs) {
      md.push(`### ${a.tool} runs`);
      md.push(`${a.total} runs: ${a.succeeded} succeeded, ${a.failed} failed, ${a.unfinished} with no outcome recorded (started, never finished or failed)${a.replays ? `, ${a.replays} replays` : ""}.`);
      md.push(a.missedDays.length ? `**As-of days with no successful run:** ${a.missedDays.join(", ")}.` : "Every as-of day in the range has at least one successful run.");
      if (a.streaks.length) {
        md.push(`Streaks of three or more consecutive failed runs (by run id, ${a.tool} only):`);
        md.push(table(["runs", "ids", "from", "to", "hours", "first error", "recovered by"], a.streaks.map((s) => [s.runs, `${s.firstRunId} to ${s.lastRunId}`, s.start.slice(0, 16), s.end.slice(0, 16), hours(s.start, s.end), s.firstError || "(none)", s.recoveredByRunId ? `run ${s.recoveredByRunId} (as-of ${s.recoveredAsof}, ${s.recoveredAt?.slice(0, 16)})` : "not yet"])));
      } else md.push("No streak of three or more consecutive failed runs.");
    }
    put("runs-streaks.csv", csv(["tool", "first_run_id", "last_run_id", "runs", "start", "end", "first_error", "recovered_by_run_id", "recovered_at", "recovered_asof"], o.runs.flatMap((a) => a.streaks.map((s) => [a.tool, s.firstRunId, s.lastRunId, s.runs, s.start, s.end, s.firstError, s.recoveredByRunId, s.recoveredAt, s.recoveredAsof]))));
    put("runs-days.csv", csv(["tool", "asof", "succeeded", "failed"], o.runs.flatMap((a) => a.perDay.map((d) => [a.tool, d.asof, d.succeeded, d.failed]))));
  }

  if (o.drift) {
    const d = o.drift;
    md.push("## How published figures moved after publication");
    md.push(
      "`regime_snapshots` is a current view: every run recomputes the whole history and overwrites it. What was published is in each run's frozen output. " +
        `This compares ${d.runsCompared} runs' frozen outputs (${d.firstRunAt?.slice(0, 16)} to ${d.lastRunAt?.slice(0, 16)}) with each other and with the table as of this backup.`,
    );
    md.push(
      `- Of ${d.summary.days} as-of days, the last run of the day published a composite that differs from today's table for **${d.summary.daysWhoseLastRunDiffersFromNow}** (largest difference ${f(d.summary.maxLastDiff, 4)}).`,
    );
    md.push(`- **${d.summary.labelFlips}** as-of day(s) were published with a different regime label than the table holds now${d.summary.flippedDays.length ? `: ${d.summary.flippedDays.join(", ")}` : ""}.`);
    md.push(`- **${d.summary.runsThatRewroteHistory}** of ${d.moves.length} runs changed the composite of at least one historical day relative to the run before; ${d.summary.runsThatFlippedHistoricalLabels} changed a historical regime label.`);
    md.push(table(["as-of", "runs that day", "last run published", "table now", "difference", "label"], d.days.map((x) => [x.asof, x.runs, `${f(x.lastComposite)} ${x.lastLabel}`, `${f(x.finalComposite)} ${x.finalLabel}`, e(x.lastDiff), x.flipped ? `**${x.lastLabel} to ${x.finalLabel}**` : "same"])));
    put("drift-days.csv", csv(["asof", "runs", "first_composite", "first_label", "last_composite", "last_label", "final_composite", "final_label", "last_diff", "flipped"], d.days.map((x) => [x.asof, x.runs, x.firstComposite, x.firstLabel, x.lastComposite, x.lastLabel, x.finalComposite, x.finalLabel, x.lastDiff, x.flipped ? "yes" : "no"])));
    put("drift-runs.csv", csv(["run_id", "created_at", "asof", "changed_dates", "earliest_changed", "max_abs_diff", "label_changes", "new_dates"], d.moves.map((m) => [m.runId, m.createdAt, m.asof, m.changedDates, m.earliestChanged, m.maxAbsDiff, m.labelChanges, m.newDates])));
  }

  if (o.revisions) {
    const r = o.revisions;
    md.push("## What the database revised in place");
    md.push(`The database logged ${r.totalEvents} in-place revisions (\`analytics_overwrite_events\`).`);
    md.push(table(["table", "revisions", "first", "last"], r.byTable.map((t) => [t.table, t.events, t.first.slice(0, 16), t.last.slice(0, 16)])));
    md.push(`Of the ${r.regimeEvents} revisions of \`regime_snapshots\`, ${r.regimeLabelChanges} changed a regime label.`);
    md.push("Raw indicator history, by indicator (relative change per revision; revisions at or below 1e-4 are provider restatement noise):");
    md.push(table(["indicator", "revisions", "distinct rows", "median", "p90", "max", "tiny (<=1e-4)"], r.indicators.map((i) => [i.indicator, i.events, i.distinctRows, e(i.medianRelChange, 1), e(i.p90RelChange, 1), e(i.maxRelChange, 1), i.tiny])));
    put("revisions-by-table.csv", csv(["table", "events", "first", "last"], r.byTable.map((t) => [t.table, t.events, t.first, t.last])));
    put("revisions-by-day.csv", csv(["day", "table", "events"], r.perDay.map((x) => [x.day, x.table, x.events])));
    put("revisions-indicators.csv", csv(["indicator", "events", "distinct_rows", "median_rel_change", "p90_rel_change", "max_rel_change", "tiny"], r.indicators.map((i) => [i.indicator, i.events, i.distinctRows, i.medianRelChange, i.p90RelChange, i.maxRelChange, i.tiny])));
  }

  if (o.replay) {
    const r = o.replay;
    md.push(`## Replay of run ${r.run.id} (as-of ${r.run.asof}) from its frozen inputs`);
    md.push(
      `The run's data vintage (id ${r.vintage.id}, knowledge-time cutoff ${r.vintage.knowledgeCutoff}, ${r.vintage.memberCount} members, manifest ${r.vintage.manifestDigest.slice(0, 12)}...) names its exact inputs. ` +
        `They were rebuilt from the backups (${r.inputs.sourceValueVersions} source values, ${r.inputs.indicators} indicators; price series ${Object.entries(r.inputs.extras).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}) and replayed through the analyst SDK (${r.sdk.dir}, commit ${r.sdk.commit ?? "unknown"}). ` +
        `${r.daysCompared} published days were compared.`,
    );
    md.push(table(["figure", "days", "identical", "largest difference", "presence mismatch", "label mismatch"], r.metrics.map((m) => [m.metric, m.compared, `${m.exact}${m.exact === m.compared ? " (all)" : ""}`, e(m.maxAbsDiff), m.presenceMismatch, m.labelMismatch])));
    if (r.backtestCorrelations) md.push(`Correlations and backtest: ${r.backtestCorrelations.exact} of ${r.backtestCorrelations.leaves} values identical${r.backtestCorrelations.different ? `; differences: ${r.backtestCorrelations.examples.join("; ")}` : ""}.`);
    if (r.reference) {
      const all = r.reference.metrics.every((m) => m.exact === m.compared);
      md.push(`Independent reference (the original JavaScript, ${r.reference.dir}): ${all ? "every compared figure is identical to what was published" : "differs from what was published, see replay-metrics.csv"}; largest difference from the SDK replay ${e(r.reference.vsSdkMaxAbsDiff)}.`);
    }
    for (const n of r.notes) md.push(`Note: ${n}`);
    put("replay-metrics.csv", csv(["source", "figure", "days", "identical", "max_abs_diff", "presence_mismatch", "label_mismatch"], [...r.metrics.map((m) => ["sdk", m.metric, m.compared, m.exact, m.maxAbsDiff, m.presenceMismatch, m.labelMismatch]), ...(r.reference?.metrics ?? []).map((m) => ["reference_js", m.metric, m.compared, m.exact, m.maxAbsDiff, m.presenceMismatch, m.labelMismatch])]));
    put("replay-diffs.csv", csv(["date", "figure", "published", "replay"], r.diffs.map((d) => [d.date, d.metric, d.published, d.replay])));
  }

  put("report.md", md.join("\n\n") + "\n");
  return written;
}
