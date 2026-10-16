import {
  isPlaceholderAddress,
  resolvePropWallets,
  resolveTrackedAssets,
  type TrackedAsset,
} from "../config.ts";
import { SLEEVE_DEFS, sleeveSymbols } from "../chain/wallet-valuation.ts";
import type postgresTypes from "postgres";
import { onStatement, registerStatement } from "../db/registry.ts";

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
  await onStatement(db, snapshotDateLock)`SELECT pg_advisory_xact_lock(hashtext('wallet-aum-snapshot'), hashtext(${sampleDate}))`;
}

// Object-less (D55 (13)): an advisory lock names no relation.
const snapshotDateLock = registerStatement({
  role: "rm_worker",
  shape: "walletSnapshotLock",
  site: "src/ops/wallet-snapshot-manifest:lockWalletSnapshotDate",
  purpose: "Serialize every live sampler and historical repair writing one wallet snapshot date.",
  callers: ["src/worker/handlers/wallet", "src/worker/handlers/repair"],
});

export interface WalletSleeveManifestKey {
  walletIndex: number;
  walletAddress: string;
  asset: TrackedAsset;
}

/** The expected natural keys for one historical AUM snapshot.
 *
 * When `asOf` is supplied, only assets deployed on or before that date are
 * expected — so a March day that predates SP500's May 2026 addition is still
 * complete. Without `asOf` (the default), all currently configured assets are
 * expected, preserving backward compatibility for the operator surface and
 * live-sampler completeness checks. */
export interface WalletSnapshotManifest {
  balanceAssets: TrackedAsset[];
  sleeveKeys: WalletSleeveManifestKey[];
}

export function resolveWalletSnapshotManifest(
  assets: TrackedAsset[] = resolveTrackedAssets(),
  wallets: string[] = resolvePropWallets(),
  asOf?: string,
): WalletSnapshotManifest {
  const deployed = asOf
    ? assets.filter((a) => a.deployedAt <= asOf)
    : assets;
  const balanceAssets = deployed.filter((asset) => asset.valuationKind !== "config");
  const bySymbol = new Map(deployed.map((asset) => [asset.symbol, asset]));
  const sleeveKeys: WalletSleeveManifestKey[] = [];

  for (let walletIndex = 0; walletIndex < SLEEVE_DEFS.length && walletIndex < wallets.length; walletIndex++) {
    const walletAddress = wallets[walletIndex]!.toLowerCase();
    for (const symbol of sleeveSymbols(SLEEVE_DEFS[walletIndex]!)) {
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

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
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
