// THE LEVER'S ADMIN PATH (R13).
//
// The pure gates are covered by judge-fault-injection.test.ts. This file is the
// half that needs a database, and it protects two things:
//
//   1. ARMING IS REFUSED ON THE DEFAULT PATH, and the refusal is a 403 an
//      operator can act on rather than an inert row they believe is working.
//   2. ARMING WRITES AN AUDIT ROW — the artifact an acceptance bundle cites to
//      bound the window during which the stack was mutated — and that row does
//      NOT carry the injected body.
//
// WHAT IT NO LONGER PROTECTS (issue #1026, D53 point 4). "An armed lever faults
// a real judging" and "the judgement row records what the completion cost"
// drove the backend `judgeSession()`, the lever's only consumer and the only
// writer of the spend columns. That judge is deleted — the judge is a
// participant — so those tests went with it.
//
// ARMING IS NOW REFUSED, and that is pinned here too. With no consumer, an
// accepted arm would be the inert row point 1 exists to prevent, so once the
// process gates pass the admin path answers 409
// `fault_injection_has_no_consumer` and writes nothing. The module-level write
// and consume are still exercised directly below, because they are what the
// participant will call when it takes the lever over.
import { afterEach, beforeAll, afterAll, expect, test } from "bun:test";
import * as admin from "../src/swarm/admin.ts";
import { sql } from "../src/db/client.ts";
import { useCleanDatabasePerTest } from "./support/clean-db.ts";
import {
  consumeJudgeFaultInjection,
  FAULT_INJECTION_ACCEPTANCE_ENV,
  FAULT_INJECTION_FLAG_ENV,
  getJudgeFaultInjection,
  writeJudgeFaultInjection,
} from "../src/swarm/judge-fault-injection.ts";

useCleanDatabasePerTest(import.meta.file);

const MALFORMED = "}{ not json — injected by the AC-E2E-06 lever";

/** Restores whatever the suite's process env carried, test by test. */
const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const k of [FAULT_INJECTION_FLAG_ENV, FAULT_INJECTION_ACCEPTANCE_ENV]) saved[k] = process.env[k];
});
afterEach(() => {
  for (const k of [FAULT_INJECTION_FLAG_ENV, FAULT_INJECTION_ACCEPTANCE_ENV]) delete process.env[k];
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
});

// ── 1 + 2. The admin path ─────────────────────────────────────────────────

test("arming the lever is REFUSED by default, and refusing writes no row", async () => {
  const refused = await admin.setJudgeFaultInjectionAdmin({ enabled: true, body: MALFORMED, remaining: 1 });
  expect(refused.ok).toBe(false);
  expect(refused.status).toBe(403);
  expect(refused.error).toBe("fault_injection_refused");
  expect(refused.reason).toBe("flag_absent");
  expect((await getJudgeFaultInjection()).enabled).toBe(false);
  expect(await sql`SELECT 1 FROM audit_log WHERE action = 'judge_fault_injection'`).toHaveLength(0);
});

test("with every process gate open, arming is REFUSED because nothing consumes the lever, and writes nothing", async () => {
  process.env[FAULT_INJECTION_FLAG_ENV] = "1";
  process.env[FAULT_INJECTION_ACCEPTANCE_ENV] = "1";
  expect(admin.FAULT_INJECTION_HAS_CONSUMER).toBe(false);
  const refused = await admin.setJudgeFaultInjectionAdmin({
    enabled: true, body: MALFORMED, remaining: 2, note: "AC-E2E-06 rehearsal",
  });
  expect(refused.ok).toBe(false);
  expect(refused.status).toBe(409);
  expect(refused.error).toBe("fault_injection_has_no_consumer");
  // Not an inert row an operator believes is working: nothing was written,
  // nothing was audited, and the body went nowhere.
  expect((await getJudgeFaultInjection()).enabled).toBe(false);
  expect(await sql`SELECT 1 FROM audit_log WHERE action = 'judge_fault_injection'`).toHaveLength(0);
  expect(JSON.stringify(refused)).not.toContain(MALFORMED);
});

test("disarming is never refused, is audited without the body, and clears a row armed before the removal", async () => {
  // A row armed before the lever lost its consumer, written the only way that
  // is still possible: the module write, beneath the admin path.
  await writeJudgeFaultInjection({ enabled: true, body: MALFORMED, remaining: 2 }, "pre-removal");
  expect((await getJudgeFaultInjection()).enabled).toBe(true);
  // …and the GET names it without echoing it.
  const read = await admin.getJudgeFaultInjectionAdmin();
  expect(JSON.stringify(read)).not.toContain(MALFORMED);
  expect((read.faultInjection as any).bodyChars).toBe(MALFORMED.length);
  expect((read.faultInjection as any).bodyDigest).toMatch(/^[0-9a-f]{16}$/);

  const off = await admin.setJudgeFaultInjectionAdmin({ enabled: false });
  expect(off.ok).toBe(true);
  const state = await getJudgeFaultInjection();
  expect(state.enabled).toBe(false);
  expect(state.body).toBe("");
  expect(state.remaining).toBe(0);
  const rows = await sql`SELECT scope FROM audit_log WHERE action = 'judge_fault_injection'` as any[];
  expect(rows).toHaveLength(1);
  expect(rows[0].scope.enabled).toBe(false);
  expect(JSON.stringify(rows[0].scope)).not.toContain(MALFORMED);
});

test("an armed lever with no body, or no calls, is refused by the module write", async () => {
  await expect(writeJudgeFaultInjection({ enabled: true, body: "  ", remaining: 1 }, "t")).rejects.toThrow(/non-empty body/);
  await expect(writeJudgeFaultInjection({ enabled: true, body: MALFORMED, remaining: 0 }, "t")).rejects.toThrow(/remaining/);
  expect((await getJudgeFaultInjection()).enabled).toBe(false);
  // The control: the same call with both present is accepted.
  expect((await writeJudgeFaultInjection({ enabled: true, body: MALFORMED, remaining: 1 }, "t")).enabled).toBe(true);
});

test("consuming the lever disarms it at zero", async () => {
  await writeJudgeFaultInjection({ enabled: true, body: MALFORMED, remaining: 2 }, "t");
  await consumeJudgeFaultInjection();
  expect(await getJudgeFaultInjection()).toMatchObject({ enabled: true, remaining: 1 });
  await consumeJudgeFaultInjection();
  const spent = await getJudgeFaultInjection();
  expect(spent).toMatchObject({ enabled: false, remaining: 0, body: "" });
  // A spent lever cannot go negative.
  await consumeJudgeFaultInjection();
  expect((await getJudgeFaultInjection()).remaining).toBe(0);
});
