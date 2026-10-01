// The instance's three SERVICE-TOKEN FILES, as `bun smoke` handles them —
// smoke-production-spec.md §3 and §5, criteria 31, 43 and 96.
//
// §3: each service token is "a file the boot places in the instance's state
// directory, named per instance and per holder, never in `~/.env` and never in
// an image". The files are `tokens/<holder>/token` (smoke-state.ts
// `InstancePaths.tokenFiles`), mode 0600 inside 0700 holder directories; each
// container mounts only its own holder's directory. The database holds each
// token's hash and rights and nothing else, so a file by itself grants nothing.
//
// WHO WRITES THEM. Exactly one module: backend/scripts/provision-tokens.ts,
// inside one fenced rm_owner transaction. This file only decides WHEN a boot
// may run it, and runs it:
//
//   --local blank | dump   provisioned unattended by the journaled `prepare
//                          (tokens)` step (§5), once per plan: a rerun of the
//                          same plan id finds the step committed and reuses the
//                          files rather than rotating them (§1.3).
//   --local volume         reuses the files the instance saved (§5). None to
//                          reuse is a refusal, never a mint: the volume's rows
//                          belong to the files that were lost.
//   remote                 NEVER provisioned by a boot (§5: "A remote rehearsal
//                          target uses tokens provisioned for that enrolled
//                          target by the same procedure, run explicitly";
//                          criterion 43). Absent files refuse, naming the
//                          command, before anything is mutated.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { LockHolder } from "../../backend/src/db/target-lock.ts";
import { SERVICE_TOKEN_HOLDERS, type InstancePaths, type ServiceTokenHolder } from "./smoke-state.ts";

/** The explicit provisioning command production and a remote rehearsal target run (§9.1 step 5). */
export const PROVISION_TOKENS_COMMAND = "bun scripts/prod-init.ts provision-tokens";

/** The holders whose token file is missing or empty. */
export function missingTokenFiles(paths: InstancePaths): ServiceTokenHolder[] {
  return SERVICE_TOKEN_HOLDERS.filter((holder) => {
    const file = paths.tokenFiles[holder];
    if (!existsSync(file) || !statSync(file).isFile()) return true;
    return readFileSync(file, "utf8").trim() === "";
  });
}

/**
 * The refusal for a boot that may not mint tokens and finds some missing, or
 * null when all three are present.
 *
 * `remote`: the tokens of a remote target come only from the explicit command.
 * `volume`: the reattached volume's rows belong to the saved files.
 */
export function tokenReuseRefusal(paths: InstancePaths, kind: "remote" | "volume"): string | null {
  const missing = missingTokenFiles(paths);
  if (missing.length === 0) return null;
  const files = missing.map((holder) => paths.tokenFiles[holder]).join(", ");
  if (kind === "remote") {
    return (
      `the remote target's service tokens are not provisioned for instance ${paths.dir}: missing ${files}. ` +
      `A boot never provisions a remote target's tokens (smoke spec §5); run \`${PROVISION_TOKENS_COMMAND}\` ` +
      "against the enrolled target first, then boot again."
    );
  }
  return (
    `\`--local volume\` reuses the instance's saved service tokens, and ${files} ${missing.length === 1 ? "is" : "are"} missing. ` +
    "The volume's token rows belong to the files that were lost; boot a fresh instance with `--local blank` or `--local dump`."
  );
}

/** One holder's token, read from its file. Refuses, naming the file, when it is missing or empty. */
export function readServiceToken(paths: InstancePaths, holder: ServiceTokenHolder): string {
  const file = paths.tokenFiles[holder];
  let token = "";
  try {
    token = readFileSync(file, "utf8").trim();
  } catch {
    throw new Error(`the ${holder} service token file ${file} is missing; \`bun smoke --local blank|dump\` or \`${PROVISION_TOKENS_COMMAND}\` provisions it`);
  }
  if (!token) throw new Error(`the ${holder} service token file ${file} is empty`);
  return token;
}

/** What the `prepare (tokens)` step hands backend/scripts/provision-tokens.ts. No secret travels in it. */
export interface TokenProvisionStep {
  readonly instance: string;
  readonly stateRoot: string;
  readonly target: { readonly host: string; readonly port: number; readonly database: string; readonly sslmode: string };
  readonly lock: { readonly backendPid: number; readonly holder: LockHolder };
  readonly stateDir: string;
}

/**
 * Run the provisioning entry module in its own host process, under the boot's
 * target lock, and return its outcome. The child reads rm_owner from the
 * instance's generated role passwords and writes each holder's file itself; the
 * result file carries holders and paths, never a secret.
 */
export async function runTokenProvisioning(
  repoRoot: string,
  step: TokenProvisionStep,
  env: Record<string, string>,
): Promise<{ ok: true; holders: string[] } | { ok: false; error: string }> {
  const resultFile = join(step.stateDir, `prepare-tokens-${process.pid}.json`);
  rmSync(resultFile, { force: true });
  const request = { instance: step.instance, stateRoot: step.stateRoot, target: step.target, credentials: { source: "instance" }, lock: step.lock, resultFile };
  const child = spawn("bun", ["--no-env-file", join(repoRoot, "backend", "scripts", "provision-tokens.ts")], {
    cwd: join(repoRoot, "backend"),
    env: { ...env, RM_PROVISION_REQUEST: JSON.stringify(request) },
    stdio: "inherit",
  });
  const code = await new Promise<number>((resolve) => child.on("exit", (c, signal) => resolve(c ?? (signal ? 128 : 1))));
  let parsed: { ok: boolean; holders?: string[]; error?: string } | null = null;
  try {
    parsed = JSON.parse(readFileSync(resultFile, "utf8"));
  } catch {
    parsed = null;
  } finally {
    rmSync(resultFile, { force: true });
  }
  if (parsed?.ok === true && code === 0) return { ok: true, holders: parsed.holders ?? [] };
  return { ok: false, error: parsed?.error ?? `token provisioning exited ${code} without a result` };
}
