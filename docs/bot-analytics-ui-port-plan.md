# Bot-Analytics UI Port — Definitive Plan

Faithful, pixel-perfect port of the entire UI of the deprecated
`robotmoney/robotmoney-bot-analytics` React app into this repo's buildless
Alpine fragment SPA.

**Companion inventories** (committed alongside this plan; cite these, the
scratchpad copies are ephemeral):

- [`docs/bot-analytics-ui-port/inventory-original.md`](./bot-analytics-ui-port/inventory-original.md)
  — exhaustive per-page inventory of the original app ("**INV-O**" below).
- [`docs/bot-analytics-ui-port/inventory-current.md`](./bot-analytics-ui-port/inventory-current.md)
  — audit of this repo's current surface and constraints ("**INV-C**" below).

Status baseline (INV-C §4): of 20 original routes, **17 are entirely missing**,
`/projects` is a partial port (table only), NotFound exists, and `/admin` is a
partial analog of the password gate. Everything else must be built.

---

## 1. Objective and fidelity bar

**Objective.** A user who knew the original app should not be able to tell the
port apart at a glance, on any page: same dark visual system
(`#06080c` void background, `#10141c` card surface, cyan `#00e5ff` primary,
`#222a38` borders, `0.25rem` radius), same type system (JetBrains Mono for
headings/labels/values, Space Grotesk body), same component vocabulary
(`.metric-card`, `.glow-cyan`/`.glow-purple`, `.data-label`/`.data-value`,
`.status-active` badges), same hand-rolled SVG sparklines, same tables with the
same columns, sorts, and formatters, same link graph, same loading/empty/error
states, same persisted UI state (INV-O §4, §6).

**Fidelity rule.** The default for every page, column, tooltip, and toast is a
FAITHFUL port. Any deviation must be argued in this document (see §4.5 drops
and §8 decisions) or in the issue that implements it. Known forced deviations
(mechanism differs, UX identical):

1. **PasswordGate** verifies against this repo's admin-token auth
   (`/api/admin/auth`), not a Supabase edge function (§8 D2).
2. **`/` route** cannot be taken over — it is this repo's marketing home. The
   List page ships at `/list` only (§8 D3).
3. **All data flows through `/api/*`** (contract boundary, INV-C §6.4) — no
   direct Supabase reads, no direct third-party REST from the browser
   (breaks preview mode; §8 D7).
4. **React/shadcn/recharts are banned** (buildless invariant) — primitives are
   hand-rolled to the same rendered pixels; recharts becomes Chart.js;
   Sparkline/RowSparkline stay hand-rolled SVG (they already were).
