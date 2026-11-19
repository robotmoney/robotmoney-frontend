// Store stage: the server-side GAP-FILL write for raw-floor seed ingestion
// (issues #13/#106). Given an already-parsed seed (the vendored floor, or the
// EDGAR seed a follow-up submits through POST /api/analytics/raw-history/seed),
// write ONLY the (date, indicator) points not already persisted. Existing rows
// are never overwritten (the DB floor wins on overlap → the honest append-only
// semantics of mergeSeries), which makes seeding idempotent: a second run finds
// every date present, writes nothing, and is a no-op.
//
// LEDGER ROWS (AN-16). Every point the seed writes is also recorded in the
// source ledger (source_value_versions) under its raw_indicator_history key, in
// the same transaction, as one 'seed' acquisition per indicator. The regime run
// computes from the ledger heads its vintage pins, so a seeded point is never a
// raw-only input.
//
// RATIOS AND LEGS (issue 1644). A ratio declared ratioInput "stored" is written
// as before; one declared "legs" is not. A ratio leg (`yahoo:<SYMBOL>.close`,
// `yahoo:<SYMBOL>.adjclose`) is source data with no raw_indicator_history row:
// it is written to the source ledger only, under its key, for every date the
// ledger holds no version of (writeMissingLedgerVersions, shared with
// scripts/ratio-legs-backfill.ts).
//
// API-OWNED (issue #106): only the API process and migration/smoke tooling may
// import this module; updaters submit seeds through the AnalyticsPersistence
// port. File PARSING of the vendored seed lives in extract/floor-seed.ts (pure).
import { randomUUID } from "node:crypto";
import type { TransactionSql } from "postgres";
import { sql, type DbHandle } from "../../db/client.ts";
import {
  loadRawIndicatorHistory,
  saveRawIndicatorHistory,
} from "./raw-history-store.ts";
import { saveSourceAcquisition } from "./source-ledger-store.ts";
import { rawIndicatorSourceKey } from "../source-tolerance.ts";
import { RATIO_IDS, RATIO_LEG_KEYS, STORED_RATIO_IDS } from "../extras.ts";
import { loadCommittedInputs } from "./run-ledger-store.ts";
import type { RawIndicatorHistory } from "../types.ts";
import type { FloorSeedResult } from "../persistence.ts";
export type { FloorSeedResult };

export async function applyRawFloorSeed(
  seed: RawIndicatorHistory,
  db: DbHandle = sql,
): Promise<FloorSeedResult> {
  // The raw rows and their ledger rows commit together: inside the caller's
  // transaction when it passes one (the route, direct.ts), else in a new one.
  if (!("savepoint" in db)) return (db as typeof sql).begin((tx) => applyRawFloorSeed(seed, tx));
  const tx = db as TransactionSql<{}>;
  const existing = await loadRawIndicatorHistory(tx);

  const toWrite: RawIndicatorHistory = {};
  const legs: RawIndicatorHistory = {};
  let seededPoints = 0;
  let existingPoints = 0;
  for (const [id, pts] of Object.entries(seed)) {
    if (RATIO_IDS.has(id) && !STORED_RATIO_IDS.has(id)) continue;
    if (RATIO_LEG_KEYS.has(id)) {
      legs[id] = pts;
      continue;
    }
    const have = new Set((existing[id] ?? []).map((p) => p.date));
    const missing = pts.filter((p) => !have.has(p.date));
    existingPoints += pts.length - missing.length;
    if (missing.length) {
      toWrite[id] = missing;
      seededPoints += missing.length;
    }
  }

  // Tag every gap-fill row 'seed' (issue #397): this is vendored real history,
  // not a fresh live/hermetic/fixture fetch from THIS run.
  await saveRawIndicatorHistory(toWrite, tx, "seed");
  for (const [id, pts] of Object.entries(toWrite)) {
    const sourceKey = rawIndicatorSourceKey(id);
    await saveSourceAcquisition({
      id: randomUUID(),
      provider: "seed",
      parserVersion: "floor-seed:1",
      cacheIdentity: sourceKey,
      requestedByRunId: null,
      events: [{ type: "started", detail: null }, { type: "succeeded", detail: null }],
      fetches: [],
      values: pts.filter((p) => Number.isFinite(p.value)).map((p) => ({ sourceKey, marketDate: p.date, marketInstant: null, value: p.value, provenance: "seed" })),
    }, tx);
  }
  const legsWritten = await writeMissingLedgerVersions(legs, { provider: "seed", parserVersion: "floor-seed:1", provenance: "seed" }, tx);
  let legKeys = 0;
  for (const [key, n] of Object.entries(legsWritten.written)) {
    seededPoints += n;
    if (n > 0) legKeys++;
  }
  existingPoints += legsWritten.existing;
  return { seededPoints, existingPoints, indicators: Object.keys(toWrite).length + legKeys };
}

export interface LedgerGapFillResult {
  /** Versions written per source key. */
  written: Record<string, number>;
  /** Points skipped because their (key, date) already has a version. */
  existing: number;
}

/**
 * Write one source_value_versions row for every (key, date) of `byKey` that
 * has no version yet, one acquisition per key. A (key, date) that has a
 * version is never touched, so a second call writes nothing. knowledge_time is
 * the column default, the database clock at write time: no earlier run or
 * vintage can appear to have read a row written here (issue 1644).
 */
export async function writeMissingLedgerVersions(
  byKey: RawIndicatorHistory,
  meta: { provider: string; parserVersion: string; provenance: string },
  db: DbHandle = sql,
): Promise<LedgerGapFillResult> {
  if (!("savepoint" in db)) return (db as typeof sql).begin((tx) => writeMissingLedgerVersions(byKey, meta, tx));
  const tx = db as TransactionSql<{}>;
  const keys = Object.keys(byKey);
  const result: LedgerGapFillResult = { written: {}, existing: 0 };
  if (keys.length === 0) return result;
  const have = new Set((await loadCommittedInputs(keys, "9999-12-31", tx)).values.map((v) => `${v.sourceKey}|${v.marketDate}`));
  for (const key of keys) {
    const missing = byKey[key]!.filter((p) => Number.isFinite(p.value) && !have.has(`${key}|${p.date}`));
    result.existing += byKey[key]!.length - missing.length;
    result.written[key] = missing.length;
    if (missing.length === 0) continue;
    await saveSourceAcquisition({
      id: randomUUID(),
      provider: meta.provider,
      parserVersion: meta.parserVersion,
      cacheIdentity: key,
      requestedByRunId: null,
      events: [{ type: "started", detail: null }, { type: "succeeded", detail: null }],
      fetches: [],
      values: missing.map((p) => ({ sourceKey: key, marketDate: p.date, marketInstant: null, value: p.value, provenance: meta.provenance })),
    }, tx);
  }
  return result;
}
