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
import { missingProdSettingNotes, refuseProdWithoutProjectsSource, smokePassthroughEnv } from "../../lib/smoke-compose-env.ts";

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

describe("a prod boot without PROJECTS_SOURCE=live refuses", () => {
  test("unset refuses and names the fix", () => {
    const msg = refuseProdWithoutProjectsSource("prod", {});
    expect(msg).toContain("PROJECTS_SOURCE=live");
    expect(msg).toContain("export PROJECTS_SOURCE=live");
  });

  test("empty and any other value refuse", () => {
    expect(refuseProdWithoutProjectsSource("prod", { PROJECTS_SOURCE: "" })).not.toBeNull();
    expect(refuseProdWithoutProjectsSource("prod", { PROJECTS_SOURCE: "fixture" })).toContain("`fixture`");
  });

  test("live passes", () => {
    expect(refuseProdWithoutProjectsSource("prod", { PROJECTS_SOURCE: "live" })).toBeNull();
  });

  test("a boot whose containers are not prod is never refused", () => {
    expect(refuseProdWithoutProjectsSource("stage", {})).toBeNull();
  });

  test("smoke-main.ts calls the refusal before the stack is configured", () => {
    const src = readFileSync(join(import.meta.dir, "..", "..", "lib", "smoke-main.ts"), "utf8");
    const call = src.indexOf("refuseProdWithoutProjectsSource(stackRmEnv, process.env)");
    expect(call).toBeGreaterThan(0);
    expect(call).toBeLessThan(src.indexOf("function makeStackConfig"));
  });
});

describe("notes for unset prod settings", () => {
  test("names the unset ones on prod only", () => {
    expect(missingProdSettingNotes("prod", { BASE_RPC_URL: "u" }).join("\n")).toContain("WEBAUTHN_ORIGIN");
    expect(missingProdSettingNotes("prod", { BASE_RPC_URL: "u", WEBAUTHN_ORIGIN: "o" })).toEqual([]);
    expect(missingProdSettingNotes("stage", {})).toEqual([]);
  });
});
