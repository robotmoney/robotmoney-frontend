// Shared concept disclosure. Interaction and viewport placement live in lib/tooltip.js.
/** @param {unknown} value */
export const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] || c);
/** @param {string} title @param {string} description @param {string} id */
export function conceptTooltip(title, description, id, label = '') {
  const esc = escapeHtml;
  return `<span class="rm-tip${label ? ' rm-tip--label' : ''}" data-floating="1"><button type="button" class="rm-tip__btn${label ? ' rm-tip__btn--text' : ''}" aria-label="About ${esc(title.toLowerCase())}" aria-expanded="false" aria-describedby="${esc(id)}">${label ? esc(label) : '?'}</button><span class="rm-tip__bub" role="tooltip" id="${esc(id)}">${esc(description)}</span></span>`;
}
