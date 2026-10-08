#!/usr/bin/env bun
// scripts/release/stop-legacy.ts — release steps R6.1 and S8.1, run ON THE TARGET HOST.
//
//   bun scripts/release/stop-legacy.ts stop --session <tmux session> --project <compose project> \
//       --legacy-checkout <dir> --compose-files <a.yml,b.yml or ''> --receipt-dir <dir>
//   bun scripts/release/stop-legacy.ts retire --legacy-checkout <dir> --version <vX.Y.Z> --receipt-dir <dir>
//
// stop (R6.1, IRREVERSIBLE: the stack is down from here until R6.9). Stops the
// named tmux driver session first, so nothing restarts the old stack, then
// runs `docker compose --env-file /dev/null -p <project> down --remove-orphans` from the old
// checkout. Never `-v`: the volumes stay (runbook R6.1). Then proves no
// container of that project remains. A session or project already gone is
// recorded, not refused, so a resumed run passes.
//
// retire (runbook section 8, after R6.3). Renames the old checkout to
// `<dir>.<version>-retired`, so the old `bun run migrate` cannot run against
// the migrated database (B13). Already renamed is recorded, not refused.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { composeArgs } from "../stack/config.ts";

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

/**
 * PURE. The compose argv that stops the legacy project, on the one compose
 * prefix (scripts/stack/config.ts composeArgs, `--env-file /dev/null`). It
 * never carries -v or --volumes.
 */
export function composeDownArgv(project: string, files: readonly string[]): string[] {
  return [...composeArgs(project, [...files]), "down", "--remove-orphans"];
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
  const session = flag("--session");
  const project = flag("--project");
  const checkout = flag("--legacy-checkout");
  const filesArg = flag("--compose-files");
  const receiptDir = flag("--receipt-dir");
  if (!session || !project || !checkout || filesArg === undefined || !receiptDir) {
    console.error("usage: stop-legacy.ts stop --session S --project P --legacy-checkout DIR --compose-files LIST --receipt-dir DIR");
    return 2;
  }
  const files = filesArg.split(",").map((f) => f.trim()).filter(Boolean);
  const problems: string[] = [];

  // 1. The driver first, so nothing brings the old stack back.
  const has = run("tmux", ["has-session", "-t", `=${session}`]);
  let tmux: string;
  if (has.status === 0) {
    const kill = run("tmux", ["kill-session", "-t", `=${session}`]);
    const still = run("tmux", ["has-session", "-t", `=${session}`]).status === 0;
    tmux = kill.status === 0 && !still ? "stopped" : "still running";
    if (tmux !== "stopped") problems.push(`tmux session ${session} is still running`);
  } else {
    tmux = "absent";
  }
  console.log(`[stop-legacy] tmux session ${session}: ${tmux}`);

  // 2. The old stack, from its own checkout, keeping its volumes.
  const before = projectContainers(project);
  if (before === null) problems.push("docker ps failed");
  let compose = "nothing to stop";
  if (before !== null && before.length > 0) {
    if (!existsSync(checkout)) problems.push(`the legacy checkout ${checkout} is missing; cannot run compose down from it`);
    else {
      const argv = composeDownArgv(project, files);
      console.log(`[stop-legacy] (cd ${checkout} && docker ${argv.join(" ")})`);
      const down = run("docker", argv, checkout);
      process.stdout.write(down.stdout ?? "");
      process.stderr.write(down.stderr ?? "");
      compose = down.status === 0 ? "down" : `failed (exit ${down.status})`;
      if (down.status !== 0) problems.push(`docker compose down exited ${down.status}`);
    }
  }

  // 3. Proof.
  const after = projectContainers(project);
  if (after === null) problems.push("docker ps failed after compose down");
  else if (after.length > 0) problems.push(`legacy containers remain: ${after.join(", ")}`);

  const file = writeReceipt(receiptDir, "stop-legacy.json", {
    step: "stop-legacy", session, tmux, project, composeFiles: files, checkout, containersBefore: before, compose, containersAfter: after, problems,
  });
  console.log(`[stop-legacy] receipt: ${file}`);
  for (const p of problems) console.error(`[stop-legacy] FAIL: ${p}`);
  return problems.length === 0 ? 0 : 1;
}

function retire(): number {
  const checkout = flag("--legacy-checkout");
  const version = flag("--version");
  const receiptDir = flag("--receipt-dir");
  if (!checkout || !version || !/^v\d+\.\d+\.\d+$/.test(version) || !receiptDir) {
    console.error("usage: stop-legacy.ts retire --legacy-checkout DIR --version vX.Y.Z --receipt-dir DIR");
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
  const file = writeReceipt(receiptDir, "retire-legacy.json", { step: "retire-legacy", checkout, retiredAs: dest, outcome });
  (code === 0 ? console.log : console.error)(`[stop-legacy] ${checkout} → ${dest}: ${outcome}`);
  console.log(`[stop-legacy] receipt: ${file}`);
  return code;
}

if (import.meta.main) {
  const sub = process.argv[2];
  process.exitCode = sub === "stop" ? stop() : sub === "retire" ? retire() : (console.error("usage: stop-legacy.ts <stop|retire> …"), 2);
}
