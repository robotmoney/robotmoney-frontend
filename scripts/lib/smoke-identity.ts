// `deployment_identity` — the one-row table that tells a tool what the database
// it is connected to is ENROLLED FOR, independently of whatever the operator
// typed into `RM_ENV`. This module reads it, writes it, and implements the
// rehearsal-only gate that `--migrate`, `--seed` and `--spoof-keys` share.
//
// STUB (issue #1026, W1 step 1). Signatures and types are real; every body
// throws. Nothing imports this module yet, and nothing may import it until the
// implementation lands — it is additive and behaviour-neutral by construction.
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
// `scripts/**` does not import `backend/**` and does not depend on `postgres`
// anywhere today, and this stub does not change that: the database access is
// behind {@link DeploymentIdentityStore}, which the backend side implements.
// Keeping the seam here is not ceremony — it is what lets the matrix and the
// rehearsal gate be unit-tested with no database at all, which the W1 gates
// need if they are to run in CI without provisioning a cluster.

/**
 * The two enrolled kinds of spec §4.2. There is no third value and no `unknown`
 * member: a database with no row is represented by `null` at the read boundary
 * (see {@link DeploymentIdentityRead}), never by a widened union, so that a
 * `switch` over this type stays exhaustive and an un-enrolled database can
 * never be accidentally handled by a `default` branch meant for a future kind.
 */
export type DeploymentIdentityKind = "production" | "rehearsal";

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
  void options;
  throw new Error("NOT IMPLEMENTED: deployment_identity store — spec §4.2, issue #1026 W1.2");
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
export function readIdentityForPolicy(
  store: DeploymentIdentityStore,
): Promise<DeploymentIdentityKind | null | "unreadable"> {
  void store;
  throw new Error("NOT IMPLEMENTED: identity read for the policy matrix — spec §4.2/§4.3, issue #1026 W1.2");
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
export function enrollAsRehearsal(
  store: DeploymentIdentityStore,
  options: { readonly note: string | null; readonly remoteAcknowledged: boolean },
): Promise<DeploymentIdentityRow> {
  void store;
  void options;
  throw new Error("NOT IMPLEMENTED: write deployment_identity = rehearsal — spec §4.2/§5, issue #1026 W1.2");
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
export function enrollAsProduction(
  store: DeploymentIdentityStore,
  options: { readonly rmEnv: string | undefined; readonly confirmed: boolean; readonly note: string | null },
): Promise<DeploymentIdentityRow> {
  void store;
  void options;
  throw new Error("NOT IMPLEMENTED: write deployment_identity = production — spec §4.2/§9.1, issue #1026 W1.2");
}

/**
 * Which rehearsal-only preparation is being requested. Spec §4.3:
 * "Rehearsal-only preparation: `--migrate`, `--seed`, `--spoof-keys` require
 * `rehearsal` in addition to their own guards."
 *
 * "In addition to" is the load-bearing phrase: this gate does not replace
 * `--seed`'s refusal of a populated database (§5), `--migrate`'s prompt-and-
 * `y/n` on a remote connection (§8.5), or `--spoof-keys`'s four guards (§6.4).
 * It is the floor under all three.
 */
export type RehearsalOnlyPreparation = "migrate" | "seed" | "spoof-keys";

/**
 * The shared gate. One function for all three flags, so a fourth preparation
 * added later cannot ship with two of the three checks.
 *
 * Inputs: which preparation, the resolved `RM_ENV`, and the identity read.
 * Output: allow, or refuse with a reason naming the preparation, the policy and
 * the observed identity.
 *
 * Refusal cases, every one of which must be its own branch with its own text:
 *  - `RM_ENV=prod`, whatever the identity says. A production-policy run never
 *    prepares; production upgrades are an operator intervention (§8.5).
 *  - identity `production`.
 *  - identity absent — an un-enrolled database is not a rehearsal database.
 *  - identity `"unreadable"` — no evidence, no preparation.
 *  - the flag was not passed explicitly. §5: `--seed` "is explicit … and is
 *    never implied by any mode"; §6.4: `--spoof-keys` refuses when the "flag
 *    [is] not explicit". A preparation that a mode can imply is a preparation
 *    that happens by surprise.
 *
 * Serves spec §10 W1 (the rehearsal half of the lifecycle gates), §10 W2
 * ("Unattended CI boot `--local blank --migrate --seed`" must still pass, so
 * the gate has to allow a correctly-enrolled local database without a prompt)
 * and §10 W3 (`--spoof-keys` guards).
 */
export function requireRehearsalTarget(request: {
  readonly preparation: RehearsalOnlyPreparation;
  readonly rmEnv: string | undefined;
  readonly identity: DeploymentIdentityKind | null | "unreadable";
  readonly explicitlyRequested: boolean;
}): { readonly allow: true } | { readonly allow: false; readonly reason: string } {
  void request;
  throw new Error("NOT IMPLEMENTED: rehearsal-only preparation gate — spec §4.3, issue #1026 W1.2");
}
