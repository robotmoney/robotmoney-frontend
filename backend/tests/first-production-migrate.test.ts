// The first production migrate — smoke-production-spec.md §10 W2, verbatim:
//
//   "First production migrate: with no `deployment_identity` row and a ledger
//   exactly equal to the production baseline (the 76-name ledger of §9.1),
//   `RM_ENV=prod`, a typed `rm_owner` and `y` migrate once and receipt the
//   pre-identity state. A ledger with one file more or less (a pure v0.5.0
//   ledger included), `RM_ENV=stage`, a missing owner password, or any answer
//   but `y` refuses and changes nothing. A second run with no row still
//   refuses."
//
// As amended by D61: the typed `rm_owner` is `~/.env`'s `rm_owner` line and
// the `y` is `--confirm-target <host:port/database>`. A missing line, no flag
// and a wrong flag each refuse and change nothing. `RM_ENV=stage` on this
// state is now the remote rehearsal pass (D61 rule 2), which writes
// `rehearsal`; identity-first-pass.test.ts holds it. Here, stage on the
// baseline is only shown NOT to write `production`.
//
// And the next bullet's first half (D55 (9)): "Identity first: the production
// pass applies 0081 and commits its DDL, its ledger row and `production` in
// the same transaction, before any other migration." Its kill-and-rerun half
// and the normal path's acceptance of the state a pass leaves are
// identity-first-pass.test.ts's.
//
// Governed by §4.3's one exception and §9.1 ("The first production migrate
// runs before the identity row exists"), D55 (5) and (8); implemented by
// backend/scripts/migrate-run.ts (`readPreIdentityState`, the gates, and
// `runMigrate`'s hold on the confirmed state) with the ledger match in
// backend/src/db/supported-releases.ts.
//
// EVERY CASE IS THE OPERATOR'S COMMAND, AS A PROCESS. `bun run migrate` runs
// with no terminal (tests/fixtures/releases/release-fixture.ts
// `runMigrateCommand`), reading its target and its `rm_owner` line from a
// `$HOME/.env` and its confirmation from `--confirm-target` (D61). A refusal is
// judged by what the command printed, the journal the command left beside its
// receipt, and a database compared before and after — never by a module call.
//
// WHICH LEDGER IS "v0.5.0's". The gate's text predates the read of
// production's ledger: production holds v0.5.0's 72 files plus
// 0061_rm_worker_wallet_backfill_grant.sql, 0062_rm_readonly_sequence_select.sql,
// 0063_swarm_judge_model_default.sql and 0080_analytics_ledger_compaction.sql
// (read 2026-10-01), and the owner ruled that observed set the one supported
// baseline (backend/src/db/supported-releases.ts). So "exact" below is that
// set. v0.5.0's pure list, and the same set with one file missing, refuse.
//
// THE DATABASES. The baseline predates 0081, so its database has no
// `deployment_identity` table at all, which is the case production is in. It
// is built from the baseline's own bytes (v0.5.0's tag, then the four files
// production added, as it ran them) by v0.5.0's runner loop, once, without its
// last file; the ledger variants are copies of that one:
//   exact    — plus the last file: the ledger IS production's observed list;
//   less     — as built: 75 names, one file missing;
//   renamed  — plus the last file's DDL recorded under another name;
//   more     — exact plus the first branch file the baseline lacks, applied;
//   v050     — v0.5.0's pure list: four files missing.
// §9.1 step 1 (`rm_owner LOGIN PASSWORD …` through the provisioning login) is
// performed on the cluster first, as it must be before any migrate run.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { adminUrl, harnessConnection, restoreRoleBaselineAfterAll } from "./support/cluster.ts";
import { IDENTITY_MIGRATION, runMigrate } from "../scripts/migrate-run.ts";
import type { MigrateJournalFile } from "../scripts/migrate-journal.ts";
import { SUPPORTED_RELEASES } from "../src/db/supported-releases.ts";
import {
  HEAD_FILES,
  MIGRATIONS_DIR,
  applyAsReleaseRunner,
  loadBaseline,
  loadRelease,
  operatorTarget,
  releaseSteps,
  restoreLogins,
  restoreRoles,
  revokeLoginDefaults,
  runMigrateCommand,
  saveRoles,
  type MigrateRun,
  type SavedRole,
} from "./fixtures/releases/release-fixture.ts";
import { withTargetLock } from "./support/target-lock.ts";

