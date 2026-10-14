#!/usr/bin/env bun
// scripts/release/host-identity.ts — release step R1.2 / R1.5, run ON A HOST.
//
//   bun scripts/release/host-identity.ts --commit <sha> [--confirm-target host:port/db] [--origin <url>] --receipt-dir <dir>
//
// Proves the checkout this runs from is the release: HEAD equals --commit and
// `git status --porcelain` is empty (policy 4.6: a host runs a clean checkout
// of a pushed commit). Checks that bun, docker and tmux are on PATH. With
// --confirm-target, resolves `host:port/database` from `$HOME/.env` and
// refuses unless it equals the flag: the run's confirmTarget is the database
// this host actually names, before any write is attempted. Then it checks the
// target precondition (./precondition.ts), read-only through `rm_readonly`:
// the database answers, its ledger reconciles with backend/migrations and the
// bytes at the tag the running stack reports at `--origin`/api/version
// (./ledger.ts, D67), and its deployment_identity is absent or the kind `--policy`
// implies. A running stack that reports no version refuses: there is nothing
// to pin the applied bytes to, and nothing is assumed in its place.
//
// With --confirm-target it also proves what the cutover needs later, before
// R6.1 stops the running stack (the run's first irreversible step):
//   - `~/.env` holds non-empty `rm_owner` and `RM_CREDENTIALS` lines
//     (./env-keys.ts PRE_CUTOVER_REQUIRED_KEYS). R6.2 checks them again.
//   - rm_owner logs in: `SELECT 1`, read-only, through the registry's
//     object-less `connectionCheck` shape declared as rm_owner in
//     backend/scripts/owner-login-check.ts (proveOwnerLogin).
// A failure refuses with "rm_owner cannot log in; run `bun run
// role-passwords --target <target>` first". No release step reads or uses
// `doadmin` (D61 amendment, owner, 2026-10-08).
//
// Writes host-identity.json to --receipt-dir. Prints key names, never values.
// Runs before `bun install`, so it imports only node built-ins and local
// modules with no package import (the registry imports `postgres` as a type
// only; proveOwnerLogin connects through Bun's built-in client).
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { join } from "node:path";
import { proveOwnerLogin } from "../../backend/scripts/owner-login-check.ts";
import { homeEnvFilePath, loadEnvFile, urlForRole } from "../lib/env-role.ts";
import { openReadOnly } from "./db-read.ts";
import { confirmTargetOf, preCutoverKeyProblems } from "./env-keys.ts";
import { readRunningVersion, reconcileLedger, runningPinRef, type ReconcileReceipt } from "./ledger.ts";
import { preconditionProblems } from "./precondition.ts";

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

const sh = (cmd: string, args: string[]) => spawnSync(cmd, args, { encoding: "utf8" });

