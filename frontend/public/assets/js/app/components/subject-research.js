// Shared research components for a portfolio overview and its sessions.
// These render supplied records only. Stance is an opinion, holdings are a
// dated snapshot, and a proposed action is never evidence of execution.
import { sessionSummary } from '../lib/session-summary.js';
import { stanceColor } from '../lib/stance.js';
import { resolveTokenColors } from '../alpine/views/shared.js';

import { escapeHtml, conceptTooltip } from './tooltip.js';
export { escapeHtml } from './tooltip.js';
/** @param {unknown} v */
const finite = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
/** @param {unknown} v */
const money = (v) => finite(v) ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(Number(v)) : 'Not reported';
/** @param {number} v */
const percent = (v) => `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(v * 100)}%`;
/** @type {Record<string, [string, string]>} */
const concepts = {
  view: ['Swarm view', 'The most common stance among submitted takes. A tie is shown as mixed views. This describes member opinion, not an executed decision.'],
  confidence: ['Confidence', 'A member’s self-reported conviction in its take. It is not a probability of profit or a measure of historical accuracy.'],
  holdings: ['Recorded holdings', 'Positions and values at the stated snapshot date. A recommendation does not establish that these holdings changed.'],
};

/** @param {string} key @param {string} id */
export function researchTooltip(key, id) {
  const concept = concepts[key];
  if (!concept) return '';
  return conceptTooltip(concept[0], concept[1], id);
}

/** @param {any} row */
export function stanceTallyMarkup(row) {
  const rows = sessionSummary.stanceSpread(row);
  if (!rows.length) return '<p class="rr-note">No member stances recorded.</p>';
  return `<ul class="pr-tally" aria-label="Member stances">${rows.map(r => `<li><i style="background:${stanceColor(r.stance)}" aria-hidden="true"></i><span>${escapeHtml(r.stance)}</span><b>${r.n}</b></li>`).join('')}</ul>`;
}

/** @param {any} snapshot @returns {Array<any>} */
export function portfolioRows(snapshot) {
  const total = snapshot?.totalValueUsd ?? snapshot?.total_value_usd;
  return (snapshot?.positions || []).map((/** @type {any} */ p, /** @type {number} */ i) => ({ ...p, rowKey: i,
    share: finite(total) && Number(total) > 0 && finite(p.value_usd) ? Number(p.value_usd) / Number(total) : null,
  })).sort((/** @type {any} */ a, /** @type {any} */ b) => (Number(b.value_usd) || 0) - (Number(a.value_usd) || 0));
}

/** @param {any} snapshot @param {boolean} [expanded] */
export function holdingsMarkup(snapshot, expanded = false) {
  const all = portfolioRows(snapshot);
  if (!all.length) return '<p class="rr-note">No positions reported for this snapshot.</p>';
  const colors = resolveTokenColors([...new Set((snapshot?.positions || []).map((/** @type {any} */ p) => p.token))]);
  return `<div class="pr-holdings-wrap"><table class="pr-holdings"><caption class="pr-sr-only">Recorded portfolio positions</caption><thead><tr><th scope="col">Position / chain</th><th scope="col">Share of book</th><th scope="col" class="pr-number">Value</th></tr></thead><tbody>${(expanded ? all : all.slice(0, 8)).map(p => `<tr><th scope="row"><i class="pr-key" data-mark="series" style="background:${colors[p.token]}" aria-hidden="true"></i>${escapeHtml(p.token || 'Unnamed position')}<small>${escapeHtml(p.chain || 'Chain not reported')}</small></th><td><span class="pr-share"><span class="pr-share__track" aria-hidden="true">${p.share == null ? '' : `<i data-mark="series" style="width:${Math.max(0, Math.min(100, p.share * 100))}%;background:${colors[p.token]}"></i>`}</span><b>${p.share == null ? 'Not reported' : percent(p.share)}</b></span></td><td class="pr-number">${money(p.value_usd)}</td></tr>`).join('')}</tbody></table></div>`;
}

