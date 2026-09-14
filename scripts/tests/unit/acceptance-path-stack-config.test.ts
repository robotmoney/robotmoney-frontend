// RM_ENV IS A PROPERTY OF THE STACK CONFIG, NOT OF THE OPERATOR'S SHELL (D13).
//
// On 2026-09-13 rm-frontend-stage-1 was found running `RM_ENV=smoke`: every
// AC-MODEL-01 refusal in the api and the worker was disabled, the judge accepted
// any model id for `mode:enforce`, and the postflight downgraded the same
// condition from FAIL to WARN. Nothing in the repository set the value — both
// containers took docker-compose.yml's `${RM_ENV:-smoke}` interpolation default,
// and the only thing that had ever set `prod` was a string typed on a command
// line (`rc2-boot.sh:48`).
//
// Two changes make that unreachable, and this file pins both:
//   1. buildComposeEnv() EMITS RM_ENV for every service, from a first-class
//      StackConfig field, and refuses to let it arrive through the extras map;
//   2. the omitted case is the STRICT one (`prod`), matching the shared
//      predicate in backend/src/acceptance-path.ts and backend/src/config.ts's
//      "fail-closed: default to prod when RM_ENV is unset".
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildComposeEnv, DEFAULT_STACK_DATABASE, type StackConfig } from "../../stack/config.ts";
import { parseRmEnv, resolveStackRmEnv } from "../../../backend/src/acceptance-path.ts";
import { resolveAcceptanceFlag } from "../../../backend/scripts/upgrades/0.4.0-to-0.5.0/postflight.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

function cfg(overrides: Partial<StackConfig> = {}): StackConfig {
  return {
    repoRoot: "/repo",
    project: "rm_test",
    profile: "core",
    composeFiles: ["docker-compose.yml"],
    database: DEFAULT_STACK_DATABASE,
    credentials: { adminToken: "a", automationToken: "b", analyticsToken: "c" },
    environment: { class: "local", hash: "deadbeef" },
    ...overrides,
  };
}

describe("buildComposeEnv emits RM_ENV", () => {
  test("every stack states its RM_ENV explicitly", () => {
    expect(buildComposeEnv(cfg({ rmEnv: "smoke" })).RM_ENV).toBe("smoke");
    expect(buildComposeEnv(cfg({ rmEnv: "prod" })).RM_ENV).toBe("prod");
    expect(buildComposeEnv(cfg({ rmEnv: "ephemeral" })).RM_ENV).toBe("ephemeral");
  });

  test("a config that FORGOT to state it gets the strict value, not the permissive one", () => {
    // The whole defect in one assertion: the old default was `smoke`.
    expect(buildComposeEnv(cfg()).RM_ENV).toBe("prod");
  });

  test("RM_ENV cannot arrive through extraComposeEnv — one place decides", () => {
    expect(() => buildComposeEnv(cfg({ rmEnv: "prod", extraComposeEnv: { RM_ENV: "smoke" } })))
      .toThrow(/must not be passed through extraComposeEnv/);
  });

  test("the compose interpolation default is the strict one too — the backstop", () => {
    // If a bring-up path ever fails to emit the value, the container must fail
    // closed rather than quietly become a development environment.
    const compose = readFileSync(join(REPO_ROOT, "docker-compose.yml"), "utf8");
    const defaults = [...compose.matchAll(/RM_ENV:\s*\$\{RM_ENV:-(\w+)\}/g)].map((m) => m[1]);
    expect(defaults.length, "the api and worker-swarm services both interpolate RM_ENV").toBe(2);
    expect(defaults).toEqual(["prod", "prod"]);
  });
});

describe("resolveStackRmEnv — the boot decides, and a contradiction is refused", () => {
  test("a --static-port boot IS staging and declares prod", () => {
    expect(resolveStackRmEnv({ standingStack: true, declared: undefined })).toBe("prod");
    expect(resolveStackRmEnv({ standingStack: true, declared: "prod" })).toBe("prod");
    expect(resolveStackRmEnv({ standingStack: true, declared: "" })).toBe("prod");
  });

  test("--static-port is REFUSED on a development RM_ENV, not silently overridden", () => {
    // stagePreflight() turns this into a FATAL and exit(1), the same convention
    // the held-stage-port refusal uses. The operator believes something false
    // about the deployment a tunnel points at, and must be told.
    for (const declared of ["smoke", "ephemeral"]) {
      expect(() => resolveStackRmEnv({ standingStack: true, declared }), declared)
        .toThrow(/--static-port is the STANDING stack/);
    }
  });

  test("a non-standing boot is the operator's own development stack", () => {
    expect(resolveStackRmEnv({ standingStack: false, declared: undefined })).toBe("smoke");
    expect(resolveStackRmEnv({ standingStack: false, declared: "ephemeral" })).toBe("ephemeral");
    expect(resolveStackRmEnv({ standingStack: false, declared: "prod" })).toBe("prod");
  });

  test("a value the backend would refuse to start on is refused HERE, before anything is created", () => {
    expect(() => resolveStackRmEnv({ standingStack: false, declared: "staging" })).toThrow(/invalid RM_ENV/);
    expect(() => resolveStackRmEnv({ standingStack: true, declared: "Prod" })).toThrow(/invalid RM_ENV/);
    expect(parseRmEnv("staging")).toBeNull();
    expect(parseRmEnv(" prod ")).toBe("prod");
  });

  test("smoke-main resolves it from the boot and never passes it through", () => {
    const main = readFileSync(join(REPO_ROOT, "scripts", "lib", "smoke-main.ts"), "utf8");
    expect(main).toContain("resolveStackRmEnvOrExit(staticPortMode)");
    expect(main).toContain("rmEnv: stackRmEnv");
    // The passthrough list is what made it an exported shell value.
    const passthrough = readFileSync(join(REPO_ROOT, "scripts", "lib", "smoke-compose-env.ts"), "utf8");
    const list = /DEMO_COMPOSE_PASSTHROUGH = \[([\s\S]*?)\] as const;/.exec(passthrough);
    expect(list, "DEMO_COMPOSE_PASSTHROUGH is still declared").not.toBeNull();
    expect(list![1]).not.toMatch(/^\s*"RM_ENV",/m);
  });
});

describe("postflight check 11 is TOLD which path it is on", () => {
  test("--acceptance / --no-acceptance state it outright", () => {
    expect(resolveAcceptanceFlag(["--acceptance"], { RM_ENV: "smoke" })).toBe(true);
    expect(resolveAcceptanceFlag(["--no-acceptance"], { RM_ENV: "prod" })).toBe(false);
  });

  test("with neither flag it falls back to the shared FAIL-CLOSED predicate", () => {
    // Not to "RM_ENV is not prod, so WARN" — an operator running this from a
    // plain login shell must not downgrade a stage database's check.
    expect(resolveAcceptanceFlag([], {})).toBe(true);
    expect(resolveAcceptanceFlag([], { RM_ENV: "prod" })).toBe(true);
    expect(resolveAcceptanceFlag([], { RM_ENV: "smoke" })).toBe(false);
  });

  test("both flags at once is a mistake, not a precedence puzzle", () => {
    expect(() => resolveAcceptanceFlag(["--acceptance", "--no-acceptance"], {})).toThrow(/mutually exclusive/);
  });
});
