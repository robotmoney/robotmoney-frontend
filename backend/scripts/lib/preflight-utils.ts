// Shared mechanics for pre-upgrade dry runs against a LIVE production
// Postgres, executed by a dedicated read-only role, before the operator
// pulls a new tag. Extracted from the original single-file
// backend/scripts/preflight-upgrade.ts so that each numbered upgrade
// (backend/scripts/upgrades/<from>-to-<to>/preflight.ts) only has to define
// its own release-specific checks, not re-solve connection/gating/env-file
// plumbing every time.
//
// WHY THIS FILE (AND ITS CALLERS) STAY STANDALONE.
// backend/scripts/db-preflight.ts is read-only too, but it imports
// src/db/client.ts, which imports src/config.ts, which does
// `required("DATABASE_URL")` at module load — so merely importing it opens a
// pool on the APPLICATION role and refuses to start without the
// application's own URL. Neither this file nor anything that imports it may
// import from src/ for that reason: it must be possible to run a check
// against production with zero write risk, before any deploy, without
// booting anything application-shaped.
//
// So: this file and every upgrade-specific preflight import `postgres`
// (backend/package.json dependency) and node builtins, and NOTHING from
// src/. Connection comes from a discrete-keys .env.readonly file — a
// separate file from the application's own .env, holding a dedicated
// read-only role's credentials — never DATABASE_URL, and it refuses to run
// if the URL it assembles is identical to the application's DATABASE_URL.
// The session is pinned read-only at the server and PROVEN before a single
// check query runs (gateReadOnly, below).

import { readFileSync } from "node:fs";
import postgres from "postgres";
import type postgresTypes from "postgres";
import { createChecker, printVerdict } from "./checks.ts";
import type { Checker, CheckResult, Status } from "./checks.ts";
import { collectDbIdentity, emitReceipt, gitFacts, summarise } from "./rollout-receipt.ts";
import type { DbIdentity } from "./rollout-receipt.ts";

export type Db = postgresTypes.Sql<{}>;

export const READONLY_ENV_REQUIRED_KEYS = ["host", "port", "username", "password", "database"] as const;

/** Minimal KEY=VALUE parser — same shape as scripts/lib/smoke-external-pg.ts's,
 *  duplicated rather than imported to keep the standalone story intact. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).replace(/^export\s+/, "").trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

export function loadEnvFile(path: string): Record<string, string> | undefined {
  try {
    return parseEnvFile(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

export type DiscreteUrlResolution = { url: string } | { missing: (typeof READONLY_ENV_REQUIRED_KEYS)[number][] };

/** Assembles postgres://... from discrete keys and URI-escapes each field
 *  itself, so the reserved-character password restriction that applies to a
 *  hand-built URI does not apply to a discrete-keys env file. */
export function urlFromDiscreteEnv(env: Record<string, string>): DiscreteUrlResolution {
  const missing = READONLY_ENV_REQUIRED_KEYS.filter((k) => !env[k]);
  if (missing.length > 0) return { missing };
  const u = new URL(`postgres://${env.host}`);
  u.port = env.port;
  u.username = encodeURIComponent(env.username);
  u.password = encodeURIComponent(env.password);
  u.pathname = `/${env.database}`;
  u.searchParams.set("sslmode", env.sslmode ?? "require");
  return { url: u.toString() };
}

/** Password-redacted target, the only form safe to print. */
export function redactedTarget(raw: string | undefined, unsetMessage: string): string {
  if (!raw) return unsetMessage;
  try {
    const u = new URL(raw);
    if (u.password) u.password = "***";
    return `${u.username}@${u.hostname}:${u.port || "5432"}${u.pathname}`;
  } catch {
    return "(unparseable database URL)";
  }
}

