// Small HTML renderers shared by allocation, vault detail and the catalogue.
import { escapeHtml as esc, conceptTooltip } from "./tooltip.js";
import { gapLabel, numberOrNull, bps } from "../lib/vault-data.js";
import { CATEGORICAL } from "../lib/chart-theme.js";
const concepts = {
  recommended: [
    "Recommended",
    "The latest published swarm recommendation. Publication does not mean it has been released on chain or applied by the router.",
  ],
  applied: [
    "Applied",
    "The router’s effective weights for new deposits. A change does not rebalance assets already in the vaults.",
  ],
  actual: [
    "Actual",
    "Each vault’s assets divided by the combined assets of all vaults on this network. Unreadable vault totals make all actual weights unavailable.",
  ],
  gap: [
    "Allocation gap",
    "Actual minus recommended, in percentage points. Applied minus recommended is the governance gap; actual minus applied is the flow gap.",
  ],
  tracking: [
    "Tracking error",
    "Half the sum of absolute gaps between actual and recommended weights. Not a return or a measure of investment risk.",
  ],
  nav: [
    "NAV per share",
    "The vault’s net asset value divided by its outstanding shares, at the stated observation time.",
  ],
};
/** @param {string} key @param {string} id */
export function vaultTooltip(key, id, label = "") {
  const c = concepts[key];
  return c ? conceptTooltip(c[0], c[1], id, label) : "";
}
/**
 * Three equal-weight readings on one 0–100% scale. The numerical gap is
 * primary; its two causes are available through a native disclosure.
 * @param {any} row
 * @param {string} [idPrefix] Unique when the same vault appears twice.
 */
export function weightLayers(
  row,
  idPrefix = `weights-${row.slug || row.symbol}`,
) {
  const color = CATEGORICAL.includes(row.color) ? row.color : CATEGORICAL[0];
  const gap = numberOrNull(row.gaps?.total);
  const gapClass = gap > 0 ? "vv-up" : gap < 0 ? "vv-down" : "";
  const reading = (value) =>
    bps(value) === null
      ? '<span class="vv-reading-missing">Unavailable</span>'
      : `<span>${(value / 100).toFixed(2)}<small>%</small></span>`;
  const rows = ["recommended", "applied", "actual"]
    .map((key, index) => {
      const v = bps(row[key + "Bps"]);
      const label = ["Recommended", "Applied", "Actual"][index];
      return `<div class="vv-layer${v === null ? " vv-layer-missing" : ""}">
      <span class="vv-layer-label">${vaultTooltip(key, `${idPrefix}-${key}`, label)}</span>
      <span class="vv-track" aria-hidden="true">${v === null ? "" : `<i data-mark="series" style="width:${v / 100}%;--series:${color}"></i>`}</span>
      <b class="vv-reading">${reading(v)}</b>
    </div>`;
    })
    .join("");
  return `<div class="vv-layers" aria-label="Allocation weights for ${esc(row.symbol)}">
    <div class="vv-chart-context"><span>Share of all vault assets</span><span>0–100%</span></div>
    <div class="vv-weight-rows">${rows}</div>
    <details class="vv-gap-detail">
      <summary><span>Gap to recommendation</span><b class="${gapClass}">${gap === null ? '<span class="vv-reading-missing">Unavailable</span>' : gapLabel(gap)}</b><span class="vv-gap-toggle" aria-hidden="true">+</span></summary>
      <dl class="vv-gap-breakdown">
        <div><dt>Governance gap<small>Applied − recommended</small></dt><dd>${gapLabel(row.gaps?.governance)}</dd></div>
        <div><dt>Flow gap<small>Actual − applied</small></dt><dd>${gapLabel(row.gaps?.flow)}</dd></div>
      </dl>
    </details>
  </div>`;
}
