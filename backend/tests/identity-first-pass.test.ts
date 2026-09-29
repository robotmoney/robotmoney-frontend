// The identity-first pass and the normal path that follows it —
// smoke-production-spec.md §9.1 ("Identity first", "The normal path accepts the
// state the pass leaves") and §10 W2, D55 (9); issue #1026 criterion 170.
//
//   §10 W2: "Kill and rerun, for each of the three passes: kill it before 0063
//   commits, and the rerun takes the pass again; kill it after 0063, and the
//   rerun resumes through the normal path and applies the six files below 0063
//   (§9.1)."
//   §10 W2: "The normal path applies a pending file below a recorded 0063 only
//   when the identity row exists and the rest of the ledger equals the baseline
//   plus 0063, plus files applied after it; every other out-of-order state
//   refuses."
//   §10 W2: "Applying 0063 out of order outside the three passes of §4.3
//   refuses."
//
// This file holds the PRODUCTION pass's kill-and-rerun (`bun run migrate`) and
// the normal path's acceptance rule. The `--local dump` pass's kill-and-rerun is
// scripts/tests/integration/smoke-dump-identity-first.test.ts's; the remote
// twin pass is not built (issue #1026, the owner question
// 'remote-twin-restore').
//
// A KILL IS A CRASH. `bun run migrate` runs as a process under a
// pseudo-terminal (fixtures/releases/release-fixture.ts
// `startMigrateAtTerminal`), the operator types rm_owner and `y`, and the test
// SIGKILLs the migrate process while one of its statements is blocked on a lock
// the test holds: no exit handler, no lock release, no journal close runs.
//   - BEFORE 0063 COMMITS: the test holds an uncommitted ledger row under
//     0063's name, invisible to every read, so the pass's own ledger INSERT —
//     the statement after 0063's DDL, inside 0063's transaction — waits on the
//     test's transaction. The process dies with 0063's transaction open, so
//     the DDL rolls back with it.
//   - AFTER 0063 COMMITS: the test holds SHARE on swarm_judge_config, which
//     0063's transaction never touches and the next file,
//     0056_swarm_judge_requires_model.sql, UPDATEs first. The process dies with
//     0063 committed and 0056's transaction open.
// The blocked backend outlives its client until it next talks to it, so the
// test releases its lock and waits for every rm_owner backend to end before it
// reads what was left.
//
// THE DATABASES. The production baseline (D55 (8)), built from its own bytes by
// v0.5.0's runner loop exactly as first-production-migrate.test.ts builds it,
// once, as a template; each case copies it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { adminUrl } from "./support/cluster.ts";
import { applyIdentityFirst, IDENTITY_MIGRATION, readPreIdentityLedger, runMigrate } from "../scripts/migrate-run.ts";
import type { MigrateJournalFile } from "../scripts/migrate-journal.ts";
import { readManifest } from "../src/db/schema-manifest.ts";
import { SUPPORTED_RELEASES } from "../src/db/supported-releases.ts";
import {
  HEAD_FILES,
  MIGRATIONS_DIR,
  applyAsReleaseRunner,
  loadBaseline,
  loadRelease,
  migrateAtTerminal,
  releaseSteps,
  restoreLogins,
  restoreRoles,
  revokeLoginDefaults,
  saveRoles,
  startMigrateAtTerminal,
  type LiveTerminal,
  type SavedRole,
} from "./fixtures/releases/release-fixture.ts";
import { withTargetLock } from "./support/target-lock.ts";

const TAG = SUPPORTED_RELEASES[0]!.name;
const BASELINE = loadBaseline(TAG);
const BASELINE_FILES = BASELINE.migrations.map((m) => m.file);
/** The six files production lacks below 0063, in the order the normal path applies them. */
const LOWER_SIX = [
  "0056_swarm_judge_requires_model.sql",
  "0057_swarm_judge_policy_stamp.sql",
  "0058_swarm_judge_fault_injection.sql",
  "0059_swarm_judgement_completion_usage.sql",
  "0061_rm_worker_wallet_backfill_grant.sql",
  "0062_rm_worker_analytics_ledger_read_grant.sql",
];

