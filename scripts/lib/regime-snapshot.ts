// The regime's live reading, written into the prerendered page (RM-135).
//
// The regime page is what the swarm reads the market by, and its figures are
// filled in by the browser from the snapshot endpoint. A reader that does not
// run JavaScript (an agent's fetch tool, a crawler that does not render) got
// the methodology and nothing it describes. So the prerender reads the snapshot
// once and writes the day's reading into two places:
//
//   - the page's "Data for machine readers" <noscript> block: the reading, the
//     26 indicators and the correlation table, as text and tables;
//   - the route's schema.org Dataset: the date and each headline figure.
//
// It is as fresh as the last prerender, and it says its date. The host re-runs
// the prerender daily so it follows the analytics refresh.
//
// Pure functions over the snapshot DTO, apart from the fetch, so the unit test
// pins the output without running a prerender.

/* eslint-disable @typescript-eslint/no-explicit-any */
type Latest = Record<string, any>;

const esc = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] || c);

const REGIME_LABEL: Record<string, string> = { risk_off: "Risk-off", neutral: "Neutral", risk_on: "Risk-on" };
const PANEL_LABEL: Record<string, string> = { macro: "Macro", onchain: "On-chain", factor: "Equity factor" };
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const fix2 = (v: unknown): string => (typeof v === "number" && Number.isFinite(v) ? v.toFixed(2) : "none");
const signed = (v: number, digits: number, suffix = ""): string => {
  const s = Math.abs(v).toFixed(digits);
  if (Number(s) === 0) return s + suffix;
  return (v < 0 ? "−" : "+") + s + suffix;
};
const ordinal = (x: unknown): string => {
  if (typeof x !== "number" || !Number.isFinite(x)) return "none";
  const n = Math.round(x * 100);
  if (n % 100 >= 11 && n % 100 <= 13) return `${n}th`;
  return `${n}${({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] || "th"}`;
};
export const longDate = (d: string): string => {
  const [y, m, day] = String(d).split("-").map(Number);
  return y && m && day ? `${MONTHS[m - 1]} ${day}, ${y}` : String(d);
};

/** The cut-offs the snapshot carries, or the method's 0.33 / 0.67. */
function cuts(latest: Latest): { lo: number; hi: number } {
  const t = latest.bucketThresholds || {};
  const lo = Number(t.risk_off ?? t.low ?? 0.33);
  const hi = Number(t.risk_on ?? t.high ?? 0.67);
  return { lo: Number.isFinite(lo) ? lo : 0.33, hi: Number.isFinite(hi) ? hi : 0.67 };
}

/** An indicator's last value in its own unit, as the page prints it. */
export function lastValue(ind: Latest): string {
  const t = ind.transform;
  const v = t === "change30" || t === "change90" ? ind.transformed_value : ind.raw_value;
  if (typeof v !== "number" || !Number.isFinite(v)) return "none";
  switch (ind.unit) {
    case "percent": return v.toFixed(2) + "%";
    case "percent_change": return signed(v * 100, 1, "%");
    case "count": return Math.abs(v) >= 1e6 ? (v / 1e6).toFixed(2) + "M" : Math.round(v).toLocaleString("en-US");
    case "ratio4": return v.toFixed(4);
    case "index": case "ratio2": return v.toFixed(2);
    default: return Math.abs(v) >= 1e6 ? v.toExponential(2) : v.toFixed(2);
  }
}

const panelsOf = (latest: Latest): string[] =>
  Array.isArray(latest.panels) && latest.panels.length ? latest.panels : ["macro", "onchain", ...(latest.factorIndex != null ? ["factor"] : [])];

