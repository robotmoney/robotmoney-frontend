// Intent: turn one Robot Money regime snapshot response into a fact sheet an agent can write a qualitative read from:
//         the composite and how it is built, each panel, every indicator with its level, its percentile and what that
//         level means in plain words, the indicators pulling the composite down and up, and recent history.
// Approach: reads the response of GET /api/dashboards/regime-snapshots (production's live API, or a saved copy
//           of the same response) from a file or a URL. Every number printed comes from
//           the response; the only text added is the indicator guide below (what each indicator measures and what a
//           high or low level means). No imports beyond Bun and node built-ins, so the script runs on its own.
// Status: implemented
//
// The research brief says what to explain (the drivers, their levels, the panel moves and the date window). It
// holds no search strings: the agent writes its own questions and searches from it.
//
// usage: bun regime-read.ts [<file or URL>] [--methodology <version>] [--json] [--guide]
//   default source: the live production API, range=400
//   --methodology  read one methodology's line from the live API (the API's own `methodology` parameter), for
//                  example v5 while it is published beside the regime the site shows
//   --json   the facts as JSON instead of markdown
//   --guide  print the indicator guide as markdown and exit

export const DEFAULT_SOURCE = "https://robotmoney.network/api/dashboards/regime-snapshots?range=400";

export type Panel = "macro" | "onchain" | "factor";
export const PANELS: readonly Panel[] = ["macro", "onchain", "factor"];
export const PANEL_NAME: Readonly<Record<Panel, string>> = { macro: "Macro", onchain: "On-chain", factor: "Equity factor" };
export const PANEL_THEME: Readonly<Record<Panel, string>> = {
  macro: "Rates, credit, the dollar, jobs and volatility",
  factor: "US stock trend, breadth, style and valuation",
  onchain: "Crypto activity, valuation and flows",
};

/** What an indicator measures and what a high or a low raw level means, in plain words. */
export interface GuideEntry {
  measures: string;
  high: string;
  low: string;
}

