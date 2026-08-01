// Thin HTTP adapters for the analytics-dashboard directory list feeds (issue
// #386). All query + DTO logic lives in the projection layer
// (dash/lists.ts); these handlers only forward, matching the projects.ts /
// dashboards.ts convention.
import { fetchCoinsList, fetchVaultsList, fetchWalletsList } from "../../dash/lists.ts";

// GET /api/dash/coins → /lobster directory.
export async function getCoinsList() {
  return fetchCoinsList();
}

// GET /api/dash/vaults → /vaults directory.
export async function getVaultsList() {
  return fetchVaultsList();
}

// GET /api/dash/wallets → /wallets directory.
export async function getWalletsList() {
  return fetchWalletsList();
}
