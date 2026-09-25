// Snapshot N + migrations = snapshot N+1 — the second of spec §8.4's CI proofs
// (smoke-production-spec.md §8.4, issue #1026 criterion 50).
//
// WHAT THIS PROVES THAT schema-equivalence.test.ts DOES NOT. That file builds
// one side by replaying EVERY migration from 0001 on an empty database, which
// is how no deployed database ever reaches the current version: a database
// that was bootstrapped from an earlier snapshot (every `--local blank`
// rehearsal, every CI boot, and every database created since the snapshot
// existed) reaches it by applying only the migrations above that snapshot's
// filename list, onto objects the SNAPSHOT created. If a migration relies on
// something only the migration history left behind (a default privilege, an
// object a later snapshot edit dropped, a comment), the replay passes and the
// snapshot path breaks. This file runs the snapshot path.
//
// THE TWO SIDES:
//
//   advanced — an empty database owned by rm_owner, bootstrapped by
//              `bootstrapBlankDatabase` from a PINNED earlier snapshot
//              (tests/fixtures/snapshots/<last>/, the snapshot N), then given
//              the REAL migrate run (`runMigrate`, §8.3) against this
//              checkout's backend/migrations/ and backend/schema/: every
//              migration above N is applied, grants are reconciled, the
//              manifest is published.
//   current  — an empty database owned by rm_owner, bootstrapped from
//              backend/schema/ (snapshot N+1).
//
// They must be EQUAL, by the same normalized catalog schema-equivalence.test.ts
// uses (tests/support/catalog-normalize.ts) and by check 3a's own fingerprint
// comparison (`compareCatalog`, src/db/schema-manifest.ts), and the manifest
// the run published must be the one the current snapshot publishes.
//
// THE FIXTURE. No release tag carries backend/schema/ (v0.5.0 predates it), so
// snapshot N is pinned in the repository: the files of the last commit whose
// snapshot ended at the fixture's `last` migration, byte for byte, each
// sha256-pinned in fixture.json the way tests/fixtures/releases/ pins a
// release's migrations. How the fixture advances when a release ships is spec
// §8.4's rule (the paragraph "Snapshot N").
//
// RECORDED, NOT HIDDEN. Snapshot N was written before cause F of
// schema-equivalence.test.ts was fixed, so it carries none of the COMMENT ON
// statements the migrations at or below N declare, and no later migration
// re-declares them. Those comments are the one recorded difference below, as
// an exact list, held to the same two rules: every difference is recorded, and
// every recorded entry still occurs. The list empties when the fixture next
// advances (to a snapshot that carries its comments) and never grows: a
// migration above N that declares a comment the current snapshot lacks, or the
// reverse, is unrecorded and fails.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type postgres from "postgres";
import { compareCatalog } from "../src/db/schema-manifest.ts";
import { bootstrapBlankDatabase, loadSnapshot, type Snapshot } from "../src/db/schema-snapshot.ts";
import type { MigrateRunResult } from "../scripts/migrate-run.ts";
import { describeCatalogDiff, diffCatalogs, normalizedCatalog, type CatalogDiff, type CatalogEntry } from "./support/catalog-normalize.ts";
import { FIXTURE_N as FIXTURE, ScratchDatabases } from "./support/snapshot-fixture.ts";

const MIGRATIONS = join(import.meta.dir, "..", "migrations");

interface FixtureRecord {
  readonly last: string;
  readonly commit: string;
  readonly files: readonly { readonly file: string; readonly sha256: string }[];
}
const fixture = JSON.parse(readFileSync(join(FIXTURE, "fixture.json"), "utf8")) as FixtureRecord;
const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

/**
 * The comments snapshot N lacks, by the object each is on. Every one was
 * declared by a migration at or below N; the current snapshot carries all of
 * them (schema-equivalence.test.ts, cause F closed). Shrink-only, and empty
 * once the fixture advances past wave 4 of #1026.
 */
