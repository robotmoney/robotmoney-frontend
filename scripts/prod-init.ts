#!/usr/bin/env bun
// PRODUCTION INITIALIZATION — smoke-production-spec.md §9.1 steps 4-6, §4.3,
// §2, §3; D47, D52, D55 (5)/(6). Issue #1026 criteria 42 and 43.
//
//   bun scripts/prod-init.ts set-identity      [--instance <name>]
//   bun scripts/prod-init.ts provision-tokens  [--instance <name>]
//   bun scripts/prod-init.ts rebind-members    [--instance <name>] [--credentials <path>] [--api <url>]
//
// §9.1 is "one-time initialization (receipted, never via `bun smoke`)", and
// §4.3 says what gates each command: "a set of separate commands allowed on
// `production`, each gated by `RM_ENV=prod`, `y/n`, a receipt and the target
// lock. A command that writes the database directly also requires a typed
// `rm_owner`; the key rotation of §9.1 step 6 goes through the admin API with
// the operator's admin service token instead. None is reachable through
// `bun smoke`." (scripts/tests/unit/prod-init.test.ts walks smoke-main's and
// scripts/stack's imports to hold that last sentence.)
//
// WHAT EACH COMMAND DOES.
//   set-identity      §9.1 step 4. Writes `deployment_identity = production`
//                     through rm_owner, inside the §2 fence
//                     (backend/scripts/set-identity.ts). It accepts the database
//                     the first production migrate just upgraded, which has the
//                     table and no row (D55 (5)).
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
//                     writes through the API.
//
// THE GATES, in order, each refusing before anything changes: the command; the
// policy (`RM_ENV=prod`, or `stage` for provision-tokens against a rehearsal
// target); the remote connection in `~/.env` (§3); the instance (§1.1); the
// target's `deployment_identity`; a terminal; the typed rm_owner password
// (never stored, D47) or the operator token; a literal `y`; the target lock
// (§2), revalidated against the read that planned the run. Every mutation
// happens inside the lock and, for a database write, inside the fence. The
// receipt — what ran, against what, by whom, and what it changed; never a
// secret — is written under the instance's state directory.
import { hostname, userInfo } from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { homeEnvFilePath, loadEnvFile, redactedTarget, urlForRole } from "./lib/env-role.ts";
import { instanceFlag, instancePaths, readStackState, resolveInstance, stateRoot as resolveStateRoot, type InstancePaths } from "./lib/smoke-state.ts";
import { readServiceToken } from "./lib/smoke-secret.ts";
import { loadCredentialFile, resolveCredentialPath, writeCredentialBearer, type CredentialEntry, type ParticipantKind } from "./lib/swarm/credential-file.ts";
import { resolveStackEnvironment } from "./stack/naming.ts";
import type { HeldTargetLock, LockHolder, TargetState } from "../backend/src/db/target-lock.ts";
import type { SetIdentityOptions, SetIdentityResult } from "../backend/scripts/set-identity.ts";
import type { ProvisionOptions } from "../backend/scripts/provision-tokens.ts";

export const PROD_INIT_COMMANDS = ["set-identity", "provision-tokens", "rebind-members"] as const;
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
  readonly isTerminal: boolean;
  promptSecret(question: string): Promise<string>;
  promptLine(question: string): Promise<string>;
  readTarget(readerUrl: string): Promise<TargetState>;
  acquireLock(readerUrl: string, holder: Omit<LockHolder, "acquiredAt">, expected: TargetState): Promise<{ lock: HeldTargetLock; release(): Promise<void> } | { refusal: string }>;
  setIdentity(options: SetIdentityOptions): Promise<SetIdentityResult>;
  provisionTokens(options: ProvisionOptions & { readonly readerUrl: string; readonly rmEnv: string }): Promise<{ holders: string[]; files: Record<string, string> }>;
  rotateKey(apiUrl: string, operatorToken: string, memberId: string, publicKey: string): Promise<{ status: number; token?: string; error?: string }>;
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

