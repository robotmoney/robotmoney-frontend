// The database classification step: empty bootstraps, populated is adopted by
// an archive boot and refused to a simulation boot.
//
// Runs against the suite's ephemeral Postgres (see tests/preload.ts), which is
// migrated and therefore POPULATED — the adopt/refuse split is exercised for
// real. The EMPTY case cannot be produced on that shared database (dropping
// public would sabotage every other file), so it gets its OWN throwaway
// database on the same Postgres instance — no migrations applied, genuinely
// zero BASE TABLEs in public — mirroring the pattern swarm-claim.test.ts uses
// for the same reason (a schema state the shared suite database can't hold).
import { expect, test } from "bun:test";
import postgres from "postgres";
import { config } from "../src/config.ts";
import { sql } from "../src/db/client.ts";
import {
  classifyDatabase,
  handleNamespaceConflicts,
  parseInitializer,
  reportLines,
} from "../scripts/db-preflight.ts";

test("empty database → bootstrap, on a genuinely fresh (unmigrated) database", async () => {
  const base = new URL(config.databaseUrl);
  const dbName = `tmp_preflight_empty_${crypto.randomUUID().slice(0, 8)}`;
  const admin = postgres(base.toString(), { max: 1, onnotice: () => {} });
  await admin.unsafe(`CREATE DATABASE ${dbName}`);
  await admin.end();

  const tmpUrl = new URL(base.toString());
  tmpUrl.pathname = `/${dbName}`;
  const db = postgres(tmpUrl.toString(), { max: 1, onnotice: () => {} });
  try {
    const r = await classifyDatabase("archive", db);
    expect(r).toEqual({ mode: "bootstrap", tables: 0, census: [], handleNamespaceConflicts: [], appendOnlyProblems: [] });
    // Same result regardless of initializer — EMPTY bootstraps either way,
    // the adopt/refuse split only matters once tables exist.
    const r2 = await classifyDatabase("simulation", db);
    expect(r2).toEqual({ mode: "bootstrap", tables: 0, census: [], handleNamespaceConflicts: [], appendOnlyProblems: [] });
    // And the invariant re-check is silent on a database whose schema does not
    // have swarm_members yet — this step runs BEFORE migrate, so "the table is
    // missing" is a migration's business, not an integrity violation.
    expect(await handleNamespaceConflicts(db)).toEqual([]);
  } finally {
    await db.end();
    const cleanup = postgres(base.toString(), { max: 1, onnotice: () => {} });
    await cleanup.unsafe(`DROP DATABASE IF EXISTS ${dbName}`);
    await cleanup.end();
  }
});

test("populated + archive boot → adopt, with a census the operator can recognise", async () => {
  const r = await classifyDatabase("archive");
  expect(r.mode).toBe("adopt");
  expect(r.tables).toBeGreaterThan(0);
  expect(r.census.length).toBeGreaterThan(0);
});

test("populated + simulation boot → refuse: smoke fixtures overwrite by design", async () => {
  const r = await classifyDatabase("simulation");
  expect(r.mode).toBe("refuse");
  expect(r.tables).toBeGreaterThan(0);
});

// ── The invariant re-check restored data has to pass (issue #597) ───────────
//
// Migration 0031's DO block refuses to INSTALL over a colliding pair, but it
// runs exactly once: a dump taken from a post-0031 database already carries
// 0031 in schema_migrations, so migrate.ts skips it and nothing re-validates.
// A plain pg_dump also emits CREATE TRIGGER post-data, so the COPY that loads
// the rows precedes the trigger. This step is the only thing standing in front
// of a restored violation, and it runs before the boot's first write.

test("the migrated database passes the handle/id namespace re-check", async () => {
  // The REAL migrated schema, not a hand-built table: if 0031 or 0030 ever
  // renames a column this query reads, this is where it goes red.
  expect(await handleNamespaceConflicts()).toEqual([]);
  const r = await classifyDatabase("archive");
  expect(r.handleNamespaceConflicts).toEqual([]);
});

test("a restored violation is DETECTED and the boot is refused, with both members named", async () => {
  // Built inside a transaction that is always rolled back, so the shared suite
  // database never actually holds the pair. DISABLE TRIGGER is itself
  // transactional, which is what makes this containable — and it is restored
  // with ENABLE ALWAYS, matching what 0031 installs.
  let conflicts: string[] = [];
  const holder = `pf-holder-${crypto.randomUUID().slice(0, 8)}`;
  const shadowed = `pf-shadowed-${crypto.randomUUID().slice(0, 8)}`;
  const rollback = new Error("rollback");
  try {
    await sql.begin(async (tx) => {
      await tx`ALTER TABLE swarm_members DISABLE TRIGGER swarm_members_handle_namespace_trigger`;
      await tx`INSERT INTO swarm_members (id, status, name, handle)
               VALUES (${shadowed}, 'active', 'Shadowed', ${`${shadowed}-h`})`;
      await tx`INSERT INTO swarm_members (id, status, name, handle)
               VALUES (${holder}, 'active', 'Holder', ${shadowed})`;
      await tx`ALTER TABLE swarm_members ENABLE ALWAYS TRIGGER swarm_members_handle_namespace_trigger`;
      conflicts = await handleNamespaceConflicts(tx);
      throw rollback;
    });
  } catch (e) {
    if (e !== rollback) throw e;
  }

  expect(conflicts).toHaveLength(1);
  // Both rows named: the pair is the only thing an operator needs, and knowing
  // WHICH id is being shadowed is what says which row has to move.
  expect(conflicts[0]).toContain(holder);
  expect(conflicts[0]).toContain(shadowed);

  // The report is a refusal that says nothing has been written, and it names
  // the pair underneath the header — smoke-failure.ts anchors on the first
  // refusal line and reads FORWARD, so the order is load-bearing.
  const lines = reportLines("db:5432/x", {
    mode: "adopt",
    tables: 55,
    census: [{ table: "swarm_members", rows: 12 }],
    handleNamespaceConflicts: conflicts,
    appendOnlyProblems: [],
  });
  const refusalAt = lines.findIndex((l) => l.includes("REFUSING the boot"));
  expect(refusalAt).toBeGreaterThanOrEqual(0);
  const block = lines.slice(refusalAt).join("\n");
  expect(block).toContain(holder);
  expect(block).toContain(shadowed);
  expect(block).toContain("addresses two members");
  expect(block).toContain("Nothing has been written");

  // …and the rollback really did undo it, trigger state included.
  expect(await handleNamespaceConflicts()).toEqual([]);
  const [trg] = await sql<{ tgenabled: string }[]>`
    SELECT tgenabled FROM pg_trigger WHERE tgname = 'swarm_members_handle_namespace_trigger'`;
  expect(trg!.tgenabled).toBe("A");
});

