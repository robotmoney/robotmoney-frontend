// Issue 1404: a run frozen in real Postgres, exported as a format 1 local copy
// (the Postgres COPY CSV bytes csvb writes), turned into an SDK input by the
// real `packages/analyst-sdk/bin/inputs.ts` process, and run through the SDK.
// Asserts the exact source-version membership of the frozen vintage, that a
// revision collected after the freeze never reaches the run's input, and that
// the report from the generated input is byte-identical to the report from the
// vintage the backend's own loader (loadFrozenVintage) resolves.
//
// Needs the ephemeral Postgres of tests/preload.ts; it fails, never skips,
// without it. The format 1 copy is written by this test, not by csvb (another
// repo): only the tables a run's inputs come from, with csvb's file names and
// backup record fields.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { sql } from "../src/db/client.ts";
import { captureSourceAcquisition } from "../src/analytics/source-ledger.ts";
import { saveSourceAcquisition } from "../src/analytics/store/source-ledger-store.ts";
import { beginRun, freezeVintage, loadFrozenVintage } from "../src/analytics/store/run-ledger-store.ts";
import { parseInput, parseRawHistory, toHistory } from "../../packages/analyst-sdk/src/input/load.ts";
import { seriesForStorageKey } from "../../packages/analyst-sdk/src/archive/format1.ts";
import { buildReport, runRegime } from "../../packages/analyst-sdk/src/run.ts";
import type { RawIndicatorHistory } from "../../packages/analyst-sdk/src/types.ts";
import { useCleanDatabase } from "./support/clean-db.ts";

useCleanDatabase(import.meta.file);

const SDK = join(import.meta.dir, "../../packages/analyst-sdk");
const TMP = mkdtempSync(join(tmpdir(), "rm-sdk-roundtrip-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

const FROM = "2026-06-01";
const ASOF = "2026-08-10";
const EXTRA: Record<string, string> = { SPX: "backtest:^GSPC", ETH: "backtest:ETH-USD", TBILL3M: "backtest:DTB3" };
const sha = (b: Uint8Array | string) => new Bun.CryptoHasher("sha256").update(b).digest("hex");

// Collected from stream events, ending on whichever of end or close comes
// first, with a bound: a for-await over a COPY stream can miss its end under a
// loaded full-suite run (the same pattern as tests/api/public-analytics-archives.test.ts).
async function copyCsv(query: string): Promise<string> {
  return sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL TimeZone = 'UTC'");
    const stream = await tx.unsafe(`COPY (${query}) TO STDOUT WITH (FORMAT csv, HEADER)`).readable();
    return new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(Buffer.concat(chunks).toString("utf8"));
      };
      const timer = setTimeout(() => {
        if (!done) reject(new Error(`COPY of ${query.slice(0, 60)} never ended`));
      }, 60_000);
      stream.on("data", (c: Buffer) => chunks.push(Buffer.from(c)));
      stream.on("end", finish);
      stream.on("close", finish);
      stream.on("error", (e: Error) => {
        clearTimeout(timer);
        reject(e);
      });
    });
  }) as Promise<string>;
}

