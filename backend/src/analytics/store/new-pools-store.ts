// Issue 1654 SQL store: the new-pools collector's pool records and polls
// (migration 0132). Only the API process imports this (same rule as
// source-ledger-store.ts); the producer reaches it through
// analytics/api-client.ts and the analytics REST boundary.
//
// One transaction per poll writes, in order:
//   - the poll's acquisition evidence (source_acquisitions and source_fetches,
//     provider geckoterminal_newpools), through saveSourceAcquisition;
//   - each pool, once: a pool id already stored is skipped, so a pool keeps the
//     knowledge_time of the first poll that saw it;
//   - one new_pool_polls row: the poll's oldest and newest pool_created_at, and
//     the coverage gap before it. A poll overlaps the previous stored poll when
//     its oldest pool is at or before that poll's newest; when it does not,
//     gap_from is the previous newest and gap_to this poll's oldest. The first
//     poll ever stored has no gap.
// A failed poll (page 1 failed after retries) and an empty one record their
// acquisition and no poll row; the next stored poll is compared with the last
// stored poll. knowledge_time is always the database clock at insert. Both
// tables are append-only (the source-ledger immutability trigger).
import { sql, type DbHandle } from "../../db/client.ts";
import { on, onStatement, registerQuery, registerStatement } from "../../db/registry.ts";
import type { NewPoolGap, NewPoolPollResult, NewPoolPollSubmission, NewPoolRunInputs } from "../persistence.ts";
import { saveSourceAcquisition } from "./source-ledger-store.ts";
import { instantMs } from "../../../../packages/analyst-sdk/src/transform/new-pools.ts";

/** The only entry module that reaches this store: the analytics ingestion route. */
const ANALYTICS_ROUTE = "src/api/routes/analytics";

const pollLock = registerStatement({
  role: "rm_app",
  shape: "advisoryLockByText",
  site: "src/analytics/store/new-pools-store:saveNewPoolPoll.pollLock",
  purpose: "Serialize stored new-pools polls, so each is compared with the poll stored just before it.",
  callers: [ANALYTICS_ROUTE],
});

const findPoll = registerQuery({
  role: "rm_app",
  object: "new_pool_polls",
  privileges: ["SELECT"],
  site: "src/analytics/store/new-pools-store:saveNewPoolPoll.findPoll",
  purpose: "Answer a replayed poll submission with the poll row its first submission stored.",
  callers: [ANALYTICS_ROUTE],
  probe: {
    statement: `SELECT pools_seen, pools_new,
        to_char(gap_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS gap_from,
        to_char(gap_to AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS gap_to
      FROM new_pool_polls WHERE acquisition_id = $1::uuid`,
    params: ["00000000-0000-0000-0000-000000000000"],
  },
});

const insertPools = registerQuery({
  role: "rm_app",
  object: "new_pool_records",
  // SELECT for RETURNING: the ids actually inserted are the poll's new pools.
  privileges: ["INSERT", "SELECT"],
  site: "src/analytics/store/new-pools-store:saveNewPoolPoll.insertPools",
  purpose: "Store each pool a poll saw once, keeping the knowledge time of the first poll that saw it.",
  callers: [ANALYTICS_ROUTE],
  probe: {
    statement: `INSERT INTO new_pool_records (pool_id, network, pool_created_at, acquisition_id)
      SELECT $1, $2, $3::timestamptz, $4::uuid WHERE false
      ON CONFLICT (pool_id) DO NOTHING RETURNING pool_id`,
    params: ["probe", "probe", "2000-01-01T00:00:00Z", "00000000-0000-0000-0000-000000000000"],
  },
});

const insertPoll = registerQuery({
  role: "rm_app",
  object: "new_pool_polls",
  privileges: ["INSERT"],
  site: "src/analytics/store/new-pools-store:saveNewPoolPoll.insertPoll",
  purpose: "Store one poll's span and the coverage gap between it and the poll stored before it.",
  callers: [ANALYTICS_ROUTE],
  probe: {
    statement: `INSERT INTO new_pool_polls (acquisition_id, oldest_created_at, newest_created_at, pages_read, pools_seen, pools_new, gap_from, gap_to)
      SELECT $1::uuid, $2::timestamptz, $3::timestamptz, $4::integer, $5::integer, $6::integer, $7::timestamptz, $8::timestamptz WHERE false`,
    params: ["00000000-0000-0000-0000-000000000000", "2000-01-01T00:00:00Z", "2000-01-01T00:00:00Z", 1, 1, 0, null, null],
  },
});

