// Compatibility (spec §8.2 and §8.4) — how an image built for snapshot N
// decides whether it may boot against a database that has moved on to M > N.
//
// These tests are the specification for src/db/schema-compat.ts, which
// preflight check 3b and the migrate run (scripts/migrate-run.ts) both call.
//
// WHY THE PARSER GETS SO MANY TESTS. The header parser is the only thing
// standing between the word `additive` and a wrong boot. §8.2 requires the
// declaration and forbids a default in either direction: defaulting to
// `additive` forges a promise nobody made, and defaulting to `breaking` makes
// the safe declaration the one you get by saying nothing, which teaches
// everyone to say nothing.
//
// The ledger tests run against the real ephemeral Postgres in a database cloned
// for this file alone, because "the column does not exist" and "the column is
// NULL" are different database states and §8.4 turns on the difference.
import { afterEach, describe, expect, test } from "bun:test";
import { sql } from "../src/db/client.ts";
import {
  COMPAT_COLUMNS,
  COMPAT_HEADER_BASELINE,
  COMPAT_METADATA_VERSION,
  checkCompatibility,
  parseMigrationHeader,
  parsePendingHeader,
  requiresCompatHeader,
  readLedgerCompat,
  recordMigrationCompat,
} from "../src/db/schema-compat.ts";
import { useCleanDatabase } from "./support/clean-db.ts";

useCleanDatabase(import.meta.file);

/** A header in the shape this repo already writes: the first comment block of
 *  the `.sql` file, where 0053 puts sixty lines of reasoning before the first
 *  statement. */
function header(lines: readonly string[]): string {
  return `${lines.map((l) => `-- ${l}`).join("\n")}\n\nALTER TABLE jobs ADD COLUMN note text;\n`;
}

/** Add §8.2's two ledger columns to this database's `schema_migrations`.
 *  Migration 0064 creates them, so the cloned template starts with them; the
 *  afterEach below drops them so "the column does not exist" stays reachable,
 *  and a test that needs them re-adds them here. */
async function addCompatColumns(): Promise<void> {
  await sql.unsafe(`ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS compat text`);
  await sql.unsafe(`ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS metadata_version integer`);
}

async function ledgerNames(): Promise<string[]> {
  const rows = await sql<{ name: string }[]>`SELECT name FROM schema_migrations ORDER BY name`;
  return rows.map((r) => r.name);
}

afterEach(async () => {
  for (const column of COMPAT_COLUMNS) {
    await sql.unsafe(`ALTER TABLE schema_migrations DROP COLUMN IF EXISTS ${column}`);
  }
});

// ───────────────────────────────────────────────────────────────────────────
// parseMigrationHeader
// ───────────────────────────────────────────────────────────────────────────

