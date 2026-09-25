// `deployment_identity` — the one-row table that tells a tool what the database
// it is connected to is ENROLLED FOR, independently of whatever the operator
// typed into `RM_ENV`. This module reads it, writes it, and implements the
// rehearsal-only gate that `--migrate`, `--seed` and `--spoof-keys` share.
//
// Implemented for issue #1026, W1 step 2. The table itself is created by
// backend/migrations/0063_deployment_identity.sql. Its runtime caller is `bun
// smoke --local dump` (backend/scripts/smoke-prepare.ts `enroll`), which writes
// the restored copy's row as `rehearsal` through rm_owner inside the §2
// mutation fence, using {@link transactionIdentityStore}. A `--local blank`
// bootstrap writes the same row inside its own snapshot transaction
// (backend/src/db/schema-snapshot.ts bootstrapBlankDatabase).
//
// ── Why a row in the database, and not a file or a flag ─────────────────────
//
// Every other signal about "which database is this?" travels WITH the operator:
// an environment variable, a connection string, a command-line flag, a `.env`
// that was copied from somewhere. All of them can be wrong in exactly the same
// way at the same time, because they all came from the same mistaken belief
// about which host the terminal is on. A row inside the target is the only
// signal that travels with the TARGET. It cannot be copied along with a `.env`,
// it cannot be inherited by a shell, and restoring a production dump into a
// rehearsal database carries the production row into the rehearsal database
// exactly once — which is why spec §4.2 requires every `--local dump` restore
// and the documented remote-twin restore procedure to overwrite it with
// `rehearsal` as part of the restore.
//
// ── What it is NOT ──────────────────────────────────────────────────────────
//
// Spec §4.2, quoted because it is the sentence most likely to be forgotten by
// the next person to build on this: "It marks what the target is enrolled for.
// It is an accidental-target safeguard, not proof the data is disposable: its
// protection rests on the write restriction and on the restore procedure being
// pointed at the right database."
//
// So: a `rehearsal` row is not permission to destroy data. It is evidence that
// SOMEONE ENROLLED this database for rehearsal. If the restore procedure was
// aimed at the wrong database, the row is a lie that this module will faithfully
// report. The safeguard it actually provides is the negative one — a database
// that was never enrolled refuses every rehearsal-only operation — and that is
// the property the W1/W2 gates test.
//
// ── Write restriction ───────────────────────────────────────────────────────
//
// Only `rm_owner` may write the row (§4.2), and `rm_owner` is the migration
// login whose password is typed at the terminal for the one run that needs it
// and never stored (§3). The runtime roles handed to containers — `rm_app`,
// `rm_worker`, `rm_readonly` — can read it and cannot change it. That is what
// makes the row worth reading: a compromised or merely buggy application
// process cannot re-label the database it is running against in order to unlock
// `--seed`.
//
// ── Governing spec sections ─────────────────────────────────────────────────
//
//   §4.2  the table, its one row, its two kinds, who may write it, who writes
//         it when.
//   §4.3  the matrix that consumes the value (see smoke-env-policy.ts).
//   §5    `--local blank` / `--local dump` write `rehearsal` as part of the
//         bootstrap; `--local volume` reattaches a volume that must already
//         carry it.
//   §6.4  `--spoof-keys` refuses unless the row says `rehearsal`.
//   §8.5  `--migrate` refuses on `RM_ENV=prod` or identity ≠ `rehearsal`.
//   §9.1  production initialization writes `production` exactly once, via
//         `rm_owner`, receipted, never through `bun smoke`.
//
// Acceptance gates served (spec §10): W1 — the identity half of the policy
// matrix; W2 — "`RM_ENV=stage` + typed owner password against
// `deployment_identity = production` refuses"; W3 — the `--spoof-keys` guards.
//
// ── Layering note ───────────────────────────────────────────────────────────
//
// This module does not depend on `postgres`: the database access is behind
// {@link DeploymentIdentityStore}, opened here over Bun.SQL
// ({@link openDeploymentIdentityStore}) or over a transaction the caller
// already holds ({@link transactionIdentityStore}). The policy it consumes
// comes from backend/src/deploy-policy.ts, which has no dependency either.

// The enrolled kinds, the rehearsal-only gate and the §4.3 matrix are the ONE
// implementation in backend/src/deploy-policy.ts (criterion 13); this module
// keeps the store and the enrollment writes, and re-exports the rest so every
// existing import site reads the same function.
import type { DeploymentIdentityKind } from "../../backend/src/deploy-policy.ts";
export {
  requireRehearsalTarget,
  type DeploymentIdentityKind,
  type RehearsalOnlyPreparation,
} from "../../backend/src/deploy-policy.ts";