// cluster admin: this file replays the historical releases AS the bootstrap login
// (a superuser), so the objects before 0054 are the admin's and role attributes
// are rewritten by 0053; the replay, the role save/restore and the session
// catalog reads all need it. The owner's own steps run as rm_owner (asOwner).
const LOGIN = new URL(adminUrl()).username;
const OWNER_PASSWORD = randomBytes(18).toString("base64url");
const READONLY_PASSWORD = randomBytes(12).toString("hex");
const suffix = randomBytes(4).toString("hex");
const TEMPLATE = `rm_ifp_base_${suffix}`;
const V050_TEMPLATE = `rm_ifp_v050_${suffix}`;
const created: string[] = [TEMPLATE, V050_TEMPLATE];
const homes: string[] = [];

function urlFor(database: string, role?: { name: string; password: string }): URL {
  const url = new URL(adminUrl());
  url.pathname = `/${database}`;
  if (role) {
    url.username = role.name;
    url.password = encodeURIComponent(role.password);
  }
  return url;
}

function connect(database: string, role?: { name: string; password: string }): postgres.Sql<{}> {
  return postgres(urlFor(database, role).toString(), { max: 1, onnotice: () => {} });
}

const asOwner = { name: "rm_owner", password: OWNER_PASSWORD };

let admin: postgres.Sql<{}>;
let saved: SavedRole[] = [];

async function withDb<T>(database: string, body: (db: postgres.Sql<{}>) => Promise<T>): Promise<T> {
  const db = connect(database);
  try {
    return await body(db);
  } finally {
    await db.end({ timeout: 5 });
  }
}

/** A fresh copy of a template, dropped in afterAll. */
async function copyOf(template: string, label: string): Promise<string> {
  const name = `rm_ifp_${label}_${suffix}`;
  await admin.unsafe(`CREATE DATABASE ${name} TEMPLATE ${template}`);
  created.push(name);
  return name;
}

interface State {
  ledger: string[];
  table: boolean;
  identity: string[];
  manifest: boolean;
}

async function stateOf(database: string): Promise<State> {
  return withDb(database, async (db) => {
    const ledger = ((await db`SELECT name FROM schema_migrations ORDER BY name`) as unknown as { name: string }[]).map((r) => r.name);
    const [t] = (await db`SELECT to_regclass('public.deployment_identity') IS NOT NULL AS present`) as unknown as { present: boolean }[];
    const identity = t!.present
      ? ((await db`SELECT kind FROM deployment_identity`) as unknown as { kind: string }[]).map((r) => r.kind)
      : [];
    return { ledger, table: t!.present, identity, manifest: (await readManifest(db)) !== null };
  });
}

/**
 * Hold `lockSql` in an open transaction on `database` until `release()` is
 * called; the transaction then rolls back.
 */
async function holdLock(database: string, lockSql: string): Promise<{ release(): Promise<void> }> {
  const db = connect(database);
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let locked!: () => void;
  const isLocked = new Promise<void>((resolve) => (locked = resolve));
  const done = db
    .begin(async (tx) => {
      await tx.unsafe(lockSql);
      locked();
      await released;
      throw new Error("rollback");
    })
    .catch(() => undefined);
  await isLocked;
  return {
    async release() {
      release();
      await done;
      await db.end({ timeout: 5 });
    },
  };
}

/** Wait until an rm_owner backend on `database` is blocked on a lock in a statement matching `pattern`. */
async function waitBlocked(database: string, pattern: string, run: LiveTerminal): Promise<void> {
  const deadline = Date.now() + 120_000;
  for (;;) {
    const rows = (await admin`
      SELECT pid FROM pg_stat_activity
       WHERE datname = ${database} AND usename = 'rm_owner' AND wait_event_type = 'Lock' AND query LIKE ${pattern}`) as unknown as {
      pid: number;
    }[];
    if (rows.length > 0) return;
    if (Date.now() > deadline) {
      const seen = await admin`
        SELECT usename, state, wait_event_type, wait_event, left(query, 120) AS query FROM pg_stat_activity WHERE datname = ${database}`;
      throw new Error(`no rm_owner statement matching ${pattern} blocked; sessions: ${JSON.stringify(seen)}; terminal:\n${run.screen()}`);
    }
    await Bun.sleep(50);
  }
}

/** Wait until no rm_owner backend remains on `database`: the killed run's transaction is gone. */
async function waitOwnerGone(database: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const [row] = (await admin`
      SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = ${database} AND usename = 'rm_owner'`) as unknown as { n: number }[];
    if (row!.n === 0) return;
    if (Date.now() > deadline) throw new Error(`an rm_owner backend is still connected to ${database}`);
    await Bun.sleep(50);
  }
}

