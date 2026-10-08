// `bun run migrate` — the operator's migrate run (smoke-production-spec.md §8.5).
//
// "In production an upgrade is an operator intervention: `bun run migrate`,
// planned per release, receipted. It is never part of the boot." This file is
// that command's argv, `~/.env` and exit handling. The sequence itself — plan,
// target lock, gates, owner login, `--confirm-target`, run, receipt — is
// `migrateCommand` in ./migrate-run.ts, the same function `bun smoke
// --migrate` runs (backend/scripts/smoke-prepare.ts).
//
// THE TARGET LOCK (§2, D52). This command takes the ONE session lock every tool
// takes — TARGET_LOCK_KEY, over a direct connection (a transaction-mode pooler
// is refused before anything connects), from acquisition to exit — so it
// contends with a running `bun smoke` whatever hostname either of them used:
// Postgres scopes an advisory lock to the database, not to the address. While
// another tool holds it this command waits `--lock-timeout` seconds, then exits
// non-zero naming the holder (its tool, plan id, instance, host and pid). Having
// acquired it, it re-reads `deployment_identity`, the ledger and the manifest
// and refuses if any moved while it waited. The lock is released explicitly on
// exit, on SIGINT and on SIGTERM.
//
// `~/.env` holds the connection values, the three runtime role passwords and,
// since D61, the `rm_owner` password. This command reads the target and
// connects as `rm_readonly` for the lock, the plan and the gates, then logs in
// as `rm_owner` with the `rm_owner = …` line of the same file. It never
// prompts and needs no terminal (D61 rule 1). A file with no `rm_owner` line
// refuses, naming the key and the file. It never reads `doadmin`.
//
// THE CONFIRMATION (D61). The interactive `y` is `--confirm-target
// <host:port/database>`: the run refuses unless the flag equals exactly the
// target `~/.env` names (`host`, `port` or 5432, `database` or `dbname`, as
// spelled there). A mismatch prints both. Nothing is normalized.
//
// usage: bun run migrate --confirm-target <host:port/database> [--instance <name>] [--receipt <path>] [--lock-timeout <seconds>]
//
// `--instance` defaults to the production instance under RM_ENV=prod. Any other
// policy must name where the receipt goes, because a receipt written to a
// guessed instance is a record in the wrong place.
//
// THE JOURNAL (§2: a losing tool "journals the phase and exits non-zero").
// Beside the receipt, this command keeps a `migrate-journal-<start>.json` for
// every run (./migrate-journal.ts), opened as soon as the receipt's directory
// is known and closed on every exit with the phase it stopped in: `config`,
// `plan`, `lock`, `gates`, `owner`, `confirm`, each `migrate: …` boundary of
// the run, `receipt`. A run that lost its lock connection mid-run says which
// phase could not start; a run killed by a signal says it was interrupted.
//
// THE FIRST PRODUCTION MIGRATE (§9.1, D55 (5), (9)) is this command, unchanged:
// under RM_ENV=prod, against a database with no identity row whose ledger
// equals a supported release's, the gates let it through, the confirmation
// names that state, the run applies 0081 first with `production` in its
// transaction (migrate-run.ts applyIdentityFirst), and the receipt records the
// pre-identity state and the row. A run killed after that transaction reruns
// as an ordinary `bun run migrate`. Under RM_ENV=stage the same state takes
// the remote rehearsal pass (D61 rule 2): the same steps, writing `rehearsal`.
import { hostname } from "node:os";
import { dirname, resolve } from "node:path";
import { homeEnvFilePath, loadEnvFile, urlForRole } from "../../scripts/lib/env-role.ts";
import { confirmTargetFlag, homeEnvTarget } from "../../scripts/lib/privileged-env.ts";
import { resolveRmEnv } from "../src/deploy-policy.ts";
import { PRODUCTION_INSTANCE, instancePaths, stateRoot } from "../../scripts/lib/smoke-state.ts";
import { MigrateJournal, migrateJournalPath } from "./migrate-journal.ts";

const NAME = "migrate";
const err = (m: string) => console.error(`[${NAME}] ${m}`);
const log = (m: string) => console.log(`[${NAME}] ${m}`);

/** How long the command waits behind another holder of the target lock by default. */
const DEFAULT_LOCK_TIMEOUT_SECONDS = 60;

/** Open once the receipt's directory is known; every refusal after that is journaled. */
let journal: MigrateJournal | undefined;

function refuse(message: string): never {
  journal?.close("refused", message);
  err(message);
  process.exit(1);
}

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  if (at < 0) return undefined;
  const value = process.argv[at + 1];
  if (!value || value.startsWith("--")) refuse(`${name} needs a value`);
  return value;
}

const receiptFlag = flag("--receipt");
const confirmTarget = confirmTargetFlag(process.argv.slice(2));
const instanceFlag = flag("--instance");
const lockTimeoutSeconds = Number(flag("--lock-timeout") ?? DEFAULT_LOCK_TIMEOUT_SECONDS);
if (!Number.isFinite(lockTimeoutSeconds) || lockTimeoutSeconds < 0) refuse("--lock-timeout needs a number of seconds");

const envPath = homeEnvFilePath();
const env = loadEnvFile(envPath);

