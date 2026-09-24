// THE TEST-ONLY JUDGE FAULT-INJECTION LEVER (R13): its gates.
//
// WHAT THIS FILE PROTECTS, and how it could be broken quietly:
//
//   THE LEVER IS REFUSED BY DEFAULT. Broken by a gate that reads "allowed"
//   when an env var is merely absent — so the DEFAULT environment (no flag,
//   and, under D13, an UNSET RM_ENV, which is acceptance/strict) is asserted
//   to refuse, in both the classify and the throw form.
//
// WHAT IT NO LONGER PROTECTS, AND WHY (issue #1026, D53 point 4). The lever's
// other promises — an armed lever refuses rather than producing an opinion,
// leaves the weights untouched, and cannot rescue an unconfigured judge — were
// promises about the backend `judge()`, the one place that consumed it. That
// judge is deleted: the judge is a participant, and nothing in the API forms
// an opinion for a lever to fault. Those tests went with the code they tested.
// The spend fields (R19) they also covered were filled by the deleted model
// transport; the participant runner does not report spend yet.
//
// NO DATABASE AND NO NETWORK. Every gate here is a pure function of an env
// record and a row shape.
import { expect, test } from "bun:test";
import {
  assertFaultInjectionAllowed,
  FAULT_INJECTION_ACCEPTANCE_ENV,
  FAULT_INJECTION_FLAG_ENV,
  faultInjectionGate,
  JudgeFaultInjectionRefused,
  selectFaultInjection,
  type JudgeFaultInjectionState,
} from "../src/swarm/judge-fault-injection.ts";

const SESSION = "11111111-2222-3333-4444-555555555555";
const OTHER_SESSION = "99999999-8888-7777-6666-555555555555";

const armed = (over: Partial<JudgeFaultInjectionState> = {}): JudgeFaultInjectionState => ({
  enabled: true,
  body: "this is not json",
  remaining: 1,
  sessionId: null,
  note: "AC-E2E-06 rehearsal",
  updatedBy: "admin",
  updatedAt: "2026-09-14T00:00:00.000Z",
  ...over,
});

const OPEN_ENV = { [FAULT_INJECTION_FLAG_ENV]: "1", RM_ENV: "ephemeral" };

// ── 1. Refused by default ──────────────────────────────────────────────────

test("the lever is refused when the process carries no flag", () => {
  expect(faultInjectionGate({})).toBe("flag_absent");
  expect(faultInjectionGate({ RM_ENV: "ephemeral" })).toBe("flag_absent");
  // Even a fully armed row is inert: a flagless process honours nothing.
  expect(selectFaultInjection(armed(), SESSION, {})).toBeNull();
});

test("an UNSET RM_ENV is an acceptance path (D13), so the flag alone is refused", () => {
  expect(faultInjectionGate({ [FAULT_INJECTION_FLAG_ENV]: "1" })).toBe("acceptance_path");
  expect(faultInjectionGate({ [FAULT_INJECTION_FLAG_ENV]: "1", RM_ENV: "prod" })).toBe("acceptance_path");
  expect(selectFaultInjection(armed(), SESSION, { [FAULT_INJECTION_FLAG_ENV]: "1" })).toBeNull();
});

test("the acceptance path opens only with the SECOND explicit opt-in", () => {
  const env = { [FAULT_INJECTION_FLAG_ENV]: "1", RM_ENV: "prod", [FAULT_INJECTION_ACCEPTANCE_ENV]: "1" };
  expect(faultInjectionGate(env)).toBe("allowed");
  expect(selectFaultInjection(armed(), SESSION, env)).not.toBeNull();
  // …and the opt-in ALONE, without the flag, is not a way in.
  expect(faultInjectionGate({ RM_ENV: "prod", [FAULT_INJECTION_ACCEPTANCE_ENV]: "1" })).toBe("flag_absent");
});

test("a development environment needs only the flag", () => {
  expect(faultInjectionGate(OPEN_ENV)).toBe("allowed");
  expect(faultInjectionGate({ [FAULT_INJECTION_FLAG_ENV]: "1", RM_ENV: "smoke" })).toBe("allowed");
});

test("assertFaultInjectionAllowed throws a refusal naming the gate that is shut", () => {
  expect(() => assertFaultInjectionAllowed({})).toThrow(JudgeFaultInjectionRefused);
  try {
    assertFaultInjectionAllowed({ [FAULT_INJECTION_FLAG_ENV]: "1" });
    throw new Error("acceptance path did not refuse");
  } catch (e) {
    expect(e).toBeInstanceOf(JudgeFaultInjectionRefused);
    expect((e as JudgeFaultInjectionRefused).gate).toBe("acceptance_path");
    expect((e as Error).message).toContain(FAULT_INJECTION_ACCEPTANCE_ENV);
  }
  // The control: the same call with the gate OPEN must NOT throw, or every
  // assertion above would pass for the wrong reason.
  expect(() => assertFaultInjectionAllowed(OPEN_ENV)).not.toThrow();
});

test("selectFaultInjection refuses an off, spent, empty or other-session lever", () => {
  expect(selectFaultInjection(armed({ enabled: false }), SESSION, OPEN_ENV)).toBeNull();
  expect(selectFaultInjection(armed({ remaining: 0 }), SESSION, OPEN_ENV)).toBeNull();
  expect(selectFaultInjection(armed({ body: "   " }), SESSION, OPEN_ENV)).toBeNull();
  expect(selectFaultInjection(armed({ sessionId: OTHER_SESSION }), SESSION, OPEN_ENV)).toBeNull();
  expect(selectFaultInjection(null, SESSION, OPEN_ENV)).toBeNull();
  // The controls: the same row, named at ITS session and armed, does apply.
  expect(selectFaultInjection(armed({ sessionId: SESSION }), SESSION, OPEN_ENV)?.body).toBe("this is not json");
  expect(selectFaultInjection(armed(), SESSION, OPEN_ENV)?.body).toBe("this is not json");
});
