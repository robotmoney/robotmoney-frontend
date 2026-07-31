# RobotMoney Analytics — UI Inventory (pixel-fidelity port reference)

Source repo: `robotmoney/robotmoney-bot-analytics` (read-only clone at
`/tmp/claude-1003/-drive2-home-lucas-robotmoney-robotmoney-frontend/7bc86c64-7832-4cef-9786-693d0ea53a0f/scratchpad/robotmoney-bot-analytics`).
All paths below are relative to that repo root.

Stack: Vite 5 + React 18 + TypeScript, react-router-dom v6, TanStack Query v5,
shadcn/ui (Radix), Tailwind 3.4 (+tailwindcss-animate, @tailwindcss/typography),
recharts 2.15, lucide-react, sonner + radix-toast, date-fns, react-markdown +
remark-gfm, Supabase JS v2. Deployed via Cloudflare wrangler (`wrangler.jsonc`,
SPA `not_found_handling`). Dev server on port 8080 with `/api` proxy
(`vite.config.ts`).

---

## 1. Route map (`src/App.tsx`)

Provider tree: `QueryClientProvider > TooltipProvider > <Toaster/> (radix) + <Sonner/> > BrowserRouter > FreshnessProvider > Routes`.

| Path | Component | Wrapper |
|---|---|---|
| `/submit` | `Submit` | **public** (no gate, no layout) |
| `/projects` | `Projects` | **public** (BrandHeader, no sidebar) |
| `/projects/:slug` | `ProjectProfile` | **public** (BrandHeader) |
| `/` | `List` | PasswordGate > DashboardLayout |
| `/market` | `Dashboard` | gated layout |
| `/dashboard` | `Dashboard` | gated layout (same component as `/market`) |
| `/list` | `List` | gated layout (same as `/`) |
| `/list2` | `List2` | gated layout |
| `/list3` | `List3` | gated layout |
| `/about` | `About` | gated layout |
| `/agents` | `Agents` | gated layout |
| `/agents/:id` | `AgentProfile` | gated layout |
| `/lobster` | `Lobster` | gated layout |
| `/lobster/:id` | `CoinProfile` | gated layout |
| `/vaults` | `Vaults` | gated layout |
| `/vaults/:id` | `VaultProfile` | gated layout |
| `/wallets` | `Wallets` | gated layout |
| `/wallets/:id` | `WalletProfile` | gated layout |
| `/methodology` | `Methodology` | gated layout |
| `/ask-mr-roboto` | `AskMrRoboto` | gated layout |
| `/gv-scratchpad` | `GVScratchpad` | gated layout (NOT in sidebar nav — reachable by URL only) |
| `*` | `NotFound` | none |

The gated group is a single layout route: `<Route element={<PasswordGate><DashboardLayout/></PasswordGate>}>`.

### PasswordGate (`src/components/PasswordGate.tsx` + `src/hooks/useAdminAuth.ts`)
- Mechanism: password is POSTed to Supabase edge function `admin-scanner`
  with `{ action: 'verify-password', password }`; server compares against
  `ADMIN_PASSWORD` env. Nothing is validated client-side.
- Storage: on success the **raw password** is stored in
  `sessionStorage['admin_password']`; on mount, a saved password is re-verified
  against the API before granting access; `logout()` clears it.
- Locked-screen UI: full-screen centered (`min-h-screen flex items-center
  justify-center bg-background p-4`), max-w-sm column:
  - Logo block: 14×14 (`w-14 h-14`) rounded-lg `bg-primary/10 border
    border-primary/20` with `glow-cyan` shadow, containing a lucide `Triangle`
    icon (`h-7 w-7 text-primary`).
  - `RobotMoney` h1 (`text-xl font-mono font-extrabold uppercase
    tracking-wider`), subtitle `ANALYTICS PLATFORM` (`text-xs font-mono
    text-muted-foreground`).
  - Error `Alert` variant destructive (`bg-destructive/10
    border-destructive/30`) with `AlertCircle` icon.
  - Password `Input` with left `Lock` icon, right eye/eye-off show-password
    toggle, placeholder `Enter access key`, `pl-10 pr-10 bg-card font-mono
    text-sm`, autoFocus.
  - Full-width submit `Button` — label `ACCESS DASHBOARD` /
    `VERIFYING...` when loading, disabled when empty.
  - Bottom link to `/submit`: `Send` icon + "Submit a community commit"
    (`text-xs font-mono text-muted-foreground hover:text-primary`).

### DashboardLayout (`src/components/DashboardLayout.tsx`)
- Uses shadcn `Sidebar` (`SidebarProvider`, `collapsible="icon"`).
- Sidebar header: 8×8 rounded `bg-primary/10 border-primary/20` box with
  `Triangle` (`h-4 w-4 text-primary`); when expanded, stacked text
  `RobotMoney` (`text-sm font-mono font-extrabold uppercase tracking-widest`)
  over `ANALYTICS` (`text-[10px] font-mono text-muted-foreground`). Bottom
  border under header.
- Main nav group (`mainNavItems`, in order):
  1. `List` → `/list` — icon `ListOrdered`
  2. `List v2 (WIP)` → `/list2` — icon `ListOrdered`
  3. `List v3` → `/list3` — icon `Trophy`
  4. `Projects` → `/projects` — icon `Layers`
  5. `About` → `/about` — icon `HelpCircle`
- Bottom (border-top separated) tools group (`toolNavItems`):
  1. `Ask Mr. Roboto` → `/ask-mr-roboto` — icon `MessageSquare`
  2. `Activity Log` → `/dashboard` — icon `Activity`
  3. `Methodology` → `/methodology` — icon `BookOpen`
  - then a ghost `Sign Out` button (icon `LogOut`) that calls `logout()`.
- Nav item styling: `NavLink` wrapper (custom, `src/components/NavLink.tsx`,
  adds `activeClassName` compat over router v6). Labels `text-xs font-mono
  uppercase tracking-wide`; active = `bg-primary/10 text-primary
  font-semibold`; hover = `bg-muted/50`; icons `mr-2 h-4 w-4`. Note: sidebar
  contains no links to /agents, /lobster, /vaults, /wallets, /market,
  /gv-scratchpad — those are reached via in-page links or URL.
- Content column: topbar `header` height 12 (`h-12`), border-bottom, contains
  `SidebarTrigger` (hamburger, `text-muted-foreground`) + current page title
  looked up from nav items by exact pathname (`text-xs font-mono font-semibold
  text-muted-foreground uppercase tracking-wider`; fallback text `Dashboard`).
- `<main class="flex-1 p-6 overflow-auto">` wraps `<Outlet/>`.

---

## 2. Per-page inventory (`src/pages/`)

Common patterns used across gated pages:
- Page h1: `text-2xl font-mono font-extrabold uppercase tracking-tight`,
  subtitle `text-sm text-muted-foreground mt-1 font-mono`.
- Table shell: `rounded-lg border border-border overflow-hidden` around shadcn
  `Table`; header row `bg-muted/30`; header cells `font-mono text-xs`
  (uppercase labels), sortable headers `cursor-pointer select-none
  hover:text-foreground` with `ArrowUpDown` (inactive, `opacity-40`) /
  `ArrowUp` / `ArrowDown` 3×3 icons; body rows `hover:bg-muted/20`.
- Money formatting: `$X.XXB / $X.XXM / $X.XK / $X.XX` abbreviation helpers
  (each page has a local `fmt`/`formatUsd` with slightly different decimals —
  see per-page notes). Positive % green `text-[hsl(142,70%,45%)]`, negative
  `text-destructive`, `+` prefix on positives.
- Loading state: plain text `Loading ...` in `text-sm text-muted-foreground
  font-mono` (a few pages use `Skeleton`s instead).
- Empty state: `metric-card` (see §4) with a big 10×10 muted lucide icon and a
  one-line message.

### 2.1 List (`src/pages/List.tsx`) — routes `/` and `/list` — title "Total Market"
The flagship unified table.
- Sections top-to-bottom:
  1. h1 `Total Market` + subtitle "Aggregate view across every tracked agent,
     coin, vault, and wallet."
  2. `<TotalMarketOverview/>` (see §3) — $ROBOTMONEY ticker card + 5 metric
     cards + 4 "leaders" cards.
  3. `pt-4 border-t` divider; h2 `All Tracked Entities` + live "Sorted by:
     LABEL ↑/↓" caption; right side `FreshnessIndicator` (global freshness
     context) + link to `/about` with `HelpCircle` icon "What am I looking
     at?".
  4. Filter row: `Tabs` pills `All (n) / Agents (n) / Coins (n) / Vaults (n) /
     Wallets (n)` (`bg-muted/30 border border-border`); right side `Switch` +
     label `Show unverified (n)`.
  5. The unified table.
