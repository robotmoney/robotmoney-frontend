// The manifest-derived four-vault overview served at
// ROUTES.dashboards.robotmoneyVaults (frontend 1103). Rows come from
// overviewRowsFromDeployment; no vault list or address is written here. Returns
// null when no deployment manifest is configured, so the route answers 404 and
// the web client falls back to the single-vault read.
import { overviewRowsFromDeployment, type DeploymentSet, type VaultKey } from "./deployment-manifest.ts";

export type VaultReads = Partial<Record<VaultKey, { tvlUsd: number | null; sharePrice: number | null }>>;

export interface VaultsOverviewDto {
  asOf: string;
  network: { chainId: number | null };
  // The gateway deposits go through, and the router it carries.
  contracts: { gateway: string | null; router: string | null; registry: string | null };
  vaults: Array<Record<string, unknown>>;
}

export function buildVaultsOverview(
  set: DeploymentSet,
  reads: VaultReads = {},
  now: Date = new Date(),
): VaultsOverviewDto | null {
  if (set.vaults.length === 0) return null;
  return {
    asOf: now.toISOString(),
    network: { chainId: set.chainId },
    contracts: { gateway: set.gateway, router: set.router, registry: set.registry },
    vaults: overviewRowsFromDeployment(set, reads),
  };
}
