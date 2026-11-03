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
  let seededPoints = 0;
  let existingPoints = 0;
  for (const [id, pts] of Object.entries(seed)) {
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
  return { seededPoints, existingPoints, indicators: Object.keys(toWrite).length };
}
