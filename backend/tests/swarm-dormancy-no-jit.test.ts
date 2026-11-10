// Issue 1579: the readSeatSilence query behind GET /api/swarm/members/<ref>,
// GET /api/swarm/admin/members and GET /api/admin/overview never JIT-compiles
// on an app connection, whatever the planner's cost estimate.
//
// In production an unanalyzed 1-row swarm_dormancy_baseline pushed the plan's
// cost past jit_inline_above_cost and jit_optimize_above_cost, and every call
// spent 1-3 s compiling. Here every JIT cost threshold is forced to 0 inside a
// transaction, so the planner would JIT any plan at all; the app pools'
// jit=off startup parameter is the only thing that stops it. The control
// connection opens WITHOUT that parameter and must show a JIT section, so the
// negative assertion is not vacuous on a Postgres built without JIT.
//
// The statement is the module's own: readSeatSilence runs on a handle that
// prefixes EXPLAIN to the caller's SQL, so the test holds no copy of it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { config } from "../src/config.ts";
import { createApiPools, sql, type ApiPools, type DbHandle } from "../src/db/client.ts";
import { deriveConnectionBudget } from "../src/db/connection-budget.ts";
import { readSeatSilence } from "../src/swarm/dormancy.ts";
import { useCleanDatabase } from "./support/clean-db.ts";

useCleanDatabase(import.meta.file);

type Plan = Record<string, unknown>;

/** The EXPLAIN (ANALYZE, FORMAT JSON) of readSeatSilence(memberId), run on `db` with every JIT threshold at 0. */
async function explainSeatSilence(db: postgres.Sql<{}>, memberId: string | null): Promise<Plan> {
  return db.begin(async (tx) => {
    await tx`SET LOCAL jit_above_cost = 0`;
    await tx`SET LOCAL jit_inline_above_cost = 0`;
    await tx`SET LOCAL jit_optimize_above_cost = 0`;
    let plan: Plan | null = null;
    const explaining = (strings: TemplateStringsArray, ...values: unknown[]) => {
      const prefixed = ["EXPLAIN (ANALYZE, FORMAT JSON) " + strings[0], ...strings.slice(1)];
      const tagged = Object.assign(prefixed, { raw: ["EXPLAIN (ANALYZE, FORMAT JSON) " + strings.raw[0], ...strings.raw.slice(1)] });
      return (tx as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<{ "QUERY PLAN": Plan[] }[]>)(
        tagged as unknown as TemplateStringsArray,
        ...values,
      ).then((rows) => {
        plan = rows[0]!["QUERY PLAN"][0]!;
        return [];
      });
    };
    await readSeatSilence(memberId, explaining as unknown as DbHandle);
    if (!plan) throw new Error("readSeatSilence issued no statement");
    return plan;
  }) as Promise<Plan>;
}

describe("readSeatSilence plans without JIT on every app pool", () => {
  let pools: ApiPools;
  let control: postgres.Sql<{}>;

  beforeAll(() => {
    const budget = deriveConnectionBudget({ maxConnections: 100, superuserReserved: 3, reserved: 0 }, { request: 1, batch: 1 }, { analytics: 0, pipeline: 0 });
    pools = createApiPools(config.databaseUrl, budget);
    // The control: the same database and role, without the jit=off startup parameter.
    control = postgres(config.databaseUrl, { max: 1, onnotice: () => {} });
  });

  afterAll(async () => {
    await pools.end();
    await control.end({ timeout: 5 });
  });

  test("CONTROL: a connection without jit=off JIT-compiles the plan, so this image can JIT", async () => {
    const plan = await explainSeatSilence(control, null);
    expect(Object.keys(plan)).toContain("JIT");
  });

  for (const memberId of [null, "no-such-member"]) {
    test(`the general pool behind sql has no JIT section (memberId=${memberId})`, async () => {
      const plan = await explainSeatSilence(sql, memberId);
      expect(Object.keys(plan)).not.toContain("JIT");
    });
  }

  test("the api's request and batch pools have no JIT section", async () => {
    for (const pool of [pools.request, pools.batch]) {
      const plan = await explainSeatSilence(pool, "no-such-member");
      expect(Object.keys(plan)).not.toContain("JIT");
    }
  });
});
