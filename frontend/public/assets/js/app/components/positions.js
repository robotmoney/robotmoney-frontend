// Compact position composition shared by vault detail and the component library.
// Identity follows source order. Never infer weights from an incomplete total.
import { CATEGORICAL } from '../lib/chart-theme.js';
import { bps, money, weight } from '../lib/vault-data.js';
import { escapeHtml as esc } from './tooltip.js';

export function positionRows(holdings = []) {
  return holdings.map((h, index) => ({ ...h, index,
    weightBps: bps(h.weightBps),
    color: CATEGORICAL[Math.min(index, 6)],
  }));
}
export function positionComposition(holdings = [], expanded = false) {
  const rows = positionRows(holdings);
  if (!rows.length) return '';
  const complete = rows.every(r => r.weightBps !== null);
  const total = rows.reduce((sum, r) => sum + (r.weightBps || 0), 0);
  // A partial or inconsistent denominator must not become a full allocation bar.
  const comparable = complete && total > 0 && Math.abs(total - 10000) < 5;
  const segments = rows.slice(0, 6).map(r => ({ ...r, label: r.label || 'Unnamed position' }));
  if (rows.length > 6) segments.push({ index: 6, color: CATEGORICAL[6], label: `${rows.length - 6} other positions`, weightBps: rows.slice(6).reduce((n, r) => n + (r.weightBps || 0), 0) });
  return `<div class="vp-composition" x-data="{ selected: null }">
    ${comparable ? `<div class="vp-band" aria-label="Holdings composition">${segments.filter(r => r.weightBps > 0).map(r => `<button type="button" data-mark="series" style="flex:${r.weightBps};background:${r.color}" @mouseenter="selected=${r.index}" @mouseleave="selected=null" @focus="selected=${r.index}" @blur="selected=null" @click="selected=${r.index}" @keydown.escape="selected=null" :aria-pressed="selected===${r.index}" aria-label="${esc(r.label)}: ${weight(r.weightBps)}"><span class="vv-sr">${esc(r.label)}</span></button>`).join('')}</div><div class="vp-band-reading" aria-live="polite"><span x-show="selected === null">${rows.length} positions</span>${segments.map(r => `<span x-cloak x-show="selected===${r.index}">${esc(r.label)} <b>${weight(r.weightBps)}</b></span>`).join('')}</div>` : '<p class="vv-meta">Complete position weights are not available.</p>'}
    <div class="vp-column-head" aria-hidden="true"><span>Position</span><span>Of vault</span><span>Value</span></div>
    ${(expanded ? rows : rows.slice(0, 8)).map(r => `<details class="vp-position" :class="{ 'vp-position-active': selected===${Math.min(r.index,6)} }">
      <summary><span class="vp-name"><i aria-hidden="true" data-mark="series" style="background:${r.color}"></i><span>${esc(r.label || 'Unnamed position')}<small>${esc(r.kind || 'Position')}</small></span></span><span class="vp-weight">${weight(r.weightBps)}</span><span class="vp-value">${money(r.valueUsd)}<i aria-hidden="true">+</i></span></summary>
      <dl class="vv-facts vp-facts"><div><dt>Target weight</dt><dd>${weight(r.targetBps)}</dd></div><div><dt>Price source</dt><dd>${esc(r.priceSource || 'Not reported')}</dd></div><div><dt>Balance</dt><dd>${esc(r.balance ?? 'Not reported')}</dd></div><div><dt>Address</dt><dd>${esc(r.address || 'Not reported')}</dd></div></dl>
    </details>`).join('')}
  </div>`;
}
