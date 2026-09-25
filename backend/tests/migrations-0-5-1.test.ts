// The three migrations v0.5.1 carries, executed against the real migrated
// database (tests/preload.ts applies every file under backend/migrations).
//
//   0061_rm_worker_wallet_backfill_grant  main's file, verbatim: production's
//     worker died 288 times in 24 h on "permission denied for table
//     wallet_backfill_state" (2026-09-25).
//   0062_rm_readonly_sequence_select      already recorded in production;
//     carried so code and database agree (its own test file covers it).
//   0063_swarm_judge_model_default        production's judge had no model.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { sql } from "../src/db/client.ts";
import { useCleanDatabase } from "./support/clean-db.ts";

useCleanDatabase(import.meta.file);

const MIGRATIONS = join(import.meta.dir, "..", "migrations");
const WORKER_PASSWORD = "rm_worker_ci_password";

describe("0061 — rm_worker may write the wallet-backfill driver's own tables", () => {
  let worker: postgres.Sql<{}>;

  beforeAll(async () => {
    await sql.unsafe(`ALTER ROLE rm_worker WITH LOGIN PASSWORD '${WORKER_PASSWORD}'`);
    const url = new URL(process.env.DATABASE_URL!);
    url.username = "rm_worker";
    url.password = WORKER_PASSWORD;
    worker = postgres(url.toString(), { max: 1, onnotice: () => {} });
  });

  afterAll(async () => {
    await worker?.end({ timeout: 5 });
  });

  for (const table of ["wallet_backfill_state", "chain_day_blocks", "chain_address_floors"]) {
    for (const priv of ["INSERT", "UPDATE", "DELETE"]) {
      test(`${priv} on ${table}`, async () => {
        const [row] = await worker`SELECT has_table_privilege(current_user, ${`public.${table}`}, ${priv}) AS ok`;
        expect(row!.ok).toBe(true);
      });
    }
  }

  test("and nothing broader: rm_worker still cannot write a table 0054 kept from it", async () => {
    const [row] = await worker`SELECT has_table_privilege(current_user, 'public.swarm_session_judgements', 'INSERT') AS ok`;
    expect(row!.ok).toBe(false);
  });
});

describe("0063 — the judge has a model", () => {
  const ddl = readFileSync(join(MIGRATIONS, "0063_swarm_judge_model_default.sql"), "utf8");

  test("a migrated database carries the CI/driver model", async () => {
    const [row] = await sql`SELECT model FROM swarm_judge_config WHERE id = 1`;
    expect(row!.model).toBe("opencode/deepseek-v4-flash");
  });

  test("fills a NULL model and leaves mode alone", async () => {
    await sql`UPDATE swarm_judge_config SET mode = 'enforce', model = NULL WHERE id = 1`;
    await sql.unsafe(ddl);
    const [row] = await sql`SELECT mode, model FROM swarm_judge_config WHERE id = 1`;
    expect(row).toEqual({ mode: "enforce", model: "opencode/deepseek-v4-flash" });
  });

  test("never overrides a model an operator chose", async () => {
    await sql`UPDATE swarm_judge_config SET model = 'opencode/some-other-model' WHERE id = 1`;
    await sql.unsafe(ddl);
    const [row] = await sql`SELECT model FROM swarm_judge_config WHERE id = 1`;
    expect(row!.model).toBe("opencode/some-other-model");
  });

  test("does not turn an 'off' judge on", async () => {
    await sql`UPDATE swarm_judge_config SET mode = 'off', model = NULL WHERE id = 1`;
    await sql.unsafe(ddl);
    const [row] = await sql`SELECT mode FROM swarm_judge_config WHERE id = 1`;
    expect(row!.mode).toBe("off");
  });
});
