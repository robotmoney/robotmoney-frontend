# Feature Parity Plan: robotmoney-site → robotmoney-frontend

**Goal:** Bring robotmoney-frontend to pixel-perfect feature parity with robotmoney-site (legacy Next.js/React/Tailwind). This repo uses a **buildless** stack (HTML + Alpine.js + hand-written CSS + Bun/Postgres backend).

**Branch:** `adhoc/20260630-125844-feature-parity-visualizations-nemotron`
**Worktree:** `/home/lucas/tmp/superfield-worktrees/robotmoney-frontend/adhoc-20260630-125844-feature-parity-visualizations`

---

## 1. Pages Inventory Comparison

### Current robotmoney-frontend (7 view files)
```
frontend/public/views/
├── home.html                      → / (home)
├── regime.html                    → /regime
├── research/
│   ├── channel-divergence.html    → /research/channel-divergence
│   └── late-cycle-signals.html    → /research/late-cycle-signals
├── committee.html                 → /committee
├── committee/
│   └── apply.html                 → /committee/apply
└── sections/                      # Home sections (included in home.html)
    ├── architecture.html
    ├── contract.html
    ├── footer.html
    ├── governance.html
    ├── problem.html
    └── token.html
```

### Target robotmoney-site (70+ pages)
| Category | Pages | Status |
|----------|-------|--------|
| **Marketing / Core** | `/`, `/disclaimer`, `/changelog`, `/faq`, `/docs/*` | ❌ Missing |
| **Allocation / Vault** | `/allocation`, `/allocation-v2`, `/allocation2`, `/allocation3`, `/allocation2_fixingtotals`, `/tokenomics` | ❌ Missing |
| **Regime / Research** | `/regime`, `/regime/indicators`, `/regime-detection`, `/regime-preview`, `/regime_2panel`, `/regime_2panel/indicators`, `/research/channel-divergence`, `/research/late-cycle-signals` | ⚠️ Partial |
| **Committee** | `/committee`, `/committee/[date]/[subject]`, `/committee/members/[id]`, `/committee/subjects/[id]`, `/committee/apply` | ⚠️ Partial |
| **Visualizations (37)** | `/matrix-rain`, `/substrate`, `/flow-field`, `/tree`, `/fractal-tree`, `/network-swarm`, `/liquid-mesh`, `/attractor`, `/constellation`, `/constructivist`, `/dla`, `/flock`, `/mandelbrot`, `/orbits`, `/reaction`, `/terrain`, `/voronoi`, `/waves`, `/epicycles`, `/chladni`, `/slime-mold`, `/double-pendulum`, `/turing`, `/phyllotaxis`, `/space-filling`, `/moire`, `/magnetic-field`, `/plasma`, `/visualization`, `/visualizations`, `/splash2`, `/home2`, `/home_archived` | ❌ Missing |
| **Blog / Media** | `/blog`, `/blog/*` (6 posts), `/media`, `/media/articles`, `/media/videos`, `/articles/treasury-allocation` | ❌ Missing |
| **Docs / Skills** | `/docs`, `/docs/investment-committee/*` (4), `/docs/skill/*` (4), `/skills` | ❌ Missing |
| **Special** | `/smart-contract-risks`, `/tech-proposal-march-16`, `/turing`, `/tree`, `/display/projects` | ❌ Missing |

**Total new pages to create: ~63**

---

## 2. Visualizations to Port (37 effects)

All visualizations in robotmoney-site are **p5.js sketches** (React components with `useEffect` loading p5 from CDN). In the buildless frontend, they must be ported as **vanilla p5 instances** mounted into `#view` via Alpine or plain JS.

### Hero/Background Effects (used on multiple pages)
| Effect | Source | Used On |
|--------|--------|---------|
| Substrate (crystal growth) | `src/app/page.tsx`, `src/app/substrate/page.tsx` | Home, /substrate |
| Flow Field | `src/app/flow-field/page.tsx` | /flow-field |
| Network Swarm | `src/app/network-swarm/page.tsx` | /network-swarm |
| Liquid Mesh | `src/app/liquid-mesh/page.tsx` | /liquid-mesh, /allocation hero |
| Orbits | `src/components/OrbitsCanvas.tsx` | /regime, /orbits |
| Slime Mold | `src/components/committee/SlimeMoldHero.tsx` | /committee |

