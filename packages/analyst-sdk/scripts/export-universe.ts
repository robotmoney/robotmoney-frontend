// `bun run universe:export <assets.csv> [--groups groups.csv] [--exported YYYY-MM-DD] [--out universe/base-universe.json]`
// Rebuilds universe/base-universe.json from a CSV export of the Base
// Permissionless Asset Universe sheet (issue 1400). Dev-only script: it reads
// and writes local files and lives outside src/, so the SDK stays pure.
//
// assets.csv: one row per asset. Headers are matched case- and
// punctuation-insensitively; each column takes the first header it finds:
//   id | name | sleeve | chain | contract (address) | liquidity (liquidityusd)
//   | yield (yieldpct, apy) | tier | maxweight (cap)
// Empty liquidity, yield, contract and series cells become null. An optional
// `series` column holds the `<provider>:<symbol>` source id.
// groups.csv (optional): id, name, cap, members (members separated by `;`).
// Without it, the groups are kept from the current output file.
// The result is validated with loadUniverse before it is written.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadUniverse, type Universe, type UniverseGroup } from "../src/allocate/universe.ts";

/** RFC 4180 CSV: quoted fields, doubled quotes, commas and newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return rows;
}

const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, "");
const COLUMNS: Record<string, string[]> = {
  id: ["id"], name: ["name"], sleeve: ["sleeve"], chain: ["chain"],
  contract: ["contract", "contractaddress", "address"],
  liquidityUsd: ["liquidityusd", "liquidity"],
  yieldPct: ["yieldpct", "yield", "apy"],
  tier: ["tier"], maxWeight: ["maxweight", "cap"], series: ["series"],
};
const REQUIRED = ["id", "name", "sleeve", "chain", "tier", "maxWeight"];

function table(text: string, what: string): { col: (k: string) => number; body: string[][] } {
  const [header, ...body] = parseCsv(text);
  if (!header) throw new Error(`${what}: empty CSV`);
  const hs = header.map(norm);
  return { col: (k) => (COLUMNS[k] ?? [k]).map((a) => hs.indexOf(a)).find((i) => i >= 0) ?? -1, body };
}

const num = (v: string, where: string): number => {
  const t = v.replace(/[$,%\s]/g, "");
  const n = Number(t);
  if (t === "" || !Number.isFinite(n)) throw new Error(`${where}: not a number: ${v}`);
  return n;
};
const opt = (v: string | undefined) => (v === undefined || v.trim() === "" ? null : v.trim());

export function buildUniverse(assetsCsv: string, groups: UniverseGroup[], exported: string, source: string): Universe {
  const { col, body } = table(assetsCsv, "assets");
  const missing = REQUIRED.filter((k) => col(k) < 0);
  if (missing.length) throw new Error(`assets: missing column(s): ${missing.join(", ")}`);
  const cell = (r: string[], k: string) => (col(k) < 0 ? undefined : r[col(k)]);
  const req = (r: string[], k: string) => (cell(r, k) ?? "").trim();
  const assets = body.map((r, i) => {
    const where = `assets row ${i + 2}`;
    const liq = opt(cell(r, "liquidityUsd")), yld = opt(cell(r, "yieldPct"));
    return {
      id: req(r, "id"), name: req(r, "name"), sleeve: req(r, "sleeve"), chain: req(r, "chain"),
      contract: opt(cell(r, "contract")),
      liquidityUsd: liq === null ? null : num(liq, where), yieldPct: yld === null ? null : num(yld, where),
      tier: req(r, "tier").toLowerCase(), maxWeight: num(req(r, "maxWeight"), where),
      series: opt(cell(r, "series")),
    };
  });
  return loadUniverse({ exported, source, assets, groups });
}

export function parseGroupsCsv(text: string): UniverseGroup[] {
  const { col, body } = table(text, "groups");
  for (const k of ["id", "name", "cap", "members"]) if (col(k) < 0) throw new Error(`groups: missing column ${k}`);
  return body.map((r, i) => ({
    id: (r[col("id")] ?? "").trim(), name: (r[col("name")] ?? "").trim(), cap: num(r[col("cap")] ?? "", `groups row ${i + 2}`),
    members: (r[col("members")] ?? "").split(";").map((m) => m.trim()).filter(Boolean),
  }));
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const val = (f: string) => { const i = args.indexOf(f); return i < 0 ? undefined : args[i + 1]; };
  const flags = ["--groups", "--exported", "--out"];
  const file = args.find((a, i) => !a.startsWith("--") && !flags.includes(args[i - 1] ?? ""));
  if (!file) {
    console.error("usage: bun run universe:export <assets.csv> [--groups groups.csv] [--exported YYYY-MM-DD] [--out path]");
    process.exit(2);
  }
  const out = val("--out") ?? join(dirname(fileURLToPath(import.meta.url)), "..", "universe", "base-universe.json");
  const groupsFile = val("--groups");
  const groups = groupsFile
    ? parseGroupsCsv(readFileSync(groupsFile, "utf8"))
    : existsSync(out) ? loadUniverse(JSON.parse(readFileSync(out, "utf8"))).groups : [];
  const exported = val("--exported") ?? new Date().toISOString().slice(0, 10);
  const source = "Base Permissionless Asset Universe sheet (https://docs.google.com/spreadsheets/d/1vF2gLzP6Nw8tKinUOCme6hEWuwiNLopJytbYL9xm7Qs), CSV export rebuilt by scripts/export-universe.ts";
  const u = buildUniverse(readFileSync(file, "utf8"), groups, exported, source);
  writeFileSync(out, JSON.stringify(u, null, 2) + "\n");
  console.error(`wrote ${out}: ${u.assets.length} assets, ${u.groups.length} groups, exported ${u.exported}`);
}
