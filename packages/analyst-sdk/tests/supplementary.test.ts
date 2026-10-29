// Supplementary series (analyst SDK requirements section 4; D79): the file format,
// the directory rules, the fetch through the HTTP seam, and the `bun run fetch`
// command's refusals. The fetch runs against the recorded Yahoo and FRED bodies
// in fixtures/extract/ through configureHttp; the spawned command is only ever
// given input it rejects before its first request.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertSupplementaryDir, listSupplementary, readSupplementary, supplementaryFiles, writeSupplementary } from "../bin/supplementary-dir.ts";
import { configureHttp } from "../src/extract/http.ts";
import { fredUrl } from "../src/extract/fred.ts";
import { NoObservationsError } from "../src/extract/model-portfolio.ts";
import { fetchSupplementary } from "../src/extract/supplementary.ts";
import { InputRowError } from "../src/input/load.ts";
import {
  formatSupplementaryCsv,
  openSupplementary,
  parseSupplementaryCsv,
  sourceIdOfPath,
  supplementaryPaths,
  SupplementaryError,
} from "../src/input/supplementary.ts";

const PKG = join(import.meta.dir, "..");
const TMP = mkdtempSync(join(import.meta.dir, ".supplementary-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));
afterEach(() => configureHttp({}));

const FIX = join(import.meta.dir, "fixtures/extract");
const meta = { field: "close", fetched_at: "2026-10-28T00:00:00.000Z", fetched_by: "test" };
const pts = [
  { date: "2016-01-04", value: 1060.199951171875 },
  { date: "2016-01-05", value: 0.1 + 0.2 },
  { date: "2016-01-06", value: 1e-7 },
];

describe("the format", () => {
  test("a source id maps to <provider>/<percent-encoded symbol>.csv and back", () => {
    expect(supplementaryPaths("yahoo:GC=F")).toEqual({ file: "yahoo/GC%3DF.csv", manifest: "yahoo/GC%3DF.manifest.json" });
    expect(supplementaryPaths("yahoo:^GSPC").file).toBe("yahoo/%5EGSPC.csv");
    expect(supplementaryPaths("fred:DTB3").file).toBe("fred/DTB3.csv");
    for (const id of ["yahoo:GC=F", "yahoo:^GSPC", "yahoo:HYPE32196-USD", "fred:DTB3"]) expect(sourceIdOfPath(supplementaryPaths(id).file)).toBe(id);
    expect(sourceIdOfPath("yahoo/GC=F.csv")).toBeNull(); // not the canonical encoding
    expect(sourceIdOfPath("yahoo/GC%3DF.manifest.json")).toBeNull();
  });
  test("a malformed source id is refused", () => {
    for (const id of ["GC=F", ":GC=F", "yahoo:", "Yahoo:GC=F", "yahoo:G C", "yahoo:a,b"]) expect(() => supplementaryPaths(id)).toThrow(SupplementaryError);
  });
  test("the file is the source contract and reads back to the same doubles", () => {
    const text = formatSupplementaryCsv("yahoo:GC=F", pts);
    expect(text).toBe("date,series,value\n2016-01-04,yahoo:GC=F,1060.199951171875\n2016-01-05,yahoo:GC=F,0.30000000000000004\n2016-01-06,yahoo:GC=F,1e-7\n");
    expect(parseSupplementaryCsv("yahoo:GC=F", text)).toEqual(pts);
  });
  test("unsorted or repeated dates, non-finite values and a second series are refused", () => {
    expect(() => formatSupplementaryCsv("yahoo:GC=F", [pts[1]!, pts[0]!])).toThrow("strictly ascending");
    expect(() => formatSupplementaryCsv("yahoo:GC=F", [pts[0]!, pts[0]!])).toThrow("strictly ascending");
    expect(() => formatSupplementaryCsv("yahoo:GC=F", [{ date: "2016-01-04", value: NaN }])).toThrow("finite");
    expect(() => parseSupplementaryCsv("yahoo:GC=F", "date,series,value\n2016-01-04,yahoo:SI=F,1\n")).toThrow(InputRowError);
    expect(() => parseSupplementaryCsv("yahoo:GC=F", "date,series,value\n2016-01-05,yahoo:GC=F,1\n2016-01-04,yahoo:GC=F,1\n")).toThrow("strictly ascending");
  });
});

describe("the directory", () => {
  test("write, list and read back; the manifest pins the bytes", () => {
    const dir = join(TMP, "store");
    const m = writeSupplementary(dir, "yahoo:GC=F", pts, meta);
    expect(m).toMatchObject({ series: "yahoo:GC=F", row_count: 3, first_date: "2016-01-04", last_date: "2016-01-06", field: "close" });
    writeSupplementary(dir, "fred:DTB3", [{ date: "2016-01-04", value: 0.2 }], meta);
    expect(listSupplementary(dir)).toEqual(["fred:DTB3", "yahoo:GC=F"]);
    const got = readSupplementary(dir, "yahoo:GC=F");
    expect(got.points).toEqual(pts);
    expect(got.manifest.sha256).toBe(m.sha256);
    const file = join(dir, "yahoo/GC%3DF.csv");
    writeFileSync(file, readFileSync(file, "utf8").replace("1e-7", "2e-7"));
    expect(() => readSupplementary(dir, "yahoo:GC=F")).toThrow("does not match");
  });
  test("an existing series is kept unless replace is asked for", () => {
    const dir = join(TMP, "replace");
    writeSupplementary(dir, "yahoo:GC=F", pts, meta);
    expect(() => writeSupplementary(dir, "yahoo:GC=F", pts.slice(0, 1), meta)).toThrow("--replace");
    writeSupplementary(dir, "yahoo:GC=F", pts.slice(0, 1), meta, { replace: true });
    expect(readSupplementary(dir, "yahoo:GC=F").points).toEqual(pts.slice(0, 1));
  });
  test("a missing series names the command that fetches it", () => {
    expect(() => readSupplementary(join(TMP, "store"), "yahoo:SI=F")).toThrow("bun run fetch --into");
  });
  test("a local copy, its csv folder, a backup and anything inside them are refused", () => {
    const copy = join(TMP, "copy");
    mkdirSync(join(copy, "csv/2026-10-19T202421Z"), { recursive: true });
    writeFileSync(join(copy, "csv/2026-10-19T202421Z/backup.json"), "{}");
    for (const d of [copy, join(copy, "csv"), join(copy, "csv/2026-10-19T202421Z"), join(copy, "extra"), join(copy, "csv/x/y")]) {
      expect(() => assertSupplementaryDir(d)).toThrow("local copy");
    }
    expect(() => writeSupplementary(join(copy, "extra"), "yahoo:GC=F", pts, meta)).toThrow("local copy");
    expect(() => assertSupplementaryDir(join(TMP, "beside-the-copy"))).not.toThrow();
  });
});

describe("openSupplementary over injected files (no filesystem)", () => {
  const FIXTURE = join(import.meta.dir, "fixtures/supplementary");
  const enc = new TextEncoder();
  // A Map of path to bytes, built from the committed fixture; nothing below touches the disk.
  const memory = () => {
    const m = new Map<string, Uint8Array>();
    for (const p of ["yahoo/GC%3DF.csv", "yahoo/GC%3DF.manifest.json"]) m.set(p, new Uint8Array(readFileSync(join(FIXTURE, p))));
    return m;
  };
  const filesOf = (m: Map<string, Uint8Array>) => ({ read: (p: string) => m.get(p) ?? null, list: () => [...m.keys()], label: "mem" });

  test("lists ids sorted and reads a series whose manifest validates", () => {
    const m = memory();
    const fred = formatSupplementaryCsv("fred:DTB3", [{ date: "2024-01-02", value: 5.2 }]);
    m.set("fred/DTB3.csv", enc.encode(fred));
    m.set("fred/notes.txt", enc.encode("ignored"));
    const r = openSupplementary(filesOf(m));
    expect(r.list()).toEqual(["fred:DTB3", "yahoo:GC=F"]);
    const got = r.read("yahoo:GC=F");
    expect(got.points).toHaveLength(4);
    expect(got.manifest).toMatchObject({ series: "yahoo:GC=F", row_count: 4, first_date: "2024-01-02", last_date: "2024-01-05" });
  });
  test("refuses a tampered byte, a wrong row count and a missing manifest; a missing series names bun run fetch", () => {
    const tampered = memory();
    const csv = new TextDecoder().decode(tampered.get("yahoo/GC%3DF.csv")!);
    tampered.set("yahoo/GC%3DF.csv", enc.encode(csv.replace("2042.300048828125", "2042.300048828126")));
    expect(() => openSupplementary(filesOf(tampered)).read("yahoo:GC=F")).toThrow(/sha256 .* does not match/);
    const rows = memory();
    const man = JSON.parse(new TextDecoder().decode(rows.get("yahoo/GC%3DF.manifest.json")!));
    rows.set("yahoo/GC%3DF.manifest.json", enc.encode(JSON.stringify({ ...man, row_count: 5 })));
    expect(() => openSupplementary(filesOf(rows)).read("yahoo:GC=F")).toThrow(/row_count 5 does not match/);
    const noManifest = memory();
    noManifest.delete("yahoo/GC%3DF.manifest.json");
    expect(() => openSupplementary(filesOf(noManifest)).read("yahoo:GC=F")).toThrow("has no yahoo/GC%3DF.manifest.json");
    expect(() => openSupplementary(filesOf(memory())).read("yahoo:SI=F")).toThrow("bun run fetch --into mem yahoo:SI=F");
  });
  test("readSupplementary(dir, id) returns what openSupplementary returns over the same files", () => {
    const fromDisk = readSupplementary(FIXTURE, "yahoo:GC=F");
    expect(fromDisk).toEqual(openSupplementary(filesOf(memory())).read("yahoo:GC=F"));
    expect(fromDisk).toEqual(openSupplementary(supplementaryFiles(FIXTURE)).read("yahoo:GC=F"));
    expect(listSupplementary(FIXTURE)).toEqual(openSupplementary(filesOf(memory())).list());
  });
  test("fredUrl starts at 2010-01-01 by default and at the given start otherwise", () => {
    expect(fredUrl("DTB3").endsWith("cosd=2010-01-01")).toBe(true);
    expect(fredUrl("DTB3", "2016-01-01").endsWith("cosd=2016-01-01")).toBe(true);
  });
});

describe("fetchSupplementary", () => {
  const recorded = () => {
    const urls: string[] = [];
    configureHttp({
      fetch: (async (input: string) => {
        urls.push(String(input));
        return String(input).includes("fredgraph")
          ? new Response(readFileSync(join(FIX, "fred-T10Y2Y.csv"), "utf8"))
          : new Response(readFileSync(join(FIX, "yahoo-VIX.json"), "utf8"), { headers: { "content-type": "application/json" } });
      }) as unknown as typeof fetch,
    });
    return urls;
  };
  const expected = JSON.parse(readFileSync(join(FIX, "expected-points.json"), "utf8")) as Record<"fred" | "yahoo", { points: { date: string; value: number }[] }>;

  test("Yahoo: the recorded chart, cut to the window, through the HTTP seam", async () => {
    const urls = recorded();
    const all = expected.yahoo.points;
    const window = { start: all[1]!.date, end: all.at(-2)!.date };
    const got = await fetchSupplementary("yahoo:^VIX", window);
    expect(got.points).toEqual(all.filter((p) => window.start <= p.date && p.date <= window.end));
    expect(got.field).toContain("adjusted close");
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("/v8/finance/chart/%5EVIX?period1=");
  });
  test("FRED: the recorded CSV from the requested start", async () => {
    const urls = recorded();
    const all = expected.fred.points;
    const got = await fetchSupplementary("fred:T10Y2Y", { start: all[0]!.date, end: all.at(-1)!.date });
    expect(got.points).toEqual(all);
    expect(urls[0]).toContain(`cosd=${all[0]!.date}`);
  });
  test("an empty window and a provider with no client fail without writing anything", async () => {
    recorded();
    await expect(fetchSupplementary("yahoo:^VIX", { start: "1990-01-01", end: "1990-01-31" })).rejects.toThrow(NoObservationsError);
    await expect(fetchSupplementary("coinmetrics:btc.PriceUSD", { start: "2016-01-01", end: "2016-02-01" })).rejects.toThrow("no source client");
  });
});

describe("bun run fetch", () => {
  const run = async (...args: string[]) => {
    const p = Bun.spawn(["bun", join(PKG, "bin/fetch.ts"), ...args], { cwd: TMP, stdout: "pipe", stderr: "pipe" });
    return { code: await p.exited, err: await new Response(p.stderr).text() };
  };
  test("usage errors exit 2 before any request", async () => {
    expect(await run("yahoo:GC=F")).toMatchObject({ code: 2 });
    expect((await run("--into", "store")).err).toContain("at least one source id");
    expect((await run("--into", "store", "--start", "2016-1-1", "yahoo:GC=F")).err).toContain("--start must be YYYY-MM-DD");
    expect((await run("--into", "store", "coinmetrics:btc.PriceUSD")).err).toContain("no source client");
    expect((await run("--into", "store", "GC=F")).code).toBe(2);
  });
  test("a local copy as the target exits 1 before any request", async () => {
    const r = await run("--into", join(TMP, "copy/extra"), "yahoo:GC=F");
    expect(r.code).toBe(1);
    expect(r.err).toContain("local copy");
  });
});
