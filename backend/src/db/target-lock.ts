// The target-lock protocol — smoke-production-spec.md §2, in full.
//
// STATUS. Implemented and proved against a live Postgres by
// backend/tests/target-lock.test.ts. It is a library: the tools in §2's caller
// list are moved onto it by later #1026 work, and until each is, that tool
// takes no target lock of its own.
//
// ── The invariant, quoted verbatim from spec §2 ─────────────────────────────
//
//   **Invariant.** Loss of the coordinating lock never lets a competing tool
//   overlap a mutation still executing. A cancellation request is not evidence
//   the mutation stopped.
//
// Both sentences are load-bearing and the second is the one that gets designed
// away. When a tool's lock connection dies, or an operator presses Ctrl-C, or a
// `statement_timeout` fires, the tool learns that it ASKED for something to
// stop. It does not learn that the something stopped. A `pg_cancel_backend`
// returns true when the signal was delivered, not when the query ended. A
// dropped TCP connection tells the client nothing about the transaction on the
// other side, which may still be committing. Every design that treats
// "I lost the lock" as "my mutation is over" is wrong, and it is wrong in the
// single worst way available: two migration runs applying DDL to one database
// at the same time.
//
// ── Why one protocol for every tool ─────────────────────────────────────────
//
// §2's first line names the callers: `bun smoke`, `bun run migrate`,
// `--spoof-keys`, and the production-initialization commands (§9). (§2 once
// listed an enable command too; system-scheduler-spec.md §12 removed it from
// that list along with the schedules it enabled.) They are separate programs,
// started by different people from
// different machines, and nothing on the host serializes them. The database is
// the only thing all of them touch, so the database is the only place a lock
// can live. A file lock on the deploy host does not protect a database that a
// second operator can reach from a second host — and `scripts/lib/smoke-state.ts`'s
// deployment lock is exactly that file lock, deliberately a different lock for
// a different question ("two runs of one instance") than this one ("two tools
// on one database").
//
// ── The two locks, and why one is not enough ────────────────────────────────
//
// SESSION LOCK (`pg_advisory_lock`) — the COORDINATION layer. Taken on a
// dedicated connection and held for the whole run: "Smoke holds it from
// acquisition through preflight, replacement, and readiness, so a standalone
// migration cannot land between preflight and the new containers starting."
// That sentence is the reason the lock spans phases rather than wrapping each
// one. Preflight verifies a database; the containers then boot against it; if a
// migration slips into the gap, preflight verified something that no longer
// exists and the guarantee it produced is worthless.
//
// A session lock has one weakness: it dies with its session. When the
// coordinator's connection drops, Postgres releases it, and a competitor can
// acquire it immediately — while the coordinator's OTHER connection may still
// be inside an uncommitted mutation. That is the invariant's failure mode.
//
// XACT FENCE (`pg_advisory_xact_lock`) — the SAFETY layer, and the answer to
// it. "Every mutation (migration, grant reconciliation, seed, key rebind,
// token provisioning, identity write) runs in a transaction that first takes
// `pg_advisory_xact_lock` on the same key, ON THE CONNECTION PERFORMING IT. A
// competitor that wins the session lock after the coordinator's connection died
// still blocks on the xact lock until the in-flight mutation commits or
// aborts."
//
// The fence is held by the transaction itself, so it cannot outlive the
// mutation and cannot be lost while the mutation runs: Postgres releases it at
// commit or abort, and at no other moment. The session lock keeps tools from
// starting; the fence keeps them from overlapping. Neither alone satisfies the
// invariant, and the emphasis on "on the connection performing it" is not
// decoration — a fence taken on the coordinating connection instead of the
// mutating one is released when the coordinating connection dies, which is the
// exact scenario it exists for.
//
// ── One constant key, and why that is enough ────────────────────────────────
//
// §2 as amended by D52: "takes a session-level `pg_advisory_lock` on one
// constant key. Postgres already scopes advisory locks to a single database, so
// every tool that reaches the same database contends, whatever hostname it
// used." An advisory lock is identified by (database, key): `pg_locks` carries
// the database oid beside classid/objid, and two databases on one cluster never
// see each other's advisory locks. So the database IS already part of the key,
// supplied by the server, and every tool on one database contends the moment
// they share any constant at all.
//
// The key used to be DERIVED instead — SHA-256 over `pg_control_system()`'s
// system identifier and `current_database()`. That derivation bought nothing
// the server does not already do, and it could fail in the worst way: the
// system identifier is readable only by superusers and `pg_monitor` by
// default, so a tool connected as a least-privilege role could not compute the
// key another tool computed, and two tools in two namespaces never contend. A
// constant cannot drift between tools, roles, hosts or releases.
//
// What the constant does NOT protect against is a connection that is not a
// session: a transaction-mode pooler hands each statement to whichever server
// backend is free, so a session lock taken in one statement belongs to a
// backend the next statement may never see again. §2: "The connection is
// direct, never through a transaction-mode pooler, which silently breaks
// session locks." {@link acquireTargetLock} refuses one — see
// {@link refusePoolerUrl} and {@link judgeSessionProbe}.
//
// ── Governing spec sections ─────────────────────────────────────────────────
//
//   §2    the entire protocol: coordination, fencing, acquisition point,
//         revalidation, contention, connection loss.
//   §1.2  smoke holds the target lock alongside the deployment lock for the
//         whole run.
//   §8.3  the migrate run is "fence (§2) → apply pending migrations … → grant
//         reconciliation → publish the manifest".
//   §6.4  the spoofed-key rebind is "one fenced transaction".
//   §9.1  the production-initialization commands are in the caller list.
//
// Acceptance gates served (spec §10, W1):
//   - "Two instances preparing the same remote database serialize on the target
//      lock." (Two hostnames for one database contend: the key is constant.)
//   - "Kill the lock connection mid-migration, start a second mutation tool: no
//      overlap."
//   - "Standalone `bun run migrate` and `bun smoke` contend on the target lock,
//      including connection loss mid-phase."

