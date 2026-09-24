// Every migration, applied by a NON-SUPERUSER login shaped like production's.
//
// WHY THIS FILE EXISTS. Everything else that runs our migrations — this suite's
// own preload, the digital smoke-twin's boot — applies them as a container
// SUPERUSER, which bypasses the ACL checks that a real deployment cannot. The
// production primary's bootstrap login is `doadmin`: rolsuper=FALSE, with
// rolcreaterole/rolcreatedb/rolbypassrls/rolreplication true. Under that role
// 0053 failed three separate ways while every test stayed green, and the live
// preflight could not see it either — it audits role STATE read-only and never
// executes the migration SQL. The gap was: nobody ran the SQL under real
// privileges. That is this file.
//
// It is deliberately cheap — an empty database on the suite's existing
// instance, no dump and no production access — so it runs on every commit
// rather than once per release. The smoke-twin rehearsal is the complementary
// check: it runs the same SQL against production's REAL object set, which a
// from-scratch database cannot reproduce.
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const ADMIN_URL = process.env.DATABASE_URL!;
const BOOT_ROLE = "rm_privprobe_boot";
const BOOT_PASSWORD = "privprobe";
const PROBE_DB = "rm_privprobe";
// 0053 ALTERs these; they are cluster-global and already exist here because
// preload migrated the suite's own database as superuser. Production's doadmin
// holds ADMIN OPTION on the ones that predate 0053 (verified against the
// replica: rm_worker and rm_readonly), so the fixture grants the same rather
// than leaving the bootstrap login weaker than the real one.
const PREEXISTING_TAXONOMY_ROLES = ["rm_worker", "rm_readonly", "rm_app", "rm_owner"];

/** migrate.ts:58's own rule — every file from 0054 on runs as rm_owner. */
const RUNS_AS_OWNER = (file: string) => file >= "0054_rm_worker_allowlist.sql";

let admin: ReturnType<typeof postgres>;
let bootUrl: string;
let files: string[] = [];

beforeAll(async () => {
  admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  const [{ rolsuper }] = (await admin`SELECT rolsuper FROM pg_roles WHERE rolname = current_user`) as unknown as { rolsuper: boolean }[];
  // Not a silent skip: without a superuser we cannot CREATE the non-superuser
  // role this file exists to test under, and quietly passing would let the
  // whole defect class back in.
  expect({ needSuperuserToCreateANonSuperuser: rolsuper }).toEqual({ needSuperuserToCreateANonSuperuser: true });

  await admin.unsafe(`DROP DATABASE IF EXISTS ${PROBE_DB} WITH (FORCE)`).catch(() => {});
  await admin.unsafe(`DROP ROLE IF EXISTS ${BOOT_ROLE}`).catch(() => {});
  // doadmin's exact production attribute set.
  await admin.unsafe(`CREATE ROLE ${BOOT_ROLE} LOGIN CREATEROLE CREATEDB BYPASSRLS REPLICATION PASSWORD '${BOOT_PASSWORD}'`);
  for (const role of PREEXISTING_TAXONOMY_ROLES) {
    await admin.unsafe(`GRANT ${role} TO ${BOOT_ROLE} WITH ADMIN OPTION`).catch(() => {});
  }
  await admin.unsafe(`CREATE DATABASE ${PROBE_DB} OWNER ${BOOT_ROLE}`);

  const u = new URL(ADMIN_URL);
  u.username = BOOT_ROLE;
  u.password = BOOT_PASSWORD;
  u.pathname = `/${PROBE_DB}`;
  bootUrl = u.toString();

  files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
});

afterAll(async () => {
  await admin?.unsafe(`DROP DATABASE IF EXISTS ${PROBE_DB} WITH (FORCE)`).catch(() => {});
  for (const role of PREEXISTING_TAXONOMY_ROLES) {
    await admin?.unsafe(`REVOKE ${role} FROM ${BOOT_ROLE}`).catch(() => {});
  }
  await admin?.unsafe(`DROP ROLE IF EXISTS ${BOOT_ROLE}`).catch(() => {});
  await admin?.end();
});