/** The reading, the indicators and the correlations, for the <noscript> block. */
export function regimeSnapshotHtml(latest: Latest | null | undefined): string {
  if (!latest || !latest.date) return "";
  const { lo, hi } = cuts(latest);
  const panels = panelsOf(latest);
  const idx = panels.map((p) => `${PANEL_LABEL[p] || p} index ${fix2(latest[p + "Index"])}`).join(", ");
  const out: string[] = [];
  out.push(`<h3>The regime on ${esc(longDate(latest.date))}</h3>`);
  out.push(`<p>${esc(REGIME_LABEL[latest.regime] || latest.regime || "No reading")}. Composite ${esc(fix2(latest.composite))}, the ${esc(ordinal(latest.compositePercentile))} percentile of its last 3 years: below the ${esc(ordinal(lo))} reads risk-off, above the ${esc(ordinal(hi))} risk-on. ${esc(idx)}, each from 0 (risk-off) to 1 (risk-on). The composite is the mean of the macro and on-chain indices; the equity factor index is tracked for context and left out of it.</p>`);

  const inds: Latest[] = Array.isArray(latest.indicators) ? latest.indicators : [];
  if (inds.length) {
    out.push(`<h3>The ${inds.length} indicators</h3>`);
    out.push("<table><thead><tr><th>Panel</th><th>Indicator</th><th>Last</th><th>Risk-on, 0 to 100</th><th>Weight in its panel</th><th>What it is</th></tr></thead><tbody>");
    for (const p of panels) {
      for (const ind of inds.filter((i) => i.panel === p)) {
        const pct = typeof ind.signed_percentile === "number" ? String(Math.round(ind.signed_percentile * 100)) : "none";
        const w = typeof ind.panel_weight === "number" ? (ind.panel_weight * 100).toFixed(1) + "%" : "none";
        out.push(`<tr><td>${esc(PANEL_LABEL[p] || p)}</td><td><a href="https://robotmoney.network/regime/indicators#${esc(ind.id)}">${esc(ind.name)}</a></td><td>${esc(lastValue(ind))}</td><td>${esc(pct)}</td><td>${esc(w)}</td><td>${esc(ind.description || "")}</td></tr>`);
      }
    }
    out.push("</tbody></table>");
  }

  const c = latest.correlations;
  if (c && (c.forward || c.concurrent)) {
    const rows = [["composite", "Composite"], ["macro", "Macro"], ["onchain", "On-chain"], ["factor", "Equity factor"]]
      .filter(([k]) => (c.forward && c.forward[k]) || (c.concurrent && c.concurrent[k]));
    const cols: [string, string, (k: string) => any][] = [];
    for (const [a, name] of [["spx", "S&P 500"], ["eth", "ETH"]]) {
      if (c.concurrent) cols.push([`${a}-now`, `${name}, today`, (k) => c.concurrent?.[k]?.[a]]);
      if (c.forward) for (const h of [30, 90, 180]) cols.push([`${a}-${h}`, `${name}, next ${h} days`, (k) => c.forward?.[k]?.[`${a}_${h}d`]]);
    }
    out.push("<h3>Predictive power and alignment</h3>");
    out.push("<p>Spearman rank correlation, from −1 to +1. Today: between the index and the price now. Next 30, 90 and 180 days: between the index and the return that followed. Under 0.15 either way is treated as noise.</p>");
    out.push(`<table><thead><tr><th>Index</th>${cols.map(([, l]) => `<th>${esc(l)}</th>`).join("")}</tr></thead><tbody>`);
    for (const [k, label] of rows) {
      out.push(`<tr><td>${esc(label)}</td>${cols.map(([, , get]) => { const cell = get(k); return `<td>${cell && typeof cell.rho === "number" ? esc(signed(cell.rho, 2)) : "none"}</td>`; }).join("")}</tr>`);
    }
    out.push("</tbody></table>");
  }
  return out.join("\n        ");
}

/**
 * The route's JSON-LD with the day's figures on its Dataset: the date it was
 * last modified, and each headline figure as a PropertyValue. Returns the
 * input unchanged when there is no Dataset or no reading.
 */
export function withLiveRegime(ldJson: string, latest: Latest | null | undefined): string {
  if (!latest || !latest.date) return ldJson;
  let doc: any;
  try { doc = JSON.parse(ldJson); } catch { return ldJson; }
  const nodes: any[] = Array.isArray(doc["@graph"]) ? doc["@graph"] : [doc];
  const ds = nodes.find((n) => n && n["@type"] === "Dataset");
  if (!ds) return ldJson;
  const pv = (name: string, value: unknown, extra: Record<string, unknown> = {}) =>
    (value == null ? null : { "@type": "PropertyValue", name, value, ...extra });
  const unit = { minValue: 0, maxValue: 1 };
  ds.dateModified = latest.date;
  ds.variableMeasured = [
    pv("Regime", REGIME_LABEL[latest.regime] || latest.regime, { description: "The composite's reading: risk-on, neutral or risk-off.", valueReference: { "@type": "DefinedTermSet", name: "Regime states", hasDefinedTerm: ["Risk-on", "Neutral", "Risk-off"].map((t) => ({ "@type": "DefinedTerm", name: t })) } }),
    pv("Composite", typeof latest.composite === "number" ? +latest.composite.toFixed(4) : null, { ...unit, description: "The mean of the macro and on-chain panel indices." }),
    pv("Composite percentile, 3 years", typeof latest.compositePercentile === "number" ? +latest.compositePercentile.toFixed(4) : null, unit),
    ...panelsOf(latest).map((p) => pv(`${PANEL_LABEL[p] || p} index`, typeof latest[p + "Index"] === "number" ? +latest[p + "Index"].toFixed(4) : null, unit)),
  ].filter(Boolean);
  // Every "<" escaped, as seo.js does, so the block can never close its script.
  return JSON.stringify(doc).replace(/</g, "\\u003c");
}

/** The snapshot, or null when it cannot be read in time. */
export async function fetchRegimeLatest(origin: string, timeoutMs = 8000): Promise<Latest | null> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${origin}/api/dashboards/regime-snapshots?range=2`, { signal: ctl.signal, headers: { accept: "application/json" } });
    if (!res.ok) return null;
    const body = await res.json() as { latest?: Latest };
    return body?.latest && body.latest.date ? body.latest : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}