/**
 * Open a single, server-side read-only connection.
 *
 * `default_transaction_read_only=on` as a STARTUP parameter is the belt: every
 * transaction on the connection begins read-only, so even a role that still
 * holds write grants cannot write through this pool (writes raise 25006).
 * DO Managed's PgBouncer port (25061) rejects startup parameters it is not
 * configured to ignore, so a failure to connect WITH the parameter falls back
 * to a plain connection plus an explicit SET — and either way the session is
 * verified with `SHOW transaction_read_only` before any check runs.
 *
 * max: 1 so the session-level SET (fallback path) governs every query.
 */
export async function connectReadOnly(
  url: string,
  applicationName: string,
): Promise<{ db: Db; usedStartupParam: boolean }> {
  const base = {
    max: 1,
    idle_timeout: 20,
    connect_timeout: 15,
    // DO Managed's pooled port speaks transaction pooling; unnamed prepared
    // statements keep this script compatible with both ports.
    prepare: false,
    onnotice: () => {},
  } as const;
  try {
    const db = postgres(url, {
      ...base,
      connection: {
        application_name: applicationName,
        default_transaction_read_only: true,
        statement_timeout: 30000,
      },
    });
    await db`SELECT 1`;
    return { db, usedStartupParam: true };
  } catch {
    const db = postgres(url, { ...base, connection: { application_name: applicationName } });
    await db`SELECT 1`;
    await db.unsafe("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY");
    await db.unsafe("SET statement_timeout = 30000");
    return { db, usedStartupParam: false };
  }
}

/**
 * Runs BEFORE every other check and aborts the whole script on failure. Three
 * independent questions, because any one of them alone is escapable:
 *   1. Is the SESSION read-only right now? (proves the belt engaged)
 *   2. Is the ROLE non-privileged? (superuser ignores grants entirely)
 *   3. Does the role hold write grants or own any public table? (an owner can
 *      re-grant itself anything, so ownership is write capability)
 * `allowPrivilegedEnvVar` (e.g. "PREFLIGHT_ALLOW_PRIVILEGED") downgrades 2+3
 * to WARN, for the operator who knowingly runs this as doadmin before the
 * read-only role exists. Do not make that the normal path.
 */