const TAG = SUPPORTED_RELEASES[0]!.name;
const release = loadBaseline(TAG);
const RELEASE_FILES = release.migrations.map((m) => m.file);
const LAST = RELEASE_FILES.at(-1)!;
/** The first branch file the baseline lacks, in apply order — the "one file more". */
const FIRST_UNSHIPPED = HEAD_FILES.find((file) => !RELEASE_FILES.includes(file))!;
const RENAMED = LAST.replace(/\.sql$/, "_renamed.sql");

const LOGIN = new URL(adminUrl()).username;
const OWNER_PASSWORD = randomBytes(18).toString("base64url");
const READONLY_PASSWORD = randomBytes(12).toString("hex");

const suffix = randomBytes(4).toString("hex");
const DB = {
  base: `rm_fpm_base_${suffix}`,
  exact: `rm_fpm_exact_${suffix}`,
  less: `rm_fpm_less_${suffix}`,
  v050: `rm_fpm_v050_${suffix}`,
  renamed: `rm_fpm_renamed_${suffix}`,
  more: `rm_fpm_more_${suffix}`,
  norow: `rm_fpm_norow_${suffix}`,
  tablenorow: `rm_fpm_tablenorow_${suffix}`,
} as const;

function urlFor(database: string, role?: { name: string; password: string }): URL {
  const url = new URL(adminUrl());
  url.pathname = `/${database}`;
  if (role) {
    url.username = role.name;
    url.password = encodeURIComponent(role.password);
  }
  return url;
}

function connect(database: string): postgres.Sql<{}> {
  return postgres(urlFor(database).toString(), { max: 1, onnotice: () => {} });
}

// cluster admin: it builds the baseline as the provisioning login (release DDL alters roles,
// superuser-only), saves/restores/alters roles, and creates/drops databases.
let admin: postgres.Sql<{}>;
let saved: SavedRole[] = [];
const homes: string[] = [];

async function withDb<T>(database: string, body: (db: postgres.Sql<{}>) => Promise<T>): Promise<T> {
  const db = connect(database);
  try {
    return await body(db);
  } finally {
    await db.end({ timeout: 5 });
  }
}

/** Everything a refused run must leave exactly as it was. */
async function fingerprint(database: string): Promise<{ ledger: string[]; relations: string[] }> {
  const owner = harnessConnection(database);
  try {
    return await readFingerprint(owner);
  } finally {
    await owner.end({ timeout: 5 });
  }
}

async function readFingerprint(db: postgres.Sql<{}>): Promise<{ ledger: string[]; relations: string[] }> {
  return ({
    ledger: ((await db`SELECT name FROM schema_migrations ORDER BY name`) as unknown as { name: string }[]).map((r) => r.name),
    relations: (
      (await db`
        SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' ORDER BY c.relname`) as unknown as { relname: string }[]
    ).map((r) => r.relname),
  });
}

/** What the operator's ~/.env and argv carry (D61): the rm_owner line, or
 *  `null` for none; the --confirm-target, exact by default, `null` for none. */
interface Authority {
  readonly owner?: string | null;
  readonly confirm?: string | null;
}

async function operator(database: string, rmEnv: string, authority: Authority = {}): Promise<MigrateRun> {
  const run = await runMigrateCommand({
    databaseUrl: urlFor(database),
    readonlyPassword: READONLY_PASSWORD,
    ownerPassword: authority.owner === undefined ? OWNER_PASSWORD : authority.owner,
    rmEnv,
    ...(authority.confirm === undefined ? {} : { confirmTarget: authority.confirm }),
  });
  homes.push(run.home);
  return run;
}

function journalOf(run: MigrateRun): MigrateJournalFile {
  const names = readdirSync(run.receiptDir).filter((name) => name.startsWith("migrate-journal-"));
  expect(names.length).toBe(1);
  return JSON.parse(readFileSync(join(run.receiptDir, names[0]!), "utf8")) as MigrateJournalFile;
}

/** A refusal, judged the three ways the header names. */
async function expectRefusedAndUnchanged(
  database: string,
  run: MigrateRun,
  before: Awaited<ReturnType<typeof fingerprint>>,
  phase: string,
): Promise<void> {
  expect(run.code).not.toBe(0);
  expect(existsSync(run.receiptPath)).toBe(false);
  const journal = journalOf(run);
  expect({ outcome: journal.outcome, phase: journal.phases.at(-1)?.phase }).toEqual({ outcome: "refused", phase });
  expect(await fingerprint(database)).toEqual(before);
  expect(run.screen).not.toContain(OWNER_PASSWORD);
}