- **Table columns** (all sortable except 6M):
  | Header | Field | Format |
  |---|---|---|
  | NAME | name | `AgentAvatar` size sm rounded-full + name truncated max-w-[260px] + ticker badge (coins) + tiny `Globe`/`Twitter` icons at 40% opacity when website/twitter present. Cell is `Link` to `row.href`. |
  | TYPE | type | outline Badge `AGENT`(cyan)/`COIN`(purple accent)/`VAULT`(green)/`WALLET`(amber) per `TYPE_META`, plus amber `Pending` badge if unverified |
  | CATEGORY | category | Title-cased string, truncate max-w-[180px] (e.g. "x402 Agent", "Tokenized Agent", "Yield Vault · Morpho", "Treasury Wallet") |
  | contextual (varies by tab): MARKET CAP / SCORE / APY / LAST TX | market_cap / score / apy / last_tx_at | USD abbr / 1-decimal / `X.XX%` / relative time ("3h ago") — width 120px |
  | REVENUE / VOL (label becomes `REVENUE (30D)` on Agents tab) | volume | USD abbr; agents get dotted-underline hover `title` tooltip breaking down `revenue_sources` per source + "updated Xh ago" |
  | BALANCE / TVL | balance | USD abbr |
  | 6M (not sortable) | sparkline | `RowSparkline` 80×22 — 26 weekly buckets |
  | 24H % | change_24h | ±X.XX%, green/red |
- Sorted-column tint: header + body cells of active sort col get `bg-primary/5`
  (`colTint`).
- Default sort: `contextual` desc (legacy `market_cap` key migrates to
  `contextual`). Switching tab resets to contextual desc.
- Persistence: filter/sort/showUnverified in
  `sessionStorage['list:state']`; last clicked row key in
  `sessionStorage['list:lastViewed']` — on return the row is scrolled into
  view (`scrollIntoView block:center smooth`) and highlighted with
  `bg-primary/10 ring-1 ring-inset ring-primary/40 animate-pulse` for 4s.
- Row-link graph: agents→`/agents/:id`, coins→`/lobster/:id`,
  vaults→`/vaults/:id`, wallets→`/wallets/:id`.
- Data: one queryKey `['unified-list-v2']` doing 9 parallel Supabase selects:
  `openclaw_agents`, `lobster_coins`(is_active), `agent_vaults`(is_active),
  `tracked_wallets`(is_active), `daily_coin_snapshots`,
  `daily_tvl_snapshots`, `daily_wallet_snapshots`, `daily_agent_snapshots`
  (all snapshots ≥182 days), and view `agent_revenue_30d`. Sparklines: daily
  rows bucketed into 26 Monday-anchored weeks (`toWeeklyBuckets`, agg 'last'
  for prices/TVL/balance with forward-fill, 'sum' for agent x402 volume).
- Pending logic: agent rows with `!is_active || status==='pending_review'`
  are `opacity-60` and hidden unless "Show unverified" on.

