// `bun run universe:export <assets.csv> [--groups groups.csv] [--series series.csv] [--exported YYYY-MM-DD] [--out universe/base-universe.json]`
// Rebuilds universe/base-universe.json from a CSV export of the Base
// Permissionless Asset Universe sheet (issue 1400). Dev-only script: it reads
// and writes local files and lives outside src/, so the SDK stays pure.
//
// assets.csv: one row per asset, the sheet's own export (tests/fixtures/base-universe-sheet.csv).
// Headers are matched case- and punctuation-insensitively; each column takes the
// first header it finds:
//   id (also) | name (asset) | sleeve | chain (default base) | contract (base contract)
//   | liquidity (liquidityusd, or base dex liquidity ($k)) | yield (yieldpct, apy, yield (apy))
//   | tier | maxweight (cap)
// An empty liquidity, yield, contract or series cell, or a contract that is not a
// 0x address (`various ...`, `market-specific`), becomes null with a reason in the
// asset's `unavailable` map. An optional `series` column holds the
// `<provider>:<symbol>` source id; `--series series.csv` (id, series, by sheet id) supplies it.
// Asset ids: the nine reference holdings keep the short ids rule files use (RULE_IDS), the rest are the sheet id in capitals.
// groups.csv (optional): id, name, cap, members (members separated by `;`).
// Without it, the groups are kept from the current output file.
// The result is validated with loadUniverse before it is written.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadUniverse, type UnavailableField, type Universe, type UniverseAsset, type UniverseGroup, type UniverseTier } from "../src/allocate/universe.ts";

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
// Headers of the Base Permissionless Asset Universe sheet's CSV export are
// matched here (`also` is the asset id column, `Base DEX liquidity ($k)` is in
// thousands of dollars); the older generic names stay accepted.
const COLUMNS: Record<string, string[]> = {
  id: ["id", "also"], name: ["name", "asset"], sleeve: ["sleeve"], chain: ["chain"],
  contract: ["contract", "contractaddress", "address", "basecontract"],
  liquidityUsd: ["liquidityusd", "liquidity"],
  liquidityK: ["basedexliquidityk"],
  yieldPct: ["yieldpct", "yield", "apy", "yieldapy"],
  tier: ["tier"], maxWeight: ["maxweight", "cap"], series: ["series"],
};
const REQUIRED = ["id", "name", "sleeve", "tier", "maxWeight"];

/**
 * The id a rule file names a holding by. Rule files predate the sheet and name
 * the nine reference holdings by short ids; every other asset is its sheet id
 * in capitals. The sheet's `aave` is the AAVE governance token, not the Aave
 * USDC market the rules call AAVE.
 */
export const RULE_IDS: Readonly<Record<string, string>> = {
  usdc: "USDC", susds: "SUSDS", aave_usdc_base: "AAVE", morpho_gtusdcp_v1: "GT", morpho_spark_usdc: "SPARK",
  morpho_steak_prime_v2: "STEAK", compound_v3_usdc_base: "COMP", dgld: "GOLD", cbbtc: "BTC", aave: "AAVE_TOKEN",
};
const idFor = (sheetId: string) => RULE_IDS[sheetId] ?? RULE_IDS[sheetId.toLowerCase()] ?? sheetId.toUpperCase();

/** The sheet's tier column: Core and Satellite are eligible; Watchlist and Speculative keep their own tier. */
const tierFor = (t: string, where: string): UniverseTier => {
  const k = t.trim().toLowerCase();
  if (k === "core" || k === "satellite" || k === "eligible") return "eligible";
  if (k === "watchlist" || k === "speculative") return k;
  throw new Error(`${where}: unknown tier: ${t}`);
};

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

const EMPTY = "the sheet cell is empty";
const NO_SERIES = "the sheet names no provider symbol and the model portfolio inputs (issue 1398) do not read this asset";

/** series.csv: `id,series` per sheet id, the `<provider>:<symbol>` source id of an asset the model portfolio inputs read. */
export function parseSeriesCsv(text: string): Record<string, string> {
  const { col, body } = table(text, "series");
  for (const k of ["id", "series"]) if (col(k) < 0) throw new Error(`series: missing column ${k}`);
  return Object.fromEntries(body.map((r) => [(r[col("id")] ?? "").trim(), (r[col("series")] ?? "").trim()]));
}