### Standalone Visualization Pages (37)
Each needs a dedicated `views/visualizations/<name>.html` + JS sketch module.

| # | Path | Type | Complexity |
|---|------|------|------------|
| 1 | `/matrix-rain` | Canvas (chars) | Low |
| 2 | `/substrate` | Canvas (crack growth) | High |
| 3 | `/flow-field` | Canvas (particles + perlin) | Medium |
| 4 | `/tree` | Canvas (recursive) | Low |
| 5 | `/fractal-tree` | Canvas (recursive) | Low |
| 6 | `/network-swarm` | Canvas (nodes + data pixels) | Medium |
| 7 | `/liquid-mesh` | Canvas (deformable grid + scatter) | High |
| 8 | `/attractor` | Canvas (Lorenz) | Low |
| 9 | `/constellation` | Canvas (stars + connections) | Low |
| 10 | `/constructivist` | Canvas (geometric) | Low |
| 11 | `/dla` | Canvas (diffusion-limited agg) | Medium |
| 12 | `/flock` | Canvas (boids) | Medium |
| 13 | `/mandelbrot` | Canvas (fractal) | Low |
| 14 | `/orbits` | Canvas (elliptical) | Low |
| 15 | `/reaction` | Canvas (reaction-diffusion) | Medium |
| 16 | `/terrain` | Canvas (procedural) | Low |
| 17 | `/voronoi` | Canvas (cellular) | Low |
| 18 | `/waves` | Canvas (sine interference) | Low |
| 19 | `/epicycles` | Canvas (Fourier) | Medium |
| 20 | `/chladni` | Canvas (resonance) | Low |
| 21 | `/slime-mold` | Canvas (physarum) | Medium |
| 22 | `/double-pendulum` | Canvas (chaos) | Low |
| 23 | `/turing` | Canvas (reaction-diffusion) | Medium |
| 24 | `/phyllotaxis` | Canvas (golden spiral) | Low |
| 25 | `/space-filling` | Canvas (Hilbert curve) | Low |
| 26 | `/moire` | Canvas (interference) | Low |
| 27 | `/magnetic-field` | Canvas (field lines) | Medium |
| 28 | `/plasma` | Canvas (metaballs) | Medium |
| 29 | `/visualization` | Canvas (gallery entry) | — |
| 30 | `/visualizations` | Index page with SVG previews | — |
| 31 | `/splash2` | Canvas | Low |
| 32 | `/home2` | Page variant | — |
| 33 | `/home_archived` | Page variant | — |
| 34 | `/smart-contract-risks` | Content page | — |
| 35 | `/tech-proposal-march-16` | Content page | — |
| 36 | `/tree` | Content page (not visualization) | — |
| 37 | `/display/projects` | Content page | — |

**Note:** `/visualizations` index uses `VisualizationsPreview.tsx` which renders **static SVG previews** for all 37 effects. This is a separate component that generates SVG strings—must be ported to generate static SVGs at build time or runtime.

---

## 3. Components to Port

### React Components → Alpine.js / Vanilla JS

