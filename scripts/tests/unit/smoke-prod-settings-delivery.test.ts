// SETTINGS PRODUCTION GOT FROM THE CHECKOUT `.env` (issue #1113).
//
// v0.5.x booted with `bun run smoke:archive`, so Bun loaded the checkout `.env`.
// The boot now runs `--no-env-file`: the shell is the one delivery path for
// non-secret settings. This file pins (a) which settings are on that path and
// (b) the refusal of a prod boot that forgot PROJECTS_SOURCE=live, which
// otherwise starts cleanly and then throws in every projects job.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEMO_COMPOSE_PASSTHROUGH } from "../../lib/smoke-compose-passthrough.ts";
import { isAcceptanceBoot, missingProdSettingNotes, refuseProdWithoutProjectsSource, smokePassthroughEnv } from "../../lib/smoke-compose-env.ts";

const CHECKOUT_ENV_KEYS = [
  "PROJECTS_SOURCE",
  "BASE_RPC_URL",
  "WEBAUTHN_ORIGIN",
  "WEBAUTHN_RP_ID",
  "BASE_RPC_MAX_CALLS_PER_SEC",
  "BASE_RPC_RATE_BURST",
  "WALLET_BACKFILL_MAX_DAYS_PER_RUN",
  "WALLET_BACKFILL_MAX_ATTEMPTS_PER_DAY",
  "GECKO_OHLCV_MIN_INTERVAL_MS",
  "PG_NAMESPACE_GUARD_TIMEOUT_MS",
] as const;

describe("checkout-.env settings have a delivery path", () => {
  test.each([...CHECKOUT_ENV_KEYS])("%s is forwarded from the shell", (key) => {
    expect(smokePassthroughEnv({ [key]: "x" })).toEqual({ [key]: "x" });
  });

  test("every forwarded key is interpolated in docker-compose.yml", () => {
    const compose = readFileSync(join(import.meta.dir, "..", "..", "..", "docker-compose.yml"), "utf8");
    for (const key of DEMO_COMPOSE_PASSTHROUGH) expect(compose).toContain("${" + key + ":-");
  });

  test("the handle-namespace weakening flag is not forwarded", () => {
    expect(DEMO_COMPOSE_PASSTHROUGH as readonly string[]).not.toContain("RM_ALLOW_HANDLE_NAMESPACE_VIOLATION");
  });
});

describe("an acceptance boot (prod policy or the standing stack) without PROJECTS_SOURCE=live refuses", () => {
  test("unset refuses and names the fix", () => {
    const msg = refuseProdWithoutProjectsSource(true, {});
    expect(msg).toContain("PROJECTS_SOURCE=live");
    expect(msg).toContain("export PROJECTS_SOURCE=live");
  });

  test("empty and any other value refuse", () => {
    expect(refuseProdWithoutProjectsSource(true, { PROJECTS_SOURCE: "" })).not.toBeNull();
    expect(refuseProdWithoutProjectsSource(true, { PROJECTS_SOURCE: "fixture" })).toContain("`fixture`");
  });

  test("live passes", () => {
    expect(refuseProdWithoutProjectsSource(true, { PROJECTS_SOURCE: "live" })).toBeNull();
  });

  test("an operator's own stage boot is never refused", () => {
    expect(refuseProdWithoutProjectsSource(false, {})).toBeNull();
  });

  test("the acceptance boot is the prod policy or the standing stack, under either policy", () => {
    expect(isAcceptanceBoot(false, "prod")).toBe(true);
    expect(isAcceptanceBoot(true, "prod")).toBe(true);
    expect(isAcceptanceBoot(true, "stage")).toBe(true);
    expect(isAcceptanceBoot(false, "stage")).toBe(false);
  });

  test("smoke-main.ts calls the refusal before the stack is configured", () => {
    const src = readFileSync(join(import.meta.dir, "..", "..", "lib", "smoke-main.ts"), "utf8");
    const call = src.indexOf("refuseProdWithoutProjectsSource(acceptanceBoot, process.env)");
    expect(call).toBeGreaterThan(0);
    expect(call).toBeLessThan(src.indexOf("function makeStackConfig"));
  });
});

describe("notes for unset prod settings", () => {
  test("names the unset ones on prod only", () => {
    expect(missingProdSettingNotes(true, { BASE_RPC_URL: "u" }).join("\n")).toContain("WEBAUTHN_ORIGIN");
    expect(missingProdSettingNotes(true, { BASE_RPC_URL: "u", WEBAUTHN_ORIGIN: "o" })).toEqual([]);
    expect(missingProdSettingNotes(false, {})).toEqual([]);
  });
});
