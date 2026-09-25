// PROVISION THE THREE SERVICE TOKENS — smoke-production-spec.md §3, §5, §9.1
// step 5. The one entry module that writes `automation_tokens`.
//
// WHAT IT DOES. For each holder (`system-scheduler`, `analytics-producer`,
// `operator`) it writes one row — the token's hash and that holder's rights,
// HOLDER_RIGHTS and nothing else — and delivers the secret as the holder's own
// file, `tokens/<holder>/token` under the instance's state directory
// (scripts/lib/smoke-state.ts `InstancePaths.tokenFiles`). The secret exists in
// exactly two places afterwards: that file, and nowhere else. The database holds
// its hash, so a leaked dump holds no usable token (§3).
//
// ONE FENCED TRANSACTION, AS `rm_owner` (§2, §3). Every row is written inside
// `withMutationFence`, whose first statement is `pg_advisory_xact_lock` on the
// target key, on the `rm_owner` connection that performs the write. A competitor
// that won the session lock after the caller's connection died still waits for
// this transaction to end. The runtime roles hold SELECT on the table and nothing
// else (migration 0069), so only this path can write it.
//
// RE-PROVISIONING REPLACES IN PLACE (D55 (6)). The row is keyed on (instance,
// holder) and the write is an upsert: a holder's new hash overwrites its old one
// in the same statement, no row is ever deleted, and every other holder's row —
// and every other instance's — is untouched. The old token is refused on its
// next request because no row carries its hash any more (§3: "Rotation is a
// re-provision and a container restart").
//
// FILES ARE STAGED IN THE TRANSACTION AND SWAPPED IN AFTER COMMIT. Each secret
// is written to a temporary file beside its destination, mode 0600, before the
// commit, and renamed over `token` only once the rows are committed. A crash
// before the commit leaves the old files matching the old rows; a crash between
// the commit and the rename leaves a holder whose file no longer validates, and
// the caller's journal has not recorded the step, so its rerun provisions again.
// The holder directory is 0700 and owned by the deploying user; each container
// mounts its own directory read-only and runs as root, which reads it.
//
// WHO RUNS IT.
//   - `bun smoke --local blank|dump`, as the `prepare (tokens)` step, directly
//     (`bun --no-env-file backend/scripts/provision-tokens.ts`) with one JSON
//     request in RM_PROVISION_REQUEST and no secret in it. It reads rm_owner
//     from the instance's generated role passwords (§5: a Postgres smoke owns)
//     and proves through `observeTargetLock` that the boot still holds the
//     session target lock before it writes. A remote target is never
//     provisioned by a boot (§5, criterion 43): the request shape has no remote
//     form.
//   - `bun scripts/prod-init.ts provision-tokens` (§9.1 step 5, and a remote
//     rehearsal target, §5), through {@link provisionServiceTokens} with the
//     owner password the operator typed. That caller takes the target lock
//     itself.
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { urlForRole } from "../../scripts/lib/env-role.ts";
import { instancePaths, readRolePasswords, SERVICE_TOKEN_HOLDERS, type ServiceTokenHolder } from "../../scripts/lib/smoke-state.ts";
import type { HeldTargetLock, LockHolder } from "../src/db/target-lock.ts";

/** The request `bun smoke` hands the direct-run form. No secret travels in it. */
export interface ProvisionRequest {
  /** The deployment instance (§1.1): the `automation_tokens.instance` value and the state directory's name. */
  readonly instance: string;
  /** The absolute state root; the token files go under `<stateRoot>/<instance>/tokens/`. */
  readonly stateRoot: string;
  /** How the host reaches the local Postgres the boot owns. */
  readonly target: { readonly host: string; readonly port: number; readonly database: string; readonly sslmode: string };
  /** The boot's session target lock, proven held before the write. */
  readonly lock: { readonly backendPid: number; readonly holder: LockHolder };
  readonly resultFile: string;
}

/** What the direct-run form writes to the request's result file: paths and holders, never a secret. */
export type ProvisionResult =
  | { readonly ok: true; readonly instance: string; readonly holders: readonly ServiceTokenHolder[]; readonly files: Readonly<Record<string, string>> }
  | { readonly ok: false; readonly error: string };

export interface ProvisionOptions {
  /** An `rm_owner` URL on a direct connection. Never logged. */
  readonly ownerUrl: string;
  readonly instance: string;
  /** Each holder's token file. */
  readonly tokenFiles: Readonly<Record<ServiceTokenHolder, string>>;
  /** Which holders to provision; all three by default. */
  readonly holders?: readonly ServiceTokenHolder[];
  /** A lock the caller holds; proven held immediately before the fenced write. */
  readonly lock?: HeldTargetLock;
}