/** Start the operator's command and answer its two prompts. */
async function startTyped(database: string): Promise<LiveTerminal> {
  const run = startMigrateAtTerminal({ databaseUrl: urlFor(database), readonlyPassword: READONLY_PASSWORD, rmEnv: "prod" });
  homes.push(run.home);
  let at = await run.waitFor("rm_owner password (not echoed");
  await run.type(`${OWNER_PASSWORD}\r`);
  at = await run.waitFor("type y to continue", at);
  await run.type("y\r");
  return run;
}

async function rerun(database: string) {
  const run = await migrateAtTerminal({
    databaseUrl: urlFor(database),
    readonlyPassword: READONLY_PASSWORD,
    rmEnv: "prod",
    steps: [
      { await: "rm_owner password (not echoed", send: OWNER_PASSWORD },
      { await: "type y to continue", send: "y" },
    ],
  });
  homes.push(run.home);
  expect({ code: run.code, tail: run.code === 0 ? "" : run.screen.slice(-3000) }).toEqual({ code: 0, tail: "" });
  return {
    run,
    receipt: JSON.parse(readFileSync(run.receiptPath, "utf8")) as {
      applied: string[];
      preIdentity: { identity: string; release: string; ledger: string[] } | null;
      identityWritten: { kind: string } | null;
      resumedAfterIdentityPass: string | null;
      baselined: boolean;
      manifest: { filenames: string[] };
    },
  };
}

function journalOf(run: LiveTerminal): MigrateJournalFile {
  const names = readdirSync(run.receiptDir).filter((name) => name.startsWith("migrate-journal-"));
  expect(names.length).toBe(1);
  return JSON.parse(readFileSync(join(run.receiptDir, names[0]!), "utf8")) as MigrateJournalFile;
}

beforeAll(async () => {
  admin = connect("postgres");
  saved = await saveRoles(admin);
  await admin.unsafe(`CREATE DATABASE ${TEMPLATE}`);
  await admin.unsafe(`CREATE DATABASE ${V050_TEMPLATE}`);
  try {
    await withDb(TEMPLATE, (db) => applyAsReleaseRunner(db, releaseSteps(BASELINE)));
    await withDb(V050_TEMPLATE, (db) => applyAsReleaseRunner(db, releaseSteps(loadRelease("v0.5.0"))));
  } finally {
    // v0.5.0's 0053 re-attributed the cluster's roles (NOLOGIN for rm_owner).
    await restoreLogins(admin, saved);
  }
  for (const name of [TEMPLATE, V050_TEMPLATE]) await withDb(name, (db) => revokeLoginDefaults(db, LOGIN));
  // §9.1 step 1 and the host's ~/.env rm_readonly line.
  await admin.unsafe(`ALTER ROLE rm_owner LOGIN PASSWORD '${OWNER_PASSWORD}'`);
  await admin.unsafe(`ALTER ROLE rm_readonly LOGIN PASSWORD '${READONLY_PASSWORD}'`);
}, 240_000);

afterAll(async () => {
  try {
    await restoreRoles(admin, saved);
    for (const name of created) await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  } finally {
    await admin.end({ timeout: 5 });
    for (const home of homes) rmSync(home, { recursive: true, force: true });
  }
});

describe("the template is production's baseline: no table, the 73-name ledger", () => {
  test("the baseline template records exactly the supported baseline and has no deployment_identity table", async () => {
    const state = await stateOf(TEMPLATE);
    expect(state).toEqual({ ledger: [...SUPPORTED_RELEASES[0]!.migrations], table: false, identity: [], manifest: false });
    expect(BASELINE_FILES.filter((f) => LOWER_SIX.includes(f))).toEqual([]);
    expect(HEAD_FILES).toEqual(expect.arrayContaining(LOWER_SIX));
  });
});

