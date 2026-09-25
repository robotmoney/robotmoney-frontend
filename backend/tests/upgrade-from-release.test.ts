// An upgrade from a populated database of each supported release passes its
// data assertions; code at N boots against N+additive — two of spec §8.4's CI
// proofs (smoke-production-spec.md §8.4, issue #1026 criterion 50).
//
// ─────────────────────────────────────────────────────────────────────────────
// WHICH RELEASES, AND WHERE THEIR SCHEMA COMES FROM
// ─────────────────────────────────────────────────────────────────────────────
//
// SUPPORTED_RELEASES is v0.5.0 alone: it is the release production runs
// (`releases-0.5.x` carries the same 72 migration files; v0.5.1's 0062 was
// never tagged), and an upgrade path from anything older is one no database
// will take. Adding a release is one fixture directory and one entry below
// ONLY for a release built by v0.5.0's runner loop (`applyAsReleaseRunner`),
// which records no compat declaration. A release whose own runner recorded
// compat (anything shipped with 0064's runMigrate) also needs that runner
// modelled here, or its ledger rows above the baseline read NULL. What depends
// on whether the release predates 0063 — the refusal, the bridge, the "compat
// is NULL" boot refusal — is gated on it (`predatesIdentity`), not assumed.
//
// A release's schema is rebuilt from its OWN migration bytes, recorded in
// tests/fixtures/releases/<tag>/release.json as a sha256 per file, taken from
// the tag. A file whose bytes on this branch still match is read from
// backend/migrations/; a file that was edited after the tag is kept verbatim
// under the fixture's migrations/ directory — v0.5.0's
// 0053_database_role_taxonomy.sql is one (it said NOLOGIN for rm_owner, the
// branch says LOGIN). The first test below fails if a file drifts from the
// recorded hash without a verbatim copy, so the release schema cannot silently
// become "whatever the branch says the release was". No test here needs git:
// CI's checkout is shallow and carries no tags.
//
// NO RELEASE TAG CARRIES A SNAPSHOT. backend/schema/ first appears on this
// branch, so spec §8.4's "snapshot N + migrations = snapshot N+1" has no
// snapshot N to start from. What this file proves in its place is the
// migrations half of it: release N's schema plus the pending migrations equals
// blank + all migrations, object for object. schema-equivalence.test.ts proves
// blank + all migrations equals the snapshot, so the two together tie the
// release to the snapshot through the migrations.
//
// The release is built the way the release built itself: v0.5.0's runner
// (backend/src/db/migrate.ts at the tag) applies each file in its own
// transaction and switches to `SET LOCAL ROLE rm_owner` from 0054 on.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE BRIDGE, AND WHY IT IS HERE (a reported gap, not a convenience)
// ─────────────────────────────────────────────────────────────────────────────
//
// `runMigrate` (backend/scripts/migrate-run.ts) cannot start from any shipped
// release. Its gates (`checkMigrateGates`) refuse a database with no
// `deployment_identity` row for every caller, and v0.5.0 predates 0063, which
// creates that table — so neither the §4.2 restore procedure ("ends by writing
// `rehearsal` through `rm_owner`") nor §9.1 step 4 has anything to write into
// until a migration runs, and nothing but `runMigrate` may run one. The
// operator caller additionally refuses a database with no manifest
// (`assertBaselineForOperator`), and v0.5.0 predates 0064. The first test in
// the upgrade block pins that refusal, because it is the state an operator
// meets today.
//
// So the pending files at or below the pre-compat baseline (0063, D53 decision
// 3 — `COMPAT_HEADER_BASELINE`) are applied by the release-era runner loop, the
// same loop `bun smoke --migrate` still reaches through the legacy runner.
// Then the database is enrolled `rehearsal` through rm_owner exactly as §4.2's
// restore procedure says, and `runMigrate` does the rest: every file above the
// baseline, each with its compat declaration recorded, then reconciliation and
// the manifest. Everything asserted about data below is asserted AFTER that
// real run.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { config } from "../src/config.ts";
import {
  checkSchemaCompatibility,
  checkSchemaIntegrity,
  type PreflightContext,
} from "../src/db/preflight.ts";
import { COMPAT_HEADER_BASELINE, migrationNumber, parsePendingHeader } from "../src/db/schema-compat.ts";
import { readManifest } from "../src/db/schema-manifest.ts";
import { runMigrate, type MigrateGateOptions } from "../scripts/migrate-run.ts";
import { withTargetLock } from "./support/target-lock.ts";
import { describeCatalogDiff, diffCatalogs, normalizedCatalog } from "./support/catalog-normalize.ts";

