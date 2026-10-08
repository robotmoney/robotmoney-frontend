#!/usr/bin/env bun
// scripts/release/host-guards.ts — release step R7.7, run ON THE TARGET HOST.
// Standing check SV.6.
//
//   bun scripts/release/host-guards.ts --instance <name> --receipt-dir <dir>
//
// The guards the 0.6 design added, checked on the live host:
//   1. no container of the instance's compose project mounts a Docker socket;
//   2. every `$HOME/.env` key is on the D61 allowlist (./env-keys.ts);
//   3. the three service-token files exist under the instance state
//      directory, mode 0600.
// Key names only, never a value. Writes host-guards.json to --receipt-dir.
import { spawnSync } from "node:child_process";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homeEnvFilePath, loadEnvFile } from "../lib/env-role.ts";
import { instancePaths, readStackState, stateRoot } from "../lib/smoke-state.ts";
import { D61_ENV_ALLOWLIST } from "./env-keys.ts";

interface InspectMount { Source?: string; Destination?: string }
interface Inspect { Name?: string; Mounts?: InspectMount[]; HostConfig?: { Binds?: string[] | null } }

/** PURE. Containers that mount a Docker socket, by name. */
export function socketMounts(inspected: readonly Inspect[]): string[] {
  const sock = (s: string | undefined) => s !== undefined && /docker\.sock$/.test(s);
  return inspected
    .filter((c) => (c.Mounts ?? []).some((m) => sock(m.Source) || sock(m.Destination)) || (c.HostConfig?.Binds ?? []).some((b) => b.split(":").some(sock)))
    .map((c) => (c.Name ?? "?").replace(/^\//, ""));
}

/** PURE. `~/.env` keys outside the allowlist. */
export function keysOutsideAllowlist(keys: readonly string[], allowlist: readonly string[] = D61_ENV_ALLOWLIST): string[] {
  return keys.filter((k) => !allowlist.includes(k));
}

/** PURE. Token files missing or not 0600. `mode` is null for a missing file. */
export function tokenFileProblems(files: readonly { path: string; mode: number | null }[]): string[] {
  return files.flatMap((f) =>
    f.mode === null ? [`${f.path} is missing`] : (f.mode & 0o777) !== 0o600 ? [`${f.path} is mode ${(f.mode & 0o777).toString(8)}, not 600`] : [],
  );
}

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

function main(): number {
  const instance = flag("--instance");
  const receiptDir = flag("--receipt-dir");
  if (!instance || !receiptDir) {
    console.error("usage: bun scripts/release/host-guards.ts --instance <name> --receipt-dir <dir>");
    return 2;
  }
  const problems: string[] = [];
  const paths = instancePaths(stateRoot(process.env), instance);
  const record = readStackState(paths);

  let containers: string[] = [];
  let mounting: string[] = [];
  if (record === null) problems.push(`instance ${instance} has no stack record`);
  else {
    const ps = spawnSync("docker", ["ps", "-a", "-q", "--filter", `label=com.docker.compose.project=${record.project}`], { encoding: "utf8" });
    containers = ps.status === 0 ? ps.stdout.split("\n").map((l) => l.trim()).filter(Boolean) : [];
    if (ps.status !== 0) problems.push("docker ps failed");
    else if (containers.length === 0) problems.push(`compose project ${record.project} has no containers`);
    else {
      const insp = spawnSync("docker", ["inspect", ...containers], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
      if (insp.status !== 0) problems.push("docker inspect failed");
      else {
        mounting = socketMounts(JSON.parse(insp.stdout) as Inspect[]);
        if (mounting.length > 0) problems.push(`containers mount a Docker socket: ${mounting.join(", ")}`);
      }
    }
  }

  const envPath = homeEnvFilePath(process.env.HOME);
  const env = loadEnvFile(envPath);
  const keys = env ? Object.keys(env).sort() : [];
  if (!env) problems.push(`${envPath} cannot be read`);
  const outside = keysOutsideAllowlist(keys);
  if (outside.length > 0) problems.push(`${envPath} holds keys outside the D61 allowlist: ${outside.join(", ")}`);

  const tokenFiles = Object.values(paths.tokenFiles).map((path) => {
    try { return { path, mode: statSync(path).mode }; } catch { return { path, mode: null }; }
  });
  problems.push(...tokenFileProblems(tokenFiles));

  mkdirSync(receiptDir, { recursive: true, mode: 0o700 });
  const file = join(receiptDir, "host-guards.json");
  writeFileSync(file, `${JSON.stringify({
    step: "R7.7", instance, project: record?.project ?? null, containers: containers.length, socketMounts: mounting,
    envKeys: keys, keysOutsideAllowlist: outside,
    tokenFiles: tokenFiles.map((t) => ({ path: t.path, mode: t.mode === null ? null : (t.mode & 0o777).toString(8) })),
    problems, at: new Date().toISOString(),
  }, null, 2)}\n`, { mode: 0o600 });
  console.log(`[host-guards] ${containers.length} container(s), ${mounting.length} with a Docker socket; ${keys.length} ~/.env key(s), ${outside.length} outside the allowlist`);
  console.log(`[host-guards] receipt: ${file}`);
  for (const p of problems) console.error(`[host-guards] FAIL: ${p}`);
  return problems.length === 0 ? 0 : 1;
}

if (import.meta.main) process.exitCode = main();
