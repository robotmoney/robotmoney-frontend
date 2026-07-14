# Live-data contract — 4 new dashboard endpoints

Foundation contract for removing the last baked-in data from `/allocation`
(buyback table, token metrics, per-wallet sleeves, strategy/bucket target
weights). The parallel implementation workers build against **this** document so
the DTOs, provenance fields, modules, tables, and preview goldens are consistent
with the existing live dashboards (`vault-economics`, `wallet-balances`).

Everything here follows the **issue #50 honesty contract** already enforced by
`chain/vault-economics.ts` + `chain/wallet-balances.ts`:

- Every DTO carries provenance: `source` (`"live" | "stub"`) and either
  `stale: boolean` or a per-row `provenance` (`"live" | "stub" | "stale" |
  "seed"`), mirroring the existing dashboards.
- A value is **never fabricated**. A failed live read degrades to the
  last-persisted (`stale`) or seeded (`seed`) value with an explicit label, or
  to `null` — never a live-looking `$0`.
- Unconfigured / placeholder addresses (`config.isPlaceholderAddress`) are
  **never** `eth_call`ed.
- Resolvers (`resolveBaseRpcSource`, `resolvePriceSource`, …) are read **per
  request**, not at module load, so tests can flip env per case and provenance
  always tracks the current source.

Shared conventions (identical to `wallet-balances`):
- `asOf`: ISO-8601 timestamp of the read (`new Date(now).toISOString()`).
- `source`: `resolveBaseRpcSource()` result — `"live"` in prod/demo, `"stub"`
  in the hermetic CI/demo layer (`BASE_RPC_SOURCE=stub`).
- Short-TTL in-process cache (`CACHE_TTL_MS = 30_000`) + a
  `_reset<Name>CacheForTests()` export, matching the existing modules.
- Handlers are thin adapters in `backend/src/api/routes/dashboards.ts` that just
  call the chain/db module (no query or DTO logic in the handler).

## Config the implementers consume (already shipped by this worker in `config.ts`)

| Getter | Returns | Real default (Base) |
|---|---|---|
| `resolveRobotmoneyToken(env)` | `string` | `0x65021a79aeef22b17cdc1b768f5e79a8618beba3` |
| `resolveWeth(env)` | `{ address, poolId }` | `0x4200…0006` |
| `resolvePropWallets(env)` | `string[]` (primary first) | `0xfbc2…c9d6`, `0x422c…8eee`, `0x8d0c…9442` |
| `resolveBuybackConfig(env)` | `{ primaryWallet, robotmoneyToken, wethToken, source }` | primary = `0xfbc2…c9d6` |
| `resolveTrackedAssets(env)` | `TrackedAsset[]` | ZYFAI-SS1 `0xc125…976d`, GIZA-SS1 `0x8e5c…8795` |
| `resolveVaultAdapters(env)` | `VaultAdapterConfig[]` (`configured:true` for real addr) | Morpho `0xa6ed…17e9`, Aave `0x2186…0bea`, Compound `0x8247…2652` |
| `isPlaceholderAddress(a)` | `boolean` | true for `0x1111…`/`0x7777…` etc. |
| `config.robotmoney`, `config.weth`, `config.propWallets`, `config.buyback` | load-time snapshots | — |

RPC client (shipped this worker): `chain/base-rpc-client.ts` now exports
`ethGetLogs(params, opts): Promise<EthLog[]>` (JSON-RPC `eth_getLogs`) with the
same throw-on-failure discipline as `ethCall` / `ethGetBalance`, plus the
existing `callBalanceOf` / `callTotalSupply` / `callConvertToAssets`.

---

## 1. Token buybacks — `GET /api/dashboards/buybacks`

- **Method**: GET (no query params).
- **Module/function**: `backend/src/chain/buyback-logs.ts` → `getBuybacks()`.
- **Source of truth**: robotmoney-site `wallet.ts::fetchBuybackTransactions` —
  Basescan/`eth_getLogs` of ROBOTMONEY `Transfer` events **into** the primary
  prop wallet (`config.buyback.primaryWallet`). WETH-spent / USD legs join the
  swap input. `config.buyback.source` drives live-vs-stub.
- **Postgres**: NEW table `buyback_swaps` (see migration note below) — the
  durable store. Live path reads `eth_getLogs`; on RPC failure degrade to the
  persisted rows marked `stale`; the historical 10-row set (all 2026-03-23,
  total `1.149114 WETH` / `$2,504.31` / `178.82M ROBOTMONEY`, real BaseScan tx
  hashes) is the `seed` provenance backfill (replaces `allocation.html:383-403`).

