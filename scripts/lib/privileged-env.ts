// scripts/lib/privileged-env.ts — the privileged credentials in `$HOME/.env`
// and the `--confirm-target` check (decision D61).
//
// D61: "The `rm_owner` password and the `doadmin` password are lines in the
// host's `~/.env`, beside the runtime role passwords. Every command that
// prompted for them reads them from there." And: "The literal `y` becomes
// `--confirm-target <host:port/database>`. A command that writes refuses unless
// the flag names exactly the target it resolved from `~/.env`."
//
// THE ONE PLACE these two rules are implemented. Its callers:
//   - backend/scripts/migrate.ts and migrate-run.ts (`bun run migrate`),
//   - backend/scripts/smoke-prepare.ts (a remote `bun smoke --migrate/--seed`),
//   - backend/scripts/prune.ts (`bun run prune`),
//   - scripts/prod-init.ts (set-identity, provision-tokens, rebind-members,
//     enable-owner-login).
//
// WHAT IT NEVER DOES. It never prints, logs or returns a password inside a
// message. A refusal names the KEY and the FILE, never the value. It never
// reads a password from a prompt, a pipe, an environment variable or argv:
// the only source is the parsed `~/.env` its caller hands in.
//
// NOTHING IS NORMALIZED. The target a command resolves is the `host`, `port`
// and `database` (or `dbname`) tokens exactly as `~/.env` spells them, with
// port 5432 when the file has no `port` line (the same default
// env-role.ts urlForRole applies). The flag must equal that string byte for
// byte. A mismatch prints both.
//
// Side-effect free, like env-role.ts: no process.env, no file reads, no
// spawning. scripts/tests/unit/privileged-env.test.ts drives every branch.
import { databaseName } from "./env-role.ts";

/** The flag that replaces the interactive `y` on every remote write. */
export const CONFIRM_TARGET_FLAG = "--confirm-target";

/** The two privileged keys D61 moves into `~/.env`. */
export const PRIVILEGED_KEYS = ["rm_owner", "doadmin"] as const;
export type PrivilegedKey = (typeof PRIVILEGED_KEYS)[number];

/**
 * The target `~/.env` names, as `host:port/database`, exactly as the file
 * spells it. `undefined` when the file has no `host` or no database name.
 */
export function homeEnvTarget(env: Record<string, string | undefined>): string | undefined {
  const host = env.host;
  const database = databaseName(env);
  if (!host || !database) return undefined;
  return `${host}:${env.port || "5432"}/${database}`;
}

/**
 * The value of `--confirm-target` in `argv`, as `--confirm-target <v>` or
 * `--confirm-target=<v>`. `undefined` when the flag is absent. An empty value
 * or a value that is another flag is returned as `""`, which never equals a
 * target, so it refuses.
 */
export function confirmTargetFlag(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === CONFIRM_TARGET_FLAG) {
      const value = argv[i + 1];
      return value === undefined || value.startsWith("--") ? "" : value;
    }
    if (token.startsWith(`${CONFIRM_TARGET_FLAG}=`)) return token.slice(CONFIRM_TARGET_FLAG.length + 1);
  }
  return undefined;
}

/** `{ confirmTarget }` when argv carries the flag, else `{}`: the field a remote
 *  `bun smoke` preparation step hands its child (backend/scripts/smoke-prepare.ts). */
export function confirmTargetField(argv: readonly string[]): { confirmTarget?: string } {
  const value = confirmTargetFlag(argv);
  return value === undefined ? {} : { confirmTarget: value };
}

/** A refusal of the confirm-target check. The message never holds a secret. */
export class ConfirmTargetRefused extends Error {}

/**
 * Hold a write to the target it resolved. Refuses unless `flag` equals
 * `resolved` exactly. `action` names the write in the message
 * ("migrate", "prune", ...). The resolved target is printed in both refusals:
 * it is a host, a port and a database name, never a credential.
 */
export function requireConfirmTarget(flag: string | undefined, resolved: string, action: string): void {
  if (flag === undefined) {
    throw new ConfirmTargetRefused(
      `Refusing: ${action} writes the remote target ${resolved}, and no ${CONFIRM_TARGET_FLAG} was given. ` +
        `Pass ${CONFIRM_TARGET_FLAG} ${resolved} to confirm that target (decision D61). Nothing was changed.`,
    );
  }
  if (flag !== resolved) {
    throw new ConfirmTargetRefused(
      `Refusing: ${CONFIRM_TARGET_FLAG} does not name the target this run resolved from $HOME/.env. ` +
        `${CONFIRM_TARGET_FLAG}: ${JSON.stringify(flag)}. Resolved target: ${JSON.stringify(resolved)}. ` +
        "They must be equal exactly; nothing is normalized (decision D61). Nothing was changed.",
    );
  }
}

/** A refusal for a missing privileged line. The message never holds a secret. */
export class PrivilegedCredentialMissing extends Error {}

/**
 * The password on the `key = …` line of `~/.env`. Refuses, naming the key
 * and the file, when the file is absent or the line is missing or empty.
 */
export function requirePrivilegedPassword(
  env: Record<string, string | undefined> | undefined,
  key: PrivilegedKey,
  envFile: string,
): string {
  const value = env?.[key];
  if (value === undefined || value === "") {
    throw new PrivilegedCredentialMissing(
      `Refusing: ${envFile} has no ${key} line. ${key === "rm_owner" ? "The rm_owner password" : "The doadmin password"} ` +
        `is read from \`${key} = <password>\` in that file and nowhere else: never a prompt, a pipe, an environment ` +
        "variable or an argument (decision D61). Add the line and rerun. Nothing was changed.",
    );
  }
  return value;
}

/**
 * `bun smoke`'s early check for a remote `--migrate` or `--seed` (D61): both
 * write as rm_owner, so the boot needs `--confirm-target` naming exactly the
 * target `~/.env` resolves to, and `~/.env` needs its `rm_owner` line. Checked
 * before anything connects (scripts/lib/smoke-main.ts); the preparation child
 * checks both again before it writes (backend/scripts/smoke-prepare.ts).
 * Throws the refusal; returns nothing.
 */
export function requireRemoteOwnerPreparation(
  homeEnv: Record<string, string | undefined>,
  envFile: string,
  argv: readonly string[],
): void {
  const resolved = homeEnvTarget(homeEnv);
  if (resolved === undefined) throw new Error(`${envFile} names no host and database (spec §3).`);
  requireConfirmTarget(confirmTargetFlag(argv), resolved, "a remote --migrate or --seed");
  requirePrivilegedPassword(homeEnv, "rm_owner", envFile);
}

/**
 * Everything a remote write needs from `~/.env`, gathered once by the CLI and
 * handed to the command: the owner password (or its absence), the file it came
 * from, the `--confirm-target` flag, and the target the file resolves to.
 * Never logged and never written: a receipt records `resolvedTarget` only.
 */
export interface RemoteAuthority {
  readonly ownerPassword: string | undefined;
  readonly envFile: string;
  readonly confirmTarget: string | undefined;
  readonly resolvedTarget: string;
}