const COMMENTS_SNAPSHOT_N_LACKS: readonly string[] = [
  "pg_class public.analytics_data_vintages",
  "pg_class public.analytics_ledger_runs",
  "pg_class public.analytics_overwrite_events",
  "pg_class public.analytics_parity_observations",
  "pg_class public.analytics_read_mode",
  "pg_class public.analytics_report_snapshots",
  "pg_class public.automation_tokens",
  "pg_class public.automation_tokens.holder",
  "pg_class public.automation_tokens.instance",
  "pg_class public.automation_tokens.rights",
  "pg_class public.deployment_identity",
  "pg_class public.schema_manifest",
  "pg_class public.schema_migrations.compat",
  "pg_class public.schema_migrations.metadata_version",
  "pg_class public.source_value_versions",
  "pg_class public.source_value_versions.provenance",
  "pg_class public.swarm_brief_revisions",
  "pg_class public.swarm_briefs.report_snapshot_id",
  "pg_class public.swarm_consensus_receipts",
  "pg_class public.swarm_judge_config.third_party_enabled",
  "pg_class public.swarm_judge_fault_injection",
  "pg_class public.swarm_member_keys",
  "pg_class public.swarm_members.role",
  "pg_class public.swarm_recommendations.final",
  "pg_class public.swarm_recommendations.report_snapshot_id",
  "pg_class public.swarm_recommendations.signing_key_id",
  "pg_class public.swarm_session_judgements",
  "pg_class public.swarm_session_judgements.applied",
  "pg_class public.swarm_session_judgements.applied_skipped_reason",
  "pg_class public.swarm_session_judgements.digest_scheme",
  "pg_class public.swarm_session_judgements.dropped_disagreements",
  "pg_class public.swarm_session_judgements.dropped_positions",
  "pg_class public.swarm_session_judgements.judged_by",
  "pg_class public.swarm_session_judgements.usage_cost_usd",
  "pg_class public.swarm_sessions.consensus_recorded_at",
  "pg_class public.swarm_sessions.judge_mode",
  "pg_class public.swarm_sessions.judging_deadline_at",
  "pg_class public.swarm_sessions.judging_duration_seconds",
  "pg_class public.swarm_sessions.judging_outcome",
  "pg_class public.swarm_sessions.successor_session_id",
  "pg_class public.swarm_subjects.epoch_anchor",
  "pg_class public.swarm_subjects.epoch_duration_seconds",
  "pg_class public.swarm_subjects.judging_duration_seconds",
  "pg_class public.wallet_aum_snapshot_runs",
  "pg_class public.wallet_aum_snapshot_runs.producer_revision",
  "pg_class public.wallet_balance_sample_evidence",
  "pg_class public.wallet_balance_samples.snapshot_run_id",
  "pg_class public.wallet_balance_samples.strategy_nav_idle_only",
  "pg_class public.wallet_sleeve_sample_evidence",
  "pg_class public.wallet_sleeve_samples.snapshot_run_id",
  "pg_constraint public.swarm_judge_config.swarm_judge_config_mode_requires_model_check",
  "pg_proc public.rm_append_only_guard()",
];

const suffix = crypto.randomUUID().slice(0, 8);
const dbs = new ScratchDatabases();
let scratch = "";

let snapshotN: Snapshot;
let current: Snapshot;
let advanced: postgres.Sql<{}>;
let currentDb: postgres.Sql<{}>;
let run: MigrateRunResult;
let advancedCatalog: CatalogEntry[] = [];
let currentCatalog: CatalogEntry[] = [];

/** Bootstrap snapshot N into `name` and run the real migrate on it, with the
 *  given migrations directory (backend/migrations/ unless a test plants one). */
async function advance(name: string, migrationsDir?: string): Promise<{ db: postgres.Sql<{}>; run: MigrateRunResult }> {
  const db = await dbs.atSnapshotN(name, snapshotN);
  const result = await dbs.migrate(db, name, migrationsDir ? { migrationsDir } : {});
  return { db, run: result };
}

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), "rm-snapshot-advance-"));
  current = await loadSnapshot();
  snapshotN = await dbs.snapshotN();

  ({ db: advanced, run } = await advance(`rm_advance_n1_${suffix}`));
  await advanced.unsafe("RESET ROLE");

  currentDb = await dbs.blank(`rm_advance_cur_${suffix}`);
  await bootstrapBlankDatabase(currentDb, current);
  await currentDb.unsafe("RESET ROLE");

  advancedCatalog = await normalizedCatalog(advanced);
  currentCatalog = await normalizedCatalog(currentDb);
}, 180_000);

