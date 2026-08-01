// Coin/Vault/Wallet detail dossiers (issue #391, docs/bot-analytics-ui-port-
// plan.md §5.10/§5.12/§5.14). Runs against the ephemeral Postgres the preload
// provisions + migrates (tests/preload.ts) — a real DB, never a mock. Seeds
// rows across the three facet tables plus their daily-snapshot tables and
// asserts fetchCoinProfile/fetchVaultProfile/fetchWalletProfile (backend/src/
// projects/dossier-projections.ts) project them into the *Profile DTOs:
// identity fields, price/TVL/balance history, linked-agent/wallet joins,
// staleness, and honest not-found/empty behavior.
import { test, expect } from "bun:test";
import { sql } from "../../src/db/client.ts";
import { fetchCoinProfile, fetchVaultProfile, fetchWalletProfile } from "../../src/projects/dossier-projections.ts";
import { getCoinProfile, getVaultProfile, getWalletProfile } from "../../src/api/routes/dashboards.ts";

const rid = (p: string) => `${p}_${crypto.randomUUID().slice(0, 8)}`;
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

// ── CoinProfile ──────────────────────────────────────────────────────────

test("fetchCoinProfile projects identity, ascending price history, and linked agents", async () => {
  const tag = rid("cp");
  const [project] = await sql`INSERT INTO projects ${sql({ slug: tag, display_name: tag })} RETURNING id`;

  const [coin] = await sql`INSERT INTO lobster_coins ${sql({
    project_id: project.id, name: `${tag}-coin`, ticker: "CP", chain: "base",
    contract_address: "0xcoin", price_usd: 2.5, percent_change_24h: 3.2,
    market_cap: 900_000, fdv: 1_200_000, volume_24h: 15_000,
    refreshed_at: new Date().toISOString(), is_active: true,
  })} RETURNING id`;

  await sql`INSERT INTO daily_coin_snapshots ${sql([
    { coin_id: coin.id, snapshot_date: daysAgo(2), price_usd: 2.0, market_cap: 800_000, volume_24h: 10_000 },
    { coin_id: coin.id, snapshot_date: daysAgo(1), price_usd: 2.5, market_cap: 900_000, volume_24h: 15_000 },
  ])}`;

  const [agent] = await sql`INSERT INTO openclaw_agents ${sql({
    project_id: project.id, name: `${tag}-agent`, is_active: true,
  })} RETURNING id`;

  const profile = await fetchCoinProfile(coin.id);
  expect(profile).not.toBeNull();
  expect(profile!.ticker).toBe("CP");
  expect(profile!.chain).toBe("base");
  expect(profile!.marketCapUsd).toBe(900_000);
  expect(profile!.fdvUsd).toBe(1_200_000);
  expect(profile!.stale).toBe(false); // refreshed_at just now, well within the 3h budget

  expect(profile!.priceHistory.map((p) => p.priceUsd)).toEqual([2.0, 2.5]); // ascending by date
  expect(profile!.priceHistory[0].date < profile!.priceHistory[1].date).toBe(true);

  expect(profile!.linkedAgents).toEqual([{ id: agent.id, name: `${tag}-agent`, href: `/agents/${agent.id}` }]);
});

test("fetchCoinProfile never fabricates staleness — a coin refreshed long ago reads stale, an inactive coin is not found", async () => {
  const tag = rid("cpstale");
  const [coin] = await sql`INSERT INTO lobster_coins ${sql({
    name: `${tag}-coin`, refreshed_at: daysAgo(2), is_active: true,
  })} RETURNING id`;
  const profile = await fetchCoinProfile(coin.id);
  expect(profile!.stale).toBe(true);

  const [inactive] = await sql`INSERT INTO lobster_coins ${sql({ name: `${tag}-inactive`, is_active: false })} RETURNING id`;
  expect(await fetchCoinProfile(inactive.id)).toBeNull();
});

test("fetchCoinProfile returns null for an unknown or malformed id (never a thrown Postgres error)", async () => {
  expect(await fetchCoinProfile(crypto.randomUUID())).toBeNull();
  expect(await fetchCoinProfile("not-a-uuid")).toBeNull();
  expect(await fetchCoinProfile("../../etc/passwd")).toBeNull();
});

