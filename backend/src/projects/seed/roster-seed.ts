// Committed v0 identity-roster seed (R11 follow-up —
// docs/audits/v0-v1-parity/R11-projects-supabase-audit.md §6: "v1 has never
// ingested v0's real roster"). Format, checksum, and NETWORK-FREE load for
// the real v0 project/agent/coin/wallet/vault identity roster that
// liveProjectsDataSource.discoverProjects() (access/live-source.ts) returns.
//
// This is IDENTITY data only — slug/display_name/description/website_url/
// twitter_handle/logo_url/is_sticky, and per-facet identity fields (agent
// name/protocol_standard/wallet_address/virtuals_agent_id/x402_*/
// productivity_score/source_confidence; coin name/ticker/coingecko_id/
// contract_address/chain; wallet label/chain/address; vault name/
// vault_address/chain/strategy_type/protocol/data_source) — exactly the
// DiscoveredProject/DiscoveredAgent/DiscoveredCoin/DiscoveredWallet/
// DiscoveredVault shape in ../access/data-source.ts. Every VOLATILE metric
// (market cap, FDV, 24h %, wallet USD balance, vault TVL, revenue) is fetched
// LIVE elsewhere in live-source.ts (coinGeckoMarkets/dexScreenerToken/
// vaultErc4626Read/walletBalanceUsd) and is NEVER baked into this seed as a
// point-in-time snapshot masquerading as current data.
//
// Pure parsing/validation — no network, no SQL. The live fetch that PRODUCES
// this artifact lives in roster-seed-generator.ts; the CLI wrapper is
// ../../../scripts/projects-roster-seed-regenerate.ts (mirrors the edgar-seed
// / floor-seed extract/generator/script split in ../../analytics/extract).
import { createHash } from "node:crypto";
import { renameSync, writeFileSync } from "node:fs";
import type { DiscoveredProject } from "../access/data-source.ts";

export const ROSTER_SEED_FORMAT_VERSION = 1;

export interface RosterSeedManifest {
  formatVersion: number;
  source: string; // provenance tag, e.g. "v0-supabase"
  generatedAt: string; // ISO timestamp the live pull was run
  projectCount: number;
  agentCount: number;
  coinCount: number;
  walletCount: number;
  vaultCount: number;
  checksum: string; // sha256 hex of the canonical JSON content (see canonicalJson)
}

// Committed pair (same directory as this module — a demo/CI/prod boot never
// needs network or DB access to read the roster). Overridable via
// ROSTER_SEED_PATH/ROSTER_SEED_MANIFEST_PATH for tests and the regenerate CLI.
export const DEFAULT_ROSTER_SEED_PATH = new URL("./v0-roster-data.json", import.meta.url).pathname;
export const DEFAULT_ROSTER_SEED_MANIFEST_PATH = new URL(
  "./v0-roster-data.manifest.json",
  import.meta.url,
).pathname;

function resolveSeedPath(explicit?: string): string {
  return explicit || process.env.ROSTER_SEED_PATH || DEFAULT_ROSTER_SEED_PATH;
}
function resolveManifestPath(explicit?: string): string {
  return explicit || process.env.ROSTER_SEED_MANIFEST_PATH || DEFAULT_ROSTER_SEED_MANIFEST_PATH;
}