export const GUIDE: Readonly<Record<string, GuideEntry>> = {
  T10Y2Y: { measures: "the 10-year Treasury yield minus the 2-year yield (the yield curve)", high: "long rates sit well above short rates, which usually goes with expected growth", low: "the curve is flat or inverted, which has often come before slowdowns" },
  DFII10: { measures: "the 10-year Treasury yield after inflation (TIPS)", high: "money is expensive after inflation, which tightens financial conditions", low: "money is cheap after inflation, which eases financial conditions" },
  T5YIE: { measures: "the inflation rate the bond market expects over the next 5 years", high: "markets expect higher inflation, which usually goes with stronger demand", low: "markets expect lower inflation, which points to weaker demand" },
  HY_OAS: { measures: "the extra yield lenders demand on junk bonds over Treasuries", high: "lenders want more pay for risk, a sign of caution", low: "lenders ask little extra pay for risk, a sign of confidence" },
  DXY: { measures: "the trade-weighted US dollar", high: "the dollar is strong, which usually weighs on risk assets and crypto", low: "the dollar is weak, which usually helps risk assets and crypto" },
  ICSA: { measures: "new weekly claims for unemployment insurance", high: "more people are losing jobs", low: "few people are filing for unemployment, so the job market is strong" },
  VIX: { measures: "the expected 30-day volatility of the S&P 500", high: "investors expect large stock swings", low: "investors expect calm stock markets" },
  FISCAL: { measures: "the federal deficit over the last 12 months, as a share of GDP", high: "the government is running a large deficit, spending that flows into company revenues", low: "the deficit is small or shrinking, so less government spending reaches the economy" },
  VIX_TERM: { measures: "expected S&P 500 volatility over the next 3 months divided by expected volatility over the next month (the VIX term structure)", high: "traders expect calm now and more risk later, the usual state of a steady market", low: "traders pay more for protection now than later, which happens in sell-offs" },
  SKEW: { measures: "the CBOE SKEW index: what traders pay for protection against a large S&P 500 fall", high: "traders are buying crash protection", low: "traders are paying little for crash protection" },
  UPVOL_SHARE: { measures: "the share of the last 20 trading days' S&P 500 volume that traded on days the index rose", high: "most trading came on up days, a sign of buying pressure", low: "most trading came on down days, a sign of selling pressure" },
  COPPER_GOLD: { measures: "the copper price over the gold price", high: "industrial demand is strong against the safe asset", low: "the safe asset is beating industrial demand" },
  SPX_TREND: { measures: "the S&P 500's 50-day average over its 200-day average", high: "the stock uptrend is strong", low: "the stock trend is flat or turning down" },
  IWM_SPY: { measures: "small-cap stocks (IWM) against the S&P 500", high: "small companies lead, so gains are broad", low: "small companies lag, so gains are narrow" },
  SPHB_SPLV: { measures: "high-beta stocks against low-volatility stocks", high: "investors favor riskier stocks", low: "investors favor steadier stocks" },
  MTUM_SPY: { measures: "the momentum factor (recent winners) against the S&P 500", high: "recent winners keep leading", low: "recent winners are no longer leading" },
  IWF_IWD: { measures: "growth stocks against value stocks", high: "growth stocks lead", low: "value stocks lead, so money is moving out of the most expensive part of the market" },
  XLU_SPY: { measures: "utility stocks against the S&P 500", high: "defensive utilities lead, a cautious sign", low: "utilities lag, so investors are not moving to defensive stocks" },
  XLP_XLY: { measures: "consumer staples against consumer discretionary stocks", high: "staples lead, a cautious sign", low: "discretionary stocks lead, a sign of confidence in spending" },
  SHILLER_CAPE: { measures: "the S&P 500 price over 10 years of average real earnings (Shiller CAPE)", high: "stocks are expensive against long-run earnings", low: "stocks are cheap against long-run earnings" },
  DEFI_TVL: { measures: "the dollar value locked in DeFi protocols (TVL)", high: "a lot of money is at work in DeFi", low: "little money is at work in DeFi" },
  STABLES: { measures: "the total supply of USD stablecoins", high: "a lot of dollar liquidity sits in crypto", low: "little dollar liquidity sits in crypto" },
  BTC_ACTIVE: { measures: "addresses active on the Bitcoin network each day", high: "many people are using the Bitcoin network", low: "few people are using the Bitcoin network" },
  ETH_ACTIVE: { measures: "addresses active on the Ethereum network each day", high: "many people are using the Ethereum network", low: "few people are using the Ethereum network" },
  BTC_MVRV: { measures: "Bitcoin's market value over its realized value (MVRV), roughly price against the average price holders paid", high: "price is well above what holders paid, a sign of strong demand", low: "price is close to what holders paid, a sign of weak demand" },
  BTC_ETH: { measures: "the Bitcoin price over the Ether price", high: "Bitcoin is beating Ether, a sign of caution inside crypto", low: "Ether is beating Bitcoin, a sign of more risk appetite inside crypto" },
  ETH_TREND: { measures: "Ether's 50-day average over its 200-day average", high: "Ether's uptrend is strong", low: "Ether's trend is flat or turning down" },
  NEW_TOKENS: { measures: "new DEX liquidity pools a day, roughly new token launches", high: "many new tokens are launching, which the model reads as speculation", low: "few new tokens are launching, which the model reads as less speculation" },
  DEFI_GROWTH: { measures: "the 90-day change in DeFi TVL", high: "money is flowing into DeFi", low: "money is flowing out of DeFi" },
  STABLES_GROWTH: { measures: "the 90-day change in stablecoin supply", high: "stablecoin supply is growing, so money is coming into crypto", low: "stablecoin supply is shrinking, so money is leaving crypto" },
};

// ── Response shape (only the fields this script reads) ───────────────────────────────────────────────────────────

export interface ApiIndicator {
  id: string;
  name: string;
  panel: string;
  description?: string;
  unit: string;
  transform: string;
  sign: number;
  raw_value: number;
  raw_date?: string;
  transformed_value: number;
  percentile: number;
  signed_percentile: number;
  panel_weight: number;
}

export interface ApiRow {
  date: string;
  composite: number | null;
  regime: string | null;
  version?: string;
  macroIndex?: number | null;
  onchainIndex?: number | null;
  factorIndex?: number | null;
  macroRegime?: string | null;
  onchainRegime?: string | null;
  factorRegime?: string | null;
  panels?: string[] | null;
  indicators?: ApiIndicator[];
}

