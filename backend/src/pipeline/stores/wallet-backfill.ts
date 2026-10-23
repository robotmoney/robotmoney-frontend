// The wallet repair pass's reads and writes, run by the api for the pipeline
// worker (issue 1034, decision D75). ops/wallet-backfill.ts resolves blocks,
// reads the chain and loads prices; every statement here is one that module
// used to run on the worker's own pool. The day write (writeRepairedDay) is the
// same one transaction it always was: lock, archive, replace, supersede, prove
// complete, checkpoint.
import { on, registerQuery, type RegistryDb } from "../../db/registry.ts";
import type { CachedDayBlockProof } from "../../chain/block-resolver.ts";
import { QUARANTINED_PROVENANCE } from "../../chain/wallet-valuation.ts";
import { detectGaps, type GapReport } from "../../ops/gap-detector.ts";
import { getSeriesDef, SERIES_REGISTRY } from "../../ops/series-registry.ts";
import { sleeveManifestKey } from "../../ops/wallet-snapshot-manifest.ts";
import { writeAssetPrice } from "../../ops/asset-prices.ts";
import { assetPricesDisagree, type AssetPriceDisagreement } from "../../ops/asset-price-types.ts";
import type {
  BackfillDayStatus,
  ManifestKeys,
  PlanStateRow,
  PriorStateRow,
  RepairedDayResult,
  RepairedDayWrite,
  WalletBackfillStore,
  WalletSnapshotCompleteness,
} from "../../ops/wallet-backfill.ts";
import { lockWalletSnapshotDate } from "./wallet-snapshot-lock.ts";

// Every statement here is the repair pass's (D55 (6): it upserts and
// supersedes, it never deletes), reached through the pipeline routes.
const PIPELINE_ROUTE = ["src/api/routes/pipeline"];

const readDayBlock = registerQuery({
  role: "rm_app",
  object: "chain_day_blocks",
  privileges: ["SELECT"],
  site: "src/pipeline/stores/wallet-backfill:dayBlockGet",
  purpose: "Read the permanent block proof for a sample date.",
  callers: PIPELINE_ROUTE,
  probe: {
    statement: `SELECT block_number, block_hash, block_timestamp,
               boundary_next_block_number, boundary_next_block_hash,
               boundary_next_block_timestamp
          FROM chain_day_blocks
         WHERE sample_date = $1::date`,
    params: ["2000-01-01"],
  },
});

const writeDayBlock = registerQuery({
  role: "rm_app",
  object: "chain_day_blocks",
  privileges: ["INSERT", "UPDATE", "SELECT"],
  site: "src/pipeline/stores/wallet-backfill:dayBlockSet",
  purpose: "Record or replace the permanent block proof for a sample date.",
  callers: PIPELINE_ROUTE,
  probe: {
    statement: `INSERT INTO chain_day_blocks
          (sample_date, block_number, block_hash, block_timestamp,
           boundary_next_block_number, boundary_next_block_hash,
           boundary_next_block_timestamp)
        SELECT $1::date, $2::bigint, $3, $4::timestamptz, $5::bigint, $6, $7::timestamptz WHERE false
        ON CONFLICT (sample_date) DO UPDATE SET
          block_number = EXCLUDED.block_number,
          block_hash = EXCLUDED.block_hash,
          block_timestamp = EXCLUDED.block_timestamp,
          boundary_next_block_number = EXCLUDED.boundary_next_block_number,
          boundary_next_block_hash = EXCLUDED.boundary_next_block_hash,
          boundary_next_block_timestamp = EXCLUDED.boundary_next_block_timestamp,
          resolved_at = now()`,
    params: ["2000-01-01", 1, "probe", "2000-01-01T00:00:00Z", null, null, null],
  },
});

const readAddressFloor = registerQuery({
  role: "rm_app",
  object: "chain_address_floors",
  privileges: ["SELECT"],
  site: "src/pipeline/stores/wallet-backfill:addressFloorGet",
  purpose: "Read the permanent first-code block for an address.",
  callers: PIPELINE_ROUTE,
  probe: {
    statement: `SELECT floor_block FROM chain_address_floors WHERE address = $1`,
    params: ["probe"],
  },
});

const writeAddressFloor = registerQuery({
  role: "rm_app",
  object: "chain_address_floors",
  privileges: ["INSERT", "UPDATE", "SELECT"],
  site: "src/pipeline/stores/wallet-backfill:addressFloorSet",
  purpose: "Record or advance the permanent first-code block for an address.",
  callers: PIPELINE_ROUTE,
  probe: {
    statement: `INSERT INTO chain_address_floors (address, floor_block)
        SELECT $1, $2::bigint WHERE false
        ON CONFLICT (address) DO UPDATE SET
          floor_block = EXCLUDED.floor_block,
          resolved_at = now()`,
    params: ["probe", 1],
  },
});

// counts-quarantined: DELIBERATE — this statement reads quarantined rows as evidence, never as coverage.
const inspectBalances = registerQuery({
  role: "rm_app",
  object: "wallet_balance_samples",
  privileges: ["SELECT"],
  site: "src/pipeline/stores/wallet-backfill:inspectSnapshot.balances",
  purpose: "Read a day's live balance rows to judge the snapshot complete.",
  callers: PIPELINE_ROUTE,
  probe: {
    statement: `SELECT symbol, provenance
      FROM wallet_balance_samples
     WHERE sample_date = $1::date
       AND superseded_at IS NULL`,
    params: ["2000-01-01"],
  },
});

// counts-quarantined: DELIBERATE — this statement reads quarantined rows as evidence, never as coverage.
const inspectBalancesLocked = registerQuery({
  role: "rm_app",
  object: "wallet_balance_samples",
  privileges: ["SELECT", "UPDATE"],
  site: "src/pipeline/stores/wallet-backfill:inspectSnapshot.balancesLocked",
  purpose: "Read and row-lock a day's live balance rows before their values are archived.",
  callers: PIPELINE_ROUTE,
  probe: {
    statement: `SELECT symbol, provenance
      FROM wallet_balance_samples
     WHERE sample_date = $1::date
       AND superseded_at IS NULL
     FOR UPDATE`,
    params: ["2000-01-01"],
  },
});

