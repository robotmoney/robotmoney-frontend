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
describe("0061 — rm_worker may write the wallet-backfill driver's own tables", () => {
  let worker: postgres.Sql<{}>;

  beforeAll(() => {
    // The harness provisions rm_worker's login (preload-roles.test.ts), and the
    // test connection may not ALTER a role it has no ADMIN OPTION on.
    worker = postgres(process.env.WORKER_DATABASE_URL!, { max: 1, onnotice: () => {} });
  });

  afterAll(async () => {
    await worker?.end({ timeout: 5 });
  });

  for (const table of ["wallet_backfill_state", "chain_day_blocks", "chain_address_floors"]) {
    // No DELETE: 0107 (D55) leaves DELETE and TRUNCATE to rm_owner alone.
    for (const priv of ["INSERT", "UPDATE"]) {
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

  test("a migrated database carries the CI/driver model (0099 strips its `opencode/` prefix, 0111 renames it)", async () => {
    const [row] = await sql`SELECT model FROM swarm_judge_config WHERE id = 1`;
    expect(row!.model).toBe("deepseek-v4.1-flash");
  });

  test("fills a NULL model and leaves mode alone", async () => {
    // Production's row was enforce + NULL when 0063 ran. Main's 0056 CHECK
    // makes an ON judge with no model unrepresentable, so the fill is
    // exercised on an `off` row here; 0063 itself is byte-identical to what
    // production recorded.
    await sql`UPDATE swarm_judge_config SET mode = 'off', model = NULL WHERE id = 1`;
    await sql.unsafe(ddl);
    const [row] = await sql`SELECT mode, model FROM swarm_judge_config WHERE id = 1`;
    expect(row).toEqual({ mode: "off", model: "opencode/deepseek-v4-flash" });
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

describe("0099 — the judge model is stored as the bare wire id ", () => {
  const ddl = readFileSync(join(MIGRATIONS, "0099_swarm_judge_model_bare_id.sql"), "utf8");

  test("strips a leading `opencode/` and leaves mode alone", async () => {
    await sql`UPDATE swarm_judge_config SET mode = 'enforce', model = 'opencode/deepseek-v4-flash' WHERE id = 1`;
    await sql.unsafe(ddl);
    const [row] = await sql`SELECT mode, model FROM swarm_judge_config WHERE id = 1`;
    expect(row).toEqual({ mode: "enforce", model: "deepseek-v4-flash" });
    // Idempotent: a second run matches no row.
    await sql.unsafe(ddl);
    expect((await sql`SELECT model FROM swarm_judge_config WHERE id = 1`)[0]!.model).toBe("deepseek-v4-flash");
  });

  test("never touches another provider's id, a bare id, or a bare `opencode/`", async () => {
    for (const model of ["vendor/some-judge", "deepseek-v4-flash"]) {
      await sql`UPDATE swarm_judge_config SET mode = 'enforce', model = ${model} WHERE id = 1`;
      await sql.unsafe(ddl);
      expect((await sql`SELECT model FROM swarm_judge_config WHERE id = 1`)[0]!.model).toBe(model);
    }
    // Stripping `opencode/` would leave nothing: left as is rather than pushed
    // into 0056's "on judge must have a model" CHECK (on an off row here).
    await sql`UPDATE swarm_judge_config SET mode = 'off', model = 'opencode/' WHERE id = 1`;
    await sql.unsafe(ddl);
    expect((await sql`SELECT model FROM swarm_judge_config WHERE id = 1`)[0]!.model).toBe("opencode/");
  });

  test("the stored value is what setJudgeConfig() would store", async () => {
    const { normalizeJudgeModel } = await import("../src/swarm/judge-config.ts");
    await sql`UPDATE swarm_judge_config SET model = 'opencode/deepseek-v4-flash' WHERE id = 1`;
    await sql.unsafe(ddl);
    const stored = String((await sql`SELECT model FROM swarm_judge_config WHERE id = 1`)[0]!.model);
    expect(stored).toBe(normalizeJudgeModel("opencode/deepseek-v4-flash"));
  });
});

describe("0093 — the judge model follows the provider's rename (2026-10-05)", () => {
  const ddl = readFileSync(join(MIGRATIONS, "0111_swarm_judge_model_deepseek_v4_1_flash.sql"), "utf8");

  test("converts the bare and the provider-qualified retired id, leaves mode alone, and is idempotent", async () => {
    for (const old of ["deepseek-v4-flash", "opencode/deepseek-v4-flash"]) {
      await sql`UPDATE swarm_judge_config SET mode = 'enforce', model = ${old} WHERE id = 1`;
      await sql.unsafe(ddl);
      const [row] = await sql`SELECT mode, model FROM swarm_judge_config WHERE id = 1`;
      expect(row).toEqual({ mode: "enforce", model: "deepseek-v4.1-flash" });
      await sql.unsafe(ddl);
      expect((await sql`SELECT model FROM swarm_judge_config WHERE id = 1`)[0]!.model).toBe("deepseek-v4.1-flash");
    }
  });

  test("never touches another model an operator chose", async () => {
    for (const model of ["deepseek-v4-pro", "vendor/some-judge"]) {
      await sql`UPDATE swarm_judge_config SET mode = 'enforce', model = ${model} WHERE id = 1`;
      await sql.unsafe(ddl);
      expect((await sql`SELECT model FROM swarm_judge_config WHERE id = 1`)[0]!.model).toBe(model);
    }
  });
});