describe("§10 W2 — kill the production pass and rerun it (`bun run migrate`, a real process, SIGKILL)", () => {
  test("killed BEFORE 0063 commits: nothing is left, and the rerun takes the pass again", async () => {
    const name = await copyOf(TEMPLATE, "killbefore");
    // An uncommitted ledger row under 0063's own name: every read and every
    // privilege probe passes it, and the pass's INSERT of the same key waits
    // on this transaction — after 0063's DDL, inside 0063's transaction.
    const blocker = await holdLock(name, `INSERT INTO schema_migrations (name) VALUES ('${IDENTITY_MIGRATION}')`);
    let run: LiveTerminal | undefined;
    try {
      run = await startTyped(name);
      // Blocked on 0063's ledger INSERT, inside 0063's transaction, after its DDL.
      await waitBlocked(name, "%INSERT INTO schema_migrations%", run);
      expect(run.screen()).toContain("FIRST PRODUCTION MIGRATE");
      await run.kill();
    } finally {
      if (run) await run.kill();
      await blocker.release();
    }
    await waitOwnerGone(name);

    // The DDL rolled back with the transaction: the baseline, no table, no row.
    expect(await stateOf(name)).toEqual({ ledger: BASELINE_FILES, table: false, identity: [], manifest: false });
    // A crash, not a refusal: the journal names the phase it died in, unclosed.
    const journal = journalOf(run!);
    expect(journal.outcome).toBeNull();
    expect(journal.phases.at(-1)).toMatchObject({ phase: `migrate: identity-first ${IDENTITY_MIGRATION}`, status: "started" });

    // The rerun meets the baseline again and takes the pass again.
    const { run: second, receipt } = await rerun(name);
    expect(second.screen).toContain("FIRST PRODUCTION MIGRATE");
    expect(receipt.preIdentity).toEqual({ identity: "no table", release: TAG, ledger: BASELINE_FILES });
    expect(receipt.identityWritten).toMatchObject({ kind: "production" });
    expect(receipt.applied[0]).toBe(IDENTITY_MIGRATION);
    expect(receipt.applied.slice(1, 7)).toEqual(LOWER_SIX);
    expect(await stateOf(name)).toEqual({ ledger: HEAD_FILES, table: true, identity: ["production"], manifest: true });
  }, 240_000);

  test("killed AFTER 0063 commits: 0063 holds its row, and the rerun resumes through the normal path, the six lower files first", async () => {
    const name = await copyOf(TEMPLATE, "killafter");
    const blocker = await holdLock(name, "LOCK TABLE swarm_judge_config IN SHARE MODE");
    let run: LiveTerminal | undefined;
    let whileBlocked: State;
    try {
      run = await startTyped(name);
      // Blocked in 0056_swarm_judge_requires_model's transaction: 0063's has committed.
      await waitBlocked(name, "%swarm_judge_config%", run);
      // The committed state at this instant: 0063 WITH its row, nothing else.
      whileBlocked = await stateOf(name);
      await run.kill();
    } finally {
      if (run) await run.kill();
      await blocker.release();
    }
    await waitOwnerGone(name);

    const passLeft = { ledger: [...BASELINE_FILES, IDENTITY_MIGRATION].sort(), table: true, identity: ["production"], manifest: false };
    expect(whileBlocked!).toEqual(passLeft);
    expect(await stateOf(name)).toEqual(passLeft);
    expect(journalOf(run!).phases.at(-1)).toMatchObject({ phase: `migrate: apply ${LOWER_SIX[0]}`, status: "started" });

    // The rerun is ordinary: the row exists, so no exception is asked for; the
    // normal path accepts the state the pass left and applies the six lower
    // files first, then the rest, in filename order.
    const { run: second, receipt } = await rerun(name);
    expect(second.screen).not.toContain("FIRST PRODUCTION MIGRATE");
    expect(receipt.preIdentity).toBeNull();
    expect(receipt.identityWritten).toBeNull();
    expect(receipt.resumedAfterIdentityPass).toBe(TAG);
    expect(receipt.applied).toEqual(HEAD_FILES.filter((f) => !BASELINE_FILES.includes(f) && f !== IDENTITY_MIGRATION));
    expect(receipt.applied.slice(0, 6)).toEqual(LOWER_SIX);
    expect(receipt.baselined).toBe(true);
    expect(await stateOf(name)).toEqual({ ledger: HEAD_FILES, table: true, identity: ["production"], manifest: true });
  }, 240_000);
});

/**
 * A pass's result built by hand on a copy, as rm_owner: 0063's DDL, its ledger
 * row and `kind`, in one transaction, on top of whatever ledger the copy has.
 * For the normal path's red controls, whose states no pass would leave.
 */
async function passShape(database: string, kind: "production" | "rehearsal"): Promise<void> {
  const owner = connect(database, asOwner);
  try {
    await owner.begin(async (tx) => {
      await tx.unsafe(readFileSync(join(MIGRATIONS_DIR, IDENTITY_MIGRATION), "utf8"));
      await tx`INSERT INTO schema_migrations (name) VALUES (${IDENTITY_MIGRATION})`;
      await tx`INSERT INTO deployment_identity (kind) VALUES (${kind})`;
    });
  } finally {
    await owner.end({ timeout: 5 });
  }
}