const MIGRATIONS_DIR = join(import.meta.dir, "..", "migrations");
const FIXTURES_DIR = join(import.meta.dir, "fixtures", "releases");
const HEAD_FILES = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();

/** The releases an upgrade must succeed from. See the header for why only one. */
const SUPPORTED_RELEASES = ["v0.5.0"] as const;

interface ReleaseFixture {
  readonly tag: string;
  readonly commit: string;
  /** What the release itself seeded and could queue — read from the tag, not
   *  from the migrations under test (see release.json's `source`). */
  readonly swarm: {
    readonly source: string;
    readonly scheduleKinds: readonly string[];
    readonly jobKinds: readonly string[];
  };
  readonly migrations: readonly { readonly file: string; readonly sha256: string }[];
}

function loadRelease(tag: string): ReleaseFixture {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, tag, "release.json"), "utf8")) as ReleaseFixture;
}

/** The release's own bytes for one file: the verbatim copy when the branch
 *  edited it after the tag, otherwise the branch's file. */
function releaseBytes(tag: string, file: string): Buffer {
  const pinned = join(FIXTURES_DIR, tag, "migrations", file);
  return readFileSync(existsSync(pinned) ? pinned : join(MIGRATIONS_DIR, file));
}

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

function urlFor(database: string): string {
  const url = new URL(config.databaseUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

function connect(database: string): postgres.Sql<{}> {
  return postgres(urlFor(database), { max: 1, onnotice: () => {} });
}

const MIGRATE_OPTIONS: MigrateGateOptions & { nonInteractive: boolean } = {
  caller: "smoke_flag",
  env: "stage",
  connection: "local",
  nonInteractive: true,
};

/**
 * The real migrate run as a tool performs it: the session IS rm_owner for the
 * whole run (`current_user = rm_owner`, which the run requires), under the §2
 * target lock. Both databases here were built by this harness's superuser
 * login, whose 0016 default privileges no snapshot declares (production's
 * bootstrap login is doadmin, a listed provider role), so those are removed
 * first — identically on both sides — for the first manifest's §9.1 step 2
 * baseline to pass for the reason production's would.
 */
async function migrateAsOwner(db: postgres.Sql<{}>, database: string, options = MIGRATE_OPTIONS): ReturnType<typeof runMigrate> {
  const login = new URL(config.databaseUrl).username;
  await db.unsafe(`ALTER DEFAULT PRIVILEGES FOR ROLE "${login}" IN SCHEMA public REVOKE ALL ON TABLES FROM rm_worker`);
  await db.unsafe(`ALTER DEFAULT PRIVILEGES FOR ROLE "${login}" IN SCHEMA public REVOKE ALL ON SEQUENCES FROM rm_worker`);
  await db.unsafe("SET ROLE rm_owner");
  try {
    return await withTargetLock(urlFor(database), (lock) => runMigrate(db, { ...options, lock }));
  } finally {
    await db.unsafe("RESET ROLE");
  }
}

/** v0.5.0's runner loop (backend/src/db/migrate.ts at the tag): one
 *  transaction per file, `SET LOCAL ROLE rm_owner` from 0054 on, a ledger row
 *  per file. Used to BUILD the release, and for the bridge described above. */
async function applyAsReleaseRunner(db: postgres.Sql<{}>, files: readonly { file: string; ddl: string }[]): Promise<void> {
  await db`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
  for (const { file, ddl } of files) {
    await db.begin(async (tx) => {
      if (file >= "0054_rm_worker_allowlist.sql") await tx.unsafe("SET LOCAL ROLE rm_owner");
      await tx.unsafe(ddl);
      await tx`INSERT INTO schema_migrations (name) VALUES (${file})`;
    });
  }
}

/** A query's rows as a plain array, so `toEqual` compares rows and nothing
 *  else the driver hangs on its result list. */
async function rows(query: PromiseLike<readonly postgres.Row[]>): Promise<postgres.Row[]> {
  return [...(await query)];
}

async function enrollRehearsal(db: postgres.Sql<{}>): Promise<void> {
  await db.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE rm_owner");
    await tx.unsafe("INSERT INTO deployment_identity (kind) VALUES ('rehearsal')");
  });
}

// Role attributes are CLUSTER-wide. v0.5.0's 0053 says `ALTER ROLE rm_owner
// NOLOGIN`, and later files in this suite log in as rm_owner or read its LOGIN
// attribute as evidence of what the branch's 0053 did. So the attributes are
// recorded before the release is built and put back exactly afterwards.
type RoleAttributes = { rolname: string; rolcanlogin: boolean };
async function roleAttributes(db: postgres.Sql<{}>): Promise<RoleAttributes[]> {
  return (await db`
    SELECT rolname, rolcanlogin FROM pg_roles
    WHERE rolname IN ('rm_owner', 'rm_app', 'rm_worker', 'rm_readonly') ORDER BY rolname`) as unknown as RoleAttributes[];
}
async function restoreRoleAttributes(db: postgres.Sql<{}>, saved: readonly RoleAttributes[]): Promise<void> {
  for (const role of saved) await db.unsafe(`ALTER ROLE ${role.rolname} ${role.rolcanlogin ? "LOGIN" : "NOLOGIN"}`);
}

// ───────────────────────────────────────────────────────────────────────────
// The release's populated data
// ───────────────────────────────────────────────────────────────────────────
//
// Chosen so every data-reshaping migration between v0.5.0 and the branch has
// something to reshape, and so every row it must NOT touch is beside one it
// must: two collecting sessions for one subject (0068 closes the older), a
// member with two revisions of one take (0075 marks the newest final — D51
// keeps both), swarm.* schedule rows and jobs beside a vault one (0072), a
// notification job (0066), a judge enabled with no model (0056), and history
// rows in append-only tables.

/**
 * The swarm.* schedule kinds 0072 says it deletes, parsed from the migration — used ONLY
 * to check the migration against what the release seeded, never to decide what
 * to seed (that would make the data assertion circular: a kind the release
 * seeded and 0072 forgot would be neither seeded nor checked).
 */
function scheduleKindsDeletedBy0072(): string[] {
  const text = readFileSync(join(MIGRATIONS_DIR, "0072_drop_swarm_schedules.sql"), "utf8");
  const list = /DELETE FROM job_schedules\s+WHERE kind IN \(([^)]*)\)/.exec(text)?.[1] ?? "";
  const kinds = [...list.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
  if (kinds.length === 0) throw new Error("0072_drop_swarm_schedules.sql no longer names the schedule kinds it deletes");
  return kinds;
}

const SESSION_PUBLISHED = "00000000-0000-4000-8000-00000000a001";
const SESSION_OLD_OPEN = "00000000-0000-4000-8000-00000000a002";
const SESSION_NEW_OPEN = "00000000-0000-4000-8000-00000000a003";

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
  ('${SESSION_OLD_OPEN}',  'subj-1', 'Subject One', 'collecting', '2026-09-20T12:00:00Z', '2026-09-20T11:00:00Z', NULL),
  ('${SESSION_NEW_OPEN}',  'subj-1', 'Subject One', 'collecting', '2026-09-21T12:00:00Z', '2026-09-21T11:00:00Z', NULL);
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

describe("the release fixtures are the releases' own bytes", () => {
  for (const tag of SUPPORTED_RELEASES) {
    test(`${tag}: every file hashes to what the tag recorded`, () => {
      const release = loadRelease(tag);
      expect(release.tag).toBe(tag);
      expect(release.migrations.length).toBeGreaterThan(0);
      const drifted = release.migrations
        .filter(({ file, sha256: recorded }) => sha256(releaseBytes(tag, file)) !== recorded)
        .map(({ file }) => file);
      // A file edited on the branch after the tag needs its release bytes kept
      // under fixtures/releases/<tag>/migrations/ — never a re-recorded hash.
      expect(drifted).toEqual([]);
    });

    test(`${tag}: it records the swarm schedule and job kinds it seeded, and 0072 deletes every one of them`, () => {
      const { scheduleKinds, jobKinds } = loadRelease(tag).swarm;
      expect(scheduleKinds.length).toBeGreaterThan(0);
      // Every schedule kind is also a job kind: a seeded row only enqueues
      // kinds a handler was registered for.
      expect(scheduleKinds.filter((kind) => !jobKinds.includes(kind))).toEqual([]);
      const deletedSchedules = scheduleKindsDeletedBy0072();
      expect(scheduleKinds.filter((kind) => !deletedSchedules.includes(kind))).toEqual([]);
    });

    test(`${tag}: its migrations are a subset of the branch's — an upgrade never meets a file the branch lacks`, () => {
      const release = loadRelease(tag);
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
let savedRoles: RoleAttributes[] = [];
const created: string[] = [];

beforeAll(async () => {
  admin = connect("postgres");
  savedRoles = await roleAttributes(admin);

  // Blank + all migrations, given the real migrate run — the target every
  // upgrade must land on, and the side schema-equivalence.test.ts compares to
  // the snapshot.
  await admin.unsafe(`CREATE DATABASE ${REFERENCE_DB} TEMPLATE "${process.env.RM_TEST_TEMPLATE_DB}"`);
  created.push(REFERENCE_DB);
  reference = connect(REFERENCE_DB);
  await enrollRehearsal(reference);
  await migrateAsOwner(reference, REFERENCE_DB);
}, 120_000);

afterAll(async () => {
  await reference?.end({ timeout: 5 });
  try {
    await restoreRoleAttributes(admin, savedRoles);
    for (const name of created) await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  } finally {
    await admin.end({ timeout: 5 });
  }
});

for (const tag of SUPPORTED_RELEASES) {
  describe(`upgrade from ${tag}, populated`, () => {
    const name = `rm_upgrade_${tag.replace(/\W/g, "_")}_${suffix}`;
    let db: postgres.Sql<{}>;
    let release: ReleaseFixture;
    let pendingAtOrBelowBaseline: string[] = [];
    let appliedByRun: readonly string[] = [];
    /** True when the release predates 0063 — it has no deployment_identity,
     *  so runMigrate refuses it and the bridge must run first. */
    let predatesIdentity = false;

    beforeAll(async () => {
      release = loadRelease(tag);
      await admin.unsafe(`CREATE DATABASE ${name}`);
      created.push(name);
      db = connect(name);
      try {
        await applyAsReleaseRunner(
          db,
          release.migrations.map(({ file }) => ({ file, ddl: releaseBytes(tag, file).toString("utf8") })),
        );
      } finally {
        // The release's 0053 re-attributed the cluster's roles; put them back
        // before anything else in this process can observe them.
        await restoreRoleAttributes(admin, savedRoles);
      }
      await db.unsafe(releaseData(release));

      const recorded = new Set(release.migrations.map((m) => m.file));
      predatesIdentity = Math.max(...release.migrations.map((m) => migrationNumber(m.file))) < migrationNumber("0063_deployment_identity.sql");
      pendingAtOrBelowBaseline = HEAD_FILES.filter(
        (file) => !recorded.has(file) && migrationNumber(file) <= COMPAT_HEADER_BASELINE,
      );
    }, 120_000);

    afterAll(async () => {
      await db?.end({ timeout: 5 });
    });

    test("runMigrate refuses a release that predates 0063 — it has no deployment_identity to be enrolled in (reported gap)", async () => {
      const [table] = (await db`SELECT to_regclass('public.deployment_identity') IS NOT NULL AS present`) as unknown as {
        present: boolean;
      }[];
      // A release at or past 0063 has the table and meets no such refusal.
      expect(table?.present).toBe(!predatesIdentity);
      if (!predatesIdentity) return;
      await expect(migrateAsOwner(db, name)).rejects.toThrow("no deployment_identity row");
      await expect(migrateAsOwner(db, name, { ...MIGRATE_OPTIONS, caller: "operator", env: "prod", connection: "remote" })).rejects.toThrow(
        "no deployment_identity row",
      );
      // …and it refused before applying anything.
      const ledger = (await db`SELECT name FROM schema_migrations ORDER BY name`) as unknown as { name: string }[];
      expect(ledger.map((r) => r.name)).toEqual(release.migrations.map((m) => m.file));
    });

    test("bridge (when the release predates 0063), enrol, then the real migrate run reaches the branch's version", async () => {
      // Every pending file at or below the baseline is pre-compat: parsing its
      // header must not refuse (D53 decision 3), which is what lets the release
      // runner loop apply it without a declaration.
      for (const file of pendingAtOrBelowBaseline) {
        expect(() => parsePendingHeader(file, readFileSync(join(MIGRATIONS_DIR, file), "utf8"))).not.toThrow();
      }
      if (predatesIdentity) expect(pendingAtOrBelowBaseline).toContain("0063_deployment_identity.sql");
      await applyAsReleaseRunner(
        db,
        pendingAtOrBelowBaseline.map((file) => ({ file, ddl: readFileSync(join(MIGRATIONS_DIR, file), "utf8") })),
      );
      await enrollRehearsal(db);

      const result = await migrateAsOwner(db, name);
      appliedByRun = result.applied;
      const recorded = new Set(release.migrations.map((m) => m.file));
      expect(result.applied).toEqual(
        HEAD_FILES.filter((file) => !recorded.has(file) && migrationNumber(file) > COMPAT_HEADER_BASELINE),
      );
      expect(result.manifest.filenames).toEqual(HEAD_FILES);

      const ledger = (await db`SELECT name FROM schema_migrations ORDER BY name`) as unknown as { name: string }[];
      expect(ledger.map((r) => r.name)).toEqual(HEAD_FILES);
      expect((await readManifest(db))?.filenames).toEqual(HEAD_FILES);
    });

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
        if (appliedByRun.includes(row.name)) {
          expect({ name: row.name, compat: row.compat, version: row.metadata_version }).toEqual({
            name: row.name,
            compat: header!.compat,
            version: header!.metadataVersion,
          });
        } else {
          expect({ name: row.name, compat: row.compat }).toEqual({ name: row.name, compat: null });
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
      // 0066 drops `notified_at` (it is `breaking`); the row itself stays.
      expect(await rows(db`SELECT email, email_norm FROM swarm_waitlist`)).toEqual([
        { email: "Wait@Example.com", email_norm: "wait@example.com" },
      ]);
    });

    test("the subject gains its grid: defaults for the durations, the anchor from its open window (0067, 0073)", async () => {
      const [subject] = (await db`
        SELECT epoch_duration_seconds, judging_duration_seconds, epoch_anchor FROM swarm_subjects WHERE id = 'subj-1'`) as unknown as {
        epoch_duration_seconds: number;
        judging_duration_seconds: number;
        epoch_anchor: Date;
      }[];
      expect(subject?.epoch_duration_seconds).toBe(3600);
      expect(subject?.judging_duration_seconds).toBe(900);
      // 0068 leaves ONE collecting session per subject (the newest); 0073
      // anchors the grid on that window's close.
      expect(subject?.epoch_anchor.toISOString()).toBe("2026-09-21T12:00:00.000Z");
    });

    test("one collecting session per subject: the older is closed, the newest stays open, history untouched (0068)", async () => {
      expect(
        await rows(db`SELECT id, state, published_at IS NOT NULL AS published FROM swarm_sessions ORDER BY convened_at`),
      ).toEqual([
        { id: SESSION_PUBLISHED, state: "published", published: true },
        { id: SESSION_OLD_OPEN, state: "window_closed", published: false },
        { id: SESSION_NEW_OPEN, state: "collecting", published: false },
      ]);
    });

    test("every take and every revision survives with its signed content; the newest per member is final (0075, D51)", async () => {
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

    test("the vault schedule and its job survive; every swarm schedule row the release seeded is gone; no swarm job it queued is left pending; history stays (0066, 0072)", async () => {
      const { scheduleKinds, jobKinds } = release.swarm;
      // Only the vault row survives — so every seeded swarm.* row is gone,
      // whatever list 0072 happens to carry.
      expect(await rows(db`SELECT kind, cron, payload, enabled FROM job_schedules ORDER BY kind`)).toEqual([
        { kind: "vault.sample_share_price", cron: "0 * * * *", payload: { vault: "v1" }, enabled: true },
      ]);
      // A pending job whose handler is gone never settles: every swarm.* kind
      // the release could queue must leave the pending state, by deletion
      // (0072) or cancellation (0066).
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

    test("a self-written operator is cleared and recorded; an admin-written one is kept (0083, D55 (2))", async () => {
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
           WHERE actor = 'migration 0083' AND action = 'member_operator_cleared' ORDER BY target_id`),
      ).toEqual([{ target_id: "m-forged", before_state: { operator: "robotmoney" } }]);
    });

    test("the event log is numbered from its counter row, seeded from the log, and the job ledger is gone (0079-0081)", async () => {
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
    // migration. One such claim is wrong, surfaced by the data test above:
    // 0072 declares `compat: additive` while deleting the swarm.* job_schedules
    // rows and pending swarm.* jobs that code built at 0070 seeded and read
    // (0072:1, :45-52). §8.4: additive means "no bootstrap row it relies on is
    // removed". Code at 0070 passes the boot gate below against this database
    // and then schedules nothing.

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
  });
}
