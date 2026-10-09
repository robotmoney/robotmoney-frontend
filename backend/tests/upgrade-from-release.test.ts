// An upgrade from a populated database of each supported release passes its
// data assertions; code at N boots against N+additive — two of spec §8.4's CI
// proofs (smoke-production-spec.md §8.4, issue #1026 criterion 50).
//
// ─────────────────────────────────────────────────────────────────────────────
// WHICH RELEASES, AND WHERE THEIR SCHEMA COMES FROM
// ─────────────────────────────────────────────────────────────────────────────
//
// PRE_IDENTITY_RELEASES (backend/src/db/supported-releases.ts) is one baseline:
// production's observed ledger, read 2026-10-01 — the 72 files of v0.5.0 plus
// four: 0062_rm_readonly_sequence_select.sql (applied out of band from the
// archived 0.5.x line on 2026-09-22), 0061_rm_worker_wallet_backfill_grant.sql
// and 0063_swarm_judge_model_default.sql (v0.5.1) and
// 0080_analytics_ledger_compaction.sql (v0.5.2); owner-ruled ground truth, D55
// (8), replaced on 2026-10-03 (issue 1097). An upgrade path from anything else
// is one no database will take. That module pins the baseline's filename list; the tests below fail
// when it disagrees with the observed ledger in
// fixtures/releases/production-2026-10-01/baseline.json or with v0.5.0's
// release.json plus the four extra files. Adding a baseline is a new decision,
// one fixture directory and one entry there ONLY for a target built by v0.5.0's runner
// loop (`applyAsReleaseRunner`), which records no compat declaration. A release
// whose own runner recorded compat (anything shipped with 0082's runMigrate)
// also needs that runner modelled here, or its ledger rows above the baseline
// read NULL. What depends on whether the release predates 0081 — the first
// production migrate's exception, the "compat is NULL" boot refusal — is gated
// on it (`predatesIdentity`), not assumed.
//
// A release's schema is rebuilt from its OWN migration bytes by its own runner
// loop (tests/fixtures/releases/release-fixture.ts): a sha256 per file, taken
// from the tag, and a verbatim copy of any file the branch edited after the
// tag — v0.5.0's 0053_database_role_taxonomy.sql is one (it said NOLOGIN for
// rm_owner, the branch says LOGIN). The first test below fails if a file drifts
// from the recorded hash without a verbatim copy, so the release schema cannot
// silently become "whatever the branch says the release was".
//
// NO RELEASE TAG CARRIES A SNAPSHOT. backend/schema/ first appears on this
// branch, so spec §8.4's "snapshot N + migrations = snapshot N+1" has no
// snapshot N to start from. What this file proves in its place is the
// migrations half of it: release N's schema plus the pending migrations equals
// blank + all migrations, object for object. schema-equivalence.test.ts proves
// blank + all migrations equals the snapshot, so the two together tie the
// release to the snapshot through the migrations.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE UPGRADE IS THE OPERATOR'S: THE FIRST PRODUCTION MIGRATE
// ─────────────────────────────────────────────────────────────────────────────
//
// The baseline predates 0081, so its database has no `deployment_identity`
// table and no row to enroll it. The upgrade runs exactly as production's will (spec
// §9.1, D55 (5), D61): `bun run migrate` as a PROCESS with no terminal,
// RM_ENV=prod, `~/.env`'s rm_owner line and the exact `--confirm-target` — the one
// run §4.3 allows without the row, because the ledger equals the baseline's
// filename list exactly. It applies 0081 FIRST, with `production` in 0081's own
// transaction (D55 (9)), then EVERY other pending file in filename order,
// including the pre-compat ones at or below 0081 (their compat stays NULL,
// D53 decision 3), reconciles grants,
// compares the live schema with the snapshot (§9.1 step 2) and publishes the
// first manifest. Nothing is applied around the command. The refusals that
// guard that exception are first-production-migrate.test.ts's subject; the one
// pinned here is that no other caller reaches a release: `--migrate` and a run
// with no confirmation refuse it before applying anything.
//
// Everything asserted about data below is asserted AFTER that real run.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import * as client from "../src/db/client.ts";
import * as epoch from "../src/swarm/epoch.ts";
import * as domain from "../src/swarm/domain.ts";
import { adminConnection, adminUrl, harnessUrl, restoreRoleBaselineAfterAll } from "./support/cluster.ts";
import {
  checkSchemaCompatibility,
  checkSchemaIntegrity,
  type PreflightContext,
} from "../src/db/preflight.ts";
import { COMPAT_HEADER_BASELINE, migrationNumber, parsePendingHeader } from "../src/db/schema-compat.ts";
import { readManifest } from "../src/db/schema-manifest.ts";
import { PRE_IDENTITY_RELEASES } from "../src/db/supported-releases.ts";
import { IDENTITY_MIGRATION, runMigrate, type MigrateGateOptions } from "../scripts/migrate-run.ts";
import {
  HEAD_FILES,
  MIGRATIONS_DIR,
  applyAsReleaseRunner,
  fixtureBytes,
  loadBaseline,
  loadRelease,
  releaseSteps,
  restoreLogins,
  restoreRoles,
  revokeLoginDefaults,
  runMigrateCommand,
  saveRoles,
  type ReleaseFixture,
  type SavedRole,
} from "./fixtures/releases/release-fixture.ts";
import { withTargetLock } from "./support/target-lock.ts";
import { describeCatalogDiff, diffCatalogs, normalizedCatalog } from "./support/catalog-normalize.ts";

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

const OWNER_PASSWORD = randomBytes(18).toString("base64url");
const READONLY_PASSWORD = randomBytes(12).toString("hex");

function urlFor(database: string, role?: { name: string; password: string }): string {
  // The harness login (rm_test_owner: not a superuser, acts as rm_owner) stands
  // in for the provider's admin; a named role logs in as itself.
  const url = new URL(harnessUrl(database));
  if (role) {
    url.username = role.name;
    url.password = encodeURIComponent(role.password);
  }
  return url.toString();
}

function connect(database: string, role?: { name: string; password: string }): postgres.Sql<{}> {
  return postgres(urlFor(database, role), { max: 1, onnotice: () => {} });
}

const MIGRATE_OPTIONS: MigrateGateOptions = {
  caller: "smoke_flag",
  env: "stage",
  connection: "local",
};

/**
 * The migrate run as a tool performs it, for the REFERENCE database (blank +
 * all migrations, which is the snapshot's state, enrolled `rehearsal` as §4.2's
 * restore procedure writes it) and for the refusals: the session IS rm_owner
 * for the whole run (`current_user = rm_owner`), under the §2 target lock, with
 * the harness login's two default ACLs removed first (release-fixture.ts
 * `revokeLoginDefaults`) so a first manifest's §9.1 step 2 baseline passes for
 * the reason production's would.
 */