export interface ApiResponse {
  latest: ApiRow;
  history: ApiRow[];
  staleness?: { stale?: boolean; ageDays?: number } | null;
}

// ── Facts ────────────────────────────────────────────────────────────────────────────────────────────────────────

export type Band = "low" | "middle" | "high";
export type Reading = "risk_off" | "neutral" | "risk_on";

export interface IndicatorFact {
  id: string;
  name: string;
  panel: Panel;
  value: string;
  asOf: string | null;
  /** where the raw level sits in its own last 3 years, 0 to 1 */
  rawPercentile: number;
  rawBand: Band;
  /** the percentile after the sign: what the model reads, 0 risk-off to 1 risk-on */
  modelPercentile: number;
  reading: Reading;
  /** share of its panel's index */
  weight: number;
  /** pull on the composite: weight x (model percentile - 0.5) / included panels; 0 for a panel outside the composite */
  pull: number;
  measures: string;
  meaning: string;
}

export interface PanelFact {
  panel: Panel;
  index: number | null;
  label: string | null;
  included: boolean;
  /** share of the days in the response's history with a lower index */
  shareLower: number | null;
  change30: number | null;
  change90: number | null;
}

/** Where the response came from. Only the live production API is the published regime. */
export interface Source {
  ref: string;
  live: boolean;
  /** the methodology the URL asked for (`?methodology=`): a line that may be published beside the regime the site shows */
  methodology: string | null;
}

/** The live production API is an https URL on robotmoney.network; anything else (a file, a build, another URL) is not. */
export function describeSource(ref: string): Source {
  let live = false, methodology: string | null = null;
  try {
    const u = new URL(ref);
    live = u.protocol === "https:" && (u.hostname === "robotmoney.network" || u.hostname.endsWith(".robotmoney.network"));
    methodology = u.searchParams.get("methodology");
  } catch {
    live = false;
  }
  return { ref, live, methodology };
}

/** The live API's URL for one methodology's line (the API's own `methodology` parameter). */
export function withMethodology(source: string, methodology: string): string {
  const u = new URL(source);
  u.searchParams.set("methodology", methodology);
  return u.toString();
}

