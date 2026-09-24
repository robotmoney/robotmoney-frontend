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
// participant — so those tests went with it. Until a participant consumes the
// lever, arming it changes no judging; that gap is recorded on the issue
// rather than hidden behind a test of deleted code.
import { afterEach, beforeAll, afterAll, expect, test } from "bun:test";
import * as admin from "../src/swarm/admin.ts";
import { sql } from "../src/db/client.ts";
import { useCleanDatabasePerTest } from "./support/clean-db.ts";
import {
  consumeJudgeFaultInjection,
  FAULT_INJECTION_ACCEPTANCE_ENV,
  FAULT_INJECTION_FLAG_ENV,
  getJudgeFaultInjection,
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

test("arming writes an audited row that does NOT carry the injected body", async () => {
  process.env[FAULT_INJECTION_FLAG_ENV] = "1";
  const armed = await admin.setJudgeFaultInjectionAdmin({
    enabled: true, body: MALFORMED, remaining: 2, note: "AC-E2E-06 rehearsal",
  });
  expect(armed.ok).toBe(true);
  expect((armed.faultInjection as any).enabled).toBe(true);
  expect((armed.faultInjection as any).remaining).toBe(2);
  // The body is never echoed — not by the write, not by the read.
  expect(JSON.stringify(armed)).not.toContain(MALFORMED);
  expect(JSON.stringify(await admin.getJudgeFaultInjectionAdmin())).not.toContain(MALFORMED);
  // …but WHICH body is armed is still identifiable.
  expect((armed.faultInjection as any).bodyChars).toBe(MALFORMED.length);
  expect((armed.faultInjection as any).bodyDigest).toMatch(/^[0-9a-f]{16}$/);
  expect((armed.warnings as string[])[0]).toContain("TEST-ONLY");

  const rows = await sql`SELECT actor, action, scope FROM audit_log WHERE action = 'judge_fault_injection'` as any[];
  expect(rows).toHaveLength(1);
  expect(rows[0].scope.enabled).toBe(true);
  expect(rows[0].scope.acceptanceMutation).toBe(true);
  expect(JSON.stringify(rows[0].scope)).not.toContain(MALFORMED);

  // Disarming is audited too, is never refused, and CLEARS the payload.
  delete process.env[FAULT_INJECTION_FLAG_ENV];
  const off = await admin.setJudgeFaultInjectionAdmin({ enabled: false });
  expect(off.ok).toBe(true);
  const state = await getJudgeFaultInjection();
  expect(state.enabled).toBe(false);
  expect(state.body).toBe("");
  expect(state.remaining).toBe(0);
  expect(await sql`SELECT 1 FROM audit_log WHERE action = 'judge_fault_injection'`).toHaveLength(2);
});

test("an armed lever with no body, or no calls, is refused by the write", async () => {
  process.env[FAULT_INJECTION_FLAG_ENV] = "1";
  expect((await admin.setJudgeFaultInjectionAdmin({ enabled: true, body: "  ", remaining: 1 })).status).toBe(400);
  expect((await admin.setJudgeFaultInjectionAdmin({ enabled: true, body: MALFORMED, remaining: 0 })).status).toBe(400);
  expect((await getJudgeFaultInjection()).enabled).toBe(false);
  // The control: the same call with both present is accepted.
  expect((await admin.setJudgeFaultInjectionAdmin({ enabled: true, body: MALFORMED, remaining: 1 })).ok).toBe(true);
});

test("consuming the lever disarms it at zero", async () => {
  process.env[FAULT_INJECTION_FLAG_ENV] = "1";
  await admin.setJudgeFaultInjectionAdmin({ enabled: true, body: MALFORMED, remaining: 2 });
  await consumeJudgeFaultInjection();
  expect(await getJudgeFaultInjection()).toMatchObject({ enabled: true, remaining: 1 });
  await consumeJudgeFaultInjection();
  const spent = await getJudgeFaultInjection();
  expect(spent).toMatchObject({ enabled: false, remaining: 0, body: "" });
  // A spent lever cannot go negative.
  await consumeJudgeFaultInjection();
  expect((await getJudgeFaultInjection()).remaining).toBe(0);
});