beforeAll(async () => {
  admin = connect("postgres");
  saved = await saveRoles(admin);
  const steps = releaseSteps(release);
  const lastStep = steps.at(-1)!;

  await admin.unsafe(`CREATE DATABASE ${DB.base}`);
  try {
    await withDb(DB.base, (db) => applyAsReleaseRunner(db, steps.slice(0, -1)));
  } finally {
    // v0.5.0's 0053 re-attributed the cluster's roles (NOLOGIN for rm_owner);
    // put them back before anything else in this process can observe them.
    await restoreLogins(admin, saved);
  }
  for (const name of [DB.exact, DB.less, DB.renamed]) {
    await admin.unsafe(`CREATE DATABASE ${name} TEMPLATE ${DB.base}`);
  }
  await admin.unsafe(`CREATE DATABASE ${DB.v050}`);
  try {
    await withDb(DB.v050, (db) => applyAsReleaseRunner(db, releaseSteps(loadRelease("v0.5.0"))));
  } finally {
    await restoreLogins(admin, saved);
  }
  await withDb(DB.exact, (db) => applyAsReleaseRunner(db, [lastStep]));
  await withDb(DB.renamed, (db) => applyAsReleaseRunner(db, [{ file: RENAMED, ddl: lastStep.ddl }]));
  await admin.unsafe(`CREATE DATABASE ${DB.more} TEMPLATE ${DB.exact}`);
  await withDb(DB.more, (db) =>
    applyAsReleaseRunner(db, [{ file: FIRST_UNSHIPPED, ddl: readFileSync(join(MIGRATIONS_DIR, FIRST_UNSHIPPED), "utf8") }]),
  );
  await withDb(DB.exact, (db) => revokeLoginDefaults(db, LOGIN));
  // tablenorow — exact, plus a deployment_identity table made out of band:
  // 0081's DDL with no ledger row and no identity row.
  await admin.unsafe(`CREATE DATABASE ${DB.tablenorow} TEMPLATE ${DB.exact}`);
  const tablenorow = harnessConnection(DB.tablenorow);
  try {
    await tablenorow.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE rm_owner");
      await tx.unsafe(readFileSync(join(MIGRATIONS_DIR, IDENTITY_MIGRATION), "utf8"));
    });
  } finally {
    await tablenorow.end({ timeout: 5 });
  }

  // §9.1 step 1, through the provisioning login: rm_owner LOGIN with the
  // password the host's ~/.env holds (D61), and the rm_readonly line beside it.
  await admin.unsafe(`ALTER ROLE rm_owner LOGIN PASSWORD '${OWNER_PASSWORD}'`);
  await admin.unsafe(`ALTER ROLE rm_readonly LOGIN PASSWORD '${READONLY_PASSWORD}'`);
}, 180_000);

afterAll(async () => {
  try {
    await restoreRoles(admin, saved);
    for (const name of Object.values(DB)) await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  } finally {
    await admin.end({ timeout: 5 });
    for (const home of homes) rmSync(home, { recursive: true, force: true });
  }
});

describe("the fixtures are the §10 gate's cases", () => {
  test("SUPPORTED_RELEASES is production's observed ledger alone, and `exact` records exactly its list with no identity table", async () => {
    expect(SUPPORTED_RELEASES.map((r) => r.name)).toEqual([TAG]);
    expect(LAST).toBe("0080_analytics_ledger_compaction.sql");
    expect(RELEASE_FILES).toHaveLength(76);
    const exact = await fingerprint(DB.exact);
    expect(exact.ledger).toEqual([...SUPPORTED_RELEASES[0]!.migrations]);
    expect(exact.relations).not.toContain("deployment_identity");
    expect(exact.relations).not.toContain("schema_manifest");
  });

  test("each variant differs from the baseline's list by exactly one file, and `v050` is v0.5.0's pure list", async () => {
    const list = SUPPORTED_RELEASES[0]!.migrations;
    expect((await fingerprint(DB.less)).ledger).toEqual(list.filter((file) => file !== LAST));
    expect((await fingerprint(DB.v050)).ledger).toEqual(loadRelease("v0.5.0").migrations.map((m) => m.file));
    expect((await fingerprint(DB.more)).ledger).toEqual([...list, FIRST_UNSHIPPED].sort());
    expect((await fingerprint(DB.renamed)).ledger).toEqual([...list.filter((file) => file !== LAST), RENAMED].sort());
  });
});

