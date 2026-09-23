// Specification for backend/scripts/schedules-enable.ts — `bun run
// schedules:enable`, the production-initialization command of
// docs/technical/smoke-production-spec.md §6.3 and step 4 of §9.1.
//
// TDD RED PHASE (issue #1026, W1 step 2). Every function under test currently
// throws `NOT IMPLEMENTED`; every test here fails today by design and is written
// against the behaviour the command must have once W1.9 lands.
//
// THE TWO PROPERTIES THAT MATTER. (1) This command owns `enabled` and NOTHING
// ELSE — most of all not `next_run_at`, because an overdue row is a backlog that
// `catchup_policy` exists to replay, and setting it forward discards that
// backlog at the exact moment an operator is recovering from the outage that
// created it. (2) All four §4.3 gates fire, every time, BEFORE the database is
// read. So the tests below compare a full before/after snapshot of all six
// mutable columns, and assert each gate independently.
//
// TIER. The gate, render and receipt blocks are pure and run anywhere. The plan
// and write blocks are INTEGRATION TIER against the ephemeral Postgres that
// tests/preload.ts provisions, and take a database of their own via
// tests/support/clean-db.ts, because they insert, delete and mutate
// `job_schedules` rows that other files read.
//
// Acceptance gates served (spec §10, W1): "Restart after schedules become
// overdue" — only observable once enablement has stopped being a restart
// side-effect, which is what `applyEnablement` touching one column proves.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "../src/db/client.ts";
import {
  applyEnablement,
  assertProductionInitializationGates,
  confirm,
  promptOwnerPassword,
  readEnablementPlan,
  renderEnablementPlan,
  SWARM_SCHEDULE_KINDS,
  writeSchedulesEnableReceipt,
  type EnablementPlan,
  type ScheduleRow,
  type SchedulesEnableReceipt,
  type SwarmScheduleKind,
} from "../scripts/schedules-enable.ts";
import type { TargetLock, TargetLockKey } from "../src/db/target-lock.ts";
import { useCleanDatabase } from "./support/clean-db.ts";

useCleanDatabase(import.meta.file);

/**
 * A held target lock, as the command receives one. The lock's own protocol is
 * specified in tests/target-lock.test.ts; here it is the connection the command
 * reads and writes through.
 */
function heldLock(): TargetLock {
  return {
    key: 42n as TargetLockKey,
    holder: {
      tool: "schedules:enable",
      instance: "rm_prod",
      host: "test-host",
      pid: process.pid,
      acquiredAt: "2026-09-23T10:00:00.000Z",
    },
    connection: sql,
    stillHeld: () => Promise.resolve(true),
    release: () => Promise.resolve(),
  };
}

const MUTABLE_COLUMNS = ["kind", "cron", "payload", "timezone", "enabled", "next_run_at", "catchup_policy"] as const;

type Snapshot = Record<string, unknown>[];

async function snapshotSwarmRows(): Promise<Snapshot> {
  return await sql<Snapshot>`
    SELECT kind, cron, payload::text AS payload, timezone, enabled, next_run_at::text AS next_run_at, catchup_policy
      FROM job_schedules
     WHERE kind = ANY(${[...SWARM_SCHEDULE_KINDS]})
     ORDER BY kind`;
}

/** Put the five lifecycle rows in a known state for this file's own database. */
async function seedFiveSwarmRows(options: { enabled: boolean; nextRunAt: string | null }): Promise<void> {
  await sql`DELETE FROM job_schedules WHERE kind LIKE 'swarm.%'`;
  for (const kind of SWARM_SCHEDULE_KINDS) {
    await sql`
      INSERT INTO job_schedules (kind, cron, payload, timezone, enabled, next_run_at, catchup_policy)
      VALUES (${kind}, '*/5 * * * *', '{}'::jsonb, 'UTC', ${options.enabled},
              ${options.nextRunAt}::timestamptz, 'collapse-per-bucket')`;
  }
}

const GOOD_GATES = {
  env: { RM_ENV: "prod" } as Record<string, string | undefined>,
  identity: "production" as const,
  interactive: true,
  invokedFromSmoke: false,
};