/**
 * Provision `holders` on `instance` in one fenced `rm_owner` transaction, then
 * swap each secret into its holder's file.
 *
 * Returns the holders and file paths. The secrets never leave this function
 * except into their files.
 *
 * Refusal cases: an unknown holder; a lock that cannot be proven held; any
 * failure of the transaction (nothing is renamed, the staged files are removed,
 * and every holder keeps its old row and file).
 */
export async function provisionServiceTokens(options: ProvisionOptions): Promise<{ instance: string; holders: ServiceTokenHolder[]; files: Record<string, string> }> {
  const holders = [...(options.holders ?? SERVICE_TOKEN_HOLDERS)];
  for (const holder of holders) {
    if (!(SERVICE_TOKEN_HOLDERS as readonly string[]).includes(holder)) {
      throw new Error(`provision-tokens: unknown holder "${holder}" — expected ${SERVICE_TOKEN_HOLDERS.join(" | ")}`);
    }
  }
  const { assertStillHeld, withMutationFence } = await import("../src/db/target-lock.ts");
  const { HOLDER_RIGHTS, provisionAutomationToken } = await import("../src/db/automation-tokens.ts");
  if (options.lock) await assertStillHeld(options.lock, "prepare tokens");

  const staged = new Map<ServiceTokenHolder, string>();
  try {
    await withMutationFence({ databaseUrl: options.ownerUrl, label: "tokens" }, async (tx) => {
      for (const holder of holders) {
        const { token } = await provisionAutomationToken(options.instance, [...HOLDER_RIGHTS[holder]], { holder, db: tx });
        staged.set(holder, stageSecret(options.tokenFiles[holder], token));
      }
    });
  } catch (error) {
    for (const file of staged.values()) rmSync(file, { force: true });
    throw error;
  }
  const files: Record<string, string> = {};
  for (const holder of holders) {
    renameSync(staged.get(holder)!, options.tokenFiles[holder]);
    files[holder] = options.tokenFiles[holder];
  }
  return { instance: options.instance, holders, files };
}

/**
 * Write `secret` to a temporary file beside `destination`, mode 0600, synced to
 * disk, and return its path. The directory is created 0700 when absent.
 */
function stageSecret(destination: string, secret: string): string {
  const dir = dirname(destination);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = join(dir, `.token.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeSync(fd, `${secret}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return temp;
}

/** The direct-run form: `bun smoke`'s local preparation. */
async function main(request: ProvisionRequest): Promise<ProvisionResult> {
  const paths = instancePaths(request.stateRoot, request.instance);
  const passwords = readRolePasswords(paths);
  const connection = {
    host: request.target.host,
    port: String(request.target.port),
    database: request.target.database,
    sslmode: request.target.sslmode,
  };
  const readerUrl = urlForRole({ ...connection, rm_readonly: passwords.rm_readonly }, "rm_readonly");
  const ownerUrl = urlForRole({ ...connection, rm_owner: passwords.rm_owner }, "rm_owner");
  if (!readerUrl || !ownerUrl) throw new Error("the instance's role passwords do not name rm_readonly and rm_owner");
  // backend/src/config.ts validates at IMPORT: DATABASE_URL is the read-only
  // role, which can write nothing. The owner credential never enters the
  // environment.
  process.env.DATABASE_URL = readerUrl;
  process.env.WORKER_DATABASE_URL = readerUrl;
  process.env.RM_ENV = "stage";
  const { default: postgres } = await import("postgres");
  const { observeTargetLock } = await import("../src/db/target-lock.ts");
  const reader = postgres(readerUrl, { max: 1, onnotice: () => {} });
  try {
    const lock = observeTargetLock(reader, request.lock.backendPid, request.lock.holder);
    const result = await provisionServiceTokens({ ownerUrl, instance: request.instance, tokenFiles: paths.tokenFiles, lock });
    return { ok: true, ...result };
  } finally {
    await reader.end({ timeout: 5 }).catch(() => undefined);
  }
}

if (import.meta.main) {
  // A terminal's Ctrl-C is the boot's to honour at its next phase boundary,
  // never this step's to die of halfway through a fenced write.
  process.on("SIGINT", () => {});
  const request = JSON.parse(process.env.RM_PROVISION_REQUEST ?? "null") as ProvisionRequest | null;
  let result: ProvisionResult;
  try {
    if (request === null) throw new Error("RM_PROVISION_REQUEST is not set; this process is started by `bun smoke`");
    result = await main(request);
  } catch (error) {
    result = { ok: false, error: error instanceof Error ? error.message : String(error) };
    console.error(`[smoke:tokens] ${result.error}`);
  }
  if (request?.resultFile) writeFileSync(request.resultFile, `${JSON.stringify(result)}\n`, { mode: 0o600 });
  process.exit(result.ok ? 0 : 1);
}
