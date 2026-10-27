// Issue 1421: the original (pre-refactor) input and report fixtures are what
// every parity test compares against, so their provenance is itself tested.
// Each fixture's sha256 (on disk and of its content) must match manifest.json,
// every file in the directory must be listed there, every derived input must
// reproduce its recorded sha256, and the origin metadata must name the
// pre-refactor commit and the commands that produced the files. A changed or
// regenerated fixture is a red test, never a silent new baseline.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  ORIGINALS_DIR,
  VARIANTS,
  loadManifest,
  originalFile,
  sha256,
  variantCsv,
} from "./support/originals.ts";

const manifest = loadManifest();
const REPO_ROOT = join(import.meta.dir, "../../..");

describe("original fixture provenance", () => {
  test("origin metadata names the pre-refactor commit, the capture commands and the rule", () => {
    expect(manifest.origin.codeCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(manifest.origin.codeCommit).toBe("4b4414c0759305df046a2de511bb446070ee7057");
    expect(Number.isNaN(Date.parse(manifest.origin.capturedAt))).toBe(false);
    expect(manifest.origin.commands).toEqual([
      `cd packages/analyst-sdk && bun run scripts/capture-originals.ts ${manifest.origin.codeCommit}`,
      `cd backend && bun run scripts/capture-analytics-originals.ts ${manifest.origin.codeCommit}`,
    ]);
    expect(manifest.origin.rule).toMatch(/Never regenerate/);
  });

  test("every file in fixtures/originals is listed in the manifest, and every listed file exists", () => {
    const onDisk = readdirSync(ORIGINALS_DIR).filter((f) => f !== "manifest.json").sort();
    const listed = manifest.originals.map((o) => o.file).sort();
    expect(listed.length).toBe(1 + VARIANTS.length * 6);
    expect(onDisk).toEqual(listed);
    for (const v of VARIANTS) {
      for (const f of [originalFile.sdkReport(v), originalFile.sdkReportFull(v), originalFile.sharedAnalysis(v), originalFile.daily(v), originalFile.backendRows(v), originalFile.backendReport(v)]) {
        expect(listed, f).toContain(f);
      }
    }
    expect(listed).toContain(originalFile.anBehaviours);
  });

  for (const entry of manifest.originals) {
    test(`${entry.file}: file and content sha256, length and producer match the manifest`, () => {
      const gz = readFileSync(join(ORIGINALS_DIR, entry.file));
      expect(sha256(gz)).toBe(entry.fileSha256);
      const content = gunzipSync(gz);
      expect(sha256(content)).toBe(entry.contentSha256);
      expect(content.length).toBe(entry.byteLength);
      expect(entry.kind).toBe("report");
      expect(existsSync(join(REPO_ROOT, entry.producedBy)), entry.producedBy).toBe(true);
      expect(entry.describes.length).toBeGreaterThan(10);
    });
  }

  for (const v of VARIANTS) {
    test(`input variant ${v}: the derived CSV reproduces its recorded sha256`, () => {
      const csv = variantCsv(v);
      expect(sha256(csv)).toBe(manifest.inputs[v].contentSha256);
      expect(csv.split("\n").filter(Boolean).length - 1).toBe(manifest.inputs[v].rows);
    });
  }

  test("the production input is the committed fixture recorded in PROVENANCE.md", () => {
    const provenance = readFileSync(join(import.meta.dir, "fixtures/PROVENANCE.md"), "utf8");
    expect(provenance).toContain(`\`raw-indicator-history.csv\` sha256 \`${manifest.inputs.production.contentSha256}\``);
  });

  test("red control: one changed byte in a fixture's content changes its sha256", () => {
    const entry = manifest.originals[0]!;
    const content = gunzipSync(readFileSync(join(ORIGINALS_DIR, entry.file)));
    const mutated = Buffer.from(content);
    mutated[mutated.length - 2] = mutated[mutated.length - 2]! ^ 1;
    expect(sha256(mutated)).not.toBe(entry.contentSha256);
  });
});
