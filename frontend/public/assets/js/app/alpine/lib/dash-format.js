// Shared compact-currency formatter for the dashboard (issue #449, the
// follow-up several views already forward-referenced as "dash-format.js"
// while they were still page-local — see the breadcrumbs in
// dash-project-profile.js, list.js, list2.js, list3.js, dash-lobster.js).
//
// Before this module landed, the `$X.XXB` / `$X.XXM` / `$X.XK` compact-USD
// branch body was hand-copied into 15 alpine/views/*.js files. Four of the
// fifteen (dash-vaults.js, dash-wallets.js, dash-lobster.js, projects.js)
// checked the THRESHOLD against the raw signed value (`n >= 1e9`) instead of
// `Math.abs(n)`, so a negative billions/millions/thousands value fell
// through every tiered branch into the plain one and rendered as an
// unscaled "$-500" instead of a properly scaled "$-2.00B". The other eleven
// views already computed `abs` first and divided the SIGNED value by the
// tier (`n / 1e9`, not `abs / 1e9`) — that keeps the minus sign attached to
// the number itself ("$-2.00B"), which is the majority/intended rendering
// this module standardizes on (dash-project-profile.js was the one holdout
// that extracted the sign and prefixed it before the `$` — "-$2.00B" — and
// has been converged onto the majority style here, since 11 of the other 14
// views already agreed on the "$-2.00B" shape).
//
// Two more per-view differences turned out to be intentional, not bugs, and
// are preserved as options rather than silently dropped:
//   - dash-coin-profile.js's `fmtUsd` doubles as its price formatter (coin
//     prices can be sub-cent), so its sub-$1 case needs 4-6dp instead of a
//     flat 2dp -> `smallPrecision`.
//   - regime.js's "usd" unit adds a trillion tier (macro-scale indicators),
//     has NO K tier at all (everything below $1M is the rounded,
//     comma-grouped base case, not a "$5.0K"), and formats that base case as
//     a rounded integer rather than toFixed(2) -> `trillion` + `skipKTier` +
//     `baseInteger`.
//   - projects.js treats an exact 0 as "no data" (an em-dash) where its
//     siblings render "$0.00" -> `zeroDash`.
//   - dash-vaults.js/dash-wallets.js/dash-lobster.js/projects.js render the
//     sub-$1K case with 0 decimals (`"$500"`), not the majority's 2
//     (`"$500.00"`) -> `baseDecimals`. Kept as-is (not "fixed" to 2) because
//     the acceptance bar for this consolidation is "previously-correct
//     non-negative output is byte-identical", and this precision choice was
//     never wrong for non-negative values — only the sign handling was.
//
// Pure `(number|null|undefined, opts) -> string`, no DOM/CSSOM dependency —
// see scripts/tests/unit/dash-format.test.ts.

/**
 * @typedef {{
 *   baseDecimals?: number,
 *   zeroDash?: boolean,
 *   smallPrecision?: boolean,
 *   trillion?: boolean,
 *   skipKTier?: boolean,
 *   baseInteger?: boolean,
 * }} FmtUsdCompactOpts
 */

/**
 * @param {number|null|undefined} n
 * @param {FmtUsdCompactOpts} [opts]
 * @returns {string}
 */
export function fmtUsdCompact(n, opts = {}) {
  const {
    baseDecimals = 2,
    zeroDash = false,
    smallPrecision = false,
    trillion = false,
    skipKTier = false,
    baseInteger = false,
  } = opts;
  if (n == null || !isFinite(n)) return "—";
  if (zeroDash && n === 0) return "—";
  const abs = Math.abs(n);
  if (trillion && abs >= 1e12) return "$" + (n / 1e12).toFixed(2) + "T";
  if (abs >= 1e9) return "$" + (n / 1e9).toFixed(2) + "B";
  if (abs >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
  if (!skipKTier && abs >= 1e3) return "$" + (n / 1e3).toFixed(1) + "K";
  if (smallPrecision) return abs >= 1 ? "$" + n.toFixed(4) : "$" + n.toFixed(6);
  if (baseInteger) return "$" + Math.round(n).toLocaleString();
  return "$" + n.toFixed(baseDecimals);
}
