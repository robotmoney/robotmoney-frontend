// The Base asset universe (issue 1400): the assets a vault can hold on Base
// without KYC, each with its own cap, plus the group caps (Bitcoin at most 10%,
// one lending protocol at most 35%, Morpho at most 30% with 12% per curator).
//
// Pure: no fs, env or network (scripts/tests/unit/analyst-sdk-purity.test.ts).
// The shipped file is a static JSON import; a member's own file is read in bin/
// and passed in as parsed JSON.
import shipped from "../../universe/base-universe.json" with { type: "json" };

export type UniverseTier = "eligible" | "watchlist";

export interface UniverseAsset {
  /** The id a rule file names the holding by (BTC, AAVE, SUSDS, ...). */
  id: string;
  name: string;
  sleeve: string;
  chain: string;
  /** Token or receipt-token address, or null when the export names none. */
  contract: string | null;
  liquidityUsd: number | null;
  /** Percent per year. */
  yieldPct: number | null;
  tier: UniverseTier;
  /** Percent of NAV the asset may hold on its own. */
  maxWeight: number;
  /** The price or yield series, as a `<provider>:<symbol>` source id, or null. */
  series: string | null;
}

export interface UniverseGroup {
  id: string;
  name: string;
  members: string[];
  /** Percent of NAV the members may hold together. */
  cap: number;
}

export interface Universe {
  /** The date the file was exported (YYYY-MM-DD). */
  exported: string;
  source: string;
  assets: UniverseAsset[];
  groups: UniverseGroup[];
}

export class UniverseError extends Error {
  override readonly name = "UniverseError";
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isNumOrNull = (v: unknown) => v === null || isNum(v);
const isStrOrNull = (v: unknown) => v === null || isStr(v);
const isPct = (v: unknown): v is number => isNum(v) && v >= 0 && v <= 100;

/**
 * Validate and return a universe. With no argument, the shipped
 * `universe/base-universe.json`; otherwise the parsed JSON of a member's file.
 * Throws UniverseError naming the first bad field.
 */
export function loadUniverse(data: unknown = shipped): Universe {
  if (!isObj(data)) throw new UniverseError("universe: not a JSON object");
  if (!isStr(data.exported) || !/^\d{4}-\d{2}-\d{2}$/.test(data.exported)) throw new UniverseError("universe: exported must be a YYYY-MM-DD date");
  if (!isStr(data.source)) throw new UniverseError("universe: source missing");
  if (!Array.isArray(data.assets) || data.assets.length === 0) throw new UniverseError("universe: assets must be a non-empty array");
  if (!Array.isArray(data.groups)) throw new UniverseError("universe: groups must be an array");
  const ids = new Set<string>();
  data.assets.forEach((a: unknown, i: number) => {
    const at = `universe: assets[${i}]`;
    if (!isObj(a) || !isStr(a.id)) throw new UniverseError(`${at}: id missing`);
    const where = `universe: asset ${a.id}`;
    if (ids.has(a.id)) throw new UniverseError(`${where}: duplicate id`);
    ids.add(a.id);
    for (const k of ["name", "sleeve", "chain"] as const) if (!isStr(a[k])) throw new UniverseError(`${where}: ${k} missing`);
    if (!isStrOrNull(a.contract)) throw new UniverseError(`${where}: contract must be a string or null`);
    if (!isStrOrNull(a.series)) throw new UniverseError(`${where}: series must be a string or null`);
    for (const k of ["liquidityUsd", "yieldPct"] as const) if (!isNumOrNull(a[k])) throw new UniverseError(`${where}: ${k} must be a number or null`);
    if (a.tier !== "eligible" && a.tier !== "watchlist") throw new UniverseError(`${where}: tier must be eligible or watchlist`);
    if (!isPct(a.maxWeight)) throw new UniverseError(`${where}: maxWeight must be a percent, 0 to 100`);
  });
  const groupIds = new Set<string>();
  data.groups.forEach((g: unknown, i: number) => {
    if (!isObj(g) || !isStr(g.id)) throw new UniverseError(`universe: groups[${i}]: id missing`);
    const where = `universe: group ${g.id}`;
    if (groupIds.has(g.id)) throw new UniverseError(`${where}: duplicate id`);
    groupIds.add(g.id);
    if (!isStr(g.name)) throw new UniverseError(`${where}: name missing`);
    if (!isPct(g.cap)) throw new UniverseError(`${where}: cap must be a percent, 0 to 100`);
    if (!Array.isArray(g.members) || g.members.length === 0) throw new UniverseError(`${where}: members must be a non-empty array`);
    for (const m of g.members) if (!isStr(m) || !ids.has(m)) throw new UniverseError(`${where}: member ${String(m)} is not an asset in the universe`);
  });
  return data as unknown as Universe;
}

/** Percent of NAV per holding id. */
export type Holdings = Record<string, number>;
/** Holdings per state (risk_off, neutral, risk_on, or any other state name). */
export type HoldingsByState = Record<string, Holdings>;

export type HoldingFindingKind = "outside_universe" | "asset_cap" | "group_cap";

export interface HoldingFinding {
  kind: HoldingFindingKind;
  state: string;
  /** The holding id; for a group cap, the group id. */
  holding: string;
  weight: number;
  /** The cap that was exceeded; null when the holding is not in the universe. */
  cap: number | null;
  message: string;
}

const EPS = 1e-9;

/**
 * Every holding, per state, that is not in the universe or whose weight is over
 * its own cap or a group cap. An empty array means the holdings are inside the
 * universe. A zero weight is not a holding.
 */
export function checkHoldings(holdingsByState: HoldingsByState, universe: Universe): HoldingFinding[] {
  const byId = new Map(universe.assets.map((a) => [a.id, a]));
  const out: HoldingFinding[] = [];
  for (const [state, holdings] of Object.entries(holdingsByState)) {
    for (const [holding, weight] of Object.entries(holdings)) {
      if (weight === 0) continue;
      const asset = byId.get(holding);
      if (!asset) {
        out.push({ kind: "outside_universe", state, holding, weight, cap: null,
          message: `${state}: ${holding} at ${weight}% is not in the universe (cap: none, the asset is not eligible)` });
      } else if (weight > asset.maxWeight + EPS) {
        out.push({ kind: "asset_cap", state, holding, weight, cap: asset.maxWeight,
          message: `${state}: ${holding} at ${weight}% is over its cap of ${asset.maxWeight}%` });
      }
    }
    for (const g of universe.groups) {
      const weight = g.members.reduce((s, m) => s + (holdings[m] ?? 0), 0);
      if (weight > g.cap + EPS) {
        out.push({ kind: "group_cap", state, holding: g.id, weight, cap: g.cap,
          message: `${state}: group ${g.name} (${g.members.join(", ")}) at ${weight}% is over its cap of ${g.cap}%` });
      }
    }
  }
  return out;
}
