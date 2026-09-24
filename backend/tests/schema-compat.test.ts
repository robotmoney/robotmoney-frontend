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
import postgres from "postgres";
import { config } from "../src/config.ts";
import { sql } from "../src/db/client.ts";
import {
  checkSchemaCompatibility,
  checkSchemaIntegrity,
  type PreflightContext,
  type PreflightFinding,
} from "../src/db/preflight.ts";
import {
  MANIFEST_FORMAT_VERSION,
  fingerprintCatalog,
  hashManifest,
  serializeDeclaration,
  writeManifest,
} from "../src/db/schema-manifest.ts";
import { bootstrapBlankDatabase, loadSnapshot } from "../src/db/schema-snapshot.ts";
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

/** Every migration at or below the 0063 baseline that has no compat header,
 *  as of D53 (2026-09-24). Closed: see the test that pins it. */
const PRE_COMPAT_HEADERLESS: string[] = [
  "0001_backends.sql",
  "0002_dashboards.sql",
  "0003_task_queue.sql",
  "0004_committee.sql",
  "0005_job_schedules_seed.sql",
  "0006_committee_reconcile.sql",
  "0007_committee_rls_stub.sql",
  "0008_committee_memos.sql",
  "0009_analytics_v2.sql",
  "0010_backtest_correlations.sql",
  "0011_regime_dashboard_extras.sql",
  "0012_vault_share_price_history.sql",
  "0013_projects.sql",
  "0014_projects_pipelines.sql",
  "0014_wallet_balance_samples.sql",
  "0015_buyback_swaps.sql",
  "0016_worker_role.sql",
  "0017_admin_surface.sql",
  "0018_research_telemetry.sql",
  "0019_committee_self_serve_claim.sql",
  "0020_committee_agent_health.sql",
  "0021_chain_indexer_samples.sql",
  "0021_committee_waitlist.sql",
  "0022_committee_application_received_notification.sql",
  "0022_committee_session_convened_at.sql",
  "0023_agent_activity_log.sql",
  "0023_analytics_submissions.sql",
  "0023_list2_leaderboard.sql",
  "0024_analytics_provenance_source.sql",
  "0025_swarm_rename.sql",
  "0026_swarm_sessions_legacy_takes.sql",
  "0027_drop_swarm_sessions_legacy_takes.sql",
  "0028_admin_credential.sql",
  "0028_swarm_briefs_session_key.sql",
  "0028_swarm_take_revisions.sql",
  "0029_admin_auth_recovery.sql",
  "0029_admin_passkey.sql",
  "0030_swarm_member_handle.sql",
  "0031_swarm_member_handle_namespace.sql",
  "0032_append_only_history.sql",
  "0032_wallet_balance_samples_strategy_nav_idle_only.sql",
  "0033_swarm_member_uuid_ids.sql",
  "0033_wallet_backfill.sql",
  "0034_job_schedules_catchup_policy.sql",
  "0035_swarm_member_avatar_bytes.sql",
  "0036_quarantine_backfilled_samples.sql",
  "0037_aum_repairable_quarantine.sql",
  "0038_wallet_aum_snapshot_foundation.sql",
  "0039_swarm_judge.sql",
  "0040_swarm_judgements_append_only.sql",
  "0041_swarm_judgement_soak_record.sql",
  "0042_swarm_consensus_receipts.sql",
  "0043_swarm_member_judges.sql",
  "0044_wallet_backfill_leg_terminal.sql",
  "0045_chain_address_floors.sql",
  "0046_asset_prices.sql",
  "0047_swarm_session_subject_name_backfill.sql",
  "0048_swarm_judge_third_party_flag.sql",
  "0049_swarm_recommendations_signing_key.sql",
  "0050_swarm_member_keys_append_only.sql",
  "0051_swarm_vault_recommendation_type_repair.sql",
  "0052_swarm_judgement_digest_scheme.sql",
  "0054_rm_worker_allowlist.sql",
  "0055_swarm_recommendations_member_received_idx.sql",
  "0056_analytics_overwrite_events.sql",
  "0056_swarm_judge_requires_model.sql",
  "0057_source_acquisition_ledger.sql",
  "0057_swarm_judge_policy_stamp.sql",
  "0058_analytics_run_ledger.sql",
  "0058_swarm_judge_fault_injection.sql",
  "0059_analytics_output_and_report_snapshots.sql",
  "0059_swarm_framework_subject_snapshot_cleanup.sql",
  "0059_swarm_judgement_completion_usage.sql",
  "0060_analytics_ledger_cutover.sql",
  "0061_rm_worker_wallet_backfill_grant.sql",
  "0061_source_value_provenance.sql",
  "0062_rm_readonly_sequence_select.sql",
  "0062_rm_worker_analytics_ledger_read_grant.sql",
  "0063_deployment_identity.sql",
];

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

  test("the header-less set at or below 0063 is CLOSED: a new low-numbered file cannot skip the header", async () => {
    // The baseline is a number, and this repo already repeats numbers (two or
    // three files each at 0021-0023, 0028-0029, 0032-0033, 0056-0062). A new
    // header-less `0059_x.sql` would therefore pass `parsePendingHeader` for
    // ever, and the "above 0063" test cannot see it. So the exact set of
    // pre-compat files that carry no header is pinned here: today's list, no
    // more. A new migration takes a number above 0063 and declares itself.
    const headerless = (await migrations())
      .filter(({ file, text }) => !requiresCompatHeader(file) && parsePendingHeader(file, text) === null)
      .map((m) => m.file);
    expect(headerless).toEqual(PRE_COMPAT_HEADERLESS);
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

  test("an ADDITIVE surplus row is compatible — the 3b half of the §10 W2 gate", async () => {
    // The ledger half only. Whether the database itself is intact is 3a's
    // question, answered against the manifest in the "old code at N against a
    // database at N + additive" case below — never by a row count, which a
    // DROP COLUMN would pass just as well.
    await addCompatColumns();
    const names = await ledgerNames();
    await sql.unsafe("ALTER TABLE jobs ADD COLUMN rm_compat_probe text");
    await sql`
      INSERT INTO schema_migrations (name, compat, metadata_version)
      VALUES ('0063_jobs_add_probe.sql', 'additive', ${COMPAT_METADATA_VERSION})`;
    const verdict = await checkCompatibility(sql, names, [...names, "0063_jobs_add_probe.sql"]);
    expect(verdict).toEqual({ kind: "compatible", surplus: ["0063_jobs_add_probe.sql"] });
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

// ───────────────────────────────────────────────────────────────────────────
// The §10 W2 gate: old code at N, a database at N + additive, and drift
// ───────────────────────────────────────────────────────────────────────────
//
// "Old code boots after an additive change to an existing table while genuine
// drift on the same database still fails." A boot's schema verdict is preflight
// check 3: (a) the live catalog against the manifest STORED IN THE DATABASE,
// (b) the ledger surplus against the booting code's filename list. So this runs
// both, on ONE database that carries a real manifest: a snapshot bootstrap
// (version N), then an additive migration committed the way the migrate run
// commits one and the manifest for the new version M published by the real
// writer, then genuine drift.
//
// What this does NOT prove: that a container boots. Nothing calls
// `runPreflight` at container startup yet (criterion 44's wiring wave); this is
// the verdict such a boot would reach.

/** A URL for `database` on the suite's server, as the harness superuser. */
function databaseUrl(database: string): string {
  const url = new URL(config.databaseUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

/** A blank database owned by rm_owner, bootstrapped from the REAL snapshot
 *  (pgcrypto installed first, as the provider's half), handed to `body` as the
 *  harness superuser and dropped afterwards. */
async function withSnapshotDatabase(
  body: (db: postgres.Sql<{}>, snapshot: Awaited<ReturnType<typeof loadSnapshot>>) => Promise<void>,
): Promise<void> {
  const snapshot = await loadSnapshot();
  const name = `rmt_compat_snapshot_${crypto.randomUUID().slice(0, 8)}`;
  const admin = postgres(databaseUrl("postgres"), { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE ${name} OWNER rm_owner`);
    const db = postgres(databaseUrl(name), { max: 1, onnotice: () => {} });
    try {
      await db.unsafe("CREATE EXTENSION IF NOT EXISTS pgcrypto");
      await db.unsafe("SET ROLE rm_owner");
      await bootstrapBlankDatabase(db, snapshot);
      await db.unsafe("RESET ROLE");
      await body(db, snapshot);
    } finally {
      await db.end({ timeout: 5 });
    }
  } finally {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end({ timeout: 5 });
  }
}

/** Checks 3a and 3b together, for code shipping `codeFilenames`: their
 *  refusal sentences, per check. */
async function checkThree(
  db: postgres.Sql<{}>,
  codeFilenames: readonly string[],
): Promise<{ integrity: string[]; compatibility: string[] }> {
  const context: PreflightContext = {
    env: "stage",
    connection: "local",
    roles: ["rm_app"],
    codeFilenames,
    envFilePath: "/nonexistent/unused.env",
  };
  const refusalsOf = (findings: readonly PreflightFinding[]) =>
    findings.filter((f) => f.severity === "refuse").map((f) => f.message);
  return {
    integrity: refusalsOf((await checkSchemaIntegrity(db, context)).findings),
    compatibility: refusalsOf((await checkSchemaCompatibility(db, context)).findings),
  };
}

describe("old code at N against a database at N + additive — and genuine drift on the same database", () => {
  test("old code passes 3a and 3b after an additive column; dropping a column then fails 3a, naming it", async () => {
    await withSnapshotDatabase(async (db, snapshot) => {
      const shippedByOldCode = snapshot.filenames;

      // Version N, as bootstrapped: the old code's own version passes.
      expect(await checkThree(db, shippedByOldCode)).toEqual({ integrity: [], compatibility: [] });

      // A NEWER release's migrate run: one additive migration, committed with
      // its declaration in its own transaction (migrate-run.ts step 5)…
      const file = "9999_job_schedules_add_note.sql";
      const ddl = [
        "-- compat: additive",
        `-- metadata_version: ${COMPAT_METADATA_VERSION}`,
        "ALTER TABLE job_schedules ADD COLUMN operator_note text;",
        "",
      ].join("\n");
      await db.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE rm_owner");
        await tx.unsafe(ddl);
        await tx`INSERT INTO schema_migrations (name) VALUES (${file})`;
        await recordMigrationCompat(tx, parseMigrationHeader(file, ddl));
      });
      // …then the manifest for the final state M, published by the real writer
      // in the reconciliation transaction (step 6). M's declaration is what the
      // newer release's snapshot would carry: its SQL, the same exclusion list,
      // and the fingerprint of the catalog that SQL produces.
      const declaration = serializeDeclaration({
        sql: `${snapshot.declarationSql}\n${ddl}`,
        exclusions: snapshot.exclusions,
        fingerprint: await fingerprintCatalog(db, snapshot.exclusions),
      });
      expect(JSON.parse(declaration.text).fingerprint["column public.job_schedules.operator_note"]).toEqual({
        type: "text",
        notnull: "no",
      });
      await db.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE rm_owner");
        const filenames = [...shippedByOldCode, file];
        await writeManifest(tx, {
          formatVersion: MANIFEST_FORMAT_VERSION,
          declaration,
          filenames,
          contentHash: hashManifest(declaration, filenames),
        });
      });

      // OLD CODE BOOTS: 3a compares against M's manifest, which includes the
      // column; 3b reads the migration's recorded declaration (spec §7 check 3).
      expect(await checkThree(db, shippedByOldCode)).toEqual({ integrity: [], compatibility: [] });

      // GENUINE DRIFT on the same database, for the same old code: a column
      // M declares is gone. 3a refuses and names it; 3b still passes, so 3a's
      // refusal is the one the operator reads.
      await db.unsafe("ALTER TABLE job_schedules DROP COLUMN last_enqueued_at");
      const drifted = await checkThree(db, shippedByOldCode);
      expect(drifted.compatibility).toEqual([]);
      expect(drifted.integrity).toEqual([
        "column public.job_schedules.last_enqueued_at is declared by the installed manifest but absent from the live catalog",
      ]);
    });
  });

  test("RED CONTROL: without M's manifest the additive column is not silently accepted — the database reads as in progress", async () => {
    // The pass above depends on the manifest describing M. The same ledger with
    // N's manifest still installed is §8.3's in-progress state, and 3a refuses
    // it: an additive migration nobody finished publishing is not a version.
    await withSnapshotDatabase(async (db, snapshot) => {
      const file = "9999_job_schedules_add_note.sql";
      const ddl = `-- compat: additive\n-- metadata_version: ${COMPAT_METADATA_VERSION}\nALTER TABLE job_schedules ADD COLUMN operator_note text;\n`;
      await db.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE rm_owner");
        await tx.unsafe(ddl);
        await tx`INSERT INTO schema_migrations (name) VALUES (${file})`;
        await recordMigrationCompat(tx, parseMigrationHeader(file, ddl));
      });
      const verdict = await checkThree(db, snapshot.filenames);
      expect(verdict.compatibility).toEqual([]);
      expect(verdict.integrity).toHaveLength(1);
      expect(verdict.integrity[0]).toContain("in progress");
      expect(verdict.integrity[0]).toContain(file);
    });
  });
});
