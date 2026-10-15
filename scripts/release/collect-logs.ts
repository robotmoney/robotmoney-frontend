#!/usr/bin/env bun
// scripts/release/collect-logs.ts — release step S08-soak-checks, run ON THE TARGET HOST:
// every container's logs since READY, and its `docker inspect`, into the run's
// receipt directory, so the control journal holds the soak's whole evidence
// (owner, 2026-10-14: a short soak that collects more logs).
//
//   bun scripts/release/collect-logs.ts --instance <name> --since <iso> --receipt-dir <dir>
//
// It reads the instance's stack record for its compose project, and for every
// container of that project (participants included) writes
// `logs-<container>.log` (`docker logs --timestamps --since`) and
// `logs-<container>.inspect.json`, flat in the receipt directory: the runner
// copies receipts one level deep, as text, through its secret scrubber. The inspect output carries no secret: the
// runtime holds no credential in its environment (D61, S06-host-guards checks it), and
// the scrubber the runner applies to receipts runs over these files too. It
// writes `collect-logs.json` last: the container list, each file's size, and
// any container it could not read. A container it could not read fails the
// step: missing evidence is not a pass.
import { spawnSync } from "node:child_process";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { instancePaths, readStackState, stateRoot } from "../lib/smoke-state.ts";

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

/** PURE. A container name as a safe file stem. */
export function fileStem(name: string): string {
  return name.replace(/^\//, "").replace(/[^A-Za-z0-9_.-]/g, "_");
}

function main(): number {
  const instance = flag("--instance");
  const since = flag("--since");
  const receiptDir = flag("--receipt-dir");
  if (!instance || !since || Number.isNaN(Date.parse(since)) || !receiptDir) {
    console.error("usage: bun scripts/release/collect-logs.ts --instance <name> --since <iso> --receipt-dir <dir>");
    return 2;
  }
  const record = readStackState(instancePaths(stateRoot(process.env), instance));
  if (record === null) {
    console.error(`[collect-logs] instance ${instance} has no stack record`);
    return 1;
  }
  const ps = spawnSync("docker", ["ps", "-a", "--format", "{{.Names}}", "--filter", `label=com.docker.compose.project=${record.project}`], { encoding: "utf8" });
  if (ps.status !== 0) {
    console.error(`[collect-logs] docker ps failed: ${ps.stderr}`);
    return 1;
  }
  const names = ps.stdout.split("\n").map((l) => l.trim()).filter(Boolean).sort();
  const dir = receiptDir;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const files: Record<string, { log: number; inspect: number }> = {};
  const failed: string[] = [];
  for (const name of names) {
    const stem = fileStem(name);
    const logs = spawnSync("docker", ["logs", "--timestamps", "--since", since, name], { maxBuffer: 1 << 30 });
    const inspect = spawnSync("docker", ["inspect", name], { encoding: "utf8" });
    if (logs.status !== 0 || inspect.status !== 0) {
      failed.push(name);
      continue;
    }
    // A container's stdout and stderr, interleaved by docker's timestamps when read back.
    writeFileSync(join(dir, `logs-${stem}.log`), Buffer.concat([logs.stdout, logs.stderr]), { mode: 0o600 });
    writeFileSync(join(dir, `logs-${stem}.inspect.json`), inspect.stdout, { mode: 0o600 });
    files[name] = { log: statSync(join(dir, `logs-${stem}.log`)).size, inspect: statSync(join(dir, `logs-${stem}.inspect.json`)).size };
  }
  const receipt = { step: "S08-soak-checks", instance, project: record.project, since, containers: names, files, failed, at: new Date().toISOString() };
  writeFileSync(join(receiptDir, "collect-logs.json"), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  console.log(`[collect-logs] ${names.length - failed.length} of ${names.length} container(s) of ${record.project} collected since ${since}`);
  if (names.length === 0) console.error(`[collect-logs] compose project ${record.project} has no containers`);
  for (const f of failed) console.error(`[collect-logs] could not read ${f}`);
  return names.length > 0 && failed.length === 0 ? 0 : 1;
}

if (import.meta.main) process.exitCode = main();
