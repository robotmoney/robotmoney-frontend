#!/usr/bin/env bun
// scripts/release/host-identity.ts — release step R1.2 / R1.5, run ON A HOST.
//
//   bun scripts/release/host-identity.ts --commit <sha> [--confirm-target host:port/db] --receipt-dir <dir>
//
// Proves the checkout this runs from is the release: HEAD equals --commit and
// `git status --porcelain` is empty (policy 4.6: a host runs a clean checkout
// of a pushed commit). Checks that bun, docker and tmux are on PATH. With
// --confirm-target, resolves `host:port/database` from `$HOME/.env` and
// refuses unless it equals the flag: the run's confirmTarget is the database
// this host actually names, before any write is attempted.
//
// Writes host-identity.json to --receipt-dir. Prints key names, never values.
// Runs before `bun install`, so it imports only node built-ins and env-role.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { join } from "node:path";
import { homeEnvFilePath, loadEnvFile } from "../lib/env-role.ts";
import { confirmTargetOf } from "./env-keys.ts";

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

const sh = (cmd: string, args: string[]) => spawnSync(cmd, args, { encoding: "utf8" });

function main(): number {
  const commit = flag("--commit");
  const confirm = flag("--confirm-target");
  const receiptDir = flag("--receipt-dir");
  if (!commit || !/^[0-9a-f]{40}$/.test(commit) || !receiptDir) {
    console.error("usage: bun scripts/release/host-identity.ts --commit <40-hex sha> [--confirm-target host:port/db] --receipt-dir <dir>");
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
  let resolvedTarget: string | undefined;
  const envPath = homeEnvFilePath(process.env.HOME);
  const env = loadEnvFile(envPath);
  if (confirm !== undefined) {
    if (env === undefined) problems.push(`${envPath} cannot be read`);
    else {
      resolvedTarget = confirmTargetOf(env);
      if (resolvedTarget === undefined) problems.push(`${envPath} names no host and database`);
      else if (resolvedTarget !== confirm) problems.push(`${envPath} names ${resolvedTarget}; the target file confirms ${confirm}`);
    }
  }
  const receipt = {
    step: "host-identity",
    host: hostname(),
    user: userInfo().username,
    home: process.env.HOME,
    rmEnv: process.env.RM_ENV ?? null,
    commit: head,
    expectedCommit: commit,
    clean: porcelain.status === 0 && porcelain.stdout.trim() === "",
    tools,
    envFile: envPath,
    envKeys: env ? Object.keys(env).sort() : null,
    resolvedTarget: resolvedTarget ?? null,
    confirmTarget: confirm ?? null,
    problems,
    at: new Date().toISOString(),
  };
  mkdirSync(receiptDir, { recursive: true, mode: 0o700 });
  const file = join(receiptDir, "host-identity.json");
  writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  console.log(`[host-identity] ${hostname()} HEAD ${head}${resolvedTarget ? `, ~/.env names ${resolvedTarget}` : ""}`);
  console.log(`[host-identity] receipt: ${file}`);
  for (const p of problems) console.error(`[host-identity] REFUSE: ${p}`);
  return problems.length === 0 ? 0 : 1;
}

process.exitCode = main();
