// A THROWAWAY STACK'S OWN DATABASE, prepared the way `bun smoke --local blank`
// prepares one (smoke-production-spec.md §5, §7.3; D52).
//
// An eval or a rails test brings up the same compose model as `bun smoke`, on a
// compose postgres of its own that is thrown away with it. Its api and worker
// run the same startup preflight a deployment's do (spec §7.2): they refuse a
// process that logs in as anything but rm_app / rm_worker, and a schema with no
// manifest. So the stack's database is built the one way a blank one is:
//
//   1. the local superuser creates the four roles with the instance's
//      generated passwords and hands the database to rm_owner — what doadmin
//      does on a fresh cluster, and the superuser is not used again;
//   2. the target lock is taken over rm_readonly (§2);
//   3. rm_owner bootstraps the snapshot's declaration, bootstrap data and
//      manifest under that lock (backend/scripts/smoke-prepare.ts `bootstrap`);
//   4. the three service tokens are provisioned under the same lock
//      (backend/scripts/provision-tokens.ts, the instance form);
//   5. the lock is released.
//
// The containers get the runtime roles' URLs and nothing else
// (throwawayStackDatabase). There is no legacy superuser migrate on this path.
import { hostname } from "node:os";
import { dirname } from "node:path";
import { acquireTargetLock } from "../../backend/src/db/target-lock.ts";
import {
  hostReadTargetState,
  instanceRolePasswords,
  localSuperuserSql,
  prepareChildEnv,
  roleUrl,
  runPrepareStep,
  superuserSqlSettled,
  type HostTarget,
} from "../lib/smoke-database.ts";
import { runTokenProvisioning } from "../lib/smoke-secret.ts";
import { instancePaths, readRolePasswords, type InstancePaths } from "../lib/smoke-state.ts";
import { DEFAULT_STACK_DATABASE, POSTGRES_CONTAINER_PORT, type StackDatabase } from "./config.ts";

/** How long a throwaway preparation waits on the target lock before refusing. */
const THROWAWAY_LOCK_TIMEOUT_MS = 60_000;

/**
 * The database config for a throwaway stack on its own compose postgres: the
 * baked-in superuser fields (the compose model's POSTGRES_* interpolation, used
 * only to create the roles) plus the runtime roles' URLs as a CONTAINER reaches
 * them. Generates and saves the instance's four role passwords on first call
 * (§5: "smoke generates the four role passwords and saves them in the
 * instance's state directory"); a second call reads the saved set.
 *
 * Call it once, with the instance the stack is given, before createStack().
 */
export function throwawayStackDatabase(paths: InstancePaths): StackDatabase {
  const passwords = instanceRolePasswords(paths, "blank");
  const target: HostTarget = { host: "postgres", port: POSTGRES_CONTAINER_PORT, database: DEFAULT_STACK_DATABASE.name, sslmode: "disable" };
  return {
    ...DEFAULT_STACK_DATABASE,
    roleUrls: {
      app: roleUrl(target, "rm_app", passwords.rm_app),
      worker: roleUrl(target, "rm_worker", passwords.rm_worker),
    },
  };
}

/** What prepareThrowawayDatabase needs from the stack it prepares. */
export interface ThrowawayDatabaseContext {
  readonly repoRoot: string;
  readonly instance: { readonly name: string; readonly stateDir: string };
  readonly database: StackDatabase;
  /** The running postgres container's id. */
  postgresContainer(): string;
  /** The host port Docker published the postgres container's 5432 on. */
  publishedPostgresPort(): number;
  log(message: string): void;
}

/**
 * Steps 1-5 above. Idempotent up to the bootstrap, which refuses a database
 * that already holds a schema — a throwaway stack is prepared once, on a fresh
 * volume.
 */
export async function prepareThrowawayDatabase(ctx: ThrowawayDatabaseContext): Promise<void> {
  const stateRoot = dirname(ctx.instance.stateDir);
  const paths = instancePaths(stateRoot, ctx.instance.name);
  // READ, never generate: the containers' role URLs were built from this set
  // (throwawayStackDatabase); a fresh one here would orphan them.
  const passwords = readRolePasswords(paths);

  // 1. The roles and the database's owner, by the stack's own superuser.
  const created = await superuserSqlSettled(
    ctx.postgresContainer(),
    ctx.database.user,
    ctx.database.name,
    localSuperuserSql(passwords, ctx.database.name),
  );
  if (created !== null) throw new Error(`the stack's superuser could not create the roles and the database: ${created}`);

  // 2. The target lock, over rm_readonly, from the host.
  const target: HostTarget = { host: "127.0.0.1", port: ctx.publishedPostgresPort(), database: ctx.database.name, sslmode: "disable" };
  const lockUrl = roleUrl(target, "rm_readonly", passwords.rm_readonly);
  const acquired = await acquireTargetLock({
    databaseUrl: lockUrl,
    holder: { tool: "stack", planId: null, instance: ctx.instance.name, host: hostname(), pid: process.pid },
    timeoutMs: THROWAWAY_LOCK_TIMEOUT_MS,
    expected: await hostReadTargetState(lockUrl),
  });
  if (!acquired.acquired) throw new Error(acquired.reason);
  const lock = acquired.lock;
  try {
    const held = { backendPid: lock.backendPid, holder: lock.holder };

    // 3. The snapshot bootstrap, as rm_owner, fenced under the lock.
    const bootstrapped = await runPrepareStep(ctx.repoRoot, {
      action: "bootstrap",
      rmEnv: null,
      connection: "local",
      target,
      credentials: { source: "instance", stateRoot, instance: ctx.instance.name },
      lock: held,
      stateDir: ctx.instance.stateDir,
      nonInteractive: true,
    }, prepareChildEnv(process.env));
    if (!bootstrapped.ok) throw new Error(`bootstrap: ${bootstrapped.error}`);
    ctx.log(`schema bootstrapped from the snapshot (manifest ${String(bootstrapped.detail.manifest).slice(0, 12)})`);

    // 4. The three service tokens, under the same lock.
    const provisioned = await runTokenProvisioning(ctx.repoRoot, {
      instance: ctx.instance.name,
      stateRoot,
      target,
      lock: held,
      stateDir: ctx.instance.stateDir,
    }, prepareChildEnv(process.env));
    if (!provisioned.ok) throw new Error(`service-token provisioning failed: ${provisioned.error}`);
    ctx.log(`service tokens provisioned for ${provisioned.holders.join(", ")}`);
  } finally {
    // 5. Released explicitly (§2), not left to connection teardown.
    await lock.release();
  }
}
