// Committed v0 identity-roster seed (R11 follow-up —
// docs/audits/v0-v1-parity/R11-projects-supabase-audit.md, Verdict: "v1 has
// never ingested v0's real roster"). Format, checksum, and NETWORK-FREE load for
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
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { config } from "../../config.ts";
import type { DiscoveredProject } from "../access/data-source.ts";

export const ROSTER_SEED_FORMAT_VERSION = 1;

// Per-table row counts. `upstreamTotals` are the counts the SERVER declared
// (PostgREST `Prefer: count=exact` → `Content-Range`), i.e. rows that exist
// upstream — NOT rows this generator managed to fetch. That distinction is the
// whole point: counts derived from the fetched array can only ever prove
// "the file matches what we extracted", never "what we extracted is complete".
export interface RosterSeedRowCounts {
  projects: number;
  agents: number;
  coins: number;
  wallets: number;
  vaults: number;
}

export interface RosterSeedManifest {
  formatVersion: number;
  source: string; // provenance tag, e.g. "v0-supabase"
  // ISO timestamp the live pull COMPLETED — the roster's true as-of time. It is
  // the identity data's real freshness and must be carried through to every
  // consumer (see loadV0RosterWithManifest); a consumer that stamps its own
  // now() over seeded rows fabricates freshness the seed does not have.
  generatedAt: string;
  projectCount: number;
  agentCount: number;
  coinCount: number;
  walletCount: number;
  vaultCount: number;
  // Server-declared upstream totals and the generator's own skip tallies.
  // OPTIONAL because artifacts generated before these were recorded cannot have
  // them, and a fabricated backfill would be exactly the lie this guards
  // against: absent means "this generator version did not record it", never 0.
  upstreamTotals?: RosterSeedRowCounts;
  skipped?: RosterSeedRowCounts;
  checksum: string; // sha256 hex of the canonical JSON content (see canonicalJson)
}

// A regeneration that loses more than this fraction of the previous artifact's
// projects is refused rather than written (RLS change, upstream filter change,
// a truncating fetch bug). Overridable per-run by the operator with the
// regenerate script's --allow-shrink, which is the deliberate "yes, v0 really
// did shrink" acknowledgement.
export const MAX_PROJECT_COUNT_DROP_RATIO = 0.1;

// Committed pair (same directory as this module — a smoke/CI/prod boot never
// needs network or DB access to read the roster). Overridable via
// ROSTER_SEED_PATH/ROSTER_SEED_MANIFEST_PATH for tests and the regenerate CLI.
// fileURLToPath, not URL.pathname: pathname is percent-encoded, so a checkout
// under a directory containing a space resolves to a `%20` path that
// Bun.file().exists() reports missing — and the operator is told to "set
// ROSTER_SEED_PATH" for a file that is sitting right there.
export const DEFAULT_ROSTER_SEED_PATH = fileURLToPath(new URL("./v0-roster-data.json", import.meta.url));
export const DEFAULT_ROSTER_SEED_MANIFEST_PATH = fileURLToPath(
  new URL("./v0-roster-data.manifest.json", import.meta.url),
);

// ROSTER_SEED_PATH / ROSTER_SEED_MANIFEST_PATH are TEST-ONLY overrides, and in
// prod they are refused rather than honoured — mirroring access/select.ts's
// fail-closed PROJECTS_SOURCE handling. An override pointing at a
// valid-but-different pair (a scratch copy, a leftover bind mount) would not
// fail any check: it loads, validates, and silently publishes a different
// roster into the production directory. Explicit arguments (the regenerate CLI,
// tests passing paths directly) are unaffected.
function resolveOverride(explicit: string | undefined, envVar: string, fallback: string): string {
  if (explicit) return explicit;
  const override = process.env[envVar];
  if (!override) return fallback;
  if (config.env === "prod") {
    throw new Error(
      `${envVar} is a test-only override and must not be set in prod — refusing to load a roster seed from ` +
        `${override} instead of the committed artifact at ${fallback}`,
    );
  }
  return override;
}