async function migrateAsOwner(db: postgres.Sql<{}>, database: string, options = MIGRATE_OPTIONS): ReturnType<typeof runMigrate> {
  await db.unsafe("SET ROLE rm_owner");
  try {
    return await withTargetLock(urlFor(database), (lock) => runMigrate(db, { ...options, lock }));
  } finally {
    await db.unsafe("RESET ROLE");
  }
}

/** A query's rows as a plain array, so `toEqual` compares rows and nothing
 *  else the driver hangs on its result list. */
async function rows(query: PromiseLike<readonly postgres.Row[]>): Promise<postgres.Row[]> {
  return [...(await query)];
}

async function enroll(db: postgres.Sql<{}>, kind: "rehearsal" | "production"): Promise<void> {
  await db.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE rm_owner");
    await tx.unsafe(`INSERT INTO deployment_identity (kind) VALUES ('${kind}')`);
  });
}


// ───────────────────────────────────────────────────────────────────────────
// The release's populated data
// ───────────────────────────────────────────────────────────────────────────
//
// Chosen so every data-reshaping migration between v0.5.0 and the branch has
// something to reshape, and so every row it must NOT touch is beside one it
// must: two collecting sessions for one subject (0086 closes the older), a
// member with two revisions of one take (0092 marks the newest final — D51
// keeps both), swarm.* schedule rows and jobs beside a vault one (0089), a
// notification job (0084), a judge enabled with no model (0056), and history
// rows in append-only tables.

/**
 * The swarm.* schedule kinds 0089 says it deletes, parsed from the migration — used ONLY
 * to check the migration against what the release seeded, never to decide what
 * to seed (that would make the data assertion circular: a kind the release
 * seeded and 0089 forgot would be neither seeded nor checked).
 */
function scheduleKindsDeletedBy0089(): string[] {
  const text = readFileSync(join(MIGRATIONS_DIR, "0089_drop_swarm_schedules.sql"), "utf8");
  const list = /DELETE FROM job_schedules\s+WHERE kind IN \(([^)]*)\)/.exec(text)?.[1] ?? "";
  const kinds = [...list.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
  if (kinds.length === 0) throw new Error("0089_drop_swarm_schedules.sql no longer names the schedule kinds it deletes");
  return kinds;
}

const SESSION_PUBLISHED = "00000000-0000-4000-8000-00000000a001";
const SESSION_OLD_OPEN = "00000000-0000-4000-8000-00000000a002";
const SESSION_NEW_OPEN = "00000000-0000-4000-8000-00000000a003";
// In flight on a v0.5.4 database (issue 1111): the cron driver closed, aggregated
// and judged these, and none of them is published. SESSION_OLD_OPEN becomes the
// `window_closed` one (0086 closes the older of two collecting sessions).
const SESSION_AGGREGATED = "00000000-0000-4000-8000-00000000a004";
const SESSION_JUDGED_ENFORCE = "00000000-0000-4000-8000-00000000a005";
const SESSION_JUDGED_SHADOW = "00000000-0000-4000-8000-00000000a006";

/** The release's populated data. Every swarm.* schedule row the release
 *  seeded, and a pending job of every swarm.* kind it could queue, come from
 *  release.json — the release's own record. */
function releaseData(release: ReleaseFixture): string {
  const { scheduleKinds, jobKinds } = release.swarm;
  return `
INSERT INTO swarm_members (id, status, name, handle, role) VALUES
  ('m-alpha', 'active', 'Alpha', 'alpha', 'member'),
  ('m-beta',  'active', 'Beta',  'beta',  'member'),
  ('m-judge', 'active', 'Judge', 'judge-one', 'judge');
INSERT INTO swarm_members (id, status, name, handle, role, operator) VALUES
  ('m-forged',  'active', 'Forged',  'forged',  'member', 'robotmoney'),
  ('m-partner', 'active', 'Partner', 'partner', 'member', 'peaq');
INSERT INTO audit_log (actor, action, scope) VALUES
  ('m-forged',  'update_profile', '{"memberId":"m-forged"}'),
  ('m-partner', 'update_profile', '{"memberId":"m-partner"}'),
  ('admin',     'member_update',  '{"memberId":"m-partner","fields":["operator"]}');
INSERT INTO swarm_subjects (id, name) VALUES ('subj-1', 'Subject One');
INSERT INTO swarm_sessions (id, subject_id, subject_name, state, window_closes_at, convened_at, published_at) VALUES
  ('${SESSION_PUBLISHED}', 'subj-1', 'Subject One', 'published',  '2026-09-01T12:00:00Z', '2026-09-01T11:00:00Z', '2026-09-01T13:00:00Z'),
  ('${SESSION_OLD_OPEN}',  'subj-1', 'Subject One', 'collecting', '2026-09-20T12:00:00Z', '2026-09-20T06:00:00Z', NULL),
  ('${SESSION_NEW_OPEN}',  'subj-1', 'Subject One', 'collecting', '2026-09-21T12:00:00Z', '2026-09-21T06:00:00Z', NULL),
  ('${SESSION_AGGREGATED}', 'subj-1', 'Subject One', 'aggregated', '2026-09-10T12:00:00Z', '2026-09-10T11:00:00Z', NULL),
  ('${SESSION_JUDGED_ENFORCE}', 'subj-1', 'Subject One', 'judged', '2026-09-11T12:00:00Z', '2026-09-11T11:00:00Z', NULL),
  ('${SESSION_JUDGED_SHADOW}', 'subj-1', 'Subject One', 'judged', '2026-09-12T12:00:00Z', '2026-09-12T11:00:00Z', NULL);
INSERT INTO swarm_session_judgements (session_id, mode, source, fallback_reason, prompt_hash, inputs_digest, take_count, min_takes, opinion, created_at) VALUES
  ('${SESSION_JUDGED_ENFORCE}', 'enforce', 'fallback', 'model_unconfigured', 'ph', 'id', 1, 3, '{"rationale":"x"}', '2026-09-11T12:30:00Z'),
  ('${SESSION_JUDGED_SHADOW}',  'shadow',  'fallback', 'model_unconfigured', 'ph', 'id', 1, 3, '{"rationale":"x"}', '2026-09-12T12:30:00Z');
INSERT INTO swarm_recommendations (session_id, member_id, subject_id, date, nonce, stance, payload, signature, verified, revision) VALUES
  ('${SESSION_PUBLISHED}', 'm-alpha', 'subj-1', '2026-09-01', 'n-alpha-1', 'buy',  '{"take":"alpha r1"}', 'sig-alpha-1', true, 1),
  ('${SESSION_PUBLISHED}', 'm-alpha', 'subj-1', '2026-09-01', 'n-alpha-2', 'hold', '{"take":"alpha r2"}', 'sig-alpha-2', true, 2),
  ('${SESSION_PUBLISHED}', 'm-beta',  'subj-1', '2026-09-01', 'n-beta-1',  'sell', '{"take":"beta r1"}',  'sig-beta-1',  true, 1);
INSERT INTO job_schedules (kind, cron, payload, enabled) VALUES
  ('vault.sample_share_price', '0 * * * *',  '{"vault":"v1"}', true),
  ${scheduleKinds.map((kind) => `('${kind}', '0 12 * * *', '{}', true)`).join(",\n  ")};
INSERT INTO jobs (kind, status, payload, dedupe_key) VALUES
  ('vault.sample_share_price', 'pending', '{"vault":"v1"}', 'rel-vault'),
  ${jobKinds.map((kind) => `('${kind}', 'pending', '{}', 'rel-pending-${kind}')`).join(",\n  ")},
  ('${scheduleKinds[0]}', 'succeeded', '{}', 'rel-retired-history');
INSERT INTO swarm_judge_config (id, mode, model) VALUES (1, 'enforce', NULL)
  ON CONFLICT (id) DO UPDATE SET mode = EXCLUDED.mode, model = EXCLUDED.model;
INSERT INTO audit_log (actor, action, target_type, target_id) VALUES ('release-fixture', 'member.activate', 'member', 'm-alpha');
INSERT INTO swarm_waitlist (email, email_norm, notified_at) VALUES ('Wait@Example.com', 'wait@example.com', '2026-09-02T00:00:00Z');
`;
}