**DTO**
```ts
interface BuybackRow {
  date: string;              // ISO calendar day, e.g. "2026-03-23"
  txHash: string;            // 0x… Base tx hash (links to basescan.org/tx/…)
  wethSpent: number;         // WETH amount, 18dp normalized (e.g. 0.116534)
  valueUsd: number;          // USD value of the WETH spent (e.g. 253.97)
  robotmoneyReceived: number;// ROBOTMONEY tokens received (raw count, e.g. 18450000)
  provenance: "live" | "stub" | "stale" | "seed";
}
interface Buybacks {
  asOf: string;              // ISO timestamp
  source: "live" | "stub";
  stale: boolean;            // true if ANY row degraded to persisted/seed
  rows: BuybackRow[];        // newest-first
  totals: {
    wethSpent: number;       // 1.149114
    valueUsd: number;        // 2504.31
    robotmoneyReceived: number; // 178820000
  };
}
```

**Preview golden** (`goldens/api-goldens.json` → `routes["/api/dashboards/buybacks"]`):
```json
{
  "asOf": "2026-07-09T12:04:40.696Z",
  "source": "stub",
  "stale": false,
  "rows": [
    { "date": "2026-03-23", "txHash": "0xa19a086682db8ff57a94e8f594bb542c8e4ba1d8f79bf7ad48717be0587ffa37", "wethSpent": 0.116534, "valueUsd": 253.97, "robotmoneyReceived": 18450000, "provenance": "seed" },
    { "date": "2026-03-23", "txHash": "0x9ce840624ce3742bca40f6b672587dfa1ad85ac40476ecb7cb71938a170319bc", "wethSpent": 0.11591,  "valueUsd": 252.61, "robotmoneyReceived": 17810000, "provenance": "seed" },
    { "date": "2026-03-23", "txHash": "0x8dc090ca0ec59882d541dffd52adbe64adbdba4166dd63a230722d2ea0b29266", "wethSpent": 0.11591,  "valueUsd": 252.61, "robotmoneyReceived": 17770000, "provenance": "seed" },
    { "date": "2026-03-23", "txHash": "0x1e09868aa284f8a969f7a85a11758e896b786f5f78daf8b503274b2828209361", "wethSpent": 0.114375, "valueUsd": 249.26, "robotmoneyReceived": 18170000, "provenance": "seed" },
    { "date": "2026-03-23", "txHash": "0x79594aaa2a4b39bdcbc19ba9f39834963d0f00599b4437e17a517503f996450f", "wethSpent": 0.114375, "valueUsd": 249.26, "robotmoneyReceived": 18140000, "provenance": "seed" },
    { "date": "2026-03-23", "txHash": "0x9364ec11ec2543438b2c1efaee79aad6ecc2ef42606ca9efa9f8378ac4837eac", "wethSpent": 0.115006, "valueUsd": 250.64, "robotmoneyReceived": 18200000, "provenance": "seed" },
    { "date": "2026-03-23", "txHash": "0xd63e11167880ef5ca9d7dfeb2e361b355e93aa01317ccb9ab5bdf5918168eb74", "wethSpent": 0.114251, "valueUsd": 248.99, "robotmoneyReceived": 18040000, "provenance": "seed" },
    { "date": "2026-03-23", "txHash": "0xe6d8138395fb5815157cf1197570dd26c10f4fd3c3792e08fa9f38956811ec33", "wethSpent": 0.114251, "valueUsd": 248.99, "robotmoneyReceived": 17460000, "provenance": "seed" },
    { "date": "2026-03-23", "txHash": "0x81cf52a3f723c48a65c67999b5b4417a67b67687125aec29ba255246a6eba39f", "wethSpent": 0.114251, "valueUsd": 248.99, "robotmoneyReceived": 17430000, "provenance": "seed" },
    { "date": "2026-03-23", "txHash": "0x3c9718e37624c0de8b5e295b3e8a9cf5dc98dcd0d08cbad395551c2ce6f8eab9", "wethSpent": 0.114251, "valueUsd": 248.99, "robotmoneyReceived": 17370000, "provenance": "seed" }
  ],
  "totals": { "wethSpent": 1.149114, "valueUsd": 2504.31, "robotmoneyReceived": 178820000 }
}
```

---

## 2. Token metrics — `GET /api/dashboards/token-metrics`

- **Method**: GET (no query params).
- **Module/function**: `backend/src/chain/token-metrics.ts` → `getTokenMetrics()`.
- **Source of truth**: `config.robotmoney` — `totalSupply` via
  `callTotalSupply` (18dp), `priceUsd` via `fetchAssetPriceUsd` (GeckoTerminal,
  `resolvePriceSource()`), `marketCapUsd = totalSupply * priceUsd`. `feeSplit`
  is a fixed Clanker-pool config constant (Protocol 57 / Bankr 40 / Clanker 3);
  it is `managed`/static, not a chain read — label its `source` accordingly but
  keep it in the DTO so the frontend stops baking it.