export async function gateReadOnly(db: Db, checker: Checker, allowPrivilegedEnvVar: string): Promise<boolean> {
  const allowPrivileged = process.env[allowPrivilegedEnvVar] === "1";
  const gateStatus: Status = allowPrivileged ? "WARN" : "FAIL";
  const { record } = checker;

  const [session] = (await db`
    SELECT current_user::text            AS role,
           current_database()::text      AS db,
           current_setting('transaction_read_only') AS read_only
  `) as unknown as { role: string; db: string; read_only: string }[];

  if (session.read_only !== "on") {
    record(
      "session-read-only",
      "FAIL",
      `transaction_read_only = '${session.read_only}' — the session is WRITEABLE, refusing to continue`,
      "Connect to the direct (non-pooled) port, or grant the role only SELECT; this script will not query a writeable session.",
    );
    return false;
  }
  record("session-read-only", "PASS", `role=${session.role} db=${session.db} transaction_read_only=on`);

  const [attrs] = (await db`
    SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication
    FROM pg_roles WHERE rolname = current_user
  `) as unknown as {
    rolsuper: boolean;
    rolbypassrls: boolean;
    rolcreaterole: boolean;
    rolcreatedb: boolean;
    rolreplication: boolean;
  }[];
  const flags = Object.entries(attrs ?? {})
    .filter(([, v]) => v === true)
    .map(([k]) => k);
  if (flags.length > 0) {
    record(
      "role-privileges",
      gateStatus,
      `${session.role} carries ${flags.join(", ")} — this is not a read-only role`,
      "Run as the dedicated read-only role (see the provisioning SQL in the runbook), not doadmin.",
    );
    if (!allowPrivileged) return false;
  } else {
    record("role-privileges", "PASS", `${session.role} has no SUPERUSER/BYPASSRLS/CREATEROLE/CREATEDB/REPLICATION`);
  }

  const writable = (await db`
    SELECT c.relname::text AS relname,
           pg_get_userbyid(c.relowner)::text AS owner,
           has_table_privilege(current_user, c.oid, 'INSERT')   AS ins,
           has_table_privilege(current_user, c.oid, 'UPDATE')   AS upd,
           has_table_privilege(current_user, c.oid, 'DELETE')   AS del,
           has_table_privilege(current_user, c.oid, 'TRUNCATE') AS trunc
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
      AND (has_table_privilege(current_user, c.oid, 'INSERT')
        OR has_table_privilege(current_user, c.oid, 'UPDATE')
        OR has_table_privilege(current_user, c.oid, 'DELETE')
        OR has_table_privilege(current_user, c.oid, 'TRUNCATE')
        OR pg_get_userbyid(c.relowner) = current_user)
    ORDER BY 1
  `) as unknown as { relname: string; owner: string; ins: boolean; upd: boolean; del: boolean; trunc: boolean }[];

  if (writable.length > 0) {
    const sample = writable.slice(0, 5).map((w) => {
      const p = [w.ins && "INSERT", w.upd && "UPDATE", w.del && "DELETE", w.trunc && "TRUNCATE"]
        .filter(Boolean)
        .join(",");
      return `  ${w.relname}${p ? ` (${p})` : ""}${w.owner === session.role ? " [OWNED by this role]" : ""}`;
    });
    record(
      "role-write-grants",
      gateStatus,
      [
        `${session.role} can write ${writable.length} public table(s) — a dump/preflight role must not:`,
        ...sample,
        ...(writable.length > 5 ? [`  …and ${writable.length - 5} more`] : []),
      ],
      "REVOKE the write grants, or provision the dedicated read-only role and re-run with its URL.",
    );
    if (!allowPrivileged) return false;
  } else {
    record("role-write-grants", "PASS", "no INSERT/UPDATE/DELETE/TRUNCATE and no table ownership in public");
  }
  return true;
}

export interface RunPreflightOpts {
  /** Path to the discrete-keys env file. Caller resolves this relative to
   *  its OWN location (see backend/scripts/upgrades/<version>/preflight.ts). */
  envPath: string;
  /** e.g. "rm-preflight-0.2.2" — used as both the Postgres application_name
   *  and the console.error prefix. */
  name: string;
  /** e.g. "PREFLIGHT_ALLOW_PRIVILEGED" */
  allowPrivilegedEnvVar: string;
  runChecks(db: Db, checker: Checker): Promise<void>;
  /**
   * Set by the caller when `--emit-receipt` is passed: write a rollout receipt
   * for this run (backend/scripts/lib/rollout-receipt.ts). The receipt is what
   * lets where.ts answer "is this gate still valid?" in a later session, so it
   * is written on EVERY exit path — a failed preflight is evidence too.
   */
  receipt?: PreflightReceiptSpec;
}

export interface PreflightReceiptSpec {
  /** Step id from the release's steps.ts manifest, e.g. "P4.preflight-live". */
  step: string;
  repoRoot: string;
  tagGlob: string;
  hostRole: string;
  backupDir?: string;
}

/** Mutable per-run sink: the wrapper needs the connection identity and the
 *  check results, both of which only exist inside the core's control flow. */
interface PreflightRunCtx {
  startedAt: string;
  identity?: DbIdentity;
  results: CheckResult[];
}

/**
 * The full boilerplate every numbered preflight script needs: load the env
 * file, assemble + guard the URL, connect read-only, gate, run the caller's
 * checks, print the verdict, close the connection. Returns the process exit
 * code (0 = safe, 1 = blocked, 2 = could not run).
 */