5. **/submit's MCP card** is rewritten for this repo's REST + skills onboarding
   (MCP was retired, D21/#265) — same visual treatment, updated content.

**Non-goals.** No Supabase, no edge functions, no Tailwind, no build step. No
new data *fabrication*: any page whose backing data is seed/curated ships
noindexed with a provenance notice per the honesty contract
(`docs/architecture.md` §11, issues #98/#346).

---

## 2. Theme isolation — the `a3` dashboard scope (build first)

The repo's `tokens.css` was ported verbatim from the original's `globals.css`
(INV-C §1), so the raw palette already matches: `--color-void: #06080c`,
`--color-surface: #10141c`, `--color-accent: #00e5ff`,
`--color-border: #222a38`, JetBrains Mono + Space Grotesk already loaded via
Google Fonts. But three things force a **dedicated scope** instead of reusing
brand CSS directly:

1. **Radius**: repo-wide `--radius: 2px`; the dashboard needs `0.25rem`
   (rounded-lg) with md/sm steps (INV-O §4).
2. **Brand covenant conflict**: tokens.css declares "Beam (cyan) = a LINE
   only" and marks `--color-purple` retired ("do not reference in any new
   rule"). The dashboard look uses cyan *fills* (`bg-primary/10` chips, active
   nav), cyan glows, and purple accents throughout. Those rules must not leak
   into marketing pages — and marketing rules must not leak in.
3. **Component classes** (`.metric-card`, glow shadows, status badges, the
   shadcn-equivalent primitives) don't exist here.

**Mechanism** (work item P0.1): a shared stylesheet
`frontend/public/assets/css/dash.css`, loaded from the shell `index.html`
alongside existing CSS, with **every rule scoped under a single `.a3` class**
that each dashboard fragment puts on its root element:

```css
.a3 {
  /* re-derive the original shadcn HSL tokens locally */
  --background: 222 33% 4%;   --card: 218 28% 9%;
  --primary: 186 100% 50%;    --secondary: 270 60% 55%;
  --muted: 218 25% 12%;       --muted-foreground: 220 12% 60%;
  --destructive: 0 65% 55%;   --border: 216 24% 18%;
  --radius: 0.25rem;
  --success: 142 70% 45%;     --amber: 38 90% 55%;  /* ad-hoc hues, tokenized */
  font-family: 'Space Grotesk', 'Inter', system-ui, sans-serif;
}
.a3 h1, .a3 h2, ... { font-family: 'JetBrains Mono', monospace; font-weight: 700; }
.a3 .metric-card { background: hsl(var(--card)); border: 1px solid hsl(var(--border)); border-radius: var(--radius); padding: 1.25rem; }
.a3 .glow-cyan   { box-shadow: 0 0 20px hsl(187 100% 45% / .15); }
/* … status-active/inactive, data-label/data-value, table shell, badge
   variants, scrollbar utilities (.hide-x-scrollbar), animations … */
```

Rules of the scope:

- **One file, shared** — no per-fragment inline `<style>` copies (breaks with
  the a2 pattern where `projects.html` carries 240 inline lines; the ported
  `/projects` migrates onto `dash.css` in P2.8). Chosen deliberately: 18+
  fragments × 300 lines of duplicated CSS is untenable for pixel drift.
- **Nothing outside `.a3`** except the `@font-face`/Google-Fonts weights the
  dashboard needs beyond what tokens.css already imports (add JetBrains Mono
  300/600 and Space Grotesk 300 to the existing import — verify against the
  original's `index.css` import list, INV-O §4).
- Marketing pages never gain the `a3` class; dashboard fragments never use
  marketing section CSS. A Playwright assertion in the shell spec checks that
  `/` (home) has no `.a3` element and `/list` has exactly one root `.a3`.

---

## 3. Architecture translation (React → this repo)

| Original (INV-O) | Port |
|---|---|
| React component per page | HTML fragment in `frontend/public/views/` + one Alpine factory module in `alpine/views/` registered in the `views.js` barrel (fragment `<script>`s never execute — INV-C §1) |
| react-router v6 routes, `:slug`/`:id` params | entries in `frontend/public/assets/js/app/routes.js`; each param route is a hand-written regex (existing pattern, routes.js:41-78) |
| `PasswordGate` wrapper element route | route metadata flag `gated: true` + gate check inside the shared shell factory (§5.0) |
| `DashboardLayout` layout route + `<Outlet/>` | router layout composition: optional `layout:` field on a route makes `render()` fetch the layout fragment, inject it, then inject the view fragment into the layout's `<div data-outlet>` (small router extension, ~25 lines; P0.3) |
| TanStack Query (supabase selects, edge fns) | `lib/api.js` HTTP calls to new `/api/analytics/*` endpoints (contract-first in `contract/src/routes.js`, vendored via `bun run sync-contract`); polling via Alpine `setInterval` with `rm:before-view-change` teardown |
| recharts LineChart / AreaChart | Chart.js 4.5.1 (already a CDN global) + a dash variant of `chart-theme.js` (P0.5) |
| `Sparkline` / `RowSparkline` SVG components | `alpine/lib/sparkline.js` pure functions returning SVG strings; exact port of geometry, stroke widths, auto-color thresholds, `—` for <4 points (P0.5) |
| shadcn primitives (Tabs, Badge, Tooltip, Dialog, Sheet, Select, Switch, Progress, ScrollArea, Sidebar, Skeleton, ToggleGroup) | hand-rolled `dash.css` classes + tiny Alpine behavior helpers (`alpine/lib/dash-ui.js`) — see P0.2 for the full list and pixel targets |
| radix toast + sonner (dual systems) | **one** toast helper matching the sonner look (drop justified in §4.5) |
| lucide-react icons | inline SVG sprite `assets/img/dash-icons.svg` containing exactly the lucide glyphs used (Triangle, ListOrdered, Trophy, Layers, HelpCircle, MessageSquare, Activity, BookOpen, LogOut, Lock, Eye, Send, Clock, ArrowUp/Down/UpDown, Globe, Twitter, Bot, Coins, Vault, Wallet, Search, RefreshCw, Radio, Info, Copy, ExternalLink, ThumbsUp/Down, Zap, CheckCircle2, ClipboardList, DollarSign, TrendingUp, AlertCircle, Radar, Upload, Trash, Star …); `<use>` references keep fragments light |
| `date-fns` formatting | small `alpine/lib/dash-format.js`: `fmtUsdAbbr` (per-page decimal variants preserved), `fmtRel` (`5m/3h/2d/1mo`), `MMM d, yyyy`, smart price precision (INV-O §2.9) |
| sessionStorage/localStorage keys | identical keys preserved: `list:state`, `list:lastViewed`, `projects-col-widths-v2`; `admin_password` replaced by the repo's admin session token (§8 D2) |

**Testing per repo convention** (INV-C §6.2–6.3): every new endpoint gets a
goldens entry captured from `bun run demo` + `goldens:update` (never
hand-authored); every view gets a Playwright spec under
`frontend/test/browser/`; visual-snapshot goldens for the designated pixel-QA
pages (§7). Preview mode must serve every new view backend-free.

---

## 4. Cross-cutting work items

### 4.1 Routing & shell
- `routes.js`: static entries for `/list /list2 /list3 /market /dashboard
  /about /agents /lobster /vaults /wallets /methodology /submit
  /ask-mr-roboto`; regex entries for `/projects/:slug`, `/agents/:id`,
  `/lobster/:id`, `/vaults/:id`, `/wallets/:id`. `/market` and `/dashboard`
  point at the same fragment (original aliasing).
- Router layout composition + gate hook (P0.3, P0.4).
- `seo.js` META entry per route (title mirrors the original page `<title>`
  semantics: "RobotMoney — Agentic Asset Analytics" family), **`robots:
  noindex` on every dashboard route until the go-live cutover** (P5.4);
  none enter `sitemap.xml` before cutover. This extends the exact policy
  already applied to `/projects` (#346).
- `.github/file-permissions.json` additions for the new paths (deny-by-default
  gate, INV-C §6.5) — folded into P0.3's deliverables.

### 4.2 Chart.js dash theme (P0.5)
Translation table for every chart in the original (complete list, INV-O §2–3):

| Original usage | recharts spec | Chart.js port |
|---|---|---|
| `PerformanceChart` (CoinProfile, VaultProfile, AgentProfile) | LineChart h-48, linear primary line w2, no dots, dashed grid 30% opacity, hidden X axis, Y width 60 fontSize 10 USD-abbrev ticks, mono tooltip, period Tabs 24h/7d/30d/90d/1y/all, ±% header | `type:'line'`, `tension:0`, `pointRadius:0`, `borderWidth:2`, `borderColor:'#00e5ff'`, grid `#222a38` `borderDash:[3,3]` 30% α, x-axis `display:false`, y ticks mono 10px w/ USD-abbrev callback; period tabs re-fetch series |
| ProjectProfile `ChartCard` ×5 (Token Price, Market Cap, Daily Revenue, Treasury, Avg Productivity) | LineChart h-32, same line/grid, Y fontSize 9 width 50, big last-value + ±% header | same config, height 8rem, y tick font 9px |
| VaultProfile Yield History | AreaChart h-64, `yieldGradient` primary 0.3→0 vertical fade, dashed grid 40%, X mono ticks fontSize 10 interval 3/6/30, Y `${v}%` w48, ToggleGroup 30D/90D/1Y | `fill:true` with `createLinearGradient` 0.3→0 α, x ticks shown (mono 10px, `maxTicksLimit` per range), y callback `%` |
| Everything else (row/metric/balance sparklines) | hand-rolled SVG | stays hand-rolled SVG via `sparkline.js` — **not** Chart.js |

The dash Chart.js defaults live in a `chart-theme.js` export
(`applyDashChartDefaults(chart)`) so marketing charts keep their own theme.

### 4.3 Sparkline library (P0.5)
Port `Sparkline` (default 80×24 stroke 1.5 single-color polyline; large
800×120 mode for WalletProfile) and `RowSparkline` (80×22 stroke 1.25, 12%
opacity area fill, auto-color green if last>first by >0.5% / red if down /
muted flat, renders `—` for <4 finite points) exactly. Plus the weekly
bucketing helper `toWeeklyBuckets` (26 Monday-anchored weeks, agg `last` with
forward-fill for prices/TVL/balance, `sum` for x402 volume — INV-O §2.1). The
bucketing moves **server-side** into the series endpoint (P1.2) so goldens
capture deterministic series; the SVG rendering stays client-side.

### 4.4 State persistence preserved
| Key | Behavior (preserved verbatim) |
|---|---|
| `sessionStorage['list:state']` | /list filter tab, sort key/dir, showUnverified |
| `sessionStorage['list:lastViewed']` | last clicked row key; on return, scrollIntoView center + `bg-primary/10 ring-1 ring-primary/40 animate-pulse` highlight for 4s |
| `localStorage['projects-col-widths-v2']` | Projects column-resize widths (same key so nothing is lost for existing users of the old app is *not* a goal — key kept for simplicity) |
| admin session | replaces `sessionStorage['admin_password']` — the gate stores the repo's admin token per the existing `/admin` US-A1 pattern; logout clears it |

### 4.5 Explicit drops (each argued; default is faithful)
| Dropped | Rationale | Recommendation |
|---|---|---|
| Dual toast systems (radix `use-toast` + sonner mounted together, INV-O §6) | An artifact of incremental shadcn adoption, not a designed behavior; two visually different toast stacks on one site is a bug users saw, not a feature. | **Drop.** One toast helper styled to the sonner look (bottom-right, card bg, border). Every original toast message text is preserved. |
| `src/App.css` | Vite boilerplate, never imported (INV-O §4). | **Drop.** Nothing to port. |
| Unused shadcn primitives (25 files never imported, INV-O §3) | Dead code. | **Drop.** Only the ~24 actually-used primitives get hand-rolled equivalents. |
| Tailwind `sage/olive/coral/tealBadge/navy` colors, `0g-glow` keyframe | CSS vars never defined / animation unused (INV-O §4). | **Drop.** |
| `/gv-scratchpad` | Debug page, not in sidebar nav, URL-only; depends on Telegram polling, LLM `analyze-chat`, and scratchpad-session storage — all three are absent here and the LLM piece is contractually banned. | **Drop, pending decision D6** (§8). If overruled: UI-only port with paste tab functional client-side and Analyze disabled. |
| AskMrRoboto Star-Wars easter eggs (`easterEggs.ts`, 511 lines) | Pure scripted client theater tied to live agent rows; portable, but meaningless until the chat backend decision (D5) resolves. | **Defer** into the P5.1 issue as an optional checklist item; not a separate work item. |
| Legacy `public/` assets with stale third-party URLs (daitindex.lovable.app robots.txt, openw3b sitemap, DeAI PDF) | Stale/broken; this repo has its own robots/sitemap. | **Drop.** |
| Supabase auth localStorage persistence | No Supabase here. | **Drop** (superseded by admin-token session). |
| Wallets page `OnchainEnrichment` panel | Present in the original file but **not rendered** by the page body (INV-O §2.13). | **Drop** (porting unrendered code is not fidelity). |

Everything else — including the `Loading ...` plain-text loading states, the
`animate-pulse` blinking terminal cursor, the amber "Pending" badges, the
`opacity-0 group-hover:opacity-100` address buttons, and the 40%-opacity
Globe/Twitter micro-icons — is in scope.

---

## 5. Route-by-route work breakdown

Sections are self-contained: column lists, charts, links, states, and API
needs are copied in from INV-O so an issue author never needs the scratchpad.
"API" names are proposals; final paths are fixed in the P1.x contract issues.

### 5.0 Shell: gate + DashboardLayout + sidebar (P0.3, P0.4)

**Layout** (`views/dash/_layout.html` + `alpine/views/dash-shell.js`):
- Sidebar, collapsible to icon rail (hamburger `SidebarTrigger` in topbar;
  <768px behaves offcanvas). Header: 8×8 rounded cyan-tinted box
  (`bg-primary/10 border-primary/20`) with Triangle icon; expanded shows
  `RobotMoney` (`text-sm` mono extrabold uppercase tracking-widest) over
  `ANALYTICS` (10px mono muted); bottom border.
- Main nav (exact order/icons): List→`/list` (ListOrdered), List v2
  (WIP)→`/list2` (ListOrdered), List v3→`/list3` (Trophy),
  Projects→`/projects` (Layers), About→`/about` (HelpCircle).
- Tools group (border-top): Ask Mr. Roboto→`/ask-mr-roboto` (MessageSquare),
  Activity Log→`/dashboard` (Activity), Methodology→`/methodology` (BookOpen);
  then ghost Sign Out (LogOut) → clears session, shows gate.
- Item styling: labels `text-xs` mono uppercase tracking-wide; active
  `bg-primary/10 text-primary font-semibold`; hover `bg-muted/50`; icons
  16×16 mr-2. Note the sidebar intentionally has **no** links to /agents,
  /lobster, /vaults, /wallets, /market, /gv-scratchpad.
- Topbar: h-12, border-bottom, hamburger + page title resolved from nav items
  by exact pathname (`text-xs` mono semibold muted uppercase tracking-wider,
  fallback "Dashboard"). Content: `main` flex-1 p-6 overflow-auto ⇒ the
  layout's `data-outlet`.

**Gate** (`alpine/views/dash-gate.js`): full-screen centered max-w-sm column —
14×14 rounded-lg cyan-tinted logo box with `glow-cyan` + Triangle icon;
`RobotMoney` h1 (text-xl mono extrabold uppercase tracking-wider) + `ANALYTICS
PLATFORM` subtitle; destructive Alert on error (AlertCircle icon); password
input with left Lock icon, right eye/eye-off toggle, placeholder `Enter access
key`, mono, autofocus; full-width `ACCESS DASHBOARD` / `VERIFYING...` button
disabled when empty; bottom link Send-icon "Submit a community commit" →
`/submit`. **Mechanism**: POST `/api/admin/auth` (existing); token in
sessionStorage; re-verified on mount; fidelity exception D2.

**States**: verifying spinner label; wrong-password error alert; session
restore without flash (gate renders only after the re-verify resolves,
matching the original's mount behavior).

**Acceptance**: Playwright `dash-shell.spec.ts` — unauthenticated `/list`
shows the gate (screenshot golden); correct token reveals layout; sidebar
active states per route; collapse to icon rail; Sign Out returns to gate;
title fallback "Dashboard" on non-nav routes like `/agents/x`; `/` has no
`.a3` element. Goldens: `/api/admin/auth` already goldened or added.

### 5.1 `/list` — "Total Market" (P2.1) — the flagship

Layout top-to-bottom: h1 `Total Market` + subtitle "Aggregate view across
every tracked agent, coin, vault, and wallet."; **TotalMarketOverview**
section; divider; h2 `All Tracked Entities` + live "Sorted by: LABEL ↑/↓"
caption + FreshnessIndicator + HelpCircle link "What am I looking at?" →
`/about`; filter row (Tabs pills `All (n) / Agents (n) / Coins (n) / Vaults
(n) / Wallets (n)` + `Show unverified (n)` Switch); unified table.

**TotalMarketOverview**: (1) $ROBOTMONEY ticker row-card (CoinGecko robot.jpg
image, live price + ±24h) opening a Dialog with price/mcap/contract/
CoinGecko/Basescan links; (2) five MetricCards — OpenClaw Agents (cyan;
pending-review trend line), Lobster Coins (purple), Vault TVL (green + 7d TVL
sparkline), Tracked Wallets (amber), Total AUM (green); (3) four leader cards
linking to the top agent/coin/vault and "Avg P / Revenue" → `/methodology`.

**Table columns** (all sortable except 6M; sorted column gets `bg-primary/5`
tint on header + cells; default sort `contextual` desc, reset on tab switch):

| Header | Field | Format |
|---|---|---|
| NAME | name | AgentAvatar sm rounded-full + name truncate max-w-260px + ticker badge (coins) + 40%-opacity Globe/Twitter micro-icons; cell links `row.href` |
| TYPE | type | outline badge AGENT(cyan)/COIN(purple)/VAULT(green)/WALLET(amber) + amber `Pending` when unverified |
| CATEGORY | category | Title-case, truncate 180px |
| contextual: MARKET CAP / SCORE / APY / LAST TX (per tab) | market_cap / score / apy / last_tx_at | USD abbr / 1-decimal / `X.XX%` / relative ("3h ago"); width 120px |
| REVENUE / VOL (`REVENUE (30D)` on Agents tab) | volume | USD abbr; agents: dotted-underline `title` tooltip with per-source revenue breakdown + "updated Xh ago" |
| BALANCE / TVL | balance | USD abbr |
| 6M (not sortable) | sparkline | RowSparkline 80×22, 26 weekly buckets |
| 24H % | change_24h | ±X.XX% green/red |

Pending agent rows `opacity-60`, hidden unless "Show unverified".
Links out: `/agents/:id`, `/lobster/:id`, `/vaults/:id`, `/wallets/:id`.
Persistence per §4.4 (state + last-viewed highlight).

**API**: `GET /api/analytics/entities` (unified rows with 26-week sparkline
series, pending flags, revenue breakdowns — replaces the original's 9 parallel
Supabase selects, INV-O §2.1) + `GET /api/analytics/overview` (counts, deltas,
leaders, RM token card) — both from P1.3. RM-token market data via P1.7 proxy.

**States**: `Loading ...` mono muted text; empty tab = metric-card with 10×10
muted icon; API error = inline error text (faithful to original's react-query
silent-retry look: keep loading text until data or a toast on hard failure).

**Acceptance**: goldens for both endpoints; `list-view.spec.ts` — tab counts,
sort toggling + tint, unverified switch, sessionStorage round-trip,
last-viewed highlight after back-nav, links resolve; visual golden of the full
page at 1440×900 (pixel-QA set §7).

### 5.2 `/list2` — "List v2 (WIP)" (P2.6)

Wrapped in `container mx-auto px-4 py-6` (unlike /list). Header h1 `List v2`
(v2 muted) + WIP outline badge + subtitle. Tabs with icons+counts
(`Agents · n / Coins · n / Vaults · n / Wallets · n`; Bot/Coins/Vault/Wallet
icons). One single-entity table per tab; header cells mono uppercase 10px
tracking-wider. First column always AgentAvatar + bold name linked to profile.

| Tab | Columns (order) | Default sort |
|---|---|---|
| Agents | AGENT (→`/agents/:id`) · PROTOCOL · 30D EARNED (tooltip "Operating revenue: x402 endpoint sales + Olas service rewards") · 30D TOKEN TAX (tooltip "~0.6% of round-trip volume") · 30D INFLOW (tooltip) · X402 VOL · X402 TXNS (int) · WALLET BAL (explorer `<a>` + ExternalLink icon) · TOKEN MCAP · LAST ACTIVE (`5m/3h/2d/1mo`) · 6M PRICE spark (tooltip "26w token price ($TICKER)" / "No linked token") | rev_earned desc; pending excluded |
| Coins | COIN · TICKER (outline badge) · CHAIN · PRICE · 24H % · MARKET CAP · 24H VOLUME · CONTRACT (short addr → explorer) · 6M PRICE spark | market_cap desc |
| Vaults | VAULT · PROTOCOL · STRATEGY · CHAIN · TVL · APY · SOURCE (solid badge when `live`, else outline) · CONTRACT · REBALANCED (rel) · 6M TVL spark | tvl_usd desc |
| Wallets | WALLET · CATEGORY · CHAIN · BALANCE (explorer link) · ADDRESS (short → explorer) · LAST TX (rel) · SYNCED (rel) · 6M BAL spark | balance_usd desc |

States: single centered table row `Loading…` / `No entries.`.
**API**: same P1.3 entities endpoint with a wider agent projection
(x402_buyers, x402_resources_count, task_throughput). **Data caveat**: 30D
TOKEN TAX / 30D INFLOW require revenue-source splits (`agent_revenue_daily`
`source` column exists — INV-C §5); token tax derivation documented in the
endpoint. **Acceptance**: `list2-view.spec.ts` — per-tab column presence +
formats, sort defaults, explorer hrefs; goldens.

### 5.3 `/list3` — "List v3 · Money Agents" (P2.7) — most complex page

Header: glowing-dot eyebrow "Robot Money · Money-Agent Index / Top 100"; h1
`List v3 · Money Agents` (text-3xl extrabold uppercase tracking-tighter, "v3"
cyan); subtitle; freshness line "Last refreshed: Xm ago" (60s poll; red
"· refresh error" suffix). Right: outline button "Invite / submit an agent" →
`/submit`.

Four **StatCards** (1px gradient top edge `via-primary/40`, 10px label
tracking-[0.2em], text-2xl extrabold tabular-nums value, caption, icon chip):
Listed Agents / Verified Wallet Balance / 30D Money In / High Confidence.

Collapsible `<details>` "Leaderboard health (debug)": MV row count, last
refresh, refresh status + duration, schedule note, error message; "Source data
health" grid of per-source cards (name, role, status badge
healthy=green/partial=amber/stale|empty=red, `x/y fresh <36h`, %, never count,
latest refresh). Polls 60s.

**Leaderboard table** (≤100 rows, overflow-x-auto, rows h-68px):

| Header | Field | Notes |
|---|---|---|
| # | rank | recomputed after each sort |
| Agent | name | AgentAvatar sm + bold name + protocol badge + source badge (only when ≠ protocol); → `/agents/:id` |
| 30D In ⇅ | revenue30d | USD; tooltip: confidence label + source mix + disclaimer |
| Wallet ⇅ | walletBalance | external explorer link; label states: `$X` / `Stale wallet evidence` / `Refresh pending` / `0x1234…abcd` / `Wallet unresolved`; tooltip explains "not $0" |
| X402 ⇅ (hidden if column empty) | x402Volume | `$vol` + `n tx · n buyers` sub-line; "Payment capture pending" state |
| Token ⇅ (hidden <2xl) | tokenMarketCap | ticker + $mcap sub-line |
| Activity ⇅ | lastObservedScore | relative time; tooltip lists timestamp sources |
| Evidence | — | badge `High/Medium/Low · score` (High=cyan, Medium=amber, Low=muted) + `x/y · freshness` + `Evidence` link-button → drawer |
| Momentum (hidden <xl; only when history exists) | sparkline | RowSparkline; tooltip "26-week money trail" |
| RM Score ⇅ | signalScore | pill `border-primary/20 bg-primary/5` + Radio icon; tooltip with the full formula `log10(revenue×5 + wallet×2 + x402×1.5 + mcap×0.15 + 1)×100 + recency boost` |

Default sort signalScore desc. **Evidence drawer**: right Sheet (sm:max-w-xl),
badges row, then bordered sections — Wallet proof / Money-in proof / x402
proof / Token proof / Identity proof (site + social links) / Freshness / All
checks (status-colored verified(cyan)/pending(amber)/missing(muted) lines).

**States**: loading "Building the money-agent leaderboard…"; error in-table
"Could not load List v3 data" + message + Retry outline button; empty "No
active wallet-backed agents found yet."

**API**: `GET /api/analytics/leaderboard` (P1.3) — server-side port of the
original's evidence/scoring pipeline (`list3Evidence.ts`: buildEvidence,
hasQualifyingMoneySignal, isFacilitatorLike, confidence labels) computed over
`openclaw_agents` + `tracked_wallets` + `lobster_coins` + 30d revenue — i.e.
the original's **client-side fallback path**, promoted to the server. The
original's materialized view + pg_cron refresh log is NOT ported (D8);
"Last refreshed" reports the endpoint's own data timestamps and the debug
panel reports per-source freshness from the same payload. Momentum sparklines
were all-zero placeholders in the original (column normally hidden) — port
that behavior, don't invent data.

**Acceptance**: golden; `list3-view.spec.ts` — sort keys, hidden-column
logic, drawer open/close + section presence, formula tooltip text; **visual
golden of the drawer open** (pixel-QA set §7).

### 5.4 `/projects` upgrades (P2.8) — from PARTIAL to faithful

Current port (INV-C §3) has the 13-column table + 8-key sorting + sticky-pin
release. Missing vs. original (INV-O §2.4) — this item adds exactly:

1. **BrandHeader chrome** with the **Definitions dialog** — 13-term `<dl>`
   (Project, Facets, Website, Description, Market Cap, FDV, MC/FDV, 24h %, 30d
   sparkline, Revenue 30d, Wallet Balance, Score, Caveats), each with a
   `border-l-2 border-primary/40` accent; BookOpen trigger button; `Admin →`
   link and solid `Protocol →` external button, all 11px uppercase
   tracking-[0.2em] square-corner. (Decide header contents vs. this repo's own
   nav — D9.)
2. **Dual synced horizontal scrollbars** (thin 14px top mirror bar; main
   container hides its x-scrollbar via `.hide-x-scrollbar`), maxHeight
   `calc(100vh - 220px)`, sticky `<thead>`.
3. **Column resizing** — 1.5px drag handle at each header's right edge, min
   60px, `tableLayout: fixed` + `<colgroup>`, widths persisted in
   `localStorage['projects-col-widths-v2']`.
4. **Sticky-left Project column** (`sticky left-0 bg-background z-10`).
5. **Row name links → `/projects/:slug`** (blocked on P1.4 endpoint + P3.1
   view; links land in this item, profile page in P3.1).
6. Wallet-balance hover tooltip (up to 10 wallets w/ label/(chain)/balance,
   "+n more") and facet-pill tooltips, if the current port lacks them.
7. Migrate the fragment's 240-line inline `<style>` onto `dash.css` (§2).

Existing provenance notice, noindex, and `PROJECTS_SOURCE` gating stay as-is.
**Acceptance**: extend `projects.spec.ts` — resize + localStorage round-trip,
sticky column under horizontal scroll, synced scrollbars, dialog content,
row links; **visual golden mid-horizontal-scroll** (pixel-QA set §7).

### 5.5 `/projects/:slug` — ProjectProfile (P3.1) — public

Back link "← All projects". **Hero card**: 16×16 logo/initials tile, h1
display_name (tracking-widest text-2xl), FacetPills AGENT/COIN/WALLET/VAULT +
primary_chain chip, overview_short, website/twitter links,
FreshnessIndicator; right column (md:w-72, left border): big score
(text-3xl extrabold) + four 1px ScoreBars (Breadth/Identity/On-chain/Activity).
**Overview card** (overview_long, whitespace-pre-wrap) + "Sources" linked-chip
row (website/twitter/coingecko/dexscreener/defillama). **Money strip**: six
KpiTiles — Market Cap (price sparkline 70×22 + FDV/dilution) · Revenue 30d
(per-source) · P/S (ann.) · Wallet Balance (n wallets) · Vault TVL (weighted
APY) · x402 Footprint. **Facet tables**:

| Table | Columns |
|---|---|
| Agents | Name (logo + → `/agents/:id`) · Protocol · x402 Score · Txns · Buyers · Productivity · P/S · Holders · Status |
| Tokens | Token (logo, ticker+name, → `/lobster/:id`) · Chain · Price · 24h % · Market Cap · FDV · Volume 24h · 30d Sparkline (90×22) |
| Wallets | Label (→ `/wallets/:id`) · Address (short) · Chain · Category · Balance · Last Tx |
| Vaults | Name (→ `/vaults/:id`) · Protocol · Chain · Strategy · TVL · APY · Link (`open ↗`) |

**Holdings** (aggregated across project wallets; blank-symbol and <$1 dropped,
top 50): Asset · Chain · Amount · Price · Value · % of Treasury · Wallets ·
Source; header `Holdings · n assets · $total` + refreshed timestamp.
**History (90d)**: Token Price ChartCard (coin Select when multiple) + 2-col
grid: Market Cap / Daily Revenue / Treasury (Wallets+TVL) / Avg Agent
Productivity — Chart.js per §4.2; empty "Not enough history yet."
**Ratios**: six RatioTiles — P/S (ann.), FDV/MCAP, TVL/MCAP, Rev Growth
(±tone), Capital Efficiency, Buyers/Txn. **Activity feed**: merged activity +
merge-log entries (30 max, max-h-96 scroll, `agent`/`merge` kind chips) —
**degrades to hidden section until activity-log backing exists (P1.6)**.
**Provenance footer**: chip links Website/X/CoinGecko/DexScreener/explorers/
vault URLs + "Coverage recalculated" + freshness.

States: 3 skeletons on load; "Project not found."
**API**: `GET /api/projects/:slug` (P1.4) — one payload covering project,
facets, holdings, 90d series, activity. **Acceptance**: golden;
`project-profile.spec.ts` — hero fields, four facet tables' columns, KPI
formulas spot-checked against golden values, chart canvases present,
not-found path.

### 5.6 `/market` + `/dashboard` — "Agent Activity Log" (P4.1)

h1 + subtitle "Live feed of every tracked agent action across the network."
**TerminalFeed**: macOS-terminal pastiche — emerald-on-black card
(`border-emerald-500/20 bg-black/60 backdrop-blur`), traffic-light dots, title
`openclaw — activity.log`, `$ tail -f /var/log/openclaw/activity.log` line,
max-h-420px scroll of activity entries (50 fetched, zero-score noise filtered,
20 shown): `[YYYY-MM-DD HH:MM]` + ✓ emerald / ⏳ amber / ✗ red status,
`agent:` cyan link → `/agents/:id`, action-type chip, `commit:` summary,
submitted-by/approved-by lines, blinking block cursor.

**Admin-only block** (original: review queue + 3 discovery-scan buttons +
PendingReviewPanel): this repo has **no discovery scanner or review pipeline**
(INV-C §5 — discovery is a curated roster). Faithful-port resolution (D10):
port the TerminalFeed for everyone; port the admin block's UI **only when** an
operator review pipeline exists — record as a follow-up issue, not silently
skipped. The page without the admin block is exactly what the original showed
non-admin viewers, so public fidelity is 100%.

**API**: `GET /api/analytics/activity` (P1.6 — requires new
`agent_activity_log` migration + a pipeline writer; until a writer exists the
endpoint returns `[]` and the terminal shows an honest empty prompt line).
**Acceptance**: golden; `dashboard-view.spec.ts` — both routes render same
fragment, terminal chrome (visual golden), entry formatting from goldens,
cursor animation disabled under snapshot.

### 5.7 `/agents` — "OpenClaw Agents" (P2.2)

Header + FreshnessIndicator. Controls: Tabs `All (n) / Agents (n) /
Facilitators (n)` (facilitator = protocol_standard==='facilitator'); right
"Sparkline" label + Select (h-8 w-140px): `Score` / `x402 Vol` / `Balance`.
Summary strip (bordered `bg-muted/20`, mono xs): `{active} active / {idle}
idle · x402 txns: N · x402 vol: $N · Total balance: $N` (cyan numbers).

| Column | Notes |
|---|---|
| NAME | AgentAvatar sm + name → `/agents/:id` |
| PROTOCOL | outline badge: x402=cyan, acp=cyan-alt, virtuals=violet, olas=emerald, bankr=amber, eliza=pink, facilitator=sky, other=muted |
| STATUS | `.status-active`/`.status-inactive` badges |
| SCORE | composite = max(x402_score, productivity_score, min(100, log10(rev30+1)×25)); Info-icon header tooltip |
| x402 TXNS | Info tooltip re x402scan |
| x402 VOL | $ 2dp |
| BALANCE | $ 0dp |
| WALLET | `0x1234...abcd` |
| 6M | RowSparkline of the selected metric; Info tooltip "Weekly trend, last 26 weeks…" |

All sortable except 6M; default composite desc. Empty: Bot-icon card "No
agents tracked yet". **API**: `GET /api/analytics/agents` (P1.1; joins wallet
balances by linked_agent_id + lowercased address, 30d revenue) + series from
P1.2 (26-week buckets: score/balance=`last`, volume=`sum`). **Acceptance**:
golden; `agents-view.spec.ts` — tab filtering, sparkline metric switch
re-renders SVGs, composite-score ordering matches golden, summary math.

### 5.8 `/agents/:id` — AgentProfile "Money-agent dossier" (P3.2)

Back "← Back to List" → `/list`.
- **DossierHeader** — rounded-2xl gradient card (`from-card via-card
  to-muted/20`, `shadow-[0_24px_80px_rgba(0,0,0,0.22)]`): strip "Money-agent
  dossier" (tracking-[0.28em]) + status + protocol badges; AgentAvatar lg;
  name in **sans** `text-2xl→4xl font-[500] tracking-[-0.04em]` (the one
  deliberate non-mono heading in the app — pixel-QA hotspot); description;
  chips `source · {discovery_source}`, `seen · date`, `auto-generated
  summary`; right pill-buttons Website / @twitter / wallet chip with copy +
  basescan link.
- **MoneyStrip** — five rounded-2xl cards: 30D money in / wallet status
  (Verified liquid wallet balance / Wallet identified / Wallet missing) / x402
  flow / Freshness / Evidence score; trusted-balance rule (native +
  stablecoin + aToken-underlying only; Alchemy/DexScreener-priced ERC20s
  excluded and explained in detail copy).
- **EvidenceRail** (1.35fr) — rows with verified=emerald/partial=amber/
  missing=muted badges: Wallet evidence, Money-in proof, x402 proof, Identity
  proof, Freshness. **DataQualityPanel** (0.9fr, `border-primary/20
  bg-primary/5`) — confidence badge + "Why included" / "Open gaps" lists.
  **RankImprovementPanel** — 3 lever cards with "Next: …" action lines.
- **PerformanceChart** (x402 volume) when x402Volume>0, else dashed
  placeholder "No attributed x402 payment history yet."
- **x402 Usage Metrics** (when captured): five centered metric-cards (Score /
  Transactions / Volume / Unique Buyers / Resources) + "Source: x402scan ↗"
  when applicable. Score-factor strip: 3 metric-cards with Progress bars — Tx
  Frequency (…/40), Success Rate (…/30), Recency (…/30).
- **Linked Assets**: Managed Vaults table (NAME/STRATEGY/TVL/APY) + Tracked
  Wallets table (LABEL/ADDRESS+copy+explorer/CHAIN/BALANCE).
- **Recent Transactions** (when wallet_address): lazy "Load transaction trail"
  button → first 10 Blockscout rows: TX HASH (basescan link) / METHOD badge /
  FROM→TO / VALUE (ETH) / TIME; 5 skeletons while loading. Via P1.7 proxy.
- **Voting & Reputation**: Endorsements/Challenges count tiles + Votes
  Received (FROM/VOTE/REASON/DATE) + Votes Cast tables — **hidden until
  `agent_score_votes` backing exists (P1.6)**; when the table exists but is
  empty, show the tiles at 0 + empty tables (faithful).

**API**: `GET /api/analytics/agents/:id` (P1.5 — agent + evidence + vaults +
wallets + holdings-derived trusted balance), P1.2 series, P1.7 onchain proxy.
**Acceptance**: golden; `agent-profile.spec.ts` — dossier typography
assertions (font-family + tracking computed styles), lazy tx-trail flow,
conditional sections (x402=0 placeholder), copy buttons; **visual golden of
the dossier header** (pixel-QA set §7).

### 5.9 `/lobster` — "Lobster Coins" (P2.3)

Header row: h1 + `REFRESH` outline button + FreshnessIndicator; subtitle
"Sub-$10M market cap tokens in agentic ecosystems". **REFRESH** invoked a
Supabase edge fn; here it becomes admin-gated `POST
/api/analytics/coins/refresh` **only if** the coin-refresh job (already ported
per INV-C §3, `projects.refresh_coins`) exposes an on-demand trigger —
otherwise render the button disabled with a tooltip (D10). Ecosystem filter
pills: `ALL` + one per distinct ecosystem; active = solid cyan.

Columns (all sortable, default mcap desc; sort icon only on active column —
note this differs from other pages, preserve it): TOKEN (name truncated 32
chars + muted ticker; row `cursor-pointer` → `/lobster/:id`) · PRICE (smart
precision: ≥1000→2dp locale, ≥1→4dp, ≥0.01→6dp, else toPrecision(4)) · MCAP ·
24H VOL · 24H % (±green/red) · ECOSYSTEM (EcosystemBadge: bankr=steel-blue,
virtuals=purple, general=muted) · CHAIN (uppercase muted). Empty: Coins-icon
card "No lobster coins found". **API**: `GET /api/analytics/coins` (P1.1).
**Acceptance**: golden; `lobster-view.spec.ts` — pill filtering, price
precision tiers against golden values, whole-row navigation.

### 5.10 `/lobster/:id` — CoinProfile (P3.3)

Back → `/list`. Header: 14×14 rounded-full CoinGecko image (or Coins-icon
circle), h1 name + muted ticker, EcosystemBadge + chain; right `text-3xl` mono
bold price + ±24h. Stat grid (2/4 cols, small Stat cards): Rank (#n, CG only)
· Market Cap · 24H Volume · Liquidity (Dex) · Circulating (CG) · Total Supply
(CG) · ATH (CG) · DEX name. Performance card → Chart.js line
(daily_coin_snapshots.price_usd, period tabs). About card: CoinGecko
description HTML in a max-h-64 scroll area (**sanitize server-side** — the
original used `dangerouslySetInnerHTML`; the proxy must strip scripts).
Linked Agents chip links → `/agents/:id`. ExtLink chip row: Website, @twitter,
DexScreener pair, Basescan token. States: 3 skeletons; "Coin not found."
**API**: `GET /api/analytics/coins/:id` (P1.5), P1.2 series, P1.7
coingecko/dexscreener proxies (staleTime 5min server-side cache).
**Acceptance**: golden; `coin-profile.spec.ts` — CG-vs-Dex conditional stats,
sanitized about HTML, not-found.

### 5.11 `/vaults` — "Agent-Managed Vaults" (P2.4)

Three summary metric-cards: Total TVL (DollarSign) / Avg APY (TrendingUp,
green) / Active Vaults (amber Vault icon). Table: VAULT (cyan link →
`/vaults/:id`) · STRATEGY (outline badge) · TVL (right-aligned; `—` when
data_source==='upcoming') · APY (right, green) · MANAGING AGENT (joined name,
not sortable) · CHAIN · LAST REBALANCE (`MMM d, yyyy`). Sortable: name,
strategy_type, tvl_usd, yield_apy, chain, last_rebalance_at; default tvl
desc. **API**: `GET /api/analytics/vaults` (P1.1, joins managing-agent name).
**Acceptance**: golden; `vaults-view.spec.ts` — summary math, upcoming `—`
rendering, sort keys.

### 5.12 `/vaults/:id` — VaultProfile (P3.4)

Back → `/list`. Identity card: 12×12 cyan Vault-icon tile; h1 + badges LIVE
(green) / SIMULATED (yellow hsl(45,90%,50%)) / UPCOMING (blue
hsl(210,80%,55%)) per data_source, + strategy + chain badges; meta row short
address + copy + basescan, Created, Last rebalance. Data-source banners:
yellow "⚠ simulated data" / blue "🚀 pre-launch" strips. Four MetricCards:
TVL (green) / APY (cyan) / Strategy (purple) / Days Since Rebalance (amber).
PerformanceChart (tvl series). **Yield History**: the original rendered a
**deterministic seeded random-walk simulation** around current APY — that is
fabricated data and violates this repo's honesty contract; port the chart
frame + 30D/90D/1Y ToggleGroup but feed it **real APY history if a series
exists, else the empty state** — flagged fidelity exception (D11). Managing
Agent card (Bot icon tile, name, status, "Score: X.X") → `/agents/:id`.
Linked Wallets table (LABEL/ADDRESS copy+explorer/CHAIN/BALANCE). Recent
Vault Transactions (Blockscout via P1.7, 10 rows, same columns as 5.8).
**API**: `GET /api/analytics/vaults/:id` (P1.5), P1.2 series, P1.7.
**Acceptance**: golden; `vault-profile.spec.ts` — badge/banner variants per
data_source (goldens include one of each), yield chart honest-empty path.

### 5.13 `/wallets` — "Tracked Wallets" (P2.5)

Header controls: admin-only `Scan now` (Radar) — same treatment as 5.6 admin
block (D10: hidden until a wallet-scan pipeline exists); toggle chips
`● X402 only / ○ X402` (emerald on) and `● Hide empty / ○ Show empty` (cyan
on; hideEmpty defaults **on**). Summary: `N wallets tracked · N with balance ·
Total: $X`. Unified table merges agent wallets (agents with wallet_address,
deduped) + tracked wallets:

| Column | Notes |
|---|---|
| LABEL | — |
| TYPE | categoryBadge: agent=cyan, treasury=orange, multisig=blue, other=muted |
| PROTOCOL | protocolBadge: x402=emerald, acp=violet, ap2=cyan, ucp=amber, ows=pink; `—` at 40% opacity |
| ADDRESS | short + hover-revealed Copy/explorer icon buttons (`opacity-0 group-hover:opacity-100`) |
| BALANCE | USD |
| CHAIN | column hidden entirely when all visible rows share one chain |
| LAST ACTIVE | locale date or faded "Never" |

Sort arrows are **text `▲/▼`** appended to labels (not icons — preserve).
Default balance desc. Row click: agent-source rows → `/agents/:agentId`,
tracked rows → `/wallets/:id`. Explorer helpers:
ethereum/arbitrum/polygon/solana/base. **API**: `GET /api/analytics/wallets`
(P1.1, includes agent-wallet merge server-side). **Acceptance**: golden;
`wallets-view.spec.ts` — toggle defaults, chain-column auto-hide, hover
buttons, dual row-click targets.

### 5.14 `/wallets/:id` — WalletProfile (P3.5)

Back → `/list`. Header: Wallet icon 7×7 cyan, h1 label, category badge +
chain; right `Copy` + `{Explorer}` outline buttons. Address strip:
`bg-muted/30` box with full address in `<code>`. Three cards: Balance
(text-3xl + ±30d from snapshots) / Last Activity / Linked Agent (→
`/agents/:id`). **Balance History (30d)**: full-width Sparkline (800×120
viewBox rendered w-full h-32, cyan stroke); empty "No snapshot history yet."
On-chain summary (P1.7 proxy): 30D TXS / TOTAL TXS / ETH VOL 30D / PARTIES
30D. **TokenHoldingsCard**: count + search input (Search icon, "Filter by
symbol or address…"); table SYMBOL/AMOUNT (4dp)/USD VALUE; pagination 20/page
with "Show 20 more" / "Show all (n)" / "Collapse"; row → **TokenDetailsDrawer**
(right Sheet sm:max-w-md): Holding + USD Value (+% of wallet) tiles, contract
box (Copy/Explorer), Market Data box (dexscreener proxy: PRICE, 24H ±, MCAP,
LIQUIDITY, VOL 24H, DexScreener link). **TransactionsCard**: 4 tiles Inflow
ETH (+green) / Outflow ETH (−red) / Gas Fees / Net ETH Δ; table TIME / DIR
(IN green / OUT red outline) / COUNTERPARTY / METHOD / VALUE (ETH 5dp) / TX;
15/page; row → **TxTransfersDialog** (max-w-3xl): Time/Method/Value/Fee tiles,
From/To boxes, per-token IN/OUT/NET "Wallet Totals" table, "Token Transfers
(n)" table (DIR/TOKEN[type]/FROM/TO/AMOUNT), "View on Explorer". **Recent
Activity** table from wallet activity log (30): DATE/TXS/GAS ETH 5dp/GAS USD —
hidden until backing exists (P1.6).
**Data caveat**: `wallet_holdings` has no table here (P1.6) and live wallet
refresh is unimplemented (handler throws — INV-C §5); until fixed the page
shows snapshot-derived balance with stale-provenance notice.
**API**: `GET /api/analytics/wallets/:id`, P1.2 series, P1.7 onchain +
tx-transfers + dexscreener proxies. **Acceptance**: golden;
`wallet-profile.spec.ts` — pagination, holdings filter, drawer + dialog
flows, provenance notice when stale.

### 5.15 `/methodology` — "Scoring Methodology" (P4.3)

Card "Productivity Score": 3 weighted factors (Transaction Frequency 40%,
Success Rate 30%, Recency Decay 30%) each with icon, WEIGHT outline badge,
Progress bar (h-2), description; "Example Calculation" mono worked-example box
(Clawd → 90.1). Card "Task Throughput": data-source box (rolling 30 days,
successful txs only — reword "Basescan API" to this repo's actual source,
content-accuracy exception noted in the issue). Card "Agent Consensus Voting"
(+`Coming Soon` badge, Shield icon): explainer + votes table
VOTER/TARGET/VOTE (endorse=green, challenge=red)/REASON/DATE; empty row "No
votes cast yet — consensus voting is coming soon". **API**: votes read from
P1.6's `agent_score_votes` if landed, else the empty row (the original's
empty state — honest by construction). **Acceptance**:
`methodology-view.spec.ts` — static content assertions + progress-bar widths.

### 5.16 `/about` (P4.2)

Static, max-w-3xl. Sections: "What is RobotMoney Analytics?" intro; "The Four
Entity Types" — 4 metric-cards with colored borders (Agent cyan / Lobster Coin
purple / Vault green / Wallet amber), icon + description; "How Discovery
Works" — one card, 3 icon rows (daily scan / review queue / daily snapshots —
**reword to this repo's curated-roster + pipeline reality**, content exception
in-issue); "Inclusion Criteria" paragraphs; inline link → `/list`. No API.
**Acceptance**: `about-view.spec.ts` — section presence, card border colors.

