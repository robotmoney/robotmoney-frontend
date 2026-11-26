#!/usr/bin/env bun
// scripts/release/replay-row.ts — Q36/C24's comparison (issue 1476): replay a
// published run with the analyst SDK and compare the SDK's as-of row, field by
// field, with the as-of row the run published.
//
//   bun scripts/release/replay-row.ts --sdk <packages/analyst-sdk> --archive <local copy> --run <run key> [--inputs <inputs.csv>] [--tier full|label] [--print-row]
//
// The replay and the comparison are the SDK's own (issue 1765): replayRun of
// <sdk>/src/replay/index.ts over the local copy, opened with the SDK's archive
// reader (<sdk>/bin/backups-dir.ts). It reads the run's frozen vintage, the
// rows the run published under its line's artifact kind (their payload checked
// against payload_sha256), replays the run under its methodology label and
// compares the as-of rows with compareRows: every compared field exactly, in a
// fixed order, and the sha256 of the canonical JSON of each side. A label this
// SDK does not compute (the fixtures' regime-v3) replays under the SDK's
// current version, as before. The published report (`/reports?run=`) is the
// envelope {asof, toolId, results} and `bun run regime` prints the regime
// report, so the two are never byte-equal and are not compared.
//
// `--inputs` is accepted for the callers that pass it (scripts/release/sdk-lib.ts)
// and not read: the replay reads the run's vintage from the copy, the same
// rows `bun run inputs` writes to that file.
//
// The SDK modules are imported from --sdk (the release commit's sparse clone),
// so this file needs nothing from backend/ and computes nothing itself. An SDK
// commit without src/replay predates issue 1765 and is refused by name. It
// reads only. Exit 0: the rows are equal. Exit 1: they differ, a side is
// missing, or the SDK is too old. Exit 2: usage.
import { existsSync } from "node:fs";
import { join } from "node:path";
// Types only (erased at run time): the code itself comes from --sdk.
import type { Archive } from "../../packages/analyst-sdk/src/archive/reader.ts";
import type { PublishedRunCandidate, ReplayOptions, ReplayResult, RowComparison } from "../../packages/analyst-sdk/src/replay/index.ts";

/** The refusal of an SDK commit older than its replay module (issue 1765). */
export const SDK_TOO_OLD = "this SDK predates its replay module (issue 1765); the post-seal replay needs an SDK commit that has src/replay";

/** PURE. Why a full-tier comparison is a problem, in one line per fact; empty when the rows are equal. */
export function comparisonProblems(c: RowComparison, run: string, asof: string): string[] {
  if (c.match) return [];
  const missing = missingRowProblems(c, run, asof);
  if (missing.length > 0) return missing;
  const d = c.firstDiff!;
  return [`run ${run} as of ${asof}: the SDK's as-of row differs from the published one in ${c.differing.join(", ")}; first ${d.field}: published ${d.published.slice(0, 80)}, SDK ${d.replay.slice(0, 80)}; sha256 published ${c.publishedSha256}, SDK ${c.replaySha256}`];
}

/**
 * PURE. The label tier: only the as-of labels must be equal. `mismatches` is the
 * SDK's labelMismatches(c): the differing label fields, or the missing-row name
 * when a side has no row. Any other differing field is info, not a problem: a
 * run made before issue 1421's fix computed from freshly fetched values stored
 * to a relative tolerance (D56), so its numbers differ by about 1e-6
 * (regime-engine.md 8.1.1). A missing row on either side is a problem.
 */
export function labelProblems(c: RowComparison, mismatches: readonly string[], run: string, asof: string): string[] {
  const missing = missingRowProblems(c, run, asof);
  if (missing.length > 0) return missing;
  return mismatches.length === 0 ? [] : [`run ${run} as of ${asof}: the SDK's as-of label differs from the published one in ${mismatches.join(", ")}`];
}

// The comparison has no row on a side: the published artifact holds none for
// the day, or the SDK computed none.
function missingRowProblems(c: RowComparison, run: string, asof: string): string[] {
  if (c.publishedSha256 === null) return [`run ${run}: the published regime artifact has no as-of row for ${asof}`];
  if (c.replaySha256 === null) return [`run ${run}: the SDK computed no as-of row for ${asof}`];
  return [];
}

