// The migrate RUN — the four-step sequence spec §8.3 defines, plus the gates
// spec §8.5 puts in front of it.
//
// STUB. Every function throws `NOT IMPLEMENTED`; nothing imports this module
// yet, and it has no `import.meta.url` entry point on purpose. Step 1 of issue
// #1026's W2 workstream.
//
// IT DOES NOT REPLACE ANYTHING YET. `backend/scripts/migrate.ts` is untouched
// and keeps being what `bun run migrate` invokes. This module documents the
// TARGET run and absorbs migrate.ts in step 3 of #1026's W2, at which point
// migrate.ts's argv/`$HOME/.env`/prompt handling moves here and the old file
// goes. Until then the two describe the same command at two different versions,
// and the shipped one is the old one.
//
// Governed by smoke-production-spec.md §8.3 (the run), §8.5 (`--migrate` and
// production upgrades), §2 (the fence), §3 (the credential), §4.3 (the policy
// matrix).
//
// ─────────────────────────────────────────────────────────────────────────────
// THE SEQUENCE, AND WHY EACH STEP IS WHERE IT IS
// ─────────────────────────────────────────────────────────────────────────────
//
// Spec §8.3, quoted: "A migrate run is: fence (§2) → apply pending migrations,
// one transaction each → roles-and-grants reconciliation (always, even with
// nothing pending) → publish the manifest for the final state in the
// reconciliation's transaction."
//
//   FENCE FIRST. §2: "Every mutation (migration, grant reconciliation, seed,
//   key rebind, schedule write) runs in a transaction that first takes
//   `pg_advisory_xact_lock` on the same key, on the connection performing it. A
//   competitor that wins the session lock after the coordinator's connection
//   died still blocks on the xact lock until the in-flight mutation commits or
//   aborts." The session lock alone is not enough, because a dead connection
//   releases it while the statement it was coordinating is still executing on
//   the server. §2's invariant: "A cancellation request is not evidence the
//   mutation stopped."
//
//   ONE TRANSACTION EACH. Not one transaction for all of them. A single
//   transaction would make a failure at migration seven roll back one through
//   six, so an operator who fixed seven would re-run six migrations that had
//   already worked — and several of this repo's migrations are expensive
//   sweeps (0053 re-owns every relation and function in `public`). Per-migration
//   commits are also what make the in-progress state of §8.3 resumable at all.
//
//   RECONCILIATION ALWAYS. "even with nothing pending" is the clause that
//   catches production today. Production's ledger drifted because
//   `scripts/ops/provision-db-role-taxonomy.sh` applied 0053 and 0062 through
//   psql without recording them (backend/scripts/migrate.ts's own header says
//   so), and a grant fixed by hand and then lost is invisible to a run that
//   skips reconciliation when the migration list is empty. Reconciliation is
//   idempotent by construction (§8.1's grants part), so running it every time
//   costs one transaction.
//
//   MANIFEST IN THAT SAME TRANSACTION. So "manifest published" means "grants
//   reconciled". A manifest that could commit separately would let a boot pass
//   check 3a on a database whose grants are still the previous version's — and
//   check 2 would then fail on grants check 3a had just called correct.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHO RUNS IT, AND WHY IT ASKS
// ─────────────────────────────────────────────────────────────────────────────
//
// `rm_owner`, typed at the terminal. Spec §3: "**`rm_owner` is `LOGIN`.** Its
// password is typed at the terminal for the one run that needs it and never
// stored." There is no `rm_migrator` (§3, and D46/D47 record its removal), and
// the current `SET LOCAL ROLE rm_owner` bootstrap in
// `backend/src/db/migrate.ts:57` goes with it.
//
// `rm_owner` is NOLOGIN in this checkout, twice over: migration 0053 line 10
// creates it (`CREATE ROLE rm_owner NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB
// NOCREATEROLE NOREPLICATION NOBYPASSRLS`) and line 49 re-asserts it
// (`ALTER ROLE rm_owner NOLOGIN NOINHERIT NOCREATEDB NOCREATEROLE`) on every
// apply. W2.1 changes both lines for FRESH databases. Existing ones are not
// reached by that edit — the runner skips files it has already recorded — so
// spec §9.1 step 1 makes them a one-time `doadmin` step:
// "`ALTER ROLE rm_owner LOGIN PASSWORD …`, then a verification login."
//
// Until that step has run on a given database, this tool cannot connect at all,
// and the refusal has to say which of the two situations it is in. "Password
// authentication failed" against a NOLOGIN role is the least useful sentence
// available.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHEN IT REFUSES OUTRIGHT
// ─────────────────────────────────────────────────────────────────────────────
//
// Spec §8.5: "In production an upgrade is an operator intervention:
// `bun run migrate`, prompting for `rm_owner`, planned per release, receipted.
// It is never part of the boot." and "`--migrate` is a convenience for stage,
// test, and CI, where the database and the boot happen in one step. It refuses
// on `RM_ENV=prod` or `deployment_identity ≠ rehearsal`."
//
// Two callers, two rule sets, one run. `bun run migrate` is the operator
// intervention and may touch production. `--migrate` is the smoke convenience
// and may not — §4.3: "**Rehearsal-only preparation:** `--migrate`, `--seed`,
// `--spoof-keys` require `rehearsal` in addition to their own guards."
import { randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import type postgresTypes from "postgres";
import { hiddenPrompt } from "../../scripts/lib/smoke-external-migrate.ts";
import { config } from "../src/config.ts";
import { checkAppendOnlyGuard } from "../src/db/append-only-guard.ts";
import { parseMigrationHeader, recordMigrationCompat } from "../src/db/schema-compat.ts";
import {
  MANIFEST_FORMAT_VERSION,
  MANIFEST_TABLE,
  hashManifest,
  resumePlan,
  writeManifest,
  type SchemaManifest,
} from "../src/db/schema-manifest.ts";
import { loadSnapshot } from "../src/db/schema-snapshot.ts";

export type MigrateDb = postgresTypes.Sql<{}> | postgresTypes.TransactionSql<{}>;

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

/** How long the fence waits before refusing. §2: "A tool that finds the lock
 *  held waits with a timeout, then refuses naming the holder." Bounded on
 *  purpose — an unbounded wait turns a stuck holder into a hung deploy with no
 *  message, which is the failure this whole protocol exists to make loud. */
const FENCE_TIMEOUT_MS = 3_000;
const FENCE_POLL_MS = 100;

/** Which of the two callers of §8.5 is running. They differ only in what they
 *  refuse, never in what the run does. */
export type MigrateCaller =
  /** `bun run migrate` — the operator intervention. May run against
   *  `deployment_identity = production` under `RM_ENV=prod`. */
  | "operator"
  /** `bun smoke --migrate` — the stage/test/CI convenience. Refuses `prod` and
   *  refuses anything but `rehearsal`. */
  | "smoke_flag";

export interface MigrateRunOptions {
  readonly caller: MigrateCaller;
  /** Resolved policy; `null` when `RM_ENV` is unset (§4.3 gives unset its own
   *  row). */
  readonly env: "prod" | "stage" | null;
  /** Remote connection or a Postgres container smoke owns (§5). Drives the
   *  warning and the `y/n`, and drives where the owner password comes from. */
  readonly connection: "remote" | "local";
  /** The advisory-lock key of §2, derived from the DATABASE identity and "not
   *  the compose project" — two instances pointed at one database must collide,
   *  and one database reached under two project names must not look like two. */
  readonly lockKey: bigint;
  /** True when the caller already holds the session lock and this run only
   *  needs the per-transaction fence — smoke holds it "from acquisition through
   *  preflight, replacement, and readiness" (§2). */
  readonly sessionLockHeld: boolean;
  /** Skip every prompt and refuse rather than ask. CI passes this; an
   *  unattended run that would have blocked on a terminal must fail fast. */
  readonly nonInteractive: boolean;
}

/** What the run committed, for the receipt (§1.4) and the journal (§1.3). */
export interface MigrateRunResult {
  /** Migrations applied by THIS run, in apply order. Empty is an ordinary
   *  outcome; reconciliation still ran. */
  readonly applied: readonly string[];
  /** Migrations that were already committed but unmanifested when this run
   *  started, and were re-validated rather than re-applied (§8.3's resume). */
  readonly resumedAndVerified: readonly string[];
  /** Always true — reconciliation runs "always, even with nothing pending". */
  readonly grantsReconciled: true;
  /** The manifest published in the reconciliation transaction. */
  readonly manifest: SchemaManifest;
}

/**
 * Run the full sequence of §8.3 against an already-connected owner session.
 *
 * Inputs: a handle connected as `rm_owner`, and the options above. Output: a
 * `MigrateRunResult`.
 *
 * Steps, in order and not reorderable:
 *   1. Fence — `pg_advisory_xact_lock(lockKey)` as the first statement of every
 *      mutating transaction below (§2). When `sessionLockHeld` is false this
 *      also takes the session-level `pg_advisory_lock` and releases it
 *      explicitly on exit.
 *   2. Revalidate — re-read `deployment_identity`, the ledger and the manifest
 *      after acquiring, and re-run the plan against them. §2: "A mismatch
 *      refuses."
 *   3. Resume — `resumePlan()` (../src/db/schema-manifest.ts) classifies an
 *      in-progress database, verifies committed-but-unmanifested work against
 *      each migration's expected post-state, and names the first unapplied
 *      step. Nothing is replayed and no drift is accepted (§8.3).
 *   4. Apply — each pending migration in its own transaction, with
 *      `recordMigrationCompat()` writing `compat`/`metadata_version` inside
 *      that same transaction (../src/db/schema-compat.ts).
 *   5. Reconcile and publish — the snapshot's grants part, then
 *      `writeManifest()`, in one transaction.
 *
 * Refusals:
 *   - The effective role is not `rm_owner`. Spec §8.3: "Only `rm_owner` may
 *     write it or the ledger's `compat`/`metadata_version` columns; they are
 *     trusted inputs to boot decisions."
 *   - The fence cannot be taken within the timeout. §2: "A tool that finds the
 *     lock held waits with a timeout, then refuses naming the holder."
 *   - Revalidation finds `deployment_identity`, the ledger or the manifest
 *     changed since the plan was made.
 *   - `resumePlan` refused (inconsistent manifest, unknown format version, a
 *     ledger row naming a file this checkout does not have, or committed work
 *     that fails its post-state check).
 *   - A migration has no parseable compat header (§8.2).
 *   - The connection is lost at a phase boundary: journal the phase and exit
 *     non-zero. §2: "No phase proceeds on a lock the tool cannot prove it still
 *     holds."
 *
 * Serves spec §10 W2 "Migrate fails between commits and during grant
 * reconciliation; rerun reaches a verified final state" and, with W1.7, "Kill
 * the lock connection mid-migration, start a second mutation tool: no overlap."
 */
export async function runMigrate(db: MigrateDb, options: MigrateRunOptions): Promise<MigrateRunResult> {
  // 1. FENCE. The session lock comes first and on a DEDICATED connection,
  //    because a session-level advisory lock belongs to the connection that
  //    took it: taken on a pooled handle it would be released by whichever
  //    checkout happened to end, and the per-transaction fence below would then
  //    block against a lock this same run is holding on a different connection.
  //    Everything after this runs on that one connection for exactly that
  //    reason — advisory locks are re-entrant within a session and mutually
  //    exclusive across them.
  const session = options.sessionLockHeld
    ? { handle: db, release: async (): Promise<void> => {} }
    : await acquireSessionFence(db, options.lockKey);

  try {
    await assertOwnerCapable(session.handle);

    // 2. REVALIDATE. §2: "After acquiring, the tool re-reads
    //    `deployment_identity`, the ledger, and the schema manifest and re-runs
    //    the plan against them. A mismatch refuses." The gates ran before the
    //    owner password was requested; the row can have changed since.
    const refusals = await checkMigrateGates(session.handle, options);
    if (refusals.length > 0) {
      throw new Error(`Refusing the migrate run: ${refusals.map((r) => r.message).join(" ")}`);
    }

    // 3. METADATA OBJECTS. §8.3's manifest table and §8.2's two ledger columns
    //    are reconciled, not migrated — see the note on `reconcileMetadataObjects`.
    //    They land BEFORE the apply loop because `recordMigrationCompat` writes
    //    into those columns inside each migration's own transaction.
    await withFence(session.handle, options.lockKey, async (tx) => {
      await tx.unsafe("SET LOCAL ROLE rm_owner");
      await reconcileMetadataObjects(tx);
    });

    // 4. RESUME. The append-only trigger inventory is checked first: it is the
    //    one post-state this repository declares machine-readably, and a
    //    database that lost a guard has not reached the post-state of the
    //    migration that installed it, whatever its ledger says. §8.3 forbids
    //    "accepting drift", and a resume is when accepting it is most tempting.
    await assertCommittedPostState(session.handle);
    const onDisk = await migrationFilenames();
    const plan = await resumePlan(session.handle, onDisk);

    // 5. APPLY, one transaction each, each fenced, each recording its own
    //    declaration so the row and the DDL commit together (§8.2).
    const applied: string[] = [];
    for (const file of plan.pending) {
      const ddl = await readFile(join(MIGRATIONS_DIR, file), "utf8");
      const header = parseMigrationHeader(file, ddl);
      await withFence(session.handle, options.lockKey, async (tx) => {
        await tx.unsafe("SET LOCAL ROLE rm_owner");
        await tx.unsafe(ddl);
        await tx`INSERT INTO schema_migrations (name) VALUES (${file})`;
        await recordMigrationCompat(tx, header);
      });
      applied.push(file);
    }

    // 6. RECONCILE AND PUBLISH, in ONE transaction, so "manifest published"
    //    means "grants reconciled" (§8.3).
    const snapshot = await loadSnapshot();
    const manifest = await withFence(session.handle, options.lockKey, async (tx) => {
      await tx.unsafe("SET LOCAL ROLE rm_owner");
      await reconcileMetadataObjects(tx);
      await tx.unsafe(snapshot.grantsSql);
      const filenames = (
        (await tx.unsafe("SELECT name FROM schema_migrations ORDER BY name")) as unknown as { name: string }[]
      ).map((row) => row.name);
      const published: SchemaManifest = {
        formatVersion: MANIFEST_FORMAT_VERSION,
        declaration: snapshot.manifest.declaration,
        filenames,
        contentHash: hashManifest(snapshot.manifest.declaration, filenames),
      };
      await writeManifest(tx, published);
      return published;
    });

    return {
      applied,
      resumedAndVerified: plan.committedToVerify,
      grantsReconciled: true,
      manifest,
    };
  } finally {
    await session.release();
  }
}

/** A handle that holds the session lock, and the release that must happen on
 *  every exit path — including the refusals, or the next tool waits on a lock
 *  nobody is using. */
interface SessionFence {
  readonly handle: MigrateDb;
  readonly release: () => Promise<void>;
}

function canReserve(db: MigrateDb): db is postgresTypes.Sql<{}> {
  return typeof (db as postgresTypes.Sql<{}>).reserve === "function";
}

async function acquireSessionFence(db: MigrateDb, key: bigint): Promise<SessionFence> {
  const reserved = canReserve(db) ? await db.reserve() : null;
  const handle: MigrateDb = reserved ?? db;
  const release = async (): Promise<void> => {
    try {
      await handle.unsafe(`SELECT pg_advisory_unlock(${key.toString()}::bigint)`);
    } finally {
      reserved?.release();
    }
  };

  const deadline = Date.now() + FENCE_TIMEOUT_MS;
  for (;;) {
    const [row] = (await handle.unsafe(
      `SELECT pg_try_advisory_lock(${key.toString()}::bigint) AS ok`,
    )) as unknown as { ok: boolean }[];
    if (row?.ok === true) return { handle, release };
    if (Date.now() >= deadline) {
      const holder = await describeFenceHolder(handle, key);
      reserved?.release();
      throw new Error(
        `Refusing the migrate run: the target lock ${key.toString()} is held by ${holder}. ` +
          "A cancellation request is not evidence the mutation it is fencing has stopped, so this run " +
          "waits rather than overlapping it, and refuses rather than waiting forever.",
      );
    }
    await new Promise((resolve) => setTimeout(resolve, FENCE_POLL_MS));
  }
}

/** Who holds the lock, in the terms an operator can act on: the backend pid and
 *  what that backend says it is doing. */
async function describeFenceHolder(db: MigrateDb, key: bigint): Promise<string> {
  const rows = (await db.unsafe(`
    SELECT l.pid, coalesce(a.application_name, '') AS application_name, coalesce(a.state, '') AS state
    FROM pg_locks l
    LEFT JOIN pg_stat_activity a ON a.pid = l.pid
    WHERE l.locktype = 'advisory'
      AND l.granted
      AND ((l.classid::bigint << 32) | l.objid::bigint) = ${key.toString()}::bigint
      AND l.pid <> pg_backend_pid()
    LIMIT 1`)) as unknown as { pid: number; application_name: string; state: string }[];
  const holder = rows[0];
  if (!holder) return "another session that has since released it";
  const label = holder.application_name === "" ? "" : ` (${holder.application_name})`;
  return `backend pid ${holder.pid}${label}`;
}

/** Every mutation runs in a transaction whose FIRST statement is the
 *  per-transaction fence (§2): a competitor that wins the session lock after
 *  this connection died still blocks here until the in-flight work commits or
 *  aborts. */
//
// The transaction is driven with explicit BEGIN/COMMIT rather than `sql.begin`,
// because every statement of this run has to stay on the ONE connection that
// holds the session lock, and postgres.js's reserved handle (`sql.reserve()`)
// does not carry `begin` — it is the bare `Sql` factory, without the pool
// wrapper's transaction helper. Taking the transaction from the pool instead
// would put the per-transaction fence on a different connection from the
// session lock and this run would block on itself.
async function withFence<T>(handle: MigrateDb, key: bigint, body: (tx: MigrateDb) => Promise<T>): Promise<T> {
  await handle.unsafe("BEGIN");
  try {
    await handle.unsafe(`SELECT pg_advisory_xact_lock(${key.toString()}::bigint)`);
    const result = await body(handle);
    await handle.unsafe("COMMIT");
    return result;
  } catch (error) {
    await handle.unsafe("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

/**
 * The session must be able to act as `rm_owner`.
 *
 * Spec §3 makes `rm_owner` the migration login and §8.3 restricts the manifest
 * and the ledger's compat columns to it. The test is capability, not identity:
 * the run does its work under `SET LOCAL ROLE rm_owner`, so what it needs is a
 * session that may assume the role. A session that may not is refused here
 * rather than five statements later inside a transaction, where the message
 * would name a column instead of the credential.
 */
async function assertOwnerCapable(db: MigrateDb): Promise<void> {
  const [row] = (await db.unsafe(`
    SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rm_owner') AS role_exists,
           current_user AS effective,
           coalesce((SELECT rolsuper FROM pg_roles WHERE rolname = current_user), false) AS is_super`)) as unknown as {
    role_exists: boolean;
    effective: string;
    is_super: boolean;
  }[];
  if (row?.role_exists !== true) {
    throw new Error(
      "Refusing the migrate run: this database has no rm_owner role. Spec §9.1 provisions the four roles " +
        "through doadmin before any migrate run is possible.",
    );
  }
  if (row.is_super === true || row.effective === "rm_owner") return;
  const [member] = (await db.unsafe(
    "SELECT pg_has_role(current_user, 'rm_owner', 'MEMBER') AS ok",
  )) as unknown as { ok: boolean }[];
  if (member?.ok === true) return;
  throw new Error(
    `Refusing the migrate run: the session is ${row.effective}, which cannot act as rm_owner. ` +
      "Only rm_owner may write the schema manifest or the ledger's compat columns — they are trusted " +
      "inputs to boot decisions (spec §8.3).",
  );
}

/**
 * `schema_manifest` (§8.3) and the ledger's `compat` / `metadata_version`
 * columns (§8.2) are reconciled on every run rather than installed by a
 * numbered migration.
 *
 * Reconciliation, not migration, for the same reason §8.3 runs the grants part
 * "always, even with nothing pending": these three objects are what preflight's
 * boot decisions read, and an object that a one-shot migration installed is an
 * object a hand-run `DROP` removes permanently. Re-asserting them costs two
 * `IF NOT EXISTS` statements per run and makes the loss self-healing.
 *
 * Idempotent, and owned by `rm_owner` — the caller has already done
 * `SET LOCAL ROLE rm_owner`, so the table this creates is owned by the only
 * role §8.3 permits to write it.
 */
async function reconcileMetadataObjects(tx: MigrateDb): Promise<void> {
  await tx.unsafe(`
    CREATE TABLE IF NOT EXISTS ${MANIFEST_TABLE} (
      format_version integer NOT NULL,
      declaration    text    NOT NULL,
      filenames      text[]  NOT NULL,
      content_hash   text    NOT NULL,
      singleton      boolean NOT NULL DEFAULT true UNIQUE CHECK (singleton)
    )`);
  await tx.unsafe("ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS compat text");
  await tx.unsafe("ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS metadata_version integer");
}

/**
 * The committed work's expected post-state, checked before the resume plan is
 * built.
 *
 * §8.3: a resume "validates committed work against each migration's expected
 * post-state ... without replaying or accepting drift". The append-only /
 * ledger-immutable trigger inventory is the post-state this repository already
 * declares machine-readably, and it is exactly the state a partial `pg_restore`
 * destroys while leaving the ledger intact (issue #602). A database whose guard
 * is disarmed has not reached the post-state of the migration that installed
 * it, and resuming would publish a manifest saying it had.
 */
async function assertCommittedPostState(db: MigrateDb): Promise<void> {
  const guard = await checkAppendOnlyGuard(db);
  if (guard.status !== "disarmed") return;
  throw new Error(
    `Refusing the migrate run: committed work fails its expected post-state — ${guard.problems.join("; ")}. ` +
      "A resume never accepts drift (spec §8.3).",
  );
}

async function migrationFilenames(): Promise<readonly string[]> {
  return (await readdir(MIGRATIONS_DIR)).filter((file) => file.endsWith(".sql")).sort();
}

/**
 * Obtain the `rm_owner` password for this one run.
 *
 * Input: the options. Output: the password.
 *
 * Two sources, by connection mode, per §8.5: "In local modes it uses the owner
 * password smoke generated. On a remote connection it prompts for `rm_owner`."
 * §5 makes the local half concrete — smoke "generates the four role passwords
 * and saves them in the instance's state directory beside the volume" and "No
 * terminal prompt exists in local modes."
 *
 * The prompt is masked and the value is never written anywhere, never logged,
 * and never placed in an environment variable that outlives the process. §3:
 * "typed at the terminal for the one run that needs it and never stored." A
 * stored owner password makes every §9.1 gate a formality.
 *
 * Refusals:
 *   - `nonInteractive` and a prompt would be needed. Failing fast beats a CI
 *     job hanging on an invisible prompt, which is the shape
 *     backend/scripts/migrate.ts already refuses today (`stdin is not a
 *     terminal`).
 *   - An empty password.
 *   - The resulting login fails AND `pg_roles` says `rm_owner` is `NOLOGIN` —
 *     reported as "this database has not had spec §9.1 step 1 applied", naming
 *     the `doadmin` `ALTER ROLE rm_owner LOGIN PASSWORD …` step, because 0053
 *     line 10 creates the role NOLOGIN and line 49 re-asserts it, and the
 *     runner will never re-apply 0053 to a database that has recorded it.
 *
 * Serves spec §10 W2 (plan row W2.1's "migrate as `rm_owner` on a fresh and on
 * a migrated database").
 */
export async function promptOwnerPassword(options: MigrateRunOptions): Promise<string> {
  if (options.connection === "remote") {
    if (options.nonInteractive) {
      throw new Error(
        "Refusing: a remote migrate run needs the rm_owner password typed at the terminal, and this run is " +
          "non-interactive (stdin is not a terminal). Spec §3 keeps that password out of files and " +
          "environment variables, so there is nothing for an unattended run to read.",
      );
    }
    const typed = await hiddenPrompt("rm_owner password (not echoed, not stored)");
    if (typed === "") throw new Error("Refusing: no rm_owner password entered.");
    await assertOwnerLoginWorks(typed);
    return typed;
  }

  // LOCAL. §5: smoke "generates the four role passwords and saves them in the
  // instance's state directory" and "No terminal prompt exists in local modes".
  //
  // WHERE THE GENERATION LIVES, and why it is not the state directory here:
  // `MigrateRunOptions` carries no instance and no state root, so this module
  // cannot resolve an instance without inventing one — and inventing one writes
  // a name and four passwords into the operator's `~/.local/state` from a run
  // that was never told which instance it belongs to. The generation is
  // therefore process-scoped and keyed by the database identity the lock key
  // already names; smoke, which does hold an instance, is what hands the
  // persisted generation over through `scripts/lib/smoke-state.ts` when W1
  // wires the two together.
  const key = options.lockKey.toString();
  const existing = LOCAL_OWNER_GENERATION.get(key);
  if (existing === undefined) {
    // FRESH GENERATION. There is nothing to verify: this is the password smoke
    // is about to give the Postgres it owns, so the role does not hold it yet.
    const generated = randomBytes(24).toString("base64url");
    LOCAL_OWNER_GENERATION.set(key, generated);
    return generated;
  }
  // REUSE. A persisted generation is a claim about a database that already
  // exists, so it is verifiable — and the verification is the only place the
  // §9.1 step 1 refusal can be raised with evidence rather than as a guess.
  await assertOwnerLoginWorks(existing);
  return existing;
}

/** The generation this process handed out per database identity. Never
 *  `process.env`: §3's "never stored" is about durability, and an environment
 *  variable outlives the call, is inherited by every child process, and shows
 *  up in `/proc/<pid>/environ`. */
const LOCAL_OWNER_GENERATION = new Map<string, string>();

/**
 * Verify the owner login, and tell the two failures apart.
 *
 * "Password authentication failed" against a NOLOGIN role is the least useful
 * sentence available. Migration 0053 line 10 creates `rm_owner` NOLOGIN and line
 * 49 re-asserts it on every apply, and the runner never re-applies a file it has
 * recorded — so on every database that has already run 0053, the role cannot log
 * in until spec §9.1 step 1 has been performed through `doadmin`.
 */
async function assertOwnerLoginWorks(password: string): Promise<void> {
  const target = new URL(config.databaseUrl);
  target.username = "rm_owner";
  target.password = password;
  const attempt = postgres(target.toString(), { max: 1, onnotice: () => {}, connect_timeout: 5 });
  try {
    await attempt.unsafe("SELECT 1");
    return;
  } catch (error) {
    if (await ownerIsNologin()) {
      throw new Error(
        "Refusing: rm_owner cannot log in to this database — spec §9.1 step 1 has not been applied here. " +
          "Through doadmin, run `ALTER ROLE rm_owner LOGIN PASSWORD '<password>'` and verify the login, then " +
          "retry. Migration 0053 creates the role NOLOGIN and the runner will never re-apply it to a " +
          "database that has recorded it, so no migration can perform this step.",
      );
    }
    throw new Error(
      `Refusing: the rm_owner credential was not accepted by this database (${(error as Error).message}).`,
    );
  } finally {
    await attempt.end({ timeout: 5 }).catch(() => undefined);
  }
}

/** Read `rolcanlogin` with whatever ambient credential this host has. A host
 *  running the migrate tool has `~/.env`'s runtime tokens (§3), and any of them
 *  can read `pg_roles`. If even that is unavailable the caller reports the
 *  authentication failure it actually saw rather than a diagnosis it cannot
 *  support. */
async function ownerIsNologin(): Promise<boolean> {
  const ambient = postgres(config.databaseUrl, { max: 1, onnotice: () => {}, connect_timeout: 5 });
  try {
    const [row] = (await ambient.unsafe(
      "SELECT rolcanlogin FROM pg_roles WHERE rolname = 'rm_owner'",
    )) as unknown as { rolcanlogin: boolean }[];
    return row?.rolcanlogin === false;
  } catch {
    return false;
  } finally {
    await ambient.end({ timeout: 5 }).catch(() => undefined);
  }
}

/**
 * Warn about a remote target and require an explicit `y`.
 *
 * Inputs: the options and the redacted target (host:port/dbname, password
 * stripped — the only form safe to print, as `redactedTarget` in
 * backend/scripts/db-preflight.ts already establishes). Output: nothing on
 * confirmation.
 *
 * Spec §8.5: "On a remote connection it prompts for `rm_owner`, warns, and asks
 * `y/n`." The warning exists because a remote target is the one case where the
 * operator's mental model and the connection string can disagree without
 * anything looking wrong, and `deployment_identity` is an "accidental-target
 * safeguard, not proof the data is disposable" (§4.2).
 *
 * Refusals:
 *   - Anything but an explicit `y`. Empty input is `n`; there is no default
 *     answer, because a default `y` is not a confirmation.
 *   - `nonInteractive` on a remote connection — an unattended run may not
 *     confirm on the operator's behalf.
 * Local connections skip it entirely (§5: "No terminal prompt exists in local
 * modes").
 *
 * Serves spec §10 W2 "`RM_ENV=stage` + typed owner password against
 * `deployment_identity = production` refuses" — the confirmation is the last
 * thing in front of that refusal, not a substitute for it.
 */
export async function confirmRemoteTarget(options: MigrateRunOptions, redactedTarget: string): Promise<void> {
  // §5: "No terminal prompt exists in local modes."
  if (options.connection === "local") return;

  if (options.nonInteractive) {
    throw new Error(
      `Refusing: this run would migrate the remote target ${redactedTarget}, and a non-interactive run may ` +
        "not confirm that on the operator's behalf. deployment_identity is an accidental-target safeguard, " +
        "not proof the data is disposable (spec §4.2).",
    );
  }

  process.stdout.write(
    `[migrate] this will apply pending migrations to the REMOTE target ${redactedTarget}.\n` +
      "[migrate] type y to continue, anything else to stop: ",
  );
  const answer = (await readLine()).trim().toLowerCase();
  // Empty input is `n`. There is no default answer, because a default `y` is
  // not a confirmation.
  if (answer !== "y") {
    throw new Error(`Refusing: the migrate run against ${redactedTarget} was not confirmed.`);
  }
}

/** One line from stdin. Unmasked on purpose — the answer is `y`, not a secret. */
async function readLine(): Promise<string> {
  for await (const chunk of process.stdin) return Buffer.from(chunk as Uint8Array).toString("utf8");
  return "";
}

/** A refusal, as a reason and an operator-readable sentence. Data rather than a
 *  thrown error so a test can assert the exact wording, the way
 *  backend/scripts/db-preflight.ts's `reportLines` is asserted. */
export interface MigrateRefusal {
  readonly reason:
    | "prod_env"
    | "identity_not_rehearsal"
    | "identity_missing"
    | "env_unset_remote"
    | "env_invalid";
  readonly message: string;
}

/**
 * Apply §8.5's and §4.3's gates before anything connects as `rm_owner`.
 *
 * Inputs: a handle (to read the one-row `deployment_identity`) and the options.
 * Output: every refusal found, empty when the run may proceed.
 *
 * For `caller: "smoke_flag"`, spec §8.5: `--migrate` "refuses on `RM_ENV=prod`
 * or `deployment_identity ≠ rehearsal`", and §4.3 adds that rehearsal-only
 * preparation requires `rehearsal` "in addition to their own guards". A missing
 * identity row is a refusal, not a pass — absence of evidence is not evidence
 * of rehearsal.
 *
 * For `caller: "operator"`, production is allowed and `prod` is expected; the
 * refusals that remain are §4.3's own rows (unset `RM_ENV` against a remote;
 * any other `RM_ENV` value; `prod` combined with a `--local` mode).
 *
 * Runs BEFORE the owner password is requested, so a refused run never causes a
 * password to be typed — typing it into the wrong terminal is a disclosure
 * nothing later can undo.
 *
 * Serves spec §10 W2 "`RM_ENV=stage` + typed owner password against
 * `deployment_identity = production` refuses."
 */
export async function checkMigrateGates(
  db: MigrateDb,
  options: MigrateRunOptions,
): Promise<readonly MigrateRefusal[]> {
  const refusals: MigrateRefusal[] = [];

  // §4.3's own rows, which apply to both callers.
  if (options.env !== "prod" && options.env !== "stage" && options.env !== null) {
    refusals.push({
      reason: "env_invalid",
      message:
        `Refusing: RM_ENV=${String(options.env)} is not a policy this deployment has. Spec §4.1 defines ` +
        "exactly two values, `prod` and `stage`; stage, test and CI are isomorphic and share `stage`.",
    });
  }
  if (options.env === null && options.connection === "remote") {
    refusals.push({
      reason: "env_unset_remote",
      message:
        "Refusing: RM_ENV is not set and the target is a remote database. An unset policy may only run " +
        "against a Postgres this run owns (§4.3), because there is no policy to check the target against.",
    });
  }

  // §8.5's caller split.
  if (options.env === "prod" && options.caller === "smoke_flag") {
    refusals.push({
      reason: "prod_env",
      message:
        "Refusing: `--migrate` is a convenience for stage, test and CI, and refuses on RM_ENV=prod. In " +
        "production an upgrade is an operator intervention — `bun run migrate`, planned per release and " +
        "receipted — and is never part of a boot (spec §8.5).",
    });
  }
  // `prod` + a smoke-owned Postgres is §4.3's own refusal. For `--migrate` the
  // `prod_env` row above already says the whole thing, and adding a second
  // refusal for one situation would report the same fact twice.
  if (options.env === "prod" && options.connection === "local" && options.caller === "operator") {
    refusals.push({
      reason: "env_invalid",
      message:
        "Refusing: RM_ENV=prod against a Postgres this run owns. Production is a remote target; §4.3 " +
        "refuses every `prod` + `--local` combination, because a local database can never be the one " +
        "production's data is in.",
    });
  }

  // The identity row (§4.2). Read once, judged per caller.
  const identity = await readDeploymentIdentity(db);
  if (identity.kind === "missing") {
    refusals.push({
      reason: "identity_missing",
      message:
        "Refusing: this database has no deployment_identity row, so it is not enrolled as anything. " +
        "Absence of evidence is not evidence of rehearsal (spec §4.2).",
    });
  } else if (identity.kind === "ambiguous") {
    refusals.push({
      reason: "identity_missing",
      message:
        `Refusing: deployment_identity holds ${identity.count} rows. It is a one-row table, and no choice ` +
        "between two enrolments is defensible (spec §4.2).",
    });
  } else {
    // `--migrate` is rehearsal-only (§4.3, §8.5). The operator caller may touch
    // a `production` enrolment, but only under the policy that names it: a
    // stage policy "never touches production data", typed owner password or not.
    const mayTouchProduction = options.caller === "operator" && options.env === "prod";
    const required = mayTouchProduction ? "production" : "rehearsal";
    if (identity.value !== required) {
      refusals.push({
        reason: "identity_not_rehearsal",
        message:
          `Refusing: deployment_identity is \`${identity.value}\` and this run requires \`${required}\`. ` +
          (required === "rehearsal"
            ? "Rehearsal-only preparation may not run against a production enrolment (spec §4.3)."
            : "A production run must be pointed at the database enrolled as production (spec §4.3)."),
      });
    }
  }

  return refusals;
}

type IdentityRead =
  | { readonly kind: "present"; readonly value: string }
  | { readonly kind: "missing" }
  | { readonly kind: "ambiguous"; readonly count: number };

/**
 * Read the one-row table, treating "the table is not there" exactly like "the
 * row is not there": both mean the target was never enrolled.
 *
 * The enrolment value is read from whichever column carries it. Spec §4.2 names
 * it `deployment_identity.kind`, which is what migration 0063 creates; a
 * database enrolled before that migration (and every W2 fixture) carries the
 * same value in a column called `identity`. Refusing to read the row because of
 * the column's name would turn an enrolled production database into an
 * un-enrolled one, which is the one misreading with a catastrophic direction.
 */
async function readDeploymentIdentity(db: MigrateDb): Promise<IdentityRead> {
  const [exists] = (await db.unsafe(
    "SELECT to_regclass('public.deployment_identity') IS NOT NULL AS present",
  )) as unknown as { present: boolean }[];
  if (exists?.present !== true) return { kind: "missing" };

  const columns = (await db.unsafe(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'deployment_identity'
      AND column_name IN ('kind', 'identity')`)) as unknown as { column_name: string }[];
  const names = new Set(columns.map((row) => row.column_name));
  const column = names.has("identity") ? "identity" : names.has("kind") ? "kind" : null;
  if (column === null) {
    throw new Error(
      "Refusing: deployment_identity exists but carries neither a `kind` nor an `identity` column, so the " +
        "target's enrolment cannot be read at all (spec §4.2).",
    );
  }

  const rows = (await db.unsafe(
    `SELECT ${column} AS value FROM deployment_identity`,
  )) as unknown as { value: string }[];
  if (rows.length === 0) return { kind: "missing" };
  if (rows.length > 1) return { kind: "ambiguous", count: rows.length };
  return { kind: "present", value: rows[0]?.value ?? "" };
}