describe("every migration applies under production's privilege model", () => {
  test("the bootstrap login is genuinely NOT a superuser (guards the fixture)", async () => {
    const db = postgres(bootUrl, { max: 1, onnotice: () => {} });
    const [r] = (await db`SELECT rolsuper, rolcreaterole FROM pg_roles WHERE rolname = current_user`) as unknown as { rolsuper: boolean; rolcreaterole: boolean }[];
    await db.end();
    // If this ever reads rolsuper=true the file is testing nothing at all.
    expect(r).toEqual({ rolsuper: false, rolcreaterole: true });
  });

  test("all migrations apply, with 0054+ running as rm_owner", async () => {
    const db = postgres(bootUrl, { max: 1, onnotice: () => {} });
    await db`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
    const failures: string[] = [];
    for (const file of files) {
      const ddl = await readFile(join(MIGRATIONS_DIR, file), "utf8");
      try {
        await db.begin(async (tx) => {
          if (RUNS_AS_OWNER(file)) await tx.unsafe("SET LOCAL ROLE rm_owner");
          await tx.unsafe(ddl);
          await tx`INSERT INTO schema_migrations (name) VALUES (${file})`;
        });
      } catch (e) {
        failures.push(`${file}: ${e instanceof Error ? e.message : e}`);
        break; // later files assume earlier ones landed; one failure is the signal
      }
    }
    const applied = Number((await db`SELECT count(*)::int AS n FROM schema_migrations`)[0]!.n);
    await db.end();
    expect(failures).toEqual([]);
    expect(applied).toBe(files.length);
  }, 120_000);

  test("0053 left extension-owned functions alone and took the application's", async () => {
    const db = postgres(bootUrl, { max: 1, onnotice: () => {} });
    const ext = (await db`
      SELECT count(*)::int AS n FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND pg_get_userbyid(p.proowner) <> 'rm_owner'
        AND EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e')`)[0]!.n;
    const strays = (await db`
      SELECT count(*)::int AS n FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND pg_get_userbyid(p.proowner) <> 'rm_owner'
        AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e')`)[0]!.n;
    const schemaOwner = (await db`SELECT pg_get_userbyid(nspowner) AS o FROM pg_namespace WHERE nspname='public'`)[0]!.o;
    const tablesNotOwned = (await db`
      SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind IN ('r','p') AND pg_get_userbyid(c.relowner) <> 'rm_owner'`)[0]!.n;
    await db.end();
    // pgcrypto's digest()/gen_random_bytes() must keep their own owner: an
    // extension's objects belong to its lifecycle, and re-owning them fails
    // outright for a non-superuser ("must be owner of function digest").
    expect(Number(ext)).toBeGreaterThan(0);
    expect({ applicationFunctionsNotOwnedByRmOwner: Number(strays) }).toEqual({ applicationFunctionsNotOwnedByRmOwner: 0 });
    expect({ tablesNotOwnedByRmOwner: Number(tablesNotOwned) }).toEqual({ tablesNotOwnedByRmOwner: 0 });
    expect(schemaOwner).toBe("rm_owner");
  });

  test("the runtime role cannot assume the owner (the point of the taxonomy)", async () => {
    const db = postgres(bootUrl, { max: 1, onnotice: () => {} });
    const [{ is_member }] = (await db`SELECT pg_has_role('rm_app','rm_owner','MEMBER') AS is_member`) as unknown as { is_member: boolean }[];
    const [{ boot_member }] = (await db`SELECT pg_has_role(current_user,'rm_owner','MEMBER') AS boot_member`) as unknown as { boot_member: boolean }[];
    await db.end();
    // rm_app must NOT reach rm_owner; the bootstrap login must, or 0054+
    // cannot run at all (0053's `GRANT rm_owner TO current_user`).
    expect({ rm_app_can_become_owner: is_member }).toEqual({ rm_app_can_become_owner: false });
    expect({ bootstrap_can_become_owner: boot_member }).toEqual({ bootstrap_can_become_owner: true });
  });
});
