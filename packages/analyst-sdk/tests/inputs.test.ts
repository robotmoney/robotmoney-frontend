// Producer to SDK (issue 1404): generate a published run's input from a format 1
// local copy, load it, run it. The two recorded copies under
// tests/fixtures/archive/ describe the same backup reached two ways: the
// API-only fill and a repo backup plus an API increment (see
// scripts/archive-fixture-regenerate.ts). Generation is the real bin/inputs.ts
// process; every later stage runs with fetch replaced by a thrower (preload).
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { openLocalCopy } from "../bin/local-copy.ts";
import {
  ArchiveError,
  RunInputCollector,
  inflateBounded,
  parseCopyCsv,
  selectBackups,
  serializeInputs,
  toObjects,
  type Row,
} from "../src/archive/format1.ts";
import { CalculatedRowError, ReplayContractError, parseInput, parseSourceCsv } from "../src/input/load.ts";
import { buildReport, runRegime } from "../src/run.ts";

setDefaultTimeout(180_000);
const DIR = import.meta.dir;
const PKG = join(DIR, "..");
const ARCHIVE = join(DIR, "fixtures/archive");
const FACTS = JSON.parse(readFileSync(join(ARCHIVE, "facts.json"), "utf8"));
const [RUN1, RUN2] = Object.keys(FACTS.runs) as [string, string];
const COPIES = ["api-only", "repo-plus-increment"] as const;
const TMP = mkdtempSync(join(DIR, ".inputs-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

const sha = (b: Uint8Array | string) => new Bun.CryptoHasher("sha256").update(b).digest("hex");

async function generate(archive: string, run: string, json = false): Promise<{ code: number; stderr: string; dir: string }> {
  const dir = mkdtempSync(join(TMP, "out-"));
  const p = Bun.spawn(["bun", join(PKG, "bin/inputs.ts"), "--archive", archive, "--run", run, "--out", dir, ...(json ? ["--json"] : [])], { cwd: PKG, stdout: "pipe", stderr: "pipe" });
  const [stderr, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
  return { code, stderr, dir };
}

function treeHash(root: string): string {
  const h = new Bun.CryptoHasher("sha256");
  const walk = (d: string) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else h.update(p.slice(root.length)).update(readFileSync(p));
    }
  };
  walk(root);
  return h.digest("hex");
}

// Every table of a copy, as objects, read straight from the files.
function tables(copy: string): Record<string, Row[]> {
  const out: Record<string, Row[]> = {};
  const csv = join(ARCHIVE, copy, "csv");
  for (const b of readdirSync(csv).sort()) {
    for (const f of readdirSync(join(csv, b, "data"))) {
      const t = f.slice(0, f.indexOf("."));
      (out[t] ??= []).push(...toObjects(parseCopyCsv(gunzipSync(readFileSync(join(csv, b, "data", f))).toString("utf8"))));
    }
  }
  return out;
}

describe("generation from both local copies", () => {
  const before = treeHash(ARCHIVE);
  const results = Promise.all(
    COPIES.flatMap((c) => [RUN1, RUN2].flatMap((r) => [false, true].map(async (json) => ({ c, r, json, g: await generate(join(ARCHIVE, c), r, json) })))),
  );

  test("CSV and JSON from the API-only copy and the repo-plus-increment copy are identical; reports are byte-identical", async () => {
    const all = await results;
    for (const x of all) expect(x.g.code, `${x.c} ${x.r} ${x.json}: ${x.g.stderr}`).toBe(0);
    for (const run of [RUN1, RUN2]) {
      const mine = all.filter((x) => x.r === run);
      const files = mine.map((x) => readFileSync(join(x.g.dir, x.json ? "inputs.json" : "inputs.csv"), "utf8"));
      const manifests = mine.map((x) => readFileSync(join(x.g.dir, "inputs.manifest.json"), "utf8"));
      // Same backup reached two ways: the same bytes per format, and the same manifest.
      expect(files[0]).toBe(files[2]!);
      expect(files[1]).toBe(files[3]!);
      expect(manifests[0]).toBe(manifests[2]!);
      const loaded = files.map((t) => parseInput(t, { replay: true }));
      for (const l of loaded) expect(l.history).toEqual(loaded[0]!.history);
      const asof = FACTS.runs[run].asof;
      const reports = loaded.map((l) => JSON.stringify(buildReport(runRegime(l.history, { asof }), { full: true })));
      for (const r of reports) expect(r).toBe(reports[0]!);
    }
  });

  test("the input is exactly the run's frozen vintage, not the newest values", async () => {
    const all = await results;
    const csvOf = (run: string) => readFileSync(join(all.find((x) => x.r === run && !x.json && x.c === "api-only")!.g.dir, "inputs.csv"), "utf8");
    const vix = (text: string) => parseInput(text, { replay: true }).history.VIX!.find((p) => p.date === FACTS.revised.date)!.value;
    // Run 1 froze the original VIX value; the revision collected later belongs to run 2 only.
    expect(vix(csvOf(RUN1))).toBe(Number(FACTS.revised.run1Value));
    expect(vix(csvOf(RUN2))).toBe(Number(FACTS.revised.run2Value));
    // Every member is accounted for: input rows plus members of other consumers.
    for (const run of [RUN1, RUN2]) {
      const rows = csvOf(run).trimEnd().split("\n").length - 1;
      const foreign = run === RUN2 ? 1 : 0;
      expect(rows + foreign).toBe(FACTS.runs[run].members);
      const max = csvOf(run).split("\n").slice(1).filter(Boolean).reduce((m, l) => (l.slice(0, 10) > m ? l.slice(0, 10) : m), "");
      expect(max <= FACTS.runs[run].asof).toBe(true);
    }
    expect(all.find((x) => x.r === RUN2)!.g.stderr).toContain(`${FACTS.foreignKey} 1`);
  });

  test("stored values are copied as their exact text; ratios replay as calculated with no legs invented", async () => {
    const all = await results;
    const text = readFileSync(join(all.find((x) => x.r === RUN2 && !x.json && x.c === "api-only")!.g.dir, "inputs.csv"), "utf8");
    const svv = tables("api-only").source_value_versions!;
    const stored = new Map(svv.map((r) => [`${r.source_key}|${r.market_date}`, r.value]));
    const lines = text.trimEnd().split("\n");
    expect(lines[0]).toBe("date,series,value,kind");
    const extra: Record<string, string> = { SPX: "backtest:^GSPC", ETH: "backtest:ETH-USD", TBILL3M: "backtest:DTB3" };
    let calculated = 0;
    for (const l of lines.slice(1)) {
      const [date, series, value, kind] = l.split(",");
      const key = extra[series!] ?? `raw_indicator_history:${series}`;
      if (!(series === "VIX" && date === FACTS.revised.date)) expect(value).toBe(stored.get(`${key}|${date}`)!);
      if (kind === "calculated") calculated++;
    }
    expect(calculated).toBeGreaterThan(0);
    const series = new Set(lines.slice(1).map((l) => l.split(",")[1]));
    expect(series.has("COPPER_GOLD")).toBe(true);
    for (const leg of ["HG=F", "GC=F", "IWM", "SPY"]) expect(series.has(leg)).toBe(false);
    // The replay file is refused as source data, and its ratio rows are refused by the source-only contract.
    expect(() => parseInput(text)).toThrow(ReplayContractError);
    const ratioRow = lines.find((l) => l.endsWith(",calculated"))!.split(",").slice(0, 3).join(",");
    expect(() => parseSourceCsv(`date,series,value\n${ratioRow}\n`)).toThrow(CalculatedRowError);
  });

  test("generation reads frozen records and writes only the derived input: the local copy and the published bytes are unchanged", async () => {
    await results;
    expect(treeHash(ARCHIVE)).toBe(before);
    for (const c of COPIES) {
      for (const s of tables(c).analytics_output_snapshots!) expect(sha(s.payload_json!)).toBe(s.payload_sha256!);
    }
  });

  test("identical inputs give identical bytes; a substituted current value is a visible input change, not method drift", async () => {
    const all = await results;
    const dir = all.find((x) => x.r === RUN1 && !x.json && x.c === "api-only")!.g.dir;
    const text = readFileSync(join(dir, "inputs.csv"), "utf8");
    const asof = FACTS.runs[RUN1].asof;
    const run = (t: string) => JSON.stringify(buildReport(runRegime(parseInput(t, { replay: true }).history, { asof }), { full: true }));
    expect(run(text)).toBe(run(text));
    // AN-15 evidence: the newest (revised) VIX in place of the frozen one is a
    // different input (different sha256, so its manifest no longer matches) and
    // may give a different report. That is an input correction, recorded apart
    // from method parity, which holds on identical inputs above.
    const substituted = text.replace(`${FACTS.revised.date},VIX,${FACTS.revised.run1Value},`, `${FACTS.revised.date},VIX,${FACTS.revised.run2Value},`);
    expect(substituted).not.toBe(text);
    expect(sha(substituted)).not.toBe(JSON.parse(readFileSync(join(dir, "inputs.manifest.json"), "utf8")).sha256);
    expect(run(substituted)).not.toBe(run(text));
  });
});

describe("incomplete or corrupt copies are refused", () => {
  const copyOf = (name: string) => {
    const d = mkdtempSync(join(TMP, "copy-"));
    cpSync(join(ARCHIVE, name), d, { recursive: true });
    return d;
  };
  const svvPath = (root: string, backup: string) => {
    const dir = join(root, "csv", backup, "data");
    return join(dir, readdirSync(dir).find((f) => f.startsWith("source_value_versions."))!);
  };
  const B1 = "2026-08-02T000000Z";

  test("a listed file with a corrupt hash, a wrong row count, or missing", async () => {
    const corrupt = copyOf("api-only");
    const p = svvPath(corrupt, FACTS.backup);
    const b = readFileSync(p);
    b[b.length - 5] ^= 0xff;
    writeFileSync(p, b);
    const counted = copyOf("api-only");
    const recPath = join(counted, "csv", FACTS.backup, "backup.json");
    const rec = JSON.parse(readFileSync(recPath, "utf8"));
    rec.append_only.analytics_vintage_members.files[0].rows += 1;
    writeFileSync(recPath, JSON.stringify(rec));
    const missing = copyOf("api-only");
    rmSync(svvPath(missing, FACTS.backup));
    const [a, c, m] = await Promise.all([generate(corrupt, RUN1), generate(counted, RUN1), generate(missing, RUN1)]);
    expect(a.code).toBe(1);
    expect(a.stderr).toMatch(/corrupt local copy: .*source_value_versions.* (is not a readable gzip|content sha256)/);
    expect(c.code).toBe(1);
    expect(c.stderr).toMatch(/corrupt local copy: .*analytics_vintage_members.* rows, the record says/);
    expect(m.code).toBe(1);
    expect(m.stderr).toMatch(/incomplete local copy: .* is listed in its backup record but missing/);
    for (const g of [a, c, m]) expect(readdirSync(g.dir)).toEqual([]);
  });

  test("a missing backup in the middle of the copy, an unknown run, an unknown as-of backup", async () => {
    const gap = copyOf("repo-plus-increment");
    rmSync(join(gap, "csv", B1), { recursive: true });
    const [g, u, s] = await Promise.all([
      generate(gap, RUN2),
      generate(join(ARCHIVE, "api-only"), "00000000-0000-4000-8000-000000000000"),
      (async () => {
        const dir = mkdtempSync(join(TMP, "out-"));
        const p = Bun.spawn(["bun", join(PKG, "bin/inputs.ts"), "--archive", join(ARCHIVE, "api-only"), "--run", RUN1, "--as-of", "2020-01-01T000000Z", "--out", dir], { stderr: "pipe", stdout: "pipe" });
        return { code: await p.exited, stderr: await new Response(p.stderr).text() };
      })(),
    ]);
    expect(g.code).toBe(1);
    expect(g.stderr).toMatch(/incomplete local copy: backup 2026-08-16T000000Z continues .*a backup is missing/);
    expect(u.code).toBe(1);
    expect(u.stderr).toMatch(/is not in the local copy's run ledger/);
    expect(s.code).toBe(1);
    expect(s.stderr).toMatch(/backup 2020-01-01T000000Z is not in the local copy/);
  });

  test("as of the repo backup alone, run 2 does not exist yet", async () => {
    const dir = mkdtempSync(join(TMP, "out-"));
    const p = Bun.spawn(["bun", join(PKG, "bin/inputs.ts"), "--archive", join(ARCHIVE, "repo-plus-increment"), "--run", RUN2, "--as-of", B1, "--out", dir], { stderr: "pipe", stdout: "pipe" });
    expect(await p.exited).toBe(1);
    expect(await new Response(p.stderr).text()).toMatch(/not in the local copy's run ledger/);
    const ok = Bun.spawn(["bun", join(PKG, "bin/inputs.ts"), "--archive", join(ARCHIVE, "repo-plus-increment"), "--run", RUN1, "--as-of", B1, "--out", dir], { stderr: "pipe", stdout: "pipe" });
    expect(await ok.exited).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, "inputs.manifest.json"), "utf8"))).toMatchObject({ backup_id: B1, source: "db", run_key: RUN1 });
  });
});

