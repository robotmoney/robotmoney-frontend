# R11 — Projects/agents directory vs v0's live Supabase (15.23–15.28)

Audit date 2026-08-03. v1 read at this worktree, branch
`adhoc/20260803-195547-r11-projects-supabase-audit` (base `main` @ `aa854ff`).
v0 read two ways: source at `/drive2/home/lucas/robotmoney/robotmoney-site`
(read-only checkout), and — new for this audit — **live, read-only queries
against v0's actual production Supabase project**
(`https://gmrwxwggtgtdyqpnqgvp.supabase.co`, anon key, GET-only, six tables:
`projects`, `lobster_coins`, `openclaw_agents`, `tracked_wallets`,
`agent_vaults`, `agent_revenue_daily`, `daily_coin_snapshots`). Raw pulls are
in `.audit-scratch/R11/` (untracked). Data snapshot taken 2026-08-03; `projects`
has 1,041 rows (1,037 `active`, 4 `merged`), `lobster_coins` 61,
`openclaw_agents` 1,493, `tracked_wallets` 793, `agent_vaults` 4,
`agent_revenue_daily` 439 (2026-04-20..2026-07-29), `daily_coin_snapshots`
11,744 (2025-11-20..2026-08-03).

This replaces the parity report's §3 Stage 15 rows 15.23–15.28 evidence class.
Previously all six were **UNVERIFIED** with the note "no baseline of any kind
exists" for this surface. That premise is gone: a real v0 baseline now exists
for every one of the six, drawn from production data, not a fixture.

---

## Verdict

**The port is materially more faithful than "UNVERIFIED" implied, with one
exception that is not a computation bug but a silently-changed business
constant, and one exception that is an intentionally-dropped field.**

- **15.25 (`data_coverage_score`) is now PROVEN-IDENTICAL for the parts that
  are checkable at all**, and the check is unusually strong: v1's
  `computeCoverage()` aggregation step —
  `round((breadth+identity+onchain+activity)/4)` — reproduces v0's own stored
  `data_coverage_score` **exactly, on all 995 live production rows that carry
  a score** (0 mismatches). The `breadth` and `identity` sub-formulas
  independently reproduce v0's stored `breadth_score`/`identity_score`
  exactly on the 758 rows where no field was edited after v0's own last
  recompute (0/758 mismatches each). `onchain`/`activity` are consistent but
  not provable to the same standard — see §3.
- **15.23/15.24 (market cap, FDV, MC/FDV%, 24h%, sparkline, wallet balance)**:
  the per-field arithmetic (sums, max-across-coins, sparkline source, MC/FDV%
  ratio) is **PROVEN-IDENTICAL on every live row it was possible to check**.
  But the **directory floor constant is silently different** — v0 gates at
  `data_coverage_score >= 45` (independently, in *two* live v0 surfaces);
  v1 hardcodes `MIN_SCORE = 55` while its own comment claims "**kept identical
  so parity holds**". On live data this is not a rounding footnote: **v0's
  gate admits 207 active projects; v1's gate would admit 28** — an 86% cut.
  **PROVEN-DIFFERENT.**
- **15.24 (MC/FDV%)** additionally diverges *by construction*: v0 ratios the
  lead coin's own market cap against its own FDV; v1 ratios the
  project-wide *max* market cap against the project-wide *max* FDV, which can
  come from two different coins. On live data only one project has 2+ active
  coins, and for that project the same coin happens to hold both maxima, so
  the two formulas currently agree (58.907% both ways). **PROVEN-DIFFERENT-DORMANT.**
  The same is true of the "24h %" cell: v0 shows the lead coin's own change;
  v1 shows the *largest-magnitude* change across all the project's coins.
  Also currently dormant on the same project, same reason.