const selectHead = registerQuery({
  role: "rm_app",
  object: "new_pool_polls",
  privileges: ["SELECT"],
  site: "src/analytics/store/new-pools-store:loadNewPoolHead",
  // Also read inside saveNewPoolPoll, under its lock: the previous poll a new one is compared with.
  purpose: "The newest pool_created_at of the last stored poll: where the collector's next poll may stop.",
  callers: [ANALYTICS_ROUTE],
  probe: {
    statement: `SELECT to_char(newest_created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS newest
      FROM new_pool_polls ORDER BY id DESC LIMIT 1`,
  },
});

const selectPolls = registerQuery({
  role: "rm_app",
  object: "new_pool_polls",
  privileges: ["SELECT"],
  site: "src/analytics/store/new-pools-store:loadNewPoolRunInputs.polls",
  purpose: "Read the database clock and, at it, every stored poll's span in poll order: a regime run's NEW_TOKENS coverage.",
  callers: [ANALYTICS_ROUTE],
  probe: {
    statement: `WITH c AS (SELECT clock_timestamp() AS t)
      SELECT to_char(c.t AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cutoff, p.oldest, p.newest
      FROM c LEFT JOIN LATERAL (
        SELECT id, to_char(oldest_created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS oldest,
          to_char(newest_created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS newest
        FROM new_pool_polls WHERE knowledge_time <= c.t
      ) p ON true
      ORDER BY p.id`,
  },
});

const selectDayTallies = registerQuery({
  role: "rm_app",
  object: "new_pool_records",
  privileges: ["SELECT"],
  site: "src/analytics/store/new-pools-store:loadNewPoolRunInputs.dayTallies",
  purpose: "Count the unique pools created per UTC day, known at a regime run's cutoff (pool_id is the key, so a row count is a unique count).",
  callers: [ANALYTICS_ROUTE],
  probe: {
    statement: `SELECT (pool_created_at AT TIME ZONE 'UTC')::date::text AS date, count(*)::int AS pools
      FROM new_pool_records WHERE knowledge_time <= $1::text::timestamptz
      GROUP BY 1 ORDER BY 1`,
    params: ["2000-01-01T00:00:00Z"],
  },
});

type GapRow = { gap_from: string | null; gap_to: string | null };
const gapOf = (r: GapRow | undefined): NewPoolGap | null => (r?.gap_from && r.gap_to ? { from: r.gap_from, to: r.gap_to } : null);