| Component | Source | Target Approach |
|-----------|--------|-----------------|
| `Navigation` | `src/components/Navigation.tsx` | Alpine component in `assets/js/app/alpine/navigation.js` |
| `Footer` | `src/components/Footer.tsx` | Static HTML partial (`views/sections/footer.html`) |
| `Hero` | `src/components/Hero.tsx` | Home view includes substrate canvas |
| `ProblemSection` | `src/components/ProblemSection.tsx` | `views/sections/problem.html` |
| `ArchitectureSection` | `src/components/ArchitectureSection.tsx` | `views/sections/architecture.html` + VaultMonolithSVG |
| `TokenSection` | `src/components/TokenSection.tsx` | `views/sections/token.html` |
| `GovernanceSection` | `src/components/GovernanceSection.tsx` | `views/sections/governance.html` |
| `ContractSection` | `src/components/ContractSection.tsx` | `views/sections/contract.html` |
| `EconomicsSection` | `src/components/EconomicsSection.tsx` | New section |
| `InfrastructureSection` | `src/components/InfrastructureSection.tsx` | New section |
| `RoadmapSection` | `src/components/RoadmapSection.tsx` | New section |
| `AllocationSection` | `src/components/AllocationSection.tsx` | New page `/allocation` |
| `CommentsSection` | `src/components/CommentsSection.tsx` | Uses backend comments API |
| `OrbitsCanvas` | `src/components/OrbitsCanvas.tsx` | p5 sketch module |
| `SlimeMoldHero` | `src/components/committee/SlimeMoldHero.tsx` | p5 sketch module |
| `Avatar` | `src/components/committee/Avatar.tsx` | Alpine component |
| `VisualizationsPreview` | `src/components/VisualizationsPreview.tsx` | Static SVG generator module |
| `RegimeDashboard` | `src/app/regime-detection/RegimeDashboard.tsx` | Alpine + Chart.js |
| `HistoryChart` / `BacktestChart` / `Sparkline` | `src/app/regime-detection/*.tsx` | Chart.js modules |

### SVG Components → Static SVG Files or Inline
| SVG | Source | Target |
|-----|--------|--------|
| `VaultMonolithSVG` | `src/components/svg/VaultMonolithSVG.tsx` | `assets/svg/vault-monolith.svg` |
| `VaultBeamSVG` | `src/components/svg/VaultBeamSVG.tsx` | `assets/svg/vault-beam.svg` |
| `VaultCorridorSVG` | `src/components/svg/VaultCorridorSVG.tsx` | `assets/svg/vault-corridor.svg` |
| `VaultCubeRow` | `src/components/svg/VaultCubeRow.tsx` | `assets/svg/vault-cube-row.svg` |
| `MonolithLogoSVG` | `src/components/svg/MonolithLogoSVG.tsx` | `assets/svg/monolith-logo.svg` |
| `AnimatedBeamSVG` | `src/components/svg/AnimatedBeamSVG.tsx` | CSS animation + SVG |
| `AnimatedServerGrid` | `src/components/svg/AnimatedServerGrid.tsx` | CSS animation + SVG |
| `ServerGridSVG` | `src/components/svg/ServerGridSVG.tsx` | `assets/svg/server-grid.svg` |
| `DataStreamSVG` | `src/components/svg/DataStreamSVG.tsx` | CSS animation + SVG |

---

## 4. Data & Backend Requirements

### Static Data Files (in `frontend/public/data/`)
| File | Source | Used By |
|------|--------|---------|
| `regime-history.csv` | `data/regime/regime-history.csv` | Regime page |
| `regime-versions.json` | `data/regime/regime-versions.json` | Regime page |
| `raw-indicator-history.csv` | `data/regime/raw-indicator-history.csv` | Regime page |
| `regime-eq-snapshot.json` | `public/data/regime-eq-snapshot.json` | RegimeDashboard |
| `hourly-wallet-balances.csv` | `data/unified-wallet-history.csv` | Allocation page |
| `hourly-vault-tvl.csv` | (generated) | Allocation page |
| `vault-apy.json` | (generated) | Allocation page |
| `committee/research.json` | `data/committee/research.json` | Committee pages |
| `committee/subjects/*.json` | `data/committee/subjects/*.json` | Committee pages |
| `committee/members/*.json` | `data/committee/members/*.json` | Committee pages |
| `committee/allocation.json` | `data/committee/allocation.json` | Allocation page |
| `wallet.ts` config | `src/config/wallet.ts` | Allocation page |

