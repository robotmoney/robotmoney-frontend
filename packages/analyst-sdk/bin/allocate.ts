// `bun run allocate --raw history.csv --prices prices.csv --research research.csv
//    --rules rules/R1.json,rules/R2.json --start 2022-10-07 --end 2026-10-07 --out out/`
// The allocation harness: point-in-time regime labels (one as-of run per decision
// date), a rule file per proposal, the page's backtest engine, and the eval
// reference (weekly weights) as CSV. Reads local files only; no network.
import { parseRawHistory, toHistory } from "../src/input/load.ts";
import type { Point } from "../src/types.ts";
import { asofLabel, currentViewLabels, type AsofLabel } from "../src/allocate/labels.ts";
import { validateRuleFile, weightsFor, turnover } from "../src/allocate/rules.ts";
import { computeResearchSeries, channelDivergenceFires, lateCycleFires, type ResearchSeries } from "../src/allocate/research-tilts.ts";
import { runPath, stats, phaseStats, type Series } from "../src/allocate/allocation-backtest.ts";
import type { RuleFile, State, Weights, Decision } from "../src/allocate/types.ts";

const args = process.argv.slice(2);
const val = (f: string, d?: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1]! : d; };
const RAW = val("--raw")!, PRICES = val("--prices")!, RESEARCH = val("--research");
const RULES = (val("--rules") ?? "").split(",").filter(Boolean);
const START = val("--start", "2022-10-07")!, END = val("--end", "2026-10-07")!;
const OUT = val("--out", "out")!;
const CACHE = val("--labels-cache", `${OUT}/labels-asof.json`)!;
const COST = Number(val("--cost-bps", "10"));
const BAND_PTS = Number(val("--band-pts", "2")), BAND_REL = Number(val("--band-rel", "0.25")); // the page's drift rule
const OOS_FROM = val("--oos-from", "2024-02-01")!; // Lex's split: in-sample through Jan 2024
if (!RAW || !PRICES || !RULES.length) { console.error("need --raw, --prices and --rules"); process.exit(2); }
await Bun.write(`${OUT}/.keep`, "");

// ---------- calendar: every day START..END; decisions every Monday, as-of the Friday before ----------
const days: string[] = [];
for (let t = Date.parse(START + "T00:00:00Z"); t <= Date.parse(END + "T00:00:00Z"); t += 864e5) days.push(new Date(t).toISOString().slice(0, 10));
const idx = new Map(days.map((d, i) => [d, i] as const));
const isMonday = (d: string) => new Date(d + "T00:00:00Z").getUTCDay() === 1;
const minus = (d: string, n: number) => new Date(Date.parse(d + "T00:00:00Z") - n * 864e5).toISOString().slice(0, 10);
const mondays = days.filter(isMonday);
// the first decision is the window start itself (whatever weekday), as-of the day before
const decisionDates = [START, ...mondays.filter((d) => d > START)];

// ---------- 1) point-in-time labels (cached) ----------
const raw = toHistory(parseRawHistory(await Bun.file(RAW).text()));
let cache: Record<string, AsofLabel> = {};
try { cache = JSON.parse(await Bun.file(CACHE).text()); } catch {}
let computed = 0; const t0 = Date.now();
for (const d of decisionDates) {
  const asof = d === START ? minus(d, 1) : minus(d, 3);
  if (cache[asof]) continue;
  cache[asof] = asofLabel(raw, asof); computed++;
  if (computed % 20 === 0) { console.error(`  as-of runs: ${computed} (${((Date.now() - t0) / 1000).toFixed(0)} s)`); await Bun.write(CACHE, JSON.stringify(cache)); }
}
await Bun.write(CACHE, JSON.stringify(cache));
console.error(`labels: ${decisionDates.length} decisions, ${computed} new as-of runs`);
// hindsight check: as-of label vs the current view from one full run as-of END
const view = currentViewLabels(raw, END);
let differ = 0, compared = 0;
for (const d of decisionDates) { const a = cache[d === START ? minus(d, 1) : minus(d, 3)]!; const v = view.get(a.asof); if (a.composite && v) { compared++; if (a.composite !== v) differ++; } }

// ---------- 2) price and yield series ----------
const series: Series = { dateAxis: days, values: {} };
for (const line of (await Bun.file(PRICES).text()).split("\n").slice(1)) {
  if (!line.trim()) continue;
  const [d, k, v] = line.split(",");
  const i = idx.get(d!); if (i === undefined) continue;
  (series.values[k!] ??= new Array(days.length).fill(NaN))[i] = Number(v);
}