export interface Facts {
  source: Source;
  /** true for an experiment-* model: not deployed, not the regime */
  experiment: boolean;
  asOf: string;
  model: string;
  stale: boolean | null;
  composite: number;
  label: string | null;
  /** how the composite is built, in one sentence */
  compositeRule: string;
  included: Panel[];
  /** the 1/n mean of the included panels today */
  panelMean: number | null;
  history: { days: number; from: string; to: string; meanShareLower: number | null; composite30: number | null; composite90: number | null; mean30: number | null; mean90: number | null; minMean: { date: string; value: number } | null; medianMean: number | null } | null;
  panels: PanelFact[];
  indicators: IndicatorFact[];
  pullingDown: IndicatorFact[];
  holdingUp: IndicatorFact[];
  /** what the agent researches: the drivers and panel moves to explain, and the window to look in. The agent writes its own questions. */
  research: {
    window: { from: string; to: string };
    drivers: { id: string; name: string; panel: Panel; role: string; value: string; levelPercentile: number; modelPercentile: number; measures: string; meaning: string }[];
    panelMoves: { panel: Panel; included: boolean; change30: number }[];
  };
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const band = (p: number): Band => (p <= 1 / 3 ? "low" : p >= 2 / 3 ? "high" : "middle");
const reading = (p: number): Reading => (p < 0.33 ? "risk_off" : p > 0.67 ? "risk_on" : "neutral");
const panelIndex = (r: ApiRow, p: Panel): number | null => {
  const v = r[`${p}Index`];
  return isNum(v) ? v : null;
};
const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** The indicator's level, in its own units. */
export function formatValue(i: ApiIndicator): string {
  const v = i.transform === "level" ? i.raw_value : i.transformed_value;
  if (i.transform.startsWith("trend")) return v.toFixed(3);
  if (i.transform.startsWith("change")) return `${v >= 0 ? "+" : "−"}${Math.abs(v * 100).toFixed(1)}% over 90 days`;
  if (i.unit === "percent") return `${v.toFixed(2)}%`;
  if (i.unit === "usd") return `$${(v / 1e9).toFixed(1)}B`;
  if (i.unit === "count") return Math.round(v).toLocaleString("en-US");
  if (i.unit === "ratio4") return v.toFixed(4);
  if (i.unit === "share") return `${(v * 100).toFixed(0)}%`;
  return v.toFixed(2);
}

/** "1st", "22nd", "93rd" for a 0-1 share. */
export function ordinal(p: number): string {
  const n = Math.round(p * 100), s = ["th", "st", "nd", "rd"], v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

/** The methodologies production serves, by the name the API gives them (`version` on every row, and `methodology`
 *  on a response that asks for one), and how each builds the composite from its panel indices:
 *  - `mean`: the average of the panels in it (v3 averages macro and on-chain; v4 the panels its rows list);
 *  - `ranked-mean`: that average, ranked against every day of the model's record since 2018 (v5).
 *  `v*` names are reserved for these; every other model is an experiment named `experiment-<name>`. A name not in
 *  this table is refused: its rule is unknown, and a read must not guess it. */
export const METHODOLOGIES: Readonly<Record<string, "mean" | "ranked-mean">> = { v3: "mean", v4: "mean", v5: "ranked-mean" };
export const DEPLOYED_MODELS: readonly string[] = Object.keys(METHODOLOGIES);
export const isExperiment = (model: string): boolean => /^experiment-[a-z0-9]+(-[a-z0-9]+)*$/.test(model);

/** The model a row was built with: a deployed model or an experiment. Anything else is an error, not a guess. */
export function modelOf(r: ApiRow): string {
  const v = r.version ?? "";
  if (DEPLOYED_MODELS.includes(v) || isExperiment(v)) return v;
  throw new Error(`${r.date}: model "${v}" is neither a production methodology this skill knows (${DEPLOYED_MODELS.join(", ")}) nor an experiment-<name>, so this data cannot be read. Get the latest skill from https://robotmoney.network/skills/robotmoney-regime-read/SKILL.md`);
}

/**
 * The panels in the composite. A `mean` methodology computes every panel but averages some: find the set whose mean is
 * the composite. A `ranked-mean` methodology or an experiment transforms that mean (ranks it, for example), so the
 * composite cannot be matched; it uses the panels its row lists.
 */
export function includedPanels(r: ApiRow): Panel[] {
  const model = modelOf(r);
  const listed = (r.panels ?? []).filter((p): p is Panel => (PANELS as readonly string[]).includes(p));
  if ((isExperiment(model) || METHODOLOGIES[model] === "ranked-mean") && listed.length) return listed;
  const candidates: Panel[][] = [["macro", "onchain"], ["macro", "onchain", "factor"], listed];
  for (const set of candidates) {
    const m = mean(set.map((p) => panelIndex(r, p)).filter(isNum));
    if (set.length && m !== null && isNum(r.composite) && Math.abs(m - r.composite) < 1e-9) return set;
  }
  throw new Error(`model ${r.version ?? "unknown"}, ${r.date}: no set of panels averages to the composite ${r.composite}, so the panels in the composite are unknown`);
}

function compositeRule(model: string, included: Panel[], composite: number): string {
  const names = included.map((p) => PANEL_NAME[p].toLowerCase());
  const list = names.length > 2 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names.join(" and ");
  if (isExperiment(model)) return `This is an experiment, not a deployed model. Its composite is built from the ${list} panels by the experiment's own rule, which may not be their plain average.`;
  if (METHODOLOGIES[model] === "ranked-mean") return `The composite is the average of the ${list} indices, each a weighted average of its indicators' percentiles, ranked against every day of the model's record since 2018: today's ${composite.toFixed(2)} means the average is higher than on about ${Math.round(composite * 100)}% of those days.`;
  return `The composite is the average of the ${list} indices, each a weighted average of its indicators' percentiles.`;
}

/** Every fact the read is written from. */
export function facts(res: ApiResponse, source: Source): Facts {
  const L = res.latest;
  if (!L || !isNum(L.composite)) throw new Error("the response has no latest composite");
  const model = modelOf(L);
  const included = includedPanels(L);
  const hist = (res.history ?? []).filter((h) => isNum(h.composite)).sort((a, b) => (a.date < b.date ? -1 : 1));
  const back = (days: number): ApiRow | undefined => {
    const t = Date.parse(L.date) - days * 864e5;
    return [...hist].reverse().find((h) => Date.parse(h.date) <= t);
  };
  const meanOf = (r: ApiRow) => mean(included.map((p) => panelIndex(r, p)).filter(isNum));

  const panels: PanelFact[] = PANELS.map((p) => {
    const v = panelIndex(L, p), series = hist.map((h) => panelIndex(h, p)).filter(isNum);
    const b30 = back(30), b90 = back(90);
    const c = (b: ApiRow | undefined) => (b && v !== null && panelIndex(b, p) !== null ? v - panelIndex(b, p)! : null);
    return {
      panel: p, index: v, label: (L[`${p}Regime`] as string | null | undefined) ?? null, included: included.includes(p),
      shareLower: v !== null && series.length > 1 ? series.filter((x) => x < v).length / series.length : null,
      change30: c(b30), change90: c(b90),
    };
  });

  const n = included.length;
  const indicators: IndicatorFact[] = (L.indicators ?? [])
    .filter((i) => (PANELS as readonly string[]).includes(i.panel) && isNum(i.signed_percentile))
    .map((i) => {
      const g = GUIDE[i.id], raw = isNum(i.percentile) ? i.percentile : i.sign > 0 ? i.signed_percentile : 1 - i.signed_percentile;
      const rb = band(raw), panel = i.panel as Panel;
      const meaning = g ? (rb === "high" ? g.high : rb === "low" ? g.low : `near the middle of its range, leaning ${raw >= 0.5 ? "high (" + g.high : "low (" + g.low})`) : (i.description ?? "").split(". ")[0] ?? "";
      return {
        id: i.id, name: i.name, panel, value: formatValue(i), asOf: i.raw_date ?? null,
        rawPercentile: raw, rawBand: rb, modelPercentile: i.signed_percentile, reading: reading(i.signed_percentile),
        weight: i.panel_weight, pull: included.includes(panel) ? (i.panel_weight * (i.signed_percentile - 0.5)) / n : 0,
        measures: g?.measures ?? i.name, meaning,
      };
    });
  const counted = indicators.filter((i) => i.pull !== 0);

  let history: Facts["history"] = null;
  if (hist.length > 1) {
    const means = hist.map((h) => ({ date: h.date, value: meanOf(h) })).filter((m): m is { date: string; value: number } => isNum(m.value));
    const b30 = back(30), b90 = back(90), today = meanOf(L);
    history = {
      days: hist.length, from: hist[0]!.date, to: hist.at(-1)!.date,
      meanShareLower: today === null || !means.length ? null : means.filter((m) => m.value < today).length / means.length,
      composite30: b30 ? b30.composite : null, composite90: b90 ? b90.composite : null,
      mean30: b30 ? meanOf(b30) : null, mean90: b90 ? meanOf(b90) : null,
      minMean: means.length ? means.reduce((a, b) => (b.value < a.value ? b : a)) : null,
      medianMean: median(means.map((m) => m.value)),
    };
  }

  const pullingDown = [...counted].sort((a, b) => a.pull - b.pull).filter((i) => i.pull < 0).slice(0, 7);
  const holdingUp = [...counted].sort((a, b) => b.pull - a.pull).filter((i) => i.pull > 0).slice(0, 5);
  const drivers: Facts["research"]["drivers"] = [];
  const add = (i: IndicatorFact, role: string) => {
    if (drivers.some((d) => d.id === i.id)) return;
    drivers.push({ id: i.id, name: i.name, panel: i.panel, role, value: i.value, levelPercentile: i.rawPercentile, modelPercentile: i.modelPercentile, measures: i.measures, meaning: i.meaning });
  };
  pullingDown.slice(0, 5).forEach((i) => add(i, "pulling the composite down"));
  holdingUp.slice(0, 3).forEach((i) => add(i, "holding the composite up"));
  indicators.filter((i) => i.rawPercentile <= 0.05 || i.rawPercentile >= 0.95).forEach((i) => add(i, `level at the ${i.rawPercentile >= 0.95 ? "top" : "bottom"} of its 3-year range`));
  const from = new Date(Date.parse(`${L.date}T00:00:00Z`) - 30 * 864e5).toISOString().slice(0, 10);
  const panelMoves = panels.filter((p) => p.change30 !== null && Math.abs(p.change30) >= 0.05).map((p) => ({ panel: p.panel, included: p.included, change30: p.change30! }));
  const research: Facts["research"] = { window: { from, to: L.date }, drivers, panelMoves };
  return {
    source, experiment: isExperiment(model), asOf: L.date, model, stale: res.staleness?.stale ?? null, composite: L.composite, label: L.regime,
    compositeRule: compositeRule(model, included, L.composite), included, panelMean: meanOf(L), history, panels, indicators,
    pullingDown, holdingUp, research,
  };
}

// ── Markdown ─────────────────────────────────────────────────────────────────────────────────────────────────────

const LABEL: Readonly<Record<string, string>> = { risk_off: "risk-off", neutral: "neutral", risk_on: "risk-on" };
const f2 = (v: number | null) => (v === null ? "n/a" : v.toFixed(2));
const sgn = (v: number | null) => (v === null ? "n/a" : `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}`);

function indicatorLine(i: IndicatorFact): string {
  return `- **${i.name}** ${i.value}. Level: ${ordinal(i.rawPercentile)} percentile of its last 3 years. Model reading: ${ordinal(i.modelPercentile)} (${LABEL[i.reading]}). Weight ${(i.weight * 100).toFixed(1)}% of the panel. Meaning: ${i.meaning}.`;
}

export function markdown(x: Facts): string {
  const out: string[] = [];
  out.push(`# Regime facts as of ${x.asOf} (model ${x.model})`, "");
  if (x.experiment) out.push(`**Experimental model ${x.model}: not deployed, not the regime.** Say so in the headline of the read. Never call it the regime or give it a version number.`, "");
  out.push(x.source.live && x.source.methodology
    ? `Source: the live production API, methodology ${x.source.methodology} as asked (${x.source.ref}). **This line may be published beside the regime the site shows:** name the methodology in the headline of the read.`
    : x.source.live
      ? `Source: the live production API (${x.source.ref}). This is the published regime.`
      : `Source: ${x.source.ref}. **Not the live production regime:** a saved file or another URL. Say so in the headline of the read.`, "");
  if (x.stale) out.push("**The data is stale: the response says the snapshot has not refreshed.**", "");
  else if (x.stale === null) out.push("**The response has no staleness check.** Confirm the as-of date is the date you meant before you write the read.", "");
  out.push(`- Composite: **${x.composite.toFixed(2)}**, label **${LABEL[x.label ?? ""] ?? x.label ?? "none"}**. Labels are cut at 0.33 and 0.67.`);
  out.push(`- ${x.compositeRule}`);
  if (x.experiment && x.panelMean !== null) out.push(`- The 1/n mean of the included panels today: ${x.panelMean.toFixed(3)}.`);
  if (x.history) {
    const h = x.history;
    out.push(`- History in this response: ${h.days} days, ${h.from} to ${h.to}.${h.meanShareLower === null ? "" : h.meanShareLower === 0 ? " Today's average of the included panels is the lowest in this history." : ` The average of the included panels was lower than today on ${Math.round(h.meanShareLower * 100)}% of those days.`}`);
    out.push(`- Composite 30 days ago: ${f2(h.composite30)}; 90 days ago: ${f2(h.composite90)}.`);
    out.push(`- Average of the included panels 30 days ago: ${f2(h.mean30)}; 90 days ago: ${f2(h.mean90)}; today: ${f2(x.panelMean)}.`);
    if (h.medianMean !== null && h.minMean) out.push(`- 1/n mean of the included panels over this history: median ${h.medianMean.toFixed(3)}, lowest ${h.minMean.value.toFixed(3)} on ${h.minMean.date}.`);
  }
  out.push("", "## Panels", "");
  for (const p of x.panels) {
    out.push(`- **${PANEL_NAME[p.panel]}** ${f2(p.index)}, label ${LABEL[p.label ?? ""] ?? "none"}, ${p.included ? "in the composite" : "context only, not in the composite"}. Change over 30 days ${sgn(p.change30)}, over 90 days ${sgn(p.change90)}.${p.shareLower === null ? "" : p.shareLower === 0 ? " Today is its lowest in this history." : ` Lower on ${Math.round(p.shareLower * 100)}% of the days in this history.`}`);
  }
  out.push("", "## Pulling the composite down", "", ...x.pullingDown.map((i) => `- ${i.name} (${PANEL_NAME[i.panel]}): ${i.value}, model reading ${ordinal(i.modelPercentile)}`));
  out.push("", "## Holding it up", "", ...x.holdingUp.map((i) => `- ${i.name} (${PANEL_NAME[i.panel]}): ${i.value}, model reading ${ordinal(i.modelPercentile)}`));
  for (const p of PANELS) {
    const rows = x.indicators.filter((i) => i.panel === p);
    if (!rows.length) continue;
    out.push("", `## ${PANEL_NAME[p]}: ${PANEL_THEME[p]}`, "", ...rows.map(indicatorLine));
  }
  const r = x.research;
  out.push("", "## Research brief", "", `Window: ${r.window.from} to ${r.window.to}. Explain the moves below with outside sources. Write your own questions for each (SKILL.md step 2); this list says what to explain, not what to search.`, "");
  out.push("Drivers:", "", ...r.drivers.map((d) => `- **${d.name}** (${PANEL_NAME[d.panel]}, ${d.role}): ${d.value}, ${ordinal(d.levelPercentile)} percentile of its 3-year range, model reading ${ordinal(d.modelPercentile)}. It measures ${d.measures}. What the level means: ${d.meaning}.`));
  if (r.panelMoves.length) out.push("", "Panel moves over 30 days:", "", ...r.panelMoves.map((m) => `- ${PANEL_NAME[m.panel]} ${sgn(m.change30)}${m.included ? "" : " (context only)"}`));
  out.push("", "Notes: percentiles compare each indicator with its own last 3 years. The model reading flips indicators where a higher level means more risk, so a low model reading is always risk-off. Pull ranks indicators by weight times distance from the middle, inside the panels in the composite.");
  return out.join("\n") + "\n";
}

export function guideMarkdown(): string {
  const lines = ["# Indicator guide", "", "What each indicator measures, and what a high or a low level means. The model reading flips indicators where a higher level means more risk.", "", "| Id | Measures | High level | Low level |", "|---|---|---|---|"];
  for (const [id, g] of Object.entries(GUIDE)) lines.push(`| \`${id}\` | ${g.measures} | ${g.high} | ${g.low} |`);
  return lines.join("\n") + "\n";
}

export async function load(source: string): Promise<ApiResponse> {
  const text = /^https?:\/\//.test(source) ? await (await fetch(source)).text() : await Bun.file(source).text();
  const res = JSON.parse(text) as ApiResponse & { error?: string; methodology?: string };
  if (res.error) throw new Error(`the API refused the request: ${res.error}`);
  // An API that does not know the parameter ignores it and serves its main line: never read that as the line asked for.
  const asked = describeSource(source).methodology;
  if (asked && res.methodology !== asked) throw new Error(`asked for methodology ${asked}, but the API did not serve it (it answered without naming it), so this is not that line`);
  return res;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes("--guide")) {
    process.stdout.write(guideMarkdown());
  } else {
    const m = args.indexOf("--methodology");
    const methodology = m === -1 ? null : args[m + 1];
    if (m !== -1 && !methodology) throw new Error("--methodology needs a version, for example v5");
    const given = args.find((a, k) => !a.startsWith("--") && (m === -1 || k !== m + 1)) ?? DEFAULT_SOURCE;
    const source = methodology ? withMethodology(given, methodology) : given;
    const x = facts(await load(source), describeSource(source));
    process.stdout.write(args.includes("--json") ? JSON.stringify(x, null, 2) + "\n" : markdown(x));
  }
}
