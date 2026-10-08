#!/usr/bin/env bun
// PRODUCTION INITIALIZATION — smoke-production-spec.md §9.1 steps 1 and 4-6,
// §4.3, §2, §3; D47, D52, D55 (5)/(6), D61. Issue #1026 criteria 42 and 43.
//
//   bun scripts/prod-init.ts enable-owner-login --confirm-target <host:port/database> [--instance <name>]
//   bun scripts/prod-init.ts set-identity       --confirm-target <host:port/database> [--instance <name>]
//   bun scripts/prod-init.ts provision-tokens   --confirm-target <host:port/database> [--instance <name>]
//   bun scripts/prod-init.ts rebind-members     --confirm-target <host:port/database> [--instance <name>] [--credentials <path>] [--api <url>]
//
// rebind-members against the instance's own smoke-owned twin (RM_ENV=stage,
// runbook R3.8) takes no --confirm-target. A local twin needs no confirmation,
// as it never needed a `y`.
//
// D61: no command prompts. The `rm_owner` and `doadmin` passwords are lines in
// `$HOME/.env` (scripts/lib/privileged-env.ts). The interactive `y` is
// `--confirm-target`, which must equal exactly the `host:port/database` the
// command resolved from `~/.env`. A mismatch refuses and prints both. Neither
// password ever reaches a receipt, a log line, an error message or argv.
//
// §4.3 still holds for the rest: each command is gated by its RM_ENV, the
// confirmation, a receipt and the target lock. None is reachable through
// `bun smoke` (scripts/tests/unit/prod-init.test.ts walks smoke-main's and
// scripts/stack's imports to hold that).
//
// WHAT EACH COMMAND DOES.
//   enable-owner-login  §9.1 step 1, D61. As `doadmin` from `~/.env`, read
//                     `rolcanlogin` for rm_owner. When it is false, run exactly
//                     `ALTER ROLE rm_owner LOGIN` (the password is unchanged).
//                     Then prove a login as rm_owner with the `~/.env`
//                     password. Already LOGIN: verify only, no ALTER
//                     (backend/scripts/enable-owner-login.ts). It is the ONE
//                     command that reads `doadmin`. It runs under RM_ENV=prod,
//                     and under RM_ENV=stage too, because D61 rule 2 rehearses
//                     the production runbook unmodified on stage. It runs
//                     before the first migrate, so it accepts a PRE-IDENTITY
//                     target (no identity row) under either policy, guarded by
//                     the ledger: it must equal a supported baseline exactly
//                     (backend/src/db/supported-releases.ts). A target with a
//                     row must match the policy, like every other command.
//   set-identity      §9.1 step 4. Confirms the identity the policy names and
//                     receipts it: `production` under RM_ENV=prod, `rehearsal`
//                     under RM_ENV=stage (D61 rule 2: the stage rehearsal runs
//                     step R6.4 unmodified). The first migrate already wrote
//                     the row, in the transaction that created the table
//                     (D55 (9), D61), so this command reads it through rm_owner
//                     inside the §2 fence and REPORTS it, unchanged
//                     (backend/scripts/set-identity.ts). It writes no row: a
//                     target enrolled otherwise refuses before any credential
//                     is read.
//   provision-tokens  §9.1 step 5. The three service tokens — hash and rights in
//                     the store, the secret in `tokens/<holder>/token` under the
//                     instance's state directory — through the one module that
//                     writes them (backend/scripts/provision-tokens.ts), inside
//                     the fence. Re-running it is a rotation: each holder's row
//                     is replaced in place and its old token refused on its next
//                     request (D55 (6)); restart the holders afterwards (§3).
//                     It is ALSO how a remote REHEARSAL target gets its tokens
//                     (§5: "A remote rehearsal target uses tokens provisioned for
//                     that enrolled target by the same procedure, run
//                     explicitly"), under `RM_ENV=stage` against a database
//                     enrolled `rehearsal` — `bun smoke` never mints them for a
//                     remote target (criterion 43).
//   rebind-members    §9.1 step 6. For each `credential.json` entry, one at a
//                     time: POST the admin `rotate-key` route with the entry's
//                     public key and the operator's service token, then write
//                     the bearer the route returns into that entry, atomically
//                     (scripts/lib/swarm/credential-file.ts). No rm_owner: it
//                     writes through the API. Under `RM_ENV=stage` it may
//                     address the instance's own smoke-owned twin (runbook
//                     R3.8): the twin's generated `rm_readonly` is the target
//                     then, not `~/.env`, which on a stage host names
//                     production's read replica.
//
// THE IDENTITY RULE (D61). Every command runs under RM_ENV=prod against a
// `production` target or under RM_ENV=stage against a `rehearsal` target, and
// never crosswise. The one exception is enable-owner-login on a pre-identity
// target whose ledger is a supported baseline.
//
// THE GATES, in order, each refusing before anything changes: the command; the
// policy; the instance (§1.1); the connection (`~/.env`, §3, or the instance's
// twin); the target's `deployment_identity`; the credential (`rm_owner`, and
// `doadmin` for enable-owner-login, from `~/.env`; the operator token for
// rebind-members); `--confirm-target`; the target lock (§2), revalidated
// against the read that planned the run. Every mutation happens inside the
// lock and, for a database write, inside the fence. The receipt — what ran,
// against what, by whom, and what it changed; never a secret — is written
// under the instance's state directory.
import { hostname, userInfo } from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { homeEnvFilePath, loadEnvFile, redactedTarget, urlForRole } from "./lib/env-role.ts";
import { instanceFlag, instancePaths, readRolePasswords, readStackState, resolveInstance, stateRoot as resolveStateRoot, type InstancePaths } from "./lib/smoke-state.ts";
import { readServiceToken } from "./lib/smoke-secret.ts";
import { loadCredentialFile, resolveCredentialPath, writeCredentialBearer, type CredentialEntry, type ParticipantKind } from "./lib/swarm/credential-file.ts";
import { resolveStackEnvironment } from "./stack/naming.ts";
import { describeUnmatchedLedger, matchSupportedRelease } from "../backend/src/db/supported-releases.ts";
import type { HeldTargetLock, LockHolder, TargetState } from "../backend/src/db/target-lock.ts";
import type { SetIdentityOptions, SetIdentityResult } from "../backend/scripts/set-identity.ts";
import type { ProvisionOptions } from "../backend/scripts/provision-tokens.ts";
import type { EnableOwnerLoginOptions, EnableOwnerLoginResult } from "../backend/scripts/enable-owner-login.ts";
import { confirmTargetFlag, homeEnvTarget, requireConfirmTarget, requirePrivilegedPassword } from "./lib/privileged-env.ts";