### 5.17 `/submit` — public intake (P4.4)

Centered max-w-xl; Triangle logo block (no glow); intro; **CommitForm**
(collapsible "$ submit-commit", defaultOpen): name/handle*, tag-agent Select
(active agents), action-type Select (8 types incl. 🤖 Register Agent),
agent-registration sub-panel (name*, wallet, description + amber "Claimed
Metrics (optional · unverified)" section: revenue, txns, users, website,
twitter, launch date), summary*; toasts on submit. **MCP Server card**
(purple tones, floating CopyButton with Copy→green-Check "Copied" 2s):
**content rewritten** for D21 — REST + committee-onboarding skill install
snippet replaces the retired MCP config JSON; visual treatment identical
(fidelity exception, §1.5). **Programmatic API card**: POST example `<pre>` +
CopyButton + valid action_type list. Back link "← Back to Dashboard" → `/`
becomes → `/list` (D3). **API/backend**: `POST /api/analytics/submissions`
(P4.4 includes the intake table migration + validation + a moderation story —
minimum viable: submissions land in a table read by the existing `/admin`
surface; no auto-publish). `GET /api/analytics/agents` feeds the Select.
**Acceptance**: golden (GET) + submit e2e against demo backend;
`submit-view.spec.ts` — form validation, sub-panel toggle, copy buttons,
non-GET no-op in preview.