import { createHash, randomUUID } from "node:crypto";
import postgres from "postgres";
import type postgresTypes from "postgres";
import type { DbHandle } from "./client.ts";

// Every catalog question below reassembles the key the way `pg_locks` splits
// it: `classid` is the high 32 bits, `objid` the low 32. Every question that
// could see ANOTHER backend's lock also filters on `database`: the key is one
// constant, so the same key held on a sibling database of the same cluster is a
// different lock and must never be reported as this one.
//
// ── Why the two layers use the two SPELLINGS of one key ─────────────────────
//
// §2 puts the session lock and the fence on the same key, and a coordinator
// holds the session lock for the whole run while its own mutations run on
// OTHER connections (§2 is emphatic that the fence goes on the mutating
// connection). Taken in the same form, those two would conflict: the tool's own
// fence would block forever on the tool's own session lock, one connection
// waiting on another connection of the same process. So the two layers use the
// two argument forms Postgres offers for one 64-bit key — the session lock the
// `(int4, int4)` form (`objsubid = 2`), the fence the `int8` form
// (`objsubid = 1`). They are distinct lock objects, so the layers never block
// each other, while session-vs-session and fence-vs-fence still serialize
// exactly as the spec requires. `pg_locks` reports both under the same
// classid/objid, which is the same key by the only reading that matters to an
// operator reading the catalog.
const OBJSUBID_SESSION = 2;
const OBJSUBID_FENCE = 1;

/**
 * The advisory-lock key of §2.
 *
 * Branded so "some number I had lying around" is untypeable at a call site: the
 * only value of this type is {@link TARGET_LOCK_KEY}, and no function in this
 * module takes a key from its caller. A second key would be a second namespace,
 * and two tools in two namespaces never contend — which looks exactly like a
 * working system until the day it matters.
 */
export type TargetLockKey = bigint & { readonly __brand: "TargetLockKey" };

/**
 * THE key: one constant, for every tool and every database (D52; see the
 * header's "One constant key"). Postgres scopes an advisory lock to the
 * database it was taken in, so this one value already means "this database".
 *
 * The number is the literal `backend/tests/migrate-run.test.ts` has always
 * passed as its lock key, so the migrate runner moving onto this constant
 * changes no value that runner's tests already pin. It is non-negative, which
 * is what makes the catalog's classid/objid split reassemble to exactly it.
 */
export const TARGET_LOCK_KEY = 7726322199513601n as TargetLockKey;

/** The key as the `(int4, int4)` form takes it: high half, then low half as a signed int4. */
function keyHalves(key: TargetLockKey): { hi: number; lo: number } {
  const hi = Number(key >> 32n);
  const low = Number(key & 0xffffffffn);
  return { hi, lo: low >= 0x80000000 ? low - 0x100000000 : low };
}

/**
 * How a session-lock holder publishes itself.
 *
 * `application_name` is the only per-connection string another session can read
 * (through `pg_stat_activity`) without a table, and a table would need a
 * migration to exist before the lock that protects migrations can be taken.
 * Postgres truncates it to 63 bytes, so the fields are ordered by how much a
 * contention refusal needs them — tool, plan id, pid, instance, host — and
 * `acquiredAt` is not in it at all: the server already knows when that
 * connection opened (`backend_start`), which is the same instant.
 *
 * THE PLAN ID IS ABBREVIATED to {@link PLAN_ID_SHOWN} hex characters, the way
 * `git` abbreviates a commit. The full id is 64 characters and would leave no
 * room for anything else; 48 bits are ample to tell an operator WHICH printed
 * plan (§1.2, whose last line is the full id) the holder is running. A tool
 * with no plan (a standalone `bun run migrate`) publishes `-`.
 */
const HOLDER_PREFIX = "rm-tl:";
const APP_NAME_MAX = 63;
export const PLAN_ID_SHOWN = 12;
/** The instance gets at most this much, so the host is never squeezed out entirely. */
const INSTANCE_SHOWN = 24;

/** A field must not contain the separator; anything else is Postgres's to sanitize. */
function field(value: string): string {
  return value.replaceAll("|", "_");
}