describe("SWARM_SCHEDULE_KINDS — §6.3, exactly five rows in lifecycle order [integration tier]", () => {
  test("is the five-row lifecycle sequence, and the command acts on exactly those rows", async () => {
    expect([...SWARM_SCHEDULE_KINDS]).toEqual([
      "swarm.open_session",
      "swarm.publish_brief",
      "swarm.close_window",
      "swarm.aggregate",
      "swarm.publish",
    ]);
    expect(SWARM_SCHEDULE_KINDS).toHaveLength(5);

    await seedFiveSwarmRows({ enabled: false, nextRunAt: null });
    const plan = await readEnablementPlan(heldLock());
    expect(plan.rows.map((row) => row.kind).sort()).toEqual([...SWARM_SCHEDULE_KINDS].sort());
  });
});

describe("assertProductionInitializationGates — §4.3, all four gates, before anything is read", () => {
  test("a correctly gated invocation passes", () => {
    expect(() => assertProductionInitializationGates(GOOD_GATES)).not.toThrow();
  });

  test("RM_ENV that is not exactly `prod` refuses", () => {
    expect(() => assertProductionInitializationGates({ ...GOOD_GATES, env: { RM_ENV: "stage" } })).toThrow(/RM_ENV/);
  });

  test("an unset RM_ENV refuses", () => {
    expect(() => assertProductionInitializationGates({ ...GOOD_GATES, env: {} })).toThrow(/RM_ENV/);
  });

  test("a rehearsal target refuses: production cadences must not start against rehearsal data", () => {
    expect(() => assertProductionInitializationGates({ ...GOOD_GATES, identity: "rehearsal" })).toThrow(
      /deployment_identity|rehearsal/,
    );
  });

  test("an un-enrolled target refuses", () => {
    expect(() => assertProductionInitializationGates({ ...GOOD_GATES, identity: null })).toThrow(
      /deployment_identity|enrolled/i,
    );
  });

  test("no TTY refuses: the typed rm_owner password and the y/n both require a terminal", () => {
    expect(() => assertProductionInitializationGates({ ...GOOD_GATES, interactive: false })).toThrow(
      /terminal|tty|interactive/i,
    );
  });

  test("the no-TTY refusal offers no escape hatch — there is no --yes, no --force and no environment variable", () => {
    let message = "";
    try {
      assertProductionInitializationGates({ ...GOOD_GATES, interactive: false });
    } catch (error) {
      message = String(error);
    }
    expect(message).toMatch(/terminal|tty|interactive/i);
    expect(message).not.toContain("--yes");
    expect(message).not.toContain("--force");
  });

  test("an invocation from `bun smoke` refuses: none of §9.1 is reachable through the boot", () => {
    expect(() => assertProductionInitializationGates({ ...GOOD_GATES, invokedFromSmoke: true })).toThrow(/smoke/);
  });

  test("each gate has its own message, so an operator learns which one fired", () => {
    const messages = new Set<string>();
    for (const bad of [
      { ...GOOD_GATES, env: {} },
      { ...GOOD_GATES, identity: "rehearsal" as const },
      { ...GOOD_GATES, interactive: false },
      { ...GOOD_GATES, invokedFromSmoke: true },
    ]) {
      try {
        assertProductionInitializationGates(bad);
      } catch (error) {
        messages.add(String(error));
      }
    }
    expect(messages.size).toBe(4);
  });
});