// Deterministic ordering: projects sorted by slug, each project's facets
// sorted by their natural key — so the checksum (and the committed diff) never
// depends on fetch/pagination order.
function canonicalize(projects: readonly DiscoveredProject[]): DiscoveredProject[] {
  return [...projects]
    .map((p) => ({
      ...p,
      agents: [...p.agents].sort((a, b) => a.name.localeCompare(b.name)),
      coins: [...p.coins].sort((a, b) => a.ticker.localeCompare(b.ticker)),
      wallets: [...p.wallets].sort((a, b) => a.address.localeCompare(b.address)),
      vaults: [...p.vaults].sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

export function canonicalJson(projects: readonly DiscoveredProject[]): string {
  return JSON.stringify(canonicalize(projects), null, 2) + "\n";
}

export function computeChecksum(canonicalText: string): string {
  return createHash("sha256").update(canonicalText, "utf8").digest("hex");
}

export function buildManifest(
  projects: readonly DiscoveredProject[],
  opts: { generatedAt: string; source?: string },
): RosterSeedManifest {
  if (projects.length === 0) throw new Error("roster seed: cannot build a manifest for zero projects");
  const text = canonicalJson(projects);
  return {
    formatVersion: ROSTER_SEED_FORMAT_VERSION,
    source: opts.source ?? "v0-supabase",
    generatedAt: opts.generatedAt,
    projectCount: projects.length,
    agentCount: projects.reduce((n, p) => n + p.agents.length, 0),
    coinCount: projects.reduce((n, p) => n + p.coins.length, 0),
    walletCount: projects.reduce((n, p) => n + p.wallets.length, 0),
    vaultCount: projects.reduce((n, p) => n + p.vaults.length, 0),
    checksum: computeChecksum(text),
  };
}

// Full structural + manifest-consistency validation. Throws with a
// descriptive message on the FIRST violation — used both to self-check a
// freshly generated artifact before it is ever written to disk, and to check
// the committed artifact before discoverProjects() ever serves it.
export function validateRoster(projects: readonly DiscoveredProject[], manifest: RosterSeedManifest): void {
  if (manifest.formatVersion !== ROSTER_SEED_FORMAT_VERSION) {
    throw new Error(
      `v0 roster seed: unsupported formatVersion ${manifest.formatVersion} (expected ${ROSTER_SEED_FORMAT_VERSION})`,
    );
  }
  if (!Number.isInteger(manifest.projectCount) || manifest.projectCount <= 0) {
    throw new Error(`v0 roster seed: manifest projectCount must be a positive integer, got ${manifest.projectCount}`);
  }
  if (projects.length !== manifest.projectCount) {
    throw new Error(
      `v0 roster seed: parsed ${projects.length} project(s) but manifest declares projectCount=${manifest.projectCount}`,
    );
  }

  const seenSlugs = new Set<string>();
  let agentCount = 0;
  let coinCount = 0;
  let walletCount = 0;
  let vaultCount = 0;
  for (const p of projects) {
    if (!p.slug) throw new Error("v0 roster seed: a project row has an empty slug");
    if (seenSlugs.has(p.slug)) throw new Error(`v0 roster seed: duplicate slug ${JSON.stringify(p.slug)}`);
    seenSlugs.add(p.slug);
    if (!p.display_name) throw new Error(`v0 roster seed: project ${JSON.stringify(p.slug)} has an empty display_name`);
    for (const a of p.agents) {
      if (!a.name || !a.protocol_standard) {
        throw new Error(`v0 roster seed: project ${p.slug} has an agent with an empty name/protocol_standard`);
      }
    }
    for (const c of p.coins) {
      if (!c.name || !c.ticker) {
        throw new Error(`v0 roster seed: project ${p.slug} has a coin with an empty name/ticker`);
      }
    }
    for (const w of p.wallets) {
      if (!w.label || !w.chain || !w.address) {
        throw new Error(`v0 roster seed: project ${p.slug} has a wallet with an empty label/chain/address`);
      }
    }
    for (const v of p.vaults) {
      if (!v.name) throw new Error(`v0 roster seed: project ${p.slug} has a vault with an empty name`);
    }
    agentCount += p.agents.length;
    coinCount += p.coins.length;
    walletCount += p.wallets.length;
    vaultCount += p.vaults.length;
  }
  if (agentCount !== manifest.agentCount) {
    throw new Error(`v0 roster seed: computed agentCount ${agentCount} !== manifest agentCount ${manifest.agentCount}`);
  }
  if (coinCount !== manifest.coinCount) {
    throw new Error(`v0 roster seed: computed coinCount ${coinCount} !== manifest coinCount ${manifest.coinCount}`);
  }
  if (walletCount !== manifest.walletCount) {
    throw new Error(`v0 roster seed: computed walletCount ${walletCount} !== manifest walletCount ${manifest.walletCount}`);
  }
  if (vaultCount !== manifest.vaultCount) {
    throw new Error(`v0 roster seed: computed vaultCount ${vaultCount} !== manifest vaultCount ${manifest.vaultCount}`);
  }

  // Content checksum LAST (mirrors extract/edgar-seed.ts): every structural
  // check above is independent of it, so a mutated field/reordered row/altered
  // count is caught by whichever check is more specific; ANY byte-level change
  // to the canonical content also always changes this digest.
  const checksum = computeChecksum(canonicalJson(projects));
  if (checksum !== manifest.checksum) {
    throw new Error(`v0 roster seed: checksum mismatch (computed ${checksum}, manifest declares ${manifest.checksum})`);
  }
}

// Load + FULLY VALIDATE the committed artifact. Fails loudly (never a silent
// empty-roster fallback) on a missing file, corrupt JSON, or any structural/
// checksum violation — always BEFORE returning, matching fixture-source.ts's
// "a missing key throws loudly rather than fabricating data" discipline.
export async function loadV0Roster(path?: string, manifestPath?: string): Promise<DiscoveredProject[]> {
  const p = resolveSeedPath(path);
  const mp = resolveManifestPath(manifestPath);

  const file = Bun.file(p);
  if (!(await file.exists())) {
    throw new Error(`v0 roster seed not found at ${p} — set ROSTER_SEED_PATH or ship the committed seed`);
  }
  const manifestFile = Bun.file(mp);
  if (!(await manifestFile.exists())) {
    throw new Error(`v0 roster seed manifest not found at ${mp} — set ROSTER_SEED_MANIFEST_PATH or ship the committed manifest`);
  }

  let projects: DiscoveredProject[];
  try {
    projects = JSON.parse(await file.text()) as DiscoveredProject[];
  } catch (e) {
    throw new Error(`v0 roster seed at ${p} is not valid JSON: ${e instanceof Error ? e.message : e}`);
  }
  let manifest: RosterSeedManifest;
  try {
    manifest = JSON.parse(await manifestFile.text()) as RosterSeedManifest;
  } catch (e) {
    throw new Error(`v0 roster seed manifest at ${mp} is not valid JSON: ${e instanceof Error ? e.message : e}`);
  }

  validateRoster(projects, manifest); // throws loudly on ANY corruption — before any caller sees a row

  return projects;
}

// Atomic replace (mirrors extract/edgar-seed-generator.ts's
// replaceSeedArtifactAtomically): self-validates the freshly generated pair
// BEFORE touching either committed path, then writes both via a same-directory
// temp file + rename so a crash mid-write can never leave a half-written or
// mismatched data/manifest pair on disk.
export function replaceRosterSeedAtomically(
  path: string,
  manifestPath: string,
  projects: readonly DiscoveredProject[],
  manifest: RosterSeedManifest,
): void {
  validateRoster(projects, manifest);
  const text = canonicalJson(projects);
  const manifestText = JSON.stringify(manifest, null, 2) + "\n";

  const tmpData = `${path}.tmp-${process.pid}`;
  const tmpManifest = `${manifestPath}.tmp-${process.pid}`;
  writeFileSync(tmpData, text, "utf8");
  writeFileSync(tmpManifest, manifestText, "utf8");
  renameSync(tmpData, path);
  renameSync(tmpManifest, manifestPath);
}