test("parseInitializer fails closed — only an explicit archive flag can adopt", () => {
  expect(parseInitializer(["--initializer=archive"])).toBe("archive");
  expect(parseInitializer(["--initializer=simulation"])).toBe("simulation");
  // Missing, misspelled, or malformed all land in the strict branch: adopting
  // a populated database must never be what a forgotten parameter gets you.
  expect(parseInitializer([])).toBe("simulation");
  expect(parseInitializer(["--initializer=Archive"])).toBe("simulation");
  expect(parseInitializer(["--initializer="])).toBe("simulation");
  expect(parseInitializer(["archive"])).toBe("simulation");
});

test("the three reports say what will happen, not just what was found", () => {
  const bootstrap = reportLines("db:5432/x", {
    mode: "bootstrap", tables: 0, census: [], handleNamespaceConflicts: [], appendOnlyProblems: [],
  }).join("\n");
  expect(bootstrap).toContain("empty");
  expect(bootstrap).toContain("migrate + seed + archive restore");

  const adopt = reportLines("db:5432/x", {
    mode: "adopt",
    tables: 55,
    census: [{ table: "raw_indicator_history", rows: 116427 }],
    handleNamespaceConflicts: [],
    appendOnlyProblems: [],
  }).join("\n");
  expect(adopt).toContain("adopting as existing production data");
  expect(adopt).toContain("idempotent and deduplicated");
  expect(adopt).toContain("never overwrites existing rows");
  expect(adopt).toContain("raw_indicator_history ~116427 rows");
  // The adopt report must NOT read as a refusal — an operator scanning the
  // boot log decides from this line whether their data is at risk.
  expect(adopt).not.toContain("REFUSING");

  const refuse = reportLines("db:5432/x", {
    mode: "refuse",
    tables: 55,
    census: [{ table: "raw_indicator_history", rows: 116427 }],
    handleNamespaceConflicts: [],
    appendOnlyProblems: [],
  }).join("\n");
  expect(refuse).toContain("REFUSING a simulation boot");
  expect(refuse).toContain("bun run smoke:archive");
  expect(refuse).toContain("Nothing has been written");
});

test("an ADOPTED database whose append-only guard is disarmed is refused, and the report says why", async () => {
  // The preflight's job is to decide whether the boot's next step — migrate,
  // seed, archive restore, every one of them a WRITE — should happen at all. A
  // database that records migration 0032 as applied and no longer refuses
  // deletion fails that test for the same reason a namespace violation does:
  // everything written past this point goes into tables that can be silently
  // emptied.
  //
  // Built on its own throwaway database, because the fixture disarms the guard
  // and the shared suite database must keep its.
  const base = new URL(config.databaseUrl);
  const dbName = `tmp_preflight_disarmed_${crypto.randomUUID().slice(0, 8)}`;
  const admin = postgres(base.toString(), { max: 1, onnotice: () => {} });
  await admin.unsafe(`CREATE DATABASE ${dbName} TEMPLATE "${process.env.RM_TEST_TEMPLATE_DB}"`);
  await admin.end();

  const url = new URL(base.toString());
  url.pathname = `/${dbName}`;
  const db = postgres(url.toString(), { max: 1, onnotice: () => {} });
  try {
    // Armed first — the control, so "refused" below cannot be a fact about
    // this helper rather than about the guard.
    const armed = await classifyDatabase("archive", db);
    expect(armed.appendOnlyProblems).toEqual([]);
    expect(reportLines("db:5432/x", armed).join("\n")).not.toContain("append-only guard");

    // One statement, function ownership only, catalog untouched.
    await db.unsafe(
      `CREATE OR REPLACE FUNCTION rm_append_only_guard() RETURNS trigger
       LANGUAGE plpgsql AS $$ BEGIN IF TG_LEVEL = 'ROW' THEN RETURN OLD; END IF; RETURN NULL; END $$;`,
    );

    const disarmed = await classifyDatabase("archive", db);
    expect(disarmed.mode).toBe("adopt");
    expect(disarmed.appendOnlyProblems.length).toBeGreaterThan(0);
    const report = reportLines("db:5432/x", disarmed).join("\n");
    expect(report).toContain("REFUSING the boot: the append-only guard");
    expect(report).toContain("a DELETE was ACCEPTED");
    expect(report).toContain("Nothing has been written");
  } finally {
    await db.end();
    const cleanup = postgres(base.toString(), { max: 1, onnotice: () => {} });
    try {
      await cleanup.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    } finally {
      await cleanup.end();
    }
  }
});
