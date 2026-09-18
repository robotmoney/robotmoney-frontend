// shapeTwinToProductionPrivileges() — the smoke-twin's stand-in for the
// production primary's pre-0053 privilege topology.
//
// WHY THIS FILE EXISTS. A smoke-twin restores with `--no-owner
// --no-privileges` and migrates as its container SUPERUSER, so it has no
// ownership model to change and no privilege constraint while changing it.
// That is why 0053's three privilege defects were invisible to the rehearsal
// as well as to this suite. The helper reshapes a restored twin so a
// NON-superuser bootstrap login owns `public`, and the rehearsal points
// MIGRATE_DATABASE_URL at it.
//
// What is asserted here is the SHAPE the helper produces. That the migrations
// then apply through it is covered by
// migrations-under-production-privileges.test.ts, which drives the same role
// attributes from scratch.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { TWIN_BOOTSTRAP_ROLE, shapeTwinToProductionPrivileges } from "../../scripts/lib/restore-container.ts";

const ADMIN_URL = process.env.DATABASE_URL!;
const TWIN_DB = "rm_twinshape_probe";

let admin: ReturnType<typeof postgres>;
let twinSuperuserUrl: string;
let shapedUrl: string;

beforeAll(async () => {
  admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  await admin.unsafe(`DROP DATABASE IF EXISTS ${TWIN_DB} WITH (FORCE)`).catch(() => {});
  await admin.unsafe(`DROP ROLE IF EXISTS ${TWIN_BOOTSTRAP_ROLE}`).catch(() => {});
  await admin.unsafe(`CREATE DATABASE ${TWIN_DB}`);

  const u = new URL(ADMIN_URL);
  u.pathname = `/${TWIN_DB}`;
  twinSuperuserUrl = u.toString();

  // Stand in for a freshly restored twin: objects owned by the container
  // superuser, plus an extension whose functions must NOT be re-owned.
  const twin = postgres(twinSuperuserUrl, { max: 1, onnotice: () => {} });
  await twin`CREATE EXTENSION IF NOT EXISTS pgcrypto`;
  await twin`CREATE TABLE restored_a (id bigserial PRIMARY KEY, v text)`;
  await twin`CREATE TABLE restored_b (id int PRIMARY KEY)`;
  await twin`CREATE VIEW restored_v AS SELECT id FROM restored_b`;
  await twin.unsafe(`CREATE FUNCTION app_fn() RETURNS int LANGUAGE sql AS 'SELECT 1'`);
  await twin.end();

  const shaped = shapeTwinToProductionPrivileges(twinSuperuserUrl, () => {});
  if ("error" in shaped) throw new Error(shaped.error);
  shapedUrl = shaped.url;
});

afterAll(async () => {
  await admin?.unsafe(`DROP DATABASE IF EXISTS ${TWIN_DB} WITH (FORCE)`).catch(() => {});
  await admin?.unsafe(`DROP ROLE IF EXISTS ${TWIN_BOOTSTRAP_ROLE}`).catch(() => {});
  await admin?.end();
});

describe("shapeTwinToProductionPrivileges", () => {
  test("the returned URL authenticates as a NON-superuser (the whole point)", async () => {
    const db = postgres(shapedUrl, { max: 1, onnotice: () => {} });
    const [r] = (await db`SELECT current_user AS who, rolsuper, rolcreaterole, rolcreatedb
      FROM pg_roles WHERE rolname = current_user`) as unknown as { who: string; rolsuper: boolean; rolcreaterole: boolean; rolcreatedb: boolean }[];
    await db.end();
    // rolsuper=true here would make the whole rehearsal meaningless again.
    expect(r).toEqual({ who: TWIN_BOOTSTRAP_ROLE, rolsuper: false, rolcreaterole: true, rolcreatedb: true });
  });

  test("the bootstrap login owns public and the restored application objects", async () => {
    const db = postgres(twinSuperuserUrl, { max: 1, onnotice: () => {} });
    const schemaOwner = (await db`SELECT pg_get_userbyid(nspowner) AS o FROM pg_namespace WHERE nspname='public'`)[0]!.o;
    const notOwned = (await db`
      SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind IN ('r','p','v')
        AND pg_get_userbyid(c.relowner) <> ${TWIN_BOOTSTRAP_ROLE}`)[0]!.n;
    const appFn = (await db`
      SELECT pg_get_userbyid(proowner) AS o FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='app_fn'`)[0]!.o;
    await db.end();
    expect(schemaOwner).toBe(TWIN_BOOTSTRAP_ROLE);
    expect({ publicObjectsNotOwnedByBootstrap: Number(notOwned) }).toEqual({ publicObjectsNotOwnedByBootstrap: 0 });
    expect(appFn).toBe(TWIN_BOOTSTRAP_ROLE);
  });

  test("extension functions are left with their own owner", async () => {
    const db = postgres(twinSuperuserUrl, { max: 1, onnotice: () => {} });
    const reowned = (await db`
      SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND pg_get_userbyid(p.proowner) = ${TWIN_BOOTSTRAP_ROLE}
        AND EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e')`)[0]!.n;
    const total = (await db`
      SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public'
        AND EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e')`)[0]!.n;
    await db.end();
    // pgcrypto must have contributed functions, and none may have moved:
    // re-owning an extension's function fails outright for a non-superuser
    // ("must be owner of function digest") and is wrong even when permitted.
    expect(Number(total)).toBeGreaterThan(0);
    expect({ extensionFunctionsReowned: Number(reowned) }).toEqual({ extensionFunctionsReowned: 0 });
  });

  test("an identity sequence is not re-owned independently of its table", async () => {
    // restored_a's bigserial sequence follows the table; Postgres rejects
    // changing it on its own, which is why both sweeps exclude deptype a/i.
    const db = postgres(twinSuperuserUrl, { max: 1, onnotice: () => {} });
    const seqOwner = (await db`
      SELECT pg_get_userbyid(c.relowner) AS o FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind='S'`)[0]!.o;
    await db.end();
    // It still ends up on the bootstrap role — carried by its table, not by a
    // direct ALTER. Asserted so a regression that starts ALTERing it directly
    // (and fails on a real twin) is visible here.
    expect(seqOwner).toBe(TWIN_BOOTSTRAP_ROLE);
  });
});
