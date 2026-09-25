// An upgrade from a populated database of each supported release passes its
// data assertions; code at N boots against N+additive — two of spec §8.4's CI
// proofs (smoke-production-spec.md §8.4, issue #1026 criterion 50).
//
// ─────────────────────────────────────────────────────────────────────────────
// WHICH RELEASES, AND WHERE THEIR SCHEMA COMES FROM
// ─────────────────────────────────────────────────────────────────────────────
//
// SUPPORTED_RELEASES (backend/src/db/supported-releases.ts) is one baseline:
// production's observed ledger, read 2026-09-25 — the 72 files of v0.5.0 plus
// 0062_rm_readonly_sequence_select.sql, applied out of band from the archived
// 0.5.x line on 2026-09-22 (owner-ruled ground truth; it supersedes D55 (8)'s
// "v0.5.0 alone"). An upgrade path from anything else is one no database will
// take. That module pins the baseline's filename list; the tests below fail
// when it disagrees with the observed ledger in
// fixtures/releases/production-2026-09-25/baseline.json or with v0.5.0's
// release.json plus the out-of-band file. Adding a baseline is a new decision,
// one fixture directory and one entry there ONLY for a target built by v0.5.0's runner
// loop (`applyAsReleaseRunner`), which records no compat declaration. A release
// whose own runner recorded compat (anything shipped with 0064's runMigrate)
// also needs that runner modelled here, or its ledger rows above the baseline
// read NULL. What depends on whether the release predates 0063 — the first
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
// The baseline predates 0063, so its database has no `deployment_identity`
// table and no row to enroll it. The upgrade runs exactly as production's will (spec
// §9.1, D55 (5)): `bun run migrate` as a PROCESS under a terminal, RM_ENV=prod,
// the rm_owner password typed at the masked prompt, an explicit `y` — the one
// run §4.3 allows without the row, because the ledger equals the baseline's
// filename list exactly. It applies EVERY pending file, including the pre-compat ones at
// or below 0063 (their compat stays NULL, D53 decision 3), reconciles grants,
// compares the live schema with the snapshot (§9.1 step 2) and publishes the
// first manifest. Nothing is applied around the command. The refusals that
// guard that exception are first-production-migrate.test.ts's subject; the one
// pinned here is that no other caller reaches a release: `--migrate` and a run
// with no typed confirmation refuse it before applying anything.
//
// Everything asserted about data below is asserted AFTER that real run.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
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
import { SUPPORTED_RELEASES } from "../src/db/supported-releases.ts";
import { runMigrate, type MigrateGateOptions } from "../scripts/migrate-run.ts";
import {
  HEAD_FILES,
  MIGRATIONS_DIR,
  applyAsReleaseRunner,
  fixtureBytes,
  loadBaseline,
  loadRelease,
  migrateAtTerminal,
  releaseSteps,
  restoreLogins,
  restoreRoles,
  revokeLoginDefaults,
  saveRoles,
  type ReleaseFixture,
  type SavedRole,
} from "./fixtures/releases/release-fixture.ts";
import { withTargetLock } from "./support/target-lock.ts";
import { describeCatalogDiff, diffCatalogs, normalizedCatalog } from "./support/catalog-normalize.ts";

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

const LOGIN = new URL(config.databaseUrl).username;
const OWNER_PASSWORD = randomBytes(18).toString("base64url");
const READONLY_PASSWORD = randomBytes(12).toString("hex");

function urlFor(database: string, role?: { name: string; password: string }): string {
  const url = new URL(config.databaseUrl);
  url.pathname = `/${database}`;
  if (role) {
    url.username = role.name;
    url.password = encodeURIComponent(role.password);
  }
  return url.toString();
}

function connect(database: string, role?: { name: string; password: string }): postgres.Sql<{}> {
  return postgres(urlFor(database, role), { max: 1, onnotice: () => {} });
}

