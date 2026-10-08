// D61's hard invariant, held against the code that assembles a container's
// environment: "`bun smoke` forwards only `rm_app`, `rm_worker` and
// `rm_readonly` to containers. No container, compose file, image or log
// receives `rm_owner` or `doadmin`."
//
// Since D61 the host's `~/.env` holds the `rm_owner` and `doadmin` lines beside
// the runtime role passwords, so every path from that file (and from the
// operator's shell) to a compose child is checked here with both lines present:
//   - the compose environment the smoke builds (`buildSpawnEnv` over a
//     StackConfig whose database role URLs come from `urlForRole`, with the
//     smoke's `extraComposeEnv` sources: `homeEnvComposeEnv` and
//     `smokePassthroughEnv`);
//   - the preparation child's environment (`prepareChildEnv`), which runs on
//     the host and reads `rm_owner` from the file itself, never from its env;
//   - the role list the preparation child will assemble URLs for from
//     `~/.env` (backend/scripts/smoke-prepare.ts RUNTIME_ROLES);
//   - the committed compose files, which may not interpolate either key.
// Red controls prove each check can fail: the runtime role passwords DO reach
// the compose environment through the same assembly.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnvFile, urlForRole } from "../../lib/env-role.ts";
import { homeEnvComposeEnv, smokePassthroughEnv } from "../../lib/smoke-compose-env.ts";
import { prepareChildEnv } from "../../lib/smoke-database.ts";
import { buildSpawnEnv, DEFAULT_COMPOSE_FILES, DEFAULT_STACK_DATABASE, type StackConfig } from "../../stack/index.ts";
import { RUNTIME_ROLES } from "../../../backend/scripts/smoke-prepare.ts";

const REPO = join(import.meta.dir, "..", "..", "..");

const OWNER = "owner-secret-3f9c1a";
const DOADMIN = "doadmin-secret-77b2e0";
const APP = "app-secret-1a2b3c";
const WORKER = "worker-secret-4d5e6f";
const READONLY = "readonly-secret-7a8b9c";

/** A host `~/.env` as D61 shapes it: the connection, all five role lines. */
const HOME_ENV = parseEnvFile(
  [
    "host = db.example.invalid",
    "port = 25060",
    "database = robotmoney",
    "sslmode = require",
    `rm_app = ${APP}`,
    `rm_worker = ${WORKER}`,
    `rm_readonly = ${READONLY}`,
    `rm_owner = ${OWNER}`,
    `doadmin = ${DOADMIN}`,
    "COINGECKO_API_KEY = CG-key",
  ].join("\n"),
);

/** An operator shell that exported both, under every spelling an operator might use. */
const SHELL_ENV: Record<string, string> = {
  PATH: "/usr/bin",
  HOME: "/home/operator",
  rm_owner: OWNER,
  doadmin: DOADMIN,
  RM_OWNER: OWNER,
  RM_OWNER_PASSWORD: OWNER,
  DOADMIN: DOADMIN,
  DOADMIN_PASSWORD: DOADMIN,
  PGPASSWORD: OWNER,
  DATABASE_URL: `postgres://rm_owner:${OWNER}@db.example.invalid:25060/robotmoney`,
  MIGRATE_DATABASE_URL: `postgres://doadmin:${DOADMIN}@db.example.invalid:25060/robotmoney`,
};

/** The stack config the smoke builds for the remote database (smoke-main.ts makeStackConfig). */
function remoteStackConfig(): StackConfig {
  const app = urlForRole(HOME_ENV, "rm_app")!;
  const worker = urlForRole(HOME_ENV, "rm_worker")!;
  return {
    repoRoot: "/repo",
    project: "rm_smoke_stack_0123456789",
    profile: "full",
    composeFiles: DEFAULT_COMPOSE_FILES,
    database: { ...DEFAULT_STACK_DATABASE, url: app, roleUrls: { app, worker } },
    environment: { class: "local", hash: "0123456789" },
    extraComposeEnv: { ...homeEnvComposeEnv(HOME_ENV), ...smokePassthroughEnv(SHELL_ENV) },
  };
}

function leaks(env: Record<string, string>): string[] {
  return Object.entries(env).flatMap(([key, value]) => {
    const found: string[] = [];
    if (/rm_owner|doadmin/i.test(key)) found.push(`key ${key}`);
    if (value.includes(OWNER) || value.includes(encodeURIComponent(OWNER))) found.push(`${key} holds the rm_owner password`);
    if (value.includes(DOADMIN) || value.includes(encodeURIComponent(DOADMIN))) found.push(`${key} holds the doadmin password`);
    if (/\brm_owner[:@]|\bdoadmin[:@]/.test(value)) found.push(`${key} names a privileged login`);
    return found;
  });
}

describe("D61: no container receives rm_owner or doadmin", () => {
  test("the compose environment the smoke builds holds neither, with both in ~/.env and in the shell", () => {
    expect(leaks(buildSpawnEnv(remoteStackConfig(), SHELL_ENV))).toEqual([]);
  });

  test("red control: the same assembly DOES carry the runtime roles it is allowed to forward", () => {
    const env = Object.values(buildSpawnEnv(remoteStackConfig(), SHELL_ENV)).join("\n");
    expect(env).toContain(APP);
    expect(env).toContain(WORKER);
  });

  test("red control: the leak check itself fires on a privileged value", () => {
    expect(leaks({ X: `postgres://rm_owner:${OWNER}@h/d` })).not.toEqual([]);
    expect(leaks({ doadmin: "x" })).not.toEqual([]);
  });

  test("homeEnvComposeEnv forwards only COINGECKO_API_KEY from a ~/.env holding both privileged lines", () => {
    expect(homeEnvComposeEnv(HOME_ENV)).toEqual({ COINGECKO_API_KEY: "CG-key" });
  });

  test("smokePassthroughEnv forwards none of the privileged spellings from the shell", () => {
    expect(leaks(smokePassthroughEnv(SHELL_ENV))).toEqual([]);
  });

  test("the preparation child's environment carries neither: it reads rm_owner from the file it is named, not from its env", () => {
    const child = prepareChildEnv(SHELL_ENV);
    expect(leaks(child)).toEqual([]);
    expect(Object.keys(child).sort()).toEqual(["HOME", "PATH"]);
  });

  test("the roles the preparation child assembles from ~/.env are exactly the three runtime roles", () => {
    expect([...RUNTIME_ROLES]).toEqual(["rm_app", "rm_worker", "rm_readonly"]);
  });

  test("no committed compose file interpolates rm_owner or doadmin", () => {
    const files = readdirSync(REPO).filter((name) => /^docker-compose.*\.ya?ml$/.test(name));
    expect(files.length).toBeGreaterThan(0);
    for (const name of files) {
      const text = readFileSync(join(REPO, name), "utf8");
      expect({ name, hits: text.match(/rm_owner|doadmin|RM_OWNER|DOADMIN/g) ?? [] }).toEqual({ name, hits: [] });
    }
  });
});