- **15.26 (revenue 30d)** stays **PROVEN-DIFFERENT** per the original report
  (removed from v1's DTO, issue #346) — now with real numbers: of v0's 207
  in-scope (≥45) projects, only **3** have *any* positive trailing-30d
  revenue as of 2026-08-03 (largest: $0.35), because revenue ingestion in
  this v0 snapshot stopped in late July. Historically (Apr–Jul 2026) revenue
  was real and non-trivial — $116,665.61 all-time across 130 agents, up to
  $29,165 for a single agent — but concentrated almost entirely in projects
  scoring **below both** v0's 45 floor and v1's 55 floor. v1's stated reason
  for dropping the field ("no persisted, non-fabricated revenue source covers
  the whole directory") is corroborated by the live data, not just plausible.
- **15.28 (x402 score/txns/volume/buyers/resources)**: score, txn count,
  volume, and resource count are column-identical between the two schemas and
  match up conceptually 1:1. **`x402_buyers` is real, live, and non-trivial in
  v0** (e.g. Coinbase x402 Facilitator: 515 buyers, 61,580 txns, $664.91
  volume) **and has no column anywhere in v1's schema** — v1's own source
  already documents this as a deliberate, honestly-omitted gap, and this
  audit confirms the omitted data is real, not speculative. **PROVEN-DIFFERENT.**
- **Join key (task item 4): there is none, and this matters as much as any
  single numeric result.** v1 has never ingested v0's real roster. Its "live"
  data source's `discoverProjects()` returns a 4-row synthetic fixture
  (`backend/src/projects/fixtures/dataset.ts`) modeled loosely, by *name*
  only, on three real v0 entities (Virtuals Protocol, aixbt, Coinbase x402
  Facilitator) but with fabricated slugs, UUIDs, and wallet/vault addresses
  that share nothing with v0's real rows (v0: `virtuals-protocol-9241b6`,
  `aixbt-c5d6b3`, `coinbase-x402-facilitator-94fcf5`, each with a
  slugify+random-hex suffix; v1 fixture: `virtuals-protocol`, `aixbt`,
  `coinbase-x402-facilitator`, no suffix, `0x...` placeholder addresses).
  Every comparison in this report is therefore done at the **formula level**
  — v1's ported computation re-run against v0's real raw columns — not by
  matching entity rows, because no entity-row match is possible today.

### Scoreboard (this report's six items)

| # | Family | Evidence class (was → now) |
|---|---|---|
| 15.23 | Projects table (mcap/FDV/24h/sparkline/wallet) | UNVERIFIED → **PROVEN-IDENTICAL (arithmetic)** + **PROVEN-DIFFERENT (directory floor 45 vs 55)** |
| 15.24 | MC/FDV % (+ 24h % cell) | UNVERIFIED → **PROVEN-DIFFERENT-DORMANT** (different formula by construction, same result on live data today) |
| 15.25 | `data_coverage_score` | UNVERIFIED → **PROVEN-IDENTICAL** (aggregation, breadth, identity) / **UNVERIFIED, but bounded and consistent** (onchain, activity) |
| 15.26 | Revenue 30d on the directory | PROVEN-DIFFERENT (unchanged, now quantified with live numbers) |
| 15.28 | x402 score/txns/vol/buyers/resources | UNVERIFIED → **PROVEN-IDENTICAL** (score/txns/vol/resources) + **PROVEN-DIFFERENT** (buyers — no v1 column) |

15.27 (dashboard overview) was **not** re-scoped for this audit — out of the
task's stated boundary (it targets `/list`+`/dashboards`, a different surface
from the six in-scope tables' `/projects`+`/agents` read path) — and remains
UNVERIFIED.

---

## 0. Method

Per item, the same two-step procedure: (a) read v1's exact computation
(`backend/src/projects/projections.ts`, `transforms.ts`,
`entities-projections.ts`, `access/data-source.ts`, plus
`agents-projections.ts`/`leaderboard-projections.ts` for the relocated
revenue/x402 surfaces, plus the frontend's
`frontend/public/assets/js/app/alpine/views/projects.js` for the two
client-derived fields the report flagged); (b) read v0's exact computation
(`analytics/src/pages/display/Projects.tsx`, cross-checked against the
second, independent Next.js implementation at
`src/app/display/projects/page.tsx`, which queries the identical Supabase
REST endpoints with an identical `MIN_COVERAGE_SCORE = 45`); then re-run
v1's formula, in Python, over the *actual* rows pulled live from v0's
Supabase, and diff against v0's own displayed/stored values.

No row was inserted, updated, or deleted. No RPC was invoked. Two orientation
probes were read-only and inconclusive by design (see §2): `GET
/rest/v1/rpc/compute_project_coverage` (and 6 other guessed names/signatures)
all returned PostgREST's `PGRST202` "no matches" — this does not execute
anything, PostgREST only resolves the function name before it would run one,
and GET is restricted by PostgREST to `STABLE`/`IMMUTABLE` functions in the
first place, so this path could never have caused a write even if a match had
been found. The OpenAPI introspection root (`GET /rest/v1/` with an
`Accept: application/openapi+json` header) was also tried for orientation, as
explicitly permitted; it 401'd with `"Only the service_role API key can be
used for this endpoint"` — this v0 project has that surface locked down, so
no function/table catalog was recoverable via the anon key. Table access
itself worked normally throughout.

---

## 1. 15.23 — Projects table (market cap, FDV, 24h %, sparkline, wallet balance)

**v1**: `backend/src/projects/projections.ts:77-301` (`fetchProjects`).
Directory floor `MIN_SCORE = 55` (line 21). Per project: `maxMarketCap` /
`maxFdv` = `Math.max` across the project's active `lobster_coins` rows
(lines 231-232); `walletTotalUsd` = sum of active `tracked_wallets.balance_usd`
(line 234); sparkline = `daily_coin_snapshots.price_usd`, trailing 30d, for
the *primary* coin, chosen by `selectPrimaryCoinId` (line 64-72: highest
`market_cap`, UUID tie-break); `volume24h` = max across coins' `volume_24h`.

**v0**: `analytics/src/pages/display/Projects.tsx:55,116-121,194-239`
(and the independent second implementation,
`src/app/display/projects/page.tsx:16,45-129`, same query shape, same
constant). Directory floor `MIN_COVERAGE_SCORE = 45` — **both v0
implementations agree on 45**, hardcoded identically in each file. Per
project: `walletBalance` = sum of active wallets' `balance_usd` (line 234,
matches v1 exactly); `topMarketCap`/lead coin FDV = the coin with the highest
`market_cap` after a client-side sort (line 195-197, no explicit tie-break —
see 15.24); sparkline = `daily_coin_snapshots` for that same lead coin,
trailing 30d (line 221), matching v1's primary-coin selection rule in every
case observed live (below).