/**
 * The row itself.
 *
 * `writtenAt` and `writtenBy` exist for the incident case, not for any control
 * flow: when a refusal says "this database says `production`" the very next
 * question an operator asks is "since when, and by whom", and a row that cannot
 * answer it sends them to the dump's provenance instead. Nothing in the matrix
 * reads these fields.
 */
export interface DeploymentIdentityRow {
  readonly kind: DeploymentIdentityKind;
  /** When the row was last written, UTC ISO-8601. */
  readonly writtenAt: string;
  /** The database role that wrote it; always `rm_owner` in a correct system. */
  readonly writtenBy: string;
  /** Free text from the writing procedure, e.g. which dump a restore came from. */
  readonly note: string | null;
}

/**
 * The result of trying to read the row, as a three-way answer rather than
 * `DeploymentIdentityRow | null`.
 *
 * The third arm is the point. "The table is not there / I could not read it"
 * must never be collapsed into "there is no row", because the matrix treats a
 * missing row as "anything else" (a refusal on rows that name a kind) while a
 * failed read is a DIFFERENT refusal with a different fix: the first means
 * "enroll this database", the second means "your credential cannot see the
 * table". Reporting the second as the first sends an operator to write a row
 * they are not permitted to write.
 */
export type DeploymentIdentityRead =
  | { readonly state: "enrolled"; readonly row: DeploymentIdentityRow }
  | { readonly state: "absent" }
  | { readonly state: "unreadable"; readonly reason: string };

/**
 * The database seam. Implemented on the backend side (which owns `postgres` and
 * the connection pool); consumed here and by every tool in spec §2's list.
 *
 * `read` must be usable with a RUNTIME role: preflight (§7 check 5) runs under
 * the credential a container will use, and it has to be able to see the row it
 * is being judged against. `write` is `rm_owner`-only by the table's own
 * privileges, so an implementation must not try to enforce that in TypeScript —
 * the database is the enforcement, and a TypeScript check on top of it would be
 * a second, weaker copy that drifts.
 */
export interface DeploymentIdentityStore {
  /** Read the single row, or report absent/unreadable. Never throws for a normal absence. */
  read(): Promise<DeploymentIdentityRead>;
  /**
   * Write (insert or replace) the single row. Must be a single statement or a
   * single transaction that leaves exactly one row: the table's shape is "one
   * row", and a partial write that leaves zero or two is worse than no write,
   * because the next reader's answer becomes arbitrary.
   */
  write(kind: DeploymentIdentityKind, note: string | null): Promise<DeploymentIdentityRow>;
  /** Release whatever connection the store holds. */
  close(): Promise<void>;
}

/**
 * Open a store against a connection.
 *
 * Inputs: a connection URL and the role whose credential it carries. Output: a
 * {@link DeploymentIdentityStore}.
 *
 * Refusal cases:
 *  - a URL that is empty or unparseable refuses immediately, naming the source
 *    the caller said it came from, rather than deferring to a connection error
 *    at read time — the read's error text would otherwise be attributed to the
 *    database instead of to the configuration.
 *  - a caller asking for a writable store while naming a non-`rm_owner` role
 *    refuses up front (§4.2: writable only by `rm_owner`). This is a fast,
 *    honest failure, NOT the security boundary; the grant is.
 */
export function openDeploymentIdentityStore(options: {
  readonly databaseUrl: string;
  readonly role: string;
  readonly writable: boolean;
}): DeploymentIdentityStore {
  if (options.databaseUrl.trim() === "") {
    throw new Error("deployment_identity: the connection URL is empty — a configuration error, not a database error.");
  }
  let parsed: URL;
  try {
    parsed = new URL(options.databaseUrl);
  } catch {
    throw new Error(`deployment_identity: the connection URL is unparseable ("${options.databaseUrl}").`);
  }
  if (options.writable && options.role !== "rm_owner") {
    throw new Error(
      `deployment_identity: a writable store requires rm_owner (§4.2); the role given is "${options.role}".`,
    );
  }

  const databaseUrl = options.databaseUrl;
  let client: Bun.SQL | null = null;
  const connection = (): Bun.SQL => (client ??= new Bun.SQL(databaseUrl));

  const store: DeploymentIdentityStore = {
    async read(): Promise<DeploymentIdentityRead> {
      try {
        const rows = (await connection()`
          SELECT kind, written_at, written_by, note FROM deployment_identity
        `) as IdentityRowShape[];
        const row = rows[0];
        return row === undefined ? { state: "absent" } : { state: "enrolled", row: toRow(row) };
      } catch (error) {
        return { state: "unreadable", reason: error instanceof Error ? error.message : String(error) };
      }
    },
    async write(kind: DeploymentIdentityKind, note: string | null): Promise<DeploymentIdentityRow> {
      const rows = (await connection()`
        INSERT INTO deployment_identity (id, kind, written_at, written_by, note)
        VALUES (true, ${kind}, now(), current_user, ${note})
        ON CONFLICT (id) DO UPDATE
          SET kind = EXCLUDED.kind,
              written_at = EXCLUDED.written_at,
              written_by = EXCLUDED.written_by,
              note = EXCLUDED.note
        RETURNING kind, written_at, written_by, note
      `) as IdentityRowShape[];
      const row = rows[0];
      if (row === undefined) throw new Error("deployment_identity: the write returned no row.");
      return toRow(row);
    },
    async close(): Promise<void> {
      await client?.close();
      client = null;
    },
  };

  contexts.set(store, {
    writable: options.writable,
    role: options.role,
    remote: !LOCAL_HOSTS.has(parsed.hostname),
  });
  return store;
}