describe("parseMigrationHeader — the declaration §8.2 requires of every migration", () => {
  test("parses an `additive` declaration with its metadata version", () => {
    const text = header([
      "0063_add_note_column.sql",
      "",
      "compat: additive",
      "metadata_version: 1",
      "",
      "Adds a nullable column; every query the older registry declares still succeeds.",
    ]);
    expect(parseMigrationHeader("0063_add_note_column.sql", text)).toEqual({
      filename: "0063_add_note_column.sql",
      compat: "additive",
      metadataVersion: 1,
    });
  });

  test("parses a `breaking` declaration", () => {
    const text = header(["compat: breaking", "metadata_version: 1"]);
    expect(parseMigrationHeader("0064_drop_column.sql", text)).toEqual({
      filename: "0064_drop_column.sql",
      compat: "breaking",
      metadataVersion: 1,
    });
  });

  test("reads the declaration from the FIRST comment block only", () => {
    const text = [
      "-- compat: additive",
      "-- metadata_version: 1",
      "",
      "ALTER TABLE jobs ADD COLUMN note text;",
      "",
      "-- compat: breaking  (prose in a later comment, not a second declaration)",
    ].join("\n");
    expect(parseMigrationHeader("0065_first_block.sql", text).compat).toBe("additive");
  });

  test("refuses a file with no declaration — defaulting either way is wrong", () => {
    const text = header(["Adds a nullable column.", "No declaration anywhere in this file."]);
    expect(() => parseMigrationHeader("0066_undeclared.sql", text)).toThrow("0066_undeclared.sql");
  });

  test("refuses a value that is neither `additive` nor `breaking`", () => {
    const text = header(["compat: probably-fine", "metadata_version: 1"]);
    expect(() => parseMigrationHeader("0067_bad_value.sql", text)).toThrow("probably-fine");
  });

  test("refuses more than one declaration in the header block", () => {
    const text = header(["compat: additive", "compat: breaking", "metadata_version: 1"]);
    expect(() => parseMigrationHeader("0068_two_declarations.sql", text)).toThrow(/more than one|duplicate/i);
  });

  test("refuses a metadata_version that is not a positive integer", () => {
    for (const value of ["0", "-1", "1.5", "one"]) {
      const text = header(["compat: additive", `metadata_version: ${value}`]);
      expect(() => parseMigrationHeader(`0069_bad_version_${value}.sql`, text)).toThrow(/metadata_version/i);
    }
  });

  test("refuses a metadata_version greater than this checkout's — a file here cannot predate its own repo", () => {
    const future = COMPAT_METADATA_VERSION + 1;
    const text = header(["compat: additive", `metadata_version: ${future}`]);
    let caught: unknown;
    try {
      parseMigrationHeader("0070_from_the_future.sql", text);
    } catch (error) {
      caught = error;
    }
    const message = (caught as Error | undefined)?.message ?? "";
    expect(message).toMatch(/metadata_version/i);
    expect(message).toContain("0070_from_the_future.sql");
    expect(message).toContain(`${future}`);
  });

  test("refuses a missing metadata_version — `additive` alone does not say what it promised", () => {
    const text = header(["compat: additive"]);
    expect(() => parseMigrationHeader("0071_no_version.sql", text)).toThrow(/metadata_version/i);
  });

  test("parses this repo's real migrations, which is the only way the claim stays next to the SQL", async () => {
    // Parsing the FILE, not a sidecar, means the declaration cannot drift from
    // the SQL it describes and cannot be forgotten in review.
    const file = "0053_database_role_taxonomy.sql";
    const text = await Bun.file(`${import.meta.dir}/../migrations/${file}`).text();
    const parsed = parseMigrationHeader(file, text);
    expect(parsed.filename).toBe(file);
    expect(["additive", "breaking"]).toContain(parsed.compat);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The pre-compat baseline (D53 decision 3)
// ───────────────────────────────────────────────────────────────────────────

describe("the pre-compat baseline — 0001-0063 may be header-less, nothing after may", () => {
  const dir = `${import.meta.dir}/../migrations`;
  async function migrations(): Promise<{ file: string; text: string }[]> {
    const { readdir } = await import("node:fs/promises");
    const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
    return Promise.all(files.map(async (file) => ({ file, text: await Bun.file(`${dir}/${file}`).text() })));
  }

  test("the baseline is 0063", () => {
    expect(COMPAT_HEADER_BASELINE).toBe(63);
    expect(requiresCompatHeader("0063_deployment_identity.sql")).toBe(false);
    expect(requiresCompatHeader("0064_schema_manifest.sql")).toBe(true);
  });

  test("EVERY migration above 0063 carries a parseable header", async () => {
    const above = (await migrations()).filter(({ file }) => requiresCompatHeader(file));
    // RED CONTROL: the loop below must have something to check.
    expect(above.length).toBeGreaterThan(0);
    for (const { file, text } of above) {
      expect({ file, header: parsePendingHeader(file, text) !== null }).toEqual({ file, header: true });
    }
  });

  test("the baseline is load-bearing: files at or below 0063 exist without a header, and are not backfilled", async () => {
    const headerless = (await migrations()).filter(
      ({ file, text }) => !requiresCompatHeader(file) && parsePendingHeader(file, text) === null,
    );
    expect(headerless.length).toBeGreaterThan(0);
    expect(headerless.map((m) => m.file)).toContain("0001_backends.sql");
  });

  test("a header-less file at or below the baseline is pre-compat: null, not a default", () => {
    expect(parsePendingHeader("0063_precompat.sql", "-- prose only\nSELECT 1;\n")).toBeNull();
  });

  test("a header-less file above the baseline refuses, naming itself", () => {
    expect(() => parsePendingHeader("0073_undeclared.sql", "-- prose only\nSELECT 1;\n")).toThrow(
      "0073_undeclared.sql",
    );
  });

  test("a pre-compat file that DOES declare is parsed strictly — a bad declaration is still bad", () => {
    expect(() => parsePendingHeader("0053_bad.sql", "-- compat: maybe\n-- metadata_version: 1\nSELECT 1;\n")).toThrow(
      "maybe",
    );
    expect(parsePendingHeader("0053_good.sql", "-- compat: additive\n-- metadata_version: 1\nSELECT 1;\n")).toEqual({
      filename: "0053_good.sql",
      compat: "additive",
      metadataVersion: 1,
    });
  });

  test("a filename without a leading number refuses rather than guessing which side of the baseline it is on", () => {
    expect(() => requiresCompatHeader("schema.sql")).toThrow("schema.sql");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// readLedgerCompat
// ───────────────────────────────────────────────────────────────────────────

describe("readLedgerCompat — what a newer release RECORDED at apply time", () => {
  test("returns one row per requested filename, with nulls preserved", async () => {
    await addCompatColumns();
    const names = (await ledgerNames()).slice(0, 2);
    await sql`UPDATE schema_migrations SET compat = 'additive', metadata_version = 1 WHERE name = ${names[0] ?? ""}`;
    const rows = await readLedgerCompat(sql, names);
    expect(rows).toEqual([
      { filename: names[0] ?? "", compat: "additive", metadataVersion: 1 },
      { filename: names[1] ?? "", compat: null, metadataVersion: null },
    ]);
  });

  test("refuses when schema_migrations has no compat column at all", async () => {
    // "A database older than §8.2's migration" must not read as "every row is
    // NULL, which happens to refuse" — the distinction is what an operator
    // needs to see in the message.
    await expect(readLedgerCompat(sql, (await ledgerNames()).slice(0, 1))).rejects.toThrow("compat");
  });

  test("refuses a requested filename that is not in the ledger", async () => {
    await addCompatColumns();
    await expect(readLedgerCompat(sql, ["9999_not_in_the_ledger.sql"])).rejects.toThrow(
      "9999_not_in_the_ledger.sql",
    );
  });

  test("reads nothing for an empty request", async () => {
    await addCompatColumns();
    expect(await readLedgerCompat(sql, [])).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// checkCompatibility — the §8.4 rule
// ───────────────────────────────────────────────────────────────────────────

describe("checkCompatibility — code at N against a database at M > N", () => {
  test("compatible when there is no surplus at all (M === N)", async () => {
    await addCompatColumns();
    const names = await ledgerNames();
    const verdict = await checkCompatibility(sql, names, names);
    expect(verdict).toEqual({ kind: "compatible", surplus: [] });
  });

  test("compatible when every surplus row is additive with a known metadata_version", async () => {
    await addCompatColumns();
    const names = await ledgerNames();
    const surplus = names.slice(-2);
    await sql`
      UPDATE schema_migrations SET compat = 'additive', metadata_version = ${COMPAT_METADATA_VERSION}
      WHERE name = ANY(${surplus})`;
    expect(await checkCompatibility(sql, names.slice(0, -2), names)).toEqual({ kind: "compatible", surplus });
  });

  test("old code boots after an ADDITIVE change to an existing table", async () => {
    // The §10 W2 gate, in the shape it is written: an `ALTER TABLE ... ADD
    // COLUMN` that is genuinely additive keeps code-only rollback alive.
    await addCompatColumns();
    const names = await ledgerNames();
    await sql.unsafe("ALTER TABLE jobs ADD COLUMN rm_compat_probe text");
    await sql`
      INSERT INTO schema_migrations (name, compat, metadata_version)
      VALUES ('0063_jobs_add_probe.sql', 'additive', ${COMPAT_METADATA_VERSION})`;
    const verdict = await checkCompatibility(sql, names, [...names, "0063_jobs_add_probe.sql"]);
    expect(verdict.kind).toBe("compatible");
    // …and the old code's declared query on that table still works, which is
    // what `additive` actually promises (§8.4: "every query the older registry
    // declares still succeeds with the same semantics").
    const [row] = await sql<{ count: number }[]>`SELECT COUNT(*)::int AS count FROM jobs`;
    expect(row?.count).toBeGreaterThanOrEqual(0);
  });

  test("refuses a surplus row declared `breaking`, naming the file and the condition", async () => {
    await addCompatColumns();
    const names = await ledgerNames();
    const surplus = names[names.length - 1] ?? "";
    await sql`
      UPDATE schema_migrations SET compat = 'breaking', metadata_version = ${COMPAT_METADATA_VERSION}
      WHERE name = ${surplus}`;
    const verdict = await checkCompatibility(sql, names.slice(0, -1), names);
    expect(verdict.kind).toBe("refused");
    if (verdict.kind === "refused") {
      expect(verdict.reasons).toHaveLength(1);
      expect(verdict.reasons[0]).toContain(surplus);
      expect(verdict.reasons[0]).toContain("breaking");
    }
  });

  test("refuses a surplus row with a NULL compat — `unknown` is not `probably fine`", async () => {
    // A NULL means the row was written by a runner predating these columns, or
    // by something that was not the runner at all:
    // scripts/ops/provision-db-role-taxonomy.sh applied 0053 and 0062 through
    // psql without recording them, which is how production's ledger drifted.
    await addCompatColumns();
    const names = await ledgerNames();
    const surplus = names[names.length - 1] ?? "";
    const verdict = await checkCompatibility(sql, names.slice(0, -1), names);
    expect(verdict.kind).toBe("refused");
    if (verdict.kind === "refused") {
      expect(verdict.reasons[0]).toContain(surplus);
      expect(verdict.reasons[0]).toMatch(/NULL/i);
    }
  });

  test("an old release refuses a metadata_version a newer one wrote and it does not understand", async () => {
    await addCompatColumns();
    const names = await ledgerNames();
    const surplus = names[names.length - 1] ?? "";
    await sql`
      UPDATE schema_migrations SET compat = 'additive', metadata_version = ${COMPAT_METADATA_VERSION + 1}
      WHERE name = ${surplus}`;
    const verdict = await checkCompatibility(sql, names.slice(0, -1), names);
    expect(verdict.kind).toBe("refused");
    if (verdict.kind === "refused") {
      expect(verdict.reasons[0]).toContain(surplus);
      expect(verdict.reasons[0]).toContain(String(COMPAT_METADATA_VERSION + 1));
    }
  });

  test("refuses a metadata_version below 1 — no release ever wrote version 0", async () => {
    await addCompatColumns();
    const names = await ledgerNames();
    const surplus = names[names.length - 1] ?? "";
    await sql`UPDATE schema_migrations SET compat = 'additive', metadata_version = 0 WHERE name = ${surplus}`;
    const verdict = await checkCompatibility(sql, names.slice(0, -1), names);
    expect(verdict.kind).toBe("refused");
    if (verdict.kind === "refused") {
      expect(verdict.reasons[0]).toContain(surplus);
      expect(verdict.reasons[0]).toContain("metadata_version 0");
    }
  });

  test("names every offending row at once, not the first", async () => {
    await addCompatColumns();
    const names = await ledgerNames();
    const surplus = names.slice(-3);
    await sql`UPDATE schema_migrations SET compat = 'breaking', metadata_version = 1 WHERE name = ${surplus[0] ?? ""}`;
    await sql`UPDATE schema_migrations SET compat = 'additive', metadata_version = 99 WHERE name = ${surplus[1] ?? ""}`;
    // surplus[2] stays NULL.
    const verdict = await checkCompatibility(sql, names.slice(0, -3), names);
    expect(verdict.kind).toBe("refused");
    if (verdict.kind === "refused") expect(verdict.reasons).toHaveLength(3);
  });

  test("the surplus is a FILENAME set difference, so the two 0059s are never treated as one version", async () => {
    await addCompatColumns();
    const names = await ledgerNames();
    const swarm0059 = "0059_swarm_framework_subject_snapshot_cleanup.sql";
    const analytics0059 = "0059_analytics_output_and_report_snapshots.sql";
    expect(names).toContain(swarm0059);
    expect(names).toContain(analytics0059);

    await sql`
      UPDATE schema_migrations SET compat = 'additive', metadata_version = ${COMPAT_METADATA_VERSION}
      WHERE name = ${swarm0059}`;
    const codeFilenames = names.filter((n) => n !== swarm0059);
    expect(await checkCompatibility(sql, codeFilenames, names)).toEqual({
      kind: "compatible",
      surplus: [swarm0059],
    });
  });

  test("THROWS when the code is ahead of the database — that question is unanswerable, not a refusal", async () => {
    await addCompatColumns();
    const names = await ledgerNames();
    await expect(checkCompatibility(sql, [...names, "0063_code_only.sql"], names)).rejects.toThrow(
      "0063_code_only.sql",
    );
  });

  test("THROWS when readLedgerCompat refused — a missing compat column is not `the code is too old`", async () => {
    const names = await ledgerNames();
    await expect(checkCompatibility(sql, names.slice(0, -1), names)).rejects.toThrow("compat");
  });

  test("genuine drift on the same database is NOT this function's pass/fail — check 3a owns it", async () => {
    // The §10 W2 gate pairs the two: old code boots after an additive change
    // WHILE genuine drift on the same database still fails. 3b must stay green
    // on drift so that 3a's refusal is the one the operator reads.
    await addCompatColumns();
    const names = await ledgerNames();
    await sql.unsafe("DROP TRIGGER IF EXISTS swarm_members_append_only ON swarm_members");
    expect(await checkCompatibility(sql, names, names)).toEqual({ kind: "compatible", surplus: [] });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// recordMigrationCompat
// ───────────────────────────────────────────────────────────────────────────

describe("recordMigrationCompat — the declaration commits with the DDL, never after it", () => {
  test("writes compat and metadata_version onto the migration's own ledger row", async () => {
    await addCompatColumns();
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE rm_owner");
      await tx`INSERT INTO schema_migrations (name) VALUES ('0063_probe.sql')`;
      await recordMigrationCompat(tx, {
        filename: "0063_probe.sql",
        compat: "additive",
        metadataVersion: COMPAT_METADATA_VERSION,
      });
    });
    const [row] = await sql<{ compat: string; metadata_version: number }[]>`
      SELECT compat, metadata_version FROM schema_migrations WHERE name = '0063_probe.sql'`;
    expect(row).toEqual({ compat: "additive", metadata_version: COMPAT_METADATA_VERSION });
  });

  test("a rolled-back migration leaves NO ledger row and no declaration behind", async () => {
    // Writing the declaration separately would produce a NULL compat between
    // two commits, and §8.4 says a NULL refuses — a crash in that window would
    // make the database permanently unbootable by older code for no reason
    // other than the write order.
    await addCompatColumns();
    let caught: unknown;
    await sql
      .begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE rm_owner");
        await tx`INSERT INTO schema_migrations (name) VALUES ('0064_rolled_back.sql')`;
        await recordMigrationCompat(tx, {
          filename: "0064_rolled_back.sql",
          compat: "additive",
          metadataVersion: COMPAT_METADATA_VERSION,
        });
        // Visible inside the transaction, and only there.
        const [inside] = await tx<{ compat: string }[]>`
          SELECT compat FROM schema_migrations WHERE name = '0064_rolled_back.sql'`;
        expect(inside?.compat).toBe("additive");
        throw new Error("simulated failure after the declaration was recorded");
      })
      .catch((error: unknown) => {
        caught = error;
      });
    // The run got as far as the simulated failure — not as far as a stub.
    expect((caught as Error | undefined)?.message).toBe("simulated failure after the declaration was recorded");
    const rows = await sql`SELECT name FROM schema_migrations WHERE name = '0064_rolled_back.sql'`;
    expect(rows).toHaveLength(0);
  });

  test("refuses when the effective role is not rm_owner — compat is a trusted input", async () => {
    await addCompatColumns();
    await sql`INSERT INTO schema_migrations (name) VALUES ('0065_not_owner.sql')`;
    await expect(
      recordMigrationCompat(sql, {
        filename: "0065_not_owner.sql",
        compat: "additive",
        metadataVersion: COMPAT_METADATA_VERSION,
      }),
    ).rejects.toThrow("rm_owner");
  });

  test("refuses to revise a row that already carries a non-NULL compat", async () => {
    // schema_migrations is append-only, and a declaration that could be revised
    // after the fact is not evidence of anything.
    await addCompatColumns();
    await sql`
      INSERT INTO schema_migrations (name, compat, metadata_version)
      VALUES ('0066_already_declared.sql', 'breaking', ${COMPAT_METADATA_VERSION})`;
    await expect(
      sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE rm_owner");
        await recordMigrationCompat(tx, {
          filename: "0066_already_declared.sql",
          compat: "additive",
          metadataVersion: COMPAT_METADATA_VERSION,
        });
      }),
    ).rejects.toThrow("0066_already_declared.sql");
  });
});
