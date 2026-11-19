#!/usr/bin/env bun
// scripts/release/version-check.ts — a release's version checks (the steps it
// adds after the soak: Q for stage, C for production, one pair per check), run ON THE TARGET HOST.
//
//   bun scripts/release/version-check.ts --release vA.B.C --check <name> --instance <name> --origin <url> --run <run-ts> --receipt-dir <dir> [--commit <sha>] [--host <ssh-dest>]
//
// `--host` makes a control-machine step read the target host: `docker` runs there over ssh, and
// `hostOrigin(port)` forwards one of its loopback ports (scripts/lib/website-host.ts), so a check
// reads what the host serves upstream of Cloudflare (owner, 2026-11-15, v0.9.0 Q41-web-bundle).
//
// A version check proves one change a release ships: a feature landed, a bug is
// fixed, a feature retired (owner, 2026-10-15). The general checks every
// release runs are the template's soak steps; these are the release's own,
// added to its runbook, one per change its `scope:` lists.
//
// Each check is one file, ./version-checks/<release>/<name>.ts, whose default
// export takes the context below and returns what it found. Reads only: the
// database through `rm_readonly` on a session proven read-only (./db-read.ts),
// the public origin over HTTP, and `docker` on this host. A check that must
// write (a refused take, say) is a stage-only step (`onlyFor: stage`).
//
// It writes `version-check-<name>.json` into --receipt-dir (`-`: a control-machine step, which prints it instead) and exits 0 only when
// the check found no problem.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sshArgv, sshHost, type WebHost } from "../lib/website-host.ts";
import { openReadOnly, type ReadOnlySession } from "./db-read.ts";

export interface VersionCheckContext {
  readonly release: string;
  readonly instance: string;
  /** The public origin, no trailing slash. */
  readonly origin: string;
  readonly runTs: string;
  /** The release commit (`--commit`), for a check that runs the SDK or reads the checkout at it; absent when the step passes none. */
  readonly commit?: string;
  /** The target host's ssh destination (`--host`), for a control-machine step that reads the host; absent on a target step. */
  readonly host?: string;
  /** Opens the proven read-only session once, on first use. */
  db(): Promise<ReadOnlySession>;
  /** `GET <origin><path>`: the status and body, never a throw for a non-2xx. */
  http(path: string, init?: RequestInit): Promise<{ status: number; text: string }>;
  /** Run `docker <args>` on the target host: here, or over ssh to `host` when the step passes one. */
  docker(args: readonly string[]): { code: number; stdout: string; stderr: string };
  /** An origin on this machine that reaches the target host's 127.0.0.1:`port` (an ssh forward when `host` is set). */
  hostOrigin(port: number): Promise<string>;
  /** The instance's compose project, from the running containers' labels. */
  project(): string;
}

export interface VersionCheckResult {
  /** What was observed: values a reader can check against the claim. */
  readonly found: Record<string, unknown>;
  /** Empty when the change is in place. */
  readonly problems: readonly string[];
}

export type VersionCheck = (ctx: VersionCheckContext) => Promise<VersionCheckResult>;

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** PURE. A check name is a short slug; it names a file, so nothing else is accepted. */
export function validCheckName(name: string): boolean {
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(name);
}

export function makeContext(opts: { release: string; instance: string; origin: string; runTs: string; commit?: string; host?: string }): VersionCheckContext & { close(): Promise<void> } {
  let session: Promise<ReadOnlySession> | undefined;
  let project: string | undefined;
  let remote: WebHost | undefined;
  const sshDir = opts.host ? mkdtempSync(join(tmpdir(), "rm-version-check-ssh-")) : undefined;
  if (opts.host !== undefined && (opts.host === "" || opts.host.startsWith("-"))) throw new Error(`Refusing: ${JSON.stringify(opts.host)} is not an ssh destination.`);
  const docker = (args: readonly string[]) => {
    const argv = opts.host && sshDir ? sshArgv(opts.host, join(sshDir, "control"), ["docker", ...args]) : ["docker", ...args];
    const r = spawnSync(argv[0]!, argv.slice(1), { encoding: "utf8" });
    return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  const origin = opts.origin.replace(/\/+$/, "");
  return {
    ...opts,
    origin,
    db: () => (session ??= openReadOnly()),
    async http(path, init) {
      const res = await fetch(`${origin}${path}`, { ...init, signal: AbortSignal.timeout(15_000) });
      return { status: res.status, text: await res.text() };
    },
    docker,
    async hostOrigin(port) {
      if (!opts.host) return `http://127.0.0.1:${port}`;
      remote ??= sshHost(opts.host);
      return (await remote.openPort(port)).origin;
    },
    project() {
      if (project !== undefined) return project;
      const r = docker(["ps", "--filter", `label=com.docker.compose.project`, "--format", "{{.Label \"com.docker.compose.project\"}}"]);
      const names = [...new Set(r.stdout.split("\n").map((l) => l.trim()).filter(Boolean))];
      const mine = names.filter((n) => n.startsWith("rm_smoke_stack_"));
      if (mine.length !== 1) throw new Error(`cannot tell instance ${opts.instance}'s compose project from the running containers (${names.join(", ") || "none"})`);
      project = mine[0]!;
      return project;
    },
    async close() {
      remote?.close();
      if (opts.host && sshDir) {
        spawnSync("ssh", ["-o", `ControlPath=${join(sshDir, "control")}`, "-O", "exit", opts.host], { stdio: "ignore" });
        rmSync(sshDir, { recursive: true, force: true });
      }
      if (session) await (await session).close();
    },
  };
}

async function main(): Promise<number> {
  const release = flag("--release");
  const name = flag("--check");
  const instance = flag("--instance");
  const origin = flag("--origin");
  const runTs = flag("--run");
  const receiptDir = flag("--receipt-dir");
  if (!release || !name || !instance || !origin || !runTs || !receiptDir || !validCheckName(name) || !/^v\d+\.\d+\.\d+$/.test(release)) {
    console.error("usage: bun scripts/release/version-check.ts --release vA.B.C --check <name> --instance <name> --origin <url> --run <run-ts> --receipt-dir <dir>");
    return 2;
  }
  const mod = (await import(`./version-checks/${release}/${name}.ts`)) as { default: VersionCheck };
  const commit = flag("--commit");
  const host = flag("--host");
  const ctx = makeContext({ release, instance, origin, runTs, ...(commit ? { commit } : {}), ...(host ? { host } : {}) });
  let result: VersionCheckResult;
  try {
    result = await mod.default(ctx);
  } catch (error) {
    result = { found: {}, problems: [`the check could not run: ${error instanceof Error ? error.message : String(error)}`] };
  } finally {
    await ctx.close();
  }
  const receipt = `${JSON.stringify({ release, check: name, at: new Date().toISOString(), ...result }, null, 2)}\n`;
  let where: string;
  if (receiptDir === "-") {
    // A control-machine step (the SDK checks) has no host run directory: its receipt is its output, which the journal keeps.
    where = "printed below";
    console.log(receipt);
  } else {
    mkdirSync(receiptDir, { recursive: true, mode: 0o700 });
    where = join(receiptDir, `version-check-${name}.json`);
    writeFileSync(where, receipt, { mode: 0o600 });
  }
  console.log(`[version-check] ${release} ${name}: ${result.problems.length === 0 ? "ok" : `${result.problems.length} problem(s)`}; receipt ${where}`);
  for (const p of result.problems) console.error(`[version-check] REFUSE: ${p}`);
  return result.problems.length === 0 ? 0 : 1;
}

if (import.meta.main) process.exit(await main());
