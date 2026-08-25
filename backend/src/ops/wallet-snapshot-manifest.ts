import {
  isPlaceholderAddress,
  resolvePropWallets,
  resolveTrackedAssets,
  type TrackedAsset,
} from "../config.ts";
import { SLEEVE_DEFS } from "../chain/wallet-valuation.ts";
import type postgresTypes from "postgres";

/**
 * One lock protocol for every writer that can touch a wallet snapshot date.
 *
 * Row locks cannot protect a natural key that does not exist yet. Without this
 * advisory lock, a live INSERT could commit after repair copied the old rows
 * but before its DELETE, and that newly committed row would be deleted without
 * ever reaching evidence. Both live samplers and historical repair acquire
 * this transaction-scoped lock before writing a date.
 */
export async function lockWalletSnapshotDate(
  db: postgresTypes.TransactionSql<{}>,
  sampleDate: string,
): Promise<void> {
  await db`SELECT pg_advisory_xact_lock(hashtext('wallet-aum-snapshot'), hashtext(${sampleDate}))`;
}

export interface WalletSleeveManifestKey {
  walletIndex: number;
  walletAddress: string;
  asset: TrackedAsset;
}

/** The expected natural keys for one historical AUM snapshot.
 *
 * P0 deliberately uses the active configuration as the manifest. Persisting a
 * versioned point-in-time manifest is P1; until then, one shared resolver is
 * still strictly better than three callers independently deciding what
 * "complete" means. Config-valued SP500 is excluded because the historical
 * backfill has no chain observation for it. */
export interface WalletSnapshotManifest {
  balanceAssets: TrackedAsset[];
  sleeveKeys: WalletSleeveManifestKey[];
}

export function resolveWalletSnapshotManifest(
  assets: TrackedAsset[] = resolveTrackedAssets(),
  wallets: string[] = resolvePropWallets(),
): WalletSnapshotManifest {
  const balanceAssets = assets.filter((asset) => asset.valuationKind !== "config");
  const bySymbol = new Map(assets.map((asset) => [asset.symbol, asset]));
  const sleeveKeys: WalletSleeveManifestKey[] = [];

  for (let walletIndex = 0; walletIndex < SLEEVE_DEFS.length && walletIndex < wallets.length; walletIndex++) {
    const walletAddress = wallets[walletIndex]!.toLowerCase();
    for (const symbol of SLEEVE_DEFS[walletIndex]!.symbols) {
      const asset = bySymbol.get(symbol);
      if (!asset) continue;
      if (asset.valuationKind !== "native" && isPlaceholderAddress(asset.address)) continue;
      sleeveKeys.push({ walletIndex, walletAddress, asset });
    }
  }

  return { balanceAssets, sleeveKeys };
}

export function sleeveManifestKey(walletAddress: string, symbol: string): string {
  return `${walletAddress.toLowerCase()}\u0000${symbol}`;
}
