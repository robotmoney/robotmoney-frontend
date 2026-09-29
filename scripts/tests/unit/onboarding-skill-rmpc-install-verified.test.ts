// Issue #748 — the published swarm-onboarding skill must not install `rmpc`
// without checking it against the checksum robotmoney-core publishes beside
// every release archive.
//
// `frontend/public/skills/swarm-onboarding/SKILL.md` is served over the public
// web (https://robotmoney.network/skills/swarm-onboarding/SKILL.md) to people whose
// very next step is to generate, with the binary they just installed, the
// signing key their member's entire public record rests on. It used to say
// `curl -fsSL <url> | tar xz && install -m 755 rmpc ...`: nothing between the
// network and a key-generating executable, and unfixable in place, because by
// the time you could compare a checksum the archive is already unpacked.
//
// This file asserts against the REPO-LOCAL file, never the live site, so it
// runs offline in the required unit.yml job with no network and no skips.
//
// It does two things:
//
//   1. STATIC — the block still orders its steps
//      download -> download .sha256 -> VERIFY -> extract -> install
//      (robotmoney-core's `scripts/release/install-rmpc.sh` ordering), and the
//      unverified pipe-into-tar form appears nowhere in the document.
//   2. EXECUTED — the documented block is lifted out of the markdown and RUN,
//      against a locally built fixture "release" served over `file://`. A
//      documented failure path that is only read, never run, is how the
//      original bug survived: prose can claim it stops on mismatch while the
//      shell it hands the reader does not. So the corrupted archive, the
//      checksum file that names some other file, and the release with no
//      published checksum are each executed here, and each must exit non-zero
//      leaving NOTHING installed.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../../..");
const SKILL_REL = "frontend/public/skills/swarm-onboarding/SKILL.md";
const skill = readFileSync(join(repoRoot, SKILL_REL), "utf8");

// The install recipe: the fenced bash block that ends in `install -m 755 rmpc`.
function installBlock(): string {
  const blocks = [...skill.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]);
  const found = blocks.filter((b) => /^install -m 755 rmpc\b/m.test(b));
  if (found.length !== 1) {
    throw new Error(`expected exactly one \`\`\`bash block installing rmpc in ${SKILL_REL}, found ${found.length}`);
  }
  return found[0];
}

describe("the published onboarding skill installs rmpc only after a checksum check (issue #748)", () => {
  const block = installBlock();

  test("the unverified pipe-into-tar install form appears nowhere in the document", () => {
    // `curl ... | tar xz` cannot be fixed in place — assert the shape is gone
    // from the whole file, prose included, so no future edit can restore it as
    // an "alternative".
    expect(skill).not.toMatch(/\|\s*tar\b/);
  });

  test("the archive and its published .sha256 are both downloaded to files", () => {
    expect(block).toContain('BASE="https://github.com/robotmoney/robotmoney-core/releases/download/${TAG}"');
    expect(block).toMatch(/curl -fsSL -o "\$ARCHIVE" "\$\{BASE\}\/\$\{ARCHIVE\}"/);
    expect(block).toMatch(/curl -fsSL -o "\$\{ARCHIVE\}\.sha256" "\$\{BASE\}\/\$\{ARCHIVE\}\.sha256"/);
  });

  test("it verifies with sha256sum -c on Linux and shasum -a 256 -c on macOS, refusing to run with neither", () => {
    expect(block).toContain("sha256sum -c");
    expect(block).toContain("shasum -a 256 -c");
    expect(block).toMatch(/refusing to install rmpc unverified/);
  });

  test("it installs one pinned rmpc release and never asks GitHub for the latest (RM-148)", () => {
    // "latest" is whatever robotmoney-core published last: the rmpc- tag rename
    // broke every install through it. A pin changes only in a reviewed edit.
    expect(skill).not.toMatch(/releases\/latest|api\.github\.com/);
    expect(block).toMatch(/^PINNED_TAG="rmpc-v\d+\.\d+\.\d+"$/m);
    expect(block).toContain('TAG="${RMPC_TAG:-$PINNED_TAG}"');
  });

  test("the pinned release carries its checksum for each of the four platforms", () => {
    const tag = block.match(/^PINNED_TAG="(rmpc-v[\d.]+)"$/m)![1];
    const pins = [...block.matchAll(PIN_LINE)].map((m) => m[1]).sort();
    expect(pins).toEqual(
      ["linux-amd64", "linux-arm64", "macos-amd64", "macos-arm64"].map((p) => `rmpc-${tag.slice(5)}-${p}.tar.gz`).sort(),
    );
  });

  test("VERIFY happens before extract, and extract before install", () => {
    const verify = block.indexOf("$SHA_CHECK");
    const extract = block.indexOf("tar xzf");
    const install = block.indexOf("install -m 755 rmpc");
    expect(verify).toBeGreaterThan(-1);
    expect(extract).toBeGreaterThan(verify);
    expect(install).toBeGreaterThan(extract);
  });

  test("a mismatch tells the reader the download failed its published checksum and that nothing was installed", () => {
    expect(block).toContain("ChecksumMismatch");
    expect(block).toContain("does not match its expected sha256");
    expect(block).toContain("Nothing was extracted and nothing was installed.");
    // ...and the surrounding prose says the same thing to the agent reading it.
    expect(skill).toMatch(/nothing was extracted\s*\n?and nothing was installed/i);
  });
});