function operatorRun(database: string) {
  const owner = connect(database, asOwner);
  return withTargetLock(urlFor(database).toString(), (lock) =>
    runMigrate(owner, { caller: "operator", env: "prod", connection: "remote", nonInteractive: true, lock }),
  ).finally(() => owner.end({ timeout: 5 }));
}

describe("§10 W2 — the normal path accepts the state a pass leaves, and no other out-of-order state", () => {
  test("RED CONTROL: rows before 0063 that are v0.5.0 alone (one file less than the baseline) refuse the lower files, applying nothing", async () => {
    const name = await copyOf(V050_TEMPLATE, "v050pass");
    await passShape(name, "production");
    const before = await stateOf(name);
    await expect(operatorRun(name)).rejects.toThrow(
      "the snapshot embodies 0056_swarm_judge_requires_model.sql, which the ledger does not record although later files are recorded",
    );
    expect(await stateOf(name)).toEqual(before);
  }, 120_000);

  test("RED CONTROL: a lower file applied BEFORE 0063 (the baseline plus one) refuses, applying nothing", async () => {
    const name = await copyOf(TEMPLATE, "extrabefore");
    await withDb(name, (db) =>
      applyAsReleaseRunner(db, [{ file: LOWER_SIX[0]!, ddl: readFileSync(join(MIGRATIONS_DIR, LOWER_SIX[0]!), "utf8") }]),
    );
    await passShape(name, "production");
    const before = await stateOf(name);
    await expect(operatorRun(name)).rejects.toThrow("which the ledger does not record although later files are recorded");
    expect(await stateOf(name)).toEqual(before);
  }, 120_000);

  test("RED CONTROL: a gap AMONG the rows applied after 0063 (0058 recorded, 0057 run through psql with no row) refuses, applying nothing", async () => {
    // The pass's state, then a resume that went wrong out of band: 0056 by the
    // runner, 0057's DDL by hand with no ledger row, 0058 by the runner. The
    // rows before 0063 still equal the baseline, so readIdentityPassRemainder
    // matches — and 0057 must still refuse, or the runner would apply it a
    // second time onto a schema that already has it.
    const name = await copyOf(TEMPLATE, "gapafter");
    await passShape(name, "production");
    const step = (file: string) => ({ file, ddl: readFileSync(join(MIGRATIONS_DIR, file), "utf8") });
    await withDb(name, (db) => applyAsReleaseRunner(db, [step(LOWER_SIX[0]!)]));
    const owner = connect(name, asOwner);
    try {
      await owner.unsafe(step(LOWER_SIX[1]!).ddl);
    } finally {
      await owner.end({ timeout: 5 });
    }
    await withDb(name, (db) => applyAsReleaseRunner(db, [step(LOWER_SIX[2]!)]));
    const before = await stateOf(name);
    expect(before.ledger).toEqual([...BASELINE_FILES, LOWER_SIX[0]!, LOWER_SIX[2]!, IDENTITY_MIGRATION].sort());
    await expect(operatorRun(name)).rejects.toThrow(
      `the snapshot embodies ${LOWER_SIX[1]!}, which the ledger does not record although later files are recorded`,
    );
    expect(await stateOf(name)).toEqual(before);
  }, 120_000);

  test("a resume the runner itself left (0056 and 0057 applied after 0063, in order) is accepted and applies the rest", async () => {
    const name = await copyOf(TEMPLATE, "orderedafter");
    await passShape(name, "production");
    await withDb(name, (db) =>
      applyAsReleaseRunner(
        db,
        LOWER_SIX.slice(0, 2).map((file) => ({ file, ddl: readFileSync(join(MIGRATIONS_DIR, file), "utf8") })),
      ),
    );
    const result = await operatorRun(name);
    expect(result.applied.slice(0, 4)).toEqual(LOWER_SIX.slice(2));
    expect(result.resumedAfterIdentityPass).toBe(TAG);
    expect(await stateOf(name)).toEqual({ ledger: HEAD_FILES, table: true, identity: ["production"], manifest: true });
  }, 180_000);

  // A ledger whose rows share 0063's applied_at (one snapshot bootstrap
  // transaction wrote them all) is not a pass's state either: prod-baseline.test.ts's
  // "a ledger that never recorded 0053" case holds that refusal on a
  // production-enrolled, snapshot-built database.

  test("out-of-order 0063 outside the passes refuses: a table made out of band, with a row, never lets the apply loop run 0063 or the lower files", async () => {
    const name = await copyOf(TEMPLATE, "outofband");
    // deployment_identity created without 0063's ledger row, then enrolled —
    // the one way a normal-path run could meet the baseline with a row.
    const owner = connect(name, asOwner);
    try {
      await owner.begin(async (tx) => {
        await tx.unsafe(readFileSync(join(MIGRATIONS_DIR, IDENTITY_MIGRATION), "utf8"));
        await tx`INSERT INTO deployment_identity (kind) VALUES ('production')`;
      });
    } finally {
      await owner.end({ timeout: 5 });
    }
    const before = await stateOf(name);
    await expect(operatorRun(name)).rejects.toThrow("which the ledger does not record although later files are recorded");
    expect(await stateOf(name)).toEqual(before);
  }, 120_000);
});

