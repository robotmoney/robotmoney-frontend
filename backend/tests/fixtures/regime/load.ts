// Test-only fixture loaders. Vendored ground-truth from agentjuno/robotmoney
// (scripts/regime + data/regime + public/data), gzipped to keep the repo lean.
// Gunzipped in-test via node:zlib (Bun supports it). FAIL LOUDLY if a fixture
// is missing — never skip (repo test-coverage policy).
import { gunzipSync } from "node:zlib";

const DIR = new URL(".", import.meta.url).pathname;

async function readGz(name: string): Promise<string> {
  const path = DIR + name;
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(`missing fixture ${path} — regime fidelity test cannot run`);
  }
  const buf = await file.arrayBuffer();
  return gunzipSync(Buffer.from(buf)).toString("utf8");
}

export interface RawRow { date: string; value: number; }

// raw-indicator-history.csv → { [indicatorId]: {date,value}[] } sorted ascending.
// Stores ALIGNED RAW values (pre-transform), one row per (date,indicator) where
// the aligned value is finite. (Confirmed against update.js writeRawHistoryCsv.)
export async function loadRawIndicatorHistory(): Promise<Record<string, RawRow[]>> {
  const text = await readGz("raw-indicator-history.csv.gz");
  const lines = text.split("\n");
  const out: Record<string, RawRow[]> = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const c = line.indexOf(",");
    const c2 = line.indexOf(",", c + 1);
    const date = line.slice(0, c);
    const id = line.slice(c + 1, c2);
    const v = parseFloat(line.slice(c2 + 1));
    if (!date || !id || !Number.isFinite(v)) continue;
    (out[id] ||= []).push({ date, value: v });
  }
  for (const id in out) out[id].sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

export interface RegimeHistRow {
  date: string;
  macro_index: number; onchain_index: number; composite: number;
  composite_percentile: number; macro_percentile: number; onchain_percentile: number;
  macro_regime: string; onchain_regime: string; regime: string; version: string;
}

// regime-history.csv → ordered array of expected output rows.
export async function loadRegimeHistory(): Promise<RegimeHistRow[]> {
  const text = await readGz("regime-history.csv.gz");
  const lines = text.split("\n").filter((l) => l.length > 0);
  const out: RegimeHistRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].split(",");
    out.push({
      date: p[0],
      macro_index: Number(p[1]), onchain_index: Number(p[2]), composite: Number(p[3]),
      composite_percentile: Number(p[4]), macro_percentile: Number(p[5]), onchain_percentile: Number(p[6]),
      macro_regime: p[7], onchain_regime: p[8], regime: p[9], version: p[10],
    });
  }
  return out;
}

export async function loadJsonGz<T = any>(name: string): Promise<T> {
  return JSON.parse(await readGz(name)) as T;
}