### Backend API Endpoints Needed
| Endpoint | Purpose | Status |
|----------|---------|--------|
| `/api/dashboards/regime-snapshots` | Regime data | ✅ Exists |
| `/api/dashboards/research-signals/:key` | Research signals | ✅ Exists |
| `/api/committee/*` | Committee CRUD | ✅ Partial |
| `/api/comments` | Comments | ✅ Exists |
| `/api/wallet/holdings` | Wallet balances | ❌ New |
| `/api/vault/tvl` | Vault TVL | ❌ New |
| `/api/vault/apy` | Vault APY | ❌ New |
| `/api/buybacks` | Buyback history | ❌ New |

### Task Queue Jobs Needed
| Job Kind | Purpose | Schedule |
|----------|---------|----------|
| `analytics.run` | Regime + research signals | Daily |
| `wallet.sync` | Fetch hourly balances | Hourly |
| `vault.sync` | Fetch vault TVL | Hourly |
| `buybacks.sync` | Index buyback txns | Hourly |
| `committee.open_session` | IC session lifecycle | Daily |
| `committee.publish_brief` | IC brief | Daily |
| `committee.close_window` | IC submission close | Daily |
| `committee.aggregate` | IC rollup | Daily |
| `committee.publish` | IC publish | IC publish | Daily |

---

## 5. CSS / Design System

### Current State
`frontend/public/assets/css/` has:
- `tokens.css` — design tokens (colors, fonts, easing)
- `design-system.css` — base/reset, utilities
- `components.css` — semantic component classes
- `sections/*.css` — per-section styles
- `views.css` — view-level styles

### Missing from robotmoney-site
| Token/Utility | Source | Action |
|---------------|--------|--------|
| `--color-blue`, `--color-warn`, `--color-void`, `--color-deep`, `--color-surface` | Tailwind config | Add to `tokens.css` |
| `glow-green`, `animate-fade-in-up`, `animate-float`, `animate-pulse` | Tailwind utilities | Add to `design-system.css` |
| `text-gradient` (cyan gradient text) | Tailwind | Already in `design-system.css` |
| `grid-pattern` | Tailwind | Already in `design-system.css` |
| `prose-rm` | Tailwind | Already in `design-system.css` |

**Action:** Audit `tailwind.config.ts` and `globals.css` from robotmoney-site, ensure all tokens/utilities exist in hand-written CSS.

---

## 6. Implementation Phases

### Phase 0: Foundation (Week 1)
- [ ] Create worktree, branch, this plan doc
- [ ] Audit & sync design tokens from robotmoney-site → `tokens.css`
- [ ] Port `Navigation` → Alpine component
- [ ] Port `Footer` → static partial
- [ ] Set up `assets/js/app/lib/visualizations/` module system for p5 sketches
- [ ] Create `views/visualizations/index.html` (gallery page)
- [ ] Port `VisualizationsPreview.tsx` → static SVG generator (`assets/js/app/lib/visualization-previews.js`)

### Phase 1: Core Marketing Pages (Week 1-2)
- [ ] `/disclaimer` → `views/disclaimer.html`
- [ ] `/changelog` → `views/changelog.html`
- [ ] `/faq` → `views/faq.html`
- [ ] `/docs` → `views/docs/index.html` + subpages
- [ ] `/skills` → `views/skills.html`
- [ ] `/tokenomics` → `views/tokenomics.html`
- [ ] `/smart-contract-risks` → `views/smart-contract-risks.html`
- [ ] `/tech-proposal-march-16` → `views/tech-proposal-march-16.html`
- [ ] Blog index `/blog` + 6 posts → `views/blog/*.html`
- [ ] Media pages `/media`, `/media/articles`, `/media/videos` → `views/media/*.html`
- [ ] `/articles/treasury-allocation` → `views/articles/treasury-allocation.html`

### Phase 2: Visualization Pages (Week 2-4)
**Strategy:** Create a p5 sketch module for each effect, then a thin HTML view that mounts it.

