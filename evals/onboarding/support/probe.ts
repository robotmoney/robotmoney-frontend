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
import { composeChildEnv } from "../../../scripts/agent/member-agent.ts";
import { composeArgs, DEFAULT_COMPOSE_FILES } from "../../../scripts/stack/config.ts";

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function decode(buf: unknown): string {
  return buf instanceof Uint8Array ? new TextDecoder().decode(buf) : "";
}

// `stdin: "ignore"` is LOAD-BEARING on every one of these, not tidiness. A
// compose child that can reach a terminal will ask
// `Recreate (data will be lost)?` and then wait forever; on 2026-07-27 that
// shape cost four 20-minute samples reported as product timeouts. With stdin
// closed the question gets EOF and the call fails loudly instead of hanging.
function run(argv: string[], cwd?: string, env?: Record<string, string>): CommandResult {
  const r = Bun.spawnSync(argv, {
    ...(cwd ? { cwd } : {}),
    ...(env ? { env } : {}),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
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

// ── Classifying a non-zero tar exit ─────────────────────────────────────────
// GNU tar's exit code alone says only "something failed". Two very different
// stderr shapes arrive here:
//
//   tar: home/agent/*.sig: Not found in archive
//     A wildcard matched no member. That is a LEGITIMATE OBSERVATION ("the agent
//     produced no such file"), which is exactly what layers 1-3 assert on, so it
//     is tolerated.
//
//   tar: Exiting with failure status due to previous errors
//     GNU tar's GENERIC trailer. It is printed after ANY error — including
//     `Cannot open: Permission denied` and `Cannot write: No space left on
//     device` — so on its own it is evidence of nothing. Tolerating it alone
//     (which this predicate used to do) swallowed a genuine extraction failure
//     and let walk() return a PARTIAL tree, degrading a real red into a
//     mis-attributed one: layer 3 would blame the agent for a signature the
//     harness had simply failed to extract.
//
// So the trailer is tolerated only when the missing-member EVIDENCE is also
// present, and never when stderr carries a shape that cannot mean "no such
// member". Pure string classification: it runs nothing and decides nothing
// about inference.
const TAR_MISSING_MEMBER = /: Not found in archive/;
const TAR_HARD_ERROR =
  /Cannot (open|write|stat|mkdir|change|utime|link|symlink|extract|connect)|Permission denied|No space left|Read-only file system|Unexpected EOF|Error response from daemon|No such container/;

export function isMissingMemberOnlyTarFailure(stderr: string): boolean {
  if (TAR_HARD_ERROR.test(stderr)) return false;
  return TAR_MISSING_MEMBER.test(stderr);
}

// ── Bulk extraction (one pass, pattern-scoped) ──────────────────────────────
// Used only where the path is unknown AND the file must be READ (the layer-3
// signature harvest). A non-zero exit is tolerated only under
// isMissingMemberOnlyTarFailure — every OTHER failure throws — and even a
// tolerated one is WARNED about, because "extraction was not clean" is
// something the campaign log must carry rather than a fact only this function
// ever knew.
export function extractMatching(containerName: string, patterns: string[], hostDir: string): string[] {
  if (patterns.length === 0) return [];
  mkdirSync(hostDir, { recursive: true });
  const quoted = patterns.map(shellQuote).join(" ");
  const r = run([
    "bash",
    "-c",
    `set -o pipefail; docker export ${shellQuote(containerName)} | tar -x -C ${shellQuote(hostDir)} --wildcards --no-anchored ${quoted}`,
  ]);
  if (r.exitCode !== 0) {
    if (!isMissingMemberOnlyTarFailure(r.stderr)) {
      throw new Error(`docker export ${containerName} | tar -x failed (exit ${r.exitCode}): ${r.stderr.slice(0, 2000)}`);
    }
    console.warn(
      `[probe] tar exited ${r.exitCode} extracting from ${containerName}, tolerated as "the archive contains no ` +
        `such member". Extraction was NOT clean; anything it did not write is invisible to the harvest. ` +
        `stderr: ${r.stderr.slice(0, 2000)}`,
    );
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
    // Same derived SMOKE_PROJECT the member-agent spawn uses. `docker compose
    // run` re-resolves the WHOLE compose model and hashes every project volume,
    // so a child without it hashes the pgdata label as "" and compose asks to
    // recreate a volume THIS project just created. Layer 2 runs this immediately
    // after the agent's own run, in the same project — exactly the mismatch.
    composeChildEnv(opts.composeProject),
  );
}
