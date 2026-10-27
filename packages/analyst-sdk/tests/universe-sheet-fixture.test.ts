// The Base Permissionless Asset Universe sheet, as the owner pasted it on
// 2026-10-26, is a TEST FIXTURE ONLY (tests/fixtures/base-universe-sheet.csv).
// This file checks its shape with a small RFC 4180 parser, proves the checks
// can fail (red control), and proves nothing in src/, bin/ or universe/ reads
// the file. No network, no files outside the package.
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const PKG = join(import.meta.dir, "..");
const FIXTURE = join(PKG, "tests/fixtures/base-universe-sheet.csv");

const HEADER = [
  "also", "Asset", "Symbol", "Sleeve", "Tier", "Base contract", "Issuer / protocol",
  "What it is", "Access", "Base DEX liquidity ($k)", "Size ($M)", "Yield (APY)",
  "A (v8) target weight", "Max weight", "Key risks", "Notes", "Source", "Last verified",
];
const COL = (name: string) => HEADER.indexOf(name);
const TIERS = new Set(["Core", "Satellite", "Watchlist", "Speculative"]);

// RFC 4180: quoted fields, "" is an escaped quote, CRLF or LF ends a record.
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      rows.push(row); row = [];
    } else field += c;
  }
  if (quoted) throw new Error("unterminated quoted field");
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const pct = (s: string) => {
  if (!/^\d+(\.\d+)?%$/.test(s)) throw new Error(`not a percentage: ${JSON.stringify(s)}`);
  return Number(s.slice(0, -1));
};

// Every shape assertion in one helper, so the red control can run the same one.
function assertSheet(rows: string[][]): void {
  expect(rows[0]).toEqual(HEADER);
  const data = rows.slice(1);
  expect(data.length).toBe(55);
  for (const r of data) expect(r.length).toBe(18);

  const ids = data.map((r) => r[COL("also")]!);
  expect(new Set(ids).size).toBe(ids.length);
  for (const id of ids) expect(id).toMatch(/^[a-z0-9_]+$/);

  for (const r of data) {
    const addr = r[COL("Base contract")]!;
    if (addr.startsWith("various (e.g. ") || addr === "market-specific") continue;
    expect(addr).toMatch(/^0x[0-9a-f]{40}$/);
  }
  expect(data.filter((r) => !/^0x[0-9a-f]{40}$/.test(r[COL("Base contract")]!)).length).toBe(3);

  for (const r of data) expect(TIERS.has(r[COL("Tier")]!)).toBe(true);

  const target = data.map((r) => pct(r[COL("A (v8) target weight")]!));
  expect(Math.abs(target.reduce((a, b) => a + b, 0) - 100)).toBeLessThanOrEqual(1e-9);
  data.forEach((r, i) => expect(target[i]!).toBeLessThanOrEqual(pct(r[COL("Max weight")]!)));

  for (const r of data) {
    const d = r[COL("Last verified")]!;
    expect(d).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10)).toBe(d);
  }
}

const rows = parseCsv(readFileSync(FIXTURE, "utf8"));
const clone = () => rows.map((r) => [...r]);

describe("Base universe sheet fixture", () => {
  test("parser handles quotes, escaped quotes, embedded commas and newlines", () => {
    expect(parseCsv('a,"b,c","d""e"\r\n"x\ny",,z\n')).toEqual([["a", "b,c", 'd"e'], ["x\ny", "", "z"]]);
  });

  test("the sheet has the expected shape and values", () => {
    assertSheet(rows);
  });

  test("red control: a dropped column fails the assertions", () => {
    const bad = clone();
    bad[5]!.splice(3, 1);
    expect(() => assertSheet(bad)).toThrow();
  });

  test("red control: a changed target weight fails the assertions", () => {
    const bad = clone();
    bad[1]![COL("A (v8) target weight")] = "3.0%";
    expect(() => assertSheet(bad)).toThrow();
  });

  test("red control: a target weight above its max fails the assertions", () => {
    const bad = clone();
    const i = COL("A (v8) target weight");
    const j = COL("Max weight");
    bad[1]![i] = "99.0%";
    bad[1]![j] = "1.0%";
    expect(() => assertSheet(bad)).toThrow();
  });
});

describe("Base universe sheet stays test-only", () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? (n === "node_modules" ? [] : walk(p)) : [p];
    });

  test("nothing in src/, bin/ or universe/ names base-universe-sheet", () => {
    const files = ["src", "bin", "universe"].flatMap((d) => walk(join(PKG, d)));
    expect(files.length).toBeGreaterThan(0);
    const hits = files.filter((f) => readFileSync(f, "utf8").includes("base-universe-sheet"));
    expect(hits).toEqual([]);
  });
});
