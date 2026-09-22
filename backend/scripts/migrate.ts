// `bun run migrate` — apply pending migrations to the database in $HOME/.env.
//
// This REPLACES scripts/ops/provision-db-role-taxonomy.sh. Where that script
// applied 0053/0062 out-of-band through psql — and never recorded them in
// `schema_migrations`, which is exactly how production's ledger drifted — this
// runs the normal forward-only runner (backend/src/db/migrate.ts), so every
// migration it applies (the role taxonomy included) is RECORDED. It migrates
// and nothing else: seeding is a separate tool (`bun run src/db/seed.ts`).
//
// It reads the connection from the ONE credential file, $HOME/.env — the
// discrete-token convention every tool here uses (scripts/lib/env-role.ts):
// host/port/database/sslmode plus one `<role> = <password>` line. The role is
// the migration login. It must hold rm_owner membership (migrate.ts SET LOCAL
// ROLE rm_owner for migrations >= 0054) and, for a first bootstrap that creates
// the taxonomy, CREATEROLE. On a DigitalOcean cluster that is `doadmin`;
// override with `--role <login>` or MIGRATE_ROLE.
import { homeEnvFilePath, loadEnvFile, redactedTarget, urlForRole } from "../../scripts/lib/env-role.ts";

const NAME = "migrate";
const err = (m: string) => console.error(`[${NAME}] ${m}`);
const log = (m: string) => console.log(`[${NAME}] ${m}`);

// The migration login: --role <login>, else MIGRATE_ROLE, else doadmin.
const roleFlag = process.argv.indexOf("--role");
const role = roleFlag >= 0 ? process.argv[roleFlag + 1] : (process.env.MIGRATE_ROLE ?? "doadmin");
if (!role) {
  err("--role needs a value");
  process.exit(64);
}

const env = loadEnvFile(homeEnvFilePath());
if (!env) {
  err(`no readable $HOME/.env (${homeEnvFilePath()}).`);
  process.exit(1);
}

const url = urlForRole(env, role);
if (!url) {
  err(`$HOME/.env cannot assemble a '${role}' connection.`);
  err(`It needs the discrete tokens (host, port, database, sslmode) plus a`);
  err(`'${role} = <password>' line. Use --role <login> or MIGRATE_ROLE for a different login.`);
  process.exit(1);
}

log(`${redactedTarget(url, role)} — migrations only, no seed`);
process.env.MIGRATE_DATABASE_URL = url;

// backend/src/config.ts is validated at import and REQUIRES a runtime
// DATABASE_URL (and forbids doadmin there in prod). The migration itself
// connects via MIGRATE_DATABASE_URL above, so give config the rm_app runtime
// URL from the SAME .env — assembled, never a placeholder — before importing
// the runner. This is why the imports below are dynamic: config runs at import.
const appUrl = urlForRole(env, "rm_app");
if (!appUrl) {
  err(`$HOME/.env also needs an 'rm_app = <password>' line — the migration runner`);
  err(`loads the app config, which requires the runtime role's URL.`);
  process.exit(1);
}
process.env.DATABASE_URL = appUrl;

const { migrate } = await import("../src/db/migrate.ts");
const { closeDb } = await import("../src/db/client.ts");
try {
  await migrate();
  log("done");
} catch (e) {
  err(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
} finally {
  await closeDb();
}