test(
  "a frozen vintage exported as format 1 generates an SDK input with exact membership and the backend loader's report bytes",
  async () => {
    // (1) Seed committed source versions through the production capture path.
    const text = readFileSync(join(SDK, "tests/fixtures/raw-indicator-history.csv"), "utf8");
    const history = toHistory(parseRawHistory(text).filter((r) => r.date >= FROM && r.date <= ASOF));
    const acquire = (sourceKey: string, points: { date: string; value: number }[]) =>
      captureSourceAcquisition({ provider: "fixture", sourceKey, parserVersion: "sdk-roundtrip:1", cacheIdentity: sourceKey }, { saveSourceAcquisition }, async () => points);
    for (const [id, points] of Object.entries(history)) await acquire(EXTRA[id] ?? `raw_indicator_history:${id}`, points);

    // (2) Begin a regime run and freeze its vintage.
    const buildIdentity = "4b4414c0e5a1d2f3b4c5d6e7f8091a2b3c4d5e6f";
    const runKey = crypto.randomUUID();
    const run = await beginRun({
      runKey, asof: ASOF, toolId: "regime", sourceLabel: "fixture", buildIdentity,
      methodology: { toolId: "regime", versionLabel: "sdk-roundtrip", config: { panels: ["macro", "onchain"] } },
    });
    const [{ now }] = await sql<{ now: string }[]>`SELECT clock_timestamp()::text AS now`;
    const frozen = await freezeVintage({ runId: run.runId, toolId: "regime", knowledgeTimeCutoff: now, marketTimeCutoff: ASOF, methodologyVersionId: run.methodologyVersionId, buildIdentity });
    expect(frozen.memberCount).toBeGreaterThan(1000);

    // (3) After the freeze, a provider revises VIX on one date.
    const vix = history.VIX!;
    const revisedDate = vix[vix.length - 3]!.date;
    const original = vix[vix.length - 3]!.value;
    await acquire("raw_indicator_history:VIX", vix.map((p) => (p.date === revisedDate ? { date: p.date, value: p.value + 0.5 } : p)));
    const [{ n: revisions }] = await sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM source_value_versions WHERE source_key = 'raw_indicator_history:VIX' AND market_date = ${revisedDate}::date`;
    expect(revisions).toBe(2);

    // (4) Export the input tables as one format 1 backup, the bytes Postgres COPY writes.
    const backup = "2026-08-11T000000Z";
    const tables: Record<string, string> = {
      analytics_ledger_runs: "SELECT * FROM analytics_ledger_runs ORDER BY id",
      analytics_ledger_methodology_versions: "SELECT * FROM analytics_ledger_methodology_versions ORDER BY id",
      analytics_data_vintages: "SELECT * FROM analytics_data_vintages ORDER BY id",
      analytics_vintage_members: "SELECT * FROM analytics_vintage_members ORDER BY id",
      source_value_versions: "SELECT * FROM source_value_versions ORDER BY id",
    };
    const root = join(TMP, "copy");
    const append_only: Record<string, unknown> = {};
    for (const [table, q] of Object.entries(tables)) {
      const raw = await copyCsv(q);
      const gz = gzipSync(Buffer.from(raw, "utf8"));
      const path = `csv/${backup}/data/${table}.2026-08-11T000000Z_2026-08-11T000000Z.csv.gz`;
      mkdirSync(join(root, `csv/${backup}/data`), { recursive: true });
      writeFileSync(join(root, path), gz);
      const rows = raw.trimEnd().split("\n").length - 1; // no multi-line field in these tables' fixture rows
      append_only[table] = { watermark_before: null, watermark_after: "0", rows_added: rows, files: [{ path, rows, sha256_gz: sha(gz) }] };
    }
    writeFileSync(join(root, `csv/${backup}/backup.json`), JSON.stringify({ format: 1, backup, source: "db", append_only, revisions: {} }));

    // (5) The real SDK command, with the network off for its process.
    const out = join(TMP, "out");
    const p = Bun.spawn(["bun", join(SDK, "bin/inputs.ts"), "--archive", root, "--run", runKey, "--out", out], { cwd: SDK, stdout: "pipe", stderr: "pipe" });
    const [stderr, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
    expect(code, stderr).toBe(0);
    const inputText = readFileSync(join(out, "inputs.csv"), "utf8");
    const manifest = JSON.parse(readFileSync(join(out, "inputs.manifest.json"), "utf8"));
    expect(manifest).toMatchObject({ backup_id: backup, run_key: runKey, asof: ASOF, source: "db", code_revision: buildIdentity, sha256: sha(inputText) });
    expect(manifest.methodology).toMatchObject({ id: run.methodologyVersionId, label: "sdk-roundtrip" });

    // (6) Exact membership: the generated input is the vintage the backend loader resolves.
    const vintage = (await loadFrozenVintage(frozen.vintageId))!;
    const fromBackend: RawIndicatorHistory = {};
    for (const m of vintage.members) {
      const id = seriesForStorageKey(m.sourceKey);
      if (id && m.marketDate) (fromBackend[id] ??= []).push({ date: m.marketDate, value: m.value });
    }
    for (const id in fromBackend) fromBackend[id]!.sort((a, b) => (a.date < b.date ? -1 : 1));
    const generated = parseInput(inputText, { replay: true });
    expect(generated.rows).toBe(vintage.members.length);
    expect(manifest.row_count).toBe(vintage.members.length);
    expect(generated.history).toEqual(fromBackend);
    // The revision after the freeze never reaches the run's input.
    expect(generated.history.VIX!.find((x) => x.date === revisedDate)!.value).toBe(original);

    // (7) Report bytes: identical through the generated file and the backend-loaded vintage.
    const a = JSON.stringify(buildReport(runRegime(generated.history, { asof: ASOF }), { full: true }));
    const b = JSON.stringify(buildReport(runRegime(fromBackend, { asof: ASOF }), { full: true }));
    expect(a).toBe(b);
    expect(JSON.parse(a).backtest).not.toBeNull();
  },
  { timeout: 120_000 },
);