function resolveSeedPath(explicit?: string): string {
  return resolveOverride(explicit, "ROSTER_SEED_PATH", DEFAULT_ROSTER_SEED_PATH);
}
function resolveManifestPath(explicit?: string): string {
  return resolveOverride(explicit, "ROSTER_SEED_MANIFEST_PATH", DEFAULT_ROSTER_SEED_MANIFEST_PATH);
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
  opts: {
    generatedAt: string;
    source?: string;
    upstreamTotals?: RosterSeedRowCounts;
    skipped?: RosterSeedRowCounts;
  },
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
    // Only ever set from real measurements — never defaulted to a zeroed shape.
    ...(opts.upstreamTotals ? { upstreamTotals: opts.upstreamTotals } : {}),
    ...(opts.skipped ? { skipped: opts.skipped } : {}),
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

  // Facet natural keys are checked against the EXACT conflict targets
  // worker/handlers/projects.ts upserts on — agents/coins/vaults ON CONFLICT
  // (project_id, name), wallets ON CONFLICT (project_id, label) — NOT against
  // the keys canonicalize() happens to sort by (wallets by address, coins by
  // ticker). Two rows that differ by address/ticker but collide on the DB's key
  // would both be counted here and then silently collapse to one row on insert,
  // leaving the manifest's counts describing a dataset the database does not
  // hold. Checking the sort key instead of the conflict key would not catch it.
  function assertUniqueFacetKeys(slug: string, facet: string, keyName: string, keys: string[]): void {
    const seen = new Set<string>();
    for (const k of keys) {
      if (seen.has(k)) {
        throw new Error(
          `v0 roster seed: project ${slug} has two ${facet} rows sharing ${keyName} ${JSON.stringify(k)} — ` +
            `they would collapse into one row on the (project_id, ${keyName}) upsert, so the manifest count would overstate reality`,
        );
      }
      seen.add(k);
    }
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
    assertUniqueFacetKeys(p.slug, "agent", "name", p.agents.map((a) => a.name));
    assertUniqueFacetKeys(p.slug, "coin", "name", p.coins.map((c) => c.name));
    assertUniqueFacetKeys(p.slug, "wallet", "label", p.wallets.map((w) => w.label));
    assertUniqueFacetKeys(p.slug, "vault", "name", p.vaults.map((v) => v.name));
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

  // Upstream reconciliation. `upstreamTotals` come from the SERVER
  // (`Prefer: count=exact`), so this is the one check in the file that is not
  // self-referential: included + skipped must account for every row the server
  // said exists. A truncating fetch shows up here as a shortfall instead of
  // passing as a smaller-but-internally-consistent artifact.
  if (manifest.upstreamTotals || manifest.skipped) {
    if (!manifest.upstreamTotals || !manifest.skipped) {
      throw new Error(
        "v0 roster seed: manifest carries only one of upstreamTotals/skipped — both are recorded together or not at all",
      );
    }
    const included: RosterSeedRowCounts = {
      projects: manifest.projectCount,
      agents: manifest.agentCount,
      coins: manifest.coinCount,
      wallets: manifest.walletCount,
      vaults: manifest.vaultCount,
    };
    for (const table of ["projects", "agents", "coins", "wallets", "vaults"] as const) {
      const upstream = manifest.upstreamTotals[table];
      const skipped = manifest.skipped[table];
      if (!Number.isInteger(upstream) || upstream < 0 || !Number.isInteger(skipped) || skipped < 0) {
        throw new Error(
          `v0 roster seed: manifest ${table} upstreamTotals/skipped must be non-negative integers, got ${upstream}/${skipped}`,
        );
      }
      if (included[table] + skipped !== upstream) {
        throw new Error(
          `v0 roster seed: ${table} do not reconcile against upstream — ${included[table]} included + ${skipped} skipped ` +
            `!== ${upstream} declared upstream by the source server (rows went missing between the fetch and the artifact)`,
        );
      }
    }
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

export interface LoadedRosterSeed {
  projects: DiscoveredProject[];
  manifest: RosterSeedManifest;
}

// Load + FULLY VALIDATE the committed artifact. Fails loudly (never a silent
// empty-roster fallback) on a missing file, corrupt JSON, or any structural/
// checksum violation — always BEFORE returning, matching fixture-source.ts's
// "a missing key throws loudly rather than fabricating data" discipline.
//
// Returns the MANIFEST alongside the rows on purpose. manifest.generatedAt is
// the roster's real as-of time, and this is the boundary where it would
// otherwise be dropped: a caller handed only `DiscoveredProject[]` has no
// option but to stamp its own now() on the rows it persists, which reports a
// frozen dataset as freshly refreshed forever. Consumers that persist
// freshness MUST carry this value through (see worker/handlers/projects.ts's
// discover()).
export async function loadV0RosterWithManifest(path?: string, manifestPath?: string): Promise<LoadedRosterSeed> {
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

  // One line naming WHICH artifact was served. Without it a wrong (but valid)
  // ROSTER_SEED_PATH publishes a different roster into the directory and no
  // log, API response, or metric anywhere says which file it came from.
  console.log(
    `[roster-seed] loaded ${p} — source=${manifest.source} generatedAt=${manifest.generatedAt} ` +
      `projects=${manifest.projectCount} agents=${manifest.agentCount} coins=${manifest.coinCount} ` +
      `wallets=${manifest.walletCount} vaults=${manifest.vaultCount} checksum=${manifest.checksum.slice(0, 12)}`,
  );

  return { projects, manifest };
}

// Manifest ONLY — the ~1.1 MB data file is never read. For callers that need
// the seed's declared provenance (the admin overview's roster-health entry)
// rather than its rows. The checksum is NOT verified here (that requires the
// data file); a caller reporting these values must present them as "what the
// manifest declares", which is exactly what the health entry is for.
export async function loadRosterSeedManifest(manifestPath?: string): Promise<RosterSeedManifest> {
  const mp = resolveManifestPath(manifestPath);
  const manifestFile = Bun.file(mp);
  if (!(await manifestFile.exists())) {
    throw new Error(`v0 roster seed manifest not found at ${mp} — set ROSTER_SEED_MANIFEST_PATH or ship the committed manifest`);
  }
  let manifest: RosterSeedManifest;
  try {
    manifest = JSON.parse(await manifestFile.text()) as RosterSeedManifest;
  } catch (e) {
    throw new Error(`v0 roster seed manifest at ${mp} is not valid JSON: ${e instanceof Error ? e.message : e}`);
  }
  if (manifest.formatVersion !== ROSTER_SEED_FORMAT_VERSION) {
    throw new Error(
      `v0 roster seed: unsupported formatVersion ${manifest.formatVersion} (expected ${ROSTER_SEED_FORMAT_VERSION})`,
    );
  }
  return manifest;
}

// Rows-only convenience for callers that genuinely do not persist freshness.
// Anything that writes a timestamp derived from this data must use
// loadV0RosterWithManifest() and carry manifest.generatedAt instead.
export async function loadV0Roster(path?: string, manifestPath?: string): Promise<DiscoveredProject[]> {
  return (await loadV0RosterWithManifest(path, manifestPath)).projects;
}

// Replace the committed pair (mirrors extract/edgar-seed-generator.ts's
// replaceSeedArtifactAtomically): self-validates the freshly generated pair and
// checks it against the previous manifest's regression floor BEFORE touching
// either committed path, then writes each file via a same-directory temp file +
// rename so neither file is ever observed half-written.
//
// Atomicity is PER FILE, not across the pair: this issues two renameSync calls,
// and no ordering of two renames is atomic, so a crash between them leaves the
// new data next to the old manifest. That state fails CLOSED — the next
// loadV0RosterWithManifest() raises a loud checksum mismatch rather than
// serving the mismatched pair — which is the actual guarantee here.
export function replaceRosterSeedAtomically(
  path: string,
  manifestPath: string,
  projects: readonly DiscoveredProject[],
  manifest: RosterSeedManifest,
  opts: { allowShrink?: boolean } = {},
): void {
  validateRoster(projects, manifest);
  assertNoProjectCountRegression(manifestPath, manifest, opts.allowShrink === true);
  const text = canonicalJson(projects);
  const manifestText = JSON.stringify(manifest, null, 2) + "\n";

  const tmpData = `${path}.tmp-${process.pid}`;
  const tmpManifest = `${manifestPath}.tmp-${process.pid}`;
  writeFileSync(tmpData, text, "utf8");
  writeFileSync(tmpManifest, manifestText, "utf8");
  renameSync(tmpData, path);
  renameSync(tmpManifest, manifestPath);
}

// Regression floor. A regeneration that silently loses a large share of the
// roster (an RLS/grant change on the source, an upstream filter change, a
// truncating fetch) is indistinguishable from a legitimate one by any
// self-derived check — the small artifact is perfectly internally consistent.
// The only reference that is NOT derived from the new pull is the artifact
// already on disk, so the previous manifest's projectCount is the floor.
// Refuses to write; the operator acknowledges a genuine shrink with
// --allow-shrink.
export function assertNoProjectCountRegression(
  manifestPath: string,
  next: RosterSeedManifest,
  allowShrink: boolean,
): void {
  if (allowShrink) return;
  if (!existsSync(manifestPath)) return; // first-ever generation has nothing to regress against
  let previous: RosterSeedManifest;
  try {
    previous = JSON.parse(readFileSync(manifestPath, "utf8")) as RosterSeedManifest;
  } catch (e) {
    throw new Error(
      `v0 roster seed: existing manifest at ${manifestPath} is not valid JSON, so the regression floor cannot be ` +
        `checked: ${e instanceof Error ? e.message : e} (pass --allow-shrink to overwrite it deliberately)`,
    );
  }
  if (!Number.isInteger(previous.projectCount) || previous.projectCount <= 0) return;
  const floor = Math.ceil(previous.projectCount * (1 - MAX_PROJECT_COUNT_DROP_RATIO));
  if (next.projectCount < floor) {
    throw new Error(
      `v0 roster seed: refusing to write — projectCount fell from ${previous.projectCount} to ${next.projectCount}, ` +
        `below the ${Math.round(MAX_PROJECT_COUNT_DROP_RATIO * 100)}% regression floor of ${floor}. ` +
        `The committed artifact is untouched. Re-run with --allow-shrink only if v0 really did shrink this much.`,
    );
  }
}