// counts-quarantined: DELIBERATE — this statement reads quarantined rows as evidence, never as coverage.
const inspectSleeves = registerQuery({
  role: "rm_app",
  object: "wallet_sleeve_samples",
  privileges: ["SELECT"],
  site: "src/pipeline/stores/wallet-backfill:inspectSnapshot.sleeves",
  purpose: "Read a day's live sleeve rows to judge the snapshot complete.",
  callers: PIPELINE_ROUTE,
  probe: {
    statement: `SELECT wallet_address, symbol, provenance
      FROM wallet_sleeve_samples
     WHERE sample_date = $1::date
       AND superseded_at IS NULL`,
    params: ["2000-01-01"],
  },
});

// counts-quarantined: DELIBERATE — this statement reads quarantined rows as evidence, never as coverage.
const inspectSleevesLocked = registerQuery({
  role: "rm_app",
  object: "wallet_sleeve_samples",
  privileges: ["SELECT", "UPDATE"],
  site: "src/pipeline/stores/wallet-backfill:inspectSnapshot.sleevesLocked",
  purpose: "Read and row-lock a day's live sleeve rows before their values are archived.",
  callers: PIPELINE_ROUTE,
  probe: {
    statement: `SELECT wallet_address, symbol, provenance
      FROM wallet_sleeve_samples
     WHERE sample_date = $1::date
       AND superseded_at IS NULL
     FOR UPDATE`,
    params: ["2000-01-01"],
  },
});

const deferDayUpdateSql = registerQuery({
  role: "rm_app",
  object: "wallet_backfill_state",
  privileges: ["UPDATE", "SELECT"],
  site: "src/pipeline/stores/wallet-backfill:deferDayUpdate",
  purpose: "Record a deferred day's status without charging its attempt.",
  callers: PIPELINE_ROUTE,
  probe: {
    statement: `UPDATE wallet_backfill_state
       SET status = $1, block_number = $2::bigint, detail = $3, attempted_at = now()
     WHERE sample_date = $4::date`,
    params: ["failed", null, "probe", "2000-01-01"],
  },
});

const bumpStreak = registerQuery({
  role: "rm_app",
  object: "wallet_backfill_state",
  privileges: ["INSERT", "UPDATE", "SELECT"],
  site: "src/pipeline/stores/wallet-backfill:bumpDeferStreak",
  purpose: "Advance or start a day's shared-leg consecutive-refusal streak.",
  callers: PIPELINE_ROUTE,
  probe: {
    statement: `INSERT INTO wallet_backfill_state (sample_date, status, defer_leg, defer_streak, defer_leg_at)
    SELECT $1::date, 'failed', $2::text, 1, $3::timestamptz WHERE false
    ON CONFLICT (sample_date) DO UPDATE SET
      defer_streak = CASE
        WHEN wallet_backfill_state.defer_leg IS DISTINCT FROM $2::text THEN 1
        WHEN wallet_backfill_state.defer_leg_at IS NOT NULL
             AND wallet_backfill_state.defer_leg_at > $3::timestamptz - ($4::text || ' milliseconds')::interval
          THEN wallet_backfill_state.defer_streak
        ELSE wallet_backfill_state.defer_streak + 1
      END,
      defer_leg = $2::text,
      defer_leg_at = CASE
        WHEN wallet_backfill_state.defer_leg IS DISTINCT FROM $2::text THEN $3::timestamptz
        WHEN wallet_backfill_state.defer_leg_at IS NOT NULL
             AND wallet_backfill_state.defer_leg_at > $3::timestamptz - ($4::text || ' milliseconds')::interval
          THEN wallet_backfill_state.defer_leg_at
        ELSE $3::timestamptz
      END
    RETURNING defer_streak`,
    params: ["2000-01-01", "probe", "2000-01-01T00:00:00Z", 1000],
  },
});

const readPlanState = registerQuery({
  role: "rm_app",
  object: "wallet_backfill_state",
  privileges: ["SELECT"],
  site: "src/pipeline/stores/wallet-backfill:planWalletBackfill.state",
  purpose: "Read every day's checkpoint for the repair plan.",
  callers: PIPELINE_ROUTE,
  probe: {
    statement: `SELECT sample_date, status, defer_leg, defer_leg_at, detail FROM wallet_backfill_state`,
  },
});

const readPriorState = registerQuery({
  role: "rm_app",
  object: "wallet_backfill_state",
  privileges: ["SELECT"],
  site: "src/pipeline/stores/wallet-backfill:priorState",
  purpose: "Read the settled checkpoints of the days in this window.",
  callers: PIPELINE_ROUTE,
  probe: {
    statement: `SELECT sample_date::text AS sample_date, status, block_number, balance_rows, sleeve_rows, detail
      FROM wallet_backfill_state
     WHERE sample_date = ANY($1::date[])
       AND status IN ('filled', 'skipped', 'exhausted')`,
    params: ["{}"],
  },
});

const readExistingState = registerQuery({
  role: "rm_app",
  object: "wallet_backfill_state",
  privileges: ["SELECT"],
  site: "src/pipeline/stores/wallet-backfill:writeRepairedDay.existingState",
  purpose: "Read one day's checkpoint status inside the write transaction.",
  callers: PIPELINE_ROUTE,
  probe: {
    statement: `SELECT status FROM wallet_backfill_state WHERE sample_date = $1::date`,
    params: ["2000-01-01"],
  },
});

// counts-quarantined: DELIBERATE — this statement reads quarantined rows as evidence, never as coverage.
const EVIDENCE_BALANCES_PROBE = {
  statement: `INSERT INTO wallet_balance_sample_evidence
            (original_id, sample_date, symbol, amount, price_usd, value_usd,
             provenance, sampled_at, strategy_nav_idle_only, evidence_reason,
             replacement_block_number, snapshot_run_id, amount_observed_at,
             price_observed_at, recorded_at)
          SELECT id, sample_date, symbol, amount, price_usd, value_usd,
                 provenance, sampled_at, strategy_nav_idle_only,
                 CASE WHEN provenance = $1
                      THEN 'quarantined-replacement'
                      ELSE 'incomplete-snapshot-replacement' END,
                 $2::bigint, snapshot_run_id, amount_observed_at,
                 price_observed_at, recorded_at
            FROM wallet_balance_samples
           WHERE sample_date = $3::date
             AND superseded_at IS NULL`,
    params: [QUARANTINED_PROVENANCE, 1, "2000-01-01"],
} as const;