describe("the baseline is production's state, not only its ledger", () => {
  // Production ran c3a68812's SQL for 0062_rm_readonly_sequence_select.sql,
  // verified on the replica 2026-09-25: rm_worker holds INSERT and UPDATE on
  // the three sampler tables, which v0.5.0 never grants. The fixture replays
  // the archive tag's bytes, so `exact` must show the same grants and `v050`
  // (v0.5.0 alone) must not; a replay of 61fab107's bytes would fail here.
  const SAMPLER_TABLES = ["asset_prices", "asset_price_floors", "chain_address_floors"];
  async function workerWrites(database: string): Promise<boolean[]> {
    return withDb(database, async (db) =>
      Promise.all(
        SAMPLER_TABLES.map(async (table) => {
          const [row] = (await db`
            SELECT has_table_privilege('rm_worker', ${`public.${table}`}, 'INSERT')
               AND has_table_privilege('rm_worker', ${`public.${table}`}, 'UPDATE') AS ok`) as unknown as { ok: boolean }[];
          return row?.ok === true;
        }),
      ),
    );
  }

  test("exact: rm_worker may INSERT and UPDATE the three sampler tables, as on production", async () => {
    expect(await workerWrites(DB.exact)).toEqual([true, true, true]);
  });

  test("red control — v0.5.0 alone: it may not", async () => {
    expect(await workerWrites(DB.v050)).toEqual([false, false, false]);
  });
});