// Text filters are literal and operate only on the records supplied by callers.
/** @param {Array<any>} takes @param {string} [query] @param {string} [stance] */
export function filterResearchTakes(takes, query = '', stance = '') {
  const q = query.trim().toLowerCase();
  return takes.filter(t => (!stance || t.stance === stance) && (!q || [t.memberName, t.memberId, t.memberHandle, t.body, t.stance].join(' ').toLowerCase().includes(q)));
}

/** @param {Array<any>} rows @param {string} [query] */
export function filterSessionDates(rows, query = '') {
  const q = query.trim().toLowerCase();
  return rows.filter(row => {
    const d = new Date(`${row.date}T00:00:00Z`);
    const label = Number.isFinite(d.getTime()) ? d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '';
    return `${row.date} ${label}`.toLowerCase().includes(q);
  });
}

export const researchRecord = {
  researchTooltip, stanceTallyMarkup, holdingsMarkup, portfolioRows,
  /** @param {MouseEvent} event */
  researchAnchor(event) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const a = event.target instanceof Element ? event.target.closest('a') : null;
    const href = a?.getAttribute('href');
    if (!href?.startsWith('#') || href.length < 2) return;
    const target = document.getElementById(decodeURIComponent(href.slice(1)));
    if (!target) return;
    event.preventDefault();
    history.pushState({}, '', href);
    target.scrollIntoView({ block: 'start', behavior: 'instant' });
  },
  restoreResearchAnchor() {
    let id = '';
    try { id = decodeURIComponent(location.hash.slice(1)); } catch { return; }
    if (id) document.getElementById(id)?.scrollIntoView({ block: 'start', behavior: 'instant' });
  },

  /** @param {any} row */
  researchView(row) { return sessionSummary.leanLabel(row) === 'split' ? 'Mixed views' : sessionSummary.leanLabel(row) || 'No verdict recorded'; },
  /** @param {any} row */
  researchRationale(row) {
    const r = row?.swarmRecommendation;
    return r && !r.quorum && !r.stances ? r.rationale || '' : '';
  },
  /** @param {any} row */
  researchActions(row) {
    const r = row?.swarmRecommendation;
    return r && !r.quorum && !r.stances && Array.isArray(r.actions) ? r.actions.filter((/** @type {any} */ a) => a?.action) : [];
  },
  /** @param {any} row */
  researchDecision(row) {
    if (row?.swarmRecommendation?.type === 'bucket_weights') return (sessionSummary.sessionWeights(row) || []).filter(w => w.pct > 0).map(w => `${percent(w.pct / 100)} ${w.label}`).join(' · ') || 'Weights not reported';
    const actions = this.researchActions(row);
    if (actions.length) return actions.map((/** @type {any} */ a) => `${a.action} ${a.token || ''}`.trim()).join(' · ');
    return this.researchRationale(row) || 'No proposed actions recorded';
  },
};

export function researchTakeList() {
  /** @type {Record<string, any>} */
  const model = {
    takeQuery: '', takeStance: '', takeLimit: 6,
    filteredResearchTakes() { return filterResearchTakes(this.takes || [], this.takeQuery, this.takeStance); },
    visibleResearchTakes() { return this.filteredResearchTakes().slice(0, this.takeLimit); },
    resetTakeFilter() { this.takeQuery = ''; this.takeStance = ''; this.takeLimit = 6; },
    takeStances() { return [...new Set((this.takes || []).map((/** @type {any} */ t) => t.stance).filter(Boolean))]; },
    /** @param {any} take */
    revealResearchTake(take) {
      this.resetTakeFilter();
      const index = this.takes.indexOf(take);
      this.takeLimit = Math.max(6, index + 1);
      this.$nextTick(() => document.getElementById(this.takeAnchor(take))?.scrollIntoView({ block: 'start', behavior: 'instant' }));
    },
    revealHashTake() {
      const take = (this.takes || []).find((/** @type {any} */ t) => `#${this.takeAnchor(t)}` === location.hash);
      if (take) this.revealResearchTake(take);
    },
  };
  return model;
}
