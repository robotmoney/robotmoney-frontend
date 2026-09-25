// The judge switch admits two modes — issue #1026, decision D53 (1), migration
// 0082.
//
// AUTHORITY: D53 (1) waives D48's judge-replay prerequisite and removes
// `shadow` from every write path; docs/technical/system-scheduler-spec.md §4.4
// captures "the judge mode in force (`off` or `enforce`, per D48)".
//
// THREE PROPERTIES, each executed against the real migration text:
//   1. a database still holding `shadow` is healed to `off` by 0082, with an
//      audit row naming the migration, and a rerun changes nothing;
//   2. after 0082 the column refuses `shadow` from ANY writer, including one
//      that bypasses src/swarm/judge-config.ts;
//   3. historical judgements and their mode stay readable: 0082 does not touch
//      `swarm_session_judgements`, whose CHECK still admits `shadow`.
//
// The pre-0082 state is rebuilt in this file's own database (useCleanDatabase)
// by putting 0039's CHECK back, which is exactly the catalog every database
// had before this migration.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "../src/db/client.ts";
import { listJudgements, openEpoch, turnOverEpoch } from "../src/swarm/domain.ts";
import { getJudgeConfig } from "../src/swarm/judge-config.ts";
import { useCleanDatabase } from "./support/clean-db.ts";
import { activeSubject } from "./support/epoch-fixtures.ts";

useCleanDatabase(import.meta.file);

const MIGRATION = readFileSync(join(import.meta.dir, "..", "migrations", "0082_judge_config_two_modes.sql"), "utf8");

async function sqlstate(statement: () => Promise<unknown>): Promise<string | null> {
  try {
    await statement();
    return null;
  } catch (e) {
    return (e as { code?: string }).code ?? "no-sqlstate";
  }
}

/** Put 0039's three-mode CHECK back and plant a `shadow` row, as a pre-0082 database holds it. */
async function plantPre0082Shadow(): Promise<void> {
  await sql.unsafe(`
    ALTER TABLE swarm_judge_config DROP CONSTRAINT swarm_judge_config_mode_check;
    ALTER TABLE swarm_judge_config ADD CONSTRAINT swarm_judge_config_mode_check
      CHECK (mode IN ('off', 'shadow', 'enforce'));`);
  await sql`UPDATE swarm_judge_config SET mode = 'shadow', model = 'legacy/shadow-model' WHERE id = 1`;
}

const healRows = async (): Promise<number> =>
  Number(
    ((await sql`SELECT count(*)::int AS n FROM audit_log WHERE actor = 'migration 0082'`) as unknown as { n: number }[])[0]!
      .n,
  );

test("0082 declares itself additive and tightens the CHECK to off | enforce", async () => {
  expect(MIGRATION.split("\n").slice(0, 2)).toEqual(["-- compat: additive", "-- metadata_version: 1"]);
  const [{ def }] = (await sql`
    SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
     WHERE conname = 'swarm_judge_config_mode_check'`) as unknown as { def: string }[];
  expect(def).toBe("CHECK ((mode = ANY (ARRAY['off'::text, 'enforce'::text])))");
});

test("after 0082 no writer can store `shadow` — not even one that bypasses judge-config.ts", async () => {
  expect(await sqlstate(() => sql`UPDATE swarm_judge_config SET mode = 'shadow', model = 'x/y' WHERE id = 1`)).toBe(
    "23514",
  );
  expect((await sql`SELECT mode FROM swarm_judge_config WHERE id = 1`)[0]!.mode).not.toBe("shadow");
});

test("a database still holding `shadow` is healed to `off`, audited, and a rerun is a no-op", async () => {
  await plantPre0082Shadow();
  // Red control: the planted state really is the retired mode.
  expect((await sql`SELECT mode FROM swarm_judge_config WHERE id = 1`)[0]!.mode).toBe("shadow");
  const before = await healRows();

  await sql.unsafe(MIGRATION);

  const [row] = (await sql`SELECT mode, model FROM swarm_judge_config WHERE id = 1`) as unknown as {
    mode: string;
    model: string | null;
  }[];
  expect(row!.mode).toBe("off");
  expect((await getJudgeConfig()).mode).toBe("off");
  const [audit] = (await sql`
    SELECT action, before_state, after_state FROM audit_log WHERE actor = 'migration 0082' ORDER BY id DESC LIMIT 1`) as unknown as {
    action: string;
    before_state: unknown;
    after_state: unknown;
  }[];
  expect(audit).toEqual({ action: "judge_config", before_state: { mode: "shadow" }, after_state: { mode: "off" } });
  expect(await healRows()).toBe(before + 1);

  // And the tightened CHECK is back in force.
  expect(await sqlstate(() => sql`UPDATE swarm_judge_config SET mode = 'shadow' WHERE id = 1`)).toBe("23514");

  // Rerun: nothing left to heal, nothing recorded.
  await sql.unsafe(MIGRATION);
  expect(await healRows()).toBe(before + 1);
  expect((await sql`SELECT mode FROM swarm_judge_config WHERE id = 1`)[0]!.mode).toBe("off");
});

test("judgements recorded under `shadow` stay on file and readable — 0082 touches only the switch", async () => {
  const subjectId = await activeSubject("judge_mode_history", 600);
  const opened = await openEpoch(subjectId);
  if (!opened.ok) throw new Error("openEpoch failed");
  const turned = await turnOverEpoch(subjectId, opened.sessionId);
  if (!turned.ok) throw new Error("turnOverEpoch failed");
  const sessionId = turned.closedSessionId;
  await sql`
    INSERT INTO swarm_session_judgements
      (session_id, mode, source, fallback_reason, prompt_hash, inputs_digest, take_count, min_takes, opinion)
    VALUES (${sessionId}, 'shadow', 'fallback', 'model_unconfigured', 'history-prompt-hash', 'history-digest', 1, 3,
            '{"rationale":"a shadow-era judgement","disagreements":[],"release_safety":{"release":"hold","thinly_supported":true,"take_count":1,"min_takes":3,"concerns":["history"]}}'::jsonb)`;
  const [{ def }] = (await sql`
    SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
     WHERE conrelid = 'swarm_session_judgements'::regclass AND conname = 'swarm_session_judgements_mode_check'`) as unknown as {
    def: string;
  }[];
  expect(def).toContain("'shadow'::text");
  const rows = await listJudgements(sessionId);
  expect(rows.map((r) => r.mode)).toEqual(["shadow"]);
});
