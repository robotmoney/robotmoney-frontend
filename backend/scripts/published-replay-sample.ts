// Issue 1431: write the committed sample of published production regime runs
// that backend/tests/regime-replay-published.test.ts replays in required CI.
//
//   bun backend/scripts/published-replay-sample.ts --archive <format 1 local copy> --out <dir> <run_key> [<run_key> ...]
//
// The local copy is a clone of robotmoney/csv-backups (D72). Everything written
// is data the public API already serves (D58, D73): each run's frozen vintage
// (source value versions, exactly as stored) and the as-of row of its published
// regime artifact. It is read through the analyst SDK's one archive reader
// (packages/analyst-sdk/bin/backups-dir.ts, the reader of `bun run inputs`), and
// each run is replayed with the SDK's replayRun (issue 1765): under its own
// methodology label, over the panels that version's published runs average
// (REGIME_PUBLISHED_PANELS), its published rows read under its line's artifact
// kind with their payload hash checked. Every sampled run so far is a v3 run, so
// it replays under v3 over macro and onchain: the version and panels the
// committed sample was recorded under (the test replays it with SAMPLE_VERSION).
//
// A production vintage holds about 129k values and consecutive runs share most
// of them, so the inputs of the sampled runs are written once, as the union:
// `inputs.csv.gz` has the replay columns plus `runs`, the sample indexes
// (`;`-joined) whose vintage holds that row. `runs.json` names each run, the
// SHA-256 of its own replay input file (as `bun run inputs` writes it), the
// SHA-256 of its published artifact and its published as-of row.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { collectRunInputs, openBackupsDir } from "../../packages/analyst-sdk/bin/backups-dir.ts";
import { serializeInputs } from "../../packages/analyst-sdk/src/archive/format1.ts";
import { COMPARED_FIELDS, replayRun } from "../../packages/analyst-sdk/src/replay/index.ts";

const argv = process.argv.slice(2);
const opt = (name: string) => {
  const i = argv.indexOf(name);
  if (i < 0 || !argv[i + 1]) throw new Error(`${name} <value> is required`);
  const v = argv[i + 1]!;
  argv.splice(i, 2);
  return v;
};
const archive = resolve(opt("--archive"));
const out = resolve(opt("--out"));
const keys = argv;
if (keys.length === 0) throw new Error("name at least one run_key");

const sha256 = (s: string | Uint8Array) => new Bun.CryptoHasher("sha256").update(s).digest("hex");
const copy = openBackupsDir(archive);

// Each run replayed by the SDK: its published as-of row (verified) and the replay's outcome.
const replays = keys.map((k) => {
  const r = replayRun(copy, k);
  if (r.problems.length > 0 || r.diff === null) throw new Error(`run ${k}: ${r.problems.join("; ") || "the SDK did not replay it"}`);
  if (r.published.asof === null) throw new Error(`run ${k} published no as-of row`);
  return r;
});
// The stored payload_sha256 of each run's published artifact, read once.
const artifactIds = new Set(replays.map((r) => r.published.artifactId!));
const payloadSha = new Map<string, string>();
for (const f of copy.files("analytics_output_snapshots")) for (const o of copy.scanRows(f)) if (artifactIds.has(o.id!)) payloadSha.set(o.id!, o.payload_sha256!);

// Union of the sampled runs' input rows: (date, series, value, kind) -> sample indexes.
const union = new Map<string, number[]>();
const meta = replays.map((r, idx) => {
  const inputs = collectRunInputs(copy, r.run.runKey);
  for (const row of inputs.rows) {
    const k = `${row.date},${row.series},${row.value},${row.kind}`;
    (union.get(k) ?? union.set(k, []).get(k)!).push(idx);
  }
  const row = r.published.asof!;
  // Only the fields a replay compares (the rich per-indicator cards are
  // display data and would make the fixture several times larger).
  const asofRow = Object.fromEntries([["date", row.date], ...COMPARED_FIELDS.map((k) => [k, (row as unknown as Record<string, unknown>)[k]])]);
  const text = serializeInputs(inputs.rows, "csv");
  // The replay's outcome on the full record, recorded so CI asserts it exactly:
  // a pre-1421 run's numbers can differ from what it published (fresh Yahoo
  // values, packages/analyst-sdk/README.md). The differing fields are pinned
  // here with a hash of the whole replayed row, never tolerated: any change in
  // any replayed value, or in which fields differ, fails the test.
  const outcome = r.diff!;
  return {
    index: idx,
    runKey: r.run.runKey,
    runId: r.run.id,
    asof: r.run.asof,
    createdAt: copy.table("analytics_ledger_runs").find((x) => x.id === r.run.id)!.created_at!,
    vintageId: inputs.run.vintageId,
    memberCount: inputs.run.memberCount,
    inputRows: inputs.rows.length,
    inputSha256: sha256(text),
    publishedPayloadSha256: payloadSha.get(r.published.artifactId!)!,
    publishedAsofRow: asofRow,
    replayDiffering: outcome.differing,
    replayFirstDiff: outcome.firstDiff,
    replaySha256: outcome.replaySha256,
  };
});

const lines = ["date,series,value,kind,runs"];
for (const k of [...union.keys()].sort()) lines.push(`${k},${union.get(k)!.join(";")}`);
const gz = gzipSync(new TextEncoder().encode(lines.join("\n") + "\n"), { level: 9 });
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "inputs.csv.gz"), gz);
// The record header is indented; each run is one compact line (its published
// backtest block alone is over 100 kB, and indentation would double it).
const head = {
  origin: "robotmoney/csv-backups format 1 local copy (D72); public archive routes serve the same data (D58, D73)",
  backup: copy.asOf.backup,
  generator: "backend/scripts/published-replay-sample.ts",
  inputsSha256Gz: sha256(gz),
};
const headText = JSON.stringify(head, null, 2).replace(/\n}$/, "");
writeFileSync(join(out, "runs.json"), `${headText},\n  "runs": [\n${meta.map((m) => `    ${JSON.stringify(m)}`).join(",\n")}\n  ]\n}\n`);
console.error(`wrote ${out}: ${meta.length} runs, ${union.size} distinct input rows, inputs.csv.gz ${gz.length} bytes`);