describe("readEnablementPlan — §6.3, the five rows read under the held lock [integration tier]", () => {
  test("reports all five rows, which will be enabled, and which already are", async () => {
    await seedFiveSwarmRows({ enabled: false, nextRunAt: null });
    await sql`UPDATE job_schedules SET enabled = true WHERE kind = 'swarm.publish'`;

    const plan = await readEnablementPlan(heldLock());
    expect(plan.rows.map((row) => row.kind).sort()).toEqual([...SWARM_SCHEDULE_KINDS].sort());
    expect([...plan.toEnable].sort()).toEqual(
      SWARM_SCHEDULE_KINDS.filter((kind) => kind !== "swarm.publish").slice().sort(),
    );
    expect([...plan.alreadyEnabled]).toEqual(["swarm.publish"]);
  });

  test("reports each row's untouched next_run_at, so the operator sees the backlog they are about to let drain", async () => {
    await seedFiveSwarmRows({ enabled: false, nextRunAt: "2020-01-01T00:00:00Z" });
    const plan = await readEnablementPlan(heldLock());
    for (const row of plan.rows) {
      expect(row.nextRunAt).not.toBeNull();
    }
  });

  test("an enabled row whose next_run_at is in the past is reported as overdue, informationally", async () => {
    await seedFiveSwarmRows({ enabled: true, nextRunAt: "2020-01-01T00:00:00Z" });
    const plan = await readEnablementPlan(heldLock());
    expect([...plan.overdue].sort()).toEqual([...SWARM_SCHEDULE_KINDS].slice().sort());
    expect(plan.toEnable).toHaveLength(0);
  });

  test("an enabled row whose next_run_at is NULL is reported as overdue too — the scheduler initializes it", async () => {
    await seedFiveSwarmRows({ enabled: true, nextRunAt: null });
    const plan = await readEnablementPlan(heldLock());
    expect([...plan.overdue].sort()).toEqual([...SWARM_SCHEDULE_KINDS].slice().sort());
  });

  test("a missing lifecycle row refuses rather than INSERTing a cadence this command has no business choosing", async () => {
    await seedFiveSwarmRows({ enabled: false, nextRunAt: null });
    await sql`DELETE FROM job_schedules WHERE kind = 'swarm.aggregate'`;
    await expect(readEnablementPlan(heldLock())).rejects.toThrow(/swarm\.aggregate/);
  });

  test("a duplicate row for one kind refuses and names both", async () => {
    await seedFiveSwarmRows({ enabled: false, nextRunAt: null });
    await sql`
      INSERT INTO job_schedules (kind, cron, payload, timezone, enabled, catchup_policy)
      VALUES ('swarm.publish', '0 * * * *', '{}'::jsonb, 'UTC', false, 'all')`;
    await expect(readEnablementPlan(heldLock())).rejects.toThrow(/swarm\.publish/);
  });

  test("a cron string that does not parse refuses: enabling it would produce a schedule that never fires", async () => {
    await seedFiveSwarmRows({ enabled: false, nextRunAt: null });
    await sql`UPDATE job_schedules SET cron = 'not a cron' WHERE kind = 'swarm.close_window'`;
    await expect(readEnablementPlan(heldLock())).rejects.toThrow(/cron/i);
  });
});

describe("renderEnablementPlan — §6.3, shown above the y/n prompt", () => {
  const plan: EnablementPlan = {
    rows: SWARM_SCHEDULE_KINDS.map((kind): ScheduleRow => ({
      kind,
      cron: "*/5 * * * *",
      enabled: kind === "swarm.publish",
      nextRunAt: null,
      catchupPolicy: "collapse-per-bucket",
    })),
    toEnable: SWARM_SCHEDULE_KINDS.filter((kind): kind is SwarmScheduleKind => kind !== "swarm.publish"),
    alreadyEnabled: ["swarm.publish"],
    overdue: ["swarm.publish"],
  };

  test("names every row that will change and every row that will not", () => {
    const text = renderEnablementPlan(plan);
    for (const kind of SWARM_SCHEDULE_KINDS) expect(text).toContain(kind);
  });

  test("states in the operator's own words that next_run_at is not being touched", () => {
    expect(renderEnablementPlan(plan)).toContain("next_run_at");
  });

  test("explains that overdue rows are the scheduler's to drain per catchup_policy", () => {
    const text = renderEnablementPlan(plan);
    expect(text).toContain("catchup_policy");
  });

  test("carries no credential", () => {
    expect(renderEnablementPlan(plan)).not.toContain("postgres://");
  });
});

