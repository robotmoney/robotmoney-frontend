#!/usr/bin/env bun
// scripts/release/stop-legacy.ts — release steps R6.1 and S8.1, run ON THE TARGET HOST.
//
//   bun scripts/release/stop-legacy.ts stop --instance <name> --legacy-checkout <dir> --receipt-dir <dir>
//   bun scripts/release/stop-legacy.ts retire --legacy-checkout <dir> --version <vX.Y.Z> --run <run-ts> --receipt-dir <dir>
//
// The "legacy" stack is the previous release's: since D63 (owner, 2026-10-09) a
// release upgrades a running v0.6.0 stack, which `bun smoke` started and left
// running in Docker (there is no tmux driver).
//
// stop (R6.1, IRREVERSIBLE: the stack is down from here until R6.9). Reads the
// instance's stack record (`<state dir>/stack-state.json`, written by the boot)
// for its compose project, then runs `bun run smoke:down --instance <name>`
// from the legacy checkout: the previous release's own tool stops the stack it
// started, without `-v`, so the volumes stay and the stack record is kept
// (spec §1). Then it proves no container of that project remains. A stack
// already stopped is recorded, not refused, so a resumed run passes.
//
// retire (runbook section 8, after R6.3). Renames the old checkout to
// `<dir>.<version>-retired`, so the old `bun run migrate` cannot run against
// the migrated database (B13). Already renamed is recorded, not refused.
// Then it removes group and world access from the whole retired checkout, and
// moves the retired checkout's `.env` secret lines (database URLs with
// a password, model and admin keys) to `$HOME/.env.legacy-retired-<run-ts>`
// (mode 0600) and makes that `.env` 0600: D61 keeps doadmin in `~/.env` only.
// It prints key names, never values.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lineKey } from "./env-rewrite.ts";

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

/** PURE. The argv that stops the previous release's stack: its own `smoke:down`, never `-v`. */
export function smokeDownArgv(instance: string): string[] {
  return ["bun", "run", "smoke:down", "--instance", instance];
}

/** PURE. The compose project the instance's stack record names, or null when it is unreadable. */
export function projectOfStackRecord(text: string): string | null {
  try {
    const record = JSON.parse(text) as { project?: unknown };
    return typeof record.project === "string" && /^[a-z0-9][a-z0-9_-]*$/.test(record.project) ? record.project : null;
  } catch {
    return null;
  }
}

/** PURE. The retired path of a legacy checkout. */
export function retiredPath(checkout: string, version: string): string {
  return `${checkout.replace(/\/+$/, "")}.${version}-retired`;
}

const run = (cmd: string, args: string[], cwd?: string) => spawnSync(cmd, args, { encoding: "utf8", cwd });

function projectContainers(project: string): string[] | null {
  const r = run("docker", ["ps", "-a", "--filter", `label=com.docker.compose.project=${project}`, "--format", "{{.Names}}"]);
  if (r.status !== 0) return null;
  return r.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
}