// Args override env (§3), so the process's RM_ENV wins over the file's. The
// value is judged by the §4.3 matrix itself (the gates, below); here it is only
// parsed, so a typo refuses before anything connects.
const policy = resolveRmEnv({ RM_ENV: process.env.RM_ENV ?? env?.RM_ENV });
if (!policy.ok) refuse(policy.reason);
const rmEnv = policy.source === "unset" ? null : policy.env;

// The receipt's home is decided BEFORE anything connects: finding out after a
// production migration that there is nowhere to record it is the wrong order.
const startedAt = new Date();
let receiptDir: string;
if (receiptFlag === undefined) {
  const instance = instanceFlag ?? (rmEnv === "prod" ? PRODUCTION_INSTANCE : undefined);
  if (instance === undefined) {
    refuse("name the instance whose state directory receives the receipt (--instance <name>), or pass --receipt <path>.");
  }
  receiptDir = instancePaths(stateRoot(process.env), instance).dir;
} else {
  receiptDir = dirname(resolve(receiptFlag));
}

// THE JOURNAL (§2), beside the receipt, from here to exit. Every exit below —
// a refusal, a lost lock, a crash, SIGINT/SIGTERM through the lock's release
// handler — closes it naming the phase it
// stopped in; the `exit` handler catches the ones that leave without closing.
// Nothing before this point connected to anything or had a place to journal.
journal = MigrateJournal.open(migrateJournalPath(receiptDir, startedAt), { caller: "operator", env: rmEnv, startedAt });
process.on("exit", (code) => journal?.closeOnExit(code));
journal.begin("config");

if (!env) refuse(`no readable $HOME/.env (${envPath}).`);


// The lock, the plan and the gates go through the least-privileged role that
// can read `deployment_identity`: §3 puts `rm_readonly` in `~/.env` and 0081
// grants it SELECT there. It can take a session advisory lock; it can do no DDL.
const readonlyUrl = urlForRole(env, "rm_readonly");
if (!readonlyUrl) {
  refuse(`$HOME/.env cannot assemble an rm_readonly connection (host, port, database, sslmode and an rm_readonly line).`);
}
// The target the flag must name, exactly as the file spells it (D61).
const resolvedTarget = homeEnvTarget(env)!;

// backend/src/config.ts validates at IMPORT, and the run's modules import it
// (append-only-guard.ts → db/client.ts). It requires DATABASE_URL: this
// process's is the rm_readonly target above, a runtime credential that can do
// no DDL. It accepts RM_ENV=stage (#1026) as the policy this command runs
// under, so nothing is re-presented to it under another name.
process.env.DATABASE_URL = readonlyUrl;

// The run's modules are imported only now: nothing above may depend on them,
// and a refusal above must not have paid for loading them.
const { MigrateRefused, migrateCommand, migrateReceiptPath } = await import("./migrate-run.ts");
const receiptPath = receiptFlag === undefined ? migrateReceiptPath(receiptDir, startedAt) : resolve(receiptFlag);

try {
  const { result, receipt } = await migrateCommand({
    caller: "operator",
    env: rmEnv,
    // `bun run migrate` never targets a Postgres smoke owns: that is
    // `bun smoke --migrate`, which uses smoke's generated password (§8.5).
    connection: "remote",
    readerUrl: readonlyUrl,
    // D61: rm_owner from ~/.env, held to --confirm-target. Never a prompt.
    remote: { ownerPassword: env.rm_owner, envFile: envPath, confirmTarget, resolvedTarget },
    lock: {
      acquire: {
        holder: { tool: NAME, planId: null, instance: instanceFlag ?? null, host: hostname(), pid: process.pid },
        timeoutMs: lockTimeoutSeconds * 1000,
      },
    },
    receiptPath,
    journal,
    log,
  });
  log(`applied ${result.applied.length} migration(s)${result.applied.length ? `: ${result.applied.join(", ")}` : ""}`);
  if (result.resumedAndVerified.length > 0) {
    log(`resumed and verified ${result.resumedAndVerified.length} committed migration(s)`);
  }
  log(`grants repaired on ${result.grantsRepaired.length} relation(s)`);
  if (result.baselined) log("first manifest: the live schema matched the snapshot (spec §9.1 step 2)");
  if (result.preIdentity && result.identityWritten) {
    const pass = result.identityWritten.kind === "production" ? "first production migrate" : "remote rehearsal pass";
    log(
      `${pass} from ${result.preIdentity.release}: ${result.applied[0]} and deployment_identity = ` +
        `${result.identityWritten.kind} committed first, in one transaction (spec §9.1 step 4, D55 (9), D61)`,
    );
  }
  if (result.resumedAfterIdentityPass) {
    log(`resumed after the identity-first pass: the rows before 0081 equal ${result.resumedAfterIdentityPass} (spec §9.1)`);
  }
  log(`manifest ${result.manifest.contentHash} published`);
  log(`receipt ${receipt}`);
  process.exit(0);
} catch (e) {
  // migrateCommand has already journaled the phase it stopped in.
  err(e instanceof MigrateRefused ? e.message : `failed: ${e instanceof Error ? e.message : String(e)}`);
  log(`journal ${journal.path}`);
  process.exit(1);
}
