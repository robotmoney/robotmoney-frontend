// Migration 0121 (the four subjects close exactly 6 h apart, issue 1286),
// applied to planted state the way the migrate step applies a file: one
// transaction, as rm_owner. Owner request 2026-10-10; production data changes
// only through a migration.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { useCleanDatabase } from "./support/clean-db.ts";
import { fixtureDb } from "./support/fixture-db.ts";

useCleanDatabase(import.meta.file);

const M0121 = readFileSync(join(import.meta.dir, "..", "migrations", "0121_subject_closes_six_hours_apart.sql"), "utf8");

const DAY = 86400;
const SIX_HOURS = 21600;

/** The four subjects in close order, with the anchors 0117 left on production. */
const ORDER = ["robotmoney-vault", "woon", "robotmoney-allocation", "robotmoney-treasury"] as const;
const BEFORE: Record<(typeof ORDER)[number], string> = {
  "robotmoney-vault": "2026-10-10T00:52:19.990Z",
  woon: "2026-10-10T06:58:21.970Z",
  "robotmoney-allocation": "2026-10-10T13:00:42.491Z",
  "robotmoney-treasury": "2026-10-09T19:03:59.504Z",
};
const AFTER: Record<(typeof ORDER)[number], string> = {
  "robotmoney-vault": "2026-10-10T00:52:19.990Z",
  woon: "2026-10-10T06:52:19.990Z",
  "robotmoney-allocation": "2026-10-10T12:52:19.990Z",
  "robotmoney-treasury": "2026-10-10T18:52:19.990Z",
};

async function apply(): Promise<void> {
  const { default: postgres } = await import("postgres");
  const db = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    await db.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE rm_owner");
      await tx.unsafe(M0121);
    });
  } finally {
    await db.end({ timeout: 5 });
  }
}

async function plantSubject(id: string, duration: number, anchor: string, version: number) {
  await fixtureDb`
    INSERT INTO swarm_subjects (id, status, name, recommendation_type, epoch_duration_seconds, epoch_anchor, version)
    VALUES (${id}, 'active', ${id}, 'position_actions', ${duration}, ${anchor}::timestamptz, ${version})
    ON CONFLICT (id) DO UPDATE SET epoch_duration_seconds = EXCLUDED.epoch_duration_seconds,
      epoch_anchor = EXCLUDED.epoch_anchor, version = EXCLUDED.version`;
}
const plantProduction = async (version: number) => {
  for (const id of ORDER) await plantSubject(id, DAY, BEFORE[id], version);
};
const subjectRow = async (id: string) =>
  (await fixtureDb`SELECT epoch_duration_seconds, epoch_anchor, version FROM swarm_subjects WHERE id = ${id}`)[0] as
    { epoch_duration_seconds: number; epoch_anchor: Date; version: number };

/** Microseconds since midnight UTC of the anchor: integer, so the spacing compares exactly. */
const timeOfDayMicros = async (id: string): Promise<bigint> =>
  BigInt((await fixtureDb`
    SELECT (extract(epoch FROM (epoch_anchor - date_trunc('day', epoch_anchor AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')) * 1000000)::bigint AS t
      FROM swarm_subjects WHERE id = ${id}`)[0]!.t as string);

/**
 * The scheduler's turnover rule (src/swarm/epoch.ts gridClose, spec §2.2): the
 * next window closes at the first grid instant strictly after the open
 * window's close. Computed here in SQL, as the scheduler does, from the
 * subject's anchor and duration.
 */
const nextCloseAfter = async (id: string, close: string): Promise<Date> =>
  (await fixtureDb`
    SELECT (epoch_anchor + make_interval(secs => ((floor(extract(epoch FROM (${close}::timestamptz - epoch_anchor)) / epoch_duration_seconds) + 1)
                                                 * epoch_duration_seconds)::float8))::timestamptz AS c
      FROM swarm_subjects WHERE id = ${id}`)[0]!.c as Date;

describe("0121: the four subjects close exactly 6 h apart, each still a 24 h window", () => {
  test("it only updates rows that exist: no subject row is created", async () => {
    // Runs first: the clean database holds none of the four production ids.
    expect((await fixtureDb`SELECT count(*)::int AS n FROM swarm_subjects WHERE id = ANY(${[...ORDER]})`)[0]!.n).toBe(0);
    const before = (await fixtureDb`SELECT count(*)::int AS n FROM swarm_subjects`)[0]!.n as number;
    await apply();
    expect((await fixtureDb`SELECT count(*)::int AS n FROM swarm_subjects`)[0]!.n).toBe(before);
  });

  test("after the migration every subject keeps a 24 h epoch and the closes sit exactly 21600 s apart, in order vault, woon, allocation, treasury", async () => {
    await plantProduction(3);
    await apply();
    for (const id of ORDER) {
      const row = await subjectRow(id);
      expect(row.epoch_duration_seconds).toBe(DAY);
      expect(row.epoch_anchor.toISOString()).toBe(AFTER[id]);
    }
    const times = await Promise.all(ORDER.map(timeOfDayMicros));
    for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!).toBe(BigInt(SIX_HOURS) * 1_000_000n);
    expect((times[0]! + BigInt(SIX_HOURS * 4) * 1_000_000n) % (BigInt(DAY) * 1_000_000n)).toBe(times[0]!);
  });

  test("vault already sits on the grid: its row is untouched, and no version moves on a rerun", async () => {
    await plantProduction(3);
    await apply();
    expect((await subjectRow("robotmoney-vault")).version).toBe(3);
    for (const id of ORDER.slice(1)) expect((await subjectRow(id)).version).toBe(4);
    const once = await Promise.all(ORDER.map(subjectRow));
    await apply();
    expect(await Promise.all(ORDER.map(subjectRow))).toEqual(once);
  });

  test("no window open at the migration closes earlier than it was due, and the one window after it lands on the new grid, 24 h less the move, never a sliver", async () => {
    await plantProduction(3);
    const open: Record<string, { id: string; close: string }> = {};
    for (const id of ORDER) {
      // Each subject's open window closes at its old time of day on 2026-10-12.
      const close = `2026-10-12T${BEFORE[id].slice(11)}`;
      const [{ id: sessionId }] = (await fixtureDb`
        INSERT INTO swarm_sessions (subject_id, subject_name, state, window_closes_at)
        VALUES (${id}, ${id}, 'collecting', ${close}::timestamptz)
        RETURNING id`) as unknown as { id: string }[];
      open[id] = { id: sessionId, close };
    }
    await apply();
    for (const id of ORDER) {
      const [row] = await fixtureDb`SELECT window_closes_at FROM swarm_sessions WHERE id = ${open[id]!.id}`;
      expect(new Date(row!.window_closes_at).toISOString()).toBe(open[id]!.close);
      const next = await nextCloseAfter(id, open[id]!.close);
      const length = (next.getTime() - new Date(open[id]!.close).getTime()) / 1000;
      // Every new time of day is at or before the old one, so the first grid
      // instant after the old close is a day later less the move (at most
      // 11 m 40 s, treasury), never minutes later. A later time of day would
      // open a window of minutes that nobody can submit into (§2.2 first-epoch
      // floor does not apply at turnover).
      expect(length).toBeGreaterThan(DAY - 12 * 60);
      expect(length).toBeLessThanOrEqual(DAY);
      expect(next.toISOString().slice(11)).toBe(AFTER[id].slice(11));
    }
  });

});
