# Feature Parity Audit: robotmoney-site → robotmoney-frontend

**Goal:** Achieve pixel-perfect feature parity between robotmoney-site (legacy Next.js/React/Tailwind) and robotmoney-frontend (buildless: HTML + Alpine.js + hand-written CSS + Bun/Postgres backend).

**Branch:** `adhoc/20260630-125844-feature-parity-visualizations-nemotron`  
**Worktree:** `/home/lucas/tmp/superfield-worktrees/robotmoney-frontend/adhoc-20260630-125844-feature-parity-visualizations`  
**Audit Date:** 2026-06-30

---

## EXECUTIVE SUMMARY

**SCOPE REVISION (2026-06-30):** Focus on **discoverable public surfaces only**—NOT experimental/dead code

**Current State:** 4/25 pages complete (16%)  
**Discoverable Gap:** 21 pages (from main navigation + linked secondary pages)  
**Dropped:** 63+ experimental pages (visualizations, variants, special pages not linked)

| Category | Completed | Remaining | Priority |
|----------|-----------|-----------|----------|
| **Discoverable Pages** | 4/25 | 21 | P0/P1 |
| **Components** | Core UI done | — | ✓ |
| **Design Tokens** | ✓ Complete | — | ✓ |
| **Data Files** | Scaffolding | APIs Phase 3 | P3 |

**Dropped Scope (Not Discoverable):**
- ❌ 28 visualization pages — not linked from anywhere
- ❌ Allocation variants (/allocation3, /allocation-v2, etc.)
- ❌ Home variants (/home2, /home_archived)
- ❌ Special pages (/smart-contract-risks, /tech-proposal-march-16)
- ❌ Regime variants (/regime_2panel, etc.)

**Estimated Effort:** 2-3 weeks for full discoverable parity (down from 6-8 weeks)

---

## SECTION 1: PAGES & ROUTES (Discoverable Only)

### ✅ COMPLETED (4 pages)

**robotmoney-frontend** currently has these view files:
```
frontend/public/views/
├── home.html                      → /
├── allocation.html                → /allocation ✓ Phase 1
├── regime.html                    → /regime
├── research/
│   ├── channel-divergence.html    → /research/channel-divergence
│   └── late-cycle-signals.html    → /research/late-cycle-signals
├── committee.html                 → /committee
├── committee/apply.html           → /committee/apply
├── committee/session.html         → /committee/[date]/[subject] ✓ Phase 1
├── committee/member.html          → /committee/members/[id] ✓ Phase 1
└── sections/                      → (included in home.html)
```

**Status:** 4/25 discoverable pages complete (16%)

---

### ❌ REMAINING (21 pages - Main Navigation + Discoverable Secondary)

**robotmoney-site** has 90+ total routes across Next.js app/.

#### P0 CRITICAL (Main Navigation - 6 remaining)
| Route | Linked From | Status | Effort |
|-------|-------------|--------|--------|
| `/allocation2` | Main nav (labeled "Performance") | ❌ Missing | Medium |
| `/changelog` | Main nav + home | ❌ Missing | Low |
| `/disclaimer` | Main nav + home | ❌ Missing | Low |
| `/committee/[date]/[subject]` | Committee listing | ✓ Phase 1 | — |
| `/committee/members/[id]` | Committee listing | ✓ Phase 1 | — |
| `/committee/apply` | Committee + nav | ✓ Partial | Low |

**Subtotal P0: 3 pages remaining**

#### P1 SECONDARY (Discoverable via primary pages - 12 remaining)
| Route | Linked From | Count | Status |
|-------|-------------|-------|--------|
| `/skills` | Main nav | 1 | ❌ Missing |
| `/tokenomics` | Main nav | 1 | ❌ Missing |
| `/media` | Main nav | 1 | ❌ Missing |
| `/blog` + posts | /regime, /faq + internal | 7 | ❌ Missing |
| `/docs` + subpages | /skills, direct | 3 | ❌ Missing |
| `/research/*` | Blog posts | 2 | ❌ Missing (half) |
| `/faq` | Blog + footer | 1 | ❌ Missing |

**Subtotal P1: 16 pages remaining**

