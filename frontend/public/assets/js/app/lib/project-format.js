// Figures on the projects directory and a project's page (RM-186). PURE.
import { fmtUsdCompact } from "../alpine/lib/dash-format.js";

/** @param {unknown} n @returns {number | null} */
export const num = (n) => (typeof n === "number" && Number.isFinite(n) ? n : null);

// "$1.26B", "$304.0K", "$480": a market cap, an FDV, a day's volume, in the
// dashboards' shared compact form.
/** @param {unknown} v */
export function usdCompact(v) {
  return fmtUsdCompact(num(v), { baseDecimals: 0 });
}

// A token's price to three significant figures, however small:
// "$22.8", "$0.00323", "$0.00000317".
/** @param {unknown} v */
export function tokenPrice(v) {
  const n = num(v);
  if (n === null) return "—";
  if (n >= 1000) return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  return "$" + n.toLocaleString("en-US", { maximumSignificantDigits: 3, maximumFractionDigits: 20 });
}

// A move as a signed percentage, glyph first: "+4.2%", "−1.0%".
/** @param {unknown} v */
export function pctText(v) {
  const n = num(v);
  if (n === null) return "—";
  const sign = n > 0 ? "+" : n < 0 ? "−" : "";
  return `${sign}${Math.abs(n).toFixed(1)}%`;
}

/** @param {unknown} v */
export function pctClass(v) {
  const n = num(v);
  return n === null || n === 0 ? "flat" : n > 0 ? "up" : "down";
}

// The token a project is measured by: its largest by market cap.
/** @param {any} p */
export function primaryCoin(p) {
  const coins = Array.isArray(p?.coins) ? p.coins : [];
  return coins.reduce((best, c) => ((num(c?.marketCap) ?? -1) > (num(best?.marketCap) ?? -1) ? c : best), null);
}

/** @param {string} name */
export function initials(name) {
  return String(name || "").replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase() || "?";
}

// A figure the data cannot back yet shows as "Missing", never as a wrong
// number or a zero that means "unknown", and says why on hover (RM-186). The
// gaps stay visible until the pipeline fills them (frontend issues 1359 to
// 1365); each reason here is what a reader needs, not which job is behind it.
export const MISSING_WHY = {
  balance: "Counts ETH only so far. Tokens and stablecoins in the wallet are not read yet.",
  lastTx: "Not read yet. The time on record is when the wallet was last checked, not when it last moved funds.",
  revenue: "Revenue is not read for this project yet.",
  needsRevenue: "Needs revenue, which is not read for this project yet.",
  x402: "x402 payments are not read for this project yet.",
  productivity: "Not measured for this agent yet.",
  apy: "The vault's yield is not read yet.",
  liquidity: "Onchain liquidity is not read yet.",
  chains: "Only one chain is on record, and the figures cover every market the token trades on.",
  trend: "Fewer than two daily readings so far.",
  treasury: "Wallet balances count ETH only, so the treasury's history is not complete yet.",
  activity: "No activity is recorded for this project's agents yet.",
};

/** @typedef {{ text: string, missing: boolean, why: string }} Cell */

/** @param {keyof typeof MISSING_WHY} key @returns {Cell} */
export const missing = (key) => ({ text: "Missing", missing: true, why: MISSING_WHY[key] });
/** @param {string} text @returns {Cell} */
export const shown = (text) => ({ text, missing: false, why: "" });
// A figure where a zero means "not read", not "none": revenue, x402 volume.
/** @param {unknown} v @param {(n: number) => string} fmt @param {keyof typeof MISSING_WHY} key */
export const readOrMissing = (v, fmt, key) => (num(v) ? shown(fmt(/** @type {number} */ (v))) : missing(key));

// A small trend line in the site's own colours: green when the window closes
// up, warn when down, muted when flat. Empty string under two readings, and
// for a series that is zero throughout, which is activity never read.
/** @param {unknown[]} values @param {number} [w] @param {number} [h] */
export function trendSvg(values, w = 88, h = 22) {
  const vals = (Array.isArray(values) ? values : []).filter((v) => typeof v === "number" && Number.isFinite(v));
  if (vals.length < 2 || vals.every((v) => v === 0)) return "";
  const min = Math.min(...vals);
  const span = Math.max(...vals) - min || 1;
  const x = (i) => (2 + (i / (vals.length - 1)) * (w - 4)).toFixed(1);
  const y = (v) => (2 + (1 - (v - min) / span) * (h - 4)).toFixed(1);
  const last = vals[vals.length - 1];
  const stroke = last > vals[0] ? "var(--color-green)" : last < vals[0] ? "var(--color-warn)" : "var(--color-text-muted)";
  const pts = vals.map((v, i) => `${x(i)},${y(v)}`).join(" ");
  return `<svg class="pj-trend" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true" focusable="false">`
    + `<polyline points="${pts}" fill="none" stroke="${stroke}" stroke-width="1.25" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}