| Batch | Visualizations | Notes |
|-------|----------------|-------|
| 2a | `substrate`, `flow-field`, `network-swarm`, `liquid-mesh` | High complexity; used as hero backgrounds too |
| 2b | `matrix-rain`, `tree`, `fractal-tree`, `attractor`, `constellation`, `constructivist`, `orbits`, `waves`, `terrain`, `voronoi`, `phyllotaxis`, `space-filling`, `moire` | Low/medium; pure canvas |
| 2c | `dla`, `flock`, `mandelbrot`, `reaction`, `epicycles`, `chladni`, `slime-mold`, `double-pendulum`, `turing`, `magnetic-field`, `plasma` | Medium; some need math libs |
| 2d | `visualizations` index (SVG previews), `splash2`, `home2`, `home_archived` | Special pages |

**Each visualization view:**
```
views/visualizations/<name>.html
  → loads assets/js/app/visualizations/<name>.js
  → mounts p5 into #canvas-container
  → includes standard hero chrome (nav, title, description)
```

### Phase 3: Allocation / Vault Pages (Week 3-4)
- [ ] `/allocation` — main page with Chart.js pies, wallet tables, vault TVL, buybacks
- [ ] Backend: wallet sync job, vault sync job, buyback indexer job
- [ ] API: `/api/wallet/holdings`, `/api/vault/tvl`, `/api/vault/apy`, `/api/buybacks`
- [ ] Chart.js integration (already in `assets/js/app/lib/charts.js`)
- [ ] Multi-wallet sleeve tables (mobile cards / desktop tables)

### Phase 4: Regime / Research Pages (Week 3-4)
- [ ] `/regime` — already exists, enhance with full methodology
- [ ] `/regime/indicators` — indicator breakdown
- [ ] `/regime-detection` — backtest/history charts
- [ ] `/regime-preview` — preview page
- [ ] `/regime_2panel` + `/regime_2panel/indicators` — alt layouts
- [ ] `/research/channel-divergence` — exists, enhance
- [ ] `/research/late-cycle-signals` — exists, enhance

### Phase 5: Committee Deep Pages (Week 4)
- [ ] `/committee/[date]/[subject]` — session detail
- [ ] `/committee/members/[id]` — member profile
- [ ] `/committee/subjects/[id]` — subject detail
- [ ] Dynamic routing via router.js (params)
- [ ] Backend: ensure committee API returns full data

### Phase 6: Polish & Parity Verification (Week 5)
- [ ] Visual diff every page vs robotmoney-site (local dev)
- [ ] Fix CSS token mismatches
- [ ] Verify all p5 sketches run at 60fps
- [ ] Test mobile/responsive
- [ ] Run `bun run demo` full stack E2E
- [ ] Document any intentional deviations

---

## 7. Technical Approach Details

### p5 Sketch Module Pattern
```js
// assets/js/app/visualizations/substrate.js
export function createSubstrateSketch(container, options = {}) {
  return (p) => {
    // ... sketch code from robotmoney-site
    // Use container.offsetWidth/Height for sizing
    // Accept options for intensity, speed, colors
  };
}

// In view HTML:
<script type="module">
  import { createSubstrateSketch } from '/assets/js/app/visualizations/substrate.js';
  import * as p5 from 'https://cdn.jsdelivr.net/npm/p5@1.9.4/+esm';
  
  const container = document.getElementById('canvas-container');
  new p5(createSubstrateSketch(container), container);
</script>
```

### Routing for Dynamic Pages
`router.js` already supports param routes. Add:
```js
// In router.js route map
'/committee/:date/:subject': 'views/committee/session.html',
'/committee/members/:id': 'views/committee/member.html',
'/committee/subjects/:id': 'views/committee/subject.html',
```

Views read params via `router.params` (Alpine `$data` or global).

### Chart.js Integration
Already vendored at `assets/js/app/lib/charts.js`. Use same pattern as allocation page:
```js
import { Chart, registerables } from 'chart.js';
Chart.register(...registerables);
// Create pie/doughnut charts in Alpine components
```