describe("the identity-first pass itself (applyIdentityFirst), on the fenced path", () => {
  test("a `rehearsal` pass over a REMOTE connection refuses inside its transaction: no 0063, no row (the store carries the remote flag)", async () => {
    const name = await copyOf(TEMPLATE, "remoterehearsal");
    const owner = connect(name, asOwner);
    try {
      const expected = (await readPreIdentityLedger(owner))!;
      expect(expected.release).toBe(TAG);
      await expect(
        applyIdentityFirst(owner, { kind: "rehearsal", rmEnv: "stage", remote: true, expected, note: "remote rehearsal attempt" }),
      ).rejects.toThrow("REMOTE database");
    } finally {
      await owner.end({ timeout: 5 });
    }
    expect(await stateOf(name)).toEqual({ ledger: BASELINE_FILES, table: false, identity: [], manifest: false });
  }, 60_000);

  test("a pass admitted on one state refuses when its fence reads another: nothing applied", async () => {
    const name = await copyOf(V050_TEMPLATE, "movedstate");
    const owner = connect(name, asOwner);
    try {
      // Admitted on the baseline, run against v0.5.0 alone.
      const expected = { identity: "no table" as const, release: TAG, ledger: BASELINE_FILES };
      await expect(
        applyIdentityFirst(owner, { kind: "production", rmEnv: "prod", remote: true, expected, note: "moved" }),
      ).rejects.toThrow("no longer qualifies");
    } finally {
      await owner.end({ timeout: 5 });
    }
    expect((await stateOf(name)).table).toBe(false);
  }, 60_000);

  test("a local `rehearsal` pass commits 0063, its ledger row and the row in one transaction, and the normal path then resumes", async () => {
    const name = await copyOf(TEMPLATE, "localrehearsal");
    const owner = connect(name, asOwner);
    try {
      const expected = (await readPreIdentityLedger(owner))!;
      const result = await applyIdentityFirst(owner, { kind: "rehearsal", rmEnv: "stage", remote: false, expected, note: "local dump" });
      expect(result.row).toMatchObject({ kind: "rehearsal", writtenBy: "rm_owner" });
    } finally {
      await owner.end({ timeout: 5 });
    }
    expect(await stateOf(name)).toEqual({
      ledger: [...BASELINE_FILES, IDENTITY_MIGRATION].sort(),
      table: true,
      identity: ["rehearsal"],
      manifest: false,
    });
    await withDb(name, async (db) => {
      const [same] = (await db`
        SELECT (SELECT xmin::text FROM schema_migrations WHERE name = ${IDENTITY_MIGRATION})
             = (SELECT xmin::text FROM deployment_identity) AS one_transaction`) as unknown as { one_transaction: boolean }[];
      expect(same!.one_transaction).toBe(true);
    });
    // `bun smoke --migrate`'s run on what the pass left: the normal path.
    const owner2 = connect(name, asOwner);
    try {
      const result = await withTargetLock(urlFor(name).toString(), (lock) =>
        runMigrate(owner2, { caller: "smoke_flag", env: "stage", connection: "local", nonInteractive: true, lock }),
      );
      expect(result.applied.slice(0, 6)).toEqual(LOWER_SIX);
      expect(result.resumedAfterIdentityPass).toBe(TAG);
    } finally {
      await owner2.end({ timeout: 5 });
    }
    expect(await stateOf(name)).toEqual({ ledger: HEAD_FILES, table: true, identity: ["rehearsal"], manifest: true });
  }, 180_000);
});