test("GET /api/dashboards/coins/:id route handler is a thin passthrough", async () => {
  const tag = rid("cproute");
  const [coin] = await sql`INSERT INTO lobster_coins ${sql({ name: `${tag}-coin`, is_active: true })} RETURNING id`;
  const res = await getCoinProfile(coin.id);
  expect(res?.id).toBe(coin.id);
  expect(await getCoinProfile(crypto.randomUUID())).toBeNull();
});

// ── VaultProfile ─────────────────────────────────────────────────────────

test("fetchVaultProfile projects identity, TVL history, honest-empty yield history, and best-effort linked agents/wallets", async () => {
  const tag = rid("vp");
  const [project] = await sql`INSERT INTO projects ${sql({ slug: tag, display_name: tag })} RETURNING id`;

  // data_source deliberately NOT 'live': worker/handlers/projects.ts's
  // fetchVaults() sweeps every `data_source = 'live' AND vault_address IS
  // NOT NULL` row in the WHOLE table (no project scoping) whenever any test
  // in this same run calls it, and degrades/overwrites tvl for an address
  // its fixture data doesn't recognize — same landmine list2-projections.
  // test.ts documents avoiding. 'static' still exercises the real,
  // unmodified dataSource/vault_address pass-through this test checks.
  const [vault] = await sql`INSERT INTO agent_vaults ${sql({
    project_id: project.id, name: `${tag}-vault`, protocol: "aave", strategy_type: "erc4626",
    chain: "base", tvl_usd: 500_000, yield_apy: 0.08, data_source: "static",
    vault_address: `0x${tag}vault`, last_rebalance_at: new Date().toISOString(),
    refreshed_at: new Date().toISOString(), is_active: true,
  })} RETURNING id`;

  await sql`INSERT INTO daily_tvl_snapshots ${sql([
    { vault_id: vault.id, snapshot_date: daysAgo(2), tvl_usd: 400_000 },
    { vault_id: vault.id, snapshot_date: daysAgo(1), tvl_usd: 500_000 },
  ])}`;

  const [agent] = await sql`INSERT INTO openclaw_agents ${sql({ project_id: project.id, name: `${tag}-agent`, is_active: true })} RETURNING id`;
  const [wallet] = await sql`INSERT INTO tracked_wallets ${sql({
    project_id: project.id, label: `${tag}-wallet`, address: "0xw", chain: "base", balance_usd: 1_000, is_active: true,
  })} RETURNING id`;

  const profile = await fetchVaultProfile(vault.id);
  expect(profile).not.toBeNull();
  expect(profile!.protocol).toBe("aave");
  expect(profile!.dataSource).toBe("static");
  expect(profile!.tvlUsd).toBe(500_000);
  expect(profile!.tvlHistory.map((p) => p.tvlUsd)).toEqual([400_000, 500_000]);
  // D11: never a fabricated seeded random-walk yield series — always empty
  // until a real per-vault APY history table/writer exists.
  expect(profile!.yieldHistory).toEqual([]);
  expect(profile!.linkedAgents).toEqual([{ id: agent.id, name: `${tag}-agent`, href: `/agents/${agent.id}` }]);
  expect(profile!.linkedWallets).toEqual([
    { id: wallet.id, label: `${tag}-wallet`, address: "0xw", chain: "base", balanceUsd: 1_000, href: `/wallets/${wallet.id}` },
  ]);
});

test("fetchVaultProfile returns null for an inactive vault or unknown id", async () => {
  const tag = rid("vpinactive");
  const [vault] = await sql`INSERT INTO agent_vaults ${sql({ name: `${tag}-vault`, is_active: false })} RETURNING id`;
  expect(await fetchVaultProfile(vault.id)).toBeNull();
  expect(await fetchVaultProfile(crypto.randomUUID())).toBeNull();
});

test("GET /api/dashboards/vaults/:id route handler is a thin passthrough", async () => {
  const tag = rid("vproute");
  const [vault] = await sql`INSERT INTO agent_vaults ${sql({ name: `${tag}-vault`, is_active: true })} RETURNING id`;
  const res = await getVaultProfile(vault.id);
  expect(res?.id).toBe(vault.id);
});

// ── WalletProfile ────────────────────────────────────────────────────────

