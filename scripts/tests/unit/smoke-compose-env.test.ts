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
import { shadowingStackEnvWarnings, smokePassthroughEnv, stackAllowInsecureFor } from "../../lib/smoke-compose-env.ts";
import { buildSmokeLifecycleComposeEnv } from "../../lib/smoke-lifecycle-env.ts";
import { refuseCheckoutEnvFile } from "../../smoke.ts";
import {
  buildComposeEnv,
  DEFAULT_COMPOSE_FILES,
  DEFAULT_STACK_DATABASE,
  INSTANCE_COMPOSE_VAR,
  INSTANCE_STATE_DIR_COMPOSE_VAR,
  type StackConfig,
} from "../../stack/config.ts";
import { instancePaths, TOKEN_FILE_NAME } from "../../lib/smoke-state.ts";

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

  test("never forwards a migration credential either: no container runs a migration any more", () => {
    // `bun smoke --migrate` runs the migrate run on the HOST as rm_owner, under
    // the boot's target lock (backend/scripts/smoke-prepare.ts). The one-shot
    // migrate container that read MIGRATE_DATABASE_URL — and the twin
    // bootstrap login restore-container.ts used to hand it — is gone, so a
    // value, set by anything, reaches no container.
    const url = "postgres://rm_bootstrap:pw@172.17.0.1:32817/rm_restore_check";
    expect(smokePassthroughEnv({ MIGRATE_DATABASE_URL: url })).toEqual({});
  });

  test("the worker's credential is the stack's own: buildComposeEnv emits rm_worker from StackDatabase.roleUrls", () => {
    const cfg: StackConfig = {
      repoRoot: "/repo",
      project: "rm_smoke_stack_roles",
      profile: "core",
      composeFiles: DEFAULT_COMPOSE_FILES,
      database: {
        ...DEFAULT_STACK_DATABASE,
        roleUrls: { app: "postgres://rm_app:a@postgres:5432/robotmoney", worker: "postgres://rm_worker:w@postgres:5432/robotmoney" },
      },
      credentials: { adminToken: "a", automationToken: "b", analyticsToken: "c" },
      environment: { class: "local", hash: "0123456789" },
      rmEnv: "stage",
      extraComposeEnv: smokePassthroughEnv({ WORKER_DATABASE_URL: "postgres://rm_worker:shell@elsewhere:5432/x" }),
    };
    const env = buildComposeEnv(cfg);
    expect(env.DATABASE_URL).toBe("postgres://rm_app:a@postgres:5432/robotmoney");
    expect(env.WORKER_DATABASE_URL).toBe("postgres://rm_worker:w@postgres:5432/robotmoney");
    // Red control: without roleUrls both fall back to the one legacy login a
    // consumer that has not moved onto the taxonomy states explicitly.
    const legacy = buildComposeEnv({ ...cfg, database: DEFAULT_STACK_DATABASE });
    expect(legacy.WORKER_DATABASE_URL).toBe(legacy.DATABASE_URL);
    expect(legacy.DATABASE_URL).toBe("postgres://robotmoney:robotmoney@postgres:5432/robotmoney");
  });

  test("§4.4: a boot under RM_ENV=prod hands api NO allow-insecure; a stage boot keeps it (criterion 46's weakening-flag half)", () => {
    const cfg: StackConfig = {
      repoRoot: "/repo",
      project: "rm_smoke_stack_insecure",
      profile: "core",
      composeFiles: DEFAULT_COMPOSE_FILES,
      database: DEFAULT_STACK_DATABASE,
      credentials: { adminToken: "a", automationToken: "b", analyticsToken: "c" },
      environment: { class: "local", hash: "0123456789" },
      rmEnv: "prod",
    };
    expect(stackAllowInsecureFor("prod")).toBe(false);
    expect(stackAllowInsecureFor("stage")).toBe(true);
    expect(buildComposeEnv({ ...cfg, allowInsecure: stackAllowInsecureFor("prod") }).RM_ALLOW_INSECURE).toBe("");
    expect(buildComposeEnv({ ...cfg, rmEnv: "stage", allowInsecure: stackAllowInsecureFor("stage") }).RM_ALLOW_INSECURE).toBe("1");
    // Red control: a consumer that decides nothing keeps the overlay's old pin.
    expect(buildComposeEnv(cfg).RM_ALLOW_INSECURE).toBe("1");
    // And no one smuggles it back in through the extras map.
    expect(() => buildComposeEnv({ ...cfg, extraComposeEnv: { RM_ALLOW_INSECURE: "1" } })).toThrow(/StackConfig field/);
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
    for (const f of ["scripts/lib/smoke-main.ts", "scripts/smoke-down.ts", "scripts/smoke-status.ts", "scripts/stack/config.ts"]) {
      expect(files).toContain(f);
    }
    const composeMentions = files.filter((f) => /["']compose["']\s*,/.test(readFileSync(join(repoRoot, f), "utf8")));
    // Four since issue #1026 retired the two TUI pollers that also spelled a
    // compose argv (smoke-readiness-polling.ts, smoke-telemetry.ts); every one
    // of the four is named above, so the floor is exact, not a guess.
    expect(composeMentions.length).toBeGreaterThanOrEqual(4);
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
    const start = src.indexOf("dockerEnv = {");
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, src.indexOf("};", start));
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
    // The twin wrappers are here because they spawn the boot with their OWN
    // environment: a `.env` bun loaded into the wrapper reaches the boot even
    // though the boot itself runs with --no-env-file. smoke:clean and smoke:reap
    // act on the same stacks and have no reason to read the checkout either.
    for (const name of ["smoke", "smoke:down", "smoke:status", "smoke:tui", "smoke:twin", "smoke:twin:once", "smoke:clean", "smoke:reap"]) {
      expect({ name, cmd: pkg.scripts[name]?.startsWith("bun --no-env-file ") }).toEqual({ name, cmd: true });
    }
  });
});