export const PROD_INIT_COMMANDS = ["enable-owner-login", "set-identity", "provision-tokens", "rebind-members"] as const;
export type ProdInitCommand = (typeof PROD_INIT_COMMANDS)[number];

/** A refusal: nothing was changed, and the message says why. */
export class ProdInitRefusal extends Error {}

/** Everything the command touches outside itself, injected so every refusal is testable without a database. */
export interface ProdInitDeps {
  readonly env: Record<string, string | undefined>;
  /** `~/.env`, parsed; undefined when absent. */
  readonly homeEnv: Record<string, string> | undefined;
  readonly homeEnvPath: string;
  readonly stateRoot: string;
  readTarget(readerUrl: string): Promise<TargetState>;
  acquireLock(readerUrl: string, holder: Omit<LockHolder, "acquiredAt">, expected: TargetState): Promise<{ lock: HeldTargetLock; release(): Promise<void> } | { refusal: string }>;
  setIdentity(options: SetIdentityOptions): Promise<SetIdentityResult>;
  provisionTokens(options: ProvisionOptions & { readonly readerUrl: string; readonly rmEnv: string }): Promise<{ holders: string[]; files: Record<string, string> }>;
  rotateKey(apiUrl: string, operatorToken: string, memberId: string, publicKey: string): Promise<{ status: number; token?: string; error?: string }>;
  /** enable-owner-login's database half: the ONLY dep that receives a doadmin URL. */
  enableOwnerLogin(options: EnableOwnerLoginOptions): Promise<EnableOwnerLoginResult>;
  now(): Date;
  log(line: string): void;
}

/** What a completed (or failed-after-starting) command records. Never a secret. */
export interface ProdInitReceipt {
  readonly command: ProdInitCommand;
  readonly instance: string;
  readonly rmEnv: string;
  /** `rm_readonly@host:port/db` — the target, redacted. */
  readonly target: string;
  readonly identityBefore: TargetState["identity"];
  readonly operator: string;
  readonly lockHolder: string;
  readonly startedAt: string;
  readonly writtenAt: string;
  readonly outcome: "completed" | "failed";
  readonly error?: string;
  readonly detail: Record<string, unknown>;
  readonly receiptFile: string;
}