afterAll(async () => {
  await dbs.dropAll();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

/** What the recorded comments leave unexplained, and which were used. */
function explain(diff: CatalogDiff): { unexplained: string[]; used: Set<string> } {
  const used = new Set<string>();
  const unexplained: string[] = [];
  for (const entry of diff.onlyRight) {
    const object = entry.key.replace(/^comment on /, "");
    if (entry.key.startsWith("comment on ") && COMMENTS_SNAPSHOT_N_LACKS.includes(object)) {
      used.add(object);
      continue;
    }
    unexplained.push(`only in snapshot N+1: ${entry.key}`);
  }
  for (const entry of diff.onlyLeft) unexplained.push(`only in snapshot N + migrations: ${entry.key}`);
  for (const entry of diff.differing) unexplained.push(`differs: ${entry.key}`);
  return { unexplained, used };
}

describe("snapshot N + migrations = snapshot N+1 (spec §8.4)", () => {
  test("the fixture is snapshot N byte for byte: every file matches its sha256 pin", () => {
    const onDisk = (readdirSync(join(FIXTURE, "schema")) as string[]).map((f) => `schema/${f}`).sort();
    expect(onDisk).toEqual(fixture.files.map((f) => f.file).sort());
    const drifted = fixture.files
      .filter(({ file, sha256: pinned }) => sha256(readFileSync(join(FIXTURE, file))) !== pinned)
      .map(({ file }) => file);
    expect(drifted).toEqual([]);
    expect(fixture.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  test("snapshot N's list is a strict prefix of this checkout's, ending at the fixture's `last`", () => {
    expect(snapshotN.filenames.at(-1)).toBe(fixture.last);
    expect(current.filenames.slice(0, snapshotN.filenames.length)).toEqual([...snapshotN.filenames]);
    expect(current.filenames.length).toBeGreaterThan(snapshotN.filenames.length);
  });

  test("the real migrate run applied exactly the migrations above N, in order, and published", () => {
    expect(run.applied).toEqual(current.filenames.slice(snapshotN.filenames.length));
    expect(run.baselined).toBe(false);
    expect(run.manifest.filenames).toEqual([...current.filenames]);
  });

  test("the manifest the run published is the one snapshot N+1 publishes at bootstrap", async () => {
    const read = async (db: postgres.Sql<{}>) =>
      (await db.unsafe("SELECT content_hash, filenames FROM schema_manifest")) as unknown as {
        content_hash: string;
        filenames: string[];
      }[];
    const [advancedRow] = await read(advanced);
    const [currentRow] = await read(currentDb);
    expect(advancedRow?.content_hash).toBe(current.manifest.contentHash);
    expect(currentRow?.content_hash).toBe(current.manifest.contentHash);
    expect(advancedRow?.filenames).toEqual(currentRow?.filenames);
  });

  test("both sides were really read — a comparison of two empty lists proves nothing", () => {
    for (const catalog of [advancedCatalog, currentCatalog]) {
      expect(catalog.filter((e) => e.key.startsWith("table public.")).length).toBeGreaterThan(50);
      expect(catalog.filter((e) => e.key.startsWith("acl relation public.")).length).toBeGreaterThan(50);
      expect(catalog.filter((e) => e.key.startsWith("trigger public.")).length).toBeGreaterThan(20);
    }
  });

  test("every object snapshot N+1 declares, snapshot N + migrations declares identically — except the recorded comments", () => {
    const { unexplained } = explain(diffCatalogs(advancedCatalog, currentCatalog));
    if (unexplained.length > 0) {
      throw new Error(
        `snapshot N + migrations differs from snapshot N+1 in ${unexplained.length} object(s) — fix the migration or ` +
          `the snapshot edit that landed with it (§8.2):\n` +
          describeCatalogDiff(diffCatalogs(advancedCatalog, currentCatalog), "snapshot N + migrations", "snapshot N+1").join("\n"),
      );
    }
    expect(unexplained).toEqual([]);
  });

  test("every recorded comment still occurs — a fixed entry is deleted", () => {
    const { used } = explain(diffCatalogs(advancedCatalog, currentCatalog));
    expect(COMMENTS_SNAPSHOT_N_LACKS.filter((object) => !used.has(object))).toEqual([]);
  });

  test("check 3a's own comparison agrees: the advanced database matches snapshot N+1's fingerprint", async () => {
    expect(await compareCatalog(advanced, current)).toEqual([]);
  });

  test("RED CONTROL: a migration above N that disagrees with the snapshot edit it landed with fails, naming the object", async () => {
    // A planted copy of backend/migrations/ in which 0084 forgets
    // admin_passkey.revoked_at, while the snapshot (N+1) still declares it:
    // exactly "a migration landed with a snapshot edit that is merely
    // plausible". The real run applies it; the comparison must name the column
    // and its comment, and nothing the plant did not touch.
    const dir = mkdtempSync(join(scratch, "planted-"));
    for (const name of readdirSync(MIGRATIONS)) copyFileSync(join(MIGRATIONS, name), join(dir, name));
    const target = join(dir, "0084_admin_revocation_tombstones.sql");
    const original = readFileSync(target, "utf8");
    const planted = original
      .replace("ALTER TABLE admin_passkey ADD COLUMN revoked_at timestamptz;\n", "")
      .replace(/COMMENT ON COLUMN admin_passkey\.revoked_at IS\n[^\n]*\n/, "");
    expect(planted).not.toBe(original);
    await Bun.write(target, planted);

    const { db, run: plantedRun } = await advance(`rm_advance_red_${suffix}`, dir);
    await db.unsafe("RESET ROLE");
    expect(plantedRun.applied).toContain("0084_admin_revocation_tombstones.sql");
    const { unexplained } = explain(diffCatalogs(await normalizedCatalog(db), currentCatalog));
    expect(unexplained.sort()).toEqual([
      "only in snapshot N+1: column public.admin_passkey.revoked_at",
      "only in snapshot N+1: comment on pg_class public.admin_passkey.revoked_at",
    ]);
    // And check 3a's reading refuses the same database.
    expect((await compareCatalog(db, current)).join("\n")).toContain("admin_passkey");
  });
});