### SVG Previews for Visualizations Gallery
Port `VisualizationsPreview.tsx` functions to `assets/js/app/lib/visualization-previews.js`:
- Each `generatePreview(path)` returns SVG string
- Gallery page renders all 37 previews server-side (or at load time)
- Since buildless, generate at runtime in browser — cache in `sessionStorage`

---

## 8. File Structure After Completion

```
frontend/public/
├── index.html
├── config.js
├── views/
│   ├── home.html
│   ├── disclaimer.html
│   ├── changelog.html
│   ├── faq.html
│   ├── tokenomics.html
│   ├── smart-contract-risks.html
│   ├── tech-proposal-march-16.html
│   ├── regime.html
│   ├── regime-indicators.html
│   ├── regime-detection.html
│   ├── regime-preview.html
│   ├── regime-2panel.html
│   ├── regime-2panel-indicators.html
│   ├── research/
│   │   ├── channel-divergence.html
│   │   └── late-cycle-signals.html
│   ├── committee.html
│   ├── committee/
│   │   ├── apply.html
│   │   ├── session.html          # [date]/[subject]
│   │   ├── member.html           # members/[id]
│   │   └── subject.html          # subjects/[id]
│   ├── blog/
│   │   ├── index.html
│   │   ├── announcement.html
│   │   ├── regime-conservative-aggressive.html
│   │   ├── regime-eq-vs-base.html
│   │   ├── honest-backtesting-weights.html
│   │   ├── treasury-allocation.html
│   │   ├── peaq-partnership.html
│   │   └── ai-ate-the-bull-market.html
│   ├── media/
│   │   ├── index.html
│   │   ├── articles.html
│   │   └── videos.html
│   ├── articles/
│   │   └── treasury-allocation.html
│   ├── docs/
│   │   ├── index.html
│   │   ├── investment-committee/
│   │   │   ├── index.html
│   │   │   ├── how-it-works.html
│   │   │   ├── api-reference.html
│   │   │   └── participation.html
│   │   └── skill/
│   │       ├── index.html
│   │       ├── installation.html
│   │       ├── commands.html
│   │       └── agent-basket.html
│   ├── skills.html
│   ├── allocation.html
│   ├── visualizations.html
│   ├── visualizations/
│   │   ├── substrate.html
│   │   ├── flow-field.html
│   │   ├── matrix-rain.html
│   │   ├── tree.html
│   │   ├── fractal-tree.html
│   │   ├── network-swarm.html
│   │   ├── liquid-mesh.html
│   │   ├── attractor.html
│   │   ├── constellation.html
│   │   ├── constructivist.html
│   │   ├── dla.html
│   │   ├── flock.html
│   │   ├── mandelbrot.html
│   │   ├── orbits.html
│   │   ├── reaction.html
│   │   ├── terrain.html
│   │   ├── voronoi.html
│   │   ├── waves.html
│   │   ├── epicycles.html
│   │   ├── chladni.html
│   │   ├── slime-mold.html
│   │   ├── double-pendulum.html
│   │   ├── turing.html
│   │   ├── phyllotaxis.html
│   │   ├── space-filling.html
│   │   ├── moire.html
│   │   ├── magnetic-field.html
│   │   ├── plasma.html
│   │   ├── splash2.html
│   │   ├── home2.html
│   │   └── home_archived.html
│   └── sections/
│       ├── architecture.html
│       ├── contract.html
│       ├── footer.html
│       ├── governance.html
│       ├── problem.html
│       ├── token.html
│       ├── economics.html
│       ├── infrastructure.html
│       └── roadmap.html
├── assets/
│   ├── css/
│   │   ├── tokens.css
│   │   ├── design-system.css
│   │   ├── components.css
│   │   ├── views.css
│   │   └── sections/
│   ├── js/
│   │   └── app/
│   │       ├── router.js
│   │       ├── alpine/
│   │       │   ├── navigation.js
│   │       │   ├── avatar.js
│   │       │   ├── regime-dashboard.js
│   │       │   ├── allocation-charts.js
│   │       │   └── committee.js
│   │       ├── lib/
│   │       │   ├── api.js
│   │       │   ├── format.js
│   │       │   ├── transforms.js
│   │       │   ├── charts.js
│   │       │   ├── visualization-previews.js
│   │       │   └── contract/ (vendored)
│   │       └── visualizations/
│   │           ├── substrate.js
│   │           ├── flow-field.js
│   │           ├── network-swarm.js
│   │           ├── liquid-mesh.js
│   │           ├── matrix-rain.js
│   │           ├── tree.js
│   │           ├── fractal-tree.js
│   │           ├── attractor.js
│   │           ├── constellation.js
│   │           ├── constructivist.js
│   │           ├── dla.js
│   │           ├── flock.js
│   │           ├── mandelbrot.js
│   │           ├── orbits.js
│   │           ├── reaction.js
│   │           ├── terrain.js
│   │           ├── voronoi.js
│   │           ├── waves.js
│   │           ├── epicycles.js
│   │           ├── chladni.js
│   │           ├── slime-mold.js
│   │           ├── double-pendulum.js
│   │           ├── turing.js
│   │           ├── phyllotaxis.js
│   │           ├── space-filling.js
│   │           ├── moire.js
│   │           ├── magnetic-field.js
│   │           └── plasma.js
│   └── svg/
│       ├── vault-monolith.svg
│       ├── vault-beam.svg
│       ├── vault-corridor.svg
│       ├── vault-cube-row.svg
│       ├── monolith-logo.svg
│       ├── server-grid.svg
│       └── ...
└── data/
    ├── regime-history.csv
    ├── regime-versions.json
    ├── raw-indicator-history.csv
    ├── regime-eq-snapshot.json
    ├── hourly-wallet-balances.csv
    ├── hourly-vault-tvl.csv
    ├── vault-apy.json
    └── committee/
        ├── research.json
        ├── allocation.json
        ├── members/
        │   ├── _index.json
        │   ├── woon.json
        │   ├── robotmoney.json
        │   └── athena.json
        └── subjects/
            ├── _SCHEMA.md
            ├── robotmoney-vault.json
            ├── robotmoney-treasury.json
            ├── robotmoney-allocation.json
            └── woon.json
```