// ───────────────────────────────────────────────────────────────────────────
// Fixture integrity — needs no database
// ───────────────────────────────────────────────────────────────────────────

describe("the baseline fixtures are the targets' own ledgers and bytes", () => {
  test("PRE_IDENTITY_RELEASES is production's observed ledger alone (2026-10-01), and it has a fixture", () => {
    expect(PRE_IDENTITY_RELEASES.map((r) => r.name)).toEqual([
      "v0.5.0+0061+0062+0063+0080 (production ledger 2026-10-01)",
    ]);
  });

  for (const { name: tag, release: releaseTag, outOfBand, migrations } of PRE_IDENTITY_RELEASES) {
    test(`${tag}: PRE_IDENTITY_RELEASES pins exactly the ledger read from the target`, () => {
      // The first production migrate matches a ledger against this list (§9.1,
      // D55 (5)); a list that drifted from what production recorded would
      // refuse production, or admit a ledger production never wrote.
      const baseline = loadBaseline(tag);
      expect([...migrations]).toEqual(baseline.ledger.map((row) => row.file));
      expect(baseline.ledger.length).toBe(76);
      expect(baseline.release).toBe(releaseTag);
    });

    test(`${tag}: it is its release's filename list plus exactly its extra files`, () => {
      const released = loadRelease(releaseTag).migrations.map((m) => m.file);
      expect(outOfBand.filter((file) => released.includes(file))).toEqual([]);
      expect([...migrations].sort()).toEqual([...released, ...outOfBand].sort());
      expect(loadBaseline(tag).outOfBand.map((o) => o.file)).toEqual([...outOfBand]);
    });

    test(`${tag}: every file hashes to what the tag or the archive recorded`, () => {
      const baseline = loadBaseline(tag);
      expect(baseline.migrations.length).toBe(migrations.length);
      const drifted = baseline.migrations
        .filter(({ file, sha256: recorded }) => sha256(fixtureBytes(baseline, file)) !== recorded)
        .map(({ file }) => file);
      // A file edited on the branch after the tag needs its release bytes kept
      // under fixtures/releases/<tag>/migrations/ — never a re-recorded hash;
      // an out-of-band file keeps its archived bytes beside baseline.json.
      expect(drifted).toEqual([]);
    });

    test(`${tag}: the branch's copy of each extra file runs the same SQL as the one production ran`, () => {
      // The reference database applies the branch's copy; the upgraded one
      // recorded the archived copy. They must differ in comments alone, or the
      // catalog comparison below compares two different post-states.
      const statements = (text: string): string =>
        text
          .split("\n")
          .filter((line) => !/^\s*--/.test(line))
          .map((line) => line.replace(/\s+--.*$/, "").trimEnd())
          .filter((line) => line.trim() !== "")
          .join("\n");
      const baseline = loadBaseline(tag);
      for (const file of outOfBand) {
        expect(statements(readFileSync(join(MIGRATIONS_DIR, file), "utf8"))).toBe(
          statements(fixtureBytes(baseline, file).toString("utf8")),
        );
      }
    });

    test(`${tag}: it records the swarm schedule and job kinds it seeded, and 0089 deletes every one of them`, () => {
      const { scheduleKinds, jobKinds } = loadBaseline(tag).swarm;
      expect(scheduleKinds.length).toBeGreaterThan(0);
      // Every schedule kind is also a job kind: a seeded row only enqueues
      // kinds a handler was registered for.
      expect(scheduleKinds.filter((kind) => !jobKinds.includes(kind))).toEqual([]);
      const deletedSchedules = scheduleKindsDeletedBy0089();
      expect(scheduleKinds.filter((kind) => !deletedSchedules.includes(kind))).toEqual([]);
    });

    test(`${tag}: its migrations are a subset of the branch's — an upgrade never meets a file the branch lacks`, () => {
      const release = loadBaseline(tag);
      const onBranch = new Set(HEAD_FILES);
      expect(release.migrations.map((m) => m.file).filter((file) => !onBranch.has(file))).toEqual([]);
    });
  }
});

// ───────────────────────────────────────────────────────────────────────────
// The upgrade
// ───────────────────────────────────────────────────────────────────────────

const suffix = crypto.randomUUID().slice(0, 8);
const REFERENCE_DB = `rm_upgrade_reference_${suffix}`;

let admin: postgres.Sql<{}>;
let reference: postgres.Sql<{}>;
let savedRoles: SavedRole[] = [];
const created: string[] = [];
const homes: string[] = [];