async function main(): Promise<number> {
  const commit = flag("--commit");
  const confirm = flag("--confirm-target");
  const origin = flag("--origin");
  const receiptDir = flag("--receipt-dir");
  // The target's policy, from the release step's own argv (D69 part 4); the capture host passes none.
  const policy = flag("--policy");
  if (!commit || !/^[0-9a-f]{40}$/.test(commit) || !receiptDir) {
    console.error("usage: bun scripts/release/host-identity.ts [--policy <prod|stage>] --commit <40-hex sha> [--confirm-target host:port/db] [--origin <url>] --receipt-dir <dir>");
    return 2;
  }
  const problems: string[] = [];
  const head = sh("git", ["rev-parse", "HEAD"]).stdout.trim();
  if (head !== commit) problems.push(`HEAD is ${head || "(unreadable)"}, expected ${commit}`);
  const porcelain = sh("git", ["status", "--porcelain"]);
  if (porcelain.status !== 0) problems.push("git status failed");
  else if (porcelain.stdout.trim() !== "") problems.push(`the checkout is not clean:\n${porcelain.stdout.trimEnd()}`);
  const tools: Record<string, string> = {};
  for (const [tool, args] of [["bun", ["--version"]], ["docker", ["--version"]], ["tmux", ["-V"]], ["git", ["--version"]]] as const) {
    const r = sh(tool, [...args]);
    if (r.status !== 0) problems.push(`${tool} is not on PATH for a non-interactive ssh command`);
    else tools[tool] = r.stdout.trim();
  }
  // The runner starts every command under `env -i` with one fixed PATH (steps.ts REMOTE_PATH); record where each tool resolved.
  const toolPaths = sh("sh", ["-c", "for t in bun docker tmux git; do printf '%s=%s\\n' \"$t\" \"$(command -v $t)\"; done"]).stdout.trim().split("\n");
  const inherited = Object.keys(process.env).filter((k) => k.startsWith("DATABASE_"));
  if (inherited.length > 0) problems.push(`the command inherited ${inherited.join(", ")}: it did not start under env -i`);
  let resolvedTarget: string | undefined;
  const envPath = homeEnvFilePath(process.env.HOME);
  const env = loadEnvFile(envPath);
  if (confirm !== undefined) {
    if (env === undefined) problems.push(`${envPath} cannot be read`);
    else {
      resolvedTarget = confirmTargetOf(env);
      if (resolvedTarget === undefined) problems.push(`${envPath} names no host and database`);
      else if (resolvedTarget !== confirm) problems.push(`${envPath} names ${resolvedTarget}; the target file confirms ${confirm}`);
      problems.push(...preCutoverKeyProblems(env, envPath));
    }
  }
  let precondition: { ledgerCount: number; identity: string | null; running: { origin: string; pinRef: string } | null; reconcile: ReconcileReceipt; problems: string[] } | null = null;
  if (confirm !== undefined && resolvedTarget !== undefined && resolvedTarget === confirm) {
    // The pin ref (D67): the tag the running stack reports, else its commit.
    // Read before the database, so a stack that reports nothing refuses by name.
    let running: { origin: string; pinRef: string } | null = null;
    if (origin === undefined) problems.push("target precondition: no --origin was given, so the running stack's version cannot pin the applied migration bytes");
    else {
      const version = await readRunningVersion(origin);
      if ("error" in version) problems.push(`target precondition: the running stack at ${origin} reports no version to pin the applied migration bytes to (${version.error})`);
      else running = { origin, pinRef: runningPinRef(version) };
    }
    try {
      const db = await openReadOnly();
      try {
        const ledger = (await db.query<{ name: string }>(`SELECT name FROM schema_migrations ORDER BY name COLLATE "C"`)).map((r) => r.name);
        const table = (await db.query<{ t: string | null }>("SELECT to_regclass('public.deployment_identity')::text AS t"))[0]?.t ?? null;
        const identity = table ? (await db.query<{ kind: string }>("SELECT kind FROM deployment_identity"))[0]?.kind ?? null : null;
        const reconcile = reconcileLedger(ledger, running ? { pinRef: running.pinRef } : {});
        const found = preconditionProblems({ rmEnv: policy, ledger, identity, reconcile });
        precondition = { ledgerCount: ledger.length, identity, running, reconcile, problems: found };
        problems.push(...found.map((p) => `target precondition: ${p}`));
      } finally {
        await db.close();
      }
    } catch (error) {
      problems.push(`target precondition: the database ${resolvedTarget} cannot be read as rm_readonly (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  // The rm_owner login proof, read-only. Only on the target ~/.env names, and
  // only with an rm_owner line (its absence is already a problem above).
  let ownerLogin: "proven" | "failed" | "not-tried" = "not-tried";
  const ownerUrl = env ? urlForRole(env, "rm_owner") : undefined;
  if (confirm !== undefined && resolvedTarget !== undefined && resolvedTarget === confirm && ownerUrl !== undefined) {
    try {
      await proveOwnerLogin(ownerUrl, policy === "prod" || policy === "stage" ? policy : "<target>");
      ownerLogin = "proven";
    } catch (error) {
      ownerLogin = "failed";
      problems.push(`rm_owner login: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const receipt = {
    step: "host-identity",
    host: hostname(),
    user: userInfo().username,
    home: process.env.HOME,
    rmEnv: policy ?? null,
    commit: head,
    expectedCommit: commit,
    clean: porcelain.status === 0 && porcelain.stdout.trim() === "",
    tools,
    path: process.env.PATH ?? null,
    toolPaths,
    inheritedDatabaseEnv: inherited,
    envFile: envPath,
    envKeys: env ? Object.keys(env).sort() : null,
    resolvedTarget: resolvedTarget ?? null,
    confirmTarget: confirm ?? null,
    precondition,
    ownerLogin,
    problems,
    at: new Date().toISOString(),
  };
  mkdirSync(receiptDir, { recursive: true, mode: 0o700 });
  const file = join(receiptDir, "host-identity.json");
  writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  console.log(`[host-identity] ${hostname()} HEAD ${head}${resolvedTarget ? `, ~/.env names ${resolvedTarget}` : ""}`);
  if (precondition) console.log(`[host-identity] target: ledger ${precondition.ledgerCount} names, identity ${precondition.identity ?? "absent"}`);
  if (ownerLogin === "proven") console.log("[host-identity] rm_owner: login proven (SELECT 1, read-only)");
  console.log(`[host-identity] receipt: ${file}`);
  for (const p of problems) console.error(`[host-identity] REFUSE: ${p}`);
  return problems.length === 0 ? 0 : 1;
}

process.exitCode = await main();
