#!/usr/bin/env bun
// Cross-repo shared-fixture drift check — the FRONTEND half (§9A R4, AC-FMT-01).
//
// WHY THIS EXISTS AT ALL. The nine (now eleven) consensus-receipt fixtures in
// contract/src/__fixtures__ are a CROSS-REPO pin: robotmoney-core carries the
// same bytes under tests/fixtures/, and the whole point of the artifact is that
// two independent implementations reproduce identical canonical bytes and an
// identical anchored digest. Nothing in this repo checked that. The contract
// suite re-derives the goldens from the fixtures next to them, so editing a
// fixture and its golden in one commit is green here by construction — which is
// precisely how core sat at v0.4.0-rc.3 with eight of the nine shared fixtures
// drifted away from this repo while BOTH repos' CI stayed green
// (fusion-evidence/20260913T-run1/phase3/3.1-core-ci-fixture-check-GREEN-while-drifted.txt).
// Core has since grown its own mirror of this check against a manifest vendored
// from HERE. This file is the other half: without it the pin is one-sided, and
// a one-sided edit landed in THIS repo is still green everywhere.
//
// WHAT MAKES IT NOT SELF-REFERENTIAL. It compares the bytes on disk against
// shared-fixtures/vendored/robotmoney-core.manifest.json, a manifest this repo
// does not author: it is generated from robotmoney-core's own tests/fixtures/
// at a pinned commit recorded inside it. A fixture edit here can only be made
// green by re-vendoring from core at a NEW pinned commit, which is exactly the
// coordinated cross-repo release the process requires. Hand-editing a sha256
// row is the one move that defeats this check, so don't: the manifest carries
// that instruction in its own $comment, and re-vendoring is one command.
//
// EXTRA files are drift too, not a free-for-all. A `consensus-receipt.*` file
// that appears here and was never promoted through the release process is the
// same asymmetry in the other direction, so the manifest names the frontend-only
// fixtures explicitly (frontend_only_not_shared) and anything else is an error.
//
// Usage:
//   bun scripts/fusion/check-cross-repo-fixture-drift.ts [--fixtures-dir DIR] [--manifest FILE]
//   bun scripts/fusion/check-cross-repo-fixture-drift.ts --regenerate --core PATH [--core-ref REF]
//
// The exit code IS the verdict: 0 clean, 1 drift. Wired into
// .github/workflows/fusion-cross-repo-drift.yml, and executed against a planted
// drifted tree by scripts/fusion/test-cross-repo-fixture-drift.sh (C-21: an
// exit code is not evidence until the script has been shown to go red).
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const DEFAULT_FIXTURES = join(REPO_ROOT, "contract/src/__fixtures__");
const DEFAULT_MANIFEST = join(REPO_ROOT, "shared-fixtures/vendored/robotmoney-core.manifest.json");
const CORE_FIXTURE_DIR = "tests/fixtures";

interface Row {
  file: string;
  byte_length: number;
  sha256: string;
  pending_core_adoption?: boolean;
}
interface Manifest {
  core_repo: string;
  core_fixture_dir: string;
  core_ref: string;
  core_commit: string;
  frontend_fixture_dir: string;
  frontend_only_not_shared: string[];
  files: Row[];
  [k: string]: unknown;
}

const sha256 = (b: Uint8Array) => "0x" + createHash("sha256").update(b).digest("hex");

