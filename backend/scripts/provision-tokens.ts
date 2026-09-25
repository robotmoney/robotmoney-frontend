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
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { urlForRole } from "../../scripts/lib/env-role.ts";
import { instancePaths, readRolePasswords, SERVICE_TOKEN_HOLDERS, type ServiceTokenHolder } from "../../scripts/lib/smoke-state.ts";
import type { HeldTargetLock, LockHolder } from "../src/db/target-lock.ts";

/**
 * The request the direct-run form takes, from RM_PROVISION_REQUEST or from the
 * JSON file named by `--request <file>`. No secret travels in it.
 */
export interface ProvisionRequest {
  /** The deployment instance (§1.1): the `automation_tokens.instance` value and the state directory's name. */
  readonly instance: string;
  /** The absolute state root; the token files go under `<stateRoot>/<instance>/tokens/`. */
  readonly stateRoot: string;
  /** How the host reaches the local Postgres. */
  readonly target: { readonly host: string; readonly port: number; readonly database: string; readonly sslmode: string };
  /**
   * Whose credential writes the rows.
   *   `instance` (the default): a Postgres `bun smoke` owns — rm_owner and
   *     rm_readonly from the instance's generated role passwords (§5). The
   *     boot's session target lock is required and proven held.
   *   `stack-superuser`: a throwaway compose stack's own `postgres` superuser
   *     (scripts/stack's DEFAULT_STACK_DATABASE, not a secret: that container
   *     is reachable only on this host's loopback). What an eval or a rails
   *     test stack uses; it is refused for any host but loopback, so it can
   *     never reach a deployment's database.
   */
  readonly credentials?: { readonly source: "instance" } | { readonly source: "stack-superuser"; readonly user: string; readonly password: string };
  /** The caller's session target lock, proven held before the write. Required for `instance`. */
  readonly lock?: { readonly backendPid: number; readonly holder: LockHolder };
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

/** Loopback only: the one kind of host a `stack-superuser` request may name. */
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** The owner and reader URLs a request names, from the instance's passwords or a throwaway stack's superuser. */
function requestUrls(request: ProvisionRequest): { ownerUrl: string; readerUrl: string } {
  const connection = {
    host: request.target.host,
    port: String(request.target.port),
    database: request.target.database,
    sslmode: request.target.sslmode,
  };
  const credentials = request.credentials ?? { source: "instance" as const };
  if (credentials.source === "stack-superuser") {
    if (!LOOPBACK.has(request.target.host)) {
      throw new Error(`a stack-superuser request provisions only a throwaway stack on this host's loopback, not ${request.target.host}`);
    }
    const url = urlForRole({ ...connection, [credentials.user]: credentials.password }, credentials.user);
    if (!url) throw new Error("the stack-superuser request names no usable connection");
    return { ownerUrl: url, readerUrl: url };
  }
  const passwords = readRolePasswords(instancePaths(request.stateRoot, request.instance));
  const readerUrl = urlForRole({ ...connection, rm_readonly: passwords.rm_readonly }, "rm_readonly");
  const ownerUrl = urlForRole({ ...connection, rm_owner: passwords.rm_owner }, "rm_owner");
  if (!readerUrl || !ownerUrl) throw new Error("the instance's role passwords do not name rm_readonly and rm_owner");
  return { ownerUrl, readerUrl };
}

/** The direct-run form: `bun smoke`'s local preparation, or a throwaway stack's. */
async function main(request: ProvisionRequest): Promise<ProvisionResult> {
  const paths = instancePaths(request.stateRoot, request.instance);
  const { ownerUrl, readerUrl } = requestUrls(request);
  if ((request.credentials?.source ?? "instance") === "instance" && !request.lock) {
    throw new Error("a boot's provisioning runs only under the boot's target lock, and this request names none");
  }
  // backend/src/config.ts validates at IMPORT. For an instance this is the
  // read-only role, which can write nothing; the owner credential never
  // enters the environment.
  process.env.DATABASE_URL = readerUrl;
  process.env.WORKER_DATABASE_URL = readerUrl;
  process.env.RM_ENV = "stage";
  const { default: postgres } = await import("postgres");
  const { observeTargetLock } = await import("../src/db/target-lock.ts");
  const reader = postgres(readerUrl, { max: 1, onnotice: () => {} });
  try {
    const lock = request.lock ? observeTargetLock(reader, request.lock.backendPid, request.lock.holder) : undefined;
    const result = await provisionServiceTokens({ ownerUrl, instance: request.instance, tokenFiles: paths.tokenFiles, lock });
    return { ok: true, ...result };
  } finally {
    await reader.end({ timeout: 5 }).catch(() => undefined);
  }
}

/** The request from `--request <file>`, else RM_PROVISION_REQUEST, else null. */
function readRequest(argv: readonly string[], env: Record<string, string | undefined>): ProvisionRequest | null {
  const at = argv.indexOf("--request");
  if (at >= 0 && argv[at + 1]) return JSON.parse(readFileSync(argv[at + 1]!, "utf8")) as ProvisionRequest;
  return JSON.parse(env.RM_PROVISION_REQUEST ?? "null") as ProvisionRequest | null;
}

if (import.meta.main) {
  // A terminal's Ctrl-C is the boot's to honour at its next phase boundary,
  // never this step's to die of halfway through a fenced write.
  process.on("SIGINT", () => {});
  let request: ProvisionRequest | null = null;
  let result: ProvisionResult;
  try {
    request = readRequest(process.argv.slice(2), process.env);
    if (request === null) throw new Error("no request: pass `--request <file>` or RM_PROVISION_REQUEST (this process is started by `bun smoke`)");
    result = await main(request);
  } catch (error) {
    result = { ok: false, error: error instanceof Error ? error.message : String(error) };
    console.error(`[smoke:tokens] ${result.error}`);
  }
  if (request?.resultFile) writeFileSync(request.resultFile, `${JSON.stringify(result)}\n`, { mode: 0o600 });
  process.exit(result.ok ? 0 : 1);
}
