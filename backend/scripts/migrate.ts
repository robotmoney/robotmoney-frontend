// `bun run migrate` — the operator's migrate run (smoke-production-spec.md §8.5).
//
// "In production an upgrade is an operator intervention: `bun run migrate`,
// prompting for `rm_owner`, planned per release, receipted. It is never part of
// the boot." This file is that command's argv, `~/.env` and terminal handling.
// The run itself, its gates and its receipt live in ./migrate-run.ts.
//
// THE SEQUENCE, in this order and no other:
//   1. Read the target from `$HOME/.env` (host, port, database, sslmode) and
//      the policy from RM_ENV. Refuse a `~/.env` that holds `rm_owner` or
//      `doadmin`: §3 keeps both out of that file, and a host that stores an
//      owner password has no reason left to type one.
//   2. `checkMigrateGates`, read through `rm_readonly` — BEFORE the owner
//      password is requested, so a refused run never has a password typed
//      into it.
//   3. `promptOwnerPassword`: masked, verified by a real login, never written
//      anywhere and never placed in the environment (§3).
//   4. Connect AS `rm_owner`. Never `doadmin`: §3 makes `doadmin` cluster
//      provisioning only, and the migration login is `rm_owner` (D47).
//   5. `confirmRemoteTarget`: warn, then an explicit `y`.
//   6. `runMigrate`: fence, apply, reconcile, publish (§8.3).
//   7. `writeMigrateReceipt`: into the instance's state directory, or the
//      path `--receipt` names.
//
// usage: bun run migrate [--instance <name>] [--receipt <path>]
//
// `--instance` defaults to the production instance under RM_ENV=prod. Any other
// policy must name where the receipt goes, because a receipt written to a
// guessed instance is a record in the wrong place.
import { homeEnvFilePath, loadEnvFile, urlForRole } from "../../scripts/lib/env-role.ts";
import { resolveRmEnv } from "../../scripts/lib/smoke-env-policy.ts";
import { PRODUCTION_INSTANCE, instancePaths, stateRoot } from "../../scripts/lib/smoke-state.ts";

const NAME = "migrate";
const err = (m: string) => console.error(`[${NAME}] ${m}`);
const log = (m: string) => console.log(`[${NAME}] ${m}`);

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

const envPath = homeEnvFilePath();
const env = loadEnvFile(envPath);
if (!env) refuse(`no readable $HOME/.env (${envPath}).`);

// §3: "It must not contain `rm_owner`, `doadmin`, a superuser token ...". The
// old runner read the migration login's password from this file when it was
// there; this one refuses the file instead, before it connects to anything.
const forbidden = ["rm_owner", "doadmin"].filter((key) => env[key] !== undefined);
if (forbidden.length > 0) {
  refuse(
    `$HOME/.env holds a ${forbidden.join(" and a ")} line. Spec §3 keeps both out of it: the rm_owner password is ` +
      "typed at the terminal for the one run that needs it and never stored. Remove the line and rerun.",
  );
}

// Args override env (§3), so the process's RM_ENV wins over the file's.
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

// The gates read `deployment_identity` through the least-privileged role that
// can: §3 puts `rm_readonly` in `~/.env` and 0063 grants it SELECT there.
const readonlyUrl = urlForRole(env, "rm_readonly");
if (!readonlyUrl) {
  refuse(`$HOME/.env cannot assemble an rm_readonly connection (host, port, database, sslmode and an rm_readonly line).`);
}
const target = (() => {
  const u = new URL(readonlyUrl);
  return `${u.hostname}:${u.port || "5432"}${u.pathname}`;
})();

// backend/src/config.ts validates at IMPORT, and the run's modules import it.
// It requires DATABASE_URL: this process's is the rm_readonly target above, a
// runtime credential that can do no DDL, and it is what the owner-login check
// reads `pg_roles` through. Its RM_ENV list still carries the retired `smoke`
// spelling where the spec says `stage` (scripts/lib/smoke-env-policy.ts
// documents the gap), so a `stage` policy is presented to it as `smoke`. The
// gates below read `rmEnv`, never config.env.
process.env.DATABASE_URL = readonlyUrl;
if (process.env.RM_ENV === "stage") process.env.RM_ENV = "smoke";

const postgres = (await import("postgres")).default;
const { TARGET_LOCK_KEY } = await import("../src/db/target-lock.ts");
const {
  checkMigrateGates,
  confirmRemoteTarget,
  migrateReceiptPath,
  promptOwnerPassword,
  runMigrate,
  writeMigrateReceipt,
} = await import("./migrate-run.ts");
const receiptPath = receiptFlag ?? migrateReceiptPath(receiptDir ?? "", startedAt);

const reader = postgres(readonlyUrl, { max: 1, onnotice: () => {} });
let owner: ReturnType<typeof postgres> | null = null;
try {
  const options = {
    caller: "operator" as const,
    env: rmEnv,
    // `bun run migrate` never targets a Postgres smoke owns: that is
    // `bun smoke --migrate`, which uses smoke's generated password (§8.5).
    connection: "remote" as const,
    // D52 §2: ONE constant key for every tool and every database, so this
    // run contends with smoke's session lock and every other fenced mutation.
    lockKey: TARGET_LOCK_KEY,
    sessionLockHeld: false,
    nonInteractive: !process.stdin.isTTY,
  };

  const refusals = await checkMigrateGates(reader, options);
  if (refusals.length > 0) {
    for (const refusal of refusals) err(refusal.message);
    process.exitCode = 1;
  } else {
    log(`target ${target}, RM_ENV=${rmEnv ?? "(unset)"}`);
    const password = await promptOwnerPassword(options);
    const ownerUrl = new URL(readonlyUrl);
    ownerUrl.username = "rm_owner";
    ownerUrl.password = encodeURIComponent(password);
    owner = postgres(ownerUrl.toString(), { max: 1, onnotice: () => {} });
    await confirmRemoteTarget(options, target);

    const result = await runMigrate(owner, options);
    const written = await writeMigrateReceipt(receiptPath, result, {
      caller: options.caller,
      env: options.env,
      target,
      startedAt,
    });
    log(`applied ${result.applied.length} migration(s)${result.applied.length ? `: ${result.applied.join(", ")}` : ""}`);
    if (result.resumedAndVerified.length > 0) {
      log(`resumed and verified ${result.resumedAndVerified.length} committed migration(s)`);
    }
    log(`grants repaired on ${result.grantsRepaired.length} relation(s)`);
    log(`manifest ${result.manifest.contentHash} published`);
    log(`receipt ${written}`);
  }
} catch (e) {
  err(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
} finally {
  await reader.end({ timeout: 5 });
  await owner?.end({ timeout: 5 });
  const { closeDb } = await import("../src/db/client.ts");
  await closeDb();
}
