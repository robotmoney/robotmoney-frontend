// The persisted-price fallback for the pipeline worker (issue 1034, decision
// D75). A live price read that fails falls back to a recent persisted sample's
// price; the worker holds no database credential, so it reads that price
// through the api (pipeline/ops.ts `wallet.recent_persisted_price`).
import { persistedFallbackReader, type WalletPriceReader } from "../chain/wallet-valuation.ts";
import { pipelineRead } from "./pipeline-client.ts";

export const persistedFallbackWalletPriceReader: WalletPriceReader = persistedFallbackReader((symbol) =>
  pipelineRead<{ priceUsd: number; sampledAt: string } | null>("wallet.recent_persisted_price", symbol),
);
