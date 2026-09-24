// The operator-environment allowlist a smoke boot forwards into compose
// (scripts/lib/smoke-compose-env.ts), and the one name deliberately NOT on it.
//
// Written after a stage `bun smoke:twin` booted with three permanently
// unhealthy worker lanes: the stage checkout's `.env` carries the persistent
// deployment's WORKER_DATABASE_URL (`…@postgres:5432/robotmoney`), bun loads
// `.env` into the driver's process.env, the allowlist forwarded it, and a twin
// boot has no `postgres` service for the lanes to resolve — so every lane's
// first query died with `getaddrinfo ESERVFAIL` and every enqueued
// swarm.open_session sat `pending` at attempts=0.
import { describe, expect, test } from "bun:test";
import { shadowingStackEnvWarnings, smokePassthroughEnv } from "../../lib/smoke-compose-env.ts";

describe("smokePassthroughEnv", () => {
  test("forwards a documented operator knob", () => {
    expect(smokePassthroughEnv({ SWARM_WINDOW_MINUTES: "5" })).toEqual({ SWARM_WINDOW_MINUTES: "5" });
  });

  test("an empty value counts as unset", () => {
    expect(smokePassthroughEnv({ SWARM_WINDOW_MINUTES: "" })).toEqual({});
  });

  test("never forwards a stack-owned database URL", () => {
    // The exact value that broke the 2026-09-18 stage twin boot.
    const env = { WORKER_DATABASE_URL: "postgres://rm_worker:pw@postgres:5432/robotmoney" };
    expect(smokePassthroughEnv(env)).toEqual({});
  });

  test("still forwards MIGRATE_DATABASE_URL, which the rehearsal sets on itself", () => {
    // restore-container.ts assigns process.env.MIGRATE_DATABASE_URL from the
    // shaped twin; the passthrough is how it reaches compose. Unlike
    // WORKER_DATABASE_URL it is produced by this boot, not inherited from a
    // deployment's `.env`.
    const url = "postgres://rm_bootstrap:pw@172.17.0.1:32817/rm_restore_check";
    expect(smokePassthroughEnv({ MIGRATE_DATABASE_URL: url })).toEqual({ MIGRATE_DATABASE_URL: url });
  });

  test("ignores a name that is not on the allowlist", () => {
    expect(smokePassthroughEnv({ OPENCODE_API_KEY: "sk-live", DATABASE_URL: "postgres://x/y" })).toEqual({});
  });
});

describe("shadowingStackEnvWarnings", () => {
  test("reports a WORKER_DATABASE_URL left in the environment", () => {
    const out = shadowingStackEnvWarnings({ WORKER_DATABASE_URL: "postgres://rm_worker:pw@postgres:5432/robotmoney" });
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("WORKER_DATABASE_URL");
    expect(out[0]).toContain("IGNORED");
  });

  test("never prints the credential it is warning about", () => {
    const out = shadowingStackEnvWarnings({ WORKER_DATABASE_URL: "postgres://rm_worker:s3cret@postgres:5432/robotmoney" });
    expect(out[0]).not.toContain("s3cret");
  });

  test("silent when unset or empty", () => {
    expect(shadowingStackEnvWarnings({})).toEqual([]);
    expect(shadowingStackEnvWarnings({ WORKER_DATABASE_URL: "  " })).toEqual([]);
  });
});

describe("an --db external boot (the deployment's own database)", () => {
  // Production's worker lanes get their rm_worker URL through this path and no
  // other; dropping it everywhere (the archived ffa431b6) stops every lane.
  const url = "postgres://rm_worker:pw@db.example:25060/robotmoney";

  test("forwards WORKER_DATABASE_URL", () => {
    expect(smokePassthroughEnv({ WORKER_DATABASE_URL: url }, { external: true })).toEqual({ WORKER_DATABASE_URL: url });
  });

  test("does not warn that it is ignored, because it is not", () => {
    expect(shadowingStackEnvWarnings({ WORKER_DATABASE_URL: url }, { external: true })).toEqual([]);
  });

  test("still forwards nothing off the allowlist", () => {
    expect(smokePassthroughEnv({ DATABASE_URL: "postgres://x/y" }, { external: true })).toEqual({});
  });
});