const USAGE = `usage: bun scripts/prod-init.ts <${PROD_INIT_COMMANDS.join("|")}> --confirm-target <host:port/database> [--instance <name>] [--credentials <path>] [--api <url>]`;

function flag(argv: readonly string[], name: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name) return argv[i + 1];
    if (argv[i]!.startsWith(`${name}=`)) return argv[i]!.slice(name.length + 1);
  }
  return undefined;
}

/**
 * Run one production-initialization command.
 *
 * Throws {@link ProdInitRefusal} for every gate that fails, before anything
 * changes. A failure once the lock is held is written to the receipt as
 * `failed` and rethrown.
 */
export async function runProdInit(argv: readonly string[], deps: ProdInitDeps): Promise<ProdInitReceipt> {
  const refuse = (why: string): never => {
    throw new ProdInitRefusal(`prod-init: ${why} Nothing was changed.`);
  };
  const command = argv[0] as ProdInitCommand;
  if (!(PROD_INIT_COMMANDS as readonly string[]).includes(command)) refuse(`unknown command "${argv[0] ?? ""}". ${USAGE}.`);
  const rest = argv.slice(1);


  // §4.1/§4.3: the policy. Production initialization runs under `prod`; the
  // stage uses are provisioning a REHEARSAL target's tokens (§5) and, since
  // 2026-10-05 (owner, runbook R3.8/B10), rebinding a REHEARSAL target's
  // seated members: the rebind order is the one cutover step that can only be
  // learned by running it, it writes through the API with the operator token,
  // and on a rehearsal target every key is throwaway. Since D61 (rule 2:
  // stage runs the production runbook unmodified) every command runs under
  // both: prod against `production`, stage against `rehearsal` (below).
  const rmEnv = deps.env.RM_ENV ?? deps.homeEnv?.RM_ENV;
  if (rmEnv !== "prod" && rmEnv !== "stage") {
    refuse(`${command} requires RM_ENV=prod (production, §9.1) or RM_ENV=stage against a rehearsal target (§5, R3.8, D61); RM_ENV is ${rmEnv === undefined ? "unset" : `"${rmEnv}"`}.`);
  }
  const policy = rmEnv as "prod" | "stage";

  // §1.1: which instance's state directory the tokens and the receipt go to.
  let paths: InstancePaths;
  let instanceName: string;
  try {
    const instance = resolveInstance({
      flag: instanceFlag([...rest]),
      rmEnv: policy,
      environment: resolveStackEnvironment(deps.env),
      stateRoot: deps.stateRoot,
    });
    instanceName = instance.name;
    paths = instancePaths(deps.stateRoot, instance.name, { create: true });
  } catch (error) {
    return refuse(error instanceof Error ? error.message : String(error));
  }

  // §3: the target. Under `prod` it is `~/.env`'s remote connection, always.
  // Under `stage`, rebind-members may address the instance's own smoke-owned
  // twin (`bun smoke --local dump`, runbook R3.8): its `rm_readonly` is the
  // generated one in the instance's role-passwords file, never `~/.env`'s,
  // which on a stage host names production's read replica (R3.1). Only when
  // the instance records no twin does `~/.env` name a remote rehearsal target.
  const homeEnv = deps.homeEnv;
  const twinUrl = policy === "stage" && command === "rebind-members" ? twinReaderUrl(paths) : undefined;
  const readerUrl = twinUrl ?? (homeEnv ? urlForRole(homeEnv, "rm_readonly") : undefined);
  if (!readerUrl) {
    refuse(`the remote connection (host, port, database or dbname, sslmode) and the rm_readonly line must be in ${deps.homeEnvPath} (§3).`);
  }
  const target = redactedTarget(readerUrl, "rm_readonly");
  if (twinUrl) deps.log(`target: instance ${instanceName}'s own twin, ${target} (not ${deps.homeEnvPath})`);

  // §4.2/§4.3: what the target is enrolled for, read before any credential.
  let state: TargetState;
  try {
    state = await deps.readTarget(readerUrl!);
  } catch (error) {
    return refuse(`the target ${target} could not be read: ${error instanceof Error ? error.message : String(error)}.`);
  }
  // D61: the identity must be the one the policy names — `production` under
  // prod, `rehearsal` under stage — never crosswise.
  const expected = policy === "prod" ? "production" : "rehearsal";
  const crosswise = `${command} under RM_ENV=${policy} requires ${target} enrolled \`${expected}\`; it reads \`${state.identity}\` (§4.3, D61: never crosswise).`;
  if (command === "enable-owner-login" && state.identity === "missing") {
    // §9.1 step 1 precedes the first migrate, so the target has no identity
    // row yet. The guard is the ledger: exactly a supported baseline, the
    // state the first migrate (prod) or the remote rehearsal pass (stage)
    // starts from.
    if (matchSupportedRelease(state.ledger) === null) {
      refuse(
        `${command} on ${target}, which has no deployment_identity row, requires a ledger exactly equal to a supported ` +
          `baseline (the pre-identity state the first migrate starts from); ${describeUnmatchedLedger(state.ledger)}.`,
      );
    }
  } else if (state.identity !== expected) {
    if (command === "set-identity" && state.identity === "missing") {
      refuse(
        `${target} reads \`missing\`. The first migrate writes \`${expected}\` in the transaction that creates ` +
          "deployment_identity (§9.1 step 4, D55 (9), D61), and set-identity only reports that row: run `bun run migrate` first.",
      );
    }
    refuse(crosswise);
  }

  // The credential this command acts with (D61): rm_owner from `~/.env` for a
  // direct database write, doadmin from `~/.env` for enable-owner-login only,
  // the operator's service token for the admin API. Never a prompt.
  let ownerUrl: string | undefined;
  let doadminUrl: string | undefined;
  let operatorToken: string | undefined;
  // Every seated member the file names, agents then judges, each by name. Read
  // straight off the validated file: rebinding is not participant
  // reconciliation (planParticipants owns that), so it builds no roster plan.
  let roster: { name: string; kind: ParticipantKind; credential: CredentialEntry }[] = [];
  let credentialPath: string | undefined;
  let apiUrl: string | undefined;
  if (command === "rebind-members") {
    try {
      operatorToken = readServiceToken(paths, "operator");
    } catch (error) {
      refuse(`${error instanceof Error ? error.message : String(error)}.`);
    }
    const resolution = resolveCredentialPath({ RM_CREDENTIALS: homeEnv?.RM_CREDENTIALS ?? deps.env.RM_CREDENTIALS }, flag(rest, "--credentials"));
    if (!resolution.configured) refuse("no credential file is configured: set RM_CREDENTIALS in ~/.env or pass --credentials <path> (§6.1).");
    credentialPath = (resolution as { path: string }).path;
    try {
      const file = loadCredentialFile(credentialPath);
      roster = [
        ...Object.keys(file.agents).sort().map((name) => ({ name, kind: "agent" as const, credential: file.agents[name]! })),
        ...Object.keys(file.judges).sort().map((name) => ({ name, kind: "judge" as const, credential: file.judges[name]! })),
      ];
    } catch (error) {
      refuse(`${error instanceof Error ? error.message : String(error)}.`);
    }
    if (roster.length === 0) refuse(`${credentialPath} names no member to rebind.`);
    const recorded = (() => {
      try {
        return readStackState(paths);
      } catch {
        return null;
      }
    })();
    apiUrl = flag(rest, "--api") ?? (recorded?.apiPort ? `http://127.0.0.1:${recorded.apiPort}` : undefined);
    if (!apiUrl) refuse(`no api address: instance ${instanceName} records no running stack; pass --api <url>.`);
  } else {
    if (!homeEnv) refuse(`the remote connection must be in ${deps.homeEnvPath} (§3).`);
    try {
      if (command === "enable-owner-login") {
        requirePrivilegedPassword(homeEnv, "doadmin", deps.homeEnvPath);
        doadminUrl = urlForRole(homeEnv!, "doadmin");
      }
      requirePrivilegedPassword(homeEnv, "rm_owner", deps.homeEnvPath);
    } catch (error) {
      refuse((error as Error).message.replace(/^Refusing: /, "").replace(/ Nothing was changed\.$/, ""));
    }
    ownerUrl = urlForRole(homeEnv!, "rm_owner");
    if (!ownerUrl || (command === "enable-owner-login" && !doadminUrl)) {
      refuse(`the remote connection (host, port, database or dbname, sslmode) must be in ${deps.homeEnvPath} (§3).`);
    }
  }

  const what = {
    "enable-owner-login": `make rm_owner LOGIN on ${target} through doadmin if it is not, then prove the rm_owner login`,
    "set-identity": `confirm and receipt ${target}'s \`${expected}\` enrollment (it is read, never rewritten)`,
    "provision-tokens": `provision the three service tokens for instance ${instanceName} on ${target} (a re-run rotates them; restart the holders after)`,
    "rebind-members": `rotate ${roster.length} member key(s) from ${credentialPath} through ${apiUrl} and write each new bearer into its entry`,
  }[command];
  deps.log(`about to ${what}`);

  // D61: the `y` is `--confirm-target`. A target resolved from `~/.env` needs
  // the flag to name it exactly. The instance's own local twin needs none.
  if (!twinUrl) {
    const resolved = homeEnv ? homeEnvTarget(homeEnv) : undefined;
    if (!resolved) refuse(`the remote connection (host, port, database or dbname) must be in ${deps.homeEnvPath} (§3).`);
    try {
      requireConfirmTarget(confirmTargetFlag(rest), resolved!, command);
    } catch (error) {
      refuse((error as Error).message.replace(/^Refusing: /, "").replace(/ Nothing was changed\.$/, ""));
    }
  }

  // §2: the session target lock, after which the target is re-read and held
  // to the read above.
  const holder = { tool: `prod-init:${command}`, planId: null, instance: instanceName, host: hostname(), pid: process.pid };
  const acquired = await deps.acquireLock(readerUrl!, holder, state);
  if ("refusal" in acquired) return refuse(acquired.refusal);


  const startedAt = deps.now().toISOString();
  let detail: Record<string, unknown> = {};
  let failure: unknown;
  try {
    switch (command) {
      case "enable-owner-login": {
        const result = await deps.enableOwnerLogin({ doadminUrl: doadminUrl!, ownerUrl: ownerUrl!, lock: acquired.lock });
        detail = { rolcanloginBefore: result.rolcanloginBefore, altered: result.altered, verified: result.verified };
        deps.log(
          result.altered
            ? "rm_owner was NOLOGIN: ran ALTER ROLE rm_owner LOGIN through doadmin, then proved the rm_owner login"
            : "rm_owner was already LOGIN: no ALTER ran; the rm_owner login is proven",
        );
        break;
      }
      case "set-identity": {
        const result = await deps.setIdentity({
          ownerUrl: ownerUrl!,
          expected,
          rmEnv: policy,
          confirmed: true,
          note: `bun scripts/prod-init.ts set-identity by ${operatorName()}@${hostname()}`,
          lock: acquired.lock,
        });
        detail = {
          before: result.before,
          after: result.row.kind,
          written: result.written,
          writtenBy: result.row.writtenBy,
          writtenAt: result.row.writtenAt,
          note: result.row.note,
        };
        break;
      }
      case "provision-tokens": {
        const result = await deps.provisionTokens({
          ownerUrl: ownerUrl!,
          instance: instanceName,
          tokenFiles: paths.tokenFiles,
          lock: acquired.lock,
          readerUrl: readerUrl!,
          rmEnv: policy,
        });
        detail = { holders: result.holders, files: result.files, note: "restart system-scheduler and analytics-producer to load the new tokens (§3)" };
        break;
      }
      case "rebind-members": {
        const rebound: { name: string; kind: string; memberId: string }[] = [];
        detail = { credentialFile: credentialPath, rebound };
        for (const entry of roster) {
          const { assertStillHeld } = await import("../backend/src/db/target-lock.ts");
          await assertStillHeld(acquired.lock, `rebind ${entry.name}`);
          const r = await deps.rotateKey(apiUrl!, operatorToken!, entry.credential.memberId, entry.credential.publicKeyB64);
          if (!r.token) throw new Error(`rotate-key for ${entry.kind} "${entry.name}" (${entry.credential.memberId}) answered ${r.status}: ${r.error ?? "no bearer"}`);
          writeCredentialBearer(credentialPath!, entry.kind, entry.name, r.token);
          rebound.push({ name: entry.name, kind: entry.kind, memberId: entry.credential.memberId });
          deps.log(`rebound ${entry.kind} ${entry.name} (${entry.credential.memberId}); its new bearer is in ${credentialPath}`);
        }
        break;
      }
    }
  } catch (error) {
    // Neither privileged password may leave in a receipt or a message (D61),
    // whatever a driver put in its error.
    failure = new Error(scrubSecrets(error instanceof Error ? error.message : String(error), homeEnv));
  } finally {
    await acquired.release();
  }

  const receiptDir = join(paths.dir, "prod-init");
  mkdirSync(receiptDir, { recursive: true, mode: 0o700 });
  const writtenAt = deps.now().toISOString();
  const receiptFile = join(receiptDir, `${command}-${writtenAt.replace(/[:.]/g, "-")}.json`);
  const receipt: ProdInitReceipt = {
    command,
    instance: instanceName,
    rmEnv: policy,
    target,
    identityBefore: state.identity,
    operator: `${operatorName()}@${hostname()}`,
    lockHolder: holder.tool,
    startedAt,
    writtenAt,
    outcome: failure === undefined ? "completed" : "failed",
    ...(failure === undefined ? {} : { error: failure instanceof Error ? failure.message : String(failure) }),
    detail,
    receiptFile,
  };
  writeFileSync(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  deps.log(`receipt: ${receiptFile}`);
  if (failure !== undefined) throw failure;
  return receipt;
}

/**
 * The instance's own smoke-owned twin as a reader URL, or undefined when the
 * instance records no twin (no stack state, an external database, or no
 * generated role passwords). The twin's connection is stack state's
 * `databaseUrl` with the generated `rm_readonly` login (runbook section 3:
 * a twin's credentials are generated, nobody types them).
 */
function twinReaderUrl(paths: InstancePaths): string | undefined {
  let recorded;
  try {
    recorded = readStackState(paths);
  } catch {
    return undefined;
  }
  if (!recorded || recorded.db !== "smoke-twin" || !recorded.databaseUrl) return undefined;
  let url: URL;
  try {
    url = new URL(recorded.databaseUrl);
  } catch {
    return undefined;
  }
  const passwords = readRolePasswords(paths);
  url.username = "rm_readonly";
  url.password = passwords.rm_readonly;
  return url.toString();
}

/** Replace the `~/.env` privileged passwords, raw or URL-encoded, with `***`. */
function scrubSecrets(text: string, homeEnv: Record<string, string> | undefined): string {
  let out = text;
  for (const key of ["rm_owner", "doadmin"] as const) {
    const secret = homeEnv?.[key];
    if (!secret) continue;
    out = out.split(secret).join("***");
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) out = out.split(encoded).join("***");
  }
  return out;
}

