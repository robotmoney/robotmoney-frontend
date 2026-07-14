// Seed invariants for the wallet-balance sampling schedule (issue #118): chain
// reads happen ONLY on the schedule, so the sampler must run every minute and a
// cold-start job must fill the table within seconds of boot. Runs against the
// ephemeral Postgres from tests/preload.ts (already migrated + seeded once); seed()
// is idempotent, so re-invoking it here is safe and self-contained.
import { expect, test } from "bun:test";
import { sql } from "../../src/db/client.ts";
import { seed } from "../../src/db/seed.ts";

test("cadence (#118): seed registers wallet.sample_balances at the every-minute cron '* * * * *'", async () => {
  await seed(); // idempotent (ON CONFLICT DO NOTHING throughout)
  const rows = await sql<{ cron: string }[]>`
    SELECT cron FROM job_schedules WHERE kind = 'wallet.sample_balances'
  `;
  // On a fresh CI/demo DB only the every-minute schedule exists.
  expect(rows.map((r) => r.cron)).toContain("* * * * *");
});

test("cold start (#118): seed enqueues exactly ONE immediate wallet.sample_balances job (idempotent on dedupe_key)", async () => {
  await seed();
  const jobs = await sql<{ kind: string; status: string }[]>`
    SELECT kind, status FROM jobs WHERE dedupe_key = 'wallet.sample_balances:coldstart'
  `;
  expect(jobs).toHaveLength(1); // one immediate sample so the endpoint has fresh data at boot
  expect(jobs[0]!.kind).toBe("wallet.sample_balances");

  // Re-running seed must NOT enqueue a duplicate (constant dedupe_key + partial
  // unique index) — the every-minute cron owns steady-state sampling thereafter.
  await seed();
  const again = await sql<{ c: number }[]>`
    SELECT count(*)::int AS c FROM jobs WHERE dedupe_key = 'wallet.sample_balances:coldstart'
  `;
  expect(again[0]!.c).toBe(1);
});
