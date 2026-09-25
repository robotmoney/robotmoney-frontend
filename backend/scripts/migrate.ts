// `bun run migrate` — the operator's migrate run (smoke-production-spec.md §8.5).
//
// "In production an upgrade is an operator intervention: `bun run migrate`,
// prompting for `rm_owner`, planned per release, receipted. It is never part of
// the boot." This file is that command's argv, `~/.env` and exit handling. The
// sequence itself — plan, target lock, gates, owner prompt, `y`, run, receipt —
// is `migrateCommand` in ./migrate-run.ts, the same function `bun smoke
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
// `~/.env` holds the connection values and the three runtime role passwords
// (§3). This command reads the target and connects as `rm_readonly` for the
// lock, the plan and the gates; it refuses a file that holds `rm_owner` or
// `doadmin` — a host that stores an owner password has no reason left to type
// one — and then logs in as `rm_owner` with the password typed at the terminal.
//
// usage: bun run migrate [--instance <name>] [--receipt <path>] [--lock-timeout <seconds>]
//
// `--instance` defaults to the production instance under RM_ENV=prod. Any other
// policy must name where the receipt goes, because a receipt written to a
// guessed instance is a record in the wrong place.
import { hostname } from "node:os";
import { homeEnvFilePath, loadEnvFile, urlForRole } from "../../scripts/lib/env-role.ts";
import { resolveRmEnv } from "../src/deploy-policy.ts";
import { PRODUCTION_INSTANCE, instancePaths, stateRoot } from "../../scripts/lib/smoke-state.ts";

const NAME = "migrate";
const err = (m: string) => console.error(`[${NAME}] ${m}`);
const log = (m: string) => console.log(`[${NAME}] ${m}`);

/** How long the command waits behind another holder of the target lock by default. */
const DEFAULT_LOCK_TIMEOUT_SECONDS = 60;

function refuse(message: string): never {
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
const instanceFlag = flag("--instance");
const lockTimeoutSeconds = Number(flag("--lock-timeout") ?? DEFAULT_LOCK_TIMEOUT_SECONDS);
if (!Number.isFinite(lockTimeoutSeconds) || lockTimeoutSeconds < 0) refuse("--lock-timeout needs a number of seconds");

const envPath = homeEnvFilePath();
const env = loadEnvFile(envPath);
if (!env) refuse(`no readable $HOME/.env (${envPath}).`);

// §3: "It must not contain `rm_owner`, `doadmin`, a superuser token ...".
const forbidden = ["rm_owner", "doadmin"].filter((key) => env[key] !== undefined);
if (forbidden.length > 0) {
  refuse(
    `$HOME/.env holds a ${forbidden.join(" and a ")} line. Spec §3 keeps both out of it: the rm_owner password is ` +
      "typed at the terminal for the one run that needs it and never stored. Remove the line and rerun.",
  );
}

// Args override env (§3), so the process's RM_ENV wins over the file's. The
// value is judged by the §4.3 matrix itself (the gates, below); here it is only
// parsed, so a typo refuses before anything connects.
const policy = resolveRmEnv({ RM_ENV: process.env.RM_ENV ?? env.RM_ENV });
if (!policy.ok) refuse(policy.reason);
const rmEnv = policy.source === "unset" ? null : policy.env;

// The receipt's home is decided BEFORE anything connects: finding out after a
// production migration that there is nowhere to record it is the wrong order.
const startedAt = new Date();
let receiptDir: string | null = null;
if (receiptFlag === undefined) {
  const instance = instanceFlag ?? (rmEnv === "prod" ? PRODUCTION_INSTANCE : undefined);
  if (instance === undefined) {
    refuse("name the instance whose state directory receives the receipt (--instance <name>), or pass --receipt <path>.");
  }
  receiptDir = instancePaths(stateRoot(process.env), instance).dir;
}

// The lock, the plan and the gates go through the least-privileged role that
// can read `deployment_identity`: §3 puts `rm_readonly` in `~/.env` and 0063
// grants it SELECT there. It can take a session advisory lock; it can do no DDL.
const readonlyUrl = urlForRole(env, "rm_readonly");
if (!readonlyUrl) {
  refuse(`$HOME/.env cannot assemble an rm_readonly connection (host, port, database, sslmode and an rm_readonly line).`);
}

// backend/src/config.ts validates at IMPORT, and the run's modules import it
// (append-only-guard.ts → db/client.ts). It requires DATABASE_URL: this
// process's is the rm_readonly target above, a runtime credential that can do
// no DDL. It accepts RM_ENV=stage (#1026) as the policy this command runs
// under, so nothing is re-presented to it under another name.
process.env.DATABASE_URL = readonlyUrl;

// The run's modules are imported only now: nothing above may depend on them,
// and a refusal above must not have paid for loading them.
const { MigrateRefused, migrateCommand, migrateReceiptPath } = await import("./migrate-run.ts");
const receiptPath = receiptFlag ?? migrateReceiptPath(receiptDir ?? "", startedAt);

try {
  const { result, receipt } = await migrateCommand({
    caller: "operator",
    env: rmEnv,
    // `bun run migrate` never targets a Postgres smoke owns: that is
    // `bun smoke --migrate`, which uses smoke's generated password (§8.5).
    connection: "remote",
    readerUrl: readonlyUrl,
    nonInteractive: !process.stdin.isTTY,
    lock: {
      acquire: {
        holder: { tool: NAME, planId: null, instance: instanceFlag ?? null, host: hostname(), pid: process.pid },
        timeoutMs: lockTimeoutSeconds * 1000,
      },
    },
    receiptPath,
    log,
  });
  log(`applied ${result.applied.length} migration(s)${result.applied.length ? `: ${result.applied.join(", ")}` : ""}`);
  if (result.resumedAndVerified.length > 0) {
    log(`resumed and verified ${result.resumedAndVerified.length} committed migration(s)`);
  }
  log(`grants repaired on ${result.grantsRepaired.length} relation(s)`);
  if (result.baselined) log("first manifest: the live schema matched the snapshot (spec §9.1 step 2)");
  log(`manifest ${result.manifest.contentHash} published`);
  log(`receipt ${receipt}`);
  process.exit(0);
} catch (e) {
  err(e instanceof MigrateRefused ? e.message : `failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