// ---------------------------------------------------------------------------
// EXECUTED: run the documented block against a local fixture release.
// ---------------------------------------------------------------------------

// Release tags carry the binary's name (rmpc-vX.Y.Z, core #1243) and the archive
// names it once: rmpc-vX.Y.Z-<os>-<arch>.tar.gz. A bare fixture tag hid the
// doubled rmpc-rmpc- archive name that 404ed from 2 Sep (RM-148).
const TAG = "rmpc-v0.0.0-fixture";
const ARCHIVE = "rmpc-v0.0.0-fixture-testos-testarch.tar.gz";

// Rewrite only the four host/network-dependent lines and the destination, each
// substitution asserted to hit — if the block's shape changes, this fails loudly
// instead of quietly executing something that is no longer the documented
// recipe.
function runnable(baseDir: string): string {
  let script = installBlock();
  const subs: Array<[RegExp, string]> = [
    [/^OS=.*$/m, "OS=testos"],
    [/^ARCH=.*$/m, "ARCH=testarch"],
    [/^TAG=.*$/m, `TAG=${TAG}`],
    [/^BASE=.*$/m, `BASE="file://${baseDir}"`],
    [/^install -m 755 rmpc .*$/m, 'install -m 755 rmpc "$RM_TEST_DEST/rmpc"'],
  ];
  for (const [pattern, replacement] of subs) {
    if (!pattern.test(script)) throw new Error(`install block no longer has a line matching ${pattern}`);
    script = script.replace(pattern, replacement);
  }
  return script;
}

type Release = "good" | "corrupted" | "checksum-names-another-file" | "no-checksum";

// One pinned checksum line in the install block: the archive, then its digest.
const PIN_LINE = /^  (rmpc-v[\d.]+-(?:linux|macos)-(?:amd64|arm64)\.tar\.gz)\) PINNED_SHA=([0-9a-f]{64}) ;;$/gm;

// Build a fixture "release" directory holding a real gzip tarball containing an
// `rmpc` executable, plus whatever `.sha256` this scenario publishes.
function fixture(kind: Release, archive = ARCHIVE): { base: string; dest: string } {
  const ARCHIVE = archive;
  const root = mkdtempSync(join(tmpdir(), "rmpc-install-doc-"));
  const base = join(root, "release");
  const dest = join(root, "dest");
  const staging = join(root, "staging");
  mkdirSync(base);
  mkdirSync(dest);
  mkdirSync(staging);

  writeFileSync(join(staging, "rmpc"), "#!/bin/sh\necho rmpc\n", { mode: 0o755 });
  const tar = Bun.spawnSync(["tar", "czf", join(base, ARCHIVE), "-C", staging, "rmpc"]);
  if (tar.exitCode !== 0) throw new Error(`fixture tar failed: ${tar.stderr.toString()}`);

  if (kind === "corrupted") {
    // A well-formed archive whose bytes are NOT the ones the checksum covers:
    // publish the digest of the tarball as built, then rebuild it differently.
    const digest = createHash("sha256").update(readFileSync(join(base, ARCHIVE))).digest("hex");
    writeFileSync(join(base, `${ARCHIVE}.sha256`), `${digest}  ${ARCHIVE}\n`);
    writeFileSync(join(staging, "rmpc"), "#!/bin/sh\necho TROJAN\n", { mode: 0o755 });
    const again = Bun.spawnSync(["tar", "czf", join(base, ARCHIVE), "-C", staging, "rmpc"]);
    if (again.exitCode !== 0) throw new Error(`fixture tar failed: ${again.stderr.toString()}`);
    return { base, dest };
  }

  if (kind === "checksum-names-another-file") {
    // `sha256sum -c` verifies whichever filenames the file lists. A checksum
    // file naming /dev/null with the well-known empty-file digest reports OK
    // over any archive at all — the block must refuse it on coverage.
    const empty = createHash("sha256").update("").digest("hex");
    writeFileSync(join(base, `${ARCHIVE}.sha256`), `${empty}  /dev/null\n`);
    return { base, dest };
  }

  if (kind === "good") {
    const digest = createHash("sha256").update(readFileSync(join(base, ARCHIVE))).digest("hex");
    writeFileSync(join(base, `${ARCHIVE}.sha256`), `${digest}  ${ARCHIVE}\n`);
  }
  // "no-checksum": the archive is published with no .sha256 beside it.
  return { base, dest };
}

