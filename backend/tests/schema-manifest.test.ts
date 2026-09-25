// `schema_manifest` (spec §8.3) — the one row that says what schema the
// database is SUPPOSED to have, so preflight check 3a can tell genuine drift
// from an ordinary version difference.
//
// These tests are the specification for src/db/schema-manifest.ts (issue
// #1026, W2). The catalog comparison it also exports (`compareCatalog`) is
// exercised class by class through check 3a in db-preflight-checks.test.ts.
//
// The hashing and serialization tests are pure: a content hash whose value is
// not executable by a test is a hash nobody can prove stayed stable across a
// refactor, and stability is the entire property.
//
// The state tests run against the real ephemeral Postgres in a database cloned
// for this file alone, because "ledger ahead of manifest" is a relationship
// between two tables and cannot be asserted about a mock.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { sql } from "../src/db/client.ts";
import { loadSnapshot } from "../src/db/schema-snapshot.ts";
import {
  MANIFEST_FORMAT_VERSION,
  MANIFEST_TABLE,
  detectManifestState,
  hashManifest,
  parseDeclaration,
  readManifest,
  serializeDeclaration,
  resumePlan,
  writeManifest,
  type SchemaDeclaration,
  type SchemaManifest,
} from "../src/db/schema-manifest.ts";
import { useCleanDatabase } from "./support/clean-db.ts";

useCleanDatabase(import.meta.file);

const MIGRATIONS_DIR = join(import.meta.dir, "..", "migrations");
const ON_DISK = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();

const DECLARATION: SchemaDeclaration = { text: "CREATE TABLE jobs (id bigserial PRIMARY KEY);\n" };

function manifest(over: Partial<SchemaManifest> = {}): SchemaManifest {
  const filenames = over.filenames ?? ON_DISK;
  const declaration = over.declaration ?? DECLARATION;
  return {
    formatVersion: MANIFEST_FORMAT_VERSION,
    declaration,
    filenames,
    contentHash: hashManifest(declaration, filenames),
    ...over,
  };
}

/** Migration 0064 creates the manifest table, but the afterEach below drops it
 *  so "no manifest table" stays reachable; a test that needs the table builds
 *  it here, owned by rm_owner as §8.3's write restriction requires. */