export async function runPreflightMain(opts: RunPreflightOpts): Promise<number> {
  const ctx: PreflightRunCtx = { startedAt: new Date().toISOString(), results: [] };
  // Captured BEFORE the run, not at emit time: if a commit lands while a long
  // step is in flight, the receipt must describe the tree the step actually ran
  // against.
  const git = opts.receipt ? gitFacts(opts.receipt.repoRoot, opts.receipt.tagGlob) : undefined;
  const code = await runPreflightCore(opts, ctx);
  if (opts.receipt) {
    const { path } = emitReceipt({
      ...opts.receipt,
      git,
      exit: code,
      // Deliberately the same three words printVerdict prints, so grepping the
      // log and reading the receipt cannot tell different stories.
      verdict: code === 0 ? "SAFE TO UPGRADE" : code === 1 ? "BLOCKED" : "COULD NOT RUN",
      startedAt: ctx.startedAt,
      db: ctx.identity,
      checks: ctx.results.length ? summarise(ctx.results) : undefined,
    });
    console.log(`[${opts.name}] receipt \u2192 ${path}`);
  }
  return code;
}

async function runPreflightCore(opts: RunPreflightOpts, ctx: PreflightRunCtx): Promise<number> {
  const { envPath, name, allowPrivilegedEnvVar, runChecks } = opts;
  const log = (msg: string) => console.log(`[${name}] ${msg}`);
  const err = (msg: string) => console.error(`[${name}] ${msg}`);

  const env = loadEnvFile(envPath);
  if (!env) {
    err(`cannot read ${envPath}`);
    err("This script deliberately does NOT read DATABASE_URL or an ambient env var:");
    err("it must run as a dedicated read-only role, configured explicitly in that");
    err("file, never as the application's writer. See .env.readonly.example.");
    return 2;
  }
  const resolved = urlFromDiscreteEnv(env);
  if ("missing" in resolved) {
    err(`${envPath} is missing: ${resolved.missing.join(", ")}`);
    err(`Required keys: ${READONLY_ENV_REQUIRED_KEYS.join(", ")} (sslmode optional, defaults to require).`);
    return 2;
  }
  const url = resolved.url;
  if (process.env.DATABASE_URL && process.env.DATABASE_URL === url) {
    err(`${envPath} resolves to the same URL as DATABASE_URL — refusing.`);
    err("Point it at the dedicated read-only role instead.");
    return 2;
  }

  const target = redactedTarget(url, `(no read-only database URL — see ${envPath})`);
  log(`target: ${target}`);

  let db: Db;
  let usedStartupParam: boolean;
  try {
    ({ db, usedStartupParam } = await connectReadOnly(url, name));
  } catch (e) {
    err(`cannot connect to ${target}: ${e instanceof Error ? e.message : e}`);
    return 2;
  }
  if (!usedStartupParam) {
    log("note: server rejected the read-only startup parameter (pooled port?);");
    log("      fell back to SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY.");
  }
  // §2.0's identity assertion, captured rather than merely printed: a receipt
  // that records in_recovery=false was not pointed at the replica, and
  // where.ts can say so long after this terminal is gone.
  ctx.identity = await collectDbIdentity(db);
  console.log("");

  const checker = createChecker("");
  ctx.results = checker.results;

  try {
    if (!(await gateReadOnly(db, checker, allowPrivilegedEnvVar))) {
      console.log("");
      console.log(`[${name}] VERDICT: BLOCKED — the connection is not provably read-only.`);
      console.log(`[${name}] Nothing was queried beyond the role audit. Set ${allowPrivilegedEnvVar}=1`);
      console.log(`[${name}] to downgrade the role checks to warnings if you accept the risk.`);
      return 1;
    }
    await runChecks(db, checker);
  } catch (e) {
    err(`check failed: ${e instanceof Error ? e.message : e}`);
    return 2;
  } finally {
    await db.end({ timeout: 5 });
  }

  return printVerdict(checker.results, {
    logPrefix: "",
    okAll: "VERDICT: SAFE TO UPGRADE",
    okWithWarnings: "VERDICT: SAFE TO UPGRADE",
    blocked: "VERDICT: BLOCKED",
  });
}
