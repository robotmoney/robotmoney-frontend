#!/usr/bin/env bun
// scripts/release/env-rewrite.ts — release step R6.2, run ON THE TARGET HOST.
//
//   bun scripts/release/env-rewrite.ts --run <run-ts> --receipt-dir <dir>
//
// Brings `$HOME/.env` to the D61 allowlist (./env-keys.ts). Every line whose
// key is outside the list moves, unchanged, to `$HOME/.env.retired-<run-ts>`
// (mode 0600, created exclusively, never overwritten); the rest stays, in
// order, comments included. Moving aside rather than deleting is runbook
// R6.2's rule. It refuses, changing nothing, when `doadmin` or
// `RM_CREDENTIALS` is missing: the cutover's writes would stop halfway. It
// does not require `rm_owner`: R6.2b runs after it and generates that line
// when it is absent. An existing `rm_owner` line is on the allowlist, so it
// stays, and a line R6.2b writes later is never retired.
//
// A second run with nothing to retire changes nothing, so a resumed run
// passes. It prints and records key NAMES only, never a value.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homeEnvFilePath } from "../lib/env-role.ts";
import { D61_ENV_ALLOWLIST, D61_REQUIRED_KEYS } from "./env-keys.ts";

export interface EnvPartition {
  /** The lines that stay, in order, comments and blanks included. */
  readonly keptText: string;
  /** The lines that move, in order. */
  readonly retiredText: string;
  readonly keptKeys: readonly string[];
  /** Keys moved aside; a line with no key is reported as `(line N)`. */
  readonly retiredKeys: readonly string[];
  readonly missingRequired: readonly string[];
}

/** The key of a `.env` line as env-role.ts parses it; null for a comment or blank; "" for a line with no `=`. */
export function lineKey(line: string): string | null {
  const t = line.trim();
  if (t === "" || t.startsWith("#")) return null;
  const eq = t.indexOf("=");
  if (eq < 0) return "";
  return t.slice(0, eq).replace(/^export\s+/, "").trim();
}

/** PURE. Split a `.env` text by the allowlist. */
export function partitionEnv(
  text: string,
  allowlist: readonly string[] = D61_ENV_ALLOWLIST,
  required: readonly string[] = D61_REQUIRED_KEYS,
): EnvPartition {
  const kept: string[] = [];
  const retired: string[] = [];
  const keptKeys: string[] = [];
  const retiredKeys: string[] = [];
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  lines.forEach((line, i) => {
    const key = lineKey(line);
    if (key === null) kept.push(line);
    else if (key !== "" && allowlist.includes(key)) {
      kept.push(line);
      keptKeys.push(key);
    } else {
      retired.push(line);
      retiredKeys.push(key === "" ? `(line ${i + 1})` : key);
    }
  });
  const missingRequired = required.filter((k) => !keptKeys.includes(k));
  const asText = (xs: string[]) => (xs.length > 0 ? `${xs.join("\n")}\n` : "");
  return { keptText: asText(kept), retiredText: asText(retired), keptKeys, retiredKeys, missingRequired };
}

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

function main(): number {
  const run = flag("--run");
  const receiptDir = flag("--receipt-dir");
  if (!run || !/^\d{8}T\d{6}Z$/.test(run) || !receiptDir) {
    console.error("usage: bun scripts/release/env-rewrite.ts --run <run-ts> --receipt-dir <dir>");
    return 2;
  }
  const envPath = homeEnvFilePath(process.env.HOME);
  if (!existsSync(envPath)) {
    console.error(`[env-rewrite] REFUSE: ${envPath} does not exist.`);
    return 1;
  }
  const part = partitionEnv(readFileSync(envPath, "utf8"));
  if (part.missingRequired.length > 0) {
    console.error(`[env-rewrite] REFUSE: ${envPath} lacks ${part.missingRequired.join(", ")} (D61: the privileged credentials live in the host's ~/.env). Nothing changed.`);
    return 1;
  }
  let retiredFile: string | null = null;
  if (part.retiredKeys.length > 0) {
    retiredFile = `${envPath}.retired-${run}`;
    try {
      writeFileSync(retiredFile, part.retiredText, { mode: 0o600, flag: "wx" });
    } catch (error) {
      console.error(`[env-rewrite] REFUSE: cannot create ${retiredFile} (${error instanceof Error ? error.message : String(error)}). Nothing changed.`);
      return 1;
    }
    chmodSync(retiredFile, 0o600);
    const tmp = `${envPath}.rewrite-${process.pid}`;
    writeFileSync(tmp, part.keptText, { mode: 0o600 });
    renameSync(tmp, envPath);
  }
  const receipt = {
    step: "env-rewrite",
    envFile: envPath,
    keptKeys: part.keptKeys,
    retiredKeys: part.retiredKeys,
    retiredFile,
    allowlist: D61_ENV_ALLOWLIST,
    at: new Date().toISOString(),
  };
  mkdirSync(receiptDir, { recursive: true, mode: 0o700 });
  const file = join(receiptDir, "env-rewrite.json");
  writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  console.log(`[env-rewrite] kept: ${part.keptKeys.join(", ")}`);
  console.log(`[env-rewrite] ${retiredFile ? `moved to ${retiredFile}: ${part.retiredKeys.join(", ")}` : "nothing to move"}`);
  console.log(`[env-rewrite] receipt: ${file}`);
  return 0;
}

if (import.meta.main) process.exitCode = main();