function encodeHolder(holder: Omit<LockHolder, "acquiredAt">): string {
  const plan = holder.planId === null ? "-" : field(holder.planId.slice(0, PLAN_ID_SHOWN));
  const instance = field((holder.instance ?? "").slice(0, INSTANCE_SHOWN));
  return `${HOLDER_PREFIX}${field(holder.tool)}|${plan}|${holder.pid}|${instance}|${field(holder.host)}`.slice(
    0,
    APP_NAME_MAX,
  );
}

function decodeHolder(applicationName: string | null, backendStart: Date | string | null): LockHolder | null {
  if (applicationName === null || !applicationName.startsWith(HOLDER_PREFIX)) return null;
  const [tool, plan, pid, instance, host] = applicationName.slice(HOLDER_PREFIX.length).split("|");
  if (tool === undefined || plan === undefined || pid === undefined) return null;
  return {
    tool,
    planId: plan === "-" || plan === "" ? null : plan,
    instance: instance === undefined || instance === "" ? null : instance,
    host: host ?? "",
    pid: Number(pid),
    acquiredAt: backendStart instanceof Date ? backendStart.toISOString() : String(backendStart ?? ""),
  };
}

/** The operator-facing name of a holder, used by every refusal that names one. */
export function describeHolderText(holder: LockHolder | null): string {
  if (holder === null) return "an unidentified tool";
  const instance = holder.instance === null ? "" : ` (instance ${holder.instance})`;
  const plan = holder.planId === null ? "with no plan id (a standalone tool)" : `under plan ${holder.planId}`;
  return `${holder.tool}${instance} ${plan}, on ${holder.host || "an unnamed host"} pid ${holder.pid}, since ${holder.acquiredAt}`;
}

/**
 * Ports on which the providers this repository deploys to serve a
 * TRANSACTION-MODE pooler instead of Postgres. A URL on one of these is refused
 * before a connection is opened: nothing the probe below learns can make a
 * session lock through a transaction pooler safe.
 */
export const KNOWN_POOLER_PORTS: ReadonlyMap<number, string> = new Map([
  [25061, "the DigitalOcean managed pooler (PgBouncer) port; the direct port is 25060"],
  [6432, "PgBouncer's default port"],
]);

/**
 * Refuse a connection URL that names a pooler. Throws; returns nothing.
 *
 * Refusal cases: an unparseable URL (a target this module cannot vet is not a
 * target it may lock); a port in {@link KNOWN_POOLER_PORTS}; a `pgbouncer`
 * query parameter set to anything but `false`.
 */
export function refusePoolerUrl(databaseUrl: string): void {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error("target lock: the connection URL cannot be parsed, so it cannot be shown to be a direct connection.");
  }
  const port = url.port === "" ? 5432 : Number(url.port);
  const pooler = KNOWN_POOLER_PORTS.get(port);
  if (pooler !== undefined) {
    throw new Error(
      `target lock: refusing ${url.hostname}:${port}, which is ${pooler}. A transaction-mode pooler hands each ` +
        "statement to whichever backend is free, so a session lock taken through it is not held by this tool. " +
        "Connect to the database's direct port.",
    );
  }
  const flag = url.searchParams.get("pgbouncer");
  if (flag !== null && flag !== "false") {
    throw new Error(
      `target lock: refusing a URL marked pgbouncer=${flag}. A session lock through a transaction-mode pooler is ` +
        "not held by this tool. Connect to the database's direct port.",
    );
  }
}

/** Two statements' view of their own session, for {@link judgeSessionProbe}. */
export interface SessionProbeReading {
  readonly pid: number;
  /** The session-level setting the first statement wrote, as the second statement reads it. */
  readonly probe: string | null;
}

/**
 * Decide whether two consecutive statements ran in ONE server session.
 *
 * The first statement writes a random value into a session-level setting and
 * reports its backend pid; the second reads the setting back and reports its
 * pid. On a direct connection both match. Through a transaction-mode pooler the
 * second statement may land on another backend, which reports a different pid
 * and has never heard of the setting.
 *
 * Output: `null` for one session, else the refusal text naming what was
 * expected and what was observed.
 *
 * What it cannot catch: a pooler that happens to hand back the same backend
 * while nothing else is using it. That is why {@link refusePoolerUrl} refuses
 * the known pooler ports outright rather than trusting this probe to.
 */
export function judgeSessionProbe(nonce: string, first: SessionProbeReading, second: SessionProbeReading): string | null {
  if (second.pid !== first.pid || second.probe !== nonce) {
    return (
      `target lock: two consecutive statements did not run in one session (backend pid ${first.pid} then ` +
      `${second.pid}; a session setting written as ${nonce} read back as ${second.probe ?? "unset"}). ` +
      "A transaction-mode pooler is in the path, and a session lock through it is not held by this tool. " +
      "Connect to the database's direct port."
    );
  }
  return null;
}