describe("applyEnablement — §6.3, one column, one transaction [integration tier]", () => {
  test("sets enabled = true on every row in the plan", async () => {
    await seedFiveSwarmRows({ enabled: false, nextRunAt: null });
    const plan = await readEnablementPlan(heldLock());
    await applyEnablement(heldLock(), plan);

    const rows = await sql<{ kind: string; enabled: boolean }[]>`
      SELECT kind, enabled FROM job_schedules WHERE kind = ANY(${[...SWARM_SCHEDULE_KINDS]})`;
    expect(rows.every((row) => row.enabled)).toBe(true);
  });

  test("never touches next_run_at — an overdue row stays overdue for the scheduler to drain", async () => {
    await seedFiveSwarmRows({ enabled: false, nextRunAt: "2020-01-01T00:00:00Z" });
    const before = await snapshotSwarmRows();
    const plan = await readEnablementPlan(heldLock());
    await applyEnablement(heldLock(), plan);
    const after = await snapshotSwarmRows();

    for (let i = 0; i < before.length; i += 1) {
      expect(after[i]?.next_run_at).toEqual(before[i]?.next_run_at);
    }
  });

  test("never touches cron, payload, timezone or catchup_policy — an enablement is not a cadence change", async () => {
    await seedFiveSwarmRows({ enabled: false, nextRunAt: "2020-01-01T00:00:00Z" });
    const before = await snapshotSwarmRows();
    const plan = await readEnablementPlan(heldLock());
    await applyEnablement(heldLock(), plan);
    const after = await snapshotSwarmRows();

    for (const column of MUTABLE_COLUMNS) {
      if (column === "enabled") continue;
      expect(after.map((row) => row[column])).toEqual(before.map((row) => row[column]));
    }
  });

  test("touches no schedule outside the five swarm.* kinds", async () => {
    await seedFiveSwarmRows({ enabled: false, nextRunAt: null });
    await sql`
      INSERT INTO job_schedules (kind, cron, payload, timezone, enabled, catchup_policy)
      VALUES ('wallet.sample_balances', '*/1 * * * *', '{}'::jsonb, 'UTC', false, 'collapse-per-bucket')
      ON CONFLICT DO NOTHING`;
    const plan = await readEnablementPlan(heldLock());
    await applyEnablement(heldLock(), plan);

    // SELECT THE ROW THIS TEST INSERTED, by its cron.
    //
    // This used to be `WHERE kind = 'wallet.sample_balances' LIMIT 1` with no
    // ORDER BY, which could not work: seed.ts already seeds that kind ENABLED
    // at two different crons (`* * * * *` and `3 * * * *`), and the unique index
    // is on (kind, cron), so the `ON CONFLICT DO NOTHING` above inserts a THIRD
    // row rather than being skipped. The unordered LIMIT 1 then returned
    // whichever row Postgres felt like — usually a pre-seeded enabled one — and
    // the assertion failed no matter how correct applyEnablement was.
    //
    // The guarantee under test is unchanged and now actually tested: a non-swarm
    // row this test disabled stays disabled.
    const [other] = await sql<{ enabled: boolean }[]>`
      SELECT enabled FROM job_schedules
       WHERE kind = 'wallet.sample_balances' AND cron = '*/1 * * * *'`;
    expect(other?.enabled).toBe(false);
    // And the pre-seeded siblings were not touched either — applyEnablement
    // must not widen from "the five swarm.* kinds" to "this kind".
    const untouched = await sql<{ enabled: boolean }[]>`
      SELECT enabled FROM job_schedules
       WHERE kind = 'wallet.sample_balances' AND cron <> '*/1 * * * *'`;
    for (const row of untouched) expect(row.enabled).toBe(true);
  });

  test("an already-enabled row is a reported no-op and is not rewritten", async () => {
    await seedFiveSwarmRows({ enabled: true, nextRunAt: "2020-01-01T00:00:00Z" });
    const plan = await readEnablementPlan(heldLock());
    expect(plan.toEnable).toHaveLength(0);
    const before = await snapshotSwarmRows();
    await applyEnablement(heldLock(), plan);
    expect(await snapshotSwarmRows()).toEqual(before);
  });

  test("returns the five rows as they stand after the write", async () => {
    await seedFiveSwarmRows({ enabled: false, nextRunAt: null });
    const plan = await readEnablementPlan(heldLock());
    const after = await applyEnablement(heldLock(), plan);
    expect(after).toHaveLength(5);
    expect(after.every((row) => row.enabled)).toBe(true);
  });

  test("a row count that does not match the plan refuses loudly: it is evidence the lock is not doing its job", async () => {
    await seedFiveSwarmRows({ enabled: false, nextRunAt: null });
    const plan = await readEnablementPlan(heldLock());
    await sql`DELETE FROM job_schedules WHERE kind = 'swarm.publish'`;
    await expect(applyEnablement(heldLock(), plan)).rejects.toThrow(/row|count|lock/i);
  });

  test("a partial enablement is impossible: a refused write leaves every row as it was", async () => {
    await seedFiveSwarmRows({ enabled: false, nextRunAt: null });
    const plan = await readEnablementPlan(heldLock());
    await sql`DELETE FROM job_schedules WHERE kind = 'swarm.publish'`;
    const before = await snapshotSwarmRows();
    await expect(applyEnablement(heldLock(), plan)).rejects.toThrow();
    expect(await snapshotSwarmRows()).toEqual(before);
  });
});

