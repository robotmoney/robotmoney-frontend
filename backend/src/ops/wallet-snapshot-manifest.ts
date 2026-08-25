import {
  isPlaceholderAddress,
  resolvePropWallets,
  resolveTrackedAssets,
  type TrackedAsset,
} from "../config.ts";
import { SLEEVE_DEFS } from "../chain/wallet-valuation.ts";
import type postgresTypes from "postgres";
import { createHash } from "node:crypto";

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

/** Persistable sleeve key for snapshot headers. PostgreSQL text cannot contain
 * NUL, so this is intentionally distinct from the process-local P0 map key. */
export function persistedSleeveManifestKey(walletAddress: string, symbol: string): string {
  return canonicalJsonString([walletAddress.toLowerCase(), symbol]);
}

// ── P1 immutable manifest and content identity primitives ───────────────────

export const AUM_PRODUCER_REVISION_ENV = "AUM_PRODUCER_REVISION";

export type ProducerRevisionIdentity =
  | { status: "available"; revision: string; unavailableReason: null }
  | { status: "unavailable"; revision: null; unavailableReason: string };

/** Resolve only an explicitly supplied build/runtime revision.
 *
 * There is deliberately no package-version, wall-clock, branch, or `unknown`
 * fallback: those values look like identity while being unable to reproduce a
 * producer. A future publisher must persist the unavailable branch as an
 * unavailable run rather than minting a published snapshot. */
export function resolveAumProducerRevision(
  env: Record<string, string | undefined> = process.env,
): ProducerRevisionIdentity {
  const revision = env[AUM_PRODUCER_REVISION_ENV]?.trim();
  return revision
    ? { status: "available", revision, unavailableReason: null }
    : {
        status: "unavailable",
        revision: null,
        unavailableReason: `${AUM_PRODUCER_REVISION_ENV} is unset or blank`,
      };
}

type CanonicalJson = null | boolean | number | string | CanonicalJson[] | { [key: string]: CanonicalJson };

function normalizeCanonicalJson(value: unknown, path = "$"): CanonicalJson {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`canonical JSON refuses non-finite number at ${path}`);
    return value;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      if (!Object.hasOwn(value, index)) throw new Error(`canonical JSON refuses sparse array slot at ${path}[${index}]`);
    }
    return value.map((item, index) => normalizeCanonicalJson(item, `${path}[${index}]`));
  }
  if (typeof value !== "object") throw new Error(`canonical JSON refuses ${typeof value} at ${path}`);
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`canonical JSON requires a plain object at ${path}`);
  }
  const symbols = Object.getOwnPropertySymbols(value);
  if (symbols.length > 0) throw new Error(`canonical JSON refuses symbol-keyed property at ${path}`);

  const out: { [key: string]: CanonicalJson } = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const child = (value as Record<string, unknown>)[key];
    if (child === undefined) throw new Error(`canonical JSON refuses undefined at ${path}.${key}`);
    out[key] = normalizeCanonicalJson(child, `${path}.${key}`);
  }
  return out;
}

/** Stable JSON for hashes persisted in Postgres. Object keys sort recursively;
 * array order remains meaningful and must be normalized by the domain builder. */
export function canonicalJsonString(value: unknown): string {
  return JSON.stringify(normalizeCanonicalJson(value));
}

export function canonicalSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJsonString(value), "utf8").digest("hex");
}

function nonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`wallet snapshot manifest requires ${field}`);
  return normalized;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function exactCanonicalKeys(keys: readonly string[], field: string): string[] {
  const normalized = keys.map((key, index) => nonEmpty(key, `${field}[${index}]`)).sort(compareText);
  const duplicate = normalized.find((key, index) => index > 0 && key === normalized[index - 1]);
  if (duplicate) throw new Error(`wallet snapshot manifest contains duplicate ${field} key: ${duplicate}`);
  return normalized;
}

export interface CanonicalWalletBalanceAsset {
  symbol: string;
  address: string | null;
  decimals: number;
  valuationKind: TrackedAsset["valuationKind"];
  priceKind: TrackedAsset["priceKind"];
  poolId: string | null;
}

export interface CanonicalWalletSleeveKey {
  walletIndex: number;
  walletAddress: string;
  symbol: string;
}

export interface CanonicalWalletSnapshotManifest {
  manifestVersion: string;
  valuationPolicyVersion: string;
  configIdentity: string;
  balanceAssets: CanonicalWalletBalanceAsset[];
  sleeveKeys: CanonicalWalletSleeveKey[];
  expectedBalanceKeys: string[];
  expectedSleeveKeys: string[];
}

export interface BuildCanonicalWalletSnapshotManifestOptions {
  manifestVersion: string;
  valuationPolicyVersion: string;
  configIdentity: string;
}

/** Convert either publisher's resolved manifest to one deterministic envelope.
 * The caller decides which assets are expected (P0 still excludes config-valued
 * SP500); this function records that decision exactly and does not add/remove
 * assets on its own. */
