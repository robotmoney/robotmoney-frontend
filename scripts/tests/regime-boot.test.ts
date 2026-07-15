// Demo-boot regime freshness/retry decision (issue #126). The boot self-heal
// loop in scripts/lib/demo-main.ts re-checks GET /api/dashboards/regime-snapshots
// after the seed regime run and must: stop when the served snapshot is FRESH,
// re-run the analytics while attempts remain when it is STALE (or the check
// itself failed), and give up with the LOUD operator warning on the final
// attempt. That decision is the pure decideRegimeBootAction — imported here from
// the exact module demo-main.ts consumes, so these assertions cover the shipped
// boot behaviour, not a copy.
import { expect, test } from "bun:test";
import {
  decideRegimeBootAction,
  REGIME_BOOT_MAX_ATTEMPTS,
  type RegimeBootDecision,
} from "../lib/regime-boot.ts";

test("a fresh snapshot stops the loop on any attempt (hand off to the worker cron)", () => {
  const fresh = { stale: false, asof: "2026-07-15", ageDays: 0 };
  for (let attempt = 1; attempt <= REGIME_BOOT_MAX_ATTEMPTS; attempt++) {
    const d = decideRegimeBootAction(fresh, attempt);
    expect(d.action).toBe("fresh");
    expect(d.message).toContain("regime snapshot fresh");
    expect(d.message).toContain("2026-07-15");
  }
});

test("a stale snapshot with attempts remaining takes the re-run branch, naming the attempt", () => {
  const stale = { stale: true, asof: "2026-06-29", ageDays: 16 };
  const d1 = decideRegimeBootAction(stale, 1);
  expect(d1.action).toBe("rerun");
  expect(d1.message).toContain("STALE");
  expect(d1.message).toContain("asof 2026-06-29");
  expect(d1.message).toContain(`attempt 1/${REGIME_BOOT_MAX_ATTEMPTS}`);
  expect(decideRegimeBootAction(stale, REGIME_BOOT_MAX_ATTEMPTS - 1).action).toBe("rerun");
});

test("still stale on the final attempt gives up LOUDLY (warning glyph + banner pointer), never a silent pass", () => {
  const d = decideRegimeBootAction({ stale: true, asof: "2026-06-29", ageDays: 16 }, REGIME_BOOT_MAX_ATTEMPTS);
  expect(d.action).toBe("give-up");
  expect(d.message).toContain("⚠");
  expect(d.message).toContain(`STILL STALE after ${REGIME_BOOT_MAX_ATTEMPTS} attempts`);
  expect(d.message).toContain("staleness banner");
});

test("a failed freshness check (null staleness) is treated as stale — retried, never trusted silently", () => {
  const d1 = decideRegimeBootAction(null, 1);
  expect(d1.action).toBe("rerun");
  expect(d1.message).toContain("asof none");
  const dLast = decideRegimeBootAction(null, REGIME_BOOT_MAX_ATTEMPTS);
  expect(dLast.action).toBe("give-up");
  expect(dLast.message).toContain("asof none");
});

test("an empty-table verdict (stale:true, asof:null) reports 'asof none' rather than 'null'", () => {
  const d = decideRegimeBootAction({ stale: true, asof: null, ageDays: null }, 1);
  expect(d.action).toBe("rerun");
  expect(d.message).toContain("asof none");
  expect(d.message).not.toContain("asof null");
});

test("the shipped boot sequence: stale, stale, then fresh → rerun, rerun, fresh (bounded at 3 attempts)", () => {
  // Drive the decision exactly as demo-main.ts's for-loop does, over the
  // self-heal scenario the feature exists for: the first two checks see the
  // frozen seed floor, the third sees the re-run's fresh snapshot.
  const checks = [
    { stale: true, asof: "2026-06-29", ageDays: 16 },
    { stale: true, asof: "2026-06-29", ageDays: 16 },
    { stale: false, asof: "2026-07-15", ageDays: 0 },
  ];
  const actions: RegimeBootDecision["action"][] = [];
  for (let attempt = 1; attempt <= REGIME_BOOT_MAX_ATTEMPTS; attempt++) {
    const d = decideRegimeBootAction(checks[attempt - 1]!, attempt);
    actions.push(d.action);
    if (d.action === "fresh") break;
  }
  expect(actions).toEqual(["rerun", "rerun", "fresh"]);
  expect(REGIME_BOOT_MAX_ATTEMPTS).toBe(3);
});
