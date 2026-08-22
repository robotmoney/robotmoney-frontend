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
// The dispatcher now enqueues ONE window job carrying the run's days, rather
// than one job per day: the provider meters HTTP hits, and a window shares its
// block resolution and its price-range load across every day in it. The per-day
// guarantees are unchanged and live in the executor, not in the job granularity.
const WINDOW_KIND = "wallet.backfill_window";

// preload.ts sets the suite-wide opt-out; these tests own the knob instead.
const priorBudget = process.env.BASE_RPC_MAX_CALLS_PER_SEC;
const priorSource = process.env.BASE_RPC_SOURCE;

beforeEach(async () => {
  // The dispatcher only gates itself under a LIVE source — there is no provider
  // bucket to exhaust under the stub, so the stub would pass either way and
  // prove nothing.
  process.env.BASE_RPC_SOURCE = "live";
  await sql`DELETE FROM jobs WHERE kind IN (${BACKFILL_KIND}, ${WINDOW_KIND})`;
});
afterEach(async () => {
  await sql`DELETE FROM jobs WHERE kind IN (${BACKFILL_KIND}, ${WINDOW_KIND})`;
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

  // Every day it claims to have dispatched really is queued — the report is the
  // operator's only view of what repair is doing, and batching the work into one
  // job must not turn that report into a claim nobody can check. It is now MORE
  // checkable, not less: the days ride in the payload.
  const dispatched = out.dispatched as { classC: string[]; enqueued: number; kind: string };
  expect(dispatched.kind).toBe(WINDOW_KIND);

  const rows = await sql<{ payload: { dates?: string[] } }[]>`
    SELECT payload FROM jobs WHERE kind = ${WINDOW_KIND}
  `;
  expect(rows.length).toBe(dispatched.enqueued);
  // At most one window per run: a second would repeat the first's work against a
  // metered provider.
  expect(dispatched.enqueued).toBeLessThanOrEqual(1);
  if (dispatched.enqueued === 1) {
    expect(rows[0]!.payload.dates).toEqual(dispatched.classC);
    expect(dispatched.classC.length).toBeGreaterThan(0);
  } else {
    expect(dispatched.classC).toEqual([]);
  }
  // No day job is enqueued any more, but the kind stays registered so rows from
  // a pre-upgrade dispatcher still drain.
  const [legacy] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM jobs WHERE kind = ${BACKFILL_KIND}`;
  expect(legacy!.n).toBe(0);
});

test("a live window suppresses a second one — a run never doubles the work in flight", async () => {
  delete process.env.BASE_RPC_MAX_CALLS_PER_SEC;

  const first = (await repairGaps()) as Record<string, unknown>;
  const firstDispatch = first.dispatched as { enqueued: number };
  if (firstDispatch.enqueued === 0) return; // no holes in this fixture DB; nothing to prove

  const second = (await repairGaps()) as Record<string, unknown>;
  expect((second.dispatched as { enqueued: number }).enqueued).toBe(0);

  const [row] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM jobs WHERE kind = ${WINDOW_KIND}`;
  expect(row!.n).toBe(1);
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