**Live check.** v0's directory floor (`status='active' AND
data_coverage_score >= 45`) currently admits **207** projects. v1's
hardcoded floor (`>= 55`) would admit **28** of those same 207 — a 179-row,
86% reduction, entirely from the floor constant, not from any facet-join
logic. v1's own comment at `projections.ts:19-21` reads: *"Directory floor:
only projects in the top coverage tier are listed (matches the source
MIN_SCORE gate). Kept identical so parity holds across the port."* That
claim is false against the actual, currently-running v0 sources — it was
apparently never checked against them. **PROVEN-DIFFERENT.**

For the 28 projects that *do* clear v1's stricter floor, every arithmetic
field re-run against live data matched v0's formula with **zero**
divergences: `maxMarketCap`/`v0` lead-coin market cap agreed on all 28 (only
one project, `diem-venice-ai-74b155`, has 2+ active coins, so 27/28 are
single-coin and trivially identical; see 15.24 for the multi-coin case);
`walletTotalUsd` sums agreed on all 28 (e.g. `bankr-agent-614b56`: $4,773.33
across its active wallets; `woon-4bac8b`: $36,473.51). Primary-coin selection
(for the sparkline) agreed on all 28 — no tie was ever observed live (v0's
undefined tie-break and v1's UUID tie-break are architecturally different but
never armed in this dataset).

**Verdict: PROVEN-IDENTICAL for every arithmetic operation checked (sums,
maxima, primary-coin selection) + PROVEN-DIFFERENT for the directory floor
constant (45 vs 55, live-measured 86% row-count impact).**

---

## 2. 15.24 — MC/FDV % (and the adjacent 24h % cell)

**v1**: not computed server-side. `frontend/public/assets/js/app/alpine/views/projects.js:178-179`:

```js
mcFdvPct(p) {
  return p.maxFdv > 0 && p.maxMarketCap > 0 ? ((p.maxMarketCap / p.maxFdv) * 100).toFixed(1) + "%" : "—";
}
```

i.e. `maxMarketCap / maxFdv`, both **already maxed independently across the
project's coins** by the backend (§1). The adjacent 24h % cell
(`_enrich`, lines 118-127) is `maxPct` — the coin with the *largest-magnitude*
`percentChange24h` across the project's coins, signed.

**v0**: `analytics/src/pages/display/Projects.tsx:206-208`:

```ts
const mcFdv = leadCoin && leadCoin.marketCap && leadCoin.fdv
  ? (Number(leadCoin.marketCap) / Number(leadCoin.fdv)) * 100
  : null;