beforeAll(async () => {
  // cluster admin: role attributes and passwords, CREATE/DROP DATABASE are superuser-only.
  admin = adminConnection("postgres");
  savedRoles = await saveRoles(admin);

  // Blank + all migrations, given the real migrate run — the target every
  // upgrade must land on, and the side schema-equivalence.test.ts compares to
  // the snapshot.
  await admin.unsafe(`CREATE DATABASE ${REFERENCE_DB} OWNER rm_owner TEMPLATE "${process.env.RM_TEST_MIGRATED_TEMPLATE_DB}"`);
  created.push(REFERENCE_DB);
  // cluster admin: the migrated template was replayed by the cluster's superuser
  // (tests/preload.ts), so it carries default ACLs FOR that login, which only a
  // superuser may alter. Removing them is the production shape (release-fixture.ts).
  const templateBuilder = adminConnection(REFERENCE_DB);
  try {
    await revokeLoginDefaults(templateBuilder, new URL(adminUrl()).username);
  } finally {
    await templateBuilder.end({ timeout: 5 });
  }
  reference = connect(REFERENCE_DB);
  await enroll(reference, "rehearsal");
  await migrateAsOwner(reference, REFERENCE_DB);
}, 120_000);

afterAll(async () => {
  await reference?.end({ timeout: 5 });
  try {
    await restoreRoles(admin, savedRoles);
    for (const name of created) await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  } finally {
    await admin.end({ timeout: 5 });
    for (const home of homes) rmSync(home, { recursive: true, force: true });
  }
});