### 2.2 List2 (`src/pages/List2.tsx`) — `/list2` — "List v2 (WIP)"
- Header: h1 `List v2` (v2 in muted), subtitle "Real on-chain & market metrics
  per entity type. No composite scores…", right side outline Badge `Work In
  Progress`. Page wrapped in `container mx-auto px-4 py-6` (unlike List).
- Tabs with icons + counts: `Agents · n / Coins · n / Vaults · n / Wallets ·
  n` (Bot/Coins/Vault/Wallet icons). Single-entity table per tab, defined as a
  per-tab column array (label, accessor, fmt, align, width, tooltip,
  renderCell). Header cells `font-mono uppercase text-[10px] tracking-wider`.
- **Agent tab columns**: AGENT (avatar+name, links `/agents/:id`) · PROTOCOL ·
  30D EARNED (tooltip: "Operating revenue: x402 endpoint sales + Olas service
  rewards") · 30D TOKEN TAX (tooltip: "~0.6% of round-trip volume") · 30D
  INFLOW (tooltip on wallet inflow) · X402 VOL · X402 TXNS (int) · WALLET BAL
  (renders as explorer `<a>` with `ExternalLink`) · TOKEN MCAP · LAST ACTIVE
  (relative `fmtRel`: `5m/3h/2d/1mo`) · 6M PRICE sparkline (Tooltip: "26w
  token price ($TICKER)" or "No linked token"). Default sort `rev_earned`
  desc. Pending agents excluded.
- **Coin tab**: COIN · TICKER (outline Badge) · CHAIN · PRICE · 24H % · MARKET
  CAP · 24H VOLUME · CONTRACT (short addr → explorer) · 6M PRICE spark.
  Default sort market_cap desc.
- **Vault tab**: VAULT · PROTOCOL · STRATEGY · CHAIN · TVL · APY · SOURCE
  (Badge, `default` variant when `live` else outline) · CONTRACT · REBALANCED
  (rel) · 6M TVL spark. Default tvl_usd desc.
- **Wallet tab**: WALLET · CATEGORY · CHAIN · BALANCE (explorer link) ·
  ADDRESS (short → explorer) · LAST TX (rel) · SYNCED (rel) · 6M BAL spark.
  Default balance_usd desc.
- First column always renders `AgentAvatar` + bold name linked to the profile.
- Data: queryKey `['list2-data']`, same 9 sources as List (slightly wider
  agent column select incl. x402_buyers/x402_resources_count/task_throughput).
- Loading/empty: single row `Loading…` / `No entries.` centered in table.

### 2.3 List3 (`src/pages/List3.tsx`) — `/list3` — "List v3 · Money Agents" (most complex page)
- Header block: eyebrow line with glowing dot (`h-1.5 w-1.5 rounded-full
  bg-primary shadow-[0_0_10px_hsl(var(--primary))]`) + "Robot Money ·
  Money-Agent Index / Top 100"; h1 `List v3 · Money Agents` (`text-3xl
  font-extrabold uppercase tracking-tighter`, "v3" in primary); subtitle;
  freshness line "Last refreshed: Xm ago" (from
  `list3_agent_candidates_refresh_log`, polls 60s) with red "· refresh error"
  suffix on error. Right: outline Button link → `/submit` ("Invite / submit an
  agent").
- 4 `StatCard`s (custom, not MetricCard): bordered card with a 1px
  gradient top edge (`bg-gradient-to-r from-transparent via-primary/40`),
  label `text-[10px] uppercase tracking-[0.2em]`, value `text-2xl
  font-extrabold tabular-nums`, caption, and icon chip
  (`border-primary/20 bg-primary/10 text-primary`). Cards: Listed Agents /
  Verified Wallet Balance / 30D Money In / High Confidence.
- Collapsible `<details>` "Leaderboard health (debug)" panel: MV rows, last
  refresh, refresh status (+duration ms), pg_cron schedule note, error
  message; plus "Source data health" grid fed by view
  `list3_data_freshness_health` (per-source cards: name, role, status badge
  healthy=green/partial=amber/stale|empty=red, `x/y fresh <36h`, %, never
  count, latest refresh). Both meta queries poll every 60s.
- **Leaderboard table** (max 100 rows, `overflow-x-auto` wrapper, rows
  `h-[68px]`):
  | Header | Field | Notes |
  |---|---|---|
  | # | rank | recomputed after each sort |
  | Agent | name | AgentAvatar sm + bold name + secondary Badge protocol + outline Badge source (only when != protocol). Links `/agents/:id` |
  | 30D In ⇅ | revenue30d | USD; Tooltip: confidence label ("Payment evidence"/"Platform-reported"/…) + source mix + disclaimer |
  | Wallet ⇅ | walletBalance | Rendered as external explorer link. Label states: `$X` (verified) / `Stale wallet evidence` / `Refresh pending` / `0x1234…abcd` / `Wallet unresolved`; Tooltip explains "not $0" semantics |
  | X402 ⇅ (hidden if no row has x402 activity) | x402Volume | `$vol` + sub-line `n tx · n buyers`; x402-identity-without-capture shows "Payment capture pending" with tooltip |
  | Token ⇅ (hidden below 2xl breakpoint) | tokenMarketCap | ticker + $mcap sub-line |
  | Activity ⇅ | lastObservedScore | relative time label; tooltip lists timestamp sources |
  | Evidence | — | outline Badge `High/Medium/Low · score` (High=primary, Medium=amber, Low=muted) + `x/y · freshness` + link-style `Evidence` Button opening the drawer |
  | Momentum (hidden below xl; only when any row has history) | sparkline | RowSparkline; tooltip "26-week money trail" |
  | RM Score ⇅ | signalScore | pill `border-primary/20 bg-primary/5` with `Radio` icon; tooltip with the full formula: `log10(revenue×5 + verified wallet balance×2 + x402 flow×1.5 + token mcap×0.15 + 1)×100 + recency boost` |
- Default sort `signalScore` desc; sortable keys: signalScore, revenue30d,
  walletBalance, x402Volume, tokenMarketCap, lastObservedScore.
- **Evidence drawer**: right `Sheet` (sm:max-w-xl) with badges row then
  sections (each `rounded-md border bg-card/60 p-3` with tiny uppercase
  title): Wallet proof / Money-in proof / x402 proof / Token proof / Identity
  proof (site + x/social links) / Freshness / All checks (status-colored
  `verified`(primary)/`pending`(amber)/`missing`(muted) lines).
- Data: primary query `['list3-agent-leaderboard']` reads view
  `list3_agent_candidates` (`is_top50_eligible=true`, order last_observed_at
  desc, limit 150, 20s timeout wrapper). Fallback when the view is missing
  from schema cache: 4 legacy selects (openclaw_agents, tracked_wallets,
  lobster_coins, agent_revenue_30d) assembled client-side with the same
  scoring pipeline (`src/lib/list3Evidence.ts`: buildEvidence,
  hasQualifyingMoneySignal, isFacilitatorLike, revenue confidence labels,
  relativeTime). Sparklines are currently all-zero placeholders
  (`emptySparkline()` = 26 zeros) so the Momentum column is normally hidden.
- Error state: in-table centered "Could not load List v3 data" + message +
  Retry outline button. Loading: "Building the money-agent leaderboard…".
  Empty: "No active wallet-backed agents found yet."

### 2.4 Projects (`src/pages/Projects.tsx`) — `/projects` — public
- Chrome: `BrandHeader` (see §3) with a **Definitions** dialog whose content
  is a 13-term `<dl>` (Project, Facets, Website, Description, Market Cap, FDV,
  MC/FDV, 24h %, 30d sparkline, Revenue 30d, Wallet Balance, Score, Caveats)
  each with a `border-l-2 border-primary/40` accent.
- h1 `Agentic Economy Ecosystem.` (`text-3xl font-mono font-extrabold
  uppercase tracking-widest`), subtitle in font-sans.
- **Custom raw `<table>`** (not shadcn) with advanced behaviors:
  - Dual synced horizontal scrollbars (thin 14px bar on top mirroring the main
    scroll container; main container hides its own x-scrollbar via
    `.hide-x-scrollbar`), `maxHeight: calc(100vh - 220px)` with sticky
    `<thead>` (`sticky top-0 z-10`).
  - `tableLayout: fixed` with a `<colgroup>`; **column resizing** by dragging
    a 1.5px handle at each header's right edge (min 60px); widths persisted in
    `localStorage['projects-col-widths-v2']`.
  - First column (`Project`) is sticky-left (`sticky left-0 bg-background
    z-10`, header `bg-muted/30`).
  - Columns (default widths px): Project 260 (sticky, logo 7×7 rounded or
    2-letter initials tile, name links `/projects/:slug`) · Market Cap 140
    (per-coin lines `TICKER $x`) · FDV 110 (per-coin) · MC/FDV 90 (% computed)
    · 24h % 100 (per-coin, emerald-500/red-500) · 30d 110 (RowSparkline 90×24
    of first coin's daily price) · Data Quality 110 (bold score) · Description
    340 (overview_short → description → overview_long) · Website 200 (link,
    scheme stripped) · Social 130 (@handle link) · Facets 140 (5 `Pill`s: AGT,
    X402, COIN, WLT, VLT — on: `bg-primary/10 text-primary border-primary/30`;
    off: 40%-muted; each with a tooltip) · Revenue 30d 130 · Wallet Balance
    150 (total + "n wallets" sub-line; hover Tooltip lists up to 10 wallets
    with label/(chain)/balance, "+n more").
  - Sortable: name, mcap, fdv, pct24h, revenue, wallet, score, facets.
    Default sort key `fdv` desc, but "sticky projects" (`is_sticky`) pin to
    the top until the first header click of the session (`stickyActive`).
    Multi-coin rows sort by max value.
- Data: queryKey `['projects-list', 55]` — `projects` where status=active AND
  `data_coverage_score >= 55` ordered by score desc; then `.in('project_id',
  ids)` selects on lobster_coins / tracked_wallets / openclaw_agents /
  agent_vaults; then agent_revenue_daily (30d) + daily_coin_snapshots (30d).
  Facet flags recomputed live from facet-table presence (has_* columns
  distrusted). x402 pill = protocol_standard==='x402' OR any x402 metric > 0.
- Loading: plain "Loading…" text.

### 2.5 ProjectProfile (`src/pages/ProjectProfile.tsx`) — `/projects/:slug` — public
- Chrome: `BrandHeader` (no definitions), `max-w-[1400px] mx-auto p-6`.
- Back link "← All projects" → `/projects`.
- **Hero card**: 16×16 logo (or initials tile), h1 display_name
  (`tracking-widest text-2xl`), FacetPills AGENT/COIN/WALLET/VAULT +
  primary_chain chip, overview_short paragraph, website + twitter links +
  `FreshnessIndicator(coverage_calculated_at ?? updated_at)`. Right column
  (md:w-72, left border): big score number (`text-3xl font-extrabold`) +
  four `ScoreBar`s (Breadth/Identity/On-chain/Activity — 1px-high
  `bg-muted` track, `bg-primary` fill = value%).
- **Overview card** (if overview_long): whitespace-pre-wrap text + "Sources"
  chip row derived from `overview_sources` boolean map (website, twitter,
  coingecko, dexscreener, defillama → linked chips).
- **Money strip**: 6 `KpiTile`s (grid 2/3/6): Market Cap (with price
  sparkline 70×22 + FDV/dilution detail) · Revenue 30d (per-source detail) ·
  P/S (ann.) `mcap/(rev30·12)` · Wallet Balance (n wallets) · Vault TVL
  (weighted APY) · x402 Footprint (txns; vol · buyers · res detail).
- **Facet tables** (each `FacetTable` = h2 `Title (n)` + bordered
  overflow-x-auto raw table, header `bg-muted/30`, rows
  `hover:bg-muted/20`):
  - Agents: Name (logo+link `/agents/:id`) · Protocol · x402 Score · Txns ·
    Buyers · Productivity · P/S · Holders · Status.
  - Tokens: Token (logo, ticker+name, link `/lobster/:id`) · Chain · Price ·
    24h % · Market Cap · FDV · Volume 24h · 30d Sparkline (90×22).
  - Wallets: Label (link `/wallets/:id`) · Address (short) · Chain · Category
    · Balance · Last Tx.
  - Vaults: Name (link `/vaults/:id`) · Protocol · Chain · Strategy · TVL ·
    APY · Link (external `open ↗`).
- **Holdings** (aggregated `wallet_holdings` across project wallets;
  blank-symbol and <$1 rows dropped, top 50 shown): Asset · Chain · Amount ·
  Price · Value · % of Treasury · Wallets (labels) · Source (price_source
  set). Header shows `Holdings · n assets · $total` + refreshed timestamp.
- **History (90d)**: Token Price chart card with a coin `Select` when
  multiple tokens; then 2-col grid of `ChartCard`s: Market Cap (aggregate),
  Daily Revenue, Treasury (Wallets + TVL), Avg Agent Productivity.
  `ChartCard` = recharts `LineChart` (h-32), linear line `hsl(var(--primary))`
  width 2 no dots, dashed CartesianGrid `hsl(var(--border))` 30% opacity,
  hidden XAxis, YAxis fontSize 9 width 50, tooltip styled
  `background: hsl(var(--background))`, plus big last-value + ±% change
  header. Empty: "Not enough history yet."
- **Ratios & Analytics**: 6 `RatioTile`s — P/S (annualized), FDV/MCAP,
  TVL/MCAP, Rev Growth (±green/red tone), Capital Efficiency, Buyers/Txn.
- **Activity feed**: merged agent_activity_log + project_merge_log entries
  (30 max, scrollable max-h-96, divided rows) with `agent`(primary)/
  `merge`(accent) kind chips.
- **Data Provenance footer**: chip links to Website, X, CoinGecko per coin,
  DexScreener per coin (chain-slug guarded), explorer per wallet, vault
  external URLs; "Coverage recalculated" + FreshnessIndicator.
- Data: one big queryKey `['project-profile', slug]` — projects by slug, then
  facets by project_id, then 8 more selects (agent_revenue_daily 90d,
  daily_coin_snapshots, daily_wallet_snapshots, daily_tvl_snapshots,
  daily_agent_snapshots, agent_activity_log limit 25, project_merge_log limit
  15, wallet_holdings).
- Loading: BrandHeader + 3 Skeletons. Not-found: "Project not found."

### 2.6 Dashboard (`src/pages/Dashboard.tsx`) — `/dashboard` & `/market` — "Agent Activity Log"
- h1 `Agent Activity Log` + subtitle "Live feed of every tracked agent action
  across the network."
- `<TerminalFeed/>` (§3): fake-terminal activity log.
- Admin-only block (isAuthenticated && storedPassword):
  - "Review Queue" heading (ClipboardList amber icon) with amber pending-count
    pill (`bg-amber-500 text-black rounded-full text-[9px]`); "Last scan Xm
    ago" chip (Clock icon + green/red status dot) from RPC
    `get_last_discovery_run` (polls 5 min).
  - Three outline scan Buttons (each disabled while any scan runs; spinning
    `RefreshCw` while active, else `Search` icon): `Scan x402 Ecosystem`
    (cyan tones), `Scan ZHCs` (amber), `Scan All Sources` (emerald) → edge
    function `discover-agents` `{action, password}`; success/error via
    **sonner** toast with discovered/updated/skipped counts; invalidates the
    pending-review query keys.
  - `<PendingReviewPanel password/>` (§3).
- Data: pending count from `openclaw_agents` status='pending_review'.

### 2.7 Agents (`src/pages/Agents.tsx`) — `/agents` — "OpenClaw Agents"
- Header + `FreshnessIndicator` (global context).
- Controls row: `Tabs` filter `All (n) / Agents (n) / Facilitators (n)`
  (facilitator = protocol_standard==='facilitator'); right side "Sparkline"
  label + `Select` (h-8 w-[140px]) choosing sparkline metric: `Score` /
  `x402 Vol` / `Balance`.
- Summary bar (bordered `bg-muted/20` strip, font-mono text-xs): `{active}
  active / {idle} idle · x402 txns: N · x402 vol: $N · Total balance: $N`
  (primary-colored numbers).
- **Table columns**: NAME (AgentAvatar sm + name → `/agents/:id`) · PROTOCOL
  (outline Badge, color per protocol: x402=primary, acp=cyan, virtuals=violet,
  olas=emerald, bankr=amber, eliza=pink, facilitator=sky, other=muted) ·
  STATUS (`status-active`/`status-inactive` badge classes) · SCORE (composite;
  header has `Info` icon Tooltip explaining "Max of x402_score,
  productivity_score, log-scaled 30d revenue score") · x402 TXNS (Info tooltip
  re x402scan) · x402 VOL ($, 2dp) · BALANCE ($, 0dp) · WALLET (0x1234...abcd)
  · 6M (RowSparkline of selected metric; Info tooltip "Weekly trend, last 26
  weeks…"). All sortable except 6M; default `compositeScore` desc.
- Composite score = max(x402_score, productivity_score, revenue_score) where
  revenue_score = min(100, log10(rev30+1)×25).
- Data: `['openclaw-agents-with-balances']` = openclaw_agents* +
  tracked_wallets (balance mapping by linked_agent_id AND lowercased address)
  + agent_revenue_daily 30d; `['agent-sparkline-series']` = 200d of
  daily_agent_snapshots + daily_wallet_snapshots + tracked_wallets mapping,
  bucketed to 26 weeks (score/balance='last', volume='sum'), staleTime 5 min.
- Empty: Bot icon card "No agents tracked yet".

### 2.8 AgentProfile (`src/pages/AgentProfile.tsx`) — `/agents/:id` — "Money-agent dossier"
- Back link "← Back to List" → `/list`.
- **AgentDossierHeader** — rounded-2xl gradient Card
  (`bg-gradient-to-br from-card via-card to-muted/20`,
  `shadow-[0_24px_80px_rgba(0,0,0,0.22)]`): top strip "Money-agent dossier"
  (tracking-[0.28em]) + status badge + protocol badge; body: AgentAvatar lg,
  name in **non-mono** `text-2xl→4xl font-[500] tracking-[-0.04em]`,
  description paragraph, chips `source · {discovery_source}`, `seen · date`,
  `auto-generated summary`; right side pill-buttons: Website, @twitter, wallet
  address chip with copy Button + basescan link.
- **AgentMoneyStrip** — 5 rounded-2xl cards (grid 1/2/5): `30D money in` /
  wallet status (Verified liquid wallet balance / Wallet identified / Wallet
  missing) / `x402 flow` / `Freshness` / `Evidence score` — each with icon in
  rounded-full chip, `text-2xl font-[500]` value, min-h-14 detail text.
  Trusted-balance logic: only native + stablecoin + aToken-underlying
  holdings count (`TRUSTED_WALLET_PRICE_SOURCES`); Alchemy/DexScreener-priced
  ERC20s are excluded and explained in the detail copy.
- **AgentEvidenceRail** (left, 1.35fr) — rows with status Badge
  (verified=emerald tone, partial=amber, missing=muted), label, detail, source
  chip. Items: Wallet evidence, Money-in proof, x402 proof, Identity proof,
  Freshness.
- **AgentDataQualityPanel** (right, 0.9fr, `border-primary/20 bg-primary/5`) —
  confidence badge + two lists: "Why included" / "Open gaps".
- **AgentRankImprovementPanel** — 3 lever cards (Wallet verification /
  Money-in provenance / Fresh activity) each with status badge, detail, and
  "Next: …" action line.
- **PerformanceChart** (entityType 'agent', x402 volume) — only when
  x402Volume>0; otherwise a dashed placeholder card "No attributed x402
  payment history yet."
- **x402 Usage Metrics** (when captured): 5 centered metric-cards — x402
  Score / Transactions / Volume (USD) / Unique Buyers / Resources; plus
  "Source: x402scan · name ↗" link when discovery_source==='x402scan'.
- Score-factor strip: 3 metric-cards with `Progress` bars — Tx Frequency
  (…/40), Success Rate (…/30), Recency (…/30).
- **Linked Assets** card: Managed Vaults table (NAME/STRATEGY/TVL/APY) and
  Tracked Wallets table (LABEL/ADDRESS+copy+explorer/CHAIN badge/BALANCE).
- **Recent Transactions** (when wallet_address): lazy — a dashed callout with
  "Load transaction trail" Button; then Blockscout
  `base.blockscout.com/api/v2/addresses/{addr}/transactions` first 10 rows:
  TX HASH (basescan link) / METHOD badge / FROM→TO short / VALUE (ETH) /
  TIME. Loading = 5 Skeletons.
- **Voting & Reputation**: 2 count tiles (Endorsements green ThumbsUp /
  Challenges red ThumbsDown, `data-value` numbers) + Votes Received table
  (FROM/VOTE badge/REASON/DATE) + Votes Cast table (TARGET/VOTE/REASON/DATE).
- Data: agent from view `list3_agent_candidates` by agent_id (fallback
  `openclaw_agents` by id); `agent_vaults` by managing_agent_id;
  `tracked_wallets` by linked_agent_id; `wallet_holdings` by wallet ids;
  `agent_score_votes` received/cast (FK-named joins); Blockscout REST
  (staleTime 60s, only after button click).

### 2.9 Lobster (`src/pages/Lobster.tsx`) — `/lobster` — "Lobster Coins"
- Header row: h1 + `REFRESH` outline Button (spinning RefreshCw; invokes edge
  fn `refresh-lobster-coins {mode:'latest'}`, sonner toast "Refreshed N
  coins") + FreshnessIndicator. Subtitle "Sub-$10M market cap tokens in
  agentic ecosystems".
- Ecosystem filter pills (rounded-full buttons): `ALL` + one per distinct
  ecosystem; active = `bg-primary text-primary-foreground border-primary`,
  inactive = `bg-muted/30 text-muted-foreground border-border`.
- **Table columns** (all sortable; default mcap desc; sort icon appears only
  on active column here): TOKEN (name truncated at 32 chars + muted ticker;
  cell Link + whole row `cursor-pointer` navigate to `/lobster/:id`) · PRICE
  (smart precision: ≥1000 → 2dp locale, ≥1 → 4dp, ≥0.01 → 6dp, else
  toPrecision(4)) · MCAP · 24H VOL · 24H % (green/red ±) · ECOSYSTEM
  (`EcosystemBadge`: bankr=steel-blue `hsl(200,80%,…)`, virtuals=purple
  `hsl(270,60%,…)`, general=muted) · CHAIN (uppercase muted).
- Data: `['lobster-coins']` full table ordered market_cap desc;
  `['lobster-freshness']` latest refreshed_at.
- Empty: Coins icon card "No lobster coins found".

### 2.10 CoinProfile (`src/pages/CoinProfile.tsx`) — `/lobster/:id`
- Back link → `/list`.
- Header: 14×14 rounded-full CoinGecko image (or muted Coins-icon circle),
  h1 name + muted ticker, EcosystemBadge + chain; right side `text-3xl
  font-mono font-bold` price + ±% 24h.
- Stat grid (2/4 cols, small `Stat` cards = Card p-3 with tiny uppercase
  label + `text-lg font-mono font-bold`): Rank (#n, CG only) · Market Cap ·
  24H Volume · Liquidity (Dex) · Circulating (CG) · Total Supply (CG) · ATH
  (CG) · DEX name (Dex).
- Performance Card → `PerformanceChart` entityType 'coin'
  (daily_coin_snapshots.price_usd).
- About Card: CoinGecko description rendered via `dangerouslySetInnerHTML`
  inside `ScrollArea max-h-64` (fallback: coin.description plain).
- Linked Agents Card: chip links (logo 4×4 + name →) → `/agents/:id`.
- External-link chip row (`ExtLink`: bordered text-xs chips): Website (CG),
  @twitter (CG), DexScreener pair, Basescan token.
- Data: `lobster_coins` by id; edge `coingecko-proxy {coingecko_id}` (staleTime
  5 min, no retry); edge `dexscreener-proxy {contract_address, chain}` (only
  when no coingecko_id); `openclaw_agents` where lobster_coin_id=id.
- Loading: 3 Skeletons. Not-found: "Coin not found."

### 2.11 Vaults (`src/pages/Vaults.tsx`) — `/vaults` — "Agent-Managed Vaults"
- 3 summary metric-cards (grid-cols-3): Total TVL (DollarSign) / Avg APY
  (TrendingUp, green value) / Active Vaults (amber Vault icon).
- **Table**: VAULT (primary link → `/vaults/:id`) · STRATEGY (outline Badge) ·
  TVL (right; `—` when data_source==='upcoming') · APY (right, green) ·
  MANAGING AGENT (name via join, not sortable) · CHAIN · LAST REBALANCE
  (`MMM d, yyyy`). Sortable: name, strategy_type, tvl_usd, yield_apy, chain,
  last_rebalance_at; default tvl_usd desc.
- Data: `agent_vaults` + joined `openclaw_agents(name)` ordered tvl desc.

### 2.12 VaultProfile (`src/pages/VaultProfile.tsx`) — `/vaults/:id`
- Back → `/list`.
- **Identity Card**: 12×12 primary Vault icon tile; h1 name + badges: LIVE
  (green) / SIMULATED (yellow `hsl(45,90%,50%)`) / UPCOMING (blue
  `hsl(210,80%,55%)`) per data_source, strategy_type badge, chain badge;
  meta row: short address + copy + basescan, Created date, Last rebalance
  date.
- Data-source banners: yellow "⚠ simulated data" or blue "🚀 pre-launch"
  callout strips.
- 4 `MetricCard`s: TVL (green) / APY (cyan) / Strategy (purple) / Days Since
  Rebalance (amber).
- `PerformanceChart` entityType 'vault' (daily_tvl_snapshots.tvl_usd).
- **Yield History chart** (SIMULATED data — deterministic seeded random walk
  around current APY): recharts `AreaChart` h-64, linear area with
  `yieldGradient` (primary 0.3→0 vertical fade), dashed grid 40%, X ticks
  fontSize 10 mono (interval 3/6/30 by range), Y `${v}%` width 48, tooltip
  card-styled with 8px radius; `ToggleGroup` 30D/90D/1Y (square-corner
  segments, active = solid primary).
- **Managing Agent** card: linked row (Bot icon in accent tile, name, status
  badge, "Score: X.X") → `/agents/:id`.
- **Linked Wallets** table (wallets linked to managing agent): LABEL /
  ADDRESS (copy+explorer) / CHAIN badge / BALANCE (USD).
- **Recent Vault Transactions** (Blockscout, 10): TX HASH / METHOD badge /
  FROM→TO / VALUE (ETH) / TIME. Loading = 5 Skeletons.

### 2.13 Wallets (`src/pages/Wallets.tsx`) — `/wallets` — "Tracked Wallets"
- Header right controls: admin-only `Scan now` Button (Radar icon → edge
  `discover-wallets {action:'scan-all', password}`, radix toast); two toggle
  chips: `● X402 only / ○ X402` (emerald when on) and `● Hide empty / ○ Show
  empty` (primary when on; hideEmpty defaults **on**).
- Summary bar: `N wallets tracked · N with balance · Total: $X`.
- **Unified table** merging agent wallets (from `openclaw_agents` with
  wallet_address, deduped) + `tracked_wallets`: LABEL · TYPE
  (`categoryBadge`: agent=primary, treasury=orange, multisig=blue,
  other=muted) · PROTOCOL (`protocolBadge`: x402=emerald, acp=violet,
  ap2=cyan, ucp=amber, ows=pink; `—` at 40% opacity otherwise) · ADDRESS
  (short + hover-revealed Copy and explorer icon buttons,
  `opacity-0 group-hover:opacity-100`) · BALANCE · CHAIN (column hidden
  entirely when every visible row is on the same chain) · LAST ACTIVE
  (locale date or faded "Never"). Sort arrows are text `▲/▼` appended to the
  label (not lucide icons). Default balance desc.
- Row click navigates: agent-source rows → `/agents/:agentId`, tracked rows →
  `/wallets/:id`.
- Explorer helpers cover ethereum/arbitrum/polygon/solana/base.
- (Contains an in-file `OnchainEnrichment` panel component — grid of 30D
  TXS / ETH VOL 30D / PARTIES + token-balance mini-table via `wallet-onchain`
  edge fn — currently not rendered by the page body.)

### 2.14 WalletProfile (`src/pages/WalletProfile.tsx`) — `/wallets/:id`
- Back → `/list`. Header: Wallet icon 7×7 primary, h1 label, category Badge +
  chain; right buttons: `Copy` and `{Explorer name}` outline buttons.
- Address strip: `bg-muted/30` box with full address in `<code>`.
- 3 cards: Balance (`text-3xl` + ±% 30d from snapshots) / Last Activity
  (locale datetime) / Linked Agent (logo/Bot icon + name link →
  `/agents/:id`).
- **Balance History (30d)** Card: full-width `Sparkline` svg (800×120 viewBox
  rendered `w-full h-32`), primary stroke. Empty: "No snapshot history yet."
- On-chain summary (edge fn `wallet-onchain`): 4 small cards — 30D TXS /
  TOTAL TXS / ETH VOL 30D / PARTIES 30D.
- **TokenHoldingsCard**: header with count + search `Input` (left Search
  icon, "Filter by symbol or address…"); table SYMBOL/AMOUNT (4dp)/USD VALUE;
  client-side pagination 20/page with "Show 20 more" outline + "Show all (n)"
  ghost + "Collapse" buttons; rows clickable → **TokenDetailsDrawer** (right
  `Sheet`, sm:max-w-md): Holding + USD Value (+% of wallet) tiles, contract
  box with Copy/Explorer buttons, Market Data box (dexscreener-proxy: PRICE,
  24H ±, MCAP, LIQUIDITY, VOL 24H, "View on DexScreener" link).
- **TransactionsCard** (from wallet-onchain `recent_txs`): 4 summary tiles —
  Inflow ETH (+green) / Outflow ETH (−red) / Gas Fees / Net ETH Δ; table
  TIME / DIR (IN green / OUT red outline badge) / COUNTERPARTY / METHOD /
  VALUE (ETH 5dp) / TX (hash link); paginate 15/page. Row click →
  **TxTransfersDialog** (`Dialog` max-w-3xl): Time/Method/Value/Fee tiles,
  From/To boxes, "Wallet Totals" per-token IN/OUT/NET table, "Token
  Transfers (n)" table (DIR/TOKEN[type]/FROM/TO/AMOUNT) via edge fn
  `tx-transfers`, "View on Explorer" button.
- **Recent Activity** table from `wallet_activity_log` (30): DATE / TXS /
  GAS (ETH 5dp) / GAS (USD).

### 2.15 Methodology (`src/pages/Methodology.tsx`) — `/methodology` — "Scoring Methodology"
- Card "Productivity Score": 3 weighted factors (Transaction Frequency 40%,
  Success Rate 30%, Recency Decay 30%) each with icon, WEIGHT outline badge,
  `Progress` bar (h-2), description; plus an "Example Calculation" mono
  worked example box (Clawd → 90.1).
- Card "Task Throughput": data-source box (Basescan API, rolling 30 days,
  successful txs only).
- Card "Agent Consensus Voting" with secondary badge `Coming Soon` (Shield
  icon): explainer + votes table VOTER/TARGET/VOTE (outline badge,
  endorse=green, challenge=red)/REASON/DATE; empty row "No votes cast yet —
  consensus voting is coming soon".
- Data: `agent_score_votes` (joined voter/target names, limit 50).

### 2.16 About (`src/pages/About.tsx`) — `/about`
- Static content, max-w-3xl. Sections: intro "What is RobotMoney Analytics?";
  "The Four Entity Types" — 4 metric-cards with colored borders (Agent cyan /
  Lobster Coin accent / Vault green / Wallet amber) with icon + description;
  "How Discovery Works" — one card with 3 icon rows (Automatic daily 13:00
  UTC scan; Review queue; Daily snapshots); "Inclusion Criteria" paragraphs.
  Inline link to `/list`.

### 2.17 AskMrRoboto (`src/pages/AskMrRoboto.tsx`) — `/ask-mr-roboto`
- max-w-3xl chat page. Header: 12×12 Bot tile + h1 "Ask Mr. Roboto" +
  subtitle "Your AI headmaster…".
- **Chat Card**: `ScrollArea` h-[480px]; empty state shows 9 suggestion
  pill-buttons — Morpho ones styled purple (`border-purple-500/40
  bg-purple-500/10 text-purple-300` + 🦋 prefix), others muted→primary hover.
- Message kinds: user (right-aligned `bg-primary/10 border-primary/20`
  bubble); roboto (Bot chip + text; "MR. ROBOTO" micro-label during
  negotiation); agent (amber Zap chip + agent-name micro-label). Direct
  Morpho answers render **markdown** via ReactMarkdown+remark-gfm with an
  elaborate prose class string (white headings/strong, bordered gfm tables)
  and a 🦋 "Morpho Direct Answer" badge.
- **Matched Agent card** (ml-8, `bg-muted/30`): Zap + "MATCHED AGENT",
  optional 🦋 Morpho badge, complexity Badge (low=emerald, medium=amber,
  high=red), agent name link → `/agents/:id`, description, score + short
  wallet; Separator; "Delegation Plan" block; `Delegate Task →` Button.
- Delegation flow: scripted negotiation messages with delays (900/1200ms) →
  **x402 Payment card** (`border-primary/20 bg-primary/5`): 3-col Task Fee /
  Commission (15%) / Total USDC; roboto wallet line; `Confirm Payment →`
  button → "Delegated" state with green CheckCircle2. Bankr-endpoint agents
  actually POST edge fn `delegate-to-bankr`; others simulate. Radix toast on
  completion.
- Status lines: "Mr. Roboto is thinking…" (muted spinner) / "Negotiating with
  agent…" (amber spinner).
- Input row: bordered top, `Input` "Describe a task…" + icon send Button
  (Enter submits).
- **Recent Tasks card** (admin only, via `secure-data` edge fn
  list-roboto-tasks): rows of description / $total / status outline badge.
- Extras: `?task=` query param auto-sends (used by GV Scratchpad); Star-Wars
  easter eggs via `src/lib/easterEggs.ts` (`detectEasterEgg` + runR2D2 /
  runChancellor / runOrder66 / runJedi / runDeathStar scripted multi-agent
  sequences using live agent rows).
- Backend: raw fetch to `${VITE_SUPABASE_URL}/functions/v1/ask-roboto` with
  anon bearer.

### 2.18 GVScratchpad (`src/pages/GVScratchpad.tsx`) — `/gv-scratchpad`
- Header: small h1 (`text-lg tracking-widest`) + `Save` (outline) and
  `Analyze` (primary) buttons with spinners.
- 2-col grid:
  - **Message Feed card** with Tabs `Paste` / `Telegram`:
    - Paste: Upload-Export ghost button (hidden file input, accepts
      .json/.html/.htm/.txt with Telegram-export parsers), Trash clear;
      drag-&-drop overlay (dashed primary border + Upload icon); `Textarea`
      min-h-[400px] mono, pre-filled with MOCK_MESSAGES sample chat.
    - Telegram: chat-id `<select>`, `{n} msgs` badge, Refresh button; ScrollArea
      h-[400px] rendering `[time] Sender: text` lines (sender in primary);
      polls `secure-data list-telegram-messages` every 30s. Empty state Radio
      icon + "Add the bot to your Telegram group chat."
  - **Links & Resources card** (below feed): extracted links with context.
  - Right column: **Action Items card** (task + priority badge
    high=destructive/medium=chart-4 amber/low=muted, "by X", `→ MR` button
    sending the task to `/ask-mr-roboto?task=`) and **Feature Ideas card**
    (idea + category badge + `→ MR`).
- Bottom **Scratchpad Notes** Textarea (min-h-[100px]).
- Persistence: sessionId in `localStorage['gv-scratchpad-session']`;
  load/save via `secure-data` get-/upsert-scratchpad-session; analysis via
  edge fn `analyze-chat` returning {action_items, links, feature_ideas}.

### 2.19 Submit (`src/pages/Submit.tsx`) — `/submit` — public "PUBLIC INTAKE FUNNEL"
- Centered max-w-xl column; same Triangle logo block as PasswordGate (no
  glow).
- Intro paragraph + `<CommitForm defaultOpen label="Submit an Agent or
  Activity"/>` (§3).