function loadManifest(path: string): Manifest {
  if (!existsSync(path)) {
    console.error(`vendored manifest is missing: ${path}`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(path, "utf8")) as Manifest;
}

type Status = "ok" | "DRIFTED" | "MISSING" | "EXTRA" | "PENDING-CORE";
type Line = { file: string; status: Status; expected: string; actual: string };

function compare(fixturesDir: string, manifest: Manifest): { errors: string[]; lines: Line[] } {
  const errors: string[] = [];
  const lines: Line[] = [];
  const named = new Set(manifest.files.map((r) => r.file));

  for (const row of manifest.files) {
    const path = join(fixturesDir, row.file);
    const pending = row.pending_core_adoption === true;
    if (!existsSync(path) || !statSync(path).isFile()) {
      lines.push({ file: row.file, status: "MISSING", expected: row.sha256, actual: "-" });
      errors.push(`${row.file}: named by the vendored core manifest but absent from ${fixturesDir}`);
      continue;
    }
    const payload = readFileSync(path);
    const actual = sha256(payload);
    if (actual !== row.sha256) {
      lines.push({ file: row.file, status: "DRIFTED", expected: row.sha256, actual });
      errors.push(
        `${row.file}: sha256 ${actual}, robotmoney-core @ ${manifest.core_commit.slice(0, 12)} has ${row.sha256}`,
      );
      continue;
    }
    // Length is checked SEPARATELY from the digest even though a digest match
    // already implies it: the manifest is meant to be readable by a human
    // reviewing a coordinated release, and a row whose byte_length disagrees
    // with its own sha256 is a corrupt manifest, not a clean fixture.
    if (payload.length !== row.byte_length) {
      lines.push({ file: row.file, status: "DRIFTED", expected: String(row.byte_length), actual: String(payload.length) });
      errors.push(`${row.file}: ${payload.length} bytes, vendored manifest records ${row.byte_length}`);
      continue;
    }
    lines.push({ file: row.file, status: pending ? "PENDING-CORE" : "ok", expected: row.sha256, actual });
  }

  const frontendOnly = new Set(manifest.frontend_only_not_shared ?? []);
  for (const name of readdirSync(fixturesDir).sort()) {
    if (!name.startsWith("consensus-receipt.")) continue;
    if (named.has(name) || frontendOnly.has(name)) continue;
    lines.push({ file: name, status: "EXTRA", expected: "-", actual: sha256(readFileSync(join(fixturesDir, name))) });
    errors.push(
      `${name}: present in ${fixturesDir} but named by neither the vendored core manifest nor frontend_only_not_shared`,
    );
  }
  return { errors, lines };
}

function printTable(lines: Line[], manifest: Manifest): void {
  const width = Math.max(10, ...lines.map((l) => l.file.length));
  console.log(`cross-repo shared fixtures vs robotmoney-core @ ${manifest.core_commit} (${manifest.core_ref})`);
  console.log(`${"fixture".padEnd(width)}  ${"status".padEnd(12)}  expected sha256 / actual sha256`);
  console.log("-".repeat(width + 62));
  for (const l of lines) {
    console.log(`${l.file.padEnd(width)}  ${l.status.padEnd(12)}  ${l.expected}`);
    if (l.status === "DRIFTED" || l.status === "MISSING" || l.status === "EXTRA") {
      console.log(`${" ".padEnd(width)}  ${" ".padEnd(12)}  ${l.actual}   <-- on disk`);
    }
  }
}

function regenerate(core: string, ref: string, manifestPath: string, fixturesDir: string): number {
  const manifest = loadManifest(manifestPath);
  const rev = Bun.spawnSync(["git", "-C", core, "rev-parse", `${ref}^{commit}`]);
  if (rev.exitCode !== 0) {
    console.error(`git rev-parse ${ref} failed in ${core}: ${rev.stderr.toString()}`);
    return 1;
  }
  const files: Row[] = [];
  for (const row of manifest.files) {
    const blob = Bun.spawnSync(["git", "-C", core, "show", `${ref}:${CORE_FIXTURE_DIR}/${row.file}`]);
    if (blob.exitCode !== 0) {
      // Not yet adopted in core: pin OUR bytes and say so on every run, rather
      // than claiming a cross-repo comparison that was never made.
      const local = readFileSync(join(fixturesDir, row.file));
      files.push({ file: row.file, byte_length: local.length, sha256: sha256(local), pending_core_adoption: true });
      continue;
    }
    const payload = blob.stdout;
    files.push({ file: row.file, byte_length: payload.length, sha256: sha256(payload) });
  }
  manifest.core_commit = rev.stdout.toString().trim();
  manifest.core_ref = ref;
  manifest.files = files;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`re-vendored ${files.length} rows from ${core} @ ${ref} (${manifest.core_commit})`);
  return 0;
}

function main(argv: string[]): number {
  let fixturesDir = DEFAULT_FIXTURES;
  let manifestPath = DEFAULT_MANIFEST;
  let doRegenerate = false;
  let core: string | null = null;
  let coreRef = "HEAD";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--fixtures-dir") fixturesDir = resolve(argv[++i]!);
    else if (a === "--manifest") manifestPath = resolve(argv[++i]!);
    else if (a === "--regenerate") doRegenerate = true;
    else if (a === "--core") core = resolve(argv[++i]!);
    else if (a === "--core-ref") coreRef = argv[++i]!;
    else {
      console.error(`unknown argument: ${a}`);
      return 2;
    }
  }

  if (doRegenerate) {
    if (!core) {
      console.error("--regenerate needs --core PATH (a robotmoney-core checkout)");
      return 2;
    }
    return regenerate(core, coreRef, manifestPath, fixturesDir);
  }

  const manifest = loadManifest(manifestPath);
  const { errors, lines } = compare(fixturesDir, manifest);
  printTable(lines, manifest);
  const pending = lines.filter((l) => l.status === "PENDING-CORE").map((l) => l.file);
  if (pending.length) {
    console.log(
      `\nNOTE: ${pending.length} row(s) are frontend-authored and not yet cross-checked against robotmoney-core: ${pending.join(", ")}`,
    );
  }
  if (errors.length) {
    console.error("\ncross-repo fixture drift:");
    for (const e of errors) console.error(`  - ${e}`);
    console.error(
      "\nResolve through the coordinated cross-repo release process — re-vendor from a" +
        "\nrobotmoney-core commit that already carries the new bytes:" +
        "\n  bun scripts/fusion/check-cross-repo-fixture-drift.ts --regenerate --core <core checkout> --core-ref <tag>" +
        "\nNever by hand-editing a sha256 row to match whichever side changed.",
    );
    return 1;
  }
  console.log(`\nok: ${lines.length} shared fixtures are byte-identical to robotmoney-core @ ${manifest.core_commit.slice(0, 12)}`);
  return 0;
}

process.exit(main(process.argv.slice(2)));
