// REPOSITORY GUARD for issue 1444: an archive's identity is its content (the
// SHA-256 of its uncompressed canonical bytes), never the gzip encoder or the
// runtime (decision D72, docs/technical/analytics-requirements.md section 4.5).
//
// What it pins, against the real tree:
//   1. The encoder pin is gone from backend/ and packages/analyst-sdk/:
//      ARCHIVE_GZIP_FIXTURE_SHA256, encoderFixtureSha256, archiveEncoderMatches
//      and _setArchiveEncoderPinForTests appear nowhere.
//   2. No gzip-derived identity field (sha256_gz, bytes_gz) and no Bun or
//      container image version string is part of an archive's identity in the
//      archive store, the archive routes, or the SDK's archive reader.
//
//   3. Format 1 has one writer (issue 1477, D80): the row encoding, file naming,
//      stamp, part splitting and the backup cut rule are defined once, in
//      packages/analyst-sdk/src/archive, and nowhere in backend/src or
//      packages/csvb/src, which import them. The settle hour and the part size
//      the SDK declares (it installs alone, so it cannot import the contract)
//      equal the contract's ARCHIVE_SETTLE_MS and ARCHIVE_PART_BYTES.
//
// A guard that only ever passes is theatre, so the scanner is also run over a
// planted violation and must report it.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { ARCHIVE_PART_BYTES, ARCHIVE_SETTLE_MS } from "@robotmoney/contract";
import { MAX_PART_BYTES, SETTLE_MS } from "../../../packages/analyst-sdk/src/archive/format1.ts";

const repoRoot = join(import.meta.dir, "..", "..", "..");

const PIN_NAMES = ["ARCHIVE_GZIP_FIXTURE_SHA256", "encoderFixtureSha256", "archiveEncoderMatches", "_setArchiveEncoderPinForTests"];
// A gzip-derived identity field, or a Bun / oven-bun image version.
const IDENTITY_RE = /\b(?:sha256_gz|bytes_gz)\b|oven\/bun|\bbun[@: ]v?\d+\.\d+|\bBun v?\d+\.\d+/i;

function walk(dir: string): string[] {
  if (!statSync(dir, { throwIfNoEntry: false })) return [];
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name === ".git") return [];
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.(?:ts|tsx|json|md|ya?ml|sh|d\.ts)$/.test(name) ? [full] : [];
  });
}

function scan(root: string, dirs: string[], needles: (text: string) => string[]): string[] {
  const hits: string[] = [];
  for (const d of dirs) {
    const abs = join(root, d);
    const st = statSync(abs, { throwIfNoEntry: false });
    if (!st) throw new Error(`the guard scans ${d}, which does not exist`);
    for (const f of st.isFile() ? [abs] : walk(abs)) {
      const text = readFileSync(f, "utf8");
      for (const hit of needles(text)) hits.push(`${relative(root, f)}: ${hit}`);
    }
  }
  return hits;
}

const pinHits = (text: string) => PIN_NAMES.filter((n) => text.includes(n));
const identityHits = (text: string) => {
  const m = IDENTITY_RE.exec(text);
  return m ? [m[0]] : [];
};

const IDENTITY_FILES = [
  "backend/src/analytics/store/public-archive-store.ts",
  "backend/src/api/routes/public-analytics.ts",
  "packages/analyst-sdk/src/archive",
  "packages/analyst-sdk/bin/backups-dir.ts",
  "packages/analyst-sdk/bin/inputs.ts",
  "contract/src/schemas/public-analytics-archive-backup-record.schema.json",
  "contract/src/public-analytics.d.ts",
];