- **Postgres**: none required for the live read; may reuse
  `vault_share_price_history`-style persistence if a `stale` fallback is added
  (optional — otherwise degrade price/supply legs to `null`).
- **Degrade**: a failed supply or price leg → that field `null` +
  `stale: true`; never a fabricated price.

**DTO**
```ts
interface TokenMetrics {
  robotmoney: {
    priceUsd: number | null;     // e.g. 0.00000451
    totalSupply: number | null;  // token count, 18dp normalized (e.g. 5.5e10)
    marketCapUsd: number | null; // priceUsd * totalSupply
  };
  feeSplit: { label: string; pct: number }[]; // fixed Clanker pool config
  asOf: string;
  source: "live" | "stub";
  stale: boolean;
}
```

**Preview golden** (`routes["/api/dashboards/token-metrics"]`):
```json
{
  "robotmoney": { "priceUsd": 0.00000451, "totalSupply": 55000000000, "marketCapUsd": 248050 },
  "feeSplit": [
    { "label": "Protocol", "pct": 57 },
    { "label": "Bankr", "pct": 40 },
    { "label": "Clanker", "pct": 3 }
  ],
  "asOf": "2026-07-09T12:04:40.696Z",
  "source": "stub",
  "stale": false
}
```

---

## 3. Wallet sleeves — `GET /api/dashboards/wallet-sleeves`

- **Method**: GET (no query params).
- **Module/function**: `backend/src/chain/wallet-sleeves.ts` → `getWalletSleeves()`.
- **Source of truth**: per-prop-wallet on-chain reads (`config.propWallets`).
  This is the **per-wallet breakdown** the aggregate `wallet-balances` endpoint
  does NOT provide: `wallet_balance_samples` has **no wallet dimension**
  (`UNIQUE (sample_date, symbol)` only), so wallet-sleeves MUST do fresh
  per-wallet `callBalanceOf` / `ethGetBalance` reads — it cannot be derived from
  that table. Names/types come from the prop-wallet metadata:
  - `0xfbc2…c9d6` — "Bankr" / primary
  - `0x422c…8eee` — "Stablecoin Strategy 1" (delegated ZyfAI, ZYFAI-SS1)
  - `0x8d0c…9442` — "Stablecoin Strategy 2" (delegated Giza, GIZA-SS1)
- **Reuse**: value each holding with the same `resolveTrackedAssets` valuation
  kinds + `fetchAssetPriceUsd` as `wallet-balances.ts::valueAsset`, but keyed
  per wallet (do **not** `sumOverWallets`). Per-holding provenance mirrors #50.
- **Postgres**: none authoritative (no per-wallet table). Optional per-wallet
  degrade store is out of scope; a failed leg → holding value `null` +
  provenance `"stale"`.

**DTO**
```ts
interface SleeveHolding {
  symbol: string;
  amount: number | null;
  priceUsd: number | null;
  valueUsd: number | null;
  provenance: "live" | "stub" | "stale" | "seed";
}
interface WalletSleeve {
  name: string;      // "Bankr" | "Stablecoin Strategy 1" | …
  address: string;   // 0x… (lowercased)
  type: string;      // "primary" | "strategy"
  totalUsd: number;  // sum of holdings[].valueUsd (nulls as 0)
  holdings: SleeveHolding[];
}
interface WalletSleeves {
  wallets: WalletSleeve[];
  asOf: string;
  source: "live" | "stub";
}
```

**Preview golden** (`routes["/api/dashboards/wallet-sleeves"]`):
```json
{
  "wallets": [
    { "name": "Bankr", "address": "0xfbc2cc30f0674ed0244ee1f0ba7864423230c9d6", "type": "primary", "totalUsd": 38331,
      "holdings": [
        { "symbol": "USDC", "amount": 9037.405, "priceUsd": 0.9983, "valueUsd": 9022, "provenance": "stub" },
        { "symbol": "ROBOTMONEY", "amount": 6499610000, "priceUsd": 0.00000451, "valueUsd": 29300, "provenance": "stub" },
        { "symbol": "BNKR", "amount": 25081.3083, "priceUsd": 0.000377, "valueUsd": 9, "provenance": "stub" }
      ] },
    { "name": "Stablecoin Strategy 1", "address": "0x422c906083ca40b7e055b811d517f03bbbef8eee", "type": "strategy", "totalUsd": 9022,
      "holdings": [
        { "symbol": "ZYFAI-SS1", "amount": 9037.405, "priceUsd": 0.9983, "valueUsd": 9022, "provenance": "stub" }
      ] },
    { "name": "Stablecoin Strategy 2", "address": "0x8d0c331e45beca4184b758f3049f8897aabb9442", "type": "strategy", "totalUsd": 8965,
      "holdings": [
        { "symbol": "GIZA-SS1", "amount": 8980.0, "priceUsd": 0.9983, "valueUsd": 8965, "provenance": "stub" }
      ] }
  ],
  "asOf": "2026-07-09T12:04:40.696Z",
  "source": "stub"
}
```