### 5.18 `/ask-mr-roboto` (P5.1)

Faithful UI: max-w-3xl chat page; 12×12 Bot tile header; chat card with
h-480px scroll area; empty state = 9 suggestion pills (Morpho ones purple
`border-purple-500/40 bg-purple-500/10` + 🦋 prefix); message kinds user
(right, cyan-tinted bubble) / roboto (Bot chip, "MR. ROBOTO" micro-label) /
agent (amber Zap chip); markdown rendering for direct answers (needs a tiny
CDN-free markdown renderer or server-side rendering — decision inside the
issue; **no** react-markdown); Matched Agent card (complexity badge
low=emerald/medium=amber/high=red, agent link, Delegation Plan, `Delegate Task
→`); scripted negotiation → x402 Payment card (Task Fee / Commission 15% /
Total USDC) → Confirm → Delegated state; status lines "Mr. Roboto is
thinking…" / "Negotiating with agent…"; input row with Enter submit; admin
Recent Tasks card; `?task=` query param auto-send.

**Backend is the blocker**: the original called an LLM edge fn (`ask-roboto`)
and this repo **contractually bans LLM calls on this path**
(`docs/architecture.md` §11: "no LLM/AI call anywhere on the projects read or
write path"; issues #93/#96). **Decision D5** (§8) gates this page. The UI
work item ships the page behind a route flag with the input disabled and an
honest status line until D5 resolves. No fake chat responses — ever.

### 5.19 `/gv-scratchpad` (P5.2 — decision item, recommend DROP)

Full spec preserved in INV-O §2.18 (message feed with Paste/Telegram tabs,
Telegram-export parsers, drag-drop, links/action-items/feature-ideas analysis
cards with `→ MR` handoff, notes textarea, session persistence). Blocked on:
Telegram polling infra (absent), `analyze-chat` LLM (banned), scratchpad
session storage (absent). It was an internal debug page, unreachable from
nav. **Recommendation: do not port**; record the drop as an ADR in
`docs/decisions.md` via the P5.2 issue so the "entire UI" mandate has an
explicit, argued subtraction rather than a silent one.

### 5.20 NotFound (`*`) (P4.5)

The repo's `views/not-found.html` already handles unknown routes (router
fallback). The original: full-screen centered on `bg-muted`, `404` text-4xl
bold, "Oops! Page not found", underlined "Return to Home" plain anchor.
**Decision**: keep this repo's existing branded 404 (marketing surface owns
`*`); dashboard fidelity is not harmed since the original's 404 carried no
dashboard chrome. Flagged as a drop with rationale in P4.5, which otherwise
audits route/META/sitemap wiring for the whole port.