// ── the SDK side: imported from the clone, never from this checkout ──
/** An archive opened by the SDK's reader; only the SDK reads it. */
export type SdkArchive = Archive;

/** What the release checks use of the SDK at the release commit: its archive reader and its replay module. */
export interface ReplaySdk {
  openBackupsDir(root: string): SdkArchive;
  replayRun(archive: SdkArchive, runKey: string, opts?: ReplayOptions): ReplayResult;
  publicationCandidates(archive: SdkArchive, toolId: string, opts?: { line?: "main" | "beside"; methodology?: string }): PublishedRunCandidate[];
  labelMismatches(c: RowComparison): string[];
  UnknownRunError: new (runKey: string) => Error;
  CURRENT_REGIME_VERSION: NonNullable<ReplayOptions["fallbackVersion"]>;
}

/** The SDK's replay at `dir`, or null when that commit has no src/replay (it predates issue 1765). */
export async function loadReplaySdk(dir: string): Promise<ReplaySdk | null> {
  if (!existsSync(join(dir, "src", "replay", "index.ts"))) return null;
  const [replay, local, ver] = await Promise.all([import(join(dir, "src/replay/index.ts")), import(join(dir, "bin/backups-dir.ts")), import(join(dir, "src/analyze/regime-versions.ts"))]);
  return {
    openBackupsDir: local.openBackupsDir,
    replayRun: replay.replayRun,
    publicationCandidates: replay.publicationCandidates,
    labelMismatches: replay.labelMismatches,
    UnknownRunError: replay.UnknownRunError,
    CURRENT_REGIME_VERSION: ver.CURRENT_REGIME_VERSION,
  };
}

const flag = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function main(): Promise<number> {
  const [sdkDir, archive, run] = [flag("--sdk"), flag("--archive"), flag("--run")];
  const tier = flag("--tier") ?? "full";
  if (!sdkDir || !archive || !run || (tier !== "full" && tier !== "label")) {
    console.error("usage: bun scripts/release/replay-row.ts --sdk <sdk dir> --archive <local copy> --run <run key> [--inputs <inputs.csv>] [--tier full|label] [--print-row]");
    return 2;
  }
  const sdk = await loadReplaySdk(sdkDir);
  if (sdk === null) {
    console.log(JSON.stringify({ problems: [SDK_TOO_OLD] }));
    return 1;
  }
  let r: ReplayResult;
  try {
    r = sdk.replayRun(sdk.openBackupsDir(archive), run, { fallbackVersion: sdk.CURRENT_REGIME_VERSION });
  } catch (e) {
    if (e instanceof sdk.UnknownRunError) {
      console.log(JSON.stringify({ problems: [(e as Error).message] }));
      return 1;
    }
    throw e;
  }
  const asof = r.run.asof;
  if (process.argv.includes("--print-row")) {
    if (r.computed.asof === null) {
      console.log(JSON.stringify({ problems: [`run ${run}: the SDK computed no as-of row for ${asof}`, ...r.problems] }));
      return 1;
    }
    console.log(JSON.stringify(r.computed.asof));
    return 0;
  }
  // A missing or unverified artifact, an unknown label: the replay is not a clean comparison.
  if (r.problems.length > 0 || r.diff === null) {
    console.log(JSON.stringify({ run, asof, tier, match: false, differing: r.diff?.differing ?? [], publishedSha256: r.diff?.publishedSha256 ?? null, replaySha256: r.diff?.replaySha256 ?? null, problems: r.problems.length > 0 ? r.problems : [`run ${run}: the SDK did not replay the run`] }));
    return 1;
  }
  const c = r.diff;
  const problems = tier === "label" ? labelProblems(c, sdk.labelMismatches(c), run, asof) : comparisonProblems(c, run, asof);
  console.log(JSON.stringify({ run, asof, tier, match: c.match, differing: c.differing, publishedSha256: c.publishedSha256, replaySha256: c.replaySha256, problems }));
  return problems.length === 0 ? 0 : 1;
}

if (import.meta.main) process.exit(await main());