const evidenceBalances = registerQuery({
  role: "rm_app",
  object: "wallet_balance_sample_evidence",
  privileges: ["INSERT"],
  site: "src/pipeline/stores/wallet-backfill:writeRepairedDay.evidenceBalances",
  purpose: "Archive every live balance row before it is rewritten or superseded.",
  callers: PIPELINE_ROUTE,
  probe: EVIDENCE_BALANCES_PROBE,
});

const evidenceBalancesSource = registerQuery({
  role: "rm_app",
  object: "wallet_balance_samples",
  privileges: ["SELECT"],
  site: "src/pipeline/stores/wallet-backfill:writeRepairedDay.evidenceBalancesSource",
  purpose: "Read the live balance rows the evidence copy archives.",
  callers: PIPELINE_ROUTE,
  probe: EVIDENCE_BALANCES_PROBE,
});

// counts-quarantined: DELIBERATE — this statement reads quarantined rows as evidence, never as coverage.
const EVIDENCE_SLEEVES_PROBE = {
  statement: `INSERT INTO wallet_sleeve_sample_evidence
            (original_id, sample_date, wallet_address, symbol, amount, price_usd,
             value_usd, provenance, sampled_at, evidence_reason,
             replacement_block_number, snapshot_run_id, amount_observed_at,
             price_observed_at, recorded_at)
          SELECT id, sample_date, wallet_address, symbol, amount, price_usd,
                 value_usd, provenance, sampled_at,
                 CASE WHEN provenance = $1
                      THEN 'quarantined-replacement'
                      ELSE 'incomplete-snapshot-replacement' END,
                 $2::bigint, snapshot_run_id, amount_observed_at,
                 price_observed_at, recorded_at
            FROM wallet_sleeve_samples
           WHERE sample_date = $3::date
             AND superseded_at IS NULL`,
    params: [QUARANTINED_PROVENANCE, 1, "2000-01-01"],
} as const;

const evidenceSleeves = registerQuery({
  role: "rm_app",
  object: "wallet_sleeve_sample_evidence",
  privileges: ["INSERT"],
  site: "src/pipeline/stores/wallet-backfill:writeRepairedDay.evidenceSleeves",
  purpose: "Archive every live sleeve row before it is rewritten or superseded.",
  callers: PIPELINE_ROUTE,
  probe: EVIDENCE_SLEEVES_PROBE,
});

const evidenceSleevesSource = registerQuery({
  role: "rm_app",
  object: "wallet_sleeve_samples",
  privileges: ["SELECT"],
  site: "src/pipeline/stores/wallet-backfill:writeRepairedDay.evidenceSleevesSource",
  purpose: "Read the live sleeve rows the evidence copy archives.",
  callers: PIPELINE_ROUTE,
  probe: EVIDENCE_SLEEVES_PROBE,
});

const readPriorSamples = registerQuery({
  role: "rm_app",
  object: "wallet_balance_samples",
  privileges: ["SELECT"],
  site: "src/pipeline/stores/wallet-backfill:writeRepairedDay.priorSamples",
  purpose: "Read the prices a prior pass wrote for a day, to report a disagreement.",
  callers: PIPELINE_ROUTE,
  probe: {
    statement: `SELECT symbol, price_usd FROM wallet_balance_samples
           WHERE sample_date = $1::date AND provenance <> $2
             AND superseded_at IS NULL`,
    params: ["2000-01-01", QUARANTINED_PROVENANCE],
  },
});

const upsertBalance = registerQuery({
  role: "rm_app",
  object: "wallet_balance_samples",
  privileges: ["INSERT", "UPDATE", "SELECT"],
  site: "src/pipeline/stores/wallet-backfill:writeRepairedDay.upsertBalance",
  purpose: "Replace a day's balance row in place on its natural key (D55 (6)).",
  callers: PIPELINE_ROUTE,
  probe: {
    statement: `INSERT INTO wallet_balance_samples
              (sample_date, symbol, amount, value_usd, provenance, sampled_at)
            SELECT $1::date, $2, $3::numeric, $4::numeric, 'backfilled', $5::timestamptz WHERE false
            ON CONFLICT (sample_date, symbol) DO UPDATE SET
              id                     = EXCLUDED.id,
              amount                 = EXCLUDED.amount,
              price_usd              = EXCLUDED.price_usd,
              value_usd              = EXCLUDED.value_usd,
              provenance             = EXCLUDED.provenance,
              sampled_at             = EXCLUDED.sampled_at,
              strategy_nav_idle_only = EXCLUDED.strategy_nav_idle_only,
              snapshot_run_id        = EXCLUDED.snapshot_run_id,
              amount_observed_at     = EXCLUDED.amount_observed_at,
              price_observed_at      = EXCLUDED.price_observed_at,
              recorded_at            = EXCLUDED.recorded_at,
              superseded_at          = EXCLUDED.superseded_at`,
    params: ["2000-01-01", "probe", 1, 1, "2000-01-01T00:00:00Z"],
  },
});

const upsertSleeve = registerQuery({
  role: "rm_app",
  object: "wallet_sleeve_samples",
  privileges: ["INSERT", "UPDATE", "SELECT"],
  site: "src/pipeline/stores/wallet-backfill:writeRepairedDay.upsertSleeve",
  purpose: "Replace a day's sleeve row in place on its natural key (D55 (6)).",
  callers: PIPELINE_ROUTE,
  probe: {
    statement: `INSERT INTO wallet_sleeve_samples
              (sample_date, wallet_address, symbol, amount, value_usd, provenance, sampled_at)
            SELECT $1::date, $2, $3, $4::numeric, $5::numeric, 'backfilled', $6::timestamptz WHERE false
            ON CONFLICT (sample_date, wallet_address, symbol) DO UPDATE SET
              id                 = EXCLUDED.id,
              amount             = EXCLUDED.amount,
              price_usd          = EXCLUDED.price_usd,
              value_usd          = EXCLUDED.value_usd,
              provenance         = EXCLUDED.provenance,
              sampled_at         = EXCLUDED.sampled_at,
              snapshot_run_id    = EXCLUDED.snapshot_run_id,
              amount_observed_at = EXCLUDED.amount_observed_at,
              price_observed_at  = EXCLUDED.price_observed_at,
              recorded_at        = EXCLUDED.recorded_at,
              superseded_at      = EXCLUDED.superseded_at`,
    params: ["2000-01-01", "probe", "probe", 1, 1, "2000-01-01T00:00:00Z"],
  },
});