// ---------- 3) research series for tilts (R2) ----------
let research: ResearchSeries | null = null;
if (RESEARCH) {
  const by: Record<string, Point[]> = {};
  for (const line of (await Bun.file(RESEARCH).text()).split("\n").slice(1)) {
    if (!line.trim()) continue;
    const [d, k, v] = line.split(","); (by[k!] ??= []).push({ date: d!, value: Number(v) });
  }
  const stables = raw.STABLES ?? [];
  const mna = raw.MNA ?? [];
  research = computeResearchSeries({ btc: by.BTC!, qqq: by.QQQ!, spy: by.SPY!, rsp: by.RSP!,
    top7: { NVDA: by.NVDA!, MSFT: by.MSFT!, AAPL: by.AAPL!, GOOGL: by.GOOGL!, AMZN: by.AMZN!, META: by.META!, AVGO: by.AVGO! },
    stables, mna, margin: by.MARGIN!, conf: by.UMCSENT! }, END);
  console.error(`research series: beta median ${research.btcBetaMedian.toFixed(2)}, points: beta ${research.btcBeta.size}, ratio ${research.btcQqqPct.size}, flow ${research.flowDiff.size}, conc ${research.concentrationPct.size}, mna ${research.mnaPct.size}, margin ${research.marginYoyPct.size}, conf ${research.confPct.size}`);
}

// ---------- 4) decisions and backtests per rule ----------
const benchmark = new Map<string, Weights>([[START, { AAVE: 100 }]]);
// Windows: each is a separate run from its start to END, like the page; only those on or after START.
const allWindows: Record<string, string> = { "8y": "2018-10-07", "6y": "2020-10-07", "4y": "2022-10-07", "3y": "2023-10-07", "2y": "2024-10-07", "1y": "2025-10-07" };
const windows: Record<string, string> = Object.fromEntries(Object.entries(allWindows).filter(([, d]) => d >= START));
// Phases: Lex's calendar-defined boundaries from the treasury post when the run
// reaches back to 2018; the shorter split otherwise. Stats on one continuous path.
const phases: [string, string, string][] = START < "2020-01-01" ? [
  ["in-sample (to Jan 2024)", START, "2024-01-31"],
  ["out-of-sample (Feb 2024 on)", OOS_FROM, END],
  ["pre-2020 + COVID (Oct 18 to Dec 20)", START, "2020-12-31"],
  ["2021 mania (Dec 20 to Nov 21)", "2020-12-01", "2021-11-30"],
  ["2022 drawdown (Nov 21 to Dec 22)", "2021-11-01", "2022-12-31"],
  ["recovery (Dec 22 to Jan 24)", "2022-12-01", "2024-01-31"],
  ["2024 to 2025 (Feb 24 to Oct 25)", "2024-02-01", "2025-10-07"],
  ["last year (Oct 25 to Oct 26)", "2025-10-07", END],
] : [
  ["in-sample (to Jan 2024)", START, "2024-01-31"],
  ["out-of-sample (Feb 2024 on)", OOS_FROM, END],
  ["2022 drawdown (Oct 22 to Dec 22)", START, "2022-12-31"],
  ["recovery (Jan 23 to Jan 24)", "2023-01-01", "2024-01-31"],
  ["2024 to 2025 (Feb 24 to Oct 25)", "2024-02-01", "2025-10-07"],
  ["last year (Oct 25 to Oct 26)", "2025-10-07", END],
];
const results: Record<string, unknown> = { start: START, end: END, costBps: COST, decisions: decisionDates.length,
  hindsight: { compared, differ, share: compared ? differ / compared : null }, rules: {} };
const table: string[] = [];
const E = days.length - 1;
const benchStats: Record<string, ReturnType<typeof stats>> = {};
const navs = new Map<string, number[]>();
for (const [wn, from] of Object.entries(windows)) benchStats[wn] = stats(runPath(series, benchmark, idx.get(from)!, E, COST).nav);