- **MCP Server card** (purple `hsl(270,70%,60%)` tones): explainer, JSON
  connection-config `<pre>` with floating **CopyButton** (Copy→green Check
  "Copied" 2s), tool list (register_agent, submit_activity, list_agents,
  get_agent_profile, list_coins, get_platform_info, get_submission_fields),
  🤖 MCP badge note.
- **Programmatic API card**: POST example `<pre>` + CopyButton; valid
  action_type list line.
- Back link "← Back to Dashboard" → `/`.

### 2.20 NotFound (`src/pages/NotFound.tsx`) — `*`
- Full-screen centered on `bg-muted`: `404` (text-4xl bold), "Oops! Page not
  found", underlined `<a href="/">Return to Home</a>` (plain anchor, not
  Link). Logs the missed path via console.error.

---

## 3. Shared components (`src/components/`, non-ui)

| Component | File | Purpose | Used by |
|---|---|---|---|
| `PasswordGate` | PasswordGate.tsx | Session-storage password wall (see §1) | App route wrapper |
| `DashboardLayout` | DashboardLayout.tsx | Sidebar + topbar shell (see §1) | all gated routes |
| `NavLink` | NavLink.tsx | react-router NavLink with `activeClassName`/`pendingClassName` compat | DashboardLayout |
| `BrandHeader` | BrandHeader.tsx | Public sticky header (`bg-background/80 backdrop-blur`, max-w-[1400px]): robotmoney-logo.svg (h-9) → robotmoney.net; optional `Definitions` dialog button (BookOpen icon, max-w-3xl scrollable DialogContent); `Admin →` link to `/`; solid primary `Protocol →` external button. Buttons all `text-[11px] uppercase tracking-[0.2em]` square-corner | Projects, ProjectProfile |
| `MetricCard` | MetricCard.tsx | `.metric-card` stat tile: `data-label` + icon chip (variant cyan/purple/green/amber → border glow classes + icon tint), `data-value`, optional trend line (±% green/red + label), optional right-aligned `Sparkline` at 60% opacity, optional icon Tooltip | TotalMarketOverview, VaultProfile |
| `Sparkline` | Sparkline.tsx | Minimal SVG polyline (default 80×24, stroke 1.5, single color prop) | MetricCard, WalletProfile (large 800×120), ProjectProfile KpiTile |
| `RowSparkline` | RowSparkline.tsx | Table-cell sparkline (80×22, stroke 1.25) with 12%-opacity area fill; auto-color: green if last>first by >0.5%, red if down, muted flat; renders `—` for <4 finite points | List, List2, List3, Agents, Projects |
| `AgentAvatar` | AgentAvatar.tsx | Logo image or uppercase first-initial in `rounded-md border bg-muted` tile; sizes sm 6×6 / md 10×10 / lg 14×14 / xl 20×20; img error → fallback initial | List, List2, List3, Agents, AgentProfile |
| `FreshnessIndicator` | FreshnessIndicator.tsx | `Clock` icon + "Last refreshed X ago" (`text-[10px] font-mono`), null-safe | most list pages, ProjectProfile |
| `PerformanceChart` | PerformanceChart.tsx | Reusable recharts LineChart (h-48) with period `Tabs` 24h/7d/30d/90d/1y/all; per-entity source table: coin→daily_coin_snapshots.price_usd, vault→daily_tvl_snapshots.tvl_usd, wallet→daily_wallet_snapshots.total_balance_usd, agent→daily_agent_snapshots.x402_volume_usd; shows ±% over period; linear primary line w2 no dots, dashed grid 30%, hidden X axis, Y width 60 fontSize 10 USD-abbrev ticks, mono tooltip. Empty: "Not enough history for this period yet." queryKey `['perf', type, id, period]` | CoinProfile, VaultProfile, AgentProfile |
| `TerminalFeed` | TerminalFeed.tsx | macOS-terminal pastiche: emerald-on-black card (`border-emerald-500/20 bg-black/60 backdrop-blur`), red/amber/emerald traffic-light dots, title `openclaw — activity.log`, `$ tail -f /var/log/openclaw/activity.log` line, max-h-[420px] scroll of agent_activity_log entries (50 fetched, zero-score noise filtered, 20 shown): `[YYYY-MM-DD HH:MM]` + status icon/color (✓ emerald / ⏳ amber / ✗ red), `agent:` cyan link → `/agents/:id`, action-type chip, `commit:` summary, submitted-by/approved-by lines, blinking block cursor | Dashboard |
| `TotalMarketOverview` | TotalMarketOverview.tsx | The `/list` top section: (1) $ROBOTMONEY row-card (CoinGecko robot.jpg image, live price via coingecko-proxy→dexscreener-proxy, ±24h) opening a Dialog with price/mcap/contract/CoinGecko/Basescan links; (2) 5 MetricCards: OpenClaw Agents (cyan; pending-review trend), Lobster Coins (purple), Vault TVL (green + 7d TVL sparkline), Tracked Wallets (amber), Total AUM (green); (3) 4 leader cards linking to top agent/coin/vault + "Avg P / Revenue" (Σmcap/Σx402 rev, links `/methodology`). 10+ small queries (counts, deltas, leaders, rm-token) | List |
| `CommitForm` | CommitForm.tsx | Collapsible "$ submit-commit" form: name/handle*, tag-agent Select (active agents), action-type Select (8 types incl. 🤖 Register Agent), agent-registration sub-panel (name*, wallet, description + "Claimed Metrics (optional · unverified)" amber section: revenue, txns, users, website, twitter, launch date), summary*; submits edge fn `submit-activity`; sonner toasts | Submit |
| `PendingReviewPanel` | PendingReviewPanel.tsx | Admin review queue with Tabs (discovered agent candidates / agent registrations / other commits); candidate cards list discovery source, source_ref link, x402 stats, publication criteria checklist; Approve (Check) / Reject (X) buttons → edge fn `review-activity {password, entry_id, decision}` | Dashboard |

