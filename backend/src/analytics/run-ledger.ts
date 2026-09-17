// Issue #977: pure types + canonicalization for the analytics run/vintage
// ledger. No I/O, no SQL — mirrors the source-ledger.ts / persistence.ts split
// (source-ledger.ts is pure evidence-shaping; store/source-ledger-store.ts is
// the SQL writer). The SQL writer for this module is
// store/run-ledger-store.ts.
import { createHash } from "node:crypto";

export type RunLifecycleEvent = "started" | "succeeded" | "degraded" | "failed";

// One frozen (source_key, market coordinate) observation, as selected by
// either typed selection operation in store/run-ledger-store.ts
// (loadCurrentSourceValues / loadHistoricalSourceValues). `versionId` is
// source_value_versions.id, carried as a string (Postgres bigint) end to end
// so no precision is lost.
export interface FrozenSourceValue {
  versionId: string;
  sourceKey: string;
  marketDate: string | null;
  marketInstant: string | null;
  value: number;
}

export interface MethodologyIdentity {
  toolId: string;
  versionLabel: string;
  config: Record<string, unknown>;
}

export interface VintageManifest {
  methodologyVersionId: string;
  buildIdentity: string;
  knowledgeTimeCutoff: string;
  marketTimeCutoff: string;
  seriesCount: number;
  memberCount: number;
  // sourceKey -> sha256 hex, each folding in methodologyVersionId +
  // buildIdentity (issue #977 AC4: a per-series fingerprint must also change
  // when either identity changes, not only the manifest digest).
  seriesFingerprints: Record<string, string>;
  manifestDigest: string;
}

export function sha256Hex(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// Deterministic JSON: every object's keys sorted, recursively. The ONLY
// mechanism that makes canonicalization independent of input array order is
// sorting the ARRAY of members before this is ever called (see
// sortedMembers/buildVintageManifest below) — this function alone only
// guarantees key order within one object.
export function canonicalStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  // A Date has to be a LEAF, checked before the generic object branch below:
  // Object.keys() on a Date instance is always [] (its instant lives in an
  // internal slot, not an enumerable own property), so recursing into it the
  // same way as a plain object silently rebuilds it as `{}` — discarding the
  // date entirely rather than canonicalizing it. Plain JSON.stringify never
  // has this problem (it calls Date.prototype.toJSON() before this function
  // ever runs), so anything that round-trips through an ORDINARY jsonb write
  // (postgres.js's .json(), used by every compatibility-table writer in this
  // repo) serializes a Date correctly while a naive canonicalStringify of the
  // exact same object silently zeroed it — found via issue #979's dual-write
  // parity check on a real published swarm brief (its embedded
  // `regime.date` is a raw Postgres Date).
  if (value instanceof Date) return value.toISOString();
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

// A total order over members that does not depend on input array order:
// (sourceKey, coordinate, versionId). `versionId` (a Postgres bigint,
// unbounded digit count) is zero-padded wide enough for any real id before
// lexical comparison, so "10" never sorts before "9".
//
// '|' is the field separator, deliberately a PRINTABLE character: a literal
// NUL here would make this whole file diff as binary in git, so it could
// never be reviewed in a pull request. It cannot collide, because the two
// trailing fields are fixed-format (a date/ISO instant, then digits only) —
// no component ever contains '|'.
function memberSortKey(m: FrozenSourceValue): string {
  const coordinate = m.marketDate ?? m.marketInstant ?? "";
  return `${m.sourceKey}|${coordinate}|${m.versionId.padStart(24, "0")}`;
}

export function sortedMembers(members: readonly FrozenSourceValue[]): FrozenSourceValue[] {
  return [...members].sort((a, b) => {
    const ka = memberSortKey(a);
    const kb = memberSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

/**
 * Build the canonical vintage manifest + its digest from a frozen member set.
 * Deterministic regardless of `members`' input order (issue #977 AC4):
 * every member is sorted before anything is hashed. The manifest — and every
 * per-series fingerprint — changes if any selected `versionId`, `marketDate`/
 * `marketInstant` coordinate, `value`, `methodologyVersionId`, or
 * `buildIdentity` changes.
 */
export function buildVintageManifest(
  members: readonly FrozenSourceValue[],
  methodologyVersionId: string,
  buildIdentity: string,
  knowledgeTimeCutoff: string,
  marketTimeCutoff: string,
): { manifest: VintageManifest; manifestBytes: string } {
  const sorted = sortedMembers(members);
  const bySeries = new Map<string, FrozenSourceValue[]>();
  for (const m of sorted) {
    const list = bySeries.get(m.sourceKey);
    if (list) list.push(m);
    else bySeries.set(m.sourceKey, [m]);
  }

  const seriesFingerprints: Record<string, string> = {};
  for (const sourceKey of [...bySeries.keys()].sort()) {
    const points = bySeries.get(sourceKey)!.map((p) => ({
      coordinate: p.marketDate ?? p.marketInstant,
      versionId: p.versionId,
      value: p.value,
    }));
    const seriesPayload = canonicalStringify({ sourceKey, methodologyVersionId, buildIdentity, points });
    seriesFingerprints[sourceKey] = sha256Hex(seriesPayload);
  }

  // Normalized to ISO-8601 before hashing (issue #977 AC7): the cutoff this
  // function is called with at freeze time is a JS Date's ISO string, but a
  // vintage reloaded from Postgres gets its knowledge_time_cutoff back via a
  // ::text cast, which prints timestamptz in Postgres's OWN format, not
  // ISO-8601 — same instant, different bytes. Hashing the raw string would
  // make a byte-for-bit replay comparison fail for a reason that has nothing
  // to do with the frozen selection. `new Date(...).toISOString()` collapses
  // every equivalent representation of the same instant to one canonical
  // string before it ever reaches the hash.
  const normalizedKnowledgeTimeCutoff = new Date(knowledgeTimeCutoff).toISOString();
  const manifestCore = {
    methodologyVersionId,
    buildIdentity,
    knowledgeTimeCutoff: normalizedKnowledgeTimeCutoff,
    marketTimeCutoff,
    seriesCount: bySeries.size,
    memberCount: sorted.length,
    seriesFingerprints,
  };
  const manifestBytes = canonicalStringify(manifestCore);
  const manifestDigest = sha256Hex(manifestBytes);
  return { manifest: { ...manifestCore, manifestDigest }, manifestBytes };
}

export function configDigest(config: Record<string, unknown>): string {
  return sha256Hex(canonicalStringify(config));
}
