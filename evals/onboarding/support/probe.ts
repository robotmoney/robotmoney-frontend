// Stopped-container filesystem observation for eval layers 1-3
// (docs/architecture.md §11.3 E3).
//
// THE RULE THIS FILE EXISTS TO KEEP: the harness never instructs the agent to
// emit an artifact. Adding "…and write the signature to /out/sig.txt" to a
// layer's task would edit the task under test — the agent would be following a
// harness protocol instead of our onboarding instructions, and the eval would
// measure obedience rather than navigation. So every observation here is made
// AFTER the fact, from outside, on a container that has already stopped.
//
// `docker cp` and `docker export`, never `docker exec`: exec cannot run against
// a stopped container. The member-agent primitive's `keepUntilInspected` +
// `inspect` bracket (scripts/agent/member-agent.ts) is what holds the stopped
// container alive long enough for these calls, and removes it afterwards
// regardless of outcome.
//
// EVERY FAILURE PATH THROWS (§11.3 E2). Nothing here returns a sentinel a
// caller could read as "skip"; `tryCopyOut` is the one nullable, and its null
// means "this path is absent in the container" — a real observation, which is
// exactly what layers 1-3 assert on.
import { chmodSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { composeArgs, DEFAULT_COMPOSE_FILES } from "../../../scripts/stack/config.ts";

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function decode(buf: unknown): string {
  return buf instanceof Uint8Array ? new TextDecoder().decode(buf) : "";
}

function run(argv: string[], cwd?: string): CommandResult {
  const r = Bun.spawnSync(argv, { ...(cwd ? { cwd } : {}), stdout: "pipe", stderr: "pipe" });
  return { exitCode: r.exitCode ?? -1, stdout: decode(r.stdout), stderr: decode(r.stderr) };
}

// Single-quote for `bash -c`. Container names and paths are harness-generated,
// but a shell pipeline is involved (see listContainerFiles) and quoting is not
// optional just because today's inputs are tame.
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// ── Targeted copy (ALWAYS tried before an export) ───────────────────────────
export function tryCopyOut(containerName: string, containerPath: string, hostDir: string): string | null {
  mkdirSync(hostDir, { recursive: true });
  const dest = join(hostDir, basename(containerPath) || "copied");
  const r = run(["docker", "cp", `${containerName}:${containerPath}`, dest]);
  if (r.exitCode !== 0) return null;
  return existsSync(dest) ? dest : null;
}

export function copyOut(containerName: string, containerPath: string, hostDir: string): string {
  const dest = tryCopyOut(containerName, containerPath, hostDir);
  if (dest === null) {
    throw new Error(`docker cp ${containerName}:${containerPath} failed — the path is absent from the stopped container`);
  }
  return dest;
}

// ── Whole-filesystem discovery (streamed, never materialised) ───────────────
// `docker export <container> | tar -tf -` streams the container's filesystem
// through a pipe and we keep only the MEMBER LIST. An agent that cloned
// robotmoney-core can leave hundreds of MB behind, so the archive is never
// written to disk and never buffered whole — only its table of contents is.
//
// Deliberately loose by design: layers 1-2 assert on a filename ANYWHERE in the
// filesystem rather than a fixed path, because opencode's on-disk skill layout
// is not a published contract and pinning it would make an upstream change look
// like a product regression.
export function listContainerFiles(containerName: string): string[] {
  const r = run([
    "bash",
    "-c",
    `set -o pipefail; docker export ${shellQuote(containerName)} | tar -tf -`,
  ]);
  if (r.exitCode !== 0) {
    throw new Error(`docker export ${containerName} | tar -tf - failed (exit ${r.exitCode}): ${r.stderr.slice(0, 2000)}`);
  }
  return r.stdout.split("\n").map((l) => l.replace(/\/+$/, "")).filter((l) => l.length > 0);
}

export function findByName(containerName: string, filename: string, listing?: string[]): string[] {
  const entries = listing ?? listContainerFiles(containerName);
  return entries.filter((p) => basename(p) === filename);
}

export function findMatching(containerName: string, pattern: RegExp, listing?: string[]): string[] {
  const entries = listing ?? listContainerFiles(containerName);
  return entries.filter((p) => pattern.test(p));
}

// A tar member path (`home/agent/x`) as an absolute container path (`/home/agent/x`).
export function toContainerPath(tarMemberPath: string): string {
  return tarMemberPath.startsWith("/") ? tarMemberPath : `/${tarMemberPath}`;
}

// ── Bulk extraction (one pass, pattern-scoped) ──────────────────────────────
// Used only where the path is unknown AND the file must be READ (the layer-3
// signature harvest). GNU tar exits non-zero when a wildcard matched nothing;
// that is a legitimate observation ("the agent produced no such file"), not a
// harness failure, so it is tolerated — every OTHER failure throws.
export function extractMatching(containerName: string, patterns: string[], hostDir: string): string[] {
  if (patterns.length === 0) return [];
  mkdirSync(hostDir, { recursive: true });
  const quoted = patterns.map(shellQuote).join(" ");
  const r = run([
    "bash",
    "-c",
    `set -o pipefail; docker export ${shellQuote(containerName)} | tar -x -C ${shellQuote(hostDir)} --wildcards --no-anchored ${quoted}`,
  ]);
  const notFoundOnly = /Not found in archive|Exiting with failure status due to previous errors/.test(r.stderr);
  if (r.exitCode !== 0 && !notFoundOnly) {
    throw new Error(`docker export ${containerName} | tar -x failed (exit ${r.exitCode}): ${r.stderr.slice(0, 2000)}`);
  }
  return walk(hostDir).map((p) => relative(hostDir, p));
}

export function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (entry.isFile()) out.push(p);
  }
  return out;
}

export function fileSize(path: string): number {
  return statSync(path).size;
}

// ── Running an artifact the agent produced ──────────────────────────────────
// The binary the AGENT installed is linux/amd64 (the member-agent image's
// platform) and may not be runnable on the developer's own host, so it is
// mounted read-only into a FRESH member-agent container and executed there.
// `--no-deps` because no service is needed; `--rm` because this container is
// pure instrumentation, not a subject.
export interface RunExtractedBinaryOptions {
  repoRoot: string;
  composeProject: string;
  composeFiles?: string[];
  hostBinaryPath: string;
  argv: string[];
}

export function runExtractedBinary(opts: RunExtractedBinaryOptions): CommandResult {
  chmodSync(opts.hostBinaryPath, 0o755);
  return run(
    [
      "docker",
      ...composeArgs(opts.composeProject, opts.composeFiles ?? DEFAULT_COMPOSE_FILES),
      "run",
      "--rm",
      "--no-deps",
      "-v",
      `${opts.hostBinaryPath}:/tmp/probe:ro`,
      "--entrypoint",
      "/tmp/probe",
      "member-agent",
      ...opts.argv,
    ],
    opts.repoRoot,
  );
}