const MIGRATE_OPTIONS: MigrateGateOptions & { nonInteractive: boolean } = {
  caller: "smoke_flag",
  env: "stage",
  connection: "local",
  nonInteractive: true,
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
  await revokeLoginDefaults(db, LOGIN);
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

describe("the baseline fixtures are the targets' own ledgers and bytes", () => {
  test("SUPPORTED_RELEASES is production's observed ledger alone (2026-09-25), and it has a fixture", () => {
    expect(SUPPORTED_RELEASES.map((r) => r.name)).toEqual([
      "v0.5.0+0062_rm_readonly_sequence_select (production ledger 2026-09-25)",
    ]);
  });

  for (const { name: tag, release: releaseTag, outOfBand, migrations } of SUPPORTED_RELEASES) {
    test(`${tag}: SUPPORTED_RELEASES pins exactly the ledger read from the target`, () => {
      // The first production migrate matches a ledger against this list (§9.1,
      // D55 (5)); a list that drifted from what production recorded would
      // refuse production, or admit a ledger production never wrote.
      const baseline = loadBaseline(tag);
      expect([...migrations]).toEqual(baseline.ledger.map((row) => row.file));
      expect(baseline.ledger.length).toBe(73);
      expect(baseline.release).toBe(releaseTag);
    });

    test(`${tag}: it is its release's filename list plus exactly its out-of-band files`, () => {
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

    test(`${tag}: the branch's copy of each out-of-band file runs the same SQL as the archived one`, () => {
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

    test(`${tag}: it records the swarm schedule and job kinds it seeded, and 0072 deletes every one of them`, () => {
      const { scheduleKinds, jobKinds } = loadBaseline(tag).swarm;
      expect(scheduleKinds.length).toBeGreaterThan(0);
      // Every schedule kind is also a job kind: a seeded row only enqueues
      // kinds a handler was registered for.
      expect(scheduleKinds.filter((kind) => !jobKinds.includes(kind))).toEqual([]);
      const deletedSchedules = scheduleKindsDeletedBy0072();
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
  admin = connect("postgres");
  savedRoles = await saveRoles(admin);

  // Blank + all migrations, given the real migrate run — the target every
  // upgrade must land on, and the side schema-equivalence.test.ts compares to
  // the snapshot.
  await admin.unsafe(`CREATE DATABASE ${REFERENCE_DB} TEMPLATE "${process.env.RM_TEST_TEMPLATE_DB}"`);
  created.push(REFERENCE_DB);
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

for (const [index, { name: tag }] of SUPPORTED_RELEASES.entries()) {
  describe(`upgrade from ${tag}, populated`, () => {
    const name = `rm_upgrade_${index}_${suffix}`;
    let db: postgres.Sql<{}>;
    let release: ReleaseFixture;
    let appliedByRun: readonly string[] = [];
    /** True when the release predates 0063 — it has no deployment_identity
     *  table, so its upgrade is the first production migrate of §9.1. */
    let predatesIdentity = false;

    beforeAll(async () => {
      release = loadBaseline(tag);
      await admin.unsafe(`CREATE DATABASE ${name}`);
      created.push(name);
      db = connect(name);
      try {
        await applyAsReleaseRunner(db, releaseSteps(release));
      } finally {
        // The release's 0053 re-attributed the cluster's roles; put them back
        // before anything else in this process can observe them.
        await restoreLogins(admin, savedRoles);
      }
      await db.unsafe(releaseData(release));
      await revokeLoginDefaults(db, LOGIN);
      predatesIdentity = Math.max(...release.migrations.map((m) => migrationNumber(m.file))) < migrationNumber("0063_deployment_identity.sql");

      // §9.1 step 1 through the provisioning login, and the host's rm_readonly
      // line: what the operator's `bun run migrate` logs in with.
      await admin.unsafe(`ALTER ROLE rm_owner LOGIN PASSWORD '${OWNER_PASSWORD}'`);
      await admin.unsafe(`ALTER ROLE rm_readonly LOGIN PASSWORD '${READONLY_PASSWORD}'`);
    }, 120_000);

    afterAll(async () => {
      await db?.end({ timeout: 5 });
    });

    test("no caller but the operator's confirmed first production migrate reaches a release that predates 0063", async () => {
      const [table] = (await db`SELECT to_regclass('public.deployment_identity') IS NOT NULL AS present`) as unknown as {
        present: boolean;
      }[];
      expect(table?.present).toBe(!predatesIdentity);
      if (!predatesIdentity) return;
      // `--migrate` never has §4.3's exception.
      await expect(migrateAsOwner(db, name)).rejects.toThrow("no deployment_identity row");
      // The run reached around the command, with no typed y behind it.
      const owner = connect(name, { name: "rm_owner", password: OWNER_PASSWORD });
      try {
        await expect(
          withTargetLock(urlFor(name), (lock) =>
            runMigrate(owner, { caller: "operator", env: "prod", connection: "remote", nonInteractive: false, lock }),
          ),
        ).rejects.toThrow("no operator confirmed it");
      } finally {
        await owner.end({ timeout: 5 });
      }
      // …and each refused before applying anything.
      const ledger = (await db`SELECT name FROM schema_migrations ORDER BY name`) as unknown as { name: string }[];
      expect(ledger.map((r) => r.name)).toEqual(release.migrations.map((m) => m.file));
    });

    test("`bun run migrate` — RM_ENV=prod, a typed rm_owner, y — reaches the branch's version in one run", async () => {
      // A release past 0063 would be enrolled already (§9.1 step 4); only one
      // that predates the table takes the pre-identity path.
      if (!predatesIdentity) await enroll(db, "production");
      const run = await migrateAtTerminal({
        databaseUrl: new URL(urlFor(name)),
        readonlyPassword: READONLY_PASSWORD,
        rmEnv: "prod",
        steps: [
          { await: "rm_owner password (not echoed", send: OWNER_PASSWORD },
          { await: "type y to continue", send: "y" },
        ],
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
      // Every pending file, the pre-compat ones at or below 0063 included: no
      // file is applied around the command any more.
      expect(receipt.applied).toEqual(HEAD_FILES.filter((file) => !recorded.has(file)));
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
        // (parsePendingHeader throws when one does not), and runs after 0064
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

    test("0072 is recorded `breaking`: it deletes rows code at 0070 seeded and read (D55 (7))", async () => {
      // The release predates 0072, so this run applied it and recorded the
      // header it carries now. §8.4: removing a bootstrap row old code relies
      // on is not additive.
      expect(
        await rows(db`SELECT name, compat, metadata_version FROM schema_migrations WHERE name = '0072_drop_swarm_schedules.sql'`),
      ).toEqual([{ name: "0072_drop_swarm_schedules.sql", compat: "breaking", metadata_version: 1 }]);
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
    // migration. One such claim was wrong, surfaced by the data test above:
    // 0072 declared `compat: additive` while deleting the swarm.* job_schedules
    // rows and pending swarm.* jobs that code built at 0070 seeded and read.
    // §8.4: additive means "no bootstrap row it relies on is removed". D55 (7)
    // relabelled it `breaking`, so this run records `breaking` for it and code
    // at 0070 is refused by check 3b. A ledger that recorded 0072 before the
    // relabel keeps `additive`; 0079-0081, all `breaking`, close that rollback.

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
