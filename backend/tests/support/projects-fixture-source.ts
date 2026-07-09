// Test helper: a projects data source that serves the vendored fixture payloads
// but rewrites each discovered project's slug with a unique prefix, so DB-backed
// pipeline tests never collide on slug with each other or with the demo-seed
// suite in the shared ephemeral Postgres. Provider lookups (coins/dex/vault/
// wallet) are keyed by shared address/id constants, so they need no rewriting.
import { fixtureProjectsDataSource } from "../../src/projects/access/fixture-source.ts";
import type { ProjectsDataSource } from "../../src/projects/access/data-source.ts";
import { DISCOVERY_DATASET } from "../../src/projects/fixtures/dataset.ts";

export function uniqueSlugSource(prefix: string): ProjectsDataSource {
  return {
    ...fixtureProjectsDataSource,
    async discoverProjects() {
      return structuredClone(DISCOVERY_DATASET).map((p) => ({ ...p, slug: `${prefix}-${p.slug}` }));
    },
  };
}

// A source whose extractors all throw — drives the degrade-to-persisted path.
export function failingSource(prefix: string): ProjectsDataSource {
  const boom = () => {
    throw new Error("forced extractor failure");
  };
  return {
    kind: "fixture",
    async discoverProjects() {
      return structuredClone(DISCOVERY_DATASET).map((p) => ({ ...p, slug: `${prefix}-${p.slug}` }));
    },
    coinGeckoMarkets: boom,
    dexScreenerToken: boom,
    vaultErc4626Read: boom,
    walletBalanceUsd: boom,
  };
}