function runInstall(kind: Release) {
  const { base, dest } = fixture(kind);
  const proc = Bun.spawnSync(["sh", "-c", runnable(base)], {
    env: { ...process.env, RM_TEST_DEST: dest },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: proc.exitCode,
    stderr: proc.stderr.toString(),
    installed: existsSync(join(dest, "rmpc")),
  };
}

describe("the documented install block, executed against a fixture release", () => {
  test("a release whose archive matches its published checksum installs rmpc", () => {
    const r = runInstall("good");
    expect(r.exitCode, `install block failed on a valid release:\n${r.stderr}`).toBe(0);
    expect(r.installed).toBe(true);
  });

  test("an archive that does not match its published checksum installs nothing", () => {
    const r = runInstall("corrupted");
    expect(r.exitCode).not.toBe(0);
    expect(r.installed).toBe(false);
    expect(r.stderr).toContain("ChecksumMismatch");
    expect(r.stderr).toContain("Nothing was extracted and nothing was installed.");
  });

  test("a checksum file that covers some other file is refused, not accepted as OK", () => {
    const r = runInstall("checksum-names-another-file");
    expect(r.exitCode).not.toBe(0);
    expect(r.installed).toBe(false);
    expect(r.stderr).toContain("does not name");
    expect(r.stderr).toContain("Nothing was extracted and nothing was installed.");
  });

  test("a release with no published checksum installs nothing", () => {
    const r = runInstall("no-checksum");
    expect(r.exitCode).not.toBe(0);
    expect(r.installed).toBe(false);
    expect(r.stderr).toContain("refusing to install an unverifiable binary");
  });
});

// ---------------------------------------------------------------------------
// EXECUTED: the pinned release, whose checksums the skill carries (RM-148).
// ---------------------------------------------------------------------------

const PINNED_TAG = installBlock().match(/^PINNED_TAG="(rmpc-v[\d.]+)"$/m)![1];
const PINNED_ARCHIVE = `rmpc-${PINNED_TAG.slice(5)}-linux-amd64.tar.gz`;

// The block as documented, TAG left to its default, on a linux-amd64 host
// served from a fixture release. `pinDigest` swaps the carried linux-amd64
// checksum for the fixture's, standing in for the real release's bytes.
function runPinned(kind: Release, opts: { pinDigest?: boolean; env?: Record<string, string>; host?: string } = {}) {
  const host = opts.host ?? "linux-amd64";
  const [os, arch] = host.split("-");
  const archive = `rmpc-${PINNED_TAG.slice(5)}-${host}.tar.gz`;
  const { base, dest } = fixture(kind, archive);
  let script = installBlock();
  const subs: Array<[RegExp, string]> = [
    [/^OS=.*$/m, `OS=${os}`],
    [/^ARCH=.*$/m, `ARCH=${arch}`],
    [/^BASE=.*$/m, `BASE="file://${base}"`],
    [/^install -m 755 rmpc .*$/m, 'install -m 755 rmpc "$RM_TEST_DEST/rmpc"'],
  ];
  if (opts.pinDigest) {
    const digest = createHash("sha256").update(readFileSync(join(base, archive))).digest("hex");
    subs.push([new RegExp(`^(  ${archive.replace(/\./g, "\\.")}\\) PINNED_SHA=)[0-9a-f]{64}`, "m"), `$1${digest}`]);
  }
  for (const [pattern, replacement] of subs) {
    if (!pattern.test(script)) throw new Error(`install block no longer has a line matching ${pattern}`);
    script = script.replace(pattern, replacement);
  }
  const proc = Bun.spawnSync(["sh", "-c", script], {
    env: { ...process.env, RMPC_TAG: "", ...opts.env, RM_TEST_DEST: dest },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: proc.exitCode, stderr: proc.stderr.toString(), installed: existsSync(join(dest, "rmpc")) };
}

describe("the pinned release, checked against the checksum the skill carries", () => {
  test("an archive matching the carried checksum installs, without fetching the release's .sha256", () => {
    const r = runPinned("no-checksum", { pinDigest: true });
    expect(r.exitCode, `pinned install failed:\n${r.stderr}`).toBe(0);
    expect(r.installed).toBe(true);
  });

  test("an archive replaced on the release, with a matching .sha256 beside it, fails the carried checksum", () => {
    const r = runPinned("good");
    expect(r.exitCode).not.toBe(0);
    expect(r.installed).toBe(false);
    expect(r.stderr).toContain("ChecksumMismatch");
    expect(r.stderr).toContain("Nothing was extracted and nothing was installed.");
  });

  test("RMPC_TAG installs another release, checked against that release's own .sha256", () => {
    const { base, dest } = fixture("good");
    const script = runnable(base).replace(/^TAG=.*$/m, 'TAG="${RMPC_TAG:-$PINNED_TAG}"');
    const proc = Bun.spawnSync(["sh", "-c", script], { env: { ...process.env, RMPC_TAG: TAG, RM_TEST_DEST: dest }, stdout: "pipe", stderr: "pipe" });
    expect(proc.exitCode, proc.stderr.toString()).toBe(0);
    expect(existsSync(join(dest, "rmpc"))).toBe(true);
  });

  test("a machine the pinned release has no build for stops before downloading", () => {
    const r = runPinned("good", { host: "freebsd-riscv64" });
    expect(r.exitCode).not.toBe(0);
    expect(r.installed).toBe(false);
    expect(r.stderr).toContain(`no ${PINNED_TAG} build for freebsd-riscv64; nothing was installed`);
  });
});