/** The column shape of the one row, as the driver returns it. */
interface IdentityRowShape {
  readonly kind: DeploymentIdentityKind;
  readonly written_at: string | Date;
  readonly written_by: string;
  readonly note: string | null;
}

function toRow(row: IdentityRowShape): DeploymentIdentityRow {
  return {
    kind: row.kind,
    writtenAt: new Date(row.written_at).toISOString(),
    writtenBy: row.written_by,
    note: row.note,
  };
}

/** Hosts that are not a remote target for the acknowledgement rule below. */
const LOCAL_HOSTS: ReadonlySet<string> = new Set(["", "localhost", "127.0.0.1", "::1"]);

/**
 * How a store was opened. A store this module did not open (a test double, or
 * the backend's own implementation) has no entry, and the enrollment functions
 * then rely on the database's own grant — which §4.2 says is the real boundary.
 */
const contexts = new WeakMap<DeploymentIdentityStore, { writable: boolean; role: string; remote: boolean }>();

function requireWritable(store: DeploymentIdentityStore): void {
  const context = contexts.get(store);
  if (context !== undefined && !context.writable) {
    throw new Error(
      `deployment_identity: writing requires a store opened writable as rm_owner (§4.2); this one is read-only as "${context.role}".`,
    );
  }
}

/**
 * Read the row and reduce it to the value the §4.3 matrix consumes.
 *
 * Output: the kind when enrolled, `null` when the table exists with no row, and
 * the literal `"unreadable"` when the table is missing or the read failed —
 * matching `PolicyInput["identity"]` in smoke-env-policy.ts exactly, so the two
 * modules cannot drift apart on what "no answer" means.
 *
 * Refusal cases: none. This function reports; it does not decide. Every refusal
 * belongs to {@link resolveDeploymentPolicy} or {@link requireRehearsalTarget},
 * because a read that could itself refuse would give the codebase two places
 * that turn an identity into a verdict, and the spec has one (§4.3).
 *
 * Serves spec §10 W1 by being the single input path to the matrix.
 */
export async function readIdentityForPolicy(
  store: DeploymentIdentityStore,
): Promise<DeploymentIdentityKind | null | "unreadable"> {
  const read = await store.read();
  switch (read.state) {
    case "enrolled":
      return read.row.kind;
    case "absent":
      return null;
    case "unreadable":
      return "unreadable";
  }
}

/**
 * Enroll a database as `rehearsal`.
 *
 * Called by `--local blank` bootstrap, by `--local dump` restore, and by the
 * documented remote-twin restore procedure (§4.2). In the `dump` case it is the
 * step that OVERWRITES the `production` row the dump carried in, and it must run
 * as part of the restore — before the restored database is reachable for
 * anything else — because between the restore completing and this write landing
 * there exists a database full of production-shaped data that answers
 * `production` to every guard. That window is unavoidable; leaving it open
 * longer than one step is not.
 *
 * Refusal cases:
 *  - `RM_ENV=prod`: nothing that runs under production policy ever writes
 *    `rehearsal` (it would be the exact inverse of the safeguard).
 *  - the store was not opened writable / the role is not `rm_owner`.
 *  - a remote connection without an explicit operator acknowledgement: writing
 *    `rehearsal` onto a remote database is the one call in this module that can
 *    disarm a protection, so the remote-twin procedure's confirmation is a
 *    parameter here, not a convention in a runbook.
 *
 * Serves spec §10 W2's "`RM_ENV=stage` + typed owner password against
 * `deployment_identity = production` refuses" from the other side: that gate is
 * only meaningful if the rehearsal enrollment path is the one that can flip it.
 */
export async function enrollAsRehearsal(
  store: DeploymentIdentityStore,
  options: { readonly note: string | null; readonly remoteAcknowledged: boolean },
): Promise<DeploymentIdentityRow> {
  if (process.env.RM_ENV === "prod") {
    throw new Error("deployment_identity: a run under RM_ENV=prod never writes `rehearsal` (§4.2).");
  }
  requireWritable(store);
  if (contexts.get(store)?.remote === true && !options.remoteAcknowledged) {
    throw new Error(
      "deployment_identity: writing `rehearsal` onto a REMOTE database disarms a protection; the remote-twin procedure's explicit acknowledgement is required (§4.2).",
    );
  }
  return await store.write("rehearsal", options.note);
}