export function buildUniverse(
  assetsCsv: string, groups: UniverseGroup[], exported: string, source: string, seriesById: Record<string, string> = {},
): Universe {
  const { col, body } = table(assetsCsv, "assets");
  const missing = REQUIRED.filter((k) => col(k) < 0);
  if (missing.length) throw new Error(`assets: missing column(s): ${missing.join(", ")}`);
  const cell = (r: string[], k: string) => (col(k) < 0 ? undefined : r[col(k)]);
  const req = (r: string[], k: string) => (cell(r, k) ?? "").trim();
  const assets = body.map((r, i): UniverseAsset => {
    const where = `assets row ${i + 2}`;
    const sheetId = req(r, "id");
    const unavailable: Partial<Record<UnavailableField, string>> = {};
    const liq = opt(cell(r, "liquidityUsd")), liqK = opt(cell(r, "liquidityK")), yld = opt(cell(r, "yieldPct"));
    const liquidityUsd = liq !== null ? num(liq, where) : liqK !== null ? Math.round(num(liqK, where) * 1000) : null;
    if (liquidityUsd === null) unavailable.liquidityUsd = EMPTY;
    const yieldPct = yld === null ? null : num(yld, where);
    if (yieldPct === null) unavailable.yieldPct = EMPTY;
    // Only a 0x address is an address: "various ..." and "market-specific" load as null with the sheet's words.
    const raw = opt(cell(r, "contract"));
    const contract = raw !== null && /^0x[0-9a-fA-F]{40}$/.test(raw) ? raw : null;
    if (contract === null) unavailable.contract = raw === null ? EMPTY : `the sheet gives no single address: "${raw}"`;
    const series = opt(cell(r, "series")) ?? seriesById[sheetId] ?? null;
    if (series === null) unavailable.series = NO_SERIES;
    return {
      id: idFor(sheetId), name: req(r, "name"), sleeve: req(r, "sleeve").toLowerCase().replace(/[^a-z0-9]+/g, "_"),
      chain: req(r, "chain") || "base", contract, liquidityUsd, yieldPct, tier: tierFor(req(r, "tier"), where),
      maxWeight: num(req(r, "maxWeight"), where), series, unavailable,
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
  const flags = ["--groups", "--series", "--exported", "--out"];
  const file = args.find((a, i) => !a.startsWith("--") && !flags.includes(args[i - 1] ?? ""));
  if (!file) {
    console.error("usage: bun run universe:export <assets.csv> [--groups groups.csv] [--series series.csv] [--exported YYYY-MM-DD] [--out path]");
    process.exit(2);
  }
  const out = val("--out") ?? join(dirname(fileURLToPath(import.meta.url)), "..", "universe", "base-universe.json");
  const groupsFile = val("--groups");
  const groups = groupsFile
    ? parseGroupsCsv(readFileSync(groupsFile, "utf8"))
    : existsSync(out) ? loadUniverse(JSON.parse(readFileSync(out, "utf8"))).groups : [];
  const exported = val("--exported") ?? new Date().toISOString().slice(0, 10);
  const seriesFile = val("--series");
  const source = "Base Permissionless Asset Universe sheet (https://docs.google.com/spreadsheets/d/1vF2gLzP6Nw8tKinUOCme6hEWuwiNLopJytbYL9xm7Qs), the owner's CSV export of 2026-10-26 (kept as a test fixture), rebuilt by scripts/export-universe.ts with universe/groups.csv (group caps from the sheet's Notes column) and universe/series.csv";
  const u = buildUniverse(readFileSync(file, "utf8"), groups, exported, source, seriesFile ? parseSeriesCsv(readFileSync(seriesFile, "utf8")) : {});
  writeFileSync(out, JSON.stringify(u, null, 2) + "\n");
  console.error(`wrote ${out}: ${u.assets.length} assets, ${u.groups.length} groups, exported ${u.exported}`);
}