`src/contexts/FreshnessContext.tsx`: global max(refreshed_at/enriched_at)
across lobster_coins, agent_vaults, tracked_wallets, openclaw_agents;
refetchInterval 60s, staleTime 30s; consumed via `useFreshness()`.

`src/hooks/`: `useAdminAuth` (§1), `use-toast` (shadcn radix toast store,
TOAST_LIMIT=1), `use-mobile` (768px matchMedia).

`src/lib/`: `utils.ts` (cn), `easterEggs.ts` (511 lines of scripted Star-Wars
chat sequences for AskMrRoboto), `list3Evidence.ts` (List3 scoring/labels:
formatUsd/formatInt/prettyProtocol/sourceLabel/sourceMixLabel/
revenueSourceConfidenceLabel/buildEvidence/hasQualifyingMoneySignal/
isFacilitatorLike/isFreshWithinHours/relativeTime), plus 12 node-test files.

### shadcn/ui usage (`src/components/ui/` — 48 files present)
Actually imported somewhere (with import counts): button (18), badge (14),
table (11), tooltip (7), skeleton (7), card (7), tabs (6), input (5),
dialog (5), sheet (3), select (3), scroll-area (3), toast (2), separator (2),
progress (2), label (2), toggle-group (1), toggle (via toggle-group),
toaster (1), textarea (1), switch (1), sonner (1), sidebar (1),
collapsible (1), alert (1). All other primitives (accordion, alert-dialog,
aspect-ratio, avatar, breadcrumb, calendar, carousel, chart, checkbox,
command, context-menu, drawer, dropdown-menu, form, hover-card, input-otp,
menubar, navigation-menu, pagination, popover, radio-group, resizable,
slider) exist but are unused. `components.json`: style "default", baseColor
"slate", cssVariables true, no prefix.

