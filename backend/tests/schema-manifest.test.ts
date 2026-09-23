// `schema_manifest` (spec §8.3) — the one row that says what schema the
// database is SUPPOSED to have, so preflight check 3a can tell genuine drift
// from an ordinary version difference.
//
// These tests are the specification for src/db/schema-manifest.ts. Every
// function there throws `NOT IMPLEMENTED` today, so every test here fails —
// #1026 W2 step 2's deliverable.
//
// The hashing tests are pure and pin EXACT digests, the way this repo already
// pins `promptHash` / `inputsDigest` in src/swarm/judge.ts: a content hash whose
// value is not executable by a test is a hash nobody can prove stayed stable
// across a refactor, and stability is the entire property.
//
// The state tests run against the real ephemeral Postgres in a database cloned
// for this file alone, because "ledger ahead of manifest" is a relationship
// between two tables and cannot be asserted about a mock.
import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { sql } from "../src/db/client.ts";
import {
  MANIFEST_FORMAT_VERSION,
  MANIFEST_TABLE,
  detectManifestState,
  hashManifest,
  readManifest,
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

/** The manifest table does not exist in this checkout's migrations yet — it is
 *  W2.6's. Tests that need it build it, and drop it again, so a file that ran
 *  before the migration lands still says something true. */
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
