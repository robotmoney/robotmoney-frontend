// @ts-nocheck — buildless DOM rendering; contract and behavior are validated by research tests.
// Production data and route lifecycle. Renderers contain no fetching or routing.
import { canonicalUrlFor } from '../seo.js';
import { api, ROUTES, path } from '../lib/api.js';
import { adapt } from './data.js';
import { subjectPage, sessionPage, historyRow, sessionPath } from './pages.js';
import { esc } from '../components/research.js';
import { enhanceResearch } from './enhance.js';

import { ALLOCATION_SUBJECT_ID as SUBJECT } from '../lib/allocation-subject.js';
const PAGE_SIZE = 12;
const errorCopy = error => error?.status === 404
  ? 'This allocation session could not be found.'
  : 'Allocation research is temporarily unavailable. Please try again.';

export function allocationResearch(preloaded = null) {
  let disposed = false, cleanup = () => {}, requestId = 0;
  let controller = new AbortController();
  const get = (route, query) => api.get(route, query, {
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
  });
  return {
    async init() { await this.load(); },
    destroy() { disposed = true; requestId++; controller.abort(); cleanup(); },
    async load() {
      controller.abort();
      controller = new AbortController();
      const root = this.$el;
      const request = ++requestId;
      cleanup();
      root.innerHTML = '<article class="rr rr--live"><p role="status">Loading allocation research…</p></article>';
      try {
        if (location.pathname.replace(/\/$/, '') === `/swarm/subjects/${SUBJECT}`) {
          const response = await get(ROUTES.swarm.sessions, { subject: SUBJECT, state: 'published', limit: PAGE_SIZE });
          if (disposed || request !== requestId) return;
          if (!response.sessions.length) {
            root.innerHTML = '<article class="rr rr--live"><h1>Robot Money Allocation</h1><p>No published allocation reviews yet.</p><a href="/allocation">Allocation & vaults ↗</a></article>';
            return;
          }
          const latest = await this.record(await get(path(ROUTES.swarm.sessionById, { id: response.sessions[0].id })));
          if (disposed || request !== requestId) return;
          root.innerHTML = subjectPage(response.sessions.map(s => adapt(s, null, {}, 'live')), 'live', { latest });
          const history = root.querySelector('#history');
          history.dataset.remoteList = 'true';
          // A global search runs on the server. Never silently search just the loaded page.
          const form = history.querySelector('form');
          form.elements.kind.closest('label').remove();
          form.elements.search.maxLength = 200;
          const state = { cursor: null, next: response.nextCursor, previous: [], search: '', page: 1 };
          const updatePager = () => {
            for (const pager of history.querySelectorAll('[data-pager]')) {
              pager.hidden = false;
              pager.querySelector('[data-count]').textContent = `Page ${state.page}`;
              pager.querySelector('[data-page=previous]').disabled = !state.previous.length;
              pager.querySelector('[data-page=next]').disabled = !state.next;
            }
          };
          let busy = false;
          const fetchPage = async (cursor, previous, search, page) => {
            if (busy) return;
            busy = true;
            history.setAttribute('aria-busy', 'true');
            history.querySelectorAll('button, input').forEach(control => { control.disabled = true; });
            history.querySelectorAll('[data-count]').forEach(label => { label.textContent = 'Loading…'; });
            const empty = history.querySelector('[data-empty]');
            try {
              const result = await get(ROUTES.swarm.sessions, { subject: SUBJECT, state: 'published', limit: PAGE_SIZE, ...(cursor ? { cursor } : {}), ...(search ? { search } : {}) });
              if (disposed || request !== requestId) return;
              Object.assign(state, { cursor, next: result.nextCursor, previous, search, page });
              history.querySelector('tbody').innerHTML = result.sessions.map(s => historyRow(adapt(s, null, {}, 'live'))).join('');
              root.querySelector('[data-history-count]').textContent = result.sessions.length;
              empty.hidden = result.sessions.length !== 0;
              empty.textContent = 'No sessions match this search.';
              updatePager();
            } catch {
              if (!disposed) { empty.hidden = false; empty.textContent = 'History could not be loaded. Your previous results are still shown. Try again.'; }
            } finally {
              busy = false;
              history.removeAttribute('aria-busy');
              history.querySelectorAll('button, input').forEach(control => { control.disabled = false; });
              updatePager();
            }
          };
          form.addEventListener('submit', event => { event.preventDefault(); fetchPage(null, [], form.elements.search.value.trim(), 1); });
          form.addEventListener('reset', () => { fetchPage(null, [], '', 1); });
          history.addEventListener('click', event => {
            const direction = event.target.closest('[data-page]')?.dataset.page;
            if (direction === 'next' && state.next) fetchPage(state.next, [...state.previous, state.cursor], state.search, state.page + 1);
            if (direction === 'previous' && state.previous.length) fetchPage(state.previous.at(-1), state.previous.slice(0, -1), state.search, state.page - 1);
          });
          updatePager();
        } else {
          const match = location.pathname.match(/^\/swarm\/(\d{4}-\d{2}-\d{2})\/robotmoney-allocation\/?$/);
          const detail = preloaded ?? await get(path(ROUTES.swarm.session, { date: match?.[1], subject: SUBJECT }));
          const record = await this.record(detail);
          if (disposed || request !== requestId) return;
          root.innerHTML = sessionPage(record, [record]);
          // Stable id is canonical even when arriving through a historical dated link.
          const canonical = document.querySelector('link[rel=canonical]');
          if (canonical) canonical.href = canonicalUrlFor(sessionPath(record));
          document.title = `Allocation review · ${record.date} | Robot Money`;
        }
        cleanup = enhanceResearch(root);
      } catch (error) {
        if (disposed || request !== requestId) return;
        root.innerHTML = `<article class="rr rr--live"><h1>Allocation research</h1><p role="alert">${esc(errorCopy(error))}</p><button type="button" data-retry>Try again</button><p><a href="/swarm/subjects/${SUBJECT}">All allocation sessions</a></p></article>`;
        root.querySelector('[data-retry]').addEventListener('click', () => this.load());
      }
    },
    async record(detail) {
      if (!detail?.session || detail.session.subjectId !== SUBJECT) throw new Error('Unexpected allocation session');
      // One session's own brief, never the latest brief for its date.
      const receiptSource = path(ROUTES.swarm.sessionConsensusReceipt, { id: detail.session.id });
      const [briefResult, receiptResult] = await Promise.allSettled([
        get(ROUTES.swarm.brief, { session: detail.session.id }),
        get(receiptSource),
      ]);
      const record = adapt(detail, briefResult.status === 'fulfilled' ? briefResult.value : null, {}, 'live');
      record.briefUnavailable = briefResult.status === 'rejected' && briefResult.reason.status !== 404;
      record.receiptSource = receiptSource;
      record.receiptStatus = receiptResult.status === 'fulfilled'
        ? receiptResult.value.verified === true ? 'Verified' : 'Not verified'
        : receiptResult.reason.status === 404 ? 'Not published' : 'Temporarily unavailable';
      return record;
    },
  };
}