describe("§10 W2 — First production migrate", () => {
  test("RM_ENV=stage never writes `production`: on this state it is the remote rehearsal pass (D61), held here to a wrong target so nothing changes", async () => {
    const before = await fingerprint(DB.exact);
    const run = await operator(DB.exact, "stage", { confirm: "not-this-target:5432/x" });
    expect(run.screen).toContain("REMOTE REHEARSAL PASS");
    expect(run.screen).toContain("writes `rehearsal`");
    expect(run.screen).not.toContain("FIRST PRODUCTION MIGRATE");
    await expectRefusedAndUnchanged(DB.exact, run, before, "confirm");
  });

  test("a ledger with one file MORE refuses at the gates, naming the extra file, and changes nothing", async () => {
    const before = await fingerprint(DB.more);
    const run = await operator(DB.more, "prod");
    expect(run.screen).toContain(`1 extra (${FIRST_UNSHIPPED})`);
    await expectRefusedAndUnchanged(DB.more, run, before, "gates");
  });

  test("a ledger with one file LESS (75 names) refuses at the gates, naming the missing file, and changes nothing", async () => {
    const before = await fingerprint(DB.less);
    const run = await operator(DB.less, "prod");
    expect(run.screen).toContain(`1 missing (${LAST})`);
    await expectRefusedAndUnchanged(DB.less, run, before, "gates");
  });

  test("v0.5.0's pure list refuses at the gates, naming the four files it lacks, and changes nothing", async () => {
    const before = await fingerprint(DB.v050);
    const run = await operator(DB.v050, "prod");
    expect(run.screen).toContain(
      "4 missing (0061_rm_worker_wallet_backfill_grant.sql, 0062_rm_readonly_sequence_select.sql, 0063_swarm_judge_model_default.sql, 0080_analytics_ledger_compaction.sql)",
    );
    await expectRefusedAndUnchanged(DB.v050, run, before, "gates");
  });

  test("a ledger with one file RENAMED refuses at the gates, naming both names, and changes nothing", async () => {
    const before = await fingerprint(DB.renamed);
    const run = await operator(DB.renamed, "prod");
    expect(run.screen).toContain(`1 missing (${LAST})`);
    expect(run.screen).toContain(`1 extra (${RENAMED})`);
    await expectRefusedAndUnchanged(DB.renamed, run, before, "gates");
  });

  test("a deployment_identity table with NO row and the exact baseline ledger refuses at the gates, before any password is asked for", async () => {
    // Criterion 170 admits the pass only with no table at all. The baseline
    // predates 0081, so a table with no row was made out of band; the pass
    // would refuse it under its fence, so the gates refuse it first.
    const before = await fingerprint(DB.tablenorow);
    const run = await operator(DB.tablenorow, "prod");
    expect(run.screen).toContain("deployment_identity exists with no row");
    await expectRefusedAndUnchanged(DB.tablenorow, run, before, "gates");
  });

  test("D61: a missing rm_owner line in ~/.env refuses, naming the key and the file, and changes nothing", async () => {
    const before = await fingerprint(DB.exact);
    const run = await operator(DB.exact, "prod", { owner: null });
    expect(run.screen).toContain(`${join(run.home, ".env")} has no rm_owner line`);
    await expectRefusedAndUnchanged(DB.exact, run, before, "owner");
  });

  test("D61: no --confirm-target refuses and changes nothing", async () => {
    const before = await fingerprint(DB.exact);
    const run = await operator(DB.exact, "prod", { confirm: null });
    expect(run.screen).toContain("FIRST PRODUCTION MIGRATE");
    expect(run.screen).toContain("no --confirm-target was given");
    await expectRefusedAndUnchanged(DB.exact, run, before, "confirm");
  });

  for (const wrong of ["db.example.invalid:25060/robotmoney", "UPPER", ""]) {
    test(`D61: --confirm-target ${JSON.stringify(wrong)} — anything but the exact target — refuses, prints both, and changes nothing`, async () => {
      const before = await fingerprint(DB.exact);
      const confirm = wrong === "UPPER" ? operatorTarget(urlFor(DB.exact)).toUpperCase() : wrong;
      const run = await operator(DB.exact, "prod", { confirm });
      // The warning named what the flag would have confirmed.
      expect(run.screen).toContain("FIRST PRODUCTION MIGRATE");
      expect(run.screen).toContain(`equals ${TAG}'s ${RELEASE_FILES.length} files`);
      expect(run.screen).toContain(JSON.stringify(operatorTarget(urlFor(DB.exact))));
      await expectRefusedAndUnchanged(DB.exact, run, before, "confirm");
    });
  }

  test("red control: the run itself, reached around the command with no confirmation, refuses on a qualifying database", async () => {
    // `runMigrate` is exported; a caller that skipped `migrateCommand`'s owner
    // line and `--confirm-target` would otherwise get the exception from the
    // gates alone.
    const before = await fingerprint(DB.exact);
    const owner = postgres(urlFor(DB.exact, { name: "rm_owner", password: OWNER_PASSWORD }).toString(), {
      max: 1,
      onnotice: () => {},
    });
    try {
      await expect(
        withTargetLock(urlFor(DB.exact).toString(), (lock) =>
          runMigrate(owner, { caller: "operator", env: "prod", connection: "remote", lock }),
        ),
      ).rejects.toThrow("no run confirmed it");
    } finally {
      await owner.end({ timeout: 5 });
    }
    expect(await fingerprint(DB.exact)).toEqual(before);
  });

  test("no row, production's exact observed ledger, RM_ENV=prod, ~/.env's rm_owner and the exact --confirm-target: migrates once, identity first, and receipts the pre-identity state", async () => {
    const run = await operator(DB.exact, "prod");
    expect({ code: run.code, tail: run.code === 0 ? "" : run.screen.slice(-3000) }).toEqual({ code: 0, tail: "" });
    expect(run.screen).not.toContain(OWNER_PASSWORD);

    const receipt = JSON.parse(readFileSync(run.receiptPath, "utf8")) as {
      applied: string[];
      baselined: boolean;
      preIdentity: { identity: string; release: string; ledger: string[] } | null;
      identityWritten: { kind: string; writtenBy: string } | null;
      manifest: { filenames: string[] };
    };
    // §9.1: "no identity row existed, the supported release the ledger
    // matched, and that ledger's filename list".
    expect(receipt.preIdentity).toEqual({ identity: "no table", release: TAG, ledger: RELEASE_FILES });
    // D55 (9): 0081 FIRST, out of filename order; then every other pending
    // file in filename order — the five the baseline lacks below 0081 included.
    const pending = HEAD_FILES.filter((file) => !RELEASE_FILES.includes(file));
    expect(receipt.applied).toEqual([IDENTITY_MIGRATION, ...pending.filter((file) => file !== IDENTITY_MIGRATION)]);
    expect(receipt.applied.slice(1, 6)).toEqual([
      "0056_swarm_judge_requires_model.sql",
      "0057_swarm_judge_policy_stamp.sql",
      "0058_swarm_judge_fault_injection.sql",
      "0059_swarm_judgement_completion_usage.sql",
      "0062_rm_worker_analytics_ledger_read_grant.sql",
    ]);
    expect(receipt.identityWritten).toMatchObject({ kind: "production", writtenBy: "rm_owner" });
    expect(receipt.baselined).toBe(true);
    expect(receipt.manifest.filenames).toEqual(HEAD_FILES);
    expect(journalOf(run).outcome).toBe("succeeded");

    const after = await fingerprint(DB.exact);
    expect(after.ledger).toEqual(HEAD_FILES);
    await withDb(DB.exact, async (db) => {
      // §9.1 step 4, D55 (9): `production`, written by rm_owner...
      expect([...(await db`SELECT kind, written_by FROM deployment_identity`)]).toEqual([{ kind: "production", written_by: "rm_owner" }]);
      // ...in the SAME transaction as 0081's ledger row: the two rows carry one
      // creating transaction id and one transaction timestamp. (The table's
      // own pg_class row is rewritten by every later grant, so its xmin says
      // nothing; a killed pass is identity-first-pass.test.ts's proof that the
      // DDL rolls back with the rows.)
      const [same] = (await db`
        SELECT (SELECT xmin::text FROM schema_migrations WHERE name = ${IDENTITY_MIGRATION}) AS ledger_xid,
               (SELECT xmin::text FROM deployment_identity) AS row_xid,
               (SELECT applied_at FROM schema_migrations WHERE name = ${IDENTITY_MIGRATION})
                 = (SELECT written_at FROM deployment_identity) AS same_instant`) as unknown as {
        ledger_xid: string;
        row_xid: string;
        same_instant: boolean;
      }[];
      expect(same!.row_xid).toBe(same!.ledger_xid);
      expect(same!.same_instant).toBe(true);
      // ...and BEFORE every other file this run applied.
      const [later] = (await db`
        SELECT count(*)::int AS n FROM schema_migrations
         WHERE name = ANY(${receipt.applied.slice(1)})
           AND applied_at <= (SELECT applied_at FROM schema_migrations WHERE name = ${IDENTITY_MIGRATION})`) as unknown as {
        n: number;
      }[];
      expect(later!.n).toBe(0);
    });
  }, 180_000);

  test("the next run is an ordinary one: the row exists, so no exception is taken and nothing is pending", async () => {
    const run = await operator(DB.exact, "prod");
    expect({ code: run.code, tail: run.code === 0 ? "" : run.screen.slice(-3000) }).toEqual({ code: 0, tail: "" });
    expect(run.screen).not.toContain("FIRST PRODUCTION MIGRATE");
    const receipt = JSON.parse(readFileSync(run.receiptPath, "utf8")) as {
      applied: string[];
      preIdentity: unknown;
      identityWritten: unknown;
      resumedAfterIdentityPass: unknown;
    };
    // The rows before 0081 still equal the baseline, but a published manifest
    // means no resume happened: the receipt must not claim one.
    expect(receipt).toMatchObject({ applied: [], preIdentity: null, identityWritten: null, resumedAfterIdentityPass: null });
    expect(run.screen).not.toContain("resumed after the identity-first pass");
  }, 180_000);

  test("a second run with no row still refuses: its ledger no longer equals the baseline's", async () => {
    // The first run leaves its row, so "no row" is built: a copy of that
    // database, the row removed on the copy by rm_owner, the table's owner.
    await admin.unsafe(`CREATE DATABASE ${DB.norow} TEMPLATE ${DB.exact}`);
    const owner = postgres(urlFor(DB.norow, { name: "rm_owner", password: OWNER_PASSWORD }).toString(), { max: 1, onnotice: () => {} });
    try {
      await owner`DELETE FROM deployment_identity`;
    } finally {
      await owner.end({ timeout: 5 });
    }
    const before = await fingerprint(DB.norow);
    const run = await operator(DB.norow, "prod");
    expect(run.screen).toContain("no deployment_identity row");
    expect(run.screen).toContain("matches none");
    await expectRefusedAndUnchanged(DB.norow, run, before, "gates");
  });
});

// A role's password is cluster state that outlives this file; put the baseline back (tests/support/cluster.ts).
restoreRoleBaselineAfterAll();