---

## 4. Visual system

### tailwind.config.ts
- `darkMode: ["class"]` (but no theme toggle exists — the single `:root`
  palette IS the dark theme; there is no light mode).
- Container: centered, padding 2rem, 2xl screen 1400px.
- fontFamily: `serif: Libre Baskerville/Georgia` (unused in practice),
  `sans: Inter/system-ui`. (Actual body font is set in CSS, see below.)
- Semantic colors all `hsl(var(--x))`: border, input, ring, background,
  foreground, primary, secondary, destructive, muted, accent, popover, card
  (+foregrounds); extra brand names **sage / olive / coral / tealBadge /
  navy** (+light/dark variants) — their CSS vars are *not defined* in
  index.css (legacy, effectively unused); full `sidebar` color set.
- borderRadius: lg = `var(--radius)` (0.25rem), md = −2px, sm = −4px.
- keyframes/animations: accordion-down/up (0.2s), fade-in (0.5s),
  fade-in-up (0.5s translateY(10px)), `0g-glow` (2.8s infinite scale/opacity
  pulse — unused in src).
- Plugin: tailwindcss-animate.

### src/index.css
- Google Fonts import: **JetBrains Mono** (300–700), **Space Grotesk**
  (300–700), **Inter** (300–700).
- `:root` tokens (RobotMoney brand, synced with robotmoney.net):
  - `--background: 222 33% 4%` (#06080c "void")
  - `--foreground: 230 15% 90%` (#e2e4ec)
  - `--card` / `--popover: 218 28% 9%` (#10141c "surface")
  - `--primary` / `--accent` / `--ring: 186 100% 50%` (**cyan #00e5ff**),
    foregrounds = background color
  - `--secondary: 270 60% 55%` (purple), white foreground
  - `--muted: 218 25% 12%`, `--muted-foreground: 220 12% 60%`
  - `--destructive: 0 65% 55%`
  - `--border` / `--input: 216 24% 18%` (#222a38 "line")
  - `--radius: 0.25rem`
  - chart colors: `--chart-1..5` = 186 100% 50% / 270 60% 55% / 142 70% 45% /
    38 90% 55% / 340 75% 55%
  - sidebar set: background 220 30% 5%, otherwise mirrors main tokens.
  - `--font-mono: 'JetBrains Mono'`, `--font-sans: 'Space Grotesk', 'Inter'`.
- Base layer: `* { @apply border-border }`; body = bg-background,
  text-foreground, antialiased, `font-family: var(--font-sans)` (Space
  Grotesk); **all h1–h6 = JetBrains Mono 700**; `code, .font-mono` =
  JetBrains Mono.
- Component classes: `.metric-card` (bg-card border rounded-lg p-5),
  `.glow-cyan` (`0 0 20px hsl(187 100% 45% / .15)`), `.glow-purple`
  (`0 0 20px hsl(270 60% 55% / .15)`), `.status-active` (green text/12%
  bg/25% border in `hsl(142,70%,45%)`), `.status-inactive` (muted),
  `.data-label` (`text-xs font-mono text-muted-foreground uppercase
  tracking-wider`), `.data-value` (`text-2xl font-mono font-bold`).
- Utilities: `.scrollbar-thin`, `.no-scrollbar`, `.hide-x-scrollbar`
  (hides only the horizontal webkit scrollbar — used by Projects dual-scroll).
- Ad-hoc greens/ambers throughout pages use raw `hsl(142,70%,45%)` (success
  green) and `hsl(38,90%,55%)` (amber) rather than tokens.
- `src/App.css` is Vite boilerplate and **not imported** anywhere — ignore.

### index.html
- `<title>RobotMoney — Agentic Asset Analytics</title>`; description "RobotMoney
  Analytics Platform — track OpenClaw agents, lobster coins, agent-managed
  vaults, and on-chain wallets."; favicon `/favicon.png` (also
  apple-touch-icon and og:image / twitter:image); og:type website,
  twitter:card summary_large_image; no font `<link>`s (fonts come from the
  CSS @import).

### Responsive behavior
- Breakpoints are default Tailwind (sm/md/lg/xl/2xl + container 2xl 1400px).
- Notables: List3 hides Token column below 2xl and Momentum below xl;
  gated content relies on `p-6 overflow-auto` main; shadcn sidebar collapses
  to icon rail and uses `use-mobile` (<768px) offcanvas behavior; grids
  step 1→2→4/5/6 columns via sm/lg.

---

## 5. Data layer

### Client (`src/integrations/supabase/`)
- `client.ts`: `createClient<Database>(VITE_SUPABASE_URL,
  VITE_SUPABASE_PUBLISHABLE_KEY)` with localStorage session persistence.
  Env in `.env` (project `gmrwxwggtgtdyqpnqgvp`).
- `types.ts`: generated DB types (source of `Tables<'list3_agent_candidates'>`).

### Tables (from `supabase/migrations/*.sql`)
Core entities:
- `openclaw_agents` — id, name, description/auto_description, status
  (active/pending_review), is_active, protocol_standard, wallet_address,
  lobster_coin_id, logo_url, website_url, twitter_handle, api_endpoint,
  discovery_source, source_ref/confidence/last_seen_at, productivity_score,
  task_throughput, x402_score/txn_count/volume_usd/buyers/resources_count,
  last_active_at, enriched_at, project_id, virtuals_agent_id,
  olas_service_id, ZHC fields (candidate_kind, zhc_*, cumulative/annualized
  revenue, price_to_sales, token_holders).
- `lobster_coins` — name, ticker, coingecko_id, contract_address, chain,
  ecosystem, category, price_usd, market_cap, fdv, volume_24h,
  percent_change_24h, logo_url, description, is_active, refreshed_at,
  project_id.
- `agent_vaults` — name, protocol, strategy_type, chain, vault_address,
  tvl_usd, yield_apy, last_rebalance_at, data_source
  (live/simulated/upcoming), external_url, managing_agent_id, is_active,
  refreshed_at, project_id.
- `tracked_wallets` — label, address, chain, category
  (agent/treasury/multisig/other), balance_usd, last_tx_at, refreshed_at,
  linked_agent_id, is_active, logo_url, project_id.
- `projects` — slug, display_name, logo_url, description,
  overview_short/long/sources, website_url, twitter_handle, primary_chain,
  data_coverage_score + breadth/identity/onchain/activity scores,
  coverage_calculated_at, has_agent/coin/wallet/vault, is_sticky, status.
Snapshots/history: `daily_agent_snapshots`, `daily_coin_snapshots`,
`daily_tvl_snapshots`, `daily_wallet_snapshots`, `daily_wallet_holdings`,
`daily_token_prices`, `wallet_activity_log`, `wallet_holdings` (token_address,
symbol, amount, price_usd, amount_usd, price_source, refreshed_at).
Revenue: `agent_revenue_daily` (agent_id, revenue_usd, revenue_date, source ∈
x402/olas/virtuals/wallet_inflow) + view **`agent_revenue_30d`** (agent_id,
revenue_usd_30d, by_source json, latest_revenue_date).
Activity/social: `agent_activity_log` (action_type, summary, status,
submitted_by, approved_by, metadata), `agent_score_votes` (voter/target,
vote endorse|challenge, reason), `project_merge_log`, `agent_source_registry`,
`roboto_tasks`, `gv_scratchpad_sessions`, `telegram_messages`,
`telegram_bot_state`, `admin_config`, `dune_cache`, plus legacy index tables
(`dai_constituents`, `rwa_constituents`, `index_methodology`,
`user_custom_indexes`, `model_deployments`).
List3 read path: **`list3_agent_candidates`** (materialized view, refreshed
every 5 min by pg_cron; `list3_agent_candidates_refresh_log` table),
`list3_wallet_evidence` view, `list3_data_freshness_health` view.
Functions/RPCs used by UI: `get_last_discovery_run`. Others:
compute_project_coverage, resolve_project_identity, refresh_list3_*,
scheduler helpers.

### Edge functions (`supabase/functions/`) — 42 total
UI-invoked (directly from the frontend):
- `admin-scanner` — verify-password action (PasswordGate) + scanner admin ops.
- `discover-agents` — scan-x402-ecosystem / scan-zhcs / scan-all (Dashboard buttons).
- `discover-wallets` — scan-all (Wallets "Scan now").
- `refresh-lobster-coins` — CoinGecko+DexScreener price refresh (Lobster REFRESH).
- `coingecko-proxy` / `dexscreener-proxy` — market-data proxies (CoinProfile, TotalMarketOverview, token drawer).
- `wallet-onchain` — Alchemy balances + Blockscout tx summary (WalletProfile, Wallets panel).
- `tx-transfers` — per-tx token transfers via Blockscout (WalletProfile dialog).
- `ask-roboto` — task→agent matcher (AskMrRoboto), Morpho direct-answer mode.
- `delegate-to-bankr` — live Bankr API delegation (AskMrRoboto payment).
- `analyze-chat` — LLM chat-log analysis (GVScratchpad).
- `secure-data` — password-gated proxy for private tables (roboto_tasks,
  scratchpad sessions, telegram messages).
- `submit-activity` — public commit/agent-registration intake (CommitForm).
- `review-activity` — approve/reject pending entries (PendingReviewPanel).
Pipeline/cron (not called from UI): `auto-review-agents`,
`backfill-agent-history`, `backfill-agent-protocol-ids`,
`backfill-agent-revenue-virtuals`, `backfill-coin-history`,
`backfill-project`, `backfill-vault-tvl`, `discover-acp`,
`discover-virtuals`, `dune-query`, `enrich-agent`, `enrich-agent-logos`,
`enrich-entity-logos`, `enrich-project-overviews`, `fetch-vault-data`,
`market-data`, `morpho-proxy`, `refresh-wallet-balances`,
`scheduler-refresh`, `seed-data`, `snapshot-daily`,
`sync-agent-revenue-olas`, `sync-agent-revenue-virtuals`,
`sync-agent-revenue-wallet-inflow`, `sync-agent-revenue-x402`,
`telegram-poll`, `ai-index-advisor`, `ai-recommender`, `mcp-server`,
`mcp-admin`.
**"The six edge functions" powering Projects** = the six numbered steps of
the `backfill-project` orchestrator (supabase/functions/backfill-project/
index.ts): (1) `enrich-agent` per agent, (2) `refresh-lobster-coins` +
`enrich-entity-logos` per coin, (3) `refresh-wallet-balances` per wallet,
(4) `enrich-project-overviews`, (5) `backfill-coin-history` +
`backfill-agent-history` (180d), (6) RPCs `resolve_project_identity` +
`compute_project_coverage`.

### Query cadence
Only three queries poll: FreshnessContext 60s; List3 refresh-meta +
data-freshness 60s; Dashboard last-scan 5 min; GVScratchpad telegram 30s.
Everything else is default react-query (no refetchInterval); several use
staleTime 60s–5min.

---

## 6. Other pixel-relevant details

- **Toasts**: BOTH systems mounted in App — shadcn radix `Toaster`
  (`useToast`/`toast` from `src/hooks/use-toast`, limit 1; used by Wallets,
  WalletProfile, VaultProfile, AgentProfile, AskMrRoboto, GVScratchpad) and
  `sonner` (used by Dashboard, Lobster, CommitForm, PendingReviewPanel).
- **Tooltips**: global `TooltipProvider` in App; Info-icon header tooltips
  (Agents), title-attr tooltips (List revenue), rich content tooltips
  (List3, Projects wallet breakdown).
- **Animations**: `animate-pulse` (loading text, last-viewed row highlight,
  terminal cursor), `animate-spin` (RefreshCw/Loader2), tailwindcss-animate
  for sheet/dialog transitions; `glow-cyan/glow-purple` static shadows.
- **Chart library**: recharts only — LineChart (PerformanceChart,
  ProjectProfile ChartCard) and AreaChart (VaultProfile yield). Everything
  else is hand-rolled SVG (Sparkline, RowSparkline).
- **Assets**: `public/` — favicon.ico, favicon.png, og-image.png,
  placeholder.svg, robots.txt (sitemap points at stale
  daitindex.lovable.app), sitemap.xml (stale openw3b.io URLs),
  2026_02_DeAI_Index.pdf (legacy). `src/assets/` — robotmoney-logo.svg
  (BrandHeader), openw3b-logo.png (unused). $ROBOTMONEY card hotlinks
  `assets.coingecko.com/coins/images/102172454/standard/robot.jpg`.
- **External link/exploration URLs** embedded in UI: basescan.org,
  etherscan.io, arbiscan.io, polygonscan.com, solscan.io, gnosisscan.io,
  x402scan.com, coingecko.com, dexscreener.com, x.com,
  base.blockscout.com (direct REST from browser).
- **State persistence**: sessionStorage — `admin_password`, `list:state`,
  `list:lastViewed`; localStorage — `projects-col-widths-v2`,
  `gv-scratchpad-session`, supabase auth.
- **Fonts everywhere**: virtually every label/value uses `font-mono`
  (JetBrains Mono); body copy Space Grotesk; the AgentProfile dossier
  header/value text deliberately switches to sans with negative tracking
  (`font-[500] tracking-[-0.04em]`) — a distinct look from every other page.
- **No pagination libraries/virtualization** anywhere; all tables render full
  result sets (List3 caps at 100; WalletProfile does manual show-more).