---

## 9. Acceptance Criteria

1. **Pixel-perfect visual match** — Every page renders identically to robotmoney-site at desktop (1440px) and mobile (375px)
2. **All 37 visualizations run** — 60fps, no console errors, responsive resize works
3. **All 63+ pages accessible** — Deep links work, browser back/forward works, no 404s
4. **Data freshness** — Allocation page shows live wallet/vault/buyback data (or fallback CSV)
5. **Committee flows work** — Apply, session view, member profile, subject detail all load real data
6. **Buildless constraint upheld** — No `node_modules` in frontend, no build step, Bun only on backend
7. **Demo passes** — `bun run demo` provisions full stack, runs committee session, serves all pages

---

## 10. Risk & Mitigation

| Risk | Impact | Mitigation |
|------|--------|------------|
| p5 performance on mobile | High | Test early; reduce particle counts via `intensity` param; use `IntersectionObserver` to pause off-screen |
| Chart.js bundle size | Medium | Already vendored; tree-shake via ES modules |
| Dynamic committee routes | Medium | Router supports params; test deep links thoroughly |
| CSS token drift | High | Single source: `tokens.css`; audit against Tailwind config weekly |
| Backend data pipelines | High | Phase 3/4 parallelize; use fallback CSVs for frontend dev |
| SVG preview generation | Low | Generate client-side once, cache; 37 SVGs < 200KB total |

---

## 11. Next Steps

1. **Approve this plan** — confirm scope & phasing
2. **Start Phase 0** — tokens, navigation, visualization module system
3. **Parallelize** — visualizations (Phase 2) can proceed independently of data pages (Phase 3/4)
4. **Weekly parity reviews** — diff screenshots vs robotmoney-site

---

*Generated: 2026-06-30 | Branch: `adhoc/20260630-125844-feature-parity-visualizations-nemotron`*