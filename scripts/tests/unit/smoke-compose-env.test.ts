// The operator-environment allowlist a smoke boot forwards into compose
// (scripts/lib/smoke-compose-env.ts), and the one name deliberately NOT on it.
//
// Written after a stage `bun smoke:twin` booted with three permanently
// unhealthy worker lanes: the stage checkout's `.env` carries the persistent
// deployment's WORKER_DATABASE_URL (`…@postgres:5432/robotmoney`), bun loads
// `.env` into the driver's process.env, the allowlist forwarded it, and a twin
// boot has no `postgres` service for the lanes to resolve — so every lane's
// first query died with `getaddrinfo ESERVFAIL` and every enqueued
// lifecycle job sat `pending` at attempts=0.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { shadowingStackEnvWarnings, smokePassthroughEnv } from "../../lib/smoke-compose-env.ts";
import { buildSmokeLifecycleComposeEnv } from "../../lib/smoke-lifecycle-env.ts";
import { refuseCheckoutEnvFile } from "../../smoke.ts";

describe("smokePassthroughEnv", () => {
  test("forwards a documented operator knob", () => {
    expect(smokePassthroughEnv({ PROJECTS_SOURCE: "live" })).toEqual({ PROJECTS_SOURCE: "live" });
  });

  test("an empty value counts as unset", () => {
    expect(smokePassthroughEnv({ PROJECTS_SOURCE: "" })).toEqual({});
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

// ── No boot reads an env file from the checkout (criterion 122) ──────────────
//
// Two readers used to fill a boot from the checkout's `.env` with nobody
// asking: bun, which auto-loads `<cwd>/.env` into the driver's process.env,
// and compose, which loads `<project dir>/.env` for interpolation whatever
// environment it is handed. The first is closed by `--no-env-file` (and the
// entrypoint refuses to run without it); the second by `--env-file /dev/null`
// on EVERY compose call. The sweep below reads every place this repo spells a
// compose invocation, so a new bare call goes red the day it is written.
const repoRoot = join(import.meta.dir, "..", "..", "..");

/** Non-test TypeScript sources that may spawn compose. */
function sourceFiles(): string[] {
  const out: string[] = [];
  for (const root of ["scripts", "backend/scripts", "backend/src"]) {
    for (const e of readdirSync(join(repoRoot, root), { recursive: true, withFileTypes: true })) {
      if (!e.isFile() || !e.name.endsWith(".ts")) continue;
      const rel = relative(repoRoot, join(e.parentPath ?? (e as unknown as { path: string }).path, e.name));
      if (rel.startsWith("scripts/tests/") || rel.includes("node_modules")) continue;
      out.push(rel);
    }
  }
  return out;
}

/**
 * Every compose argv in a TypeScript source that does not open with
 * `--env-file /dev/null`: an array literal whose `"compose"` element is not
 * immediately followed by those two elements.
 */
function bareComposeCallsTs(src: string): string[] {
  const code = src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  return [...code.matchAll(/["']compose["']\s*,(?!\s*["']--env-file["']\s*,\s*["']\/dev\/null["'])[^\n]{0,60}/g)].map((m) => m[0]);
}

/** Every `docker compose` command line in a shell script or workflow that lacks `--env-file /dev/null`. */
function bareComposeCallsShell(src: string): string[] {
  // Join backslash continuations so a multi-line command is judged whole.
  const logical = src.replace(/\\\n\s*/g, " ").split("\n");
  return logical
    .map((l) => l.trim())
    .filter((l) => !l.startsWith("#") && !l.startsWith("echo") && /(^|[\s;&|(])docker compose\s/.test(l))
    .filter((l) => !/--env-file \/dev\/null/.test(l));
}

describe("every compose invocation passes --env-file /dev/null (criterion 122)", () => {
  const files = sourceFiles();

  test("the sweep is not vacuous: it reads the files that spawn compose", () => {
    for (const f of ["scripts/lib/smoke-main.ts", "scripts/smoke-down.ts", "scripts/smoke-status.ts", "scripts/lib/smoke-readiness-polling.ts", "scripts/lib/smoke-telemetry.ts", "scripts/stack/config.ts"]) {
      expect(files).toContain(f);
    }
    const composeMentions = files.filter((f) => /["']compose["']\s*,/.test(readFileSync(join(repoRoot, f), "utf8")));
    expect(composeMentions.length).toBeGreaterThanOrEqual(6);
  });

  test("no TypeScript source spawns compose without --env-file /dev/null", () => {
    const offenders = files.flatMap((f) => bareComposeCallsTs(readFileSync(join(repoRoot, f), "utf8")).map((c) => `${f}: ${c}`));
    expect(offenders).toEqual([]);
  });

  test("no workflow or shell script runs docker compose without --env-file /dev/null", () => {
    const shellFiles = [
      ...readdirSync(join(repoRoot, ".github", "workflows")).filter((f) => f.endsWith(".yml")).map((f) => join(".github", "workflows", f)),
      ...readdirSync(join(repoRoot, "scripts")).filter((f) => f.endsWith(".sh")).map((f) => join("scripts", f)),
    ];
    const offenders = shellFiles.flatMap((f) => bareComposeCallsShell(readFileSync(join(repoRoot, f), "utf8")).map((c) => `${f}: ${c}`));
    expect(offenders).toEqual([]);
  });

  test("red control: the retired bare calls are caught, the fixed ones are not", () => {
    expect(bareComposeCallsTs('Bun.spawnSync(["docker", "compose", "down"], {')).toHaveLength(1);
    expect(bareComposeCallsTs('capture(["compose", "ps", "-aq"])')).toHaveLength(1);
    expect(bareComposeCallsTs('Bun.spawnSync(["docker", "compose", "--env-file", "/dev/null", "down"])')).toEqual([]);
    expect(bareComposeCallsTs('// ["docker", "compose", "down"] in a comment')).toEqual([]);
    expect(bareComposeCallsShell('  docker compose -p "$P" \\\n    -f docker-compose.yml \\\n    down -v\n')).toHaveLength(1);
    expect(bareComposeCallsShell('  docker compose -p "$P" \\\n    --env-file /dev/null \\\n    down -v\n')).toEqual([]);
    expect(bareComposeCallsShell('  echo "::group::docker compose -p x down"\n')).toEqual([]);
  });
});

describe("the driver never spreads the host environment into compose (criterion 122)", () => {
  test("smoke-main.ts's direct-compose env is the stack's spawn env, not process.env", () => {
    const src = readFileSync(join(repoRoot, "scripts", "lib", "smoke-main.ts"), "utf8");
    const block = src.slice(src.indexOf("const dockerEnv"), src.indexOf("};", src.indexOf("const dockerEnv")));
    expect(block).toContain("buildSpawnEnv(smokeStackConfig, process.env)");
    expect(block).not.toContain("...process.env");
  });

  test("smoke:down / smoke:status rebuild compose env from the state file plus docker plumbing only", () => {
    const state = {
      project: "rm_smoke_stack_state",
      composeFiles: "docker-compose.yml:docker-compose.smoke.yml",
      databaseUrl: "postgres://robotmoney:robotmoney@postgres:5432/robotmoney",
      dbUser: "robotmoney",
      dbPassword: "robotmoney",
      dbName: "robotmoney",
    };
    const planted = {
      PATH: "/usr/bin",
      DOCKER_HOST: "unix:///run/user/1000/docker.sock",
      DATABASE_URL: "postgres://rm_app:planted@prod.example:25060/defaultdb",
      SMOKE_PROJECT: "planted-project",
      ADMIN_TOKEN: "planted-admin",
      OPENCODE_API_KEY: "planted-key",
    };
    const env = buildSmokeLifecycleComposeEnv(state, planted);
    expect(env.PATH).toBe("/usr/bin");
    expect(env.DOCKER_HOST).toBe(planted.DOCKER_HOST);
    expect(env.DATABASE_URL).toBe(state.databaseUrl);
    expect(env.SMOKE_PROJECT).toBe(state.project);
    expect(env).not.toHaveProperty("ADMIN_TOKEN");
    expect(env).not.toHaveProperty("OPENCODE_API_KEY");
    expect(Object.values(env).some((v) => v.includes("planted"))).toBe(false);
  });
});

describe("bun never fills the boot from the checkout's .env (criterion 122)", () => {
  // A planted checkout: a directory holding a `.env` that names a production
  // database and a retired project name, with the real entrypoint run from it.
  const planted = mkdtempSync(join(tmpdir(), "rm-planted-dotenv-"));
  writeFileSync(join(planted, ".env"), "DATABASE_URL=postgres://rm_app:planted@prod.example:25060/defaultdb\nSMOKE_PROJECT=planted-project\n");
  const entry = join(repoRoot, "scripts", "smoke.ts");
  const run = (bunFlags: string[], args: string[]) => {
    const r = Bun.spawnSync(["bun", ...bunFlags, entry, ...args], {
      cwd: planted,
      env: { PATH: process.env.PATH ?? "", HOME: planted },
      stdout: "pipe",
      stderr: "pipe",
    });
    return { code: r.exitCode, out: `${r.stdout.toString()}${r.stderr.toString()}` };
  };

  test("the entrypoint refuses to run when bun was allowed to load the .env", () => {
    const r = run([], ["--local", "blank"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("auto-loaded this checkout's .env");
  });

  test("with --no-env-file the planted values never arrive: SMOKE_PROJECT from the file is not seen", () => {
    // `--no-such-flag` makes the boot stop at argument validation, on an
    // untouched host. Had the file been loaded, the retired-SMOKE_PROJECT
    // refusal would have fired first; it does not.
    const r = run(["--no-env-file"], ["--local", "blank", "--no-such-flag"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('unknown flag "--no-such-flag"');
    expect(r.out).not.toContain("SMOKE_PROJECT is retired");
    expect(r.out).not.toContain("planted");
  });

  test("red control: the same SMOKE_PROJECT in the real environment IS refused", () => {
    const r = Bun.spawnSync(["bun", "--no-env-file", entry, "--local", "blank"], {
      cwd: planted,
      env: { PATH: process.env.PATH ?? "", HOME: planted, SMOKE_PROJECT: "planted-project" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(r.exitCode).toBe(1);
    expect(`${r.stdout}${r.stderr}`).toContain("SMOKE_PROJECT is retired with no alias");
  });

  test("refuseCheckoutEnvFile is the whole decision: only --no-env-file passes", () => {
    expect(refuseCheckoutEnvFile(["--no-env-file"])).toBeNull();
    expect(refuseCheckoutEnvFile([])).toContain(".env");
    expect(refuseCheckoutEnvFile(["--smol"])).toContain(".env");
  });

  test("the package scripts that boot or observe a stack all pass --no-env-file", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { scripts: Record<string, string> };
    for (const name of ["smoke", "smoke:down", "smoke:status", "smoke:tui"]) {
      expect({ name, cmd: pkg.scripts[name]?.startsWith("bun --no-env-file ") }).toEqual({ name, cmd: true });
    }
  });
});