describe("run membership (pure)", () => {
  const t = tables("api-only");
  const base = () => ({
    runs: t.analytics_ledger_runs!.map((r) => ({ ...r })),
    methodologies: t.analytics_ledger_methodology_versions!,
    vintages: t.analytics_data_vintages!.map((r) => ({ ...r })),
    members: t.analytics_vintage_members!.map((r) => ({ ...r })),
  });
  const collect = (tb: ReturnType<typeof base>, versions: Row[] = t.source_value_versions!) => {
    const c = new RunInputCollector(RUN1, tb);
    c.addVersions(versions);
    return c.finish();
  };

  test("the complete vintage collects; serialization keeps the stored text", () => {
    const r = collect(base());
    expect(r.run).toMatchObject({ runKey: RUN1, asof: FACTS.runs[RUN1].asof, memberCount: FACTS.runs[RUN1].members, codeRevision: FACTS.build });
    expect(serializeInputs(r.rows, "csv").split("\n")[0]).toBe("date,series,value,kind");
    expect(serializeInputs(r.rows.filter((x) => x.kind === "source"), "csv").split("\n")[0]).toBe("date,series,value");
  });

  test("corrupt membership: member_count, a member's storage key, overlapping ranges", () => {
    const a = base();
    a.vintages.find((v) => v.run_id === "101")!.member_count = String(FACTS.runs[RUN1].members + 1);
    expect(() => collect(a)).toThrow(/records .* members but its member ranges cover/);
    const b = base();
    b.members.find((m) => m.vintage_id === "201")!.source_key = "raw_indicator_history:NOPE";
    expect(() => collect(b)).toThrow(/but the vintage lists it under raw_indicator_history:NOPE/);
    const c = base();
    const m0 = c.members.find((m) => m.vintage_id === "201" && m.last_source_value_version_id)!;
    c.members.push({ ...m0, id: "999", last_source_value_version_id: null });
    c.vintages.find((v) => v.run_id === "101")!.member_count = String(FACTS.runs[RUN1].members + 1);
    expect(() => collect(c)).toThrow(/overlap/);
  });

  test("a partial vintage is refused, never generated", () => {
    const versions = t.source_value_versions!.filter((r) => r.id !== "5");
    expect(() => collect(base(), versions)).toThrow(ArchiveError);
    expect(() => collect(base(), versions)).toThrow(/incomplete local copy: vintage 201 .*first missing ids 5\b/);
  });

  test("a non-regime run, a run with no vintage, and duplicate version ids are refused", () => {
    const a = base();
    a.runs.find((r) => r.run_key === RUN1)!.tool_id = "research";
    expect(() => collect(a)).toThrow(/not a regime run/);
    const b = base();
    b.vintages = b.vintages.filter((v) => v.run_id !== "101");
    expect(() => collect(b)).toThrow(/0 frozen vintages/);
    expect(() => collect(base(), [...t.source_value_versions!, t.source_value_versions![0]!])).toThrow(/appears twice/);
  });

  test("records: format, self-naming, as-of selection", () => {
    const rec = (id: string, extra: object = {}) => JSON.stringify({ format: 1, backup: id, append_only: {}, revisions: {}, ...extra });
    expect(() => selectBackups({})).toThrow(/no format 1 backups/);
    expect(() => selectBackups({ "2026-01-01T000000Z": rec("2026-01-02T000000Z") })).toThrow(/record says backup/);
    expect(() => selectBackups({ "2026-01-01T000000Z": rec("2026-01-01T000000Z", { format: 2 }) })).toThrow(/not format 1/);
    expect(() => selectBackups({ "2026-01-01T000000Z": rec("2026-01-01T000000Z", { source: "web" }) })).toThrow(/source must be/);
    const two = { "2026-01-01T000000Z": rec("2026-01-01T000000Z"), "2026-01-02T000000Z": rec("2026-01-02T000000Z") };
    expect(selectBackups(two, "2026-01-01T000000Z").map((r) => r.backup)).toEqual(["2026-01-01T000000Z"]);
    expect(selectBackups(two).map((r) => r.backup)).toEqual(["2026-01-01T000000Z", "2026-01-02T000000Z"]);
  });

  test("a listed path outside its backup directory is refused", () => {
    const id = "2026-01-01T000000Z";
    const rec = (path: string) =>
      JSON.stringify({ format: 1, backup: id, revisions: {}, append_only: { t: { watermark_before: null, watermark_after: "1", files: [{ path, rows: 1, sha256_raw: "0".repeat(64) }] } } });
    const bad = ["/abs/x.csv.gz", `csv/${id}/../../outside/x`, `csv/${id}/data/../x.csv.gz`, "csv/2026-01-02T000000Z/data/x.csv.gz", `csv/${id}//x`, `csv/${id}/./x`, `csv/${id}\\..\\x`, `csv/${id}/x\0y`];
    for (const p of bad) expect(() => selectBackups({ [id]: rec(p) }), p).toThrow(/is not a file inside/);
    expect(selectBackups({ [id]: rec(`csv/${id}/data/t.csv.gz`) }).length).toBe(1);
  });

  test("COPY CSV: quoted fields, doubled quotes, NULL versus empty string", () => {
    const p = parseCopyCsv('a,b,c\n1,"x,""y""\nz",\n2,"",3\n');
    expect(p.header).toEqual(["a", "b", "c"]);
    expect(p.rows).toEqual([["1", 'x,"y"\nz', null], ["2", "", "3"]]);
    expect(() => parseCopyCsv('a,b\n1,"x\n')).toThrow(ArchiveError);
    expect(() => parseCopyCsv("a,b\n1,2,3\n")).toThrow(ArchiveError);
  });
});