/**
 * A connection of this module's own, never the pool of `db/client.ts`.
 *
 * `max: 1` because a session lock belongs to one backend; `idle_timeout` and
 * `max_lifetime` disabled because postgres.js would otherwise recycle the
 * backend out from under a lock that is supposed to last the whole run, which
 * is the pooled-connection failure the spec rules out.
 */
function dedicatedClient(databaseUrl: string, applicationName: string): postgresTypes.Sql<{}> {
  return postgres(databaseUrl, {
    max: 1,
    idle_timeout: 0,
    max_lifetime: 0,
    onnotice: () => {},
    connection: { application_name: applicationName },
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Which tool holds (or wants) the lock, recorded so a contention refusal can name the holder. */
export interface LockHolder {
  /** `smoke` | `migrate` | `spoof-keys` | a §9.1 command name. */
  readonly tool: string;
  /**
   * The plan id (§1.2) the tool is executing, or `null` for a tool that has no
   * plan. Explicit rather than optional, so every caller decides. A holder read
   * back from the catalog carries the {@link PLAN_ID_SHOWN}-character prefix.
   */
  readonly planId: string | null;
  /** The deployment instance (§1.1), when the tool has one. */
  readonly instance: string | null;
  /** Host and PID, so an operator can go find it. */
  readonly host: string;
  readonly pid: number;
  readonly acquiredAt: string;
}

/**
 * A held session-level target lock, on its own dedicated connection.
 *
 * "The tool opens ONE DEDICATED CONNECTION and takes a session-level
 * `pg_advisory_lock`" (§2). Dedicated is a requirement, not an optimization: a
 * session lock taken on a pooled connection is released the moment the pool
 * hands that connection to someone else or recycles it, so the lock's lifetime
 * would be decided by pool pressure rather than by the run. The pool in
 * `db/client.ts` is therefore never the right place to take this.
 */
export interface TargetLock {
  readonly key: TargetLockKey;
  readonly holder: LockHolder;
  /**
   * The dedicated connection the session lock lives on. Exposed ONLY so
   * {@link assertStillHeld} can interrogate it. Callers must not run mutations
   * here: mutations run on their own connection and take their own fence (§2,
   * "on the connection performing it").
   */
  readonly connection: DbHandle;
  /**
   * Prove the lock is still held, right now, by asking the server — never by
   * consulting a local flag. See {@link assertStillHeld}.
   */
  stillHeld(): Promise<boolean>;
  /**
   * Release explicitly. §2: "It is released explicitly on exit." Explicit
   * because relying on connection teardown makes the release happen at an
   * unspecified time, and a lock that lingers after a tool exits is a
   * contention refusal for the next operator with no holder to name. See
   * {@link releaseTargetLockOnExit} for the exit and signal paths.
   */
  release(): Promise<void>;
}

/**
 * Wrap an acquired session lock and its dedicated connection.
 *
 * `stillHeld` always asks the server and never reads a local flag — including
 * after {@link TargetLock.release}, where the round trip fails because the
 * connection is gone. A question that cannot be answered is answered `false`:
 * §2 gives "not held", "connection dead" and "cannot tell" the same verdict.
 */
function makeLock(holder: LockHolder, client: postgresTypes.Sql<{}>): TargetLock {
  const key = TARGET_LOCK_KEY;
  let released = false;
  return {
    key,
    holder,
    connection: client,
    async stillHeld(): Promise<boolean> {
      try {
        const rows = await client<{ count: string }[]>`
          SELECT count(*)::text AS count FROM pg_locks
           WHERE locktype = 'advisory' AND granted
             AND pid = pg_backend_pid()
             AND objsubid = ${OBJSUBID_SESSION}
             AND ((classid::bigint << 32) | objid::bigint) = ${key.toString()}::bigint`;
        return Number(rows[0]?.count ?? "0") > 0;
      } catch {
        return false;
      }
    },
    async release(): Promise<void> {
      if (released) return;
      released = true;
      try {
        const { hi, lo } = keyHalves(key);
        await client`SELECT pg_advisory_unlock(${hi}::int4, ${lo}::int4)`;
      } catch {
        // The connection is already gone, which released the lock for us.
      }
      await client.end({ timeout: 5 });
    },
  };
}

/** What happened when a tool tried to take the lock. */
export type AcquireResult =
  | { readonly acquired: true; readonly lock: TargetLock }
  /**
   * §2, Contention: "A tool that finds the lock held waits with a timeout, then
   * refuses naming the holder." `holder` may be `null` when the holder's
   * identity could not be read — the refusal still stands; an unidentifiable
   * holder is not an absent one.
   *
   * §2, Revalidation: the lock was acquired, but the target moved while the
   * tool waited. The lock has already been released; `holder` is `null`
   * because nobody else holds it, and `reason` names each expectation and the
   * value observed.
   */
  | {
      readonly acquired: false;
      readonly refusal: "contention" | "revalidation";
      readonly holder: LockHolder | null;
      readonly waitedMs: number;
      readonly reason: string;
    };

/**
 * Acquire the session-level target lock on a dedicated connection, then
 * revalidate the plan against the locked target.
 *
 * ACQUISITION POINT, from §2 verbatim: "After any local database is created or
 * restored, before the first read used for a decision."
 *
 * Both halves are exact. After creation/restore, because there is nothing to
 * lock before the database exists, and a `--local dump` restore is itself the
 * thing that puts production-shaped bytes on disk. Before the first read used
 * for a decision, because a decision made on an unlocked read is a decision
 * made on state that can move before it is acted on — and the whole protocol
 * exists to close exactly that window.
 *
 * Inputs: a connection URL for the dedicated connection, the holder identity to
 * publish, a contention timeout, and `expected` — the {@link TargetState} the
 * plan was built from, read before the lock existed. Output:
 * {@link AcquireResult}.
 *
 * Refusal cases:
 *  - the URL names a pooler ({@link refusePoolerUrl}), or two consecutive
 *    statements do not share one session ({@link judgeSessionProbe}), or the
 *    lock just taken is not visible to the next statement: throws. A session
 *    lock through a transaction-mode pooler is not held by this tool.
 *  - the lock is held and stays held past `timeoutMs`: refuse, naming the
 *    holder (tool, plan id, instance, host, pid, since when). Do NOT retry
 *    forever: an unbounded wait inside a deployment is indistinguishable from
 *    a hang, and an operator who cannot tell those apart eventually kills the
 *    process holding a fence.
 *  - `pg_try_advisory_lock` succeeds but {@link revalidateAfterAcquire} fails:
 *    release and refuse. Holding a lock on a database that is not the one the
 *    plan was built against is worse than not holding one, because it blocks
 *    the tool that IS right about the target.
 *  - the dedicated connection cannot be opened: throws.
 *
 * Serves spec §10 W1: "Standalone `bun run migrate` and `bun smoke` contend on
 * the target lock."
 */
export async function acquireTargetLock(options: {
  readonly databaseUrl: string;
  readonly holder: Omit<LockHolder, "acquiredAt">;
  readonly timeoutMs: number;
  readonly expected: TargetState;
}): Promise<AcquireResult> {
  refusePoolerUrl(options.databaseUrl);
  const key = TARGET_LOCK_KEY;
  const client = dedicatedClient(options.databaseUrl, encodeHolder(options.holder));
  const started = Date.now();
  const deadline = started + options.timeoutMs;
  let handedOver = false;
  try {
    const nonce = randomUUID();
    const [first] = await client<{ pid: number; probe: string }[]>`
      SELECT pg_backend_pid() AS pid, set_config('rm_tl.session_probe', ${nonce}, false) AS probe`;
    const [second] = await client<{ pid: number; probe: string | null }[]>`
      SELECT pg_backend_pid() AS pid, current_setting('rm_tl.session_probe', true) AS probe`;
    const pooled = judgeSessionProbe(
      nonce,
      { pid: first?.pid ?? -1, probe: first?.probe ?? null },
      { pid: second?.pid ?? -2, probe: second?.probe ?? null },
    );
    if (pooled !== null) throw new Error(pooled);

    const { hi, lo } = keyHalves(key);
    for (;;) {
      const rows = await client<{ locked: boolean }[]>`
        SELECT pg_try_advisory_lock(${hi}::int4, ${lo}::int4) AS locked`;
      if (rows[0]?.locked === true) break;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        // The wait is over and the lock is still someone else's. Name them if
        // the server can, and refuse either way: an unidentifiable holder is
        // not an absent one.
        const holder = await describeHolder(client).catch(() => null);
        const waitedMs = Date.now() - started;
        return {
          acquired: false,
          refusal: "contention",
          holder,
          waitedMs,
          reason: `target lock ${key} is held by ${describeHolderText(holder)}; waited ${waitedMs}ms and gave up.`,
        };
      }
      await sleep(Math.min(50, remaining));
    }

    const lock = makeLock({ ...options.holder, acquiredAt: new Date().toISOString() }, client);
    // The lock was taken by one statement; prove the NEXT statement's session
    // holds it. A pooler that moved us between the two fails here even when
    // the probe above was lucky.
    if (!(await lock.stillHeld())) {
      await lock.release();
      handedOver = true;
      throw new Error(
        `target lock ${key}: the session lock just taken is not held by the session serving the next statement. ` +
          "A transaction-mode pooler is in the path. Connect to the database's direct port.",
      );
    }
    const verdict = await revalidateAfterAcquire(lock, options.expected);
    if (!verdict.ok) {
      await lock.release();
      handedOver = true;
      return {
        acquired: false,
        refusal: "revalidation",
        holder: null,
        waitedMs: Date.now() - started,
        reason: `target lock ${key} was acquired and released again: the target moved while this tool waited. ${verdict.reason}`,
      };
    }
    handedOver = true;
    return { acquired: true, lock };
  } finally {
    if (!handedOver) await client.end({ timeout: 5 });
  }
}

/**
 * What a plan believed about its target, read before the lock existed, and
 * re-read after acquiring it. §2: "the tool re-reads `deployment_identity`, the
 * ledger, and the schema manifest".
 */
export interface TargetState {
  /** `deployment_identity.kind`. No row reads as `rehearsal` (§4.2). */
  readonly identity: "production" | "rehearsal";
  /**
   * EVERY applied migration filename, in filename order; `[]` when the ledger
   * is absent or empty. The whole list, never the head: spec §8.1 makes the
   * filename list the schema identity, and a migration with a LOWER filename
   * than the head can land while the tool waits and leave the head unchanged.
   */
  readonly ledger: readonly string[];
  /** `schema_manifest.content_hash`, or `null` when the target has no manifest. */
  readonly manifestHash: string | null;
}

type Reading<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

async function readIdentity(conn: DbHandle): Promise<Reading<"production" | "rehearsal">> {
  try {
    const rows = await conn<{ kind: string }[]>`SELECT kind FROM deployment_identity LIMIT 1`;
    const kind = rows[0]?.kind ?? "rehearsal";
    if (kind !== "production" && kind !== "rehearsal") return { ok: false, error: `unknown kind ${kind}` };
    return { ok: true, value: kind };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

async function readLedger(conn: DbHandle): Promise<Reading<readonly string[]>> {
  try {
    // An ABSENT table is an answer ("no ledger"); an unreadable one is not.
    const [exists] = await conn<{ present: boolean }[]>`
      SELECT to_regclass('schema_migrations') IS NOT NULL AS present`;
    if (exists?.present !== true) return { ok: true, value: [] };
    // The column is `name`: the migration's FULL FILENAME (spec §8.1).
    const rows = await conn<{ name: string }[]>`SELECT name FROM schema_migrations ORDER BY name`;
    return { ok: true, value: rows.map((row) => row.name) };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

async function readManifest(conn: DbHandle): Promise<Reading<string | null>> {
  try {
    const [exists] = await conn<{ present: boolean }[]>`
      SELECT to_regclass('schema_manifest') IS NOT NULL AS present`;
    if (exists?.present !== true) return { ok: true, value: null };
    const rows = await conn<{ content_hash: string }[]>`SELECT content_hash FROM schema_manifest LIMIT 1`;
    return { ok: true, value: rows[0]?.content_hash ?? null };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * Read the target's {@link TargetState} — what a plan is built from, and what
 * {@link revalidateAfterAcquire} compares against. Throws when any part cannot
 * be read: a plan cannot be built on an answer nobody got.
 */
export async function readTargetState(conn: DbHandle): Promise<TargetState> {
  const [identity, ledger, manifest] = [await readIdentity(conn), await readLedger(conn), await readManifest(conn)];
  if (!identity.ok) throw new Error(`deployment_identity could not be read: ${identity.error}`);
  if (!ledger.ok) throw new Error(`the migration ledger could not be read: ${ledger.error}`);
  if (!manifest.ok) throw new Error(`the schema manifest could not be read: ${manifest.error}`);
  return { identity: identity.value, ledger: ledger.value, manifestHash: manifest.value };
}

/** A short, stable name for a ledger list, so two lists can be compared by eye in a refusal. */
export function ledgerDigest(ledger: readonly string[]): string {
  return createHash("sha256").update(ledger.join("\n")).digest("hex").slice(0, 12);
}

function describeLedger(ledger: readonly string[]): string {
  const tail = ledger.at(-1);
  return `${ledger.length} file(s)${tail === undefined ? "" : ` ending ${tail}`} (list ${ledgerDigest(ledger)})`;
}

/**
 * §2, Revalidation: "After acquiring, the tool re-reads `deployment_identity`,
 * the ledger, and the schema manifest and re-runs the plan against them. A
 * mismatch refuses." {@link acquireTargetLock} calls this itself; it is
 * exported for tools that must re-check again later under the same lock.
 *
 * The reason is a race that is easy to miss: everything the plan was built from
 * was read BEFORE the lock existed, so any of it may have changed while the
 * tool waited to acquire — including the case where the change was made by the
 * very holder this tool was queued behind. Revalidating turns "the plan was
 * true when I wrote it" into "the plan is true now, and nothing can change it
 * while I hold this".
 *
 * All three are re-read on every call, and a mismatch in any one refuses:
 *  - `deployment_identity` (§4.2): the target was re-enrolled, so every policy
 *    decision in the plan (§4.3) was taken against a different answer.
 *  - the migration ledger, compared as the WHOLE filename list: migrations
 *    landed while waiting, so the schema the plan expects is not the schema
 *    present. `[]` is a claim ("there was no ledger"), not an absence of one.
 *  - the schema manifest (§8.3): the declared schema moved, or appeared. A
 *    `null` expectation is the claim "there was no manifest", so a manifest
 *    that appeared while the tool waited refuses too.
 *
 * Every reason names the plan's value and the value observed. An unreadable
 * input is a mismatch, not a pass. Note that the catch cannot tell a broken
 * query from a genuinely unreadable table, so anything it reports deserves to
 * be read as a possible bug and not only as a mismatch: the ledger read once
 * named a column that does not exist and "refused" every run for that reason.
 */
export async function revalidateAfterAcquire(
  lock: TargetLock,
  expected: TargetState,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> {
  const conn = lock.connection;
  const reasons: string[] = [];

  const identity = await readIdentity(conn);
  if (!identity.ok) {
    reasons.push(
      `deployment_identity could not be re-read (${identity.error}); the plan was built against ${expected.identity}, ` +
        "and an unreadable identity is a mismatch",
    );
  } else if (identity.value !== expected.identity) {
    reasons.push(`deployment_identity is ${identity.value}, but the plan was built against ${expected.identity}`);
  }

  const ledger = await readLedger(conn);
  if (!ledger.ok) {
    reasons.push(
      `the migration ledger could not be re-read (${ledger.error}); the plan was built against ` +
        `${describeLedger(expected.ledger)}, and an unreadable ledger is a mismatch`,
    );
  } else {
    const actual = ledger.value;
    const same = actual.length === expected.ledger.length && actual.every((name, index) => name === expected.ledger[index]);
    if (!same) {
      let index = 0;
      while (index < actual.length && actual[index] === expected.ledger[index]) index += 1;
      reasons.push(
        `the migration ledger holds ${describeLedger(actual)}, but the plan was built against ` +
          `${describeLedger(expected.ledger)}; the first difference is at position ${index + 1}: ` +
          `${actual[index] ?? "nothing"} where the plan had ${expected.ledger[index] ?? "nothing"}`,
      );
    }
  }

  const manifest = await readManifest(conn);
  if (!manifest.ok) {
    reasons.push(
      `the schema manifest could not be re-read (${manifest.error}); the plan was built against ` +
        `${expected.manifestHash ?? "no manifest"}, and an unreadable manifest is a mismatch`,
    );
  } else if (manifest.value !== expected.manifestHash) {
    reasons.push(
      `the schema manifest hash is ${manifest.value ?? "absent"}, but the plan was built against ` +
        `${expected.manifestHash ?? "no manifest"}`,
    );
  }

  return reasons.length === 0 ? { ok: true } : { ok: false, reason: reasons.join("; ") };
}

/**
 * §2: "It is released explicitly on exit." Install the exit paths for a held
 * lock and return a disposer that removes them.
 *
 *  - SIGINT / SIGTERM: release, then exit non-zero (130 / 143). The release is
 *    bounded, so a dead network cannot turn a signal into a hang.
 *  - `beforeExit` (the event loop drained): release.
 *  - `exit` and SIGKILL: no code can run a round trip there. The kernel closes
 *    the socket when the process dies and Postgres drops the session and its
 *    lock with it. The explicit paths above exist so the ordinary endings do
 *    not depend on that.
 *
 * A tool that stops at phase boundaries on a signal (smoke, through
 * `watchForInterrupt` in scripts/lib/smoke-journal.ts) must not install this:
 * it would exit mid-phase. Such a tool releases at the boundary itself.
 */
export function releaseTargetLockOnExit(
  lock: TargetLock,
  options: { readonly exit?: (code: number) => void; readonly releaseTimeoutMs?: number } = {},
): () => void {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const bound = options.releaseTimeoutMs ?? 5000;
  const releaseBounded = (): Promise<void> => Promise.race([lock.release(), sleep(bound)]).catch(() => undefined);
  const onSigint = (): void => void releaseBounded().then(() => exit(130));
  const onSigterm = (): void => void releaseBounded().then(() => exit(143));
  const onBeforeExit = (): void => void releaseBounded();
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  process.once("beforeExit", onBeforeExit);
  return () => {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
    process.removeListener("beforeExit", onBeforeExit);
  };
}

/**
 * Run one mutation inside the xact fence. THE safety primitive of §2, and the
 * only supported way for any tool in the caller list to write.
 *
 * "Every mutation (migration, grant reconciliation, seed, key rebind, token
 * provisioning, identity write) runs in a transaction that first takes
 * `pg_advisory_xact_lock` on the same key, on the connection performing it."
 *
 * Implementation requirements that the sentence above makes non-negotiable:
 *  1. BEGIN, then `pg_advisory_xact_lock(key)` as the FIRST statement, then the
 *     mutation. First, because any statement before it runs outside the fence.
 *  2. The fence is taken on the MUTATING connection — the handle passed to
 *     `body` — never on the coordinating lock's connection. A fence on the
 *     coordinating connection dies when that connection dies, which is the one
 *     circumstance it exists to survive.
 *  3. The blocking form, `pg_advisory_xact_lock`, not `pg_try_*`. A competitor
 *     that reached here has already won the session lock, which means the
 *     previous holder's session is gone; it must WAIT for the in-flight
 *     transaction to finish rather than conclude it is finished.
 *  4. No release. The transaction's commit or abort is the release. An explicit
 *     unlock would reopen the window at exactly the wrong moment.
 *
 * Refusal cases:
 *  - the URL names a pooler ({@link refusePoolerUrl}): a fence is transaction
 *    scoped and would survive a transaction pooler, but the same URL would not
 *    survive {@link acquireTargetLock}, and a tool whose two layers reach the
 *    database by two routes is a tool whose layers can disagree.
 *  - `body` opens its own nested transaction or commits internally: the fence's
 *    scope is this transaction, and work that escapes it is unfenced work.
 *  - the fence wait is never cancelled. Per the invariant, "a cancellation
 *    request is not evidence the mutation stopped" — cancelling here would
 *    trade a wait for exactly the overlap this module forbids.
 *
 * Serves spec §10 W1: "Kill the lock connection mid-migration, start a second
 * mutation tool: no overlap."
 */
export async function withMutationFence<T>(
  options: { readonly databaseUrl: string; readonly label: string },
  body: (tx: DbHandle) => Promise<T>,
): Promise<T> {
  refusePoolerUrl(options.databaseUrl);
  const key = TARGET_LOCK_KEY;
  const client = dedicatedClient(options.databaseUrl, `rm-tl-fence:${options.label}`.slice(0, APP_NAME_MAX));
  try {
    const result = await client.begin(async (tx) => {
      // FIRST statement in the transaction, and the blocking form: a competitor
      // waits for the in-flight mutation to end rather than concluding it ended.
      await tx`SELECT pg_advisory_xact_lock(${key.toString()}::bigint)`;
      const value = await body(tx);
      // The fence is released by commit and by nothing else, so if it is gone
      // here the body ended this transaction itself and whatever it did after
      // that ran unfenced.
      const rows = await tx<{ count: string }[]>`
        SELECT count(*)::text AS count FROM pg_locks
         WHERE locktype = 'advisory' AND granted
           AND pid = pg_backend_pid()
           AND objsubid = ${OBJSUBID_FENCE}
           AND ((classid::bigint << 32) | objid::bigint) = ${key.toString()}::bigint`;
      if (Number(rows[0]?.count ?? "0") === 0) {
        throw new Error(
          `the mutation fence for ${options.label} was lost before commit: the body committed or rolled back its own ` +
            "transaction, and work that escapes this transaction is unfenced work.",
        );
      }
      return value;
    });
    return result as T;
  } finally {
    await client.end({ timeout: 5 });
  }
}

/**
 * §2, Connection loss: "Detected at every phase boundary; the tool journals the
 * phase and exits non-zero. No phase proceeds on a lock the tool cannot prove
 * it still holds."
 *
 * Call this at every phase boundary of §1.3 — before `prepare`, before
 * `preflight`, before `replace`, before `participants`, before `readiness`.
 *
 * "PROVE" excludes a cached boolean, a local flag set at acquisition, and the
 * absence of an error event. It means a round trip that asks the server whether
 * this session still holds this key (`pg_locks` filtered to this backend's pid
 * and the key), so that a connection which died silently — a NAT timeout, a
 * failover, a pooler that recycled the backend — is discovered here rather than
 * at the next write.
 *
 * Refusal cases: the lock is not held, the connection is dead, or the question
 * cannot be answered. All three are the same refusal: the tool journals the
 * phase (`endPhase("failed", …)` in `scripts/lib/smoke-journal.ts`) and exits
 * non-zero. It must not re-acquire and continue — between the loss and the
 * re-acquisition another tool may have run, and the journal's expectations
 * (§1.3) are the mechanism for that, not this one.
 *
 * Serves spec §10 W1: "Standalone `bun run migrate` and `bun smoke` contend on
 * the target lock, including connection loss mid-phase."
 */
export async function assertStillHeld(lock: TargetLock, phase: string): Promise<void> {
  if (await lock.stillHeld()) return;
  throw new Error(
    `target lock ${lock.key} cannot be proven held, so the phase "${phase}" does not start. ` +
      `It was taken by ${describeHolderText(lock.holder)}. ` +
      "The lock is not re-acquired: another tool may have run in the gap.",
  );
}

/**
 * Read the current holder of the target lock on the database `conn` is
 * connected to, for a contention refusal.
 *
 * Output: the holder, or `null` when the lock is free or the holder published
 * no identity.
 *
 * `null` must be rendered by the caller as "held by an unidentified tool", not
 * as "free": the caller only asks this question after failing to acquire, so
 * the lock IS held, and printing "not held" there would send an operator to
 * force something.
 */
export async function describeHolder(conn: DbHandle): Promise<LockHolder | null> {
  const key = TARGET_LOCK_KEY;
  // A session lock and a fence can both be granted on one key; a contention
  // refusal is about the SESSION holder, which is the one that publishes itself.
  // The same key on a sibling database is a different lock: filter it out.
  const rows = await conn<{ application_name: string | null; backend_start: Date | null }[]>`
    SELECT a.application_name, a.backend_start
      FROM pg_locks l
      JOIN pg_stat_activity a ON a.pid = l.pid
     WHERE l.locktype = 'advisory' AND l.granted
       AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
       AND l.objsubid = ${OBJSUBID_SESSION}
       AND ((l.classid::bigint << 32) | l.objid::bigint) = ${key.toString()}::bigint
     LIMIT 1`;
  const row = rows[0];
  if (row === undefined) return null;
  return decodeHolder(row.application_name, row.backend_start);
}