describe("the twin wrappers hand the boot no checkout .env (criterion 122)", () => {
  // The wrapper spawns the boot with its own process.env. So the boot's
  // --no-env-file proves nothing unless the WRAPPER also ran without the file:
  // a planted value bun loaded into the wrapper would ride into the child.
  //
  // The run is stopped before any work: RM_ENV=bogus makes the boot refuse at
  // its RM_ENV check, which comes AFTER the SMOKE_PROJECT refusal and before
  // any port probe, restore or container. So which of the two refusals fires
  // says whether the planted SMOKE_PROJECT reached the boot. `--reuse` skips
  // the capture, and the key is a dummy the boot never gets to use.
  const planted = mkdtempSync(join(tmpdir(), "rm-planted-twin-dotenv-"));
  writeFileSync(join(planted, ".env"), "SMOKE_PROJECT=planted-project\n");
  const twin = join(repoRoot, "scripts", "smoke-twin.ts");
  const rehearse = join(repoRoot, "scripts", "smoke-twin-rehearse.ts");
  const run = (argv: string[], extra: Record<string, string> = {}) => {
    const r = Bun.spawnSync(["bun", ...argv], {
      cwd: planted,
      env: { PATH: process.env.PATH ?? "", HOME: planted, OPENCODE_API_KEY: "zen-dummy", RM_ENV: "bogus", ...extra },
      stdout: "pipe",
      stderr: "pipe",
    });
    return { code: r.exitCode, out: `${r.stdout.toString()}${r.stderr.toString()}` };
  };

  test("smoke:twin as package.json runs it: the boot never sees the planted SMOKE_PROJECT", () => {
    const r = run(["--no-env-file", twin, "--reuse"]);
    expect(r.out).toContain("equivalent: bun smoke --local dump --migrate");
    expect(r.out).toContain('RM_ENV="bogus" is not a policy value');
    expect(r.out).not.toContain("SMOKE_PROJECT is retired");
    expect(r.code).toBe(1);
  }, 30_000);

  test("red control: the same value in the real environment DOES reach the boot, and is refused", () => {
    const r = run(["--no-env-file", twin, "--reuse"], { SMOKE_PROJECT: "planted-project" });
    expect(r.out).toContain("SMOKE_PROJECT is retired with no alias");
    expect(r.code).toBe(1);
  }, 30_000);

  test("smoke:twin without --no-env-file is refused before it does anything", () => {
    const r = run([twin, "--reuse"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("auto-loaded this checkout's .env");
    expect(r.out).toContain("bun run smoke:twin");
    expect(r.out).not.toContain("equivalent:");
  }, 30_000);

  test("smoke:twin:once without --no-env-file is refused before it does anything", () => {
    const r = run([rehearse]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("auto-loaded this checkout's .env");
    expect(r.out).toContain("bun run smoke:twin:once");
    expect(r.out).not.toContain("booting:");
  }, 30_000);
});

// ── Criterion 113: the instance reaches compose, and only the scheduler's token dir is mounted ──
//
// buildComposeEnv emits RM_INSTANCE and RM_INSTANCE_STATE_DIR from
// StackConfig.instance; docker-compose.yml interpolates both with `:?` (no
// `./.agents/state` or `:-default` fallback), and system-scheduler mounts the
// instance's `tokens/system-scheduler/` directory only — never the instance
// directory, which holds role-passwords.json. The RENDERED mounts are asserted
// in scripts/tests/integration/no-db-credential-outside-api-compose-config.test.ts
// and smoke-compose-config.test.ts; these are the pure halves.
describe("buildComposeEnv carries the deployment instance (criterion 113)", () => {
  const base: StackConfig = {
    repoRoot: "/repo",
    project: "rm_smoke_stack_0123456789",
    profile: "core",
    composeFiles: DEFAULT_COMPOSE_FILES,
    database: DEFAULT_STACK_DATABASE,
    credentials: { adminToken: "a", automationToken: "b", analyticsToken: "c" },
    environment: { class: "local", hash: "0123456789" },
  };
  const stateDir = "/home/op/.local/state/robotmoney-smoke/rm_local_abc";

  test("emits RM_INSTANCE and RM_INSTANCE_STATE_DIR from StackConfig.instance", () => {
    const env = buildComposeEnv({ ...base, instance: { name: "rm_local_abc", stateDir } });
    expect(env[INSTANCE_COMPOSE_VAR]).toBe("rm_local_abc");
    expect(env[INSTANCE_STATE_DIR_COMPOSE_VAR]).toBe(stateDir);
    expect(INSTANCE_COMPOSE_VAR).toBe("RM_INSTANCE");
    expect(INSTANCE_STATE_DIR_COMPOSE_VAR).toBe("RM_INSTANCE_STATE_DIR");
  });

  test("red control: without an instance neither is emitted, so compose's `:?` refuses loudly", () => {
    const env = buildComposeEnv(base);
    expect(env).not.toHaveProperty("RM_INSTANCE");
    expect(env).not.toHaveProperty("RM_INSTANCE_STATE_DIR");
  });

  test("a relative state directory is refused: compose would resolve it inside the checkout", () => {
    expect(() => buildComposeEnv({ ...base, instance: { name: "x", stateDir: ".agents/state" } })).toThrow(/relative/);
  });

  test("extraComposeEnv cannot steer which instance's state a container mounts", () => {
    expect(() => buildComposeEnv({ ...base, extraComposeEnv: { RM_INSTANCE_STATE_DIR: "/tmp/other" } })).toThrow(/RM_INSTANCE_STATE_DIR/);
    expect(() => buildComposeEnv({ ...base, extraComposeEnv: { RM_INSTANCE: "other" } })).toThrow(/RM_INSTANCE/);
  });

  test("the state directory a boot hands compose is the instance's, and its scheduler token file is TOKEN_FILE_NAME", () => {
    const root = mkdtempSync(join(tmpdir(), "rm-compose-env-instance-"));
    const paths = instancePaths(root, "rm_local_abc", { create: true });
    const env = buildComposeEnv({ ...base, instance: { name: "rm_local_abc", stateDir: paths.dir } });
    expect(env.RM_INSTANCE_STATE_DIR).toBe(paths.dir);
    expect(paths.tokenFiles["system-scheduler"]).toBe(join(paths.dir, "tokens", "system-scheduler", TOKEN_FILE_NAME));
  });
});

/** The system-scheduler service block of a compose file, as text. */
function schedulerBlock(compose: string): string {
  const start = compose.indexOf("\n  system-scheduler:\n");
  const next = compose.slice(start + 1).search(/\n  [a-z][a-z0-9-]*:\n/);
  return compose.slice(start, next === -1 ? undefined : start + 1 + next);
}

/** Why a scheduler block could reach more than its own token directory, or null. */
function schedulerMountProblem(block: string): string | null {
  const code = block.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  if (/\.\/\.agents\/state/.test(code)) return "falls back to ./.agents/state in the checkout";
  if (/RM_INSTANCE(_STATE_DIR)?:-/.test(code)) return "has an interpolation default";
  if (!/\$\{RM_INSTANCE_STATE_DIR:\?[^}]*\}\/tokens\/system-scheduler:\/run\/rm-token:ro/.test(code)) return "does not mount tokens/system-scheduler read-only";
  if (!new RegExp(`SCHEDULER_TOKEN_FILE: /run/rm-token/${TOKEN_FILE_NAME}\\b`).test(code)) return "does not read /run/rm-token/<TOKEN_FILE_NAME>";
  return null;
}

describe("docker-compose.yml: the scheduler mounts its own token directory, with no fallback (criteria 40, 113)", () => {
  const compose = readFileSync(join(repoRoot, "docker-compose.yml"), "utf8");

  test("the real compose file passes", () => {
    expect(schedulerBlock(compose)).toContain("system-scheduler:");
    expect(schedulerMountProblem(schedulerBlock(compose))).toBeNull();
  });

  test("no compose file anywhere keeps a ./.agents/state or :-default instance fallback", () => {
    for (const file of ["docker-compose.yml", "docker-compose.smoke.yml", "docker-compose.stage.yml", "stacks/robotmoney-swarm/pods/workers/composefile.yml"]) {
      const code = readFileSync(join(repoRoot, file), "utf8").split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
      expect({ file, agentsState: /\.agents\/state/.test(code), defaulted: /RM_INSTANCE(_STATE_DIR)?:-/.test(code) }).toEqual({ file, agentsState: false, defaulted: false });
    }
  });

  test("red control: the retired whole-instance-directory mount is caught", () => {
    const retired =
      "\n  system-scheduler:\n    environment:\n      SCHEDULER_TOKEN_FILE: /run/rm-state/${RM_INSTANCE:-default}-scheduler-token\n" +
      "    volumes:\n      - ${RM_INSTANCE_STATE_DIR:-./.agents/state}:/run/rm-state:ro\n";
    expect(schedulerMountProblem(schedulerBlock(retired))).toBe("falls back to ./.agents/state in the checkout");
    const wholeDir = retired.replace("${RM_INSTANCE_STATE_DIR:-./.agents/state}", "${RM_INSTANCE_STATE_DIR:?x}").replace("${RM_INSTANCE:-default}", "x");
    expect(schedulerMountProblem(schedulerBlock(wholeDir))).toBe("does not mount tokens/system-scheduler read-only");
  });
});

describe("smoke:status / smoke:down add the instance to the rebuilt compose env", () => {
  test("both spread instanceComposeEnv over the stack record's env, so compose can parse the file", () => {
    for (const file of ["scripts/smoke-status.ts", "scripts/smoke-down.ts"]) {
      const src = readFileSync(join(repoRoot, file), "utf8");
      expect({ file, uses: /\.\.\.instanceComposeEnv\(\{ name: [a-z.]+, stateDir: paths\.dir \}\)/.test(src) }).toEqual({ file, uses: true });
    }
  });
});
