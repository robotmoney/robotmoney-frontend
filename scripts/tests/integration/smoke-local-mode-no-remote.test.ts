// Criterion 32, rendered: "With a remote host in `~/.env`, any `--local` mode
// resolves to the local container and opens no remote connection."
//
// The unit half (scripts/tests/unit/smoke-env-policy.test.ts) shows the parser
// ignores ~/.env and that the compose child's environment carries no remote
// value. This file renders the stack the way a `--local blank` boot does:
// `docker compose --env-file /dev/null config` over the smoke's own files, with
// the environment buildSpawnEnv() hands the real child, while BOTH ~/.env and
// the operator's shell name a remote database. No service may come out holding
// the remote host. `config` is offline: no daemon state, no containers.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDataPath, usesComposePostgres } from "../../smoke.ts";
import { dropShellMigrationCredential, smokePassthroughEnv } from "../../lib/smoke-compose-env.ts";
import { buildSpawnEnv, composeArgs, DEFAULT_STACK_DATABASE, type StackConfig } from "../../stack/index.ts";

const repoRoot = join(import.meta.dir, "../../..");
const REMOTE_HOST = "db-rm-app-x.do-user-12345-0.b.db.ondigitalocean.com";
const COMPOSE_FILES = ["docker-compose.yml", "docker-compose.smoke.yml"];

const homeEnv = join(mkdtempSync(join(tmpdir(), "rm-c32-home-")), ".env");
writeFileSync(homeEnv, `host = ${REMOTE_HOST}\nport = 25060\ndatabase = defaultdb\nsslmode = require\nrm_app = s3cret-remote\n`);

/** The operator's shell: every database URL a stale export could leave behind. */
function operatorShell(): Record<string, string | undefined> {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    DOCKER_HOST: process.env.DOCKER_HOST,
    DATABASE_URL: `postgres://rm_app:s3cret@${REMOTE_HOST}:25060/defaultdb`,
    WORKER_DATABASE_URL: `postgres://rm_worker:s3cret@${REMOTE_HOST}:25060/defaultdb`,
    MIGRATE_DATABASE_URL: `postgres://rm_owner:s3cret@${REMOTE_HOST}:25060/defaultdb`,
  };
}

function stackConfig(env: Record<string, string | undefined>): StackConfig {
  return {
    repoRoot,
    project: "rm_smoke_stack_c32render",
    profile: "full",
    composeFiles: COMPOSE_FILES,
    // smoke-main.ts: an ephemeral data path takes DEFAULT_STACK_DATABASE, no URL.
    database: DEFAULT_STACK_DATABASE,
    credentials: { adminToken: "a", automationToken: "b", analyticsToken: "c", analyticsTokenFile: "/dev/null" },
    environment: { class: "local", hash: "c32c32c32c" },
    rmEnv: "smoke",
    // smoke-main.ts always hands the stack its instance (smoke spec §1.1).
    instance: { name: "rm_local_c32render", stateDir: "/var/empty/rm_local_c32render" },
    extraComposeEnv: { ...smokePassthroughEnv(env) },
  };
}

function render(spawnEnv: Record<string, string>): string {
  const r = Bun.spawnSync(
    ["docker", ...composeArgs("rm_smoke_stack_c32render", COMPOSE_FILES), "--profile", "full", "config", "--format", "json"],
    { cwd: repoRoot, env: spawnEnv, stdout: "pipe", stderr: "pipe" },
  );
  if (r.exitCode !== 0) throw new Error(`docker compose config failed: ${r.stderr.toString()}`);
  return r.stdout.toString();
}

describe("a --local blank boot renders no remote connection (criterion 32)", () => {
  test("the data path is the local container", () => {
    const { dataPath } = parseDataPath(["bun", "scripts/smoke.ts", "--local", "blank"], { envFilePath: homeEnv });
    expect(dataPath).toEqual({ kind: "ephemeral" });
    expect(usesComposePostgres(dataPath)).toBe(true);
  });

  test("no rendered service, and no compose-child variable, names the remote host", () => {
    const env = operatorShell();
    dropShellMigrationCredential(env);
    const spawnEnv = buildSpawnEnv(stackConfig(env), env);
    expect(Object.entries(spawnEnv).filter(([, v]) => v.includes(REMOTE_HOST))).toEqual([]);

    const rendered = JSON.parse(render(spawnEnv)) as { services: Record<string, { environment?: Record<string, string | null> }> };
    const leaks: string[] = [];
    for (const [name, svc] of Object.entries(rendered.services)) {
      for (const [k, v] of Object.entries(svc.environment ?? {})) {
        if (typeof v === "string" && v.includes(REMOTE_HOST)) leaks.push(`${name}.${k}`);
      }
    }
    expect(leaks).toEqual([]);
    // And the services that do dial a database dial the local one.
    expect(rendered.services.api?.environment?.DATABASE_URL).toContain("@postgres:5432/");
  }, 30_000);

  test("red control: the render does surface a remote value when one is passed in", () => {
    const env = operatorShell();
    const spawnEnv = { ...buildSpawnEnv(stackConfig(env), env), DATABASE_URL: `postgres://rm_app:s3cret@${REMOTE_HOST}:25060/defaultdb` };
    expect(render(spawnEnv)).toContain(REMOTE_HOST);
  }, 30_000);
});
