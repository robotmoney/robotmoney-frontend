// @ts-check
// Formatting for the deposit surfaces (RM-146), as the design canvas sets it:
// amounts in USDC to the cent, shares to four places, times in the reader's
// own time zone as "Sat 14 Nov · 01:00". A guaranteed minimum is floored, so it
// never reads higher than it is.

/** "48,250 USDC", "101.66 USDC". @param {number|null|undefined} n */
export function fmtUsdc(n) {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })} USDC`;
}
/** "1,500.4210". @param {number|null|undefined} n */
export function fmtShares(n) {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 4 });
}
/**
 * The vault's share token as a wallet shows it: the fund's `symbol()` on Base,
 * read 17 Nov 2026 (name "Robot Money Fund"). A share amount carries it, so
 * the page and the wallet name the same thing; sentences still say "shares".
 */
export const SHARE_SYMBOL = "rmFUND";
/** "1,500.4210 rmFUND". @param {number|null|undefined} n */
export const fmtRm = (n) => `${fmtShares(n)} ${SHARE_SYMBOL}`;
/** "1.0213 USDC". @param {number|null|undefined} p */
export const fmtPrice = (p) => (p == null || !Number.isFinite(p) ? "—" : `${p.toFixed(4)} USDC`);
/** "25%", "24.6%". @param {number|null|undefined} bps */
export const fmtBps = (bps) => (bps == null ? "—" : `${(bps / 100).toLocaleString("en-US", { maximumFractionDigits: 1 })}%`);
/** "0.1%", or "None" for zero. @param {number|null|undefined} bps */
export const fmtFee = (bps) => (bps == null ? "Not set yet" : bps === 0 ? "None" : `${(bps / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}%`);
/** Round down to `places`. @param {number} n @param {number} places */
export const floorTo = (n, places) => Math.floor(n * 10 ** places) / 10 ** places;

const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MO = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const two = (n) => String(n).padStart(2, "0");
/** "Sat 14 Nov · 01:00" in local time. @param {number|null|undefined} ms */
export function fmtWhen(ms) {
  if (ms == null || !Number.isFinite(ms)) return "—";
  const d = new Date(ms);
  return `${WD[d.getDay()]} ${d.getDate()} ${MO[d.getMonth()]} · ${two(d.getHours())}:${two(d.getMinutes())}`;
}
/** "Sat 01:00": the short form for tables. @param {number|null|undefined} ms */
export function fmtWhenShort(ms) {
  if (ms == null || !Number.isFinite(ms)) return "—";
  const d = new Date(ms);
  return `${WD[d.getDay()]} ${two(d.getHours())}:${two(d.getMinutes())}`;
}
/** "0x7e57…ffee". @param {string|null|undefined} a */
export const shortAddr = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");
/** "0x1f4c…a9d2". @param {string|null|undefined} h */
export const shortHash = (h) => (h ? `${h.slice(0, 6)}…${h.slice(-4)}` : "");
