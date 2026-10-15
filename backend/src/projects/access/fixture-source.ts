// Hermetic (offline, deterministic) projects data source. Serves the vendored
// fixtures/dataset.ts payloads with NO network — the source selected under
// CI/tests/smoke so the per-PR suite never opens a live socket (issue #87
// hermeticity AC). A missing key throws loudly rather than fabricating data.
import type { CoinGeckoMarketRow, DexPayload } from "../transforms.ts";
import type { DiscoveredProject, Erc4626Read, ProjectsDataSource, WalletBalanceRead } from "./data-source.ts";
import {
  COINGECKO_MARKETS,
  DEXSCREENER_TOKENS,
  DISCOVERY_DATASET,
  VAULT_READS,
  WALLET_BALANCES,
} from "../fixtures/dataset.ts";

export const fixtureProjectsDataSource: ProjectsDataSource = {
  kind: "fixture",

  async discoverProjects(): Promise<DiscoveredProject[]> {
    // Deep-clone so a handler mutating a record can never corrupt the fixture.
    return structuredClone(DISCOVERY_DATASET);
  },

  async coinGeckoMarkets(ids: string[]): Promise<CoinGeckoMarketRow[]> {
    return ids.map((id) => COINGECKO_MARKETS[id]).filter((r): r is CoinGeckoMarketRow => r != null);
  },

  async dexScreenerToken(address: string): Promise<DexPayload> {
    const payload = DEXSCREENER_TOKENS[address.toLowerCase()];
    return payload ?? { pairs: [] };
  },

  async vaultErc4626Read(vaultAddress: string): Promise<Erc4626Read> {
    const read = VAULT_READS[vaultAddress.toLowerCase()];
    if (!read) throw new Error(`fixture vault read missing for ${vaultAddress}`);
    return read;
  },

  // The hermetic fixture serves its own placeholder addresses, so it reads
  // every wallet; a missing fixture key throws in walletBalanceUsd instead.
  supportsWallet(): boolean {
    return true;
  },

  async walletBalanceUsd(address: string): Promise<number> {
    const bal = WALLET_BALANCES[address.toLowerCase()];
    if (bal == null) throw new Error(`fixture wallet balance missing for ${address}`);
    return bal;
  },

  // The batched read is the per-wallet read applied to each address, so both
  // give the same answer (issue 1373). It calls `this.walletBalanceUsd`, so a
  // test source that spreads this object and overrides only the per-wallet
  // read still drives the batched path through its override.
  async walletBalancesUsd(this: ProjectsDataSource, addresses: string[], chain: string): Promise<Map<string, WalletBalanceRead>> {
    const out = new Map<string, WalletBalanceRead>();
    for (const address of addresses) {
      try {
        out.set(address.toLowerCase(), { ok: true, balanceUsd: await this.walletBalanceUsd(address, chain) });
      } catch (err) {
        out.set(address.toLowerCase(), { ok: false, error: err instanceof Error ? err : new Error(String(err)) });
      }
    }
    return out;
  },
};