for (const [index, { name: tag }] of PRE_IDENTITY_RELEASES.entries()) {
  describe(`upgrade from ${tag}, populated`, () => {
    const name = `rm_upgrade_${index}_${suffix}`;
    let db: postgres.Sql<{}>;
    let release: ReleaseFixture;
    let appliedByRun: readonly string[] = [];
    /** True when the release predates 0081 — it has no deployment_identity
     *  table, so its upgrade is the first production migrate of §9.1. */
    let predatesIdentity = false;

    beforeAll(async () => {
      release = loadBaseline(tag);
      await admin.unsafe(`CREATE DATABASE ${name} OWNER rm_owner`);
      created.push(name);
      // cluster admin: the release's own 0053 runs ALTER ROLE, which only a
      // superuser may do, so the release's history is replayed (and its data
      // loaded) as the provider's bootstrap login, as production's doadmin does.
      const runner = adminConnection(name);
      try {
        try {
          await applyAsReleaseRunner(runner, releaseSteps(release));
        } finally {
          // The release's 0053 re-attributed the cluster's roles; put them back
          // before anything else in this process can observe them.
          await restoreLogins(admin, savedRoles);
        }
        await runner.unsafe(releaseData(release));
        await revokeLoginDefaults(runner, new URL(adminUrl()).username);
      } finally {
        await runner.end({ timeout: 5 });
      }
      db = connect(name);
      predatesIdentity = Math.max(...release.migrations.map((m) => migrationNumber(m.file))) < migrationNumber("0081_deployment_identity.sql");

      // §9.1 step 1 through the provisioning login, and the host's rm_readonly
      // line: what the operator's `bun run migrate` logs in with.
      await admin.unsafe(`ALTER ROLE rm_owner LOGIN PASSWORD '${OWNER_PASSWORD}'`);
      await admin.unsafe(`ALTER ROLE rm_readonly LOGIN PASSWORD '${READONLY_PASSWORD}'`);
    }, 120_000);

    afterAll(async () => {
      await db?.end({ timeout: 5 });
    });

    test("no caller but the operator's confirmed first production migrate reaches a release that predates 0081", async () => {
      const [table] = (await db`SELECT to_regclass('public.deployment_identity') IS NOT NULL AS present`) as unknown as {
        present: boolean;
      }[];
      expect(table?.present).toBe(!predatesIdentity);
      if (!predatesIdentity) return;
      // `--migrate` never has §4.3's exception.
      await expect(migrateAsOwner(db, name)).rejects.toThrow("no deployment_identity row");
      // The run reached around the command, with no confirmation behind it.
      const owner = connect(name, { name: "rm_owner", password: OWNER_PASSWORD });
      try {
        await expect(
          withTargetLock(urlFor(name), (lock) =>
            runMigrate(owner, { caller: "operator", env: "prod", connection: "remote", lock }),
          ),
        ).rejects.toThrow("no run confirmed it");
      } finally {
        await owner.end({ timeout: 5 });
      }
      // …and each refused before applying anything.
      const ledger = (await db`SELECT name FROM schema_migrations ORDER BY name`) as unknown as { name: string }[];
      expect(ledger.map((r) => r.name)).toEqual(release.migrations.map((m) => m.file));
    });

    test("`bun run migrate` — RM_ENV=prod, ~/.env's rm_owner, --confirm-target — reaches the branch's version in one run", async () => {
      // A release past 0081 would be enrolled already (§9.1 step 4); only one
      // that predates the table takes the pre-identity path.
      if (!predatesIdentity) await enroll(db, "production");
      const run = await runMigrateCommand({
        databaseUrl: new URL(urlFor(name)),
        readonlyPassword: READONLY_PASSWORD,
        ownerPassword: OWNER_PASSWORD,
        rmEnv: "prod",
      });
      homes.push(run.home);
      expect({ code: run.code, tail: run.code === 0 ? "" : run.screen.slice(-3000) }).toEqual({ code: 0, tail: "" });

      const receipt = JSON.parse(readFileSync(run.receiptPath, "utf8")) as {
        applied: string[];
        preIdentity: { identity: string; release: string; ledger: string[] } | null;
        manifest: { filenames: string[] };
      };
      appliedByRun = receipt.applied;
      const recorded = new Set(release.migrations.map((m) => m.file));
      // Every pending file, the pre-compat ones at or below 0081 included: no
      // file is applied around the command any more. A release that predates
      // 0081 takes the identity-first pass (D55 (9)): 0081 first, then the rest
      // in filename order.
      const pending = HEAD_FILES.filter((file) => !recorded.has(file));
      expect(receipt.applied).toEqual(
        predatesIdentity ? [IDENTITY_MIGRATION, ...pending.filter((file) => file !== IDENTITY_MIGRATION)] : pending,
      );
      expect(await rows(db`SELECT kind FROM deployment_identity`)).toEqual([{ kind: "production" }]);
      expect(receipt.preIdentity).toEqual(
        predatesIdentity ? { identity: "no table", release: tag, ledger: release.migrations.map((m) => m.file) } : null,
      );
      expect(receipt.manifest.filenames).toEqual(HEAD_FILES);

      const ledger = (await db`SELECT name FROM schema_migrations ORDER BY name`) as unknown as { name: string }[];
      expect(ledger.map((r) => r.name)).toEqual(HEAD_FILES);
      expect((await readManifest(db))?.filenames).toEqual(HEAD_FILES);
    }, 180_000);

    test("every file the run applied recorded its own declaration; every pre-compat file stayed NULL", async () => {
      expect(appliedByRun.length).toBeGreaterThan(0);
      const rows = (await db`
        SELECT name, compat, metadata_version FROM schema_migrations ORDER BY name`) as unknown as {
        name: string;
        compat: string | null;
        metadata_version: number | null;
      }[];
      for (const row of rows) {
        const header = parsePendingHeader(row.name, readFileSync(join(MIGRATIONS_DIR, row.name), "utf8"));
        // A file above the pre-compat baseline always carries a header
        // (parsePendingHeader throws when one does not), and runs after 0082
        // added the columns, so the run records it. At or below the baseline
        // (D53 decision 3) the run applied it before those columns existed —
        // or the release did — and the row stays NULL, declared or not.
        const declared = appliedByRun.includes(row.name) && migrationNumber(row.name) > COMPAT_HEADER_BASELINE;
        if (declared) {
          expect({ name: row.name, compat: row.compat, version: row.metadata_version }).toEqual({
            name: row.name,
            compat: header!.compat,
            version: header!.metadataVersion,
          });
        } else {
          expect({ name: row.name, compat: row.compat, version: row.metadata_version }).toEqual({
            name: row.name,
            compat: null,
            version: null,
          });
        }
      }
    });


    test("the upgraded schema equals blank + all migrations, object for object — comments included", async () => {
      const diff = diffCatalogs(await normalizedCatalog(db), await normalizedCatalog(reference));
      const lines = describeCatalogDiff(diff, `${tag}+pending`, "blank+all");
      if (lines.length > 0) throw new Error(`upgraded ${tag} differs from blank + all migrations:\n${lines.join("\n")}`);
      expect(lines).toEqual([]);
    });

    // ── The data assertions ───────────────────────────────────────────────

    test("members, the subject, audit history and the waitlist survive unchanged", async () => {
      expect(await rows(db`SELECT id, status, name, handle, role FROM swarm_members ORDER BY id`)).toEqual([
        { id: "m-alpha", status: "active", name: "Alpha", handle: "alpha", role: "member" },
        { id: "m-beta", status: "active", name: "Beta", handle: "beta", role: "member" },
        { id: "m-forged", status: "active", name: "Forged", handle: "forged", role: "member" },
        { id: "m-judge", status: "active", name: "Judge", handle: "judge-one", role: "judge" },
        { id: "m-partner", status: "active", name: "Partner", handle: "partner", role: "member" },
      ]);
      expect(await rows(db`SELECT id, name, status FROM swarm_subjects`)).toEqual([
        { id: "subj-1", name: "Subject One", status: "active" },
      ]);
      expect(await rows(db`SELECT actor, action, target_id FROM audit_log WHERE actor = 'release-fixture'`)).toEqual([
        { actor: "release-fixture", action: "member.activate", target_id: "m-alpha" },
      ]);
      // 0084 drops `notified_at` (it is `breaking`); the row itself stays.
      expect(await rows(db`SELECT email, email_norm FROM swarm_waitlist`)).toEqual([
        { email: "Wait@Example.com", email_norm: "wait@example.com" },
      ]);
    });

    test("the subject keeps production's six-hour schedule: 21600 s, and the next three closes are the instants v0.5.4's driver would have used (0085, 0090, issue 1112)", async () => {
      const [subject] = (await db`
        SELECT epoch_duration_seconds, judging_duration_seconds, epoch_anchor FROM swarm_subjects WHERE id = 'subj-1'`) as unknown as {
        epoch_duration_seconds: number;
        judging_duration_seconds: number;
        epoch_anchor: Date;
      }[];
      // v0.5.4 ran one session per subject every six hours, window = interval
      // (scripts/lib/smoke-schedule.ts, REALISTIC). An upgrade does not change it.
      expect(subject?.epoch_duration_seconds).toBe(21600);
      expect(subject?.judging_duration_seconds).toBe(900);
      // 0086 leaves ONE collecting session per subject (the newest); 0090
      // anchors the grid on that window's close.
      expect(subject?.epoch_anchor.toISOString()).toBe("2026-09-21T12:00:00.000Z");
      // The open window is 06:00 -> 12:00 (six hours). Production's driver opens
      // the next session at 12:00 and walks 6 h slots, so the next three closes
      // are 18:00, 00:00 and 06:00. The grid the scheduler will use, read back
      // from the migrated columns, must produce exactly those.
      const grid = (await db`
        SELECT to_char(epoch_anchor + k * make_interval(secs => epoch_duration_seconds),
                       'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at
          FROM swarm_subjects, generate_series(1, 3) AS k
         WHERE id = 'subj-1' ORDER BY k`) as unknown as { at: string }[];
      expect(grid.map((g) => g.at)).toEqual(["2026-09-21T18:00:00Z", "2026-09-22T00:00:00Z", "2026-09-22T06:00:00Z"]);
    });

    test("one collecting session per subject: the older is closed, the newest stays open, history untouched (0086)", async () => {
      expect(
        await rows(db`SELECT id, state, published_at IS NOT NULL AS published FROM swarm_sessions ORDER BY convened_at`),
      ).toEqual([
        { id: SESSION_PUBLISHED, state: "published", published: true },
        { id: SESSION_AGGREGATED, state: "aggregated", published: false },
        { id: SESSION_JUDGED_ENFORCE, state: "judged", published: false },
        // A `shadow` judgement never reached its session: back to `aggregated` (0091).
        { id: SESSION_JUDGED_SHADOW, state: "aggregated", published: false },
        { id: SESSION_OLD_OPEN, state: "window_closed", published: false },
        { id: SESSION_NEW_OPEN, state: "collecting", published: false },
      ]);
    });

    test("every take and every revision survives with its signed content; the newest per member is final (0092, D51)", async () => {
      expect(
        await rows(db`
          SELECT member_id, revision, nonce, stance, payload, signature, verified, final
          FROM swarm_recommendations ORDER BY member_id, revision`),
      ).toEqual([
        { member_id: "m-alpha", revision: 1, nonce: "n-alpha-1", stance: "buy", payload: { take: "alpha r1" }, signature: "sig-alpha-1", verified: true, final: false },
        { member_id: "m-alpha", revision: 2, nonce: "n-alpha-2", stance: "hold", payload: { take: "alpha r2" }, signature: "sig-alpha-2", verified: true, final: true },
        { member_id: "m-beta", revision: 1, nonce: "n-beta-1", stance: "sell", payload: { take: "beta r1" }, signature: "sig-beta-1", verified: true, final: true },
      ]);
    });

    test("the vault schedule and its job survive; every swarm schedule row the release seeded is gone; no swarm job it queued is left pending; history stays (0084, 0089)", async () => {
      const { scheduleKinds, jobKinds } = release.swarm;
      // Only the vault row survives — so every seeded swarm.* row is gone,
      // whatever list 0089 happens to carry.
      expect(await rows(db`SELECT kind, cron, payload, enabled FROM job_schedules ORDER BY kind`)).toEqual([
        { kind: "vault.sample_share_price", cron: "0 * * * *", payload: { vault: "v1" }, enabled: true },
      ]);
      // A pending job whose handler is gone never settles: every swarm.* kind
      // the release could queue must leave the pending state, by deletion
      // (0089) or cancellation (0084).
      expect(
        await rows(db`SELECT kind FROM jobs WHERE dedupe_key LIKE 'rel-pending-%' AND status = 'pending' ORDER BY kind`),
      ).toEqual([]);
      const settled = (await db`
        SELECT kind, status, last_error FROM jobs WHERE dedupe_key LIKE 'rel-pending-%' ORDER BY kind`) as unknown as {
        kind: string;
        status: string;
        last_error: string | null;
      }[];
      for (const row of settled) {
        expect({ kind: row.kind, status: row.status, last_error: row.last_error }).toEqual({
          kind: row.kind,
          status: "cancelled",
          last_error: "swarm email removed (issue #1026 W5, decision D50)",
        });
      }
      // Every seeded kind is accounted for: deleted, or cancelled above.
      expect(jobKinds.length).toBeGreaterThan(scheduleKinds.length);
      expect(settled.every((row) => jobKinds.includes(row.kind))).toBe(true);
      expect(
        await rows(db`SELECT dedupe_key, kind, status FROM jobs WHERE dedupe_key IN ('rel-vault', 'rel-retired-history') ORDER BY dedupe_key`),
      ).toEqual([
        { dedupe_key: "rel-retired-history", kind: scheduleKinds[0], status: "succeeded" },
        { dedupe_key: "rel-vault", kind: "vault.sample_share_price", status: "pending" },
      ]);
    });

    test("0089 is recorded `breaking`: it deletes rows code at 0088 seeded and read (D55 (7))", async () => {
      // The release predates 0089, so this run applied it and recorded the
      // header it carries now. §8.4: removing a bootstrap row old code relies
      // on is not additive.
      expect(
        await rows(db`SELECT name, compat, metadata_version FROM schema_migrations WHERE name = '0089_drop_swarm_schedules.sql'`),
      ).toEqual([{ name: "0089_drop_swarm_schedules.sql", compat: "breaking", metadata_version: 1 }]);
    });

    test("a self-written operator is cleared and recorded; an admin-written one is kept (0101, D55 (2))", async () => {
      // The release's own code logged a member's profile write as
      // `update_profile` with only { memberId }, so `m-forged`'s `robotmoney`
      // is a self-write with no admin behind it. `m-partner` also self-wrote,
      // but an admin wrote its operator afterwards.
      expect(await rows(db`SELECT id, operator FROM swarm_members WHERE id IN ('m-forged', 'm-partner') ORDER BY id`))
        .toEqual([
          { id: "m-forged", operator: null },
          { id: "m-partner", operator: "peaq" },
        ]);
      expect(
        await rows(db`
          SELECT target_id, before_state FROM audit_log
           WHERE actor = 'migration 0101' AND action = 'member_operator_cleared' ORDER BY target_id`),
      ).toEqual([{ target_id: "m-forged", before_state: { operator: "robotmoney" } }]);
    });

    test("the event log is numbered from its counter row, seeded from the log, and the job ledger is gone (0096-0098)", async () => {
      expect(await rows(db`SELECT id, seq::int AS seq FROM swarm_stream_head`)).toEqual([{ id: true, seq: 0 }]);
      expect(await rows(db`SELECT to_regclass('public.swarm_scheduler_jobs')::text AS reg`)).toEqual([{ reg: null }]);
    });

    test("a judge enabled with no model is switched off, never left to judge with nothing (0056)", async () => {
      const [config] = (await db`
        SELECT mode, model, policy_updated_at IS NOT NULL AS stamped FROM swarm_judge_config`) as unknown as {
        mode: string;
        model: string | null;
        stamped: boolean;
      }[];
      // Switched off by 0056. 0063 (which gives the judge the CI/driver model)
      // is part of this baseline now, so it ran before the row was planted and
      // does not fill it again: the repair is 0056's alone, and the row stays
      // model-less until an operator sets { mode, model } together.
      expect(config).toEqual({ mode: "off", model: null, stamped: true });
    });

    // ── Code at N against N+additive ──────────────────────────────────────
    //
    // Run on the ledger THIS upgrade produced, so each surplus row's compat is
    // what `runMigrate` recorded from the file's header — not a value written
    // by the test. "Code at N" is represented by its snapshot filename list,
    // which is the whole of what check 3b reads; check 3a reads the database's
    // own manifest "whatever code is booting".
    //
    // NOT PROVED HERE: that an older image's REGISTERED QUERIES still succeed
    // (§8.4's definition of additive). No older registry exists to execute —
    // the registry is this branch's — so that half is a reviewed claim per
    // migration. One such claim was wrong, surfaced by the data test above:
    // 0089 declared `compat: additive` while deleting the swarm.* job_schedules
    // rows and pending swarm.* jobs that code built at 0088 seeded and read.
    // §8.4: additive means "no bootstrap row it relies on is removed". D55 (7)
    // relabelled it `breaking`, so this run records `breaking` for it and code
    // at 0088 is refused by check 3b. A ledger that recorded 0089 before the
    // relabel keeps `additive`; 0096-0098, all `breaking`, close that rollback.

    function context(codeFilenames: readonly string[]): PreflightContext {
      return { env: "stage", connection: "local", roles: ["rm_app"], codeFilenames, envFilePath: "/nonexistent/.env" };
    }

    /** The last `breaking` file on the branch — the newest point code-only
     *  rollback may reach, since every file after it is additive. */
    function lastBreaking(): string {
      const breaking = HEAD_FILES.filter(
        (file) => parsePendingHeader(file, readFileSync(join(MIGRATIONS_DIR, file), "utf8"))?.compat === "breaking",
      );
      expect(breaking.length).toBeGreaterThan(0);
      return breaking[breaking.length - 1]!;
    }

    test("check 3a passes on the upgraded database for any booting code — it compares the database with its own manifest", async () => {
      const findings = (await checkSchemaIntegrity(db, context(HEAD_FILES))).findings;
      // THE HARNESS LOGIN STANDS IN FOR THE PROVIDER'S ADMIN. Migration
      // 0016:37-38 sets default privileges FOR the login that runs it. In
      // production that login is doadmin, which the installed manifest's
      // provider exclusion list covers, so 3a has nothing to say. The first
      // manifest is now published only after the §9.1 step 2 baseline
      // (migrate-run.ts), so `migrateAsOwner` removed this harness login's two
      // default ACLs first — the production shape — and 3a has nothing to say
      // here either. Any refusal fails, by name.
      expect(findings.filter((f) => f.severity === "refuse").map((f) => f.message)).toEqual([]);
    });

    test("code at every N from the last breaking file onward boots against the additive tail (check 3b)", async () => {
      const from = HEAD_FILES.indexOf(lastBreaking());
      for (let n = from; n < HEAD_FILES.length; n += 1) {
        const code = HEAD_FILES.slice(0, n + 1);
        const refusals = (await checkSchemaCompatibility(db, context(code))).findings.filter((f) => f.severity === "refuse");
        expect({ codeAt: HEAD_FILES[n], refusals }).toEqual({ codeAt: HEAD_FILES[n], refusals: [] });
      }
    });

    test("code before the last breaking file refuses, naming it — rollback past a breaking change is closed, explicitly", async () => {
      const boundary = lastBreaking();
      const code = HEAD_FILES.slice(0, HEAD_FILES.indexOf(boundary));
      const messages = (await checkSchemaCompatibility(db, context(code))).findings
        .filter((f) => f.severity === "refuse")
        .map((f) => f.message);
      expect(messages.some((m) => m.startsWith(`${boundary}: declared breaking`))).toBe(true);
    });

    test(`code at ${tag} itself refuses to boot on the upgraded database when the release predates the baseline or the last breaking file`, async () => {
      const code = release.migrations.map((m) => m.file);
      const messages = (await checkSchemaCompatibility(db, context(code))).findings
        .filter((f) => f.severity === "refuse")
        .map((f) => f.message);
      // Pre-compat files the release lacks carry a NULL compat (only when it
      // predates the baseline), and a breaking file in its surplus refuses
      // (only when the release lacks it): each refuses, and each is named.
      const recorded = new Set(code);
      const lacksPreCompat = HEAD_FILES.some((f) => !recorded.has(f) && migrationNumber(f) <= COMPAT_HEADER_BASELINE);
      const lacksBreaking = !recorded.has(lastBreaking());
      // A release past both boots on the additive tail — the check-3b test
      // above already covers that case.
      expect(messages.length > 0).toBe(lacksPreCompat || lacksBreaking);
      expect(messages.some((m) => m.includes("compat is NULL"))).toBe(lacksPreCompat);
      if (lacksBreaking) expect(messages.some((m) => m.startsWith(`${lastBreaking()}: declared breaking`))).toBe(true);
    });

    // ── Sessions in flight at the upgrade (issue 1111) ────────────────────
    //
    // A v0.5.4 database holds sessions the cron driver had closed, aggregated
    // or judged and not yet published. The epoch scheduler refuses a session
    // whose judge_mode was never captured, and 0089 has just deleted the
    // pending swarm.* jobs that would have finished them. The owner rule
    // (2026-10-03): they finish on their normal timing, with no operator step.
    // Everything below runs on the database the real migrate run produced, and
    // drives epoch.ts exactly as the scheduler's API client does.

    async function withUpgradedDatabase<T>(run: () => Promise<T>): Promise<T> {
      const previous = process.env.DATABASE_URL!;
      await client.setDatabase(urlFor(name));
      try {
        return await run();
      } finally {
        await client.setDatabase(previous);
      }
    }

    /** Aggregate, request judging, and finalize one session as the scheduler's chain does. */
    async function settleAsScheduler(sessionId: string): Promise<{ requested: string; outcome?: string }> {
      const agg = await epoch.aggregateEpoch(sessionId);
      expect(agg.ok).toBe(true);
      const req = await epoch.requestJudging(sessionId);
      if (!req.ok) {
        // `off`: nothing waits, `aggregated -> publish` with `not_judged` (spec 4.4).
        expect(req.error).toBe("judge_mode_off");
        const fin = await epoch.finalizeEpoch(sessionId);
        expect(fin.ok).toBe(true);
        return { requested: "off", outcome: (fin as { outcome: string }).outcome };
      }
      return { requested: "judging" };
    }

    test("every in-flight session carries a captured judge mode and judging duration, and its timestamps are unchanged (0091)", async () => {
      const captured = await rows(db`
        SELECT id, state, judge_mode, judging_duration_seconds,
               judging_requested_at IS NOT NULL AS requested, judging_deadline_at IS NOT NULL AS has_deadline,
               consensus_recorded_at IS NOT NULL AS consensus
          FROM swarm_sessions
         WHERE id IN (${SESSION_OLD_OPEN}, ${SESSION_AGGREGATED}, ${SESSION_JUDGED_ENFORCE}, ${SESSION_JUDGED_SHADOW}, ${SESSION_NEW_OPEN})
         ORDER BY convened_at`);
      expect(captured).toEqual([
        // aggregated: mode in force (0056 switched the planted judge off), subject duration
        { id: SESSION_AGGREGATED, state: "aggregated", judge_mode: "off", judging_duration_seconds: 900, requested: false, has_deadline: false, consensus: false },
        // judged under an enforce judgement: keeps that mode and settles by it
        { id: SESSION_JUDGED_ENFORCE, state: "judged", judge_mode: "enforce", judging_duration_seconds: 900, requested: true, has_deadline: true, consensus: true },
        // judged under shadow: the judge never reached the session, back to aggregated, mode off
        { id: SESSION_JUDGED_SHADOW, state: "aggregated", judge_mode: "off", judging_duration_seconds: 900, requested: false, has_deadline: false, consensus: false },
        // window_closed
        { id: SESSION_OLD_OPEN, state: "window_closed", judge_mode: "off", judging_duration_seconds: 900, requested: false, has_deadline: false, consensus: false },
        // collecting: the turnover captures at close, so nothing yet
        { id: SESSION_NEW_OPEN, state: "collecting", judge_mode: null, judging_duration_seconds: null, requested: false, has_deadline: false, consensus: false },
      ]);
      const stamps = await rows(db`
        SELECT id, window_closes_at, convened_at FROM swarm_sessions
         WHERE id IN (${SESSION_AGGREGATED}, ${SESSION_JUDGED_ENFORCE}, ${SESSION_JUDGED_SHADOW}, ${SESSION_OLD_OPEN}) ORDER BY convened_at`);
      expect(stamps.map((r) => [r.id, (r.window_closes_at as Date).toISOString(), (r.convened_at as Date).toISOString()])).toEqual([
        [SESSION_AGGREGATED, "2026-09-10T12:00:00.000Z", "2026-09-10T11:00:00.000Z"],
        [SESSION_JUDGED_ENFORCE, "2026-09-11T12:00:00.000Z", "2026-09-11T11:00:00.000Z"],
        [SESSION_JUDGED_SHADOW, "2026-09-12T12:00:00.000Z", "2026-09-12T11:00:00.000Z"],
        [SESSION_OLD_OPEN, "2026-09-20T12:00:00.000Z", "2026-09-20T06:00:00.000Z"],
      ]);
      // The enforce judgement's own instant becomes the request and the consensus; the deadline is that plus the duration.
      const [je] = await rows(db`
        SELECT judging_requested_at, judging_deadline_at, consensus_recorded_at FROM swarm_sessions WHERE id = ${SESSION_JUDGED_ENFORCE}`);
      expect([je!.judging_requested_at, je!.judging_deadline_at, je!.consensus_recorded_at].map((d) => (d as Date).toISOString())).toEqual([
        "2026-09-11T12:30:00.000Z",
        "2026-09-11T12:45:00.000Z",
        "2026-09-11T12:30:00.000Z",
      ]);
    });

    test("the scheduler's own calls publish the window_closed, aggregated and judged sessions and the collecting one turns over and settles, with no operator step", async () => {
      await withUpgradedDatabase(async () => {
        // window_closed and both aggregated (the shadow-judged one was returned to aggregated): judge off, so not_judged.
        for (const id of [SESSION_OLD_OPEN, SESSION_AGGREGATED, SESSION_JUDGED_SHADOW]) {
          expect(await settleAsScheduler(id)).toEqual({ requested: "off", outcome: "not_judged" });
        }
        // judged under enforce: finalize decides `judged` from the stored instants (consensus at or before the deadline).
        const fin = await epoch.finalizeEpoch(SESSION_JUDGED_ENFORCE);
        expect(fin).toMatchObject({ ok: true, state: "published", outcome: "judged" });
        // collecting: its window closed on the subject's grid long ago, the turnover captures and the chain settles it.
        const turned = await epoch.turnOverEpoch("subj-1", SESSION_NEW_OPEN);
        expect(turned.ok).toBe(true);
        expect(await settleAsScheduler(SESSION_NEW_OPEN)).toEqual({ requested: "off", outcome: "not_judged" });
      });
      const states = await rows(db`
        SELECT id, state, judging_outcome FROM swarm_sessions
         WHERE id IN (${SESSION_OLD_OPEN}, ${SESSION_AGGREGATED}, ${SESSION_JUDGED_ENFORCE}, ${SESSION_JUDGED_SHADOW}, ${SESSION_NEW_OPEN})
         ORDER BY convened_at`);
      expect(states).toEqual([
        { id: SESSION_AGGREGATED, state: "published", judging_outcome: "not_judged" },
        { id: SESSION_JUDGED_ENFORCE, state: "published", judging_outcome: "judged" },
        { id: SESSION_JUDGED_SHADOW, state: "published", judging_outcome: "not_judged" },
        { id: SESSION_OLD_OPEN, state: "published", judging_outcome: "not_judged" },
        { id: SESSION_NEW_OPEN, state: "published", judging_outcome: "not_judged" },
      ]);
    });

    test("a session the old driver was judging when 0089 deleted its swarm.judge job reaches the judge through the stream under enforce, and publishes when the deadline passes", async () => {
      // The planted judge was switched off by 0056, so this run's sessions took
      // `off`. A production judge in `enforce` needs the same migration run
      // against the same shapes, so the migration's own backfill block is
      // executed here, from the file, over fresh legacy-shaped rows.
      const sqlText = readFileSync(join(MIGRATIONS_DIR, "0091_session_judging_duration.sql"), "utf8");
      const block = /\nDO \$\$[\s\S]*?\n\$\$;/.exec(sqlText)?.[0];
      expect(block).toBeDefined();
      const legacyWindowClosed = "00000000-0000-4000-8000-00000000a0b1";
      const legacyAggregated = "00000000-0000-4000-8000-00000000a0b2";
      await db.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE rm_owner");
        await tx`UPDATE swarm_judge_config SET mode = 'enforce', model = 'test/model' WHERE id = 1`;
        await tx`UPDATE swarm_members SET operator = 'robotmoney' WHERE id = 'm-judge'`;
        await tx`INSERT INTO swarm_sessions (id, subject_id, subject_name, state, window_closes_at, convened_at) VALUES
          (${legacyWindowClosed}, 'subj-1', 'Subject One', 'window_closed', '2026-09-13T12:00:00Z', '2026-09-13T11:00:00Z'),
          (${legacyAggregated},   'subj-1', 'Subject One', 'aggregated',   '2026-09-14T12:00:00Z', '2026-09-14T11:00:00Z')`;
        await tx`INSERT INTO swarm_recommendations (session_id, member_id, subject_id, date, nonce, stance, payload, signature, verified, revision) VALUES
          (${legacyWindowClosed}, 'm-alpha', 'subj-1', '2026-09-13', 'n-lc-1', 'buy', '{"take":"a"}', 'sig-lc-1', true, 1),
          (${legacyAggregated},   'm-alpha', 'subj-1', '2026-09-14', 'n-lc-2', 'buy', '{"take":"a"}', 'sig-lc-2', true, 1)`;
        await tx.unsafe(block!);
      });
      await withUpgradedDatabase(async () => {
        expect(await settleAsScheduler(legacyWindowClosed)).toEqual({ requested: "judging" });
        expect(await settleAsScheduler(legacyAggregated)).toEqual({ requested: "judging" });
        const pending = (await domain.pendingJudgingFor("m-judge")).map((p) => p.sessionId);
        expect(pending).toContain(legacyWindowClosed);
        expect(pending).toContain(legacyAggregated);
        // No judge answers: the stored deadline is the scheduler's only timer.
        await db`UPDATE swarm_sessions SET judging_deadline_at = now() - interval '1 second' WHERE id IN (${legacyWindowClosed}, ${legacyAggregated})`;
        for (const id of [legacyWindowClosed, legacyAggregated]) {
          expect(await epoch.finalizeEpoch(id)).toMatchObject({ ok: true, state: "published", outcome: "no_consensus" });
        }
      });
    }, 60_000);
  });
}

// A role's password is cluster state that outlives this file; put the baseline back (tests/support/cluster.ts).
restoreRoleBaselineAfterAll();
