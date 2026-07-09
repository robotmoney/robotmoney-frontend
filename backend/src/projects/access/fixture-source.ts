// Hermetic (offline, deterministic) projects data source. Serves the vendored
// fixtures/dataset.ts payloads with NO network — the source selected under
// CI/tests/demo so the per-PR suite never opens a live socket (issue #87
// hermeticity AC). A missing key throws loudly rather than fabricating data.
import type { CoinGeckoMarketRow, DexPayload } from "../transforms.ts";
import type { DiscoveredProject, Erc4626Read, ProjectsDataSource } from "./data-source.ts";
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

  async walletBalanceUsd(address: string): Promise<number> {
    const bal = WALLET_BALANCES[address.toLowerCase()];
    if (bal == null) throw new Error(`fixture wallet balance missing for ${address}`);
    return bal;
  },
};
