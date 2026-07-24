// Shared, cached, loud-fail `rmpc` release binary fetch (Stage 3,
// docs/architecture.md §11 R3/R6 — "keygen is never centralized" / "setup-gated
// apply"). Extracted from scripts/rmpc-release-e2e.ts so the SAME
// download/verify path is used by both the live release-e2e driver and
// scripts/tests/rmpc-canonical-apply.test.ts (the JS/Rust canonical-payload
// byte-exactness proof). NEVER falls back to anything — especially not JS
// keygen, which would silently defeat the point of proving the real toolchain
// works — if the binary can't be fetched, extracted, or run: every failure
// path here THROWS. Callers that want a script-style immediate-exit failure
// should let the throw propagate to their own top-level `.catch()`.
import { mkdirSync, chmodSync, existsSync, writeFileSync, renameSync, rmSync, mkdtempSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const RMPC_REPO = "robotmoney/robotmoney-core";

// Pinned release: robotmoney-core v0.3.2 is the first release whose rmpc
// binary ships a working `committee-identity create/show-public-key/sign`
// (implements robotmoney-core issue #1111/PR #1112; verified locally
// 2026-07-10 against rmpc-v0.3.2-linux-amd64.tar.gz's --help before this
// driver was written, and re-confirmed 2026-07-24 by
// scripts/tests/rmpc-canonical-apply.test.ts, which additionally proves it
// signs the committee-application canonical payload byte-exactly). Bump this
// (and re-run that test locally) when adopting a newer rmpc release — no
// auto-discovery mechanism is needed for a once-in-a-while manual bump.
export const RMPC_VERSION = process.env.RMPC_VERSION?.trim() || "v0.3.2";

export interface RmpcAsset {
  os: string;
  arch: string;
  asset: string;
  url: string;
}

// Maps a Node/Bun `process.platform`/`process.arch` pair to the matching
// rmpc-core release asset name + download URL. Throws on an unsupported
// combination (robotmoney-core ships linux/macos amd64/arm64 only).
export function resolveRmpcAsset(version: string, platform: string, arch: string, repo = RMPC_REPO): RmpcAsset {
  const os = platform === "linux" ? "linux" : platform === "darwin" ? "macos" : null;
  const archName = arch === "x64" ? "amd64" : arch === "arm64" ? "arm64" : null;
  if (!os || !archName) {
    throw new Error(`unsupported runner platform ${platform}/${arch} — robotmoney-core ${version} ships linux/macos amd64/arm64 only`);
  }
  const asset = `rmpc-${version}-${os}-${archName}.tar.gz`;
  return { os, arch: archName, asset, url: `https://github.com/${repo}/releases/download/${version}/${asset}` };
}

// Every committee-identity subcommand this whole onboarding flow depends on,
// per `--help` text. Returns the ones missing (empty ⇒ all present).
export function missingCommitteeIdentitySubcommands(helpText: string): string[] {
  return ["create", "show-public-key", "sign"].filter((sub) => !new RegExp(`\\b${sub}\\b`).test(helpText));
}

function cacheRoot(): string {
  return process.env.RMPC_CACHE_DIR?.trim() || join(tmpdir(), "robotmoney-rmpc-cache");
}

function verifyCommitteeIdentitySubcommand(rmpcPath: string, version: string): void {
  const r = Bun.spawnSync([rmpcPath, "committee-identity", "--help"], { stdout: "pipe", stderr: "pipe" });
  const out = new TextDecoder().decode(r.stdout) + new TextDecoder().decode(r.stderr);
  if (r.exitCode !== 0) throw new Error(`rmpc committee-identity --help exited ${r.exitCode}: ${out}`);
  const missing = missingCommitteeIdentitySubcommands(out);
  if (missing.length > 0) {
    throw new Error(`downloaded rmpc ${version} is missing committee-identity subcommand(s): ${missing.join(", ")} — output:\n${out}`);
  }
}

/**
 * Download (or reuse a cached) rmpc release binary for the pinned version,
 * verify it exposes the committee-identity create/show-public-key/sign
 * subcommands this whole onboarding flow depends on, and return its path.
 * Cached by version under RMPC_CACHE_DIR (default: an OS-temp directory) so
 * repeated calls within the same run — or across processes on the same
 * machine — don't re-download. THROWS on any failure: a missing/unreachable
 * release, an extraction failure, or a binary missing a required subcommand
 * never silently degrades to "skip" or to any non-`rmpc` signing path.
 */
export async function fetchRmpc(version: string = RMPC_VERSION): Promise<string> {
  const { asset, url } = resolveRmpcAsset(version, process.platform, process.arch);
  const dir = join(cacheRoot(), version);
  const binPath = join(dir, "rmpc");

  if (existsSync(binPath)) {
    verifyCommitteeIdentitySubcommand(binPath, version);
    return binPath;
  }

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `rmpc release asset download failed: GET ${url} → ${res.status} ${res.statusText} ` +
        `(pinned version ${version} may not exist, or this platform's asset was renamed — ` +
        `check https://github.com/${RMPC_REPO}/releases/tag/${version})`,
    );
  }

  const tmpDir = mkdtempSync(join(tmpdir(), "rmpc-fetch-"));
  try {
    const tarPath = join(tmpDir, asset);
    writeFileSync(tarPath, new Uint8Array(await res.arrayBuffer()));
    const extract = Bun.spawnSync(["tar", "-xzf", tarPath, "-C", tmpDir], { stdout: "inherit", stderr: "inherit" });
    if (extract.exitCode !== 0) throw new Error(`extracting ${asset} failed (tar exit ${extract.exitCode})`);
    const extractedBin = join(tmpDir, "rmpc");
    chmodSync(extractedBin, 0o755);
    verifyCommitteeIdentitySubcommand(extractedBin, version);

    // Move the verified binary into the cache. Prefer rename (atomic on the
    // same filesystem); fall back to copy+remove if RMPC_CACHE_DIR points
    // somewhere cross-device. A lost race against a concurrent fetchRmpc()
    // populating the same cache entry just means one of the two downloads
    // was wasted, never a corrupt cache entry (rename/copy target is only
    // ever a fully-verified binary).
    mkdirSync(dir, { recursive: true });
    try {
      renameSync(extractedBin, binPath);
    } catch {
      cpSync(extractedBin, binPath);
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
  return binPath;
}

/**
 * Run an rmpc subcommand that prints one JSON object to stdout; throw (never
 * return an unparsed/failed result) on a non-zero exit or non-JSON stdout.
 * Shared by the release-e2e driver and the canonical-signing test so both
 * fail the same way on a broken invocation.
 */
export function runRmpcJson(rmpcPath: string, args: string[], env: Record<string, string> = {}): any {
  const r = Bun.spawnSync([rmpcPath, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env } as Record<string, string>,
  });
  const out = new TextDecoder().decode(r.stdout).trim();
  const err = new TextDecoder().decode(r.stderr).trim();
  if (r.exitCode !== 0) throw new Error(`rmpc ${args.join(" ")} exited ${r.exitCode}: ${err || out}`);
  try {
    return JSON.parse(out);
  } catch {
    throw new Error(`rmpc ${args.join(" ")} produced non-JSON stdout: ${out}`);
  }
}