function writeReceipt(dir: string, name: string, body: object): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, name);
  writeFileSync(file, `${JSON.stringify({ ...body, at: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
  return file;
}

function stop(): number {
  const instance = flag("--instance");
  const checkout = flag("--legacy-checkout");
  const receiptDir = flag("--receipt-dir");
  if (!instance || !/^[a-z0-9][a-z0-9_-]*$/.test(instance) || !checkout || !receiptDir) {
    console.error("usage: stop-legacy.ts stop --instance NAME --legacy-checkout DIR --receipt-dir DIR");
    return 2;
  }
  const problems: string[] = [];

  // 1. The stack record names the compose project; read it before smoke:down.
  const recordFile = join(process.env.HOME ?? "/root", ".local", "state", "robotmoney-smoke", instance, "stack-state.json");
  const project = existsSync(recordFile) ? projectOfStackRecord(readFileSync(recordFile, "utf8")) : null;
  if (project === null) problems.push(`${recordFile} is missing or names no compose project: the stack to stop cannot be identified`);
  console.log(`[stop-legacy] instance ${instance}: compose project ${project ?? "(unknown)"}`);

  // 2. The previous release's own tool stops the stack it started, keeping its volumes.
  const before = project === null ? null : projectContainers(project);
  if (project !== null && before === null) problems.push("docker ps failed");
  let down = "nothing to stop";
  if (project !== null && before !== null && before.length > 0) {
    if (!existsSync(checkout)) problems.push(`the legacy checkout ${checkout} is missing; cannot run smoke:down from it`);
    else {
      const argv = smokeDownArgv(instance);
      console.log(`[stop-legacy] (cd ${checkout} && ${argv.join(" ")})`);
      const r = run(argv[0]!, argv.slice(1), checkout);
      process.stdout.write(r.stdout ?? "");
      process.stderr.write(r.stderr ?? "");
      down = r.status === 0 ? "down" : `failed (exit ${r.status})`;
      if (r.status !== 0) problems.push(`smoke:down exited ${r.status}`);
    }
  }

  // 3. Proof.
  const after = project === null ? null : projectContainers(project);
  if (project !== null) {
    if (after === null) problems.push("docker ps failed after smoke:down");
    else if (after.length > 0) problems.push(`containers remain: ${after.join(", ")}`);
  }

  const file = writeReceipt(receiptDir, "stop-legacy.json", {
    step: "stop-legacy", instance, project, checkout, containersBefore: before, smokeDown: down, containersAfter: after, problems,
  });
  console.log(`[stop-legacy] receipt: ${file}`);
  for (const p of problems) console.error(`[stop-legacy] FAIL: ${p}`);
  return problems.length === 0 ? 0 : 1;
}

/** Keys in the legacy checkout's `.env` that carry a secret, whatever their value looks like. */
export const LEGACY_SECRET_KEYS: readonly string[] = Object.freeze([
  "MIGRATE_DATABASE_URL", "WORKER_DATABASE_URL", "DATABASE_URL", "OPENCODE_API_KEY", "ADMIN_TOKEN", "COINGECKO_API_KEY",
]);

/** A postgres URL that carries a password. */
export const POSTGRES_URL_WITH_PASSWORD = /postgres(?:ql)?:\/\/[^:\s\/@]+:[^@\s]+@/i;

/**
 * PURE. Split the legacy checkout's `.env`: lines whose key is a known secret,
 * or whose value is a postgres URL with a password, move; the rest stay.
 */
export function partitionLegacyEnv(text: string): { kept: string; moved: string; movedKeys: string[] } {
  const kept: string[] = [];
  const moved: string[] = [];
  const movedKeys: string[] = [];
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  for (const line of lines) {
    const key = lineKey(line);
    const secret = key !== null && (LEGACY_SECRET_KEYS.includes(key) || POSTGRES_URL_WITH_PASSWORD.test(line));
    if (secret) { moved.push(line); movedKeys.push(key === "" ? "(no key)" : key); } else kept.push(line);
  }
  const asText = (xs: string[]) => (xs.length > 0 ? `${xs.join("\n")}\n` : "");
  return { kept: asText(kept), moved: asText(moved), movedKeys };
}

/** Move the retired checkout's `.env` secrets to `$HOME/.env.legacy-retired-<run>` (0600) and make the `.env` 0600. */
function cleanLegacyEnv(retired: string, run: string): { file: string | null; movedKeys: string[]; movedTo: string | null; problem?: string } {
  const envFile = join(retired, ".env");
  if (!existsSync(envFile)) return { file: null, movedKeys: [], movedTo: null };
  const part = partitionLegacyEnv(readFileSync(envFile, "utf8"));
  let movedTo: string | null = null;
  if (part.movedKeys.length > 0) {
    movedTo = join(process.env.HOME ?? "/root", `.env.legacy-retired-${run}`);
    try {
      writeFileSync(movedTo, part.moved, { mode: 0o600, flag: "wx" });
    } catch (error) {
      return { file: envFile, movedKeys: part.movedKeys, movedTo, problem: `cannot create ${movedTo}: ${error instanceof Error ? error.message : String(error)}` };
    }
    chmodSync(movedTo, 0o600);
    writeFileSync(envFile, part.kept, { mode: 0o600 });
  }
  chmodSync(envFile, 0o600);
  return { file: envFile, movedKeys: part.movedKeys, movedTo };
}

function retire(): number {
  const checkout = flag("--legacy-checkout");
  const version = flag("--version");
  const run = flag("--run");
  const receiptDir = flag("--receipt-dir");
  if (!checkout || !version || !/^v\d+\.\d+\.\d+$/.test(version) || !run || !/^\d{8}T\d{6}Z$/.test(run) || !receiptDir) {
    console.error("usage: stop-legacy.ts retire --legacy-checkout DIR --version vX.Y.Z --run <run-ts> --receipt-dir DIR");
    return 2;
  }
  const dest = retiredPath(checkout, version);
  const src = existsSync(checkout);
  const dst = existsSync(dest);
  let outcome: string;
  let code = 0;
  if (src && !dst) {
    renameSync(checkout, dest);
    outcome = "renamed";
  } else if (!src && dst) {
    outcome = "already retired";
  } else if (src && dst) {
    outcome = `refused: both ${checkout} and ${dest} exist`;
    code = 1;
  } else {
    outcome = `refused: neither ${checkout} nor ${dest} exists`;
    code = 1;
  }
  // D61: doadmin lives only in ~/.env. The old checkout's .env (0644 on prod)
  // held MIGRATE_DATABASE_URL as doadmin; its secret lines leave it now.
  const env = code === 0 ? cleanLegacyEnv(dest, run) : { file: null, movedKeys: [], movedTo: null };
  if ("problem" in env && env.problem) code = 1;
  // The retired checkout keeps the old stack's state, logs and compose overlays,
  // which name the database with its password. Nobody but the owner reads it now.
  let lockedDown = false;
  if (code === 0) {
    const r = spawnSync("chmod", ["-R", "go-rwx", dest], { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" });
    lockedDown = r.status === 0;
    if (!lockedDown) code = 1;
  }
  const file = writeReceipt(receiptDir, "retire-legacy.json", {
    step: "retire-legacy", checkout, retiredAs: dest, outcome, lockedDown, legacyEnv: env.file, movedKeys: env.movedKeys, movedTo: env.movedTo,
    problem: "problem" in env ? env.problem ?? null : null,
  });
  (code === 0 ? console.log : console.error)(`[stop-legacy] ${checkout} → ${dest}: ${outcome}`);
  if (env.file) console.log(`[stop-legacy] ${env.file}: ${env.movedKeys.length ? `moved ${env.movedKeys.join(", ")} to ${env.movedTo}` : "no secret line"}; mode 0600`);
  if ("problem" in env && env.problem) console.error(`[stop-legacy] FAIL: ${env.problem}`);
  console.log(`[stop-legacy] receipt: ${file}`);
  return code;
}

if (import.meta.main) {
  const sub = process.argv[2];
  process.exitCode = sub === "stop" ? stop() : sub === "retire" ? retire() : (console.error("usage: stop-legacy.ts <stop|retire> …"), 2);
}