const USAGE = `usage: bun scripts/prod-init.ts <${PROD_INIT_COMMANDS.join("|")}> [--instance <name>] [--credentials <path>] [--api <url>]`;

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
  // one stage use is provisioning a remote REHEARSAL target's tokens (§5).
  const rmEnv = deps.env.RM_ENV ?? deps.homeEnv?.RM_ENV;
  if (command === "provision-tokens") {
    if (rmEnv !== "prod" && rmEnv !== "stage") {
      refuse(`provision-tokens requires RM_ENV=prod (production, §9.1 step 5) or RM_ENV=stage against a remote rehearsal target (§5); RM_ENV is ${rmEnv === undefined ? "unset" : `"${rmEnv}"`}.`);
    }
  } else if (rmEnv !== "prod") {
    refuse(`${command} requires RM_ENV=prod (§9.1, §4.3); RM_ENV is ${rmEnv === undefined ? "unset" : `"${rmEnv}"`}.`);
  }
  const policy = rmEnv as "prod" | "stage";

  // §3: the remote connection is `~/.env`'s. Production and a remote rehearsal
  // target are both remote; a local Postgres is `bun smoke`'s, which provisions
  // its own tokens.
  const homeEnv = deps.homeEnv;
  const readerUrl = homeEnv ? urlForRole(homeEnv, "rm_readonly") : undefined;
  if (!homeEnv || !readerUrl) {
    refuse(`the remote connection (host, port, database or dbname, sslmode) and the rm_readonly line must be in ${deps.homeEnvPath} (§3).`);
  }
  const target = redactedTarget(readerUrl, "rm_readonly");

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

  // §4.2/§4.3: what the target is enrolled for, read before any prompt.
  let state: TargetState;
  try {
    state = await deps.readTarget(readerUrl!);
  } catch (error) {
    return refuse(`the target ${target} could not be read: ${error instanceof Error ? error.message : String(error)}.`);
  }
  if (command === "set-identity") {
    if (state.identity === "rehearsal") {
      refuse(`${target} is enrolled \`rehearsal\`; set-identity enrolls a production database the first migrate upgraded, never a rehearsal one (§9.1).`);
    }
  } else if (policy === "prod" && state.identity !== "production") {
    refuse(`${command} under RM_ENV=prod requires ${target} enrolled \`production\`; it reads \`${state.identity}\` (run set-identity first, §9.1 step 4).`);
  } else if (policy === "stage" && state.identity !== "rehearsal") {
    refuse(`provision-tokens under RM_ENV=stage requires ${target} enrolled \`rehearsal\` (§4.3: stage policy never touches production data); it reads \`${state.identity}\`.`);
  }

  if (!deps.isTerminal) {
    refuse(`${command} needs an operator at a terminal: it asks for ${command === "rebind-members" ? "an explicit y" : "the rm_owner password and an explicit y"}, and neither is ever read from a file, a pipe or the environment (§3, D47).`);
  }

  // The credential this command acts with: a typed rm_owner for a direct
  // database write, the operator's service token for the admin API.
  let ownerUrl: string | undefined;
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
    const resolution = resolveCredentialPath({ RM_CREDENTIALS: homeEnv!.RM_CREDENTIALS ?? deps.env.RM_CREDENTIALS }, flag(rest, "--credentials"));
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
    const password = await deps.promptSecret("rm_owner password");
    if (password === "") refuse("no rm_owner password was typed (§3: it is typed for the one run that needs it).");
    ownerUrl = urlForRole({ ...homeEnv!, rm_owner: password }, "rm_owner");
  }

  const what = {
    "set-identity": `enroll ${target} as \`production\``,
    "provision-tokens": `provision the three service tokens for instance ${instanceName} on ${target} (a re-run rotates them; restart the holders after)`,
    "rebind-members": `rotate ${roster.length} member key(s) from ${credentialPath} through ${apiUrl} and write each new bearer into its entry`,
  }[command];
  const answer = (await deps.promptLine(`About to ${what}. Type y to continue`)).trim();
  if (answer !== "y") refuse(`the answer was "${answer}", not y.`);

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
      case "set-identity": {
        const result = await deps.setIdentity({
          ownerUrl: ownerUrl!,
          rmEnv: policy,
          confirmed: true,
          note: `bun scripts/prod-init.ts set-identity by ${operatorName()}@${hostname()}`,
          lock: acquired.lock,
        });
        detail = { before: result.before, after: result.row.kind, writtenBy: result.row.writtenBy, writtenAt: result.row.writtenAt };
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
    failure = error;
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

function operatorName(): string {
  try {
    return userInfo().username;
  } catch {
    return "unknown";
  }
}

/** The real effects: the terminal, the target database, the admin API. */
export function realDeps(env: Record<string, string | undefined> = process.env): ProdInitDeps {
  const homeEnvPath = homeEnvFilePath();
  return {
    env,
    homeEnv: loadEnvFile(homeEnvPath),
    homeEnvPath,
    stateRoot: resolveStateRoot(env),
    isTerminal: process.stdin.isTTY === true,
    async promptSecret(question) {
      const { hiddenPrompt } = await import("./lib/smoke-external-migrate.ts");
      return hiddenPrompt(question);
    },
    async promptLine(question) {
      const { createInterface } = await import("node:readline/promises");
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await rl.question(`${question}: `);
      } finally {
        rl.close();
      }
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
      // can write nothing. The typed owner password stays in the URL it came in.
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