for (const file of RULES) {
  const rule = JSON.parse(await Bun.file(file).text()) as RuleFile;
  validateRuleFile(rule);
  const decisions: Decision[] = [];
  const dmap = new Map<string, Weights>();
  let prev: Weights | null = null, stateChanges = 0, prevState: State | null = null;
  for (const d of decisionDates) {
    const asof = d === START ? minus(d, 1) : minus(d, 3);
    const L = cache[asof]!;
    const label = rule.label === "conservative" ? L.conservative : rule.label === "aggressive" ? L.aggressive : L.composite;
    const fired: string[] = [];
    if (research && rule.tilts?.length && !rule.frozen) {
      const st = label ?? "neutral";
      for (const t of rule.tilts) {
        if (t.onlyIn && !t.onlyIn.includes(st)) continue;
        if (t.signal === "channel_divergence" && channelDivergenceFires(research, asof, L.macroPercentile, t.params)) fired.push(t.id);
        if (t.signal === "late_cycle" && lateCycleFires(research, asof, t.params)) fired.push(t.id);
      }
    }
    // no label (data gap): hold last week's weights
    const w: { state: State; weights: Weights } = label === null && prev ? { state: prevState ?? "neutral", weights: prev } : weightsFor(rule, label, fired);
    if (prevState !== null && w.state !== prevState) stateChanges++;
    prevState = w.state; prev = w.weights;
    dmap.set(d, w.weights);
    decisions.push({ date: d, asof, label: w.state, composite: L.composite, conservative: L.conservative, aggressive: L.aggressive,
      macro: L.macro, onchain: L.onchain, compositePercentile: L.compositePercentile, macroPercentile: L.macroPercentile, tiltsFired: fired, weights: w.weights });
  }
  // weekly reference weights as CSV
  const keys = Object.keys(rule.states.neutral);
  const csv = ["date,asof,state,composite,macro,onchain,composite_pct,tilts," + keys.join(",")];
  for (const x of decisions) csv.push([x.date, x.asof, x.label, x.composite, x.macro, x.onchain, x.compositePercentile?.toFixed(3) ?? "", x.tiltsFired.join("|"), ...keys.map((k) => (x.weights[k] ?? 0).toFixed(2))].join(","));
  await Bun.write(`${OUT}/weights-${rule.id}.csv`, csv.join("\n") + "\n");

  const r: Record<string, unknown> = { id: rule.id, name: rule.name, status: rule.status, author: rule.author, label: rule.label, frozen: rule.frozen ?? null,
    stateChanges, tiltWeeks: decisions.filter((x) => x.tiltsFired.length).length,
    stateShare: Object.fromEntries((["risk_off", "neutral", "risk_on"] as State[]).map((s) => [s, decisions.filter((x) => x.label === s).length / decisions.length])),
    windows: {}, phases: {} };
  for (const [wn, from] of Object.entries(windows)) {
    const p = runPath(series, dmap, idx.get(from)!, E, COST, BAND_PTS, BAND_REL, rule.driftPtsBySeries ?? {}); const st = stats(p.nav); const b = benchStats[wn]!;
    (r.windows as Record<string, unknown>)[wn] = { ...st, vsAave: st.cagr - b.cagr, exPerVol: st.vol > 0.5 ? (st.cagr - b.cagr) / st.vol : null, costBps: p.costs * 1e4, turnoverPct: p.turnover, rebalances: p.rebalances };
    table.push([wn, rule.id.padEnd(16), st.total.toFixed(1).padStart(6), st.cagr.toFixed(2).padStart(6), st.vol.toFixed(1).padStart(5), st.maxdd.toFixed(1).padStart(6), (st.cagr - b.cagr).toFixed(2).padStart(7), (p.costs * 1e4).toFixed(1).padStart(5), p.turnover.toFixed(0).padStart(5), String(p.rebalances).padStart(4)].join(" "));
  }
  const full = runPath(series, dmap, 0, E, COST, BAND_PTS, BAND_REL, rule.driftPtsBySeries ?? {});
  navs.set(rule.id, full.nav);
  const bfull = runPath(series, benchmark, 0, E, COST);
  for (const [name, from, to] of phases) {
    const a = phaseStats(full.nav, days, 0, from, to), b = phaseStats(bfull.nav, days, 0, from, to);
    (r.phases as Record<string, unknown>)[name] = a && b ? { cagr: a.cagr, maxdd: a.maxdd, aaveCagr: b.cagr, aaveMaxdd: b.maxdd } : null;
  }
  (results.rules as Record<string, unknown>)[rule.id] = r;
}
results.benchmark = { id: "Aave USDC", windows: benchStats };
// Daily NAV of every full-window path, $100 start, for charts: nav.csv (date, aave, <rule ids>).
{
  const cols = ["aave", ...RULES.map((f) => (navs.get(f) ? f : null)).filter(Boolean)];
  const header = "date," + ["aave", ...[...navs.keys()]].join(",");
  const b = runPath(series, benchmark, 0, E, COST).nav;
  const lines = [header];
  for (let i = 0; i <= E; i++) lines.push([days[i], (b[i]! * 100).toFixed(3), ...[...navs.values()].map((v) => (v[i]! * 100).toFixed(3))].join(","));
  await Bun.write(`${OUT}/nav.csv`, lines.join("\n") + "\n");
}
await Bun.write(`${OUT}/results.json`, JSON.stringify(results, null, 2));
console.log(`win  rule              total   cagr   vol  maxdd  vsAave  cost  turn  reb`);
for (const [wn, b] of Object.entries(benchStats)) console.log([wn, "Aave USDC".padEnd(16), b.total.toFixed(1).padStart(6), b.cagr.toFixed(2).padStart(6), b.vol.toFixed(1).padStart(5), b.maxdd.toFixed(1).padStart(6), "   0.00", "  0.0", "    0", "   0"].join(" "));
for (const l of table) console.log(l);
console.log(`\nhindsight: ${differ} of ${compared} as-of labels differ from the current view (${compared ? (100 * differ / compared).toFixed(0) : "-"}%)`);