const supersedeBalances = registerQuery({
  role: "rm_app",
  object: "wallet_balance_samples",
  privileges: ["UPDATE", "SELECT"],
  site: "src/pipeline/stores/wallet-backfill:writeRepairedDay.supersedeBalances",
  purpose: "Supersede the day's live balance rows this pass did not write (D55 (6)).",
  callers: PIPELINE_ROUTE,
  probe: {
    statement: `UPDATE wallet_balance_samples
             SET superseded_at = now()
           WHERE sample_date = $1::date
             AND superseded_at IS NULL
             AND symbol <> ALL($2::text[])`,
    params: ["2000-01-01", "{}"],
  },
});

const supersedeSleeves = registerQuery({
  role: "rm_app",
  object: "wallet_sleeve_samples",
  privileges: ["UPDATE", "SELECT"],
  site: "src/pipeline/stores/wallet-backfill:writeRepairedDay.supersedeSleeves",
  purpose: "Supersede the day's live sleeve rows this pass did not write (D55 (6)).",
  callers: PIPELINE_ROUTE,
  probe: {
    statement: `UPDATE wallet_sleeve_samples AS s
             SET superseded_at = now()
           WHERE s.sample_date = $1::date
             AND s.superseded_at IS NULL
             AND NOT EXISTS (
                   SELECT 1
                     FROM unnest($2::text[], $3::text[])
                          AS w(wallet_address, symbol)
                    WHERE w.wallet_address = s.wallet_address
                      AND w.symbol = s.symbol
                 )`,
    params: ["2000-01-01", "{}", "{}"],
  },
});

const writeFilledState = registerQuery({
  role: "rm_app",
  object: "wallet_backfill_state",
  privileges: ["INSERT", "UPDATE", "SELECT"],
  site: "src/pipeline/stores/wallet-backfill:writeRepairedDay.writeState",
  purpose: "Commit a day's checkpoint with the rows that produced it.",
  callers: PIPELINE_ROUTE,
  probe: {
    statement: `INSERT INTO wallet_backfill_state
          (sample_date, status, block_number, balance_rows, sleeve_rows, detail, attempted_at, defer_leg, defer_streak, defer_leg_at)
        SELECT $1::date, $2, $3::bigint, $4::integer, $5::integer, $6, now(), NULL, 0, NULL WHERE false
        ON CONFLICT (sample_date) DO UPDATE SET
          status       = EXCLUDED.status,
          block_number = EXCLUDED.block_number,
          balance_rows = EXCLUDED.balance_rows,
          sleeve_rows  = EXCLUDED.sleeve_rows,
          detail       = EXCLUDED.detail,
          attempted_at = EXCLUDED.attempted_at,
          defer_leg    = NULL,
          defer_streak = 0,
          defer_leg_at = NULL`,
    params: ["2000-01-01", "filled", 1, 1, 1, null],
  },
});

const readAttempts = registerQuery({
  role: "rm_app",
  object: "wallet_backfill_state",
  privileges: ["SELECT"],
  site: "src/pipeline/stores/wallet-backfill:readAttempts",
  purpose: "Read a day's attempt counter.",
  callers: PIPELINE_ROUTE,
  probe: {
    statement: `SELECT attempts FROM wallet_backfill_state WHERE sample_date = $1::date`,
    params: ["2000-01-01"],
  },
});

const recordStateUpsert = registerQuery({
  role: "rm_app",
  object: "wallet_backfill_state",
  privileges: ["INSERT", "UPDATE", "SELECT"],
  site: "src/pipeline/stores/wallet-backfill:recordState",
  purpose: "Checkpoint a day that produced no rows.",
  callers: PIPELINE_ROUTE,
  probe: {
    statement: `INSERT INTO wallet_backfill_state
      (sample_date, status, block_number, balance_rows, sleeve_rows, attempts, detail, attempted_at, defer_leg, defer_streak, defer_leg_at)
    SELECT $1::date, $2, $3::bigint, $4::integer, $5::integer, $6::integer, $7, now(), NULL, 0, NULL WHERE false
    ON CONFLICT (sample_date) DO UPDATE SET
      status       = EXCLUDED.status,
      block_number = EXCLUDED.block_number,
      balance_rows = EXCLUDED.balance_rows,
      sleeve_rows  = EXCLUDED.sleeve_rows,
      attempts     = COALESCE($8::integer, wallet_backfill_state.attempts),
      detail       = EXCLUDED.detail,
      attempted_at = EXCLUDED.attempted_at,
      defer_leg    = NULL,
      defer_streak = 0,
      defer_leg_at = NULL`,
    params: ["2000-01-01", "failed", null, 0, 0, 0, null, null],
  },
});



// ── Gap reports and the plan's checkpoints ──────────────────────────────────

/**
 * The gap detector's reports for `keys` (every registered series when null),
 * as of `now` (`gaps.reports`). The repair dispatcher and the plan read the
 * same detector the operator surface does (markets §4.1).
 */
export async function gapReports(db: RegistryDb, keys: readonly string[] | null, now: Date): Promise<GapReport[]> {
  const defs = keys === null ? SERIES_REGISTRY : keys.map((k) => getSeriesDef(k)).filter((d) => d !== undefined);
  return Promise.all(defs.map((def) => detectGaps(def!, db, now)));
}

/** Every day's checkpoint, for the repair plan (`wallet_backfill.plan_state`). */
export async function planState(db: RegistryDb): Promise<PlanStateRow[]> {
  return [...await on(db, readPlanState)<PlanStateRow>`
    SELECT sample_date, status, defer_leg, defer_leg_at, detail FROM wallet_backfill_state
  `];
}

/** The settled checkpoints of `dates` (`wallet_backfill.prior_state`). */
export async function priorState(db: RegistryDb, dates: readonly string[]): Promise<PriorStateRow[]> {
  return [...await on(db, readPriorState)<PriorStateRow>`
    SELECT sample_date::text AS sample_date, status, block_number, balance_rows, sleeve_rows, detail
      FROM wallet_backfill_state
     WHERE sample_date = ANY(${[...dates]}::date[])
       AND status IN ('filled', 'skipped', 'exhausted')
  `];
}

// ── The permanent date→block and address→floor caches ───────────────────────