describe("archive identity is content, not the encoder", () => {
  test("no encoder pin exists under backend/ or packages/analyst-sdk/", () => {
    expect(scan(repoRoot, ["backend", "packages/analyst-sdk"], pinHits)).toEqual([]);
  });

  test("no gzip-derived field or Bun version is part of an archive's identity", () => {
    expect(scan(repoRoot, IDENTITY_FILES, identityHits)).toEqual([]);
  });

  test("red control: the scanners report a planted pin and a planted Bun version", () => {
    const tmp = mkdtempSync(join(tmpdir(), "archive-identity-guard-"));
    try {
      mkdirSync(join(tmp, "backend"), { recursive: true });
      writeFileSync(join(tmp, "backend", "x.ts"), "export const ARCHIVE_GZIP_FIXTURE_SHA256 = 'x'; // oven/bun:1.4.4\n");
      expect(scan(tmp, ["backend"], pinHits)).toEqual(["backend/x.ts: ARCHIVE_GZIP_FIXTURE_SHA256"]);
      expect(scan(tmp, ["backend"], identityHits)).toEqual(["backend/x.ts: oven/bun"]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ── 3. one definition of format 1's writer functions ─────────────────────────

const SHARED = [
  "encodeCsvRow",
  "parseCsvRow",
  "splitCsv",
  "startsNewPart",
  "parseDbTime",
  "stamp",
  "dataFileName",
  "DataFileNamer",
  "backupIdOfDay",
  "lastSealedDayMs",
  "firstBoundaryMs",
  "junctionApplies",
  "planCuts",
];
const DEFINITION_ROOTS = ["packages/analyst-sdk/src", "backend/src", "packages/csvb/src"];
const HOME = "packages/analyst-sdk/src/archive/";
// A module-level definition (exported or not): a function, a class, or a const/let/var. A local variable that
// happens to share a name (a block's `const stamp = ...` in backend/src/chain) is not a second writer.
const definitionHits = (text: string): string[] =>
  SHARED.filter((n) => new RegExp(`^(?:export\\s+)?(?:async\\s+)?(?:function\\*?\\s+${n}\\s*[<(]|class\\s+${n}\\b|(?:const|let|var)\\s+${n}\\s*[:=])`, "m").test(text)).map((n) => `defines ${n}`);

describe("format 1 has one writer", () => {
  test("every shared function is defined exactly once, in packages/analyst-sdk/src/archive", () => {
    const hits = scan(repoRoot, DEFINITION_ROOTS, definitionHits);
    expect(hits.filter((h) => !h.startsWith(HOME))).toEqual([]);
    for (const n of SHARED) expect(hits.filter((h) => h.endsWith(`defines ${n}`)), n).toEqual([`${HOME}format1.ts: defines ${n}`]);
  });

  test("the SDK's settle hour and part size equal the contract's", () => {
    expect(SETTLE_MS).toBe(ARCHIVE_SETTLE_MS);
    expect(MAX_PART_BYTES).toBe(ARCHIVE_PART_BYTES);
  });

  test("red control: a second definition in backend/src or packages/csvb/src is reported; an import is not", () => {
    const tmp = mkdtempSync(join(tmpdir(), "archive-one-writer-guard-"));
    try {
      mkdirSync(join(tmp, "backend", "src"), { recursive: true });
      mkdirSync(join(tmp, "packages", "csvb", "src"), { recursive: true });
      writeFileSync(join(tmp, "backend", "src", "x.ts"), "export function stamp(micros: bigint): string {\n  return String(micros);\n}\nconst backupIdOfDay = (d: number) => String(d);\n");
      writeFileSync(join(tmp, "packages", "csvb", "src", "y.ts"), "export const encodeCsvRow = (v: string[]) => v.join();\nclass DataFileNamer {}\n");
      writeFileSync(join(tmp, "packages", "csvb", "src", "z.ts"), 'import { encodeCsvRow, stamp } from "@robotmoney/analyst-sdk/src/archive/format1.ts";\nexport { encodeCsvRow, stamp };\nfunction f() {\n  const stamp = 1;\n  return stamp;\n}\n');
      expect(scan(tmp, ["backend/src", "packages/csvb/src"], definitionHits).sort()).toEqual([
        "backend/src/x.ts: defines backupIdOfDay",
        "backend/src/x.ts: defines stamp",
        "packages/csvb/src/y.ts: defines DataFileNamer",
        "packages/csvb/src/y.ts: defines encodeCsvRow",
      ]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