function operatorName(): string {
  try {
    return userInfo().username;
  } catch {
    return "unknown";
  }
}

/** The real effects: `~/.env`, the target database, the admin API. No terminal. */
export function realDeps(env: Record<string, string | undefined> = process.env): ProdInitDeps {
  const homeEnvPath = homeEnvFilePath();
  return {
    env,
    homeEnv: loadEnvFile(homeEnvPath),
    homeEnvPath,
    stateRoot: resolveStateRoot(env),
    async enableOwnerLogin(options) {
      const { enableOwnerLogin } = await import("../backend/scripts/enable-owner-login.ts");
      return enableOwnerLogin(options);
    },
    async readTarget(readerUrl) {
      const { readTargetStateAt } = await import("../backend/src/db/target-lock.ts");
      return readTargetStateAt(readerUrl);
    },
    async acquireLock(readerUrl, holder, expected) {
      const { acquireTargetLock } = await import("../backend/src/db/target-lock.ts");
      const result = await acquireTargetLock({ databaseUrl: readerUrl, holder, timeoutMs: 30_000, expected });
      return result.acquired ? { lock: result.lock, release: () => result.lock.release() } : { refusal: result.reason };
    },
    async setIdentity(options) {
      const { setProductionIdentity } = await import("../backend/scripts/set-identity.ts");
      return setProductionIdentity(options);
    },
    async provisionTokens(options) {
      // backend/src/config.ts validates at import: the read-only role, which
      // can write nothing. The ~/.env owner password stays in the URL it came in.
      process.env.DATABASE_URL = options.readerUrl;
      process.env.WORKER_DATABASE_URL = options.readerUrl;
      process.env.RM_ENV = options.rmEnv;
      const { provisionServiceTokens } = await import("../backend/scripts/provision-tokens.ts");
      return provisionServiceTokens(options);
    },
    async rotateKey(apiUrl, operatorToken, memberId, publicKey) {
      const { ROUTES, path } = await import("@robotmoney/contract");
      const res = await fetch(`${apiUrl.replace(/\/$/, "")}${path(ROUTES.swarm.admin.memberRotateKey, { id: memberId })}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Automation-Token": operatorToken },
        body: JSON.stringify({ publicKey }),
      });
      const body = (await res.json().catch(() => ({}))) as { token?: string; error?: string };
      return { status: res.status, token: res.ok ? body.token : undefined, error: body.error };
    },
    now: () => new Date(),
    log: (line) => console.log(`[prod-init] ${line}`),
  };
}

if (import.meta.main) {
  try {
    const receipt = await runProdInit(process.argv.slice(2), realDeps());
    console.log(`[prod-init] ${receipt.command}: completed (${receipt.receiptFile})`);
    process.exit(0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
