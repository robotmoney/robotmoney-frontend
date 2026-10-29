// Issue 1431: write the committed sample of published production regime runs
// that backend/tests/regime-replay-published.test.ts replays in required CI.
//
//   bun backend/scripts/published-replay-sample.ts --archive <format 1 local copy> --out <dir> <run_key> [<run_key> ...]
//
// The local copy is a clone of robotmoney/csv-backups (D72). Everything written
// is data the public API already serves (D58, D73): each run's frozen vintage
// (source value versions, exactly as stored) and the as-of row of its published
// regime_snapshots artifact. It is read through the analyst SDK's one archive
// reader (packages/analyst-sdk/bin/local-copy.ts, the reader of `bun run inputs`).
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
import { collectRunInputs, openLocalCopy } from "../../packages/analyst-sdk/bin/local-copy.ts";
import { serializeInputs } from "../../packages/analyst-sdk/src/archive/format1.ts";
import { COMPARED_FIELDS, publishedAsofRow, replayPublishedRun, type PublishedAsofRow } from "../tests/support/published-replay.ts";

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
const copy = openLocalCopy(archive);
const runs = keys.map((k) => {
  const r = (copy.tables.analytics_ledger_runs ?? []).find((x) => x.run_key === k);
  if (!r) throw new Error(`run ${k} is not in the copy`);
  return r;
});
const wanted = new Map(runs.map((r) => [r.id!, r]));
const published = new Map<string, { sha256: string; asofRow: unknown }>();
for (const f of copy.files("analytics_output_snapshots")) {
  for (const o of copy.readRows(f)) {
    if (o.artifact_kind !== "regime_snapshots" || !wanted.has(o.run_id!)) continue;
    if (sha256(o.payload_json!) !== o.payload_sha256) throw new Error(`run ${o.run_id}: payload does not match its SHA-256`);
    const row = publishedAsofRow(o.payload_json!, wanted.get(o.run_id!)!.asof!);
    if (!row) throw new Error(`run ${o.run_id} published no as-of row`);
    // Only the fields a replay compares (the rich per-indicator cards are
    // display data and would make the fixture several times larger).
    const kept = Object.fromEntries([["date", row.date], ...COMPARED_FIELDS.map((k) => [k, row[k]])]);
    published.set(o.run_id!, { sha256: o.payload_sha256!, asofRow: kept });
  }
}

// Union of the sampled runs' input rows: (date, series, value, kind) -> sample indexes.
const union = new Map<string, number[]>();
const meta = runs.map((r, idx) => {
  const inputs = collectRunInputs(copy, r.run_key!);
  for (const row of inputs.rows) {
    const k = `${row.date},${row.series},${row.value},${row.kind}`;
    (union.get(k) ?? union.set(k, []).get(k)!).push(idx);
  }
  const pub = published.get(r.id!);
  if (!pub) throw new Error(`run ${r.run_key} has no published regime_snapshots artifact`);
  const text = serializeInputs(inputs.rows, "csv");
  // The replay's outcome on the full record, recorded so CI asserts it exactly:
  // a pre-1421 run's numbers can differ from what it published (fresh Yahoo
  // values, packages/analyst-sdk/README.md). The differing fields are pinned
  // here with a hash of the whole replayed row, never tolerated: any change in
  // any replayed value, or in which fields differ, fails the test.
  const outcome = replayPublishedRun(text, r.asof!, pub.asofRow as PublishedAsofRow);
  return {
    index: idx,
    runKey: r.run_key!,
    runId: r.id!,
    asof: r.asof!,
    createdAt: r.created_at!,
    vintageId: inputs.run.vintageId,
    memberCount: inputs.run.memberCount,
    inputRows: inputs.rows.length,
    inputSha256: sha256(text),
    publishedPayloadSha256: pub.sha256,
    publishedAsofRow: pub.asofRow,
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