---

## 4. Allocation framework — `GET /api/dashboards/allocation`

- **Method**: GET (no query params).
- **Module/function**: `backend/src/chain/allocation.ts` (or a `db/` reader) →
  `getAllocationFramework()`. This is **admin/committee-managed** data (no chain
  read, no AI enrichment — see the "projects overviews admin-managed" policy):
  it reads the single-row `allocation_framework` table.
- **Source of truth**: `robotmoney-site/data/committee/allocation.json`
  (`buckets[].target_weight` + `items[].target_weight`, `vault_contract
  0x4f83…49dd`) seeded into `allocation_framework`. Replaces the baked bucket
  percentages in `allocation.html` (95% Conservative DeFi Yield / 5% Agent
  Tokens / 0% Protocol / 0% RWA and the per-item legend weights).
- **Postgres**: EXISTING table `allocation_framework`
  (`id=1, asof date, vault_contract text, buckets jsonb`) — currently unused,
  now the authoritative store. `strategy[]` (top-level pie) and `buckets[]`
  (2×2 cards) both project out of the `buckets` jsonb.
- **Provenance**: `managed: true` (admin-authored, not a live read); `source`
  reflects whether the row is present (`"live"` = DB row) vs a seed default.
  There is no `stale` chain concept here — the data is intentionally static
  until an admin rewrites it.

**DTO**
```ts
interface AllocationStrategy { label: string; targetPct: number }
interface AllocationItem     { label: string; targetPct: number }
interface AllocationBucket   { key: string; label: string; items: AllocationItem[] }
interface AllocationFramework {
  strategy: AllocationStrategy[]; // top-level pie (bucket target weights)
  buckets: AllocationBucket[];    // 2x2 detail cards
  asOf: string;                   // allocation_framework.asof (ISO day) or read time
  source: "live" | "stub";
  managed: true;                  // admin/committee-authored, never chain-derived
}
```

**Preview golden** (`routes["/api/dashboards/allocation"]`):
```json
{
  "strategy": [
    { "label": "Conservative DeFi Yield", "targetPct": 95 },
    { "label": "Agent Tokens", "targetPct": 5 },
    { "label": "Protocol Tokens", "targetPct": 0 },
    { "label": "Real World Assets", "targetPct": 0 }
  ],
  "buckets": [
    { "key": "defi-yield", "label": "Conservative DeFi Yield", "items": [
      { "label": "Aave", "targetPct": 40 },
      { "label": "Morpho", "targetPct": 35 },
      { "label": "Compound", "targetPct": 25 }
    ] },
    { "key": "agent-tokens", "label": "Agent Tokens", "items": [
      { "label": "Juno", "targetPct": 100 }
    ] },
    { "key": "protocol-tokens", "label": "Protocol Tokens", "items": [] },
    { "key": "rwa", "label": "Real World Assets", "items": [] }
  ],
  "asOf": "2026-07-09",
  "source": "stub",
  "managed": true
}
```
> The bucket-item weights above are the shape/example only. The implementer
> seeds the exact `target_weight` values from
> `robotmoney-site/data/committee/allocation.json`; do not invent weights the
> committee data does not carry.

---

## Migration + goldens checklist for implementers

- **New migration** `backend/migrations/00XX_buyback_swaps.sql`:
  `buyback_swaps(id bigserial pk, block_number bigint, tx_hash text UNIQUE,
  log_index int, occurred_on date, weth_spent numeric, value_usd numeric,
  robotmoney_received numeric, provenance text NOT NULL DEFAULT 'live',
  ingested_at timestamptz DEFAULT now())`. Natural key `tx_hash` (or
  `(tx_hash, log_index)`) so a re-run never duplicates a swap — same
  upsert-on-natural-key convention as `0012`/`0014`. Seed the 10 historical rows
  `ON CONFLICT DO NOTHING` with `provenance='seed'`.
- **Seed** `allocation_framework` (id=1) from
  `robotmoney-site/data/committee/allocation.json` in `backend/src/db/seed.ts`.
- **Goldens**: every new route MUST have a `routes[...]` entry in
  `goldens/api-goldens.json` (preview 404s otherwise). Use the examples above as
  the shape; regenerate real values with `bun run goldens:update` against a
  running backend.
- **Frontend**: register the 4 new `ROUTES.dashboards.*` (already added:
  `buybacks`, `tokenMetrics`, `walletSleeves`, `allocation`) into the allocation
  view + Alpine so the baked tables in `frontend/public/views/allocation.html`
  are replaced by fetches.