/** A day's permanent block proof (`wallet_backfill.day_block_get`). */
export async function dayBlockGet(db: RegistryDb, date: string): Promise<CachedDayBlockProof | null> {
  const rows = await on(db, readDayBlock)<{
    block_number: string;
    block_hash: string | null;
    block_timestamp: Date;
    boundary_next_block_number: string | null;
    boundary_next_block_hash: string | null;
    boundary_next_block_timestamp: Date | null;
  }>`
    SELECT block_number, block_hash, block_timestamp,
           boundary_next_block_number, boundary_next_block_hash,
           boundary_next_block_timestamp
      FROM chain_day_blocks
     WHERE sample_date = ${date}
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    blockNumber: Number(row.block_number),
    blockHash: row.block_hash,
    blockTimestampSec: Math.floor(new Date(row.block_timestamp).getTime() / 1000),
    boundaryNextBlockNumber:
      row.boundary_next_block_number === null ? null : Number(row.boundary_next_block_number),
    boundaryNextBlockHash: row.boundary_next_block_hash,
    boundaryNextBlockTimestampSec: row.boundary_next_block_timestamp === null
      ? null
      : Math.floor(new Date(row.boundary_next_block_timestamp).getTime() / 1000),
  };
}

/** Record or replace a day's block proof (`wallet_backfill.day_block_set`). */
export async function dayBlockSet(db: RegistryDb, date: string, proof: CachedDayBlockProof): Promise<void> {
  await on(db, writeDayBlock)`
    INSERT INTO chain_day_blocks
      (sample_date, block_number, block_hash, block_timestamp,
       boundary_next_block_number, boundary_next_block_hash,
       boundary_next_block_timestamp)
    VALUES
      (${date}, ${proof.blockNumber}, ${proof.blockHash},
       ${new Date(proof.blockTimestampSec * 1000)},
       ${proof.boundaryNextBlockNumber}, ${proof.boundaryNextBlockHash},
       ${proof.boundaryNextBlockTimestampSec === null
         ? null
         : new Date(proof.boundaryNextBlockTimestampSec * 1000)})
    ON CONFLICT (sample_date) DO UPDATE SET
      block_number = EXCLUDED.block_number,
      block_hash = EXCLUDED.block_hash,
      block_timestamp = EXCLUDED.block_timestamp,
      boundary_next_block_number = EXCLUDED.boundary_next_block_number,
      boundary_next_block_hash = EXCLUDED.boundary_next_block_hash,
      boundary_next_block_timestamp = EXCLUDED.boundary_next_block_timestamp,
      resolved_at = now()
  `;
}

/** An address's permanent first-code block (`wallet_backfill.address_floor_get`). */
export async function addressFloorGet(db: RegistryDb, address: string): Promise<number | null> {
  const rows = await on(db, readAddressFloor)<{ floor_block: string }>`
    SELECT floor_block FROM chain_address_floors WHERE address = ${address}
  `;
  const row = rows[0];
  return row ? Number(row.floor_block) : null;
}

/** Record or advance an address's first-code block (`wallet_backfill.address_floor_set`). */
export async function addressFloorSet(db: RegistryDb, address: string, floorBlock: number): Promise<void> {
  await on(db, writeAddressFloor)`
    INSERT INTO chain_address_floors (address, floor_block)
    VALUES (${address}, ${floorBlock})
    ON CONFLICT (address) DO UPDATE SET
      floor_block = EXCLUDED.floor_block,
      resolved_at = now()
  `;
}

// ── A day's snapshot completeness ───────────────────────────────────────────

/**
 * Inspect a day's active rows against the manifest's keys
 * (`wallet_backfill.inspect`; locked inside writeRepairedDay).
 *
 * "Active" is live: a row a repair pass superseded (D55 (6), migration 0104)
 * is neither coverage nor a row awaiting archival — it was archived when it
 * was live, before the pass that superseded it wrote anything.
 *
 * counts-quarantined: DELIBERATE — quarantined rows are selected so they can be
 * counted as occupied evidence awaiting archival, but they are excluded from
 * the present-key sets and therefore can never make a snapshot complete.
 */
export async function inspectSnapshot(
  db: RegistryDb,
  date: string,
  keys: ManifestKeys,
  lockRows = false,
): Promise<WalletSnapshotCompleteness> {
  const balances = lockRows
    ? await on(db, inspectBalancesLocked)<{ symbol: string; provenance: string }>`
    SELECT symbol, provenance
      FROM wallet_balance_samples
     WHERE sample_date = ${date}
       AND superseded_at IS NULL
     FOR UPDATE
  `
    : await on(db, inspectBalances)<{ symbol: string; provenance: string }>`
    SELECT symbol, provenance
      FROM wallet_balance_samples
     WHERE sample_date = ${date}
       AND superseded_at IS NULL
  `;
  // counts-quarantined: DELIBERATE — same evidence/coverage distinction above.
  const sleeves = lockRows
    ? await on(db, inspectSleevesLocked)<{ wallet_address: string; symbol: string; provenance: string }>`
    SELECT wallet_address, symbol, provenance
      FROM wallet_sleeve_samples
     WHERE sample_date = ${date}
       AND superseded_at IS NULL
     FOR UPDATE
  `
    : await on(db, inspectSleeves)<{ wallet_address: string; symbol: string; provenance: string }>`
    SELECT wallet_address, symbol, provenance
      FROM wallet_sleeve_samples
     WHERE sample_date = ${date}
       AND superseded_at IS NULL
  `;
  const balanceSymbols = new Set(
    balances.filter((row) => row.provenance !== QUARANTINED_PROVENANCE).map((row) => row.symbol),
  );
  const sleeveKeys = new Set(
    sleeves
      .filter((row) => row.provenance !== QUARANTINED_PROVENANCE)
      .map((row) => sleeveManifestKey(row.wallet_address, row.symbol)),
  );
  const missingBalanceSymbols = keys.balanceSymbols.filter((symbol) => !balanceSymbols.has(symbol));
  const missingSleeveKeys = keys.sleeveKeys
    .map((key) => sleeveManifestKey(key.walletAddress, key.symbol))
    .filter((key) => !sleeveKeys.has(key));
  return {
    complete: missingBalanceSymbols.length === 0 && missingSleeveKeys.length === 0,
    missingBalanceSymbols,
    missingSleeveKeys,
    balanceRows: balances.length,
    sleeveRows: sleeves.length,
  };
}

// ── Checkpoints ─────────────────────────────────────────────────────────────

/** A day's attempt counter, 0 when it has none (`wallet_backfill.read_attempts`). */
export async function readAttemptCount(db: RegistryDb, date: string): Promise<number> {
  const rows = await on(db, readAttempts)<{ attempts: number }>`
    SELECT attempts FROM wallet_backfill_state WHERE sample_date = ${date}
  `;
  return rows[0]?.attempts ?? 0;
}

/**
 * The checkpoint write for a day that produced NO rows
 * (`wallet_backfill.record_state`). `attempts` of null leaves the existing
 * counter alone (a skip is not a failed attempt). Every caller writes a
 * DAY-SPECIFIC outcome, never a shared-leg one, so it always clears the
 * shared-leg streak (issue #761).
 */
export async function recordState(
  db: RegistryDb,
  date: string,
  status: BackfillDayStatus,
  blockNumber: number | null,
  balanceRows: number,
  sleeveRows: number,
  detail: string | null,
  attempts: number | null,
): Promise<void> {
  await on(db, recordStateUpsert)`
    INSERT INTO wallet_backfill_state
      (sample_date, status, block_number, balance_rows, sleeve_rows, attempts, detail, attempted_at, defer_leg, defer_streak, defer_leg_at)
    VALUES
      (${date}, ${status}, ${blockNumber}, ${balanceRows}, ${sleeveRows}, ${attempts ?? 0}, ${detail}, now(), NULL, 0, NULL)
    ON CONFLICT (sample_date) DO UPDATE SET
      status       = EXCLUDED.status,
      block_number = EXCLUDED.block_number,
      balance_rows = EXCLUDED.balance_rows,
      sleeve_rows  = EXCLUDED.sleeve_rows,
      attempts     = COALESCE(${attempts}, wallet_backfill_state.attempts),
      detail       = EXCLUDED.detail,
      attempted_at = EXCLUDED.attempted_at,
      defer_leg    = NULL,
      defer_streak = 0,
      defer_leg_at = NULL
  `;
}

/**
 * Advance (or start) the per-day, per-leg consecutive-refusal streak and
 * return the resulting count (`wallet_backfill.bump_defer_streak`). Two
 * refusals of the same leg less than `debounceMs` apart are one incident;
 * a leg change resets the streak to 1 (ops/wallet-backfill.ts deferDay).
 */
export async function bumpDeferStreak(db: RegistryDb, date: string, leg: string, now: Date, debounceMs: number): Promise<number> {
  const [row] = await on(db, bumpStreak)<{ defer_streak: number }>`
    INSERT INTO wallet_backfill_state (sample_date, status, defer_leg, defer_streak, defer_leg_at)
    VALUES (${date}, 'failed', ${leg}, 1, ${now})
    ON CONFLICT (sample_date) DO UPDATE SET
      defer_streak = CASE
        WHEN wallet_backfill_state.defer_leg IS DISTINCT FROM ${leg} THEN 1
        WHEN wallet_backfill_state.defer_leg_at IS NOT NULL
             AND wallet_backfill_state.defer_leg_at > ${now}::timestamptz - (${debounceMs}::text || ' milliseconds')::interval
          THEN wallet_backfill_state.defer_streak
        ELSE wallet_backfill_state.defer_streak + 1
      END,
      defer_leg = ${leg},
      defer_leg_at = CASE
        WHEN wallet_backfill_state.defer_leg IS DISTINCT FROM ${leg} THEN ${now}::timestamptz
        WHEN wallet_backfill_state.defer_leg_at IS NOT NULL
             AND wallet_backfill_state.defer_leg_at > ${now}::timestamptz - (${debounceMs}::text || ' milliseconds')::interval
          THEN wallet_backfill_state.defer_leg_at
        ELSE ${now}::timestamptz
      END
    RETURNING defer_streak
  `;
  return row!.defer_streak;
}

/** Record a deferred day's status without charging its attempt (`wallet_backfill.defer_day`). */
export async function deferDayUpdate(
  db: RegistryDb,
  date: string,
  status: BackfillDayStatus,
  blockNumber: number | null,
  detail: string,
): Promise<void> {
  await on(db, deferDayUpdateSql)`
    UPDATE wallet_backfill_state
       SET status = ${status}, block_number = ${blockNumber}, detail = ${detail}, attempted_at = now()
     WHERE sample_date = ${date}
  `;
}

// ── The day write ───────────────────────────────────────────────────────────

/**
 * Commit one COMPLETE active snapshot for a day whose block is resolved and
 * whose legs are read and priced (`wallet_backfill.write_day`), in `tx`.
 *
 * If the day is partial or contains quarantine, its original live rows are
 * copied to immutable evidence before both active tables are rewritten in
 * place: each row this pass writes is upserted on its natural key, and each
 * live row it no longer writes is marked `superseded_at` (D55 (6): nothing here
 * deletes). Archive, replacement, supersession, completeness proof and
 * checkpoint are one transaction; any failure restores the original state, and
 * the caller (ops/wallet-backfill.ts) defers the day on the 'snapshot-write' leg.
 */
export async function writeRepairedDay(tx: RegistryDb, input: RepairedDayWrite): Promise<RepairedDayResult> {
  const { date, blockNumber, sampledAt, keys } = input;
  let balanceRows = 0;
  let sleeveRows = 0;
  let status: BackfillDayStatus = "filled";
  let detail: string | null = null;
  const priceDisagreements: AssetPriceDisagreement[] = [];

  // Serialize every repair/live writer for this date. Row locks alone do
  // not cover a missing natural key that a concurrent sampler could insert
  // between the evidence copy and the rewrite below.
  await lockWalletSnapshotDate(tx, date);
  // Lock every live row whose value may be archived. Without this, a
  // concurrent UPDATE could commit after the evidence SELECT but before the
  // rewrite, replacing a version that was never preserved.
  const before = await inspectSnapshot(tx, date, keys, true);

  if (before.complete) {
    const [existingState] = await on(tx, readExistingState)<{ status: BackfillDayStatus }>`
      SELECT status FROM wallet_backfill_state WHERE sample_date = ${date}
    `;
    status = existingState?.status === "filled" ? "filled" : "skipped";
    balanceRows = status === "filled" ? keys.balanceSymbols.length : 0;
    sleeveRows = status === "filled" ? keys.sleeveKeys.length : 0;
    detail = "already populated with a complete expected balance+sleeve snapshot";
  } else {
    // counts-quarantined: DELIBERATE. Every original live row is copied
    // before it is rewritten or superseded; quarantined rows receive the
    // more specific reason. A row an EARLIER pass superseded is not copied
    // again: it was live, and so archived, before that pass rewrote the
    // day, and supersession changed nothing but its tombstone.
    await on(tx, evidenceBalances, evidenceBalancesSource)`
      INSERT INTO wallet_balance_sample_evidence
        (original_id, sample_date, symbol, amount, price_usd, value_usd,
         provenance, sampled_at, strategy_nav_idle_only, evidence_reason,
         replacement_block_number, snapshot_run_id, amount_observed_at,
         price_observed_at, recorded_at)
      SELECT id, sample_date, symbol, amount, price_usd, value_usd,
             provenance, sampled_at, strategy_nav_idle_only,
             CASE WHEN provenance = ${QUARANTINED_PROVENANCE}
                  THEN 'quarantined-replacement'
                  ELSE 'incomplete-snapshot-replacement' END,
             ${blockNumber}, snapshot_run_id, amount_observed_at,
             price_observed_at, recorded_at
        FROM wallet_balance_samples
       WHERE sample_date = ${date}
         AND superseded_at IS NULL
    `;
    // counts-quarantined: DELIBERATE — same evidence-preserving transition.
    await on(tx, evidenceSleeves, evidenceSleevesSource)`
      INSERT INTO wallet_sleeve_sample_evidence
        (original_id, sample_date, wallet_address, symbol, amount, price_usd,
         value_usd, provenance, sampled_at, evidence_reason,
         replacement_block_number, snapshot_run_id, amount_observed_at,
         price_observed_at, recorded_at)
      SELECT id, sample_date, wallet_address, symbol, amount, price_usd,
             value_usd, provenance, sampled_at,
             CASE WHEN provenance = ${QUARANTINED_PROVENANCE}
                  THEN 'quarantined-replacement'
                  ELSE 'incomplete-snapshot-replacement' END,
             ${blockNumber}, snapshot_run_id, amount_observed_at,
             price_observed_at, recorded_at
        FROM wallet_sleeve_samples
       WHERE sample_date = ${date}
         AND superseded_at IS NULL
    `;
    // Captured BEFORE the rewrite so the asset_prices dual-write below can
    // report a disagreement against the sample row a prior pass wrote for
    // this (date, symbol) — D41 phase 2's "a check reports rows that
    // disagree", read literally as sample row vs. price row. Quarantined rows
    // are excluded (QUARANTINED_PROVENANCE): they are exactly the rows whose
    // price describes a different asset, so a "disagreement" against one
    // would be noise, not a finding.
    const priorSampleRows = await on(tx, readPriorSamples)<{ symbol: string; price_usd: string | null }>`
      SELECT symbol, price_usd FROM wallet_balance_samples
       WHERE sample_date = ${date} AND provenance <> ${QUARANTINED_PROVENANCE}
         AND superseded_at IS NULL
    `;
    const priorSamplePriceBySymbol = new Map(
      priorSampleRows.map((row) => [row.symbol, row.price_usd === null ? null : Number(row.price_usd)]),
    );

    // The natural keys this pass writes. Every live row on the date outside
    // them is superseded below, after the upserts.
    const writtenSymbols: string[] = [];
    const writtenSleeveWallets: string[] = [];
    const writtenSleeveSymbols: string[] = [];

    for (const b of input.balances) {
      // D41 phase 4 (markets §5.6): price_usd is NOT written here. asset_prices
      // is the sole write target for price data; value_usd still carries the
      // fused amount*price product.
      //
      // D55 (6): an upsert that replaces the row in place, never a delete and
      // re-insert. The conflict branch sets EVERY column to its EXCLUDED value
      // — the value the INSERT gives a fresh row — so the replaced row reads
      // exactly as the old delete-and-insert left it: price_usd stays NULL, a
      // prior snapshot identity is cleared, a row an earlier pass superseded is
      // live again, and `id` is the fresh sequence value EXCLUDED drew. The new
      // id is load-bearing: the evidence tables hold UNIQUE (original_id), one
      // archived copy per VERSION, so a key rewritten by a second pass must
      // present a new version's id or its archive collides with the first.
      // rm_wallet_aum_snapshot_constituent_guard (0038) still refuses this
      // UPDATE with 0A000 on a row of a complete or degraded run.
      await on(tx, upsertBalance)`
        INSERT INTO wallet_balance_samples
          (sample_date, symbol, amount, value_usd, provenance, sampled_at)
        VALUES
          (${date}, ${b.symbol}, ${b.amount}, ${b.valueUsd}, 'backfilled', ${sampledAt})
        ON CONFLICT (sample_date, symbol) DO UPDATE SET
          id                     = EXCLUDED.id,
          amount                 = EXCLUDED.amount,
          price_usd              = EXCLUDED.price_usd,
          value_usd              = EXCLUDED.value_usd,
          provenance             = EXCLUDED.provenance,
          sampled_at             = EXCLUDED.sampled_at,
          strategy_nav_idle_only = EXCLUDED.strategy_nav_idle_only,
          snapshot_run_id        = EXCLUDED.snapshot_run_id,
          amount_observed_at     = EXCLUDED.amount_observed_at,
          price_observed_at      = EXCLUDED.price_observed_at,
          recorded_at            = EXCLUDED.recorded_at,
          superseded_at          = EXCLUDED.superseded_at
      `;
      writtenSymbols.push(b.symbol);
      balanceRows += 1;

      // The literal "sample row vs. price row" reading of D41 phase 2's verify
      // step: what a PRIOR pass wrote for this (date, symbol), compared against
      // what this pass computed. Reported, never a reason to change what gets
      // written.
      const priorSamplePrice = priorSamplePriceBySymbol.get(b.symbol);
      if (priorSamplePrice != null && assetPricesDisagree(priorSamplePrice, b.assetPrice.priceUsd)) {
        priceDisagreements.push({
          priceDate: date,
          symbol: b.symbol,
          previousPriceUsd: priorSamplePrice,
          freshPriceUsd: b.assetPrice.priceUsd,
          against: "sample_row",
        });
      }

      // D41 phase 2 — dual-write the price row alongside the sample row, once
      // per (date, symbol) from the AGGREGATE leg.
      const disagreement = await writeAssetPrice(tx, b.assetPrice);
      if (disagreement) priceDisagreements.push(disagreement);
    }

    for (const t of input.sleeves) {
      // D41 phase 4 and D55 (6): the same in-place upsert as the balance row
      // above, on the sleeve natural key, every column (id included) from
      // EXCLUDED.
      await on(tx, upsertSleeve)`
        INSERT INTO wallet_sleeve_samples
          (sample_date, wallet_address, symbol, amount, value_usd, provenance, sampled_at)
        VALUES
          (${date}, ${t.walletAddress}, ${t.symbol}, ${t.amount}, ${t.valueUsd}, 'backfilled', ${sampledAt})
        ON CONFLICT (sample_date, wallet_address, symbol) DO UPDATE SET
          id                 = EXCLUDED.id,
          amount             = EXCLUDED.amount,
          price_usd          = EXCLUDED.price_usd,
          value_usd          = EXCLUDED.value_usd,
          provenance         = EXCLUDED.provenance,
          sampled_at         = EXCLUDED.sampled_at,
          snapshot_run_id    = EXCLUDED.snapshot_run_id,
          amount_observed_at = EXCLUDED.amount_observed_at,
          price_observed_at  = EXCLUDED.price_observed_at,
          recorded_at        = EXCLUDED.recorded_at,
          superseded_at      = EXCLUDED.superseded_at
      `;
      writtenSleeveWallets.push(t.walletAddress);
      writtenSleeveSymbols.push(t.symbol);
      sleeveRows += 1;
    }

    // D55 (6): the day's live rows this pass did not write — a symbol no
    // longer tracked, a sleeve wallet no longer configured, a key spelled
    // differently from the one the pass writes — are superseded, not
    // deleted. Their content is already in evidence (copied above), every
    // reader filters them out, and a later write of the same key (this
    // pass's upsert or the live sampler's) clears the tombstone. The
    // constituent guard refuses this UPDATE on a row of a complete or
    // degraded run, as it refused the DELETE. Key matching is exact (no case
    // folding).
    await on(tx, supersedeBalances)`
      UPDATE wallet_balance_samples
         SET superseded_at = now()
       WHERE sample_date = ${date}
         AND superseded_at IS NULL
         AND symbol <> ALL(${writtenSymbols}::text[])
    `;
    await on(tx, supersedeSleeves)`
      UPDATE wallet_sleeve_samples AS s
         SET superseded_at = now()
       WHERE s.sample_date = ${date}
         AND s.superseded_at IS NULL
         AND NOT EXISTS (
               SELECT 1
                 FROM unnest(${writtenSleeveWallets}::text[], ${writtenSleeveSymbols}::text[])
                      AS w(wallet_address, symbol)
                WHERE w.wallet_address = s.wallet_address
                  AND w.symbol = s.symbol
             )
    `;

    const after = await inspectSnapshot(tx, date, keys);
    if (
      !after.complete ||
      after.balanceRows !== keys.balanceSymbols.length ||
      after.sleeveRows !== keys.sleeveKeys.length
    ) {
      throw new Error(
        `snapshot completeness validation failed: missing balances [${after.missingBalanceSymbols.join(", ")}], ` +
          `missing sleeves [${after.missingSleeveKeys.join(", ")}], rows ${after.balanceRows}/${after.sleeveRows}`,
      );
    }
    detail = before.balanceRows + before.sleeveRows > 0
      ? `replaced incomplete snapshot; archived ${before.balanceRows} balance and ${before.sleeveRows} sleeve row(s)`
      : null;
  }

  // `filled` is written only after both active key sets passed validation,
  // and it commits with the evidence and replacement rows. A successful
  // write clears any shared-leg streak this date was carrying — whatever
  // leg it was, it was not the reason this attempt succeeded.
  await on(tx, writeFilledState)`
    INSERT INTO wallet_backfill_state
      (sample_date, status, block_number, balance_rows, sleeve_rows, detail, attempted_at, defer_leg, defer_streak, defer_leg_at)
    VALUES
      (${date}, ${status}, ${blockNumber}, ${balanceRows}, ${sleeveRows}, ${detail}, now(), NULL, 0, NULL)
    ON CONFLICT (sample_date) DO UPDATE SET
      status       = EXCLUDED.status,
      block_number = EXCLUDED.block_number,
      balance_rows = EXCLUDED.balance_rows,
      sleeve_rows  = EXCLUDED.sleeve_rows,
      detail       = EXCLUDED.detail,
      attempted_at = EXCLUDED.attempted_at,
      defer_leg    = NULL,
      defer_streak = 0,
      defer_leg_at = NULL
  `;
  return { status, balanceRows, sleeveRows, detail, priceDisagreements };
}

/** The repair pass's store on a database handle: what the pipeline operations run, and a test's direct store. */
export function walletBackfillDbStore(db: RegistryDb): WalletBackfillStore {
  return {
    gapReports: (keys, now) => gapReports(db, keys, now),
    planState: () => planState(db),
    priorState: (dates) => priorState(db, dates),
    dayBlockGet: (date) => dayBlockGet(db, date),
    dayBlockSet: (date, proof) => dayBlockSet(db, date, proof),
    addressFloorGet: (address) => addressFloorGet(db, address),
    addressFloorSet: (address, floor) => addressFloorSet(db, address, floor),
    inspect: (date, keys) => inspectSnapshot(db, date, keys),
    readAttempts: (date) => readAttemptCount(db, date),
    recordState: (date, status, blockNumber, balanceRows, sleeveRows, detail, attempts) =>
      recordState(db, date, status, blockNumber, balanceRows, sleeveRows, detail, attempts),
    bumpDeferStreak: (date, leg, now, debounceMs) => bumpDeferStreak(db, date, leg, now, debounceMs),
    deferDay: (date, status, blockNumber, detail) => deferDayUpdate(db, date, status, blockNumber, detail),
    writeRepairedDay: (input) =>
      (db as { begin?: unknown }).begin
        ? (db as unknown as { begin: <T>(fn: (tx: RegistryDb) => Promise<T>) => Promise<T> }).begin((tx) => writeRepairedDay(tx, input))
        : writeRepairedDay(db, input),
  };
}