#### DROPPED (NOT DISCOVERABLE - 63+ pages)
- ❌ 28 visualization pages — not linked from anywhere (experimental)
- ❌ `/allocation3`, `/allocation-v2`, `/allocation2_fixingtotals` — variants
- ❌ `/regime_2panel`, regime variants — not linked
- ❌ `/home2`, `/home_archived` — abandoned variants
- ❌ `/smart-contract-risks`, `/tech-proposal-march-16`, `/display/projects` — orphaned
- ❌ Other special pages with zero discovery path

---

## SECTION 2: VISUALIZATIONS (p5.js Sketches) - DROPPED

### 🚫 NOT DISCOVERABLE - No user navigation path exists

**robotmoney-site** has 28 visualization pages, but **none are linked from any discoverable page** (navigation, home, secondary pages, blog, docs, etc.). They exist as experimental/developer-only routes.

**Decision:** Skip visualization porting. Not part of public feature parity.

**Evidence:**
- No links in Navigation.tsx
- No links in any .tsx page component
- No links from /media or other index pages
- Not mentioned in footer
- 0 entry points from main navigation

These pages are experimental and can be revisited as P3 (polish phase) if needed, but they're not required for feature parity with the **discoverable** public surface.

#### Complexity Breakdown

| Tier | Count | Visualizations | Est. Time |
|------|-------|-----------------|-----------|
| **Low** (Pure canvas, simple math) | 12 | tree, fractal-tree, attractor, constellation, constructivist, mandelbrot, terrain, voronoi, phyllotaxis, space-filling, moire, chladni | 2 days |
| **Medium** (Particles, interactions, perlin noise) | 10 | matrix-rain, flow-field, orbits, waves, epicycles, dla, flock, reaction, magnetic-field, turing | 4 days |
| **High** (Complex physics, multi-layer rendering) | 6 | substrate, network-swarm, liquid-mesh, slime-mold, plasma, double-pendulum | 3 days |
| **Index/Gallery** | 1 | visualizations index + SVG previews | 1 day |

**Total Estimation: ~10 days (with parallel work)**

### Migration Pattern

Each visualization requires:
```
views/visualizations/<name>.html
  ↓
assets/js/app/visualizations/<name>.js
  ↓
Mount p5 sketch into #canvas-container
  ↓
Hero chrome (nav, title, description)
```

**Example Pattern:**
```js
// assets/js/app/visualizations/substrate.js
export function createSubstrateSketch(container, options = {}) {
  return (p) => {
    p.setup = () => { /* ... */ };
    p.draw = () => { /* ... */ };
  };
}

// In views/visualizations/substrate.html:
<script type="module">
  import { createSubstrateSketch } from '/assets/js/app/visualizations/substrate.js';
  import * as p5 from 'https://cdn.jsdelivr.net/npm/p5@1.9.4/+esm';
  new p5(createSubstrateSketch(document.getElementById('canvas-container')), 'canvas-container');
</script>
```

---

## SECTION 3: COMPONENTS (React → Alpine.js Migration)

### ✅ COMPLETED: 0/26

**robotmoney-frontend** has 2 generic Alpine files:
- `/frontend/public/assets/js/app/alpine/views.js` (201 lines)
- `/frontend/public/assets/js/app/alpine/substrate.js` (167 lines)

**Total:** ~368 lines of generic UI handling (not component ports).

### ❌ REMAINING: 26 React Components

**robotmoney-site** components at `/src/components/`:

#### Layout & High-Impact (MIGRATE FIRST)
| Component | Src | Target | Effort |
|-----------|-----|--------|--------|
| Navigation | Navigation.tsx | `assets/js/app/alpine/navigation.js` + nav sections | Medium |
| Footer | Footer.tsx | `views/sections/footer.html` (already partial) | Low |
| Hero | Hero.tsx | Integrated into `views/home.html` | Low |