test("fetchWalletProfile projects identity, ascending balance history, 30d-ago balance, and address-matched linked agent", async () => {
  const tag = rid("wp");
  const address = `0x${tag}wallet`.toLowerCase();

  const [wallet] = await sql`INSERT INTO tracked_wallets ${sql({
    label: `${tag}-wallet`, category: "treasury", chain: "base",
    address, balance_usd: 5_000, last_tx_at: new Date().toISOString(),
    refreshed_at: new Date().toISOString(), is_active: true,
  })} RETURNING id`;

  await sql`INSERT INTO daily_wallet_snapshots ${sql([
    { wallet_id: wallet.id, snapshot_date: daysAgo(35), total_balance_usd: 3_000 }, // the 30d-ago candidate
    { wallet_id: wallet.id, snapshot_date: daysAgo(2), total_balance_usd: 4_500 },
    { wallet_id: wallet.id, snapshot_date: daysAgo(1), total_balance_usd: 5_000 },
  ])}`;

  // Address match takes priority over a project_id match (exercises the
  // lowercased join, mirrors list2-projections.ts's own wallet<->agent join).
  const [agent] = await sql`INSERT INTO openclaw_agents ${sql({
    name: `${tag}-agent`, wallet_address: address.toUpperCase(), is_active: true,
  })} RETURNING id`;

  const profile = await fetchWalletProfile(wallet.id);
  expect(profile).not.toBeNull();
  expect(profile!.category).toBe("treasury");
  expect(profile!.balanceUsd).toBe(5_000);
  expect(profile!.balanceHistory.map((p) => p.balanceUsd)).toEqual([3_000, 4_500, 5_000]);
  expect(profile!.balance30dAgoUsd).toBe(3_000);
  expect(profile!.stale).toBe(false);
  expect(profile!.linkedAgent).toEqual({ id: agent.id, name: `${tag}-agent`, href: `/agents/${agent.id}` });
});

test("fetchWalletProfile falls back to a project_id-matched agent when no wallet_address match exists", async () => {
  const tag = rid("wpproject");
  const [project] = await sql`INSERT INTO projects ${sql({ slug: tag, display_name: tag })} RETURNING id`;
  const [wallet] = await sql`INSERT INTO tracked_wallets ${sql({
    project_id: project.id, label: `${tag}-wallet`, address: "0xunmatched", is_active: true,
  })} RETURNING id`;
  const [agent] = await sql`INSERT INTO openclaw_agents ${sql({ project_id: project.id, name: `${tag}-agent`, is_active: true })} RETURNING id`;

  const profile = await fetchWalletProfile(wallet.id);
  expect(profile!.linkedAgent).toEqual({ id: agent.id, name: `${tag}-agent`, href: `/agents/${agent.id}` });
});

test("fetchWalletProfile: no snapshot history and no linked agent renders honestly empty, not fabricated", async () => {
  const tag = rid("wpempty");
  const [wallet] = await sql`INSERT INTO tracked_wallets ${sql({ label: `${tag}-wallet`, is_active: true })} RETURNING id`;
  const profile = await fetchWalletProfile(wallet.id);
  expect(profile!.balanceHistory).toEqual([]);
  expect(profile!.balance30dAgoUsd).toBeNull();
  expect(profile!.linkedAgent).toBeNull();
  // D14: wallet refresh is unimplemented — refreshed_at is never set on
  // discovery, so a fresh wallet reads honestly stale, never fresh-by-default.
  expect(profile!.stale).toBe(true);
});

test("fetchWalletProfile returns null for an inactive wallet or unknown id", async () => {
  const tag = rid("wpinactive");
  const [wallet] = await sql`INSERT INTO tracked_wallets ${sql({ label: `${tag}-wallet`, is_active: false })} RETURNING id`;
  expect(await fetchWalletProfile(wallet.id)).toBeNull();
  expect(await fetchWalletProfile(crypto.randomUUID())).toBeNull();
});

test("GET /api/dashboards/wallets/:id route handler is a thin passthrough", async () => {
  const tag = rid("wproute");
  const [wallet] = await sql`INSERT INTO tracked_wallets ${sql({ label: `${tag}-wallet`, is_active: true })} RETURNING id`;
  const res = await getWalletProfile(wallet.id);
  expect(res?.id).toBe(wallet.id);
});
