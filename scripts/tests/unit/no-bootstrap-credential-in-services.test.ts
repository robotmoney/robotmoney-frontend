// No long-running service may carry the migration bootstrap credential.
//
// 0053's header states the rule: "A human-run deployment connects with the
// short-lived MIGRATE_DATABASE_URL and SET ROLE rm_owner for DDL. Runtime
// processes authenticate only as rm_app or rm_worker." deployment.md §4.3 says
// the same operationally — "supply MIGRATE_DATABASE_URL only to that command".
//
// docker-compose.yml broke it, and not subtly. It declared
// `MIGRATE_DATABASE_URL: ${MIGRATE_DATABASE_URL}` on six services: api, all
// three worker lanes, analytics-producer, and postgres — which is the database
// image and could not read it under any circumstances. On the production host
// that meant five long-lived containers each holding a login with CREATEROLE
// and rm_owner membership, for 19 hours, read by nothing: `src/api/index.ts:51`
// records that the api process "invokes neither migrate nor
// scripts/db-preflight.ts", and no worker lane imports migrate() either.
//
// THE REASON IT LOOKED NECESSARY. Migrations run as an EPHEMERAL child —
// `docker compose run --rm --no-deps -T api bun run src/db/migrate.ts`
// (scripts/stack/config.ts) — and `compose run` inherits the named service's
// `environment:` block. Compose offers no way to scope a variable to the
// run-child, so declaring it on `api` was the only way to reach the migration
// and it hit the persistent container as collateral. Naming it on the run
// invocation instead (`-e MIGRATE_DATABASE_URL`, bare) reaches exactly the
// process that needs it and nothing else.
//
// Read as TEXT. The subject is what the compose file GRANTS, which is a
// property of the file, not of a running stack.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..", "..");
const COMPOSE_FILES = [
  "docker-compose.yml",
  "docker-compose.smoke.yml",
  "docker-compose.stage.yml",
];

/** Credentials no persistent service may be handed. */
const BOOTSTRAP_ONLY = ["MIGRATE_DATABASE_URL"];

function read(name: string): string {
  try {
    return readFileSync(join(REPO, name), "utf8");
  } catch {
    return "";
  }
}

describe("the bootstrap migration credential never reaches a long-running service", () => {
  test("RED CONTROL: the compose file is found and does declare other env vars", () => {
    // Without this, an unreadable path would make every case below vacuous.
    const main = read("docker-compose.yml");
    expect(main.length).toBeGreaterThan(1000);
    expect(main).toContain("DATABASE_URL: ${DATABASE_URL}");
  });

  test.each(COMPOSE_FILES)("%s declares no bootstrap credential on any service", (file: string) => {
    const text = read(file);
    const offenders = text
      .split("\n")
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => !line.trim().startsWith("#"))
      .filter(({ line }) => BOOTSTRAP_ONLY.some((v) => new RegExp(`^\\s*${v}\\s*:`).test(line)))
      .map(({ line, n }) => `${file}:${n}: ${line.trim()}`);
    expect(offenders).toEqual([]);
  });

  test("the runtime services still get the runtime credentials they DO need", () => {
    // The point is least privilege, not no privilege: removing the wrong line
    // would break the stack, and this is what tells the two apart.
    const main = read("docker-compose.yml");
    expect(main).toContain("DATABASE_URL: ${DATABASE_URL}");
    expect(main).toMatch(/WORKER_DATABASE_URL:\s*\$\{WORKER_DATABASE_URL:-\}/);
  });

  test("the migration step is the one place that names the credential", () => {
    // Exactly one consumer, and it is the ephemeral `compose run` child.
    const config = read("scripts/stack/config.ts");
    expect(config).toContain("MIGRATION_CREDENTIAL_VARS");
    expect(config).toMatch(/MIGRATION_CREDENTIAL_VARS\.flatMap\(\(k\) => \["-e", k\]\)/);
  });
});