/**
 * Enroll a database as `production`. Step 3 of the one-time production
 * initialization (§9.1).
 *
 * "`production` is written once by production initialization" (§4.2). Once, by
 * a separate receipted command, never by `bun smoke` — spec §4.3 makes
 * production initialization "a set of separate commands allowed on
 * `production`, each gated by `RM_ENV=prod`, typed `rm_owner`, `y/n`, and a
 * receipt. None is reachable through `bun smoke`."
 *
 * Refusal cases:
 *  - `RM_ENV` is not exactly `prod`.
 *  - the store is not writable as `rm_owner`.
 *  - the operator did not confirm `y/n` at a terminal (a non-interactive
 *    invocation refuses rather than defaulting to yes; an unattended process
 *    that can enroll production is not a thing this repository has).
 *  - the row already says `production` — re-enrollment is a no-op that must
 *    still be reported, not silently rewritten, so the receipt does not claim a
 *    transition that did not happen.
 *  - the row says `rehearsal`: promoting a rehearsal database to production is
 *    never a step in §9.1 and is far more likely to be the wrong connection
 *    string than a real intent. It refuses and names both kinds.
 */
export async function enrollAsProduction(
  store: DeploymentIdentityStore,
  options: { readonly rmEnv: string | undefined; readonly confirmed: boolean; readonly note: string | null },
): Promise<DeploymentIdentityRow> {
  if (options.rmEnv !== "prod") {
    const observed = options.rmEnv === undefined ? "RM_ENV is unset" : `RM_ENV is "${options.rmEnv}"`;
    throw new Error(`deployment_identity: production enrollment requires RM_ENV=prod (§9.1); ${observed}.`);
  }
  if (!options.confirmed) {
    throw new Error(
      "deployment_identity: production enrollment requires the operator's typed y/n confirmation (§9.1); an unconfirmed invocation refuses.",
    );
  }
  requireWritable(store);

  const current = await store.read();
  if (current.state === "enrolled") {
    if (current.row.kind === "production") return current.row;
    throw new Error(
      "deployment_identity: this database is enrolled as `rehearsal`; promoting a rehearsal database to `production` is not a step of §9.1.",
    );
  }
  return await store.write("production", options.note);
}

/**
 * A tagged-template SQL handle, the only thing {@link transactionIdentityStore}
 * needs from a transaction. postgres.js's transaction satisfies it; so does a
 * test double.
 */
export type TemplateSql = (strings: TemplateStringsArray, ...values: never[]) => PromiseLike<unknown>;

/**
 * A store over a transaction the CALLER already holds — the §2 mutation fence.
 *
 * Spec §2 fences "the identity write": it must run in a transaction whose first
 * statement is `pg_advisory_xact_lock`, on the connection performing it. A store
 * that opened its own connection (as {@link openDeploymentIdentityStore} does)
 * would write outside that transaction. So `bun smoke --local dump` opens the
 * fence as rm_owner (backend/src/db/target-lock.ts withMutationFence) and hands
 * its transaction here; {@link enrollAsRehearsal} then writes through it.
 *
 * The write restriction is the database's: the grant lets only rm_owner write
 * the table (§4.2), and this store adds no second, weaker check. `close` is a
 * no-op — the transaction belongs to the fence, which commits or aborts it.
 */
export function transactionIdentityStore(tx: TemplateSql): DeploymentIdentityStore {
  const run = tx as unknown as (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;
  return {
    async read(): Promise<DeploymentIdentityRead> {
      try {
        const rows = (await run`SELECT kind, written_at, written_by, note FROM deployment_identity`) as IdentityRowShape[];
        const row = rows[0];
        return row === undefined ? { state: "absent" } : { state: "enrolled", row: toRow(row) };
      } catch (error) {
        return { state: "unreadable", reason: error instanceof Error ? error.message : String(error) };
      }
    },
    async write(kind: DeploymentIdentityKind, note: string | null): Promise<DeploymentIdentityRow> {
      const rows = (await run`
        INSERT INTO deployment_identity (id, kind, written_at, written_by, note)
        VALUES (true, ${kind}, now(), current_user, ${note})
        ON CONFLICT (id) DO UPDATE
          SET kind = EXCLUDED.kind,
              written_at = EXCLUDED.written_at,
              written_by = EXCLUDED.written_by,
              note = EXCLUDED.note
        RETURNING kind, written_at, written_by, note
      `) as IdentityRowShape[];
      const row = rows[0];
      if (row === undefined) throw new Error("deployment_identity: the write returned no row.");
      return toRow(row);
    },
    async close(): Promise<void> {},
  };
}