async function createManifestTable(): Promise<void> {
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS ${MANIFEST_TABLE} (
      format_version integer NOT NULL,
      declaration    text    NOT NULL,
      filenames      text[]  NOT NULL,
      content_hash   text    NOT NULL,
      singleton      boolean NOT NULL DEFAULT true UNIQUE CHECK (singleton)
    )`);
  await sql.unsafe(`ALTER TABLE ${MANIFEST_TABLE} OWNER TO rm_owner`);
}

async function insertManifestRow(row: {
  formatVersion?: number;
  declaration?: string;
  filenames: readonly string[];
  contentHash?: string;
}): Promise<void> {
  await sql`
    INSERT INTO schema_manifest (format_version, declaration, filenames, content_hash)
    VALUES (
      ${row.formatVersion ?? MANIFEST_FORMAT_VERSION},
      ${row.declaration ?? DECLARATION.text},
      ${row.filenames as string[]},
      ${row.contentHash ?? "unverified"}
    )`;
}

/** The ledger's recorded filenames, in apply order. */
async function ledgerNames(): Promise<string[]> {
  const rows = await sql<{ name: string }[]>`SELECT name FROM schema_migrations ORDER BY name`;
  return rows.map((r) => r.name);
}

afterEach(async () => {
  await sql.unsafe(`DROP TABLE IF EXISTS ${MANIFEST_TABLE}`);
});

// ───────────────────────────────────────────────────────────────────────────
// hashManifest — pure, and over BOTH inputs
// ───────────────────────────────────────────────────────────────────────────

describe("serializeDeclaration / parseDeclaration — the format-2 declaration the hash covers", () => {
  const exclusions = { roles: ["doadmin", "postgres"], extensions: ["pgcrypto", "plpgsql"] };
  const fingerprint = {
    "table public.jobs": { owner: "rm_owner" },
    "column public.jobs.id": { type: "bigint", notnull: "yes" },
  };

  test("round-trips the SQL, the exclusion list and the fingerprint", () => {
    const declaration = serializeDeclaration({ sql: DECLARATION.text, exclusions, fingerprint });
    expect(parseDeclaration(declaration)).toEqual({ sql: DECLARATION.text, exclusions, fingerprint });
  });

  test("is canonical: the order an object was built in never changes the bytes, so never the hash", () => {
    const scrambled = {
      "column public.jobs.id": { notnull: "yes", type: "bigint" },
      "table public.jobs": { owner: "rm_owner" },
    };
    const a = serializeDeclaration({ sql: "x", exclusions, fingerprint });
    const b = serializeDeclaration({ sql: "x", exclusions, fingerprint: scrambled });
    expect(b.text).toBe(a.text);
    expect(hashManifest(b, ON_DISK)).toBe(hashManifest(a, ON_DISK));
  });

  test("the hash covers the fingerprint: one changed attribute is a different digest", () => {
    const a = serializeDeclaration({ sql: "x", exclusions, fingerprint });
    const b = serializeDeclaration({
      sql: "x",
      exclusions,
      fingerprint: { ...fingerprint, "table public.jobs": { owner: "rm_app" } },
    });
    expect(hashManifest(b, ON_DISK)).not.toBe(hashManifest(a, ON_DISK));
  });

  test("refuses a format-1 declaration (bare SQL), naming why — 3a cannot compare against it", () => {
    expect(() => parseDeclaration(DECLARATION)).toThrow("not JSON");
    expect(() => parseDeclaration({ text: JSON.stringify({ sql: "x", exclusions }) })).toThrow("fingerprint");
    expect(() => parseDeclaration({ text: JSON.stringify({ sql: "x", fingerprint }) })).toThrow("exclusion list");
  });

  test("refuses an exclusion list naming a §3 taxonomy role", () => {
    const text = JSON.stringify({ sql: "x", exclusions: { roles: ["rm_owner"], extensions: [] }, fingerprint });
    expect(() => parseDeclaration({ text })).toThrow("rm_owner");
  });
});

describe("hashManifest — the content hash re-checked on every read", () => {
  test("is deterministic: the same declaration and filename list always hash the same", () => {
    const a = hashManifest(DECLARATION, ["0001_init.sql", "0002_next.sql"]);
    const b = hashManifest({ text: DECLARATION.text }, ["0001_init.sql", "0002_next.sql"]);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  test("covers the FILENAME LIST too — editing the list without the declaration changes the digest", () => {
    // Hashing only the declaration would let the filename list be edited
    // undetected, and that list is the identity check 3b reasons about (§8.4).
    const one = hashManifest(DECLARATION, ["0001_init.sql"]);
    const two = hashManifest(DECLARATION, ["0001_init.sql", "0002_next.sql"]);
    expect(two).not.toBe(one);
  });

  test("covers the declaration too — a hand-altered column changes the digest", () => {
    const altered = hashManifest({ text: `${DECLARATION.text}ALTER TABLE jobs ADD COLUMN sneaky text;\n` }, ON_DISK);
    expect(altered).not.toBe(hashManifest(DECLARATION, ON_DISK));
  });

  test("hashes the filename list in its RECORDED order, not a sorted one", () => {
    const forward = hashManifest(DECLARATION, ["0001_a.sql", "0002_b.sql"]);
    const reversed = hashManifest(DECLARATION, ["0002_b.sql", "0001_a.sql"]);
    expect(reversed).not.toBe(forward);
  });

  test("distinguishes the two 0059 migrations, which a number alone cannot", () => {
    const analytics = "0059_analytics_output_and_report_snapshots.sql";
    const swarm = "0059_swarm_framework_subject_snapshot_cleanup.sql";
    expect(ON_DISK).toContain(analytics);
    expect(ON_DISK).toContain(swarm);
    expect(hashManifest(DECLARATION, [analytics])).not.toBe(hashManifest(DECLARATION, [swarm]));
  });

  test("an empty filename list is still hashable — a blank database before bootstrap has one", () => {
    expect(hashManifest(DECLARATION, [])).toMatch(/^[0-9a-f]{64}$/);
    expect(hashManifest(DECLARATION, [])).not.toBe(hashManifest(DECLARATION, ["0001_init.sql"]));
  });
});

// ───────────────────────────────────────────────────────────────────────────
// readManifest / writeManifest — the round trip
// ───────────────────────────────────────────────────────────────────────────

describe("readManifest / writeManifest — round trip", () => {
  test("returns null when the table does not exist at all", async () => {
    expect(await readManifest(sql)).toBeNull();
  });

  test("returns null when the table exists but holds no row", async () => {
    await createManifestTable();
    expect(await readManifest(sql)).toBeNull();
  });

  test("a manifest written as rm_owner reads back byte-identical", async () => {
    await createManifestTable();
    const names = await ledgerNames();
    const published = manifest({ filenames: names });
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE rm_owner");
      await writeManifest(tx, published);
    });
    expect(await readManifest(sql)).toEqual(published);
  });

  test("reading does NOT refuse an unknown format version — reading is how you find that out", async () => {
    await createManifestTable();
    await insertManifestRow({ formatVersion: MANIFEST_FORMAT_VERSION + 7, filenames: await ledgerNames() });
    const read = await readManifest(sql);
    expect(read?.formatVersion).toBe(MANIFEST_FORMAT_VERSION + 7);
  });

  test("refuses more than one row — no choice between two manifests is defensible", async () => {
    // Migration 0064 creates `schema_manifest` with the singleton constraint,
    // so this builds the unconstrained shape on its own clone: what is under
    // test is readManifest's refusal to choose between two rows, not who
    // created the table, and the two-row state has to be constructible at all.
    await sql.unsafe(`DROP TABLE IF EXISTS ${MANIFEST_TABLE}`);
    await sql.unsafe(`
      CREATE TABLE ${MANIFEST_TABLE} (
        format_version integer NOT NULL, declaration text NOT NULL,
        filenames text[] NOT NULL, content_hash text NOT NULL)`);
    await insertManifestRow({ filenames: ["0001_a.sql"] });
    await insertManifestRow({ filenames: ["0002_b.sql"] });
    await expect(readManifest(sql)).rejects.toThrow(MANIFEST_TABLE);
  });
});

describe("writeManifest — a trusted input, written only by rm_owner and only with the grants", () => {
  test("refuses when the effective role is not rm_owner", async () => {
    await createManifestTable();
    // The suite's own connection is the container superuser, not rm_owner: a
    // grant mistake must fail loudly at the write rather than quietly widen who
    // can forge a boot decision.
    await expect(writeManifest(sql, manifest({ filenames: await ledgerNames() }))).rejects.toThrow("rm_owner");
  });

  test("refuses a filename list that does not equal the ledger's inside the same transaction", async () => {
    await createManifestTable();
    const wrong = (await ledgerNames()).slice(0, -1);
    await expect(
      sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE rm_owner");
        await writeManifest(tx, manifest({ filenames: wrong }));
      }),
    ).rejects.toThrow("ledger");
  });

  test("refuses a contentHash that is not hashManifest() of what is being written", async () => {
    await createManifestTable();
    const names = await ledgerNames();
    const forged: SchemaManifest = { ...manifest({ filenames: names }), contentHash: "0".repeat(64) };
    await expect(
      sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE rm_owner");
        await writeManifest(tx, forged);
      }),
    ).rejects.toThrow("hash");
  });

  test("refuses a formatVersion other than MANIFEST_FORMAT_VERSION", async () => {
    await createManifestTable();
    const names = await ledgerNames();
    const wrong: SchemaManifest = { ...manifest({ filenames: names }), formatVersion: MANIFEST_FORMAT_VERSION + 1 };
    await expect(
      sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE rm_owner");
        await writeManifest(tx, wrong);
      }),
    ).rejects.toThrow("format");
  });

  test("a refused write leaves no row — it commits with the reconciliation or it does not exist", async () => {
    await createManifestTable();
    const wrong = (await ledgerNames()).slice(0, -1);
    await sql
      .begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE rm_owner");
        await writeManifest(tx, manifest({ filenames: wrong }));
      })
      .catch(() => undefined);
    expect(await readManifest(sql)).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// detectManifestState — one classifier, two readers with opposite responses
// ───────────────────────────────────────────────────────────────────────────

describe("detectManifestState — classify manifest vs ledger", () => {
  test("`absent` when there is no table — NOT `in_progress`, which means something different", async () => {
    expect(await detectManifestState(sql)).toEqual({ kind: "absent" });
  });

  test("`absent` when the table exists with no row", async () => {
    await createManifestTable();
    expect(await detectManifestState(sql)).toEqual({ kind: "absent" });
  });

  test("`published` when the filename list equals the ledger's and the hash verifies", async () => {
    await createManifestTable();
    const names = await ledgerNames();
    await insertManifestRow({ filenames: names, contentHash: hashManifest(DECLARATION, names) });
    const state = await detectManifestState(sql);
    expect(state.kind).toBe("published");
    if (state.kind === "published") {
      expect(state.manifest.filenames).toEqual(names);
      expect(state.manifest.contentHash).toBe(hashManifest(DECLARATION, names));
    }
  });

  test("`in_progress` when the ledger is AHEAD, listing the uncovered rows in apply order", async () => {
    await createManifestTable();
    const names = await ledgerNames();
    const embodied = names.slice(0, -2);
    await insertManifestRow({ filenames: embodied, contentHash: hashManifest(DECLARATION, embodied) });
    const state = await detectManifestState(sql);
    expect(state.kind).toBe("in_progress");
    if (state.kind === "in_progress") {
      expect(state.ahead).toEqual(names.slice(-2));
      expect(state.manifest.filenames).toEqual(embodied);
    }
  });

  test("`inconsistent` when the manifest embodies a file the ledger does not record", async () => {
    await createManifestTable();
    const names = [...(await ledgerNames()), "9999_never_applied.sql"];
    await insertManifestRow({ filenames: names, contentHash: hashManifest(DECLARATION, names) });
    const state = await detectManifestState(sql);
    expect(state.kind).toBe("inconsistent");
    if (state.kind === "inconsistent") {
      expect(state.reasons.join("\n")).toContain("9999_never_applied.sql");
    }
  });

  test("`inconsistent` when the stored hash does not match the stored content", async () => {
    await createManifestTable();
    await insertManifestRow({ filenames: await ledgerNames(), contentHash: "f".repeat(64) });
    const state = await detectManifestState(sql);
    expect(state.kind).toBe("inconsistent");
    if (state.kind === "inconsistent") {
      expect(state.reasons.join("\n")).toMatch(/hash/i);
    }
  });

  test("`unknown_format` when formatVersion is not one this code understands, carrying the version back", async () => {
    await createManifestTable();
    const names = await ledgerNames();
    await insertManifestRow({
      formatVersion: MANIFEST_FORMAT_VERSION + 1,
      filenames: names,
      contentHash: hashManifest(DECLARATION, names),
    });
    expect(await detectManifestState(sql)).toEqual({
      kind: "unknown_format",
      formatVersion: MANIFEST_FORMAT_VERSION + 1,
    });
  });

  test("throws nothing of its own — every bad condition is a RETURNED state", async () => {
    // Its two callers want opposite behaviour from the same finding (an
    // application boot refuses `in_progress`, the migrate tool resumes it), so
    // the choice belongs to them.
    await createManifestTable();
    await insertManifestRow({ filenames: ["9999_never_applied.sql"], contentHash: "nope" });
    const state = await detectManifestState(sql);
    expect(["inconsistent", "unknown_format", "in_progress", "published", "absent"]).toContain(state.kind);
  });

  test("does not read the live catalog — dropping a trigger does not change the classification", async () => {
    await createManifestTable();
    const names = await ledgerNames();
    await insertManifestRow({ filenames: names, contentHash: hashManifest(DECLARATION, names) });
    const before = await detectManifestState(sql);
    await sql.unsafe("DROP TRIGGER IF EXISTS swarm_members_append_only ON swarm_members");
    expect(await detectManifestState(sql)).toEqual(before);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// resumePlan — the migrate tool's half of "in progress"
// ───────────────────────────────────────────────────────────────────────────

describe("resumePlan — finishing an interrupted run without replaying or accepting drift", () => {
  test("names committed-but-unmanifested work to VERIFY, pending work to APPLY, and always reconciles grants", async () => {
    await createManifestTable();
    const names = await ledgerNames();
    const embodied = names.slice(0, -2);
    await insertManifestRow({ filenames: embodied, contentHash: hashManifest(DECLARATION, embodied) });

    const onDisk = [...names, "0063_not_yet_applied.sql"];
    const plan = await resumePlan(sql, onDisk);
    expect(plan.committedToVerify).toEqual(names.slice(-2));
    expect(plan.pending).toEqual(["0063_not_yet_applied.sql"]);
    expect(plan.reconcileGrants).toBe(true);
  });

  test("re-applies nothing: every committed migration lands in committedToVerify, never in pending", async () => {
    await createManifestTable();
    const names = await ledgerNames();
    const embodied = names.slice(0, -1);
    await insertManifestRow({ filenames: embodied, contentHash: hashManifest(DECLARATION, embodied) });
    const plan = await resumePlan(sql, names);
    for (const committed of names) {
      expect(plan.pending).not.toContain(committed);
    }
  });

  test("reconcileGrants is true even with nothing pending and nothing to verify", async () => {
    await createManifestTable();
    const names = await ledgerNames();
    await insertManifestRow({ filenames: names, contentHash: hashManifest(DECLARATION, names) });
    const plan = await resumePlan(sql, names);
    expect(plan).toEqual({ committedToVerify: [], pending: [], reconcileGrants: true });
  });

  test("pending is in APPLY order, not discovery order", async () => {
    await createManifestTable();
    const names = await ledgerNames();
    await insertManifestRow({ filenames: names, contentHash: hashManifest(DECLARATION, names) });
    const plan = await resumePlan(sql, [...names, "0064_second.sql", "0063_first.sql"]);
    expect(plan.pending).toEqual(["0063_first.sql", "0064_second.sql"]);
  });

  test("refuses when a ledger row names a file that is not on disk — that is §8.4's question, not a resume", async () => {
    await createManifestTable();
    const names = await ledgerNames();
    await insertManifestRow({ filenames: names, contentHash: hashManifest(DECLARATION, names) });
    const missing = names[names.length - 1] ?? "";
    await expect(resumePlan(sql, names.slice(0, -1))).rejects.toThrow(missing);
  });

  test("refuses an `inconsistent` manifest — never resumable, make a human look", async () => {
    await createManifestTable();
    await insertManifestRow({ filenames: await ledgerNames(), contentHash: "f".repeat(64) });
    await expect(resumePlan(sql, ON_DISK)).rejects.toThrow(/inconsistent/i);
  });

  test("refuses an unknown format version", async () => {
    await createManifestTable();
    const names = await ledgerNames();
    await insertManifestRow({
      formatVersion: MANIFEST_FORMAT_VERSION + 1,
      filenames: names,
      contentHash: hashManifest(DECLARATION, names),
    });
    await expect(resumePlan(sql, ON_DISK)).rejects.toThrow(/format/i);
  });

  test("refuses when committed-but-unmanifested work fails its expected post-state check", async () => {
    // Spec §8.3 forbids "accepting drift", and a resume is exactly when
    // accepting it would be most tempting. 0032 installs the append-only guard
    // and 0053 re-owns every relation; a database whose ledger records 0032 but
    // whose trigger is gone has not actually reached that migration's post-state.
    await createManifestTable();
    const names = await ledgerNames();
    const embodied = names.filter((n) => n < "0032_append_only_history.sql");
    await insertManifestRow({ filenames: embodied, contentHash: hashManifest(DECLARATION, embodied) });
    await sql.unsafe("DROP TRIGGER IF EXISTS swarm_members_append_only ON swarm_members");
    await expect(resumePlan(sql, names)).rejects.toThrow("swarm_members");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The trusted inputs are refused to rm_app BY GRANT (§8.3)
// ───────────────────────────────────────────────────────────────────────────

describe("rm_app is refused every write to the manifest and the ledger, by grant, connecting as rm_app", () => {
  // §8.3: "Only `rm_owner` may write it or the ledger's `compat`/
  // `metadata_version` columns; they are trusted inputs to boot decisions."
  //
  // The writeManifest test above proves only a TypeScript `current_user` check,
  // over the suite's superuser connection. These cases are the database's own
  // answer: a real login as rm_app, a real statement, SQLSTATE 42501 from the
  // executor's privilege check, which runs before a single row is formed. The
  // UPDATEs match every row, so a pass could not hide behind an empty match,
  // and any other outcome (success, or a constraint error that only a
  // privileged writer could reach) fails the equality below.
  //
  // WHY THE MANIFEST TABLE IS REBUILT FROM THE REAL 0064. This file's afterEach
  // drops `schema_manifest` after every test, so the table the migrations built
  // is long gone by now. Re-running the migration's own text as rm_owner puts
  // back exactly what 0064 creates, grants included. The later cases plant the
  // default privilege the old reconciliation left behind — every NEW rm_owner
  // table handed `SELECT, INSERT, UPDATE` for rm_app — which is the state in
  // which 0064's REVOKE is the only thing between rm_app and a forged manifest,
  // and then prove the real reconciliation (backend/schema/grants.sql) takes
  // that default back.
  const RM_APP_PASSWORD = "rm_app_manifest_grant_test";
  const MIGRATION_0064 = readFileSync(join(MIGRATIONS_DIR, "0064_schema_manifest.sql"), "utf8");
  let app: postgres.Sql<{}>;

  beforeAll(async () => {
    await sql.unsafe(`ALTER ROLE rm_app WITH LOGIN PASSWORD '${RM_APP_PASSWORD}'`);
    const [{ db }] = (await sql`SELECT current_database() AS db`) as unknown as { db: string }[];
    const url = new URL(process.env.DATABASE_URL!);
    url.pathname = `/${db}`;
    url.username = "rm_app";
    url.password = RM_APP_PASSWORD;
    app = postgres(url.toString(), { max: 1, onnotice: () => {} });
  });

  afterAll(async () => {
    await app?.end({ timeout: 5 });
  });

  async function asOwner(statements: string): Promise<void> {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE rm_owner");
      await tx.unsafe(statements);
    });
  }

  /** Put back 0064's table and one manifest row, as the migration and a
   *  migrate run would leave them. */
  async function rebuildManifestFromMigration(): Promise<void> {
    await sql.unsafe(`DROP TABLE IF EXISTS ${MANIFEST_TABLE}`);
    await asOwner(MIGRATION_0064);
    await insertManifestRow({ filenames: await ledgerNames() });
  }

  async function sqlstate(statement: string): Promise<string | null> {
    try {
      await app.unsafe(statement);
      return null;
    } catch (error) {
      return (error as { code?: string }).code ?? "no-sqlstate";
    }
  }

  async function assertRefusedByGrant(): Promise<void> {
    const [who] = (await app`SELECT current_user AS role`) as unknown as { role: string }[];
    expect(who?.role).toBe("rm_app");

    const refusals = {
      "INSERT schema_manifest": await sqlstate(
        `INSERT INTO ${MANIFEST_TABLE} (format_version, declaration, filenames, content_hash)
         VALUES (1, 'forged', ARRAY['0001_backends.sql'], 'forged')`,
      ),
      "UPDATE schema_manifest": await sqlstate(`UPDATE ${MANIFEST_TABLE} SET content_hash = 'forged'`),
      "UPDATE schema_migrations.compat": await sqlstate("UPDATE schema_migrations SET compat = 'additive'"),
      "UPDATE schema_migrations.metadata_version": await sqlstate("UPDATE schema_migrations SET metadata_version = 1"),
      "INSERT schema_migrations": await sqlstate(
        "INSERT INTO schema_migrations (name, compat, metadata_version) VALUES ('9999_forged.sql', 'additive', 1)",
      ),
    };
    expect(refusals).toEqual({
      "INSERT schema_manifest": "42501",
      "UPDATE schema_manifest": "42501",
      "UPDATE schema_migrations.compat": "42501",
      "UPDATE schema_migrations.metadata_version": "42501",
      "INSERT schema_migrations": "42501",
    });

    // Reading both stays open: the api's append-only guard reads the ledger at
    // boot, and §7.2 has every container run check 3a — which reads the ledger
    // and the manifest — under its own credential.
    const manifestRows = (await app.unsafe(`SELECT content_hash FROM ${MANIFEST_TABLE}`)) as unknown as {
      content_hash: string;
    }[];
    expect(manifestRows.map((r) => r.content_hash)).toEqual(["unverified"]);
    const ledger = (await app`SELECT name, compat, metadata_version FROM schema_migrations ORDER BY name`) as unknown as {
      name: string;
    }[];
    expect(ledger.map((r) => r.name)).toEqual(await ledgerNames());
    expect(ledger.some((r) => r.name === "9999_forged.sql")).toBe(false);
  }

  test("on the migrated schema: 42501 for every manifest write and every ledger write, SELECT still served", async () => {
    await rebuildManifestFromMigration();
    await assertRefusedByGrant();
  });

  /** Whether rm_app may INSERT into a table rm_owner creates right now — the
   *  default privileges in force, read off a real new table. */
  async function newTableAdmitsAppInsert(): Promise<boolean> {
    const probe = `rm_default_priv_probe_${crypto.randomUUID().slice(0, 8)}`;
    await asOwner(`CREATE TABLE ${probe} (x int)`);
    try {
      return (await sqlstate(`INSERT INTO ${probe} (x) VALUES (1)`)) === null;
    } finally {
      await asOwner(`DROP TABLE ${probe}`);
    }
  }

  test("under a default privilege that hands rm_app writes, 0064's own REVOKE is what refuses them", async () => {
    // Every database the old reconciliation ran on carries a default
    // `GRANT SELECT, INSERT, UPDATE ON TABLES TO rm_app` for rm_owner — the line
    // grants.sql used to end with, against 0053's no-default-write rule. That
    // is planted here, and 0064 creates the table under it: the order a
    // production database met them in.
    await asOwner("ALTER DEFAULT PRIVILEGES FOR ROLE rm_owner IN SCHEMA public GRANT SELECT, INSERT, UPDATE ON TABLES TO rm_app");
    // Red control: the planted default really does hand a new table's writes
    // to rm_app, so the refusal below is 0064's REVOKE and not an absence.
    expect(await newTableAdmitsAppInsert()).toBe(true);
    await rebuildManifestFromMigration();
    await assertRefusedByGrant();
  });

  test("the real grants reconciliation takes the default write grant back, and keeps every manifest write refused", async () => {
    await asOwner("ALTER DEFAULT PRIVILEGES FOR ROLE rm_owner IN SCHEMA public GRANT SELECT, INSERT, UPDATE ON TABLES TO rm_app");
    expect(await newTableAdmitsAppInsert()).toBe(true);
    const snapshot = await loadSnapshot();
    await asOwner(snapshot.grantsSql);
    // 0053: "There are no default write grants." After reconciliation a table
    // rm_owner creates gives rm_app nothing to write until a migration says so.
    expect(await newTableAdmitsAppInsert()).toBe(false);
    await rebuildManifestFromMigration();
    await assertRefusedByGrant();
    // And once more afterwards, as every later migrate run does: the sweep must
    // re-assert the narrowing, never undo it.
    await asOwner(snapshot.grantsSql);
    await assertRefusedByGrant();
  });
});