// Issue 1444: an archive's identity is its content. The downloader (the local
// copy reader) decompresses, then verifies the hash of the uncompressed bytes,
// so a correct archive is accepted whatever gzip encoder wrote it.
describe("archive identity is the content, not the gzip encoder", () => {
  const ID = "2026-01-01T000000Z";
  const TABLE = "analytics_ledger_runs";
  const CONTENT = "id,run_key\n1,a\n2,b\n";
  const PATH = `csv/${ID}/data/${TABLE}.2026-01-01T000000Z_2026-01-01T000000Z.csv.gz`;
  const copyWith = (gz: Uint8Array, content = CONTENT): string => {
    const root = mkdtempSync(join(TMP, "enc-"));
    mkdirSync(join(root, `csv/${ID}/data`), { recursive: true });
    writeFileSync(join(root, PATH), gz);
    const file = { path: PATH, rows: 2, bytes_raw: Buffer.byteLength(content), sha256_raw: sha(content) };
    writeFileSync(
      join(root, `csv/${ID}/backup.json`),
      JSON.stringify({ format: 1, backup: ID, append_only: { [TABLE]: { watermark_before: null, watermark_after: "2", files: [file] } }, revisions: {} }),
    );
    return root;
  };
  const encoders: Record<string, () => Uint8Array> = {
    bun: () => Bun.gzipSync(Buffer.from(CONTENT)),
    "zlib-1": () => gzipSync(Buffer.from(CONTENT), { level: 1 }),
    "zlib-9": () => gzipSync(Buffer.from(CONTENT), { level: 9 }),
  };

  test("a correct archive is accepted whatever encoder produced its gzip", () => {
    const gzips = new Set<string>();
    for (const [name, make] of Object.entries(encoders)) {
      const gz = make();
      gzips.add(sha(gz));
      const copy = openLocalCopy(copyWith(gz));
      expect(copy.tables[TABLE], name).toEqual([{ id: "1", run_key: "a" }, { id: "2", run_key: "b" }]);
    }
    expect(gzips.size, "the encoders must differ for this to test anything").toBeGreaterThan(1);
  });

  test("an archive whose decompressed bytes differ is refused, even when its gzip is valid", () => {
    const other = CONTENT.replace("b\n", "c\n");
    for (const make of [() => Bun.gzipSync(Buffer.from(other)), () => gzipSync(Buffer.from(other), { level: 1 })]) {
      expect(() => openLocalCopy(copyWith(make()))).toThrow(/content sha256 .* does not match the record/);
    }
  });

  const copyRecorded = (gz: Uint8Array, file: Record<string, unknown>): string => {
    const root = copyWith(gz);
    const rec = JSON.parse(readFileSync(join(root, `csv/${ID}/backup.json`), "utf8"));
    rec.append_only[TABLE].files[0] = { ...rec.append_only[TABLE].files[0], ...file };
    for (const k of Object.keys(file)) if (file[k] === undefined) delete rec.append_only[TABLE].files[0][k];
    writeFileSync(join(root, `csv/${ID}/backup.json`), JSON.stringify(rec));
    return root;
  };

  test("a small gzip that inflates far past the record's bytes_raw is refused, naming the file", () => {
    // 80 MB of zeros is about 80 KB on disk: the reader must stop at bytes_raw + 1 bytes.
    const bomb = gzipSync(Buffer.alloc(80 * 1024 * 1024));
    expect(bomb.length).toBeLessThan(200_000);
    const root = copyRecorded(bomb, { bytes_raw: 10 });
    let err: unknown;
    try {
      openLocalCopy(root);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ArchiveError);
    expect((err as Error).message).toContain(PATH);
    expect((err as Error).message).toContain("bytes_raw");
  });

  test("an inflated length of bytes_raw + 1 is refused before hashing", () => {
    const content = CONTENT + "x";
    const root = copyRecorded(gzipSync(Buffer.from(content)), { bytes_raw: Buffer.byteLength(CONTENT), sha256_raw: sha(content) });
    // The record's hash matches the longer content, so only the length check can refuse it.
    expect(() => openLocalCopy(root)).toThrow(/inflates to .*bytes_raw/);
    // And a shorter inflate is refused the same way.
    const short = copyRecorded(gzipSync(Buffer.from(CONTENT)), { bytes_raw: Buffer.byteLength(CONTENT) + 1 });
    expect(() => openLocalCopy(short)).toThrow(/inflates to .*bytes_raw/);
  });

  test("inflateBounded passes maxOutputLength of min(bytes_raw, 64 MB) + 1 to gunzip", () => {
    for (const [bytesRaw, want] of [[10, 11], [100 * 1024 * 1024, 67108865]] as const) {
      const seen: unknown[] = [];
      const spy = ((buf: Uint8Array, opts?: { maxOutputLength?: number }) => {
        seen.push(opts?.maxOutputLength);
        return new Uint8Array(bytesRaw > 1000 ? 0 : bytesRaw);
      }) as unknown as typeof gunzipSync;
      try {
        inflateBounded(new Uint8Array(0), bytesRaw, "f", spy);
      } catch (e) {
        expect(e).toBeInstanceOf(ArchiveError);
      }
      expect(seen).toEqual([want]);
      expect(want).toBe(Math.min(bytesRaw, 67108864) + 1);
    }
  });

  test("a listed file with no sha256_raw is refused, naming the field", () => {
    const root = copyRecorded(gzipSync(Buffer.from(CONTENT)), { sha256_raw: undefined });
    expect(() => openLocalCopy(root)).toThrow(/sha256_raw/);
  });

  test("a file that is not a gzip is corrupt, and a missing one is incomplete", () => {
    expect(() => openLocalCopy(copyWith(Buffer.from("not gzip")))).toThrow(/not a readable gzip/);
    const root = copyWith(gzipSync(Buffer.from(CONTENT)));
    rmSync(join(root, PATH));
    expect(() => openLocalCopy(root)).toThrow(/incomplete local copy/);
  });
});
