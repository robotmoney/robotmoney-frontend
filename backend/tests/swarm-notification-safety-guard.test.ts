// Boot-time notification-safety guard (issue #894, sharpened from the
// ultracode audit's rm-env-prod-swarm-notification-leak finding).
//
// backend/src/config.ts's RM_ENV has no "staging" value — VALID_ENVS is
// exactly ["ephemeral","smoke","prod"] and defaults to "prod" when unset — so
// a stack-deployed staging environment must set RM_ENV=prod too, which means
// RM_ENV can never distinguish it from real production. The only thing that
// actually varies per deployment is SWARM_PUBLIC_BASE_URL, and it defaults to
// the literal production origin (SWARM_PUBLIC_BASE_URL_DEFAULT) when unset.
// Combined with SWARM_SCHEDULES_ENABLED being the documented flag staging
// flips on to exercise the real notification path, an operator who enables
// the schedules without setting SWARM_PUBLIC_BASE_URL would have this process
// silently start emailing real applicants a link back to production, for a
// member id that does not exist there.
//
// assertSwarmNotificationSafety() closes that gap the only way it can be
// closed at this layer: refuse to boot rather than let the ambiguity reach a
// live email. It is pure and call-time (no DB, no module-load state), so
// these tests exercise it directly rather than through a process boot.
import { expect, test } from "bun:test";
import { assertSwarmNotificationSafety } from "../src/config.ts";

test("throws when SWARM_SCHEDULES_ENABLED is on and SWARM_PUBLIC_BASE_URL is unset", () => {
  expect(() => assertSwarmNotificationSafety({ SWARM_SCHEDULES_ENABLED: "true" })).toThrow(
    /SWARM_PUBLIC_BASE_URL/,
  );
});

test("does not throw once SWARM_PUBLIC_BASE_URL is set explicitly", () => {
  expect(() =>
    assertSwarmNotificationSafety({
      SWARM_SCHEDULES_ENABLED: "true",
      SWARM_PUBLIC_BASE_URL: "https://staging.robotmoney.network",
    }),
  ).not.toThrow();
});

test("does not throw when schedules are disabled, regardless of SWARM_PUBLIC_BASE_URL", () => {
  expect(() => assertSwarmNotificationSafety({})).not.toThrow();
  expect(() =>
    assertSwarmNotificationSafety({ SWARM_PUBLIC_BASE_URL: "" }),
  ).not.toThrow();
  expect(() =>
    assertSwarmNotificationSafety({ SWARM_SCHEDULES_ENABLED: "0" }),
  ).not.toThrow();
  expect(() =>
    assertSwarmNotificationSafety({ SWARM_SCHEDULES_ENABLED: "false" }),
  ).not.toThrow();
});

test("recognizes both truthy spellings resolveSwarmSchedules accepts (\"1\" and \"true\")", () => {
  expect(() => assertSwarmNotificationSafety({ SWARM_SCHEDULES_ENABLED: "1" })).toThrow();
  expect(() => assertSwarmNotificationSafety({ SWARM_SCHEDULES_ENABLED: "true" })).toThrow();
});

test("an empty-string SWARM_PUBLIC_BASE_URL counts as unset, not as explicitly configured", () => {
  // Guards against a `${SWARM_PUBLIC_BASE_URL:-}` compose passthrough (an
  // unset host var resolving to "") being mistaken for an operator's
  // deliberate choice.
  expect(() =>
    assertSwarmNotificationSafety({ SWARM_SCHEDULES_ENABLED: "1", SWARM_PUBLIC_BASE_URL: "" }),
  ).toThrow(/SWARM_PUBLIC_BASE_URL/);
});

test("whitespace-only SWARM_PUBLIC_BASE_URL also counts as unset", () => {
  expect(() =>
    assertSwarmNotificationSafety({ SWARM_SCHEDULES_ENABLED: "1", SWARM_PUBLIC_BASE_URL: "   " }),
  ).toThrow(/SWARM_PUBLIC_BASE_URL/);
});

test("the thrown message names the production default so an operator knows what almost shipped", () => {
  expect(() => assertSwarmNotificationSafety({ SWARM_SCHEDULES_ENABLED: "1" })).toThrow(
    /robotmoney\.network/,
  );
});

test("defaults to process.env when called with no argument (the real boot call site)", () => {
  const prevEnabled = process.env.SWARM_SCHEDULES_ENABLED;
  const prevUrl = process.env.SWARM_PUBLIC_BASE_URL;
  try {
    process.env.SWARM_SCHEDULES_ENABLED = "1";
    delete process.env.SWARM_PUBLIC_BASE_URL;
    expect(() => assertSwarmNotificationSafety()).toThrow(/SWARM_PUBLIC_BASE_URL/);

    process.env.SWARM_PUBLIC_BASE_URL = "https://staging.robotmoney.network";
    expect(() => assertSwarmNotificationSafety()).not.toThrow();
  } finally {
    if (prevEnabled === undefined) delete process.env.SWARM_SCHEDULES_ENABLED;
    else process.env.SWARM_SCHEDULES_ENABLED = prevEnabled;
    if (prevUrl === undefined) delete process.env.SWARM_PUBLIC_BASE_URL;
    else process.env.SWARM_PUBLIC_BASE_URL = prevUrl;
  }
});