describe("promptOwnerPassword and confirm — §3 and §4.3, typed at a terminal or not at all", () => {
  test("the owner password prompt refuses with no TTY", async () => {
    await expect(promptOwnerPassword()).rejects.toThrow(/terminal|tty|interactive/i);
  });

  test("the y/n confirmation refuses on a non-interactive stdin rather than defaulting to yes", async () => {
    await expect(confirm("swarm.publish: false -> true")).rejects.toThrow(/terminal|tty|interactive|stdin/i);
  });
});

describe("writeSchedulesEnableReceipt — §4.3's fourth gate", () => {
  const receipt: SchedulesEnableReceipt = {
    command: "schedules:enable",
    writtenAt: "2026-09-23T10:00:00.000Z",
    database: "db.example.invalid/robotmoney",
    identity: "production",
    rmEnv: "prod",
    before: SWARM_SCHEDULE_KINDS.map((kind): ScheduleRow => ({
      kind,
      cron: "*/5 * * * *",
      enabled: false,
      nextRunAt: "2020-01-01T00:00:00.000Z",
      catchupPolicy: "collapse-per-bucket",
    })),
    after: SWARM_SCHEDULE_KINDS.map((kind): ScheduleRow => ({
      kind,
      cron: "*/5 * * * *",
      enabled: true,
      nextRunAt: "2020-01-01T00:00:00.000Z",
      catchupPolicy: "collapse-per-bucket",
    })),
    nextRunAtTouched: false,
    operator: "lucas",
  };

  test("writes a durable record of before, after, who and which target", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "rm-schedules-receipt-")), "receipt.json");
    await writeSchedulesEnableReceipt(path, receipt);
    const parsed = JSON.parse(readFileSync(path, "utf8")) as SchedulesEnableReceipt;
    expect(parsed.command).toBe("schedules:enable");
    expect(parsed.before).toHaveLength(5);
    expect(parsed.after.every((row) => row.enabled)).toBe(true);
    expect(parsed.operator).toBe("lucas");
    expect(parsed.database).toBe("db.example.invalid/robotmoney");
  });

  test("records that next_run_at was left alone, so a later reader knows it was a choice", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "rm-schedules-receipt-")), "receipt.json");
    await writeSchedulesEnableReceipt(path, receipt);
    const parsed = JSON.parse(readFileSync(path, "utf8")) as SchedulesEnableReceipt;
    expect(parsed.nextRunAtTouched).toBe(false);
  });

  test("carries no credential — a receipt is exactly the kind of file that gets pasted into a thread", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "rm-schedules-receipt-")), "receipt.json");
    await writeSchedulesEnableReceipt(path, receipt);
    const raw = readFileSync(path, "utf8");
    expect(raw).not.toContain("postgres://");
    expect(raw.toLowerCase()).not.toContain("password");
  });

  test("an unwritable receipt path refuses, and the refusal says the enablement DID land", async () => {
    let message = "";
    try {
      await writeSchedulesEnableReceipt("/proc/definitely/not/writable/receipt.json", receipt);
    } catch (error) {
      message = String(error);
    }
    expect(message).toMatch(/did land|landed/i);
  });
});
