# Next Agent Prompt: Visual-Parity Status (robotmoney-frontend)

## Context

The buildless `robotmoney-frontend` SPA mirrors the public surface of the
original Next.js site `robotmoney-site`. All ~26 target pages exist and render.
The P0 + P1 visual-parity gaps from the prior screenshot audit are now **closed**
(see "Done" below). What remains is **P2 optional richness** only.

**Branch:** `adhoc/20260630-125844-feature-parity-visualizations-nemotron`
**Worktree:** `/home/lucas/tmp/superfield-worktrees/robotmoney-frontend/adhoc-20260630-125844-feature-parity-visualizations`

## Critical architecture constraint (read first)

The client router (`frontend/public/assets/js/app/router.js`) injects each view
via `host.innerHTML = html`. **Scripts inserted via innerHTML do NOT execute**,
so inline `<script>` and any `Alpine.data(...)` factory defined *inside* a
`/views/*.html` fragment are dead. Two valid patterns:

1. **Static fragment** (default): bake data into markup; charts as CSS visuals;
   conditional global chrome via CSS `:has()` (see docs shell below).
2. **Boot-registered factory**: add the factory to
   `frontend/public/assets/js/app/alpine/views.js` (loaded before Alpine boots),
   then reference it with `x-data="myFactory()"` and drive a
   `<canvas x-ref="chart">`. Use only if you genuinely need real Chart.js/JS.

## Done (this pass)

- **Docs 3-column shell.** New `frontend/public/assets/css/docs-shell.css`
  (linked in `index.html`) + all 9 `/docs*` views wrapped in
  `.docs-shell` → `.docs-sidebar` (nav tree) + `.docs-main` + `.docs-toc`
  ("On this page"). Global `.nav`/`.footer` are hidden on docs routes via
  `body:has(.docs-shell)` — fully static, no per-view script. Active sidebar
  link + h2-derived TOC per page.
- **FAQ** (`views/faq.html`): all 32 Q&As now render as open prose
  (sans `h2` question + muted answer), no accordion.
- **Blog index** (`views/blog.html`): left CSS-gradient thumbnail column added;
  post set/order reconciled to the original 12-entry date-sorted list.
- **Tokenomics** (`views/tokenomics.html`): placeholder squares replaced with
  inline line-icon SVGs (utility / principles / governance / participation
  cards). Heading font-style left as-is — the original IS serif-italic, so the
  port already matched (the prior audit's "upright serif" note was inaccurate).
- **Copy buttons** (P2): global delegated clipboard handler in `main.js`
  (boot-registered → works for injected views). `[data-copy="<text>"]` copies a
  literal (tokenomics contract address); `[data-copy-code]` copies the `<pre>`
  text of its `.docs-codeblock`. A Copy button is wired into the tokenomics
  contract row and into every docs/skill code-block bar (44 blocks across 7
  views; styled once in `docs-shell.css`). All functionally verified end-to-end.
- **Hero animations** (P2): every navigable page that had a p5 hero in the
  original now has it back, as boot-registered Alpine factories in new
  `assets/js/app/alpine/heroes.js` (same lifecycle as `substrate.js`):
  `blogHero()` (generative tree), `faqHero()` (WebGL terrain mesh), `tokHero()`
  (boids flock + predator), `mediaHero()` (network swarm), `changelogHero()`
  (flow field). Home already used `substrate()`. Each is layered behind its hero
  title; all 14 navigable routes render with no console errors.

Each fix is its own commit; re-screenshotted on `:8080` against
`frontend/test/fixtures/screenshots/original/<slug>.png` and confirmed close.

## Remaining — P2 optional richness (low value; everything above is done)

Only stylistic chart differences remain; both render correctly with matching
data, so these are genuinely optional:

1. **Real charts.** The tokenomics fee donut is a CSS conic-gradient (the
   original is a Chart.js doughnut — visually near-identical). allocation2 uses
   CSS **stacked bars** where the original used Chart.js **stacked areas** (same
   data, slightly different style). For exact parity, register chart factories in
   `views.js` (boot-time) like the regime/research views do.
2. **allocation2 constructivist hero.** Its hero is a static shapes/gradient
   approximation of the original animated "constructivist" p5 canvas. Could be
   ported as another `heroes.js` factory if desired (lower priority).

Hero parity for navigable pages is otherwise complete — only the out-of-scope
standalone visualization pages still lack sketches (intentionally; see below).

## How to run + screenshot

Static server: serve `frontend/public` with SPA fallback (extension-less paths
→ `index.html`) on `:8080`. Playwright + Chromium are installed; resolve the
package via its absolute path under
`/home/lucas/.npm/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs`
(ESM import; `NODE_PATH` does not help ESM). Capture at 1440x900,
`waitUntil:'load'`, wait for `#view` non-empty, full page; compare to the
matching `frontend/test/fixtures/screenshots/original/<slug>.png`.

## Out of scope (do NOT build)

`/regime_2panel`, `/regime-detection`, `/smart-contract-risks`,
`/tech-proposal-march-16`, `/flow-field`, and the 28 standalone visualization
pages. A few ported pages (incl. the blog index) link to these; the router falls
back to home gracefully (no 404). Leave as-is unless the user asks to build them.