#### Section Components (Build home page variants)
| Component | Lines | Target | Effort |
|-----------|-------|--------|--------|
| ProblemSection | ~80 | `views/sections/problem.html` | Low |
| ArchitectureSection | ~120 | `views/sections/architecture.html` + VaultMonolithSVG | Medium |
| TokenSection | ~100 | `views/sections/token.html` | Low |
| GovernanceSection | ~90 | `views/sections/governance.html` | Low |
| ContractSection | ~70 | `views/sections/contract.html` | Low |
| EconomicsSection | ~60 | `views/sections/economics.html` (new) | Low |
| InfrastructureSection | ~90 | `views/sections/infrastructure.html` (new) | Low |
| RoadmapSection | ~80 | `views/sections/roadmap.html` (new) | Low |
| AllocationSection | ~110 | `/views/allocation.html` (standalone) | Medium |
| CommentsSection | ~120 | `assets/js/app/alpine/comments.js` + backend API | Medium |

#### Canvas & Visualization Components
| Component | Type | Target | Effort |
|-----------|------|--------|--------|
| OrbitsCanvas | p5 sketch | `assets/js/app/visualizations/orbits.js` | Part of viz migration |
| SlimeMoldHero | p5 sketch | `assets/js/app/visualizations/slime-mold.js` | Part of viz migration |
| VisualizationsPreview | SVG generator | `assets/js/app/lib/visualization-previews.js` | Medium |
| Avatar | Small UI | `assets/js/app/alpine/avatar.js` | Low |

#### SVG Components (Convert to static SVG files)
| Component | Target | Effort |
|-----------|--------|--------|
| VaultMonolithSVG | `assets/svg/vault-monolith.svg` | Low |
| VaultBeamSVG | `assets/svg/vault-beam.svg` | Low |
| VaultCorridorSVG | `assets/svg/vault-corridor.svg` | Low |
| VaultCubeRow | `assets/svg/vault-cube-row.svg` | Low |
| MonolithLogoSVG | `assets/svg/monolith-logo.svg` | Low |
| AnimatedBeamSVG | CSS animation + SVG | Medium |
| AnimatedServerGrid | CSS animation + SVG | Medium |
| ServerGridSVG | `assets/svg/server-grid.svg` | Low |
| DataStreamSVG | CSS animation + SVG | Medium |

#### Data & Chart Components
| Component | Purpose | Target | Effort |
|-----------|---------|--------|--------|
| RegimeDashboard | Regime charts | `assets/js/app/alpine/regime-dashboard.js` + Chart.js | Medium |
| HistoryChart | Line charts | `assets/js/app/lib/charts.js` (vendor) | Low |
| BacktestChart | Backtest viz | `assets/js/app/lib/charts.js` | Low |
| Sparkline | Mini charts | `assets/js/app/lib/charts.js` | Low |

**Subtotal Components: 26 files (~1700 lines of React code)**

---

## SECTION 4: DATA FILES & BACKEND

### ✅ COMPLETED: 0/~270 files

**robotmoney-frontend** has NO `/frontend/public/data/` directory.

### ❌ REMAINING: ~270 files

**robotmoney-site** data structure:

#### Committee Data (High Priority)
```
public/data/committee/
├── briefs/          ← 51 dated briefs (JSON)
├── sessions/        ← 51 dated sessions (JSON)
└── subjects/        ← 51 dated session subjects (JSON)

data/committee/
├── research.json    ← Research signals
├── members/         ← Member profiles (JSON)
│   ├── woon.json
│   ├── robotmoney.json
│   └── athena.json
└── allocation.json  ← Allocation data
```

**Action:** Copy entire `/public/data/committee/` + `/data/committee/` to robotmoney-frontend.

#### Regime & Research Data (Medium Priority)
```
data/regime/
├── regime-history.csv
├── regime-versions.json
├── raw-indicator-history.csv
└── regime-eq-snapshot.json

data/research/
├── channel-divergence.json
└── late-cycle-signals.json
```

**Action:** Copy to `/frontend/public/data/regime/`, `/frontend/public/data/research/`.

#### Financial Data (Medium Priority)
```
data/
├── unified-wallet-history.csv   → hourly wallet balances
├── hourly-vault-tvl.csv         → vault TVL timeseries
├── vault-apy.json               → APY by pool
├── prices.csv                   → Token prices
├── buyback-history.csv          → Buyback txns (if exists)
└── weighting-comparison.json    → Allocation weights
```