```

— the **lead coin's own** market cap over its **own** FDV (same coin, both
sides of the ratio). The 24h % column (lines 436-454) renders **every**
coin's own change stacked per-row (not aggregated), and the `change24h` sort
key (line 259) uses `leadCoin?.change24h` — the lead coin's own change, not a
max-magnitude scan across coins.

**These are different formulas by construction** whenever a project has 2+
active coins and the coin with the highest market cap is not also the coin
with the highest FDV (for MC/FDV%) or not also the biggest 24h mover (for the
24h cell). Live data has exactly one project meeting the "2+ active coins"
precondition at all: `diem-venice-ai-74b155` (DIEM: mc $51,570,923, fdv
$51,570,923, 24h +3.97%; VVV: mc $586,702,422, fdv $995,981,002, 24h
+5.5098%). VVV is simultaneously the lead coin (highest MC), the highest-FDV
coin, and the biggest mover, so **both formulas currently produce the
identical result** — MC/FDV% = 58.906989…% either way; 24h% = +5.5098% either
way.

**Verdict: PROVEN-DIFFERENT-DORMANT.** The two formulas are structurally
different and would diverge the moment a multi-coin project's largest-cap
coin is not also its highest-FDV or biggest-moving coin — currently
impossible to observe because only one qualifying project exists in v0's
live data and it happens not to arm the condition.

---

## 3. 15.25 — `data_coverage_score`

**Does v0's own frontend call an RPC?** No. Grepped the entire
`robotmoney-site` repo (`analytics/` and `src/app/`) for `.rpc(` — zero hits.
Both v0 page implementations read `data_coverage_score` as a **plain stored
column**, already computed, off the `projects` row (`Projects.tsx:118`,
`page.tsx:50-51`). The parity report's speculation that it might be a
Postgres RPC named `compute_project_coverage()` could not be confirmed *or*
refuted by source inspection: that name (and 6 plausible variants, with and
without common parameter names) is **not exposed to the anon role** via
PostgREST (`PGRST202` on every attempt — see §0), and the OpenAPI
introspection endpoint that would enumerate every exposed function is
blocked for non-`service_role` keys on this project. Grepping v0's own
`analytics/supabase/migrations/*.sql` (33 files) and
`analytics/supabase/functions/*` for `compute_project_coverage`,
`data_coverage_score`, or any of the four sub-score column names: **zero
hits anywhere in the repo.** The `projects` table itself, and whatever
computes its coverage columns, exist entirely outside this checkout — either
authored directly against the live database (never migrated to a checked-in
file) or in a repo not available here. `analytics/supabase/migrations/
20260324005334_cron_discover_agents.sql` schedules three cron jobs
(`discover-agents-daily`, `refresh-wallet-balances-hourly`,
`market-data-refresh`) — none of them coverage scoring — so the mechanism
that recomputes coverage is not even among v0's own scheduled jobs as far as
this repo's migrations show.

**What live data *does* prove.** v0's `projects` table carries four sub-score
columns — `breadth_score`, `identity_score`, `onchain_score`,
`activity_score` — plus `coverage_calculated_at` and `resolved_at`. This
alone confirms v1's migration comment
(`backend/migrations/0014_projects_pipelines.sql:56-57`, *"mirror the columns
the legacy `compute_project_coverage()` ... wrote"*) got the **shape** right,
whatever the underlying mechanism is called. v1's ported formula,
`computeCoverage()` in `backend/src/projects/transforms.ts:226-281`, was
re-run in Python against v0's live raw columns and checked against v0's own
*stored* sub-scores and final score:

| Sub-formula | Rows checked | Mismatches | Note |
|---|---:|---:|---|
| **Aggregation** `round((breadth+identity+onchain+activity)/4)` | **995** (every row with all 4 sub-scores + final score present) | **0** | Exact on the full live table, no staleness filtering needed — the inputs are v0's own already-frozen sub-scores. |
| **Breadth** `(has_agent+has_coin+has_wallet+has_vault)×25` | 758 (rows with no project-row edit since `coverage_calculated_at` — see caveat below) | **0** | 2/995 mismatches on the *unfiltered* full set, both explained by `has_*` flags changing after the last coverage recompute. |
| **Identity** (5 × 20-point fields, capped at 100) | 758 (same clean set) | **0** | 24/995 mismatches on the unfiltered set, all in the direction "current data has MORE identity fields filled than the stored score reflects" — confirmed on one example (`autonomopoly-1a5ade`): `coverage_calculated_at` = 2026-06-04, `resolved_at`/`updated_at` = 2026-08-02 — the identity fields were resolved **two months after** the score was last computed. This is v0's *own* staleness, not a v1 porting defect. |
| **Onchain** (coin/wallet/vault sub-terms, 0-100 each, integer-averaged) | 758 | 649/758 within a computed bound (85.6%); 181/758 exact | Bounded because two of v0's three "≥7-day-history" flags (`daily_agent_snapshots`, `daily_wallet_snapshots`) are explicitly **out of this audit's 6-table scope** and were never queried; `coin7` (from the in-scope `daily_coin_snapshots`) was used directly, the other two were tried both `true` and `false`. The 109 rows outside even that bound are large gaps (e.g. computed range 70-100, stored 0) consistent with **facet-row-level** staleness (an individual wallet's `balance_usd`/`last_tx_at` refreshing more often than the project's own coverage recompute) that the project-row-level "clean" filter cannot detect — `tracked_wallets`/`lobster_coins`/`agent_vaults` refresh on independent hourly/6h cycles (`projections.ts:35-38`) while coverage recomputes on its own, evidently much slower, cadence. |
| **Activity** | 758 | 756/758 within bound (99.7%); 2/758 exact | Same two-flag ambiguity as onchain; only 2 residual failures, both a stored value 15-25 points below the computed range. |

**Verdict.** The **aggregation formula is PROVEN-IDENTICAL** — the strongest
and cleanest result in this report, because it needed no facet-freshness
assumptions at all: it is pure arithmetic over four numbers v0 itself already
froze. **Breadth and identity are PROVEN-IDENTICAL** on the subset where
staleness can be ruled out at the project-row level, and the visible
mismatches outside that subset are fully explained by v0's own staleness
(not a formula difference) with a concrete, dated example. **Onchain and
activity remain UNVERIFIED but bounded and directionally consistent** — the
6-table scope restriction (no `daily_agent_snapshots`/`daily_wallet_snapshots`
access) and facet-row-level refresh cadences that outrun the project-level
staleness proxy mean this audit cannot push them to PROVEN-IDENTICAL without
either widening scope or getting `coverage_calculated_at`-synchronized facet
history, which the six approved tables don't carry.

**What v0's own source code cannot settle, that this audit also cannot
settle:** whether the underlying mechanism is literally a Postgres function
named `compute_project_coverage()`, an Edge Function, or something else —
the anon key that read every other result in this report cannot see it, and
it is not checked into the source repo either. Call this **UNTESTABLE-DATA-ACCESS**
for the *identity* of the mechanism specifically (not for its output, which
is now proven).

---

## 4. 15.26 — Revenue 30d on the projects directory

Unchanged verdict from the original report — **PROVEN-DIFFERENT**, intentional
(issue #346, `projections.ts:10-15,184-186`; DTO comment
`contract/src/projects.d.ts:62-65`) — now quantified against live v0 data
instead of asserted from the port's own commit message.

**v0's live formula** (`Projects.tsx:218`): sum `agent_revenue_daily.revenue_usd`
for the project's active agents, `revenue_date >= now-30d`. Run against live
data as of 2026-08-03 (cutoff `2026-07-04`) over v0's own 207-project (≥45)
directory: **3 of 207** projects have any positive trailing-30d revenue at
all (`sfg-engine-96883c`: $0.35, `unicorn-meme-e42ae3`: $0.01,
`cicada-x-891911`: $0.003) — because `agent_revenue_daily`'s most recent row
in this snapshot is dated 2026-07-29, and ingestion has evidently gone quiet
since. Widening to *all-time* (no 30d window): 130 of 1,493 agents (8.7%)
have ever posted a revenue row at all, $116,665.61 combined, with real,
material single-agent totals as recently as this spring (XMAQUINA
$29,165.24, basecn $17,660.84, DEPLOYED $14,441.63) — but every one of those
top agents belongs to a project scoring **below both** v0's 45 floor (38,
51, 48) and, a fortiori, v1's 55 floor.

This corroborates v1's stated rationale for dropping the field
("no persisted, non-fabricated revenue source covers the whole directory,
only a subset of Virtuals-protocol agents") with live numbers: even on v0's
*own* side, revenue coverage across the *displayed* directory is close to
zero today, and was concentrated in projects that neither directory would
show anyway. v1's `/agents` (`agents-projections.ts:104-217`) and leaderboard
(`leaderboard-projections.ts:97-264`) both still compute a 30d revenue figure
**per agent** (`rev30ByAgent`/`revenue30ByAgent`, identical `revenue_date >=
cutoff` window logic to v0's), so the relocation, not a removal, claim in the
report's original note holds up.

---

## 5. 15.28 — x402 score / txns / volume / buyers / resources; productivity score

**Schema comparison** (v0 `openclaw_agents` columns, live; v1
`backend/migrations/0013_projects.sql:45-47` +
`0014_projects_pipelines.sql:29-34`):

| Metric | v0 column | v1 column | Match |
|---|---|---|---|
| x402 score | `x402_score` | `x402_score` | identical name/type |
| x402 txn count | `x402_txn_count` | `x402_txn_count` | identical |
| x402 volume | `x402_volume_usd` | `x402_volume_usd` | identical |
| x402 resources | `x402_resources_count` | `x402_resources_count` | identical |
| **x402 buyers** | **`x402_buyers`** | **no column** | **missing in v1** |
| productivity score | `productivity_score` | `productivity_score` | identical |

**Live buyers data is real, not incidental.** All 1,493 v0 agents carry a
non-null `x402_buyers` (default 0); **26** have a positive value, e.g.
Coinbase x402 Facilitator: 515 buyers, 61,580 txns, $664.91 volume, 0
resources, x402_score 0; RelAI: 890 buyers, 4,280 txns, $312.50 volume,
score 9.45; Canza: 2,640 buyers, 0 txns, score 2,642. v1's own source
(`backend/src/projects/agent-detail-projections.ts:19-23`) already documents
this precisely and honestly: *"x402 'unique buyers' (no column — x402_resources_count
is the only x402 dimension beyond txns/volume/score)"* and, separately,
`contract/src/projects.d.ts:112-113`: *"no column anywhere in this schema
counts distinct buyers or token holders."* This audit's contribution is
confirming that gap against **real, live, non-trivial v0 data** rather than
taking the port's own comment at face value — the 26 nonzero rows prove
`x402_buyers` is an actively-tracked v0 metric, not a vestigial or
always-empty legacy column.

**The x402 classification flag itself** — `protocol_standard === 'x402' OR
score>0 OR txn_count>0 OR resources_count>0` (v1, `projections.ts:167-171`)
vs `(protocol_standard||'').toLowerCase() === 'x402' OR ...` (v0,
`Projects.tsx:211-217`, case-*insensitive*) — is a narrow, second
by-construction difference: v0 lower-cases before comparing, v1 does not.
Live `protocol_standard` values (1,493 rows): `virtuals` (1,097), `x402`
(217), `acp` (126), `mcp` (16), `zhc` (14), `facilitator` (12),
`zhcs_infra` (4), `paywall` (3), `custom` (2), `bittensor` (1),
`agent_wallet` (1) — every `x402` row is already lowercase, so this is
**PROVEN-DIFFERENT-DORMANT**, not currently armed.

**Verdict: PROVEN-IDENTICAL** for score/txns/volume/resources/productivity
(same column names, same values, same aggregation shape — v1's per-project
`x402ByProject` set-membership test and v0's `hasX402` reduce produce the
same result on every live row checked) **+ PROVEN-DIFFERENT** for buyers (real
data in v0, no column in v1) **+ PROVEN-DIFFERENT-DORMANT** for the
case-sensitivity of the protocol-standard string match.

---

## 6. Join key (task item 4)

There is no reliable join key between v0's live Supabase rows and v1's
project identifiers, and there cannot be one without new work, because v1
has never ingested v0's data:

- v1's `liveProjectsDataSource.discoverProjects()`
  (`backend/src/projects/access/live-source.ts:75-77`) returns
  `structuredClone(DISCOVERY_DATASET)` — the **same hermetic fixture** the
  test-only `fixtureProjectsDataSource` serves, regardless of whether
  `PROJECTS_SOURCE=live` is set. Only the *market* numbers (CoinGecko/
  DexScreener calls) go live; project *identity* never does.
- `DISCOVERY_DATASET` (`backend/src/projects/fixtures/dataset.ts:16-123`) is
  a 4-project synthetic roster: `virtuals-protocol`, `aixbt`,
  `coinbase-x402-facilitator`, `tokenless-no-activity`. Three of the four
  names echo real, well-known v0 entities, but every identifying field is
  fabricated: addresses like `0xwallet0000000000000000000000000000000aaa`
  and `0xvirt00000000000000000000000000000000game`, and slugs with no
  suffix.
- v0's real, live rows for the same three concepts are
  `virtuals-protocol-9241b6` (score 41), `aixbt-c5d6b3` (score 68), and
  `coinbase-x402-facilitator-94fcf5` (score 58) — different slugs (v0
  appends a random 6-hex discovery suffix that v1's fixture never
  reproduces), different UUIDs (Supabase-generated vs
  `gen_random_uuid()`-at-insert-time in a from-scratch local Postgres, with
  no shared seed), and none of v1's fabricated coin/wallet/vault addresses
  match any real v0 on-chain identifier.
- `backend/src/projects/smoke-seed.ts:1-21` is a **third**, independent,
  smoke-only synthetic dataset ("concepts... ported from the deprecated
  Supabase seed-data function... synthesized here with realistic
  market_cap/fdv/24h numbers") — explicitly *not* real data, gated behind
  `DEMO_SEED_PROJECTS`.
- No migration, script, or crosswalk table anywhere in this repo references
  v0's real project UUIDs, slugs, or the Supabase project ref
  `gmrwxwggtgtdyqpnqgvp`.

**Conclusion for item 4: no entity-level match is possible today.** Every
comparison in §§1-5 above was necessarily done by re-running v1's *formula*
against v0's *real raw data*, not by matching rows — which is the only form
of comparison available until v1 either ingests v0's roster or a slug/UUID
crosswalk is built. That gap is itself worth surfacing to the owner
independent of any individual metric's parity: **v1's directory, agents
page, and leaderboard have never been exercised against real production
scale (1,041 projects / 1,493 agents / 793 wallets) — only against a 4-project
fixture** — so nothing in this codebase's own test suite would catch a
performance, pagination, or edge-case regression that only appears at v0's
actual scale.

---

## 7. What this audit did not, and could not, determine

- **The literal identity of v0's coverage-computation mechanism** (RPC name,
  Edge Function, trigger) — UNTESTABLE-DATA-ACCESS, per §3. Its *output* is
  proven identical for aggregation/breadth/identity; its *source* is not
  recoverable via the anon key or this repo's checked-in migrations.
- **Onchain/activity sub-score exactness** — bounded to 85.6%/99.7% exact
  agreement within a two-flag ambiguity window, not proven to 100%, because
  `daily_agent_snapshots` and `daily_wallet_snapshots` are outside this
  audit's approved 6-table scope and facet-row-level refresh timestamps
  (not just the project row's) would be needed to fully rule out staleness.
- **15.27** (dashboard overview / `/list` + `/dashboards` surface) — outside
  this audit's declared scope (six tables backing `/projects` + `/agents`),
  left UNVERIFIED as before.
- **Whether v1's directory floor of 55 was a deliberate policy change or an
  unreviewed typo** — this audit can only prove the values differ (45 vs 55)
  and that v1's own comment asserts equivalence that does not hold; the
  *intent* behind the change is a question for the owner/issue history, not
  something derivable from the data.
