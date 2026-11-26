// Issue 1751 (gap 6): the publication rule, the canonical JSON, the
// regime-snapshots shaping and the per-indicator row detail live once, in
// packages/analyst-sdk/src/report/. Each backend module below must name the
// function in an import or re-export from that SDK file and must not declare
// it. A planted second copy is run through the same check and must be flagged.
//
// Issue 1765 (phase 1): the row builder (publishedRows, src/replay/rows.ts) and
// the snapshot column table (SNAPSHOT_COLUMNS) live once too. The backend
// reaches both through one shim (report/published-rows.ts). index.ts builds its
// rows with publishedRows and holds no row builder of its own: it no longer
// imports buildRichIndicators, which only the SDK's row builder calls.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "../../..");
const BA = "backend/src/analytics";
const SDK_REPORT = "packages/analyst-sdk/src/report";

interface Moved {
  /** Backend module, under backend/src/analytics. */
  file: string;
  /** SDK module, under packages/analyst-sdk/src/report. */
  sdk: string;
  /** Names the backend module must take from the SDK module (none when the row only forbids copies). */
  imported: string[];
  /** Names that must not be declared in the backend module (the imported ones are included). */
  notDeclared?: string[];
}

const MOVED: Moved[] = [
  { file: "cutover/ledger-current.ts", sdk: "publication.ts", imported: ["selectPublications"], notDeclared: ["publishesOver"] },
  { file: "report/regime-projection.ts", sdk: "regime-snapshots.ts", imported: ["rowToSnapshot", "forHistory", "computeRegimeSnapshotStaleness", "shapeRegimeSnapshots"] },
  { file: "output-snapshots.ts", sdk: "canonical.ts", imported: ["canonicalArtifactBytes"], notDeclared: ["canonicalStringify"] },
  { file: "run-ledger.ts", sdk: "canonical.ts", imported: ["canonicalStringify"], notDeclared: ["sortKeysDeep"] },
  { file: "report/published-rows.ts", sdk: "snapshot-columns.ts", imported: ["SNAPSHOT_COLUMNS"] },
  // The row builder and the indicator detail it writes are the SDK's alone (issue 1765).
  { file: "index.ts", sdk: "indicator-rows.ts", imported: [], notDeclared: ["buildSnapshotRows", "buildRichIndicators", "monthlySparkline", "keptRegimeRows", "publishedRows"] },
];

const withoutComments = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, "");

/** Names listed in `import { … } from` or `export { … } from` statements whose specifier ends in the SDK report module. */
function namesFromSdk(code: string, sdk: string): Set<string> {
  const names = new Set<string>();
  const re = /\b(?:import|export)\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    if (!m[2]!.endsWith(`/${SDK_REPORT}/${sdk}`)) continue;
    for (const part of m[1]!.split(",")) {
      const name = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]!.trim();
      if (name) names.add(name);
    }
  }
  return names;
}

const declares = (code: string, name: string): boolean => new RegExp(`\\b(?:function\\*?|const|let|var|class)\\s+${name}\\b`).test(code);

/** Why `text` is not a single-copy consumer of the SDK module, or [] when it is. */
export function oneCopyViolations(text: string, m: Moved): string[] {
  const code = withoutComments(text);
  const fromSdk = namesFromSdk(code, m.sdk);
  const found: string[] = [];
  for (const name of m.imported) if (!fromSdk.has(name)) found.push(`${m.file}: ${name} is not imported from ${SDK_REPORT}/${m.sdk}`);
  for (const name of [...m.imported, ...(m.notDeclared ?? [])]) if (declares(code, name)) found.push(`${m.file}: declares its own ${name}`);
  return found;
}