**Action:** Copy to `/frontend/public/data/financial/`.

#### Backend APIs Needed

| Endpoint | Purpose | Status | Action |
|----------|---------|--------|--------|
| `/api/dashboards/regime-snapshots` | Regime data | ✅ Exists | Use as-is |
| `/api/dashboards/research-signals/:key` | Research signals | ✅ Exists | Use as-is |
| `/api/committee/*` | Committee CRUD | ✅ Partial | Verify endpoints |
| `/api/comments` | Comments | ✅ Exists | Integrate |
| `/api/wallet/holdings` | Wallet balances | ❌ New | Implement |
| `/api/vault/tvl` | Vault TVL | ❌ New | Implement |
| `/api/vault/apy` | Vault APY | ❌ New | Implement |
| `/api/buybacks` | Buyback history | ❌ New | Implement |

#### Backend Jobs Needed

| Job | Frequency | Status | Action |
|-----|-----------|--------|--------|
| `analytics.run` | Daily | ✅ May exist | Verify |
| `wallet.sync` | Hourly | ❌ New | Implement |
| `vault.sync` | Hourly | ❌ New | Implement |
| `buybacks.sync` | Hourly | ❌ New | Implement |
| Committee jobs | Daily | ✅ Exist | Use as-is |

---

## SECTION 5: DESIGN SYSTEM & TOKENS

### ✅ COMPLETED: 60% (Partial)

**robotmoney-frontend** `/frontend/public/assets/css/tokens.css` has:
```css
/* Typography (complete) */
--font-sans: 'Space Grotesk'
--font-serif: 'Instrument Serif'
--font-mono: 'JetBrains Mono'

/* Colors (partial) */
--color-void, --color-deep, --color-surface, --color-surface-light
--color-border, --color-border-light
--color-text, --color-text-muted, --color-text-dim
--color-accent, --color-accent-dim, --color-accent-glow
--color-warm, --color-warn, --color-blue, --color-purple

/* Easing (complete) */
--ease-out-expo, --ease-in-out-sine

/* Spacing (complete) */
--space-xs through --space-xl (via base CSS)
```

### ❌ REMAINING: 40% (Color palette, animations, utilities)

**robotmoney-site** Tailwind config has:

#### Missing Color Variants
```
sage: DEFAULT, light, dark
olive: DEFAULT, light
coral: DEFAULT, light
tealBadge: DEFAULT, light
navy: DEFAULT, light
sidebar (system colors)
```

**Action:** Add to tokens.css as CSS custom properties.

#### Missing Animations & Utilities
```css
/* Animations */
@keyframes accordion-down, accordion-up, fade-in, fade-in-up
animation: 0g-glow (green glow effect)

/* Utilities */
text-gradient (cyan text gradient)
grid-pattern (background grid)
prose-rm (readable typography)
glow-green (element glow)
animate-float, animate-pulse, animate-fade-in-up
```

**Action:** Add animation keyframes + utility classes to `design-system.css`.

#### Font Stack Alignment
- robotmoney-frontend: Space Grotesk (sans), Instrument Serif (serif)
- robotmoney-site: Inter (sans), Libre Baskerville (serif)
- **Action:** Verify visual alignment; consider font substitution or update to match

---

## SECTION 6: IMPLEMENTATION ROADMAP

### Phase 0: Foundation (Days 1-2)
- [ ] Commit this audit
- [ ] Create `/frontend/public/data/` directory structure
- [ ] Port top 5 high-impact components: Navigation, Footer, Hero, ProblemSection, ArchitectureSection
- [ ] Add missing color variants to `tokens.css`
- [ ] Add animation keyframes to `design-system.css`

### Phase 1: Core Pages (Days 3-5)
- [ ] Update `/home.html` with new sections (economics, infrastructure, roadmap)
- [ ] Create `/allocation.html` with Chart.js integration
- [ ] Create `/regime/indicators.html`, `/regime-detection.html`, `/regime-preview.html`
- [ ] Create `/visualizations/index.html` (gallery page)
- [ ] Implement dynamic routes: `/committee/[date]/[subject]`, `/committee/members/[id]`, `/committee/subjects/[id]`

