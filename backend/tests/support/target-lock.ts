// The §2 session target lock, held the way a real tool holds it, for tests that
// drive `runMigrate` directly.
//
// `runMigrate` requires a held lock (backend/scripts/migrate-run.ts): it proves
// the lock at every boundary and fences every transaction, and it no longer
// takes a session lock of its own. A test that calls it stands in for the tool
// that would have acquired the lock — `bun run migrate` or `bun smoke` — so it
// acquires it the same way, through `acquireTargetLock` over a direct
// connection, and releases it afterwards. Never a hand-rolled
// `pg_advisory_lock`: a test that took the lock in some other form would prove
// nothing about the form the tools take.
import postgres from "postgres";
import { acquireTargetLock, readTargetState, type TargetLock } from "../../src/db/target-lock.ts";

/** Acquire the target lock on the database `url` names, as a test tool with no plan. */
export async function holdTargetLock(url: string, tool = "test"): Promise<TargetLock> {
  const reader = postgres(url, { max: 1, onnotice: () => {} });
  let expected;
  try {
    expected = await readTargetState(reader);
  } finally {
    await reader.end({ timeout: 5 });
  }
  const acquired = await acquireTargetLock({
    databaseUrl: url,
    holder: { tool, planId: null, instance: null, host: "test-host", pid: process.pid },
    timeoutMs: 10_000,
    expected,
  });
  if (!acquired.acquired) throw new Error(`test could not take the target lock: ${acquired.reason}`);
  return acquired.lock;
}

/** Run `body` under the target lock on `url`, releasing it on every exit path. */
export async function withTargetLock<T>(url: string, body: (lock: TargetLock) => Promise<T>, tool = "test"): Promise<T> {
  const lock = await holdTargetLock(url, tool);
  try {
    return await body(lock);
  } finally {
    await lock.release();
  }
}