describe("issue 1751: the backend holds no second copy of the SDK report functions", () => {
  for (const m of MOVED) {
    const title = m.imported.length > 0 ? `${m.file} takes ${m.imported.join(", ")} from the SDK` : `${m.file} declares none of ${m.notDeclared!.join(", ")}`;
    test(title, () => {
      expect(oneCopyViolations(readFileSync(join(root, BA, m.file), "utf8"), m)).toEqual([]);
      const sdk = readFileSync(join(root, SDK_REPORT, m.sdk), "utf8");
      for (const name of m.imported) expect(sdk, name).toMatch(new RegExp(`^export (?:function|const) ${name}\\b`, "m"));
    });
  }

  test("index.ts builds its rows with publishedRows from the shim, and the shim re-exports the SDK's builder", () => {
    const code = withoutComments(readFileSync(join(root, BA, "index.ts"), "utf8"));
    expect(code).toMatch(/import\s*\{\s*publishedRows\s*\}\s*from\s*"\.\/report\/published-rows\.ts"/);
    // Both regime branches: the kept run and the recomputing run.
    expect(code.match(/\bpublishedRows\(/g)?.length).toBe(2);
    expect(code).not.toMatch(/indicator-rows\.ts|\bkeptRegimeRows\b/);
    const shim = withoutComments(readFileSync(join(root, BA, "report/published-rows.ts"), "utf8"));
    expect(shim).toMatch(/export\s*\{\s*publishedRows\b[^}]*\}\s*from\s*"(?:\.\.\/)+packages\/analyst-sdk\/src\/replay\/rows\.ts"/);
    expect(declares(shim, "publishedRows")).toBe(false);
    expect(readFileSync(join(root, "packages/analyst-sdk/src/replay/rows.ts"), "utf8")).toMatch(/^export function publishedRows\b/m);
  });

  test("report/projections.ts shapes its response with shapeRegimeSnapshots from the shim and declares none of it", () => {
    const code = withoutComments(readFileSync(join(root, BA, "report/projections.ts"), "utf8"));
    expect(code).toMatch(/import\s*\{[^}]*\bshapeRegimeSnapshots\b[^}]*\}\s*from\s*"\.\/regime-projection\.ts"/);
    expect(code).toMatch(/\bshapeRegimeSnapshots\(full, today, includeBacktest\)/);
    for (const name of ["shapeRegimeSnapshots", "rowToSnapshot", "forHistory", "computeRegimeSnapshotStaleness"]) expect(declares(code, name), name).toBe(false);
  });

  describe("red control: a planted second copy is flagged", () => {
    const m = MOVED[0]!;
    const sdkPath = `../../../../${SDK_REPORT}/publication.ts`;
    test("a clean consumer passes", () => {
      expect(oneCopyViolations(`import { selectPublications, type PublicationCandidate } from "${sdkPath}";\nexport { selectPublications };`, m)).toEqual([]);
      expect(oneCopyViolations(`// function selectPublications() lived here\nexport { selectPublications } from "${sdkPath}";`, m)).toEqual([]);
    });
    test("a local declaration is flagged, with or without the import", () => {
      expect(oneCopyViolations("export function selectPublications() { return new Map(); }", m).length).toBe(2);
      expect(oneCopyViolations(`import { selectPublications as sdk } from "${sdkPath}";\nconst selectPublications = sdk;`, m)).toEqual([`${m.file}: declares its own selectPublications`]);
      expect(oneCopyViolations(`import { selectPublications } from "${sdkPath}";\nfunction publishesOver() { return true; }`, m)).toEqual([`${m.file}: declares its own publishesOver`]);
    });
    test("an import from anywhere else is flagged", () => {
      expect(oneCopyViolations('import { selectPublications } from "./publication.ts";', m)).toEqual([`${m.file}: selectPublications is not imported from ${SDK_REPORT}/publication.ts`]);
    });
    test("a row builder declared in index.ts again is flagged", () => {
      const index = MOVED.find((x) => x.file === "index.ts")!;
      expect(oneCopyViolations('import { publishedRows } from "./report/published-rows.ts";\nconst rows = publishedRows(run);', index)).toEqual([]);
      expect(oneCopyViolations("function buildSnapshotRows(dateAxis, r2, r3) { return []; }", index)).toEqual(["index.ts: declares its own buildSnapshotRows"]);
    });
  });
});