/** Store one poll in one transaction. Idempotent on the acquisition id. */
export async function saveNewPoolPoll(input: NewPoolPollSubmission, db: Pick<typeof sql, "begin"> = sql): Promise<NewPoolPollResult> {
  return await db.begin(async (tx) => {
    const saved = await saveSourceAcquisition(input.acquisition, tx);
    const failed = input.acquisition.events.at(-1)?.type !== "succeeded";
    const poolsSeen = input.pools.length;
    if (saved.replayed) {
      const [row] = await on(tx, findPoll)<GapRow & { pools_seen: number; pools_new: number }>`
        SELECT pools_seen, pools_new,
          to_char(gap_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS gap_from,
          to_char(gap_to AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS gap_to
        FROM new_pool_polls WHERE acquisition_id = ${input.acquisition.id}::uuid`;
      return { acquisitionId: saved.acquisitionId, replayed: true, stored: !!row, poolsSeen: row?.pools_seen ?? 0, poolsNew: row?.pools_new ?? 0, gap: gapOf(row) };
    }
    if (failed || poolsSeen === 0 || input.oldestCreatedAt === null || input.newestCreatedAt === null) {
      return { acquisitionId: saved.acquisitionId, replayed: false, stored: false, poolsSeen, poolsNew: 0, gap: null };
    }
    await onStatement(tx, pollLock)`SELECT pg_advisory_xact_lock(hashtextextended(${"new_pool_polls"}, 0))`;
    const rows = input.pools.map((p) => ({ pool_id: p.id, network: p.network, pool_created_at: p.createdAt, acquisition_id: input.acquisition.id }));
    let poolsNew = 0;
    // Four parameters a row, far below PostgreSQL's 65,535-parameter ceiling.
    const BATCH = 5_000;
    for (let start = 0; start < rows.length; start += BATCH) {
      const inserted = await on(tx, insertPools)`
        INSERT INTO new_pool_records ${tx(rows.slice(start, start + BATCH), "pool_id", "network", "pool_created_at", "acquisition_id")}
        ON CONFLICT (pool_id) DO NOTHING RETURNING pool_id`;
      poolsNew += inserted.length;
    }
    // The previous stored poll, read under the lock: an overlap is this poll's
    // oldest pool at or before its newest.
    const prevNewest = await loadNewPoolHead(tx);
    // `to` in the shape the store reads it back in (microseconds), so a replay answers identically.
    const gap = prevNewest !== null && instantMs(input.oldestCreatedAt) > instantMs(prevNewest)
      ? { from: prevNewest, to: new Date(instantMs(input.oldestCreatedAt)).toISOString().replace(/Z$/, "000Z") }
      : null;
    await on(tx, insertPoll)`
      INSERT INTO new_pool_polls (acquisition_id, oldest_created_at, newest_created_at, pages_read, pools_seen, pools_new, gap_from, gap_to)
      VALUES (${input.acquisition.id}::uuid, ${input.oldestCreatedAt}::timestamptz, ${input.newestCreatedAt}::timestamptz,
        ${input.pagesRead}::integer, ${poolsSeen}::integer, ${poolsNew}::integer, ${gap?.from ?? null}::timestamptz, ${gap?.to ?? null}::timestamptz)`;
    return { acquisitionId: saved.acquisitionId, replayed: false, stored: true, poolsSeen, poolsNew, gap };
  });
}

/** The newest pool_created_at of the last stored poll, or null before the first. */
export async function loadNewPoolHead(db: DbHandle = sql): Promise<string | null> {
  const [row] = await on(db, selectHead)<{ newest: string }>`
    SELECT to_char(newest_created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS newest
    FROM new_pool_polls ORDER BY id DESC LIMIT 1`;
  return row?.newest ?? null;
}

/**
 * A regime run's NEW_TOKENS input: the database clock, and at it every poll's
 * span (poll order) and the unique pools created per UTC day. The SDK's
 * newPoolDailyCounts turns them into the daily count.
 */
export async function loadNewPoolRunInputs(db: DbHandle = sql): Promise<NewPoolRunInputs> {
  const polls = await on(db, selectPolls)<{ cutoff: string; oldest: string | null; newest: string | null }>`
    WITH c AS (SELECT clock_timestamp() AS t)
    SELECT to_char(c.t AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cutoff, p.oldest, p.newest
    FROM c LEFT JOIN LATERAL (
      SELECT id, to_char(oldest_created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS oldest,
        to_char(newest_created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS newest
      FROM new_pool_polls WHERE knowledge_time <= c.t
    ) p ON true
    ORDER BY p.id`;
  const knowledgeTimeCutoff = polls[0]!.cutoff;
  const tallies = await on(db, selectDayTallies)<{ date: string; pools: number }>`
    SELECT (pool_created_at AT TIME ZONE 'UTC')::date::text AS date, count(*)::int AS pools
    FROM new_pool_records WHERE knowledge_time <= ${knowledgeTimeCutoff}::text::timestamptz
    GROUP BY 1 ORDER BY 1`;
  return {
    knowledgeTimeCutoff,
    dayTallies: tallies.map((t) => ({ date: t.date, pools: Number(t.pools) })),
    polls: polls.filter((p) => p.oldest !== null && p.newest !== null).map((p) => ({ oldestCreatedAt: p.oldest!, newestCreatedAt: p.newest! })),
  };
}