---

## 6. Data dependencies & honesty (per route)

Schema exists ≠ data exists: facet tables are dev-seed/curated-roster unless
`PROJECTS_SOURCE=live`; live wallet refresh throws (INV-C §3, §5). Per the
provenance contract (#98/#346) every route below ships **noindexed with a
visible provenance notice** until its "live when" condition holds.

| Route | Backing today | Missing for live | Provenance at launch |
|---|---|---|---|
| /list, /list2 | `openclaw_agents`, `lobster_coins`, `agent_vaults`, `tracked_wallets`, all four `daily_*_snapshots`, `agent_revenue_daily` (INV-C §5) | `PROJECTS_SOURCE=live` cutover; wallet refresh handler; snapshot cron writing daily rows | notice + noindex |
| /list3 | same + server-side evidence pipeline (P1.3) | same; no MV/pg_cron equivalent (D8) | notice + noindex |
| /projects | live-wired coin/revenue/vault/coverage jobs; discovery = curated roster | wallet refresh; `PROJECTS_SOURCE=live` (#346 unchanged) | existing notice stays |
| /projects/:slug | same + P1.4 | + `wallet_holdings`, activity/merge logs (P1.6) — sections hidden until then | notice + noindex |
| /agents, /agents/:id | agents + snapshots + revenue | `agent_score_votes` (P1.6, votes section), onchain proxy (P1.7) | notice + noindex |
| /lobster, /lobster/:id | coins + snapshots (coin refresh job is live-wired) | CG/Dex proxies (P1.7) | earliest candidate for live |
| /vaults, /vaults/:id | vaults + tvl snapshots (vault TVL job live-wired) | APY history series (D11) | notice on simulated/upcoming rows (original behavior, aligned with our rules) |
| /wallets, /wallets/:id | tracked_wallets + snapshots | **wallet refresh unimplemented (handler throws)**; `wallet_holdings`; onchain/tx proxies | stale-provenance notice mandatory |
| /market, /dashboard | none (no activity log) | `agent_activity_log` migration + writer (P1.6) | honest empty terminal until writer exists |
| /methodology | static + optional votes | `agent_score_votes` | n/a (static) |
| /about | static | content reword to this repo's pipeline reality | n/a |
| /submit | none | intake table + POST endpoint + moderation path (P4.4) | n/a (form) |
| /ask-mr-roboto | none; **LLM banned on this path** | D5 decision + whatever backend it selects | route-flagged, input disabled |
| /gv-scratchpad | none (3 hard blockers) | — | recommend drop (D6) |

---

## 7. Pixel-QA method

1. **Reference truth**: run the original locally — copy the read-only clone to
   a temp dir, `bun install && bunx vite --port 8080`; with no Supabase env
   the visual chrome renders with empty/loading data states, which is enough
   for layout/typography/spacing QA. For data-full comparison, use the
   archived production screenshots set captured once into
   `docs/bot-analytics-ui-port/reference-shots/` (P5.3 captures them; the
   clone is ephemeral).
2. **Golden screenshots**: extend the existing visual-snapshot convention
   (`regime-visual.spec.ts` + `-snapshots/`, 1% maxDiffPixelRatio, animations
   disabled) with a `dash-visual.spec.ts` capturing, at 1440×900 dark:
   gate screen, /list full page, /list3 with evidence drawer open,
   /projects mid-horizontal-scroll (sticky column engaged),
   /agents/:id dossier header, /dashboard terminal, /wallets/:id drawer.
   These are the **highest-risk fidelity pages**: List3's drawer (dense
   nested proof sections), Projects' resizable sticky columns + dual synced
   scrollbars (easiest to get subtly wrong in CSS), AgentProfile's dossier
   (the app's one sans-serif negative-tracking design outlier), TerminalFeed
   (backdrop-blur + emerald-on-black), and the sidebar collapse rail.
3. **Checklist per view** (in each issue's acceptance criteria): fonts
   (computed font-family on h1/labels/values), exact hex/HSL of bg, border,
   primary on key elements, radius 0.25rem, spacing of the table shell,
   hover states, sort-tint `bg-primary/5`, and every tooltip's text.
4. **Deterministic data**: all visual goldens run in preview mode against
   committed api-goldens so pixels never depend on live data.
5. **Cost control** (single Blacksmith runner, hours-long e2e cycles): visual
   goldens limited to the 7 shots above; per-view functional specs grouped
   ~3 views per spec file where routes share a phase; `frontend.yml` keeps
   running only preview-smoke; the full suite stays inside `e2e.yml`.

---

## 8. Sequencing & phases (issue-shaped work items)

Dependency order: Phase 0 → 1 → 2 → 3 → 4 → 5; items within a phase are
parallel unless a dependency is listed. 35 items total.

### Phase 0 — Theme scope, shell, chart/sparkline foundation (6 items)

| # | Title | Scope & deliverables | Acceptance | Deps |
|---|---|---|---|---|
| P0.1 | `a3` dashboard theme scope | `assets/css/dash.css` per §2: scoped tokens (radius 0.25rem, HSL set), `.metric-card`, glows, status badges, data-label/value, table shell, badge/pill variants, scrollbar utils, animations; font-weight additions to the tokens.css import | Style-guide fixture fragment `views/dash/_styleguide.html` renders all classes; visual golden; `/` unaffected (no `.a3`) | — |
| P0.2 | Dash UI primitives | `alpine/lib/dash-ui.js` + CSS: tabs/pills, tooltip (hover + rich content), dialog, right sheet (sm:max-w-xl and -md), select, switch, toggle-group, progress, skeleton, scroll-area, toast (sonner look, §4.5), copy-button, icon sprite `dash-icons.svg` (§3 glyph list) | Each primitive demonstrated on the styleguide fixture; keyboard/esc close on dialog/sheet; spec asserts behaviors | P0.1 |
| P0.3 | Router layout composition + dash shell + route/SEO scaffolding | Router `layout:` support (~25 lines, preserves `rm:*` events); `views/dash/_layout.html` + `dash-shell.js` (sidebar/topbar per §5.0); routes.js entries + 5 param regexes; seo.js META (all noindex); file-permissions.json additions | `dash-shell.spec.ts` per §5.0; navigation between two stub dash views keeps layout state | P0.1, P0.2 |
| P0.4 | Access gate on admin-token auth | `dash-gate.js` per §5.0; `gated:true` route flag; session storage + re-verify + logout | Gate visual golden; auth flow spec against demo backend + goldens for `/api/admin/auth` | P0.3 |
| P0.5 | Sparkline lib + Chart.js dash theme | `alpine/lib/sparkline.js` (Sparkline, RowSparkline, exact geometry/colors per §4.3); `applyDashChartDefaults` per §4.2 | Unit tests on sparkline path output (fixed inputs → fixed `d`/points strings, `—` under 4 pts); chart theme demoed on styleguide | P0.1 |
| P0.6 | Formatting + relative-time lib | `alpine/lib/dash-format.js`: USD abbreviation variants, smart price precision, `fmtRel`, dates | Unit tests pinning every formatter to original outputs (table of cases lifted from INV-O) | — |

### Phase 1 — Read APIs & schema (7 items) — contract-first, goldens for every endpoint

| # | Title | Scope & deliverables | Acceptance | Deps |
|---|---|---|---|---|
| P1.1 | Facet list endpoints | `GET /api/analytics/{agents,coins,vaults,wallets}` in contract + backend: projections per §5.7/5.9/5.11/5.13 incl. wallet-balance joins, agent-wallet merge, managing-agent names; provenance fields on every DTO (`source`, `stale`) per architecture §12 | Goldens captured from `bun run demo`; unit tests on projections; drift gate green | — |
| P1.2 | Series endpoint + weekly bucketing | `GET /api/analytics/series/:entity/:id?days=` over the four `daily_*_snapshots`; server-side `toWeeklyBuckets` (26 Monday weeks, last/sum aggs, forward-fill) and raw daily mode for profile charts | Golden per entity type; bucketing unit tests against fixture snapshot rows | — |
| P1.3 | Aggregate endpoints: entities, overview, leaderboard | `GET /api/analytics/entities` (unified /list rows + spark series), `/overview` (counts, deltas, leaders, RM token), `/leaderboard` (List3 evidence pipeline ported server-side from `list3Evidence.ts` incl. signal-score formula, confidence labels, facilitator exclusion, per-source freshness) | Goldens; unit tests pinning the score formula to original outputs on fixtures | P1.1, P1.2 |
| P1.4 | Project profile endpoint | `GET /api/projects/:slug`: project + facet rows + KPI inputs + 90d series + holdings + activity (empty-tolerant) | Golden incl. a full-facet project and a sparse one; 404 shape | P1.1, P1.2 |
| P1.5 | Detail endpoints ×4 | `GET /api/analytics/{agents,coins,vaults,wallets}/:id` incl. linked assets (agent→vaults/wallets, coin→agents, vault→agent/wallets, wallet→agent), trusted-balance computation (§5.8), 30d balance delta | Goldens (one rich + one sparse fixture each); 404 shapes | P1.1 |
| P1.6 | Missing-table migrations + honest writers | Migrations: `agent_activity_log`, `agent_score_votes`, `wallet_holdings`, submissions intake table; `GET /api/analytics/activity`; endpoints return `[]` honestly where no writer exists yet; **explicitly no fake seed rows** | Migration tests; goldens with empty payloads; provenance notice contract documented per §11 | — |
| P1.7 | Third-party proxy endpoints | `GET /api/analytics/onchain/wallet/:address` (Blockscout summary + txs), `/onchain/tx/:hash/transfers`, `/market/coingecko/:id`, `/market/dexscreener/:chain/:address` — server-side cache (5 min), HTML sanitization for CG descriptions, loud degrade on upstream failure | Goldens (recorded fixtures); degrade path returns typed error the UI renders honestly | — |

### Phase 2 — List pages (8 items)

| # | Title | Scope | Acceptance | Deps |
|---|---|---|---|---|
| P2.1 | `/list` Total Market | §5.1 full: overview section, tabs, unified table, persistence, highlight | §5.1; visual golden | P0.*, P1.3, P1.7 |
| P2.2 | `/agents` | §5.7 | §5.7 | P0.*, P1.1, P1.2 |
| P2.3 | `/lobster` | §5.9 (refresh-button decision resolved in-issue per D10) | §5.9 | P0.*, P1.1 |
| P2.4 | `/vaults` | §5.11 | §5.11 | P0.*, P1.1 |
| P2.5 | `/wallets` | §5.13 | §5.13 | P0.*, P1.1 |
| P2.6 | `/list2` | §5.2 | §5.2 | P2.1 (shares entities feed + table plumbing) |
| P2.7 | `/list3` + evidence drawer | §5.3 | §5.3; drawer visual golden | P0.*, P1.3 |
| P2.8 | `/projects` fidelity upgrades | §5.4 items 1–7 incl. dash.css migration | §5.4; mid-scroll visual golden | P0.1; row links need P1.4 landed for hrefs to resolve (may ship anchored before P3.1 view) |

### Phase 3 — Profile pages (5 items)

| # | Title | Scope | Acceptance | Deps |
|---|---|---|---|---|
| P3.1 | `/projects/:slug` | §5.5 | §5.5 | P1.4, P0.* |
| P3.2 | `/agents/:id` dossier | §5.8 | §5.8; dossier visual golden | P1.5, P1.2, P1.7 |
| P3.3 | `/lobster/:id` | §5.10 | §5.10 | P1.5, P1.7 |
| P3.4 | `/vaults/:id` | §5.12 (yield-history honesty per D11) | §5.12 | P1.5, P1.2, P1.7 |
| P3.5 | `/wallets/:id` | §5.14 (drawer + dialog + pagination) | §5.14; drawer visual golden | P1.5, P1.2, P1.6, P1.7 |

### Phase 4 — Dashboard, prose pages, intake (5 items)

| # | Title | Scope | Acceptance | Deps |
|---|---|---|---|---|
| P4.1 | `/market` + `/dashboard` TerminalFeed | §5.6; admin block deferred per D10 (follow-up issue filed, not silently dropped) | §5.6; terminal visual golden | P1.6, P0.* |
| P4.2 | `/about` | §5.16 incl. content-accuracy rewrites | §5.16 | P0.* |
| P4.3 | `/methodology` | §5.15 | §5.15 | P0.*; votes table optional (P1.6) |
| P4.4 | `/submit` + intake backend | §5.17: form UI, POST endpoint, intake migration (if not in P1.6), moderation-read on `/admin`, MCP-card rewrite | §5.17 | P0.*, P1.1 (agent select), P1.6 |
| P4.5 | Route wiring audit + NotFound decision | Sitemap/META/robots audit across all new routes; 404 ADR (§5.20); nav ANALYTICS link repoint from old subdomain (INV-C §3 note, closes that part of #346's surface) | Spec asserting every dash route is noindex + absent from sitemap; nav link test | Phases 2–4 views |

### Phase 5 — Long tail & go-live (4 items)

| # | Title | Scope | Acceptance | Deps |
|---|---|---|---|---|
| P5.1 | `/ask-mr-roboto` faithful UI | §5.18 behind route flag, input disabled until D5; markdown renderer decision; easter-egg optional checklist | §5.18; no LLM call anywhere; spec proves disabled state | P0.*, D5 decision recorded |
| P5.2 | `/gv-scratchpad` ADR | Execute D6: record drop (or scoped port if overruled) in `docs/decisions.md` | ADR merged; plan cross-reference updated | — |
| P5.3 | Pixel-QA sweep | Run §7 end-to-end: reference capture set committed, all 7 visual goldens reviewed side-by-side, per-view checklists closed, divergence fixes | Sign-off checklist in issue; all visual goldens stable across 2 CI runs | all views |
| P5.4 | Go-live cutover | `PROJECTS_SOURCE=live` + wallet-refresh implementation (or explicit core-repo issue if the fetcher lives there), provenance-notice removal per route as its live-when condition (§6) is met, sitemap + robots index flip per route | Per-route: live provenance in API, notice removed, sitemap entry, index allowed — each gated on real data flowing | P1.6 writers, pipeline work |

**Issue conversion note**: each row above is one GitHub feature issue; titles
prefix `feat(dash):` / `feat(api):`; every issue body links this doc's section
and copies its acceptance list. Per repo process, one concern per PR; roadmap
state lives in the Plan issue, not this doc.

---

## 9. Risks & open decisions

| ID | Conflict | Recommendation |
|---|---|---|
| D1 | **Buildless vs. shadcn/Radix** — 24 primitives incl. Sidebar, Sheet, Dialog must be hand-rolled with pixel parity; biggest single fidelity effort and the reason P0.2 exists | Accept the cost; scope P0.2 to only the primitives actually used (INV-O §3 import counts); styleguide fixture is the control surface |
| D2 | **PasswordGate mechanism** — original verified a raw password against a Supabase edge fn; repo has admin-token auth | Reuse `/api/admin/auth`; UX identical (same screen, same labels); documented fidelity exception. Open sub-question: should the analytics area share the operator admin credential or get its own viewer credential? **Recommend a separate viewer token** so dashboard access never implies operator rights |
| D3 | **`/` route collision** — original mounted List at `/`; here `/` is the marketing home | List lives at `/list` only; all original secondary paths (`/market`, `/dashboard`, `/about`, …) are free and kept verbatim. In-app "Back to Dashboard"/home links point at `/list` |
| D4 | **LLM ban vs. /ask-mr-roboto** — architecture §11 bans LLM/AI calls on this path (#93/#96) | Port the UI (P5.1) behind a flag with input disabled + honest status; the backend question is a product decision routed through `robotmoney-context`/core as an issue (cross-repo: issues, never code). Never simulate answers |
| D5 | **Ask-roboto backend** (the decision D4 defers) | Options: (a) keep disabled indefinitely, (b) non-LLM rule-based matcher over agent rows (original's matcher was largely retrieval + scripted negotiation — feasible without an LLM), (c) seek an explicit ADR amending the ban. **Recommend (b)** — scripted negotiation/payment flow was already client-side theater; a deterministic matcher preserves the full UX without violating §11 |
| D6 | **/gv-scratchpad** — internal debug page; 3 hard blockers (Telegram infra, LLM analyze, session store) | **Drop with ADR** (P5.2). Faithful-port mandate satisfied by an argued, recorded subtraction |
| D7 | **Direct third-party browser calls** (Blockscout, CoinGecko/DexScreener proxies were edge fns) break preview mode and the API boundary | All third-party data via `/api/analytics/*` proxies (P1.7) with server-side cache + sanitization; preview intercepts stay complete |
| D8 | **List3 materialized view + pg_cron** — heavy infra for a leaderboard | Compute in the P1.3 endpoint (the original shipped an equivalent client-side fallback path); add caching only if measured slow. Refresh-log UI reports endpoint data timestamps honestly |
| D9 | **BrandHeader on public projects pages** — original's public chrome vs. this repo's existing site nav | Keep this repo's global nav; render the original's BrandHeader strip *inside* the a3 scope beneath it only if pixel review (P5.3) finds the page reads wrong without it. Definitions dialog is kept regardless |
| D10 | **Admin actions with no backing pipeline** (Dashboard scan buttons, Wallets Scan now, Lobster REFRESH, PendingReviewPanel) | Never render a button that does nothing: hide admin-only controls until their pipeline exists (each gets a follow-up issue); Lobster REFRESH may wire to the ported coin-refresh job if an on-demand trigger is added, else disabled+tooltip |
| D11 | **VaultProfile simulated yield chart** — original fabricated a seeded random walk; violates honesty contract #98 | Port chart frame + toggles; feed real APY history or show the empty state. Fidelity exception recorded in P3.4 |
| D12 | **Seed-data provenance (#346) generalizes** — every new facet page inherits "real source before indexing" | §6 table is the contract: notice + noindex per route until its live-when condition holds; P5.4 is the only place notices are removed |
| D13 | **e2e cost** — single runner, hours-long cycles (memory: e2e gate flake); this port adds ~19 views | ~12 grouped spec files instead of 19; 7 visual goldens only; specs run in preview mode wherever a live backend adds nothing; phase-sized PRs so each e2e cycle covers several views |
| D14 | **Wallet refresh unimplemented** (handler throws) — /wallets pages would show stale balances | Ship with stale-provenance notices (honest per contract); implementation or core-repo issue tracked in P5.4; do not block the UI phases on it |
| D15 | **Missing tables** (activity log, votes, holdings) | P1.6 adds schema + honest empty endpoints; dependent UI sections hide or show original empty states; writers are follow-up pipeline work, never faked |

---

## 10. Summary

- Port all 20 original routes into the buildless Alpine SPA at pixel fidelity;
  drops (gv-scratchpad, dual toasts, dead code) are argued, everything else is
  faithful.
- Isolation via a single shared `.a3`-scoped `dash.css`; hand-rolled primitives
  replace shadcn; Chart.js replaces recharts; sparklines stay hand-rolled SVG.
- 35 issue-shaped items across 6 phases: foundation → read APIs → list pages →
  profiles → dashboard/prose/intake → long tail + go-live.
- Every endpoint gets contract routes + captured goldens; every view gets a
  Playwright spec; 7 visual goldens cover the highest-risk pages.
- Honesty contract enforced throughout: noindex + provenance notices until per-
  route live-data conditions hold; LLM ban respected; nothing fabricated.