export function buildCanonicalWalletSnapshotManifest(
  manifest: WalletSnapshotManifest,
  options: BuildCanonicalWalletSnapshotManifestOptions,
): { manifest: CanonicalWalletSnapshotManifest; manifestJson: string; manifestHash: string } {
  const balanceAssets = manifest.balanceAssets
    .map((asset) => {
      if (!Number.isSafeInteger(asset.decimals) || asset.decimals < 0) {
        throw new Error(`wallet snapshot manifest requires non-negative integer decimals for ${asset.symbol}`);
      }
      return {
        symbol: nonEmpty(asset.symbol, "balance asset symbol"),
        address: asset.address === null ? null : nonEmpty(asset.address, `${asset.symbol} address`).toLowerCase(),
        decimals: asset.decimals,
        valuationKind: asset.valuationKind,
        priceKind: asset.priceKind,
        poolId: asset.poolId === null ? null : nonEmpty(asset.poolId, `${asset.symbol} poolId`),
      };
    })
    .sort((a, b) => compareText(a.symbol, b.symbol));
  const sleeveKeys = manifest.sleeveKeys
    .map((key) => {
      if (!Number.isSafeInteger(key.walletIndex) || key.walletIndex < 0) {
        throw new Error("wallet snapshot manifest requires non-negative integer walletIndex");
      }
      return {
        walletIndex: key.walletIndex,
        walletAddress: nonEmpty(key.walletAddress, "sleeve wallet address").toLowerCase(),
        symbol: nonEmpty(key.asset.symbol, "sleeve symbol"),
      };
    })
    .sort((a, b) =>
      compareText(a.walletAddress, b.walletAddress)
      || compareText(a.symbol, b.symbol)
      || a.walletIndex - b.walletIndex,
    );

  const canonical: CanonicalWalletSnapshotManifest = {
    manifestVersion: nonEmpty(options.manifestVersion, "manifestVersion"),
    valuationPolicyVersion: nonEmpty(options.valuationPolicyVersion, "valuationPolicyVersion"),
    configIdentity: nonEmpty(options.configIdentity, "configIdentity"),
    balanceAssets,
    sleeveKeys,
    expectedBalanceKeys: exactCanonicalKeys(balanceAssets.map((asset) => asset.symbol), "balance"),
    expectedSleeveKeys: exactCanonicalKeys(
      sleeveKeys.map((key) => persistedSleeveManifestKey(key.walletAddress, key.symbol)),
      "sleeve",
    ),
  };
  const manifestJson = canonicalJsonString(canonical);
  return {
    manifest: canonical,
    manifestJson,
    manifestHash: createHash("sha256").update(manifestJson, "utf8").digest("hex"),
  };
}

export interface ExactSetValidation {
  expected: string[];
  present: string[];
  missing: string[];
  unexpected: string[];
  duplicateExpected: string[];
  duplicatePresent: string[];
  exact: boolean;
}

function uniqueAndDuplicates(values: readonly string[]): { unique: string[]; duplicates: string[] } {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return {
    unique: [...counts.keys()].sort(compareText),
    duplicates: [...counts.entries()].filter(([, count]) => count > 1).map(([value]) => value).sort(compareText),
  };
}

/** Exact-set grading shared by future live and historical publication paths.
 * Duplicates are failures even when unique-set equality happens to hold. */
export function validateExactSet(expectedValues: readonly string[], presentValues: readonly string[]): ExactSetValidation {
  const expected = uniqueAndDuplicates(expectedValues);
  const present = uniqueAndDuplicates(presentValues);
  const expectedSet = new Set(expected.unique);
  const presentSet = new Set(present.unique);
  const missing = expected.unique.filter((value) => !presentSet.has(value));
  const unexpected = present.unique.filter((value) => !expectedSet.has(value));
  return {
    expected: expected.unique,
    present: present.unique,
    missing,
    unexpected,
    duplicateExpected: expected.duplicates,
    duplicatePresent: present.duplicates,
    exact:
      missing.length === 0
      && unexpected.length === 0
      && expected.duplicates.length === 0
      && present.duplicates.length === 0,
  };
}

export interface WalletSnapshotExactValidation {
  balances: ExactSetValidation;
  sleeves: ExactSetValidation;
  exact: boolean;
}

export function validateWalletSnapshotExactSets(
  expected: Pick<CanonicalWalletSnapshotManifest, "expectedBalanceKeys" | "expectedSleeveKeys">,
  present: { balanceKeys: readonly string[]; sleeveKeys: readonly string[] },
): WalletSnapshotExactValidation {
  const balances = validateExactSet(expected.expectedBalanceKeys, present.balanceKeys);
  const sleeves = validateExactSet(expected.expectedSleeveKeys, present.sleeveKeys);
  return { balances, sleeves, exact: balances.exact && sleeves.exact };
}
