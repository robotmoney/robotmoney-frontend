// Shared mechanics for post-cutover verification (docs/runbooks/*.md §8),
// run AFTER a boot has already migrated and deployed. Unlike preflight, this
// intentionally connects as the application's own role via DATABASE_URL —
// §8's checks are read-only SELECTs plus a couple of HTTP GETs, but they need
// to see the just-migrated schema, which a role scoped to the OLD pre-upgrade
// permission set (or a read replica lagging the primary) might not yet.
//
// Standalone for the same reason as preflight-utils.ts: no import from src/,
// so this never opens the application's shared pool or requires config.ts's
// module-load `required(...)` calls to succeed.

import postgres from "postgres";
import type postgresTypes from "postgres";
import { createChecker, printVerdict } from "./checks.ts";
import type { Checker, CheckResult } from "./checks.ts";
import { collectDbIdentity, emitReceipt, gitFacts, summarise } from "./rollout-receipt.ts";
import type { DbIdentity } from "./rollout-receipt.ts";
import type { PreflightReceiptSpec } from "./preflight-utils.ts";

export type Db = postgresTypes.Sql<{}>;

/** Opens a single connection on DATABASE_URL. No read-only gating — postflight
 *  runs as whatever role the operator's shell already has (§2.0/§8: export
 *  DATABASE_URL, assert identity, then run this). */
export function connect(url: string, applicationName: string): Db {
  return postgres(url, {
    max: 1,
    idle_timeout: 20,
    connect_timeout: 15,
    prepare: false,
    onnotice: () => {},
    connection: { application_name: applicationName },
  });
}

export interface HttpCheckResult {
  ok: boolean;
  status?: number;
  body?: string;
  error?: string;
}

/** Fetch with a hard timeout — a hung request must not hang the whole
 *  postflight run. Never throws; failures come back as {ok: false, error}. */
export async function fetchCheck(url: string, opts: { timeoutMs?: number } = {}): Promise<HttpCheckResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10_000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const body = await res.text();
    return { ok: res.ok, status: res.status, body };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timeout);
  }
}

export interface RunPostflightOpts {
  /** e.g. "rm-postflight-0.2.2" — used as both the Postgres application_name
   *  and the console.error prefix. */
  name: string;
  runChecks(db: Db, checker: Checker): Promise<void>;
  /** Set when `--emit-receipt` is passed — see RunPreflightOpts.receipt. The
   *  same spec shape, because a postflight receipt and a preflight receipt are
   *  read by the same probe and must not diverge. */
  receipt?: PreflightReceiptSpec;
}

interface PostflightRunCtx {
  startedAt: string;
  identity?: DbIdentity;
  results: CheckResult[];
}

/**
 * The boilerplate every numbered postflight script needs: require
 * DATABASE_URL (already loaded per §2.0/§8 — this script does not load it
 * itself, unlike preflight's .env.readonly), connect, run the caller's
 * checks, print the verdict, close the connection.
 */
export async function runPostflightMain(opts: RunPostflightOpts): Promise<number> {
  const ctx: PostflightRunCtx = { startedAt: new Date().toISOString(), results: [] };
  const git = opts.receipt ? gitFacts(opts.receipt.repoRoot, opts.receipt.tagGlob) : undefined;
  const code = await runPostflightCore(opts, ctx);
  if (opts.receipt) {
    const { path } = emitReceipt({
      ...opts.receipt,
      git,
      exit: code,
      verdict: code === 0 ? "POSTFLIGHT CLEAN" : code === 1 ? "POSTFLIGHT FAILED" : "COULD NOT RUN",
      startedAt: ctx.startedAt,
      db: ctx.identity,
      checks: ctx.results.length ? summarise(ctx.results) : undefined,
    });
    console.log(`[${opts.name}] receipt \u2192 ${path}`);
  }
  return code;
}

async function runPostflightCore(opts: RunPostflightOpts, ctx: PostflightRunCtx): Promise<number> {
  const { name, runChecks } = opts;
  const log = (msg: string) => console.log(`[${name}] ${msg}`);
  const err = (msg: string) => console.error(`[${name}] ${msg}`);

  const url = process.env.DATABASE_URL;
  if (!url) {
    err("DATABASE_URL is not set. Postflight runs against the just-deployed database as the");
    err("application's own role — load and assert it first (see the runbook's §2.0/§8).");
    return 2;
  }

  let db: Db;
  try {
    db = connect(url, name);
    await db`SELECT 1`;
  } catch (e) {
    err(`cannot connect: ${e instanceof Error ? e.message : e}`);
    return 2;
  }
  log(`connected as the application's own role (DATABASE_URL)`);
  // Which database did this actually grade? §2.0's failure mode is a psql that
  // connects successfully to the WRONG server; recording identity makes that
  // detectable after the fact instead of never.
  ctx.identity = await collectDbIdentity(db);
  console.log("");

  const checker = createChecker("");
  ctx.results = checker.results;
  try {
    await runChecks(db, checker);
  } catch (e) {
    err(`check failed: ${e instanceof Error ? e.message : e}`);
    return 2;
  } finally {
    await db.end({ timeout: 5 });
  }

  return printVerdict(checker.results, {
    logPrefix: "",
    okAll: "VERDICT: POSTFLIGHT CLEAN",
    okWithWarnings: "VERDICT: POSTFLIGHT CLEAN",
    blocked: "VERDICT: POSTFLIGHT FAILED",
  });
}