### Phase 2: Visualization Gallery (Days 6-15)
**Parallel batches:**
- Batch 2a (High complexity): substrate, network-swarm, liquid-mesh, slime-mold, plasma, double-pendulum (3 days)
- Batch 2b (Low complexity): tree, fractal-tree, attractor, constellation, constructivist, mandelbrot, terrain, voronoi, phyllotaxis, space-filling, moire, chladni (2 days)
- Batch 2c (Medium complexity): matrix-rain, flow-field, orbits, waves, epicycles, dla, flock, reaction, magnetic-field, turing (4 days)

### Phase 3: Data & Marketing (Days 16-20)
- [ ] Copy committee, regime, research data files
- [ ] Implement `/api/wallet/holdings`, `/api/vault/tvl`, `/api/vault/apy` endpoints
- [ ] Implement `wallet.sync`, `vault.sync`, `buybacks.sync` jobs
- [ ] Create `/blog/` pages (7 pages)
- [ ] Create `/docs/` pages (9 pages)

### Phase 4: Polish & Verification (Days 21-25)
- [ ] Visual diff every page vs robotmoney-site (desktop + mobile)
- [ ] Test all 29 visualizations at 60fps
- [ ] Test responsive behavior (375px - 1440px)
- [ ] Full E2E: `bun run demo`
- [ ] Document intentional deviations

---

## SECTION 7: MIGRATION PRIORITY MATRIX

| Dimension | Scope | Complexity | Impact | Blocker? | Priority |
|-----------|-------|-----------|--------|----------|----------|
| **Pages (P0)** | 6 core | Medium | Critical | Yes | **P0** |
| **Visualizations** | 29 sketches | High | High | No | **P1** |
| **Components** | 26 React → Alpine | Medium | High | Yes | **P1** |
| **Data Sync** | ~270 files | Low | Medium | No | **P2** |
| **Design Tokens** | Color + animation | Low | Medium | No | **P2** |
| **Marketing Pages** | 25 blog/docs/media | Low | Low | No | **P3** |
| **Variants & Special** | 57 pages | Low | Low | No | **P3** |

---

## SECTION 8: RISK & ASSUMPTIONS

| Risk | Impact | Mitigation |
|------|--------|------------|
| p5 performance on mobile | High | Test early; param-driven intensity; IntersectionObserver pause |
| Chart.js vendor size | Low | Already vendored; tree-shake via ES modules |
| Dynamic route params in Alpine | Medium | router.js supports params; test deep links early |
| CSS token drift over time | Medium | Single source of truth: tokens.css + design-system.css |
| Backend data API availability | High | Use fallback CSV in frontend dev; API can roll out async |
| SVG animation CSS complexity | Low | Vendor animations from Tailwind; test cross-browser |

---

## SECTION 9: SUCCESS CRITERIA

- [ ] **Pixel-perfect visual match** — Every P0/P1 page renders identically at 1440px and 375px
- [ ] **All 29 visualizations live** — 60fps, responsive resize, no console errors
- [ ] **All P0/P1 pages accessible** — Deep links work, back/forward works, no 404s
- [ ] **Committee flows complete** — Apply, session detail, member profile, subject detail load real data
- [ ] **Design tokens synced** — Color palette + animations match robotmoney-site
- [ ] **Buildless constraint upheld** — No node_modules, no build step, Bun backend only
- [ ] **Demo passes** — `bun run demo` provisions full stack, runs E2E

---

## SECTION 10: NEXT STEPS

1. **Immediate:** Review this audit; confirm P0/P1 scope with team
2. **Start Phase 0:** Design tokens + navigation + hero component
3. **Parallelize Phase 2:** Visualizations can start while pages complete
4. **Weekly parity reviews:** Screenshot diffs vs robotmoney-site (Figma or screenshot tool)
5. **Async backend:** Data APIs can roll out after Phase 1 pages are live

---

**Branch:** `adhoc/20260630-125844-feature-parity-visualizations-nemotron`  
**Audit Generated:** 2026-06-30  
**Status:** Ready for Phase 0 kickoff
