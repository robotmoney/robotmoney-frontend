// THE ONE BEHAVIOUR THE 0.3.0 GAP REPAIR EXISTS FOR: an ordinary live
// deployment, configured with nothing at all, dispatches wallet AUM / sleeve
// repair on its own.
//
// RED CONTROL. Against the pre-change tree the first test fails outright: with
// BASE_RPC_MAX_CALLS_PER_SEC unset, `resolveRpcRateBudget` returned null,
// `assertRpcBudgetConfigured` threw, and `repairGaps` returned
// `status: "skipped"` on every one of its hourly runs — the feature shipped
// inert and stayed inert until an operator measured a budget the provider does
// not publish. See decisions.md's PD6 amendment and
// chain/base-rpc-client.ts::DEFAULT_RATE_PER_SEC.
//
// The opt-OUT is still real, and the second test pins it: a deployment that
// says BASE_RPC_MAX_CALLS_PER_SEC=0 has turned the limiter off, and an unpaced
// sweep against a per-IP-metered provider is the 2026-08-10 incident this
// feature exists to repair. It must decline, not proceed.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { sql } from "../src/db/worker-client.ts";
import { repairGaps } from "../src/worker/handlers/repair.ts";

const BACKFILL_KIND = "wallet.backfill_day";

// preload.ts sets the suite-wide opt-out; these tests own the knob instead.
const priorBudget = process.env.BASE_RPC_MAX_CALLS_PER_SEC;
const priorSource = process.env.BASE_RPC_SOURCE;

beforeEach(async () => {
  // The dispatcher only gates itself under a LIVE source — there is no provider
  // bucket to exhaust under the stub, so the stub would pass either way and
  // prove nothing.
  process.env.BASE_RPC_SOURCE = "live";
  await sql`DELETE FROM jobs WHERE kind = ${BACKFILL_KIND}`;
});
afterEach(async () => {
  await sql`DELETE FROM jobs WHERE kind = ${BACKFILL_KIND}`;
  if (priorBudget === undefined) delete process.env.BASE_RPC_MAX_CALLS_PER_SEC;
  else process.env.BASE_RPC_MAX_CALLS_PER_SEC = priorBudget;
  if (priorSource === undefined) delete process.env.BASE_RPC_SOURCE;
  else process.env.BASE_RPC_SOURCE = priorSource;
});

test("unconfigured deployment: ops.repair_gaps DISPATCHES rather than declining", async () => {
  delete process.env.BASE_RPC_MAX_CALLS_PER_SEC;

  const out = (await repairGaps()) as Record<string, unknown>;
  expect(out.ok).toBe(true);
  // Not "skipped" — that is the inert path, and no amount of gap width excuses it.
  expect(out.status).toBeUndefined();
  expect(out.reason).toBeUndefined();
  // The dispatcher reports its plan whether or not this database happens to
  // have holes; these fields exist only on the path that actually ran.
  expect(out.dispatched).toBeDefined();
  expect(out.perRunCap).toBeGreaterThan(0);

  // Every day it claims to have enqueued really is a queued job — the report is
  // the operator's only view of what repair is doing.
  const dispatched = out.dispatched as { classC: string[]; enqueued: number };
  const [row] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM jobs WHERE kind = ${BACKFILL_KIND}`;
  expect(row!.n).toBe(dispatched.enqueued);
  expect(dispatched.classC.length).toBeGreaterThanOrEqual(dispatched.enqueued);
});

test("BASE_RPC_MAX_CALLS_PER_SEC=0 is still a refusal, and enqueues nothing", async () => {
  process.env.BASE_RPC_MAX_CALLS_PER_SEC = "0";

  const out = (await repairGaps()) as Record<string, unknown>;
  expect(out.ok).toBe(true);
  expect(out.status).toBe("skipped");
  expect(String(out.reason)).toContain("BASE_RPC_MAX_CALLS_PER_SEC=0");
  // A refusal that still queued work would be the worst of both.
  const [row] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM jobs WHERE kind = ${BACKFILL_KIND}`;
  expect(row!.n).toBe(0);
});
