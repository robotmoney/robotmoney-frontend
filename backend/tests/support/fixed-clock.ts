// Freeze the wall clock for a test — either one async operation
// (`withFrozenClock`) or every test in a file (`useFrozenClock`, mirroring
// `useCleanDatabase[PerTest]` in this same directory).
//
// WHY (issue #827): some tests exercise production code that legitimately
// reads `new Date()`/`Date.now()` itself (e.g. worker/handlers/wallet.ts's
// sampleWalletBalances computing its own `sampleDate`, slot.ts's classifySlot
// defaulting `now` to `new Date()`, and api/routes/admin.ts computing
// `serverDate` for regime/research staleness). A test that ALSO computes
// "today" from the real clock — to seed a row, or to build its expected
// value — is racing that production read across whatever wall-clock instant
// the two happen to land on: usually invisible, but deterministically wrong
// in the minutes either side of 00:00 UTC. `wallet-balances.test.ts` used to
// paper over exactly this with a "re-run after 00:06 UTC" precondition guard;
// the correct fix is for the test to control the clock, not to wait for the
// real one to move into a safe window.
//
// HOW THIS IS SAFE: tests/support/clean-db.ts's own header records that `bun
// test` runs every backend test file in ONE process, one file at a time — so
// replacing the global `Date` constructor for the lifetime of a test (or one
// `await`) can never race a concurrently-running test in another file. The
// swap is always undone before control returns to the caller.
import { afterEach, beforeEach } from "bun:test";

// A subclass, not a plain override of `Date.now`: production code that builds
// "today" via `new Date().toISOString()` (rather than `Date.now()`) needs the
// zero-argument constructor pinned too. Every OTHER overload (`new Date(ms)`,
// `new Date(y, m, d)`, ...) is passed straight through to the real
// constructor, so code that builds an explicit instant — like slot.ts's
// `bucketStart()` — is unaffected.
function frozenDateClass(fixedMs: number): typeof Date {
  const RealDate = Date;
  class FrozenDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(fixedMs);
      else super(...(args as ConstructorParameters<typeof Date>));
    }
    static override now(): number {
      return fixedMs;
    }
  }
  return FrozenDate as unknown as typeof Date;
}

function parseOrThrow(fixedIso: string): number {
  const fixedMs = Date.parse(fixedIso);
  if (Number.isNaN(fixedMs)) throw new Error(`fixed-clock: invalid ISO instant "${fixedIso}"`);
  return fixedMs;
}

/** Freeze the clock for the duration of `fn`, then restore it — even if `fn` throws. */
export async function withFrozenClock<T>(fixedIso: string, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.Date;
  globalThis.Date = frozenDateClass(parseOrThrow(fixedIso));
  try {
    return await fn();
  } finally {
    globalThis.Date = original;
  }
}

/**
 * Freeze the clock for every test in the calling file, at module scope:
 *
 *     useFrozenClock("2026-06-15T12:00:00.000Z");
 *
 * Prefer this over per-test `withFrozenClock` wrapping when most or all of a
 * file's tests compute "today" against the real clock — it keeps the fixed
 * instant as one declaration instead of repeating it at every call site.
 */
export function useFrozenClock(fixedIso: string): void {
  const fixedMs = parseOrThrow(fixedIso);
  let original: typeof Date;
  beforeEach(() => {
    original = globalThis.Date;
    globalThis.Date = frozenDateClass(fixedMs);
  });
  afterEach(() => {
    globalThis.Date = original;
  });
}
