// Issue 1513 (tunable backtests): the building blocks a client tunes a backtest
// with are exported from the package entry, src/index.ts, and return plain data.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sdk from "../src/index.ts";

describe("package entry exports the tunable building blocks", () => {
  test("markowitzBooks, markowitzSchedule, simulateDrift and periodStats are functions on the package entry", () => {
    for (const name of ["markowitzBooks", "markowitzSchedule", "simulateDrift", "periodStats"] as const) {
      expect(typeof sdk[name]).toBe("function");
    }
  });
  test("the solvers, the shrunk covariance, the linear algebra and the rest of the Markowitz workflow are exported too", () => {
    for (const name of [
      "markowitzSizing", "markowitzBacktest", "simulatePortfolio", "ercExact", "ercCertified", "minVarExact", "meanVarExact",
      "tangencyExact", "supports", "ercResidual", "minVarResidual", "meanVarResidual", "sharpeResidual", "annualCov",
      "shrinkToDiagonal", "shrunkCov", "covarianceMatrix", "correlationMatrix", "solveRefined", "UnsupportedError",
    ] as const) {
      expect(typeof sdk[name]).toBe("function");
    }
    expect([sdk.SHRINK, sdk.ERC_TOL, sdk.MIN_OBS, sdk.LAMBDA, sdk.ZERO_TOL]).toEqual([0.2, 4e-15, 252, 4, 1e-12]);
  });
  test("markowitzBooks returns plain data that survives a JSON round trip", () => {
    const rows = [[0.01, -0.02], [-0.005, 0.03], [0.002, 0.001], [0.004, -0.01]];
    const books = sdk.markowitzBooks({ returns: rows, assets: ["a", "b"], rf: 0.01, mu: { a: 0.06, b: 0.08 }, lambdas: [4] });
    expect(JSON.parse(JSON.stringify(books))).toEqual(books);
  });
});

// Issue 1655: the fill-policy and day-completeness API is on the package entry,
// and MAX_FORWARD_FILL_DAYS stays exported as the value every registry row declares.
describe("package entry exports the fill-policy and complete-day API", () => {
  test("fill policies, day completeness and the incomplete result are exported; MAX_FORWARD_FILL_DAYS stays 120", () => {
    for (const name of ["fillPolicyOf", "fillMaxAgeDays", "FillPolicyError", "latestCompleteDay", "missingOnDay", "requireComplete", "IncompleteDayError", "forwardFillAge"] as const) {
      expect(typeof sdk[name]).toBe("function");
    }
    expect(sdk.MAX_FORWARD_FILL_DAYS).toBe(120);
  });
});

// Issue 1554: the backtest client surface a client copies is on the package
// entry; forwardFillDaily and computeBacktestWithFill stay off it.
describe("package entry exports the backtest client helpers", () => {
  test("parsePlainDecimal, PLAIN_DECIMAL, referenceStrategies and REFERENCE_FILL_POLICIES are exported", () => {
    for (const name of ["parsePlainDecimal", "referenceStrategies"] as const) expect(typeof sdk[name]).toBe("function");
    expect(sdk.PLAIN_DECIMAL).toBeInstanceOf(RegExp);
    expect(Object.keys(sdk.REFERENCE_FILL_POLICIES)).toEqual(["spx", "eth", "tbill3m"]);
    expect(sdk.UNKNOWN_LABEL_RULE).toBe("refuse");
    expect(sdk.DEFAULT_SIMULATOR_FILL).toEqual({ kind: "forward", maxAgeDays: null, reason: "Reproduces the undeclared carry" });
    expect("forwardFillDaily" in sdk).toBe(false);
    expect("computeBacktestWithFill" in sdk).toBe(false);
  });
});

// Issue 1751: the options and building blocks a downstream regime model needs
// are on the package entry.
describe("package entry exports the downstream regime model surface (issue 1751)", () => {
  test("fitPanelWeights and weightedMeanOnDay are functions on the package entry", () => {
    for (const name of ["fitPanelWeights", "weightedMeanOnDay"] as const) expect(typeof sdk[name]).toBe("function");
  });
  test("the rules, the derived series, the report functions and the archive member read are exported", () => {
    for (const name of [
      "regimeRulesOf", "deriveSeries", "DerivedSeriesError", "StoredRatioOnlyError", "selectPublications", "publishesOver", "canonicalStringify",
      "shapeRegimeSnapshots", "rowToSnapshot", "forHistory", "computeRegimeSnapshotStaleness", "buildRichIndicators", "monthlySparkline",
      "runVintageMembers", "CalendarError", "calendarOf",
    ] as const) {
      expect(typeof sdk[name], name).toBe("function");
    }
    expect(Object.keys(sdk.REGIME_RULES)).toEqual(["v3", "v4", "v5"]);
    expect(sdk.REGIME_KNOWLEDGE_TIME).toEqual({ v3: false, v4: true, v5: false });
    expect(sdk.REGIME_OBSERVATION_WINDOWS).toEqual({ v3: false, v4: true, v5: false });
    expect(sdk.REGIME_MISSING_PANEL).toEqual({ v3: "rebase", v4: "nan", v5: "rebase" });
    expect(sdk.REGIME_LABEL_CUT).toEqual({ v3: "percentile", v4: "series", v5: "series" });
  });
});

// Issue 1753: methodology v5 and its kept record are on the package entry.
describe("package entry exports methodology v5 and the kept record (issue 1753)", () => {
  test("the kept-record functions and the building blocks they read are functions on the package entry", () => {
    for (const name of [
      "computeKeptRegime", "keptRegimeRows", "withDerivedSeries", "scoreDays", "fitDay", "keptDayOf", "walkForward", "deriveKeptRecord",
      "panelMean", "smoothRegimes", "bucketFn", "derivedInputIds", "seriesMappingFor", "storedUnderFor",
    ] as const) {
      expect(typeof sdk[name], name).toBe("function");
    }
  });
  test("the v5 declarations are exported: the line, the registry, the derived series and the backtest rules", () => {
    expect(sdk.REGIME_LINE).toEqual({ v3: "main", v4: "main", v5: "beside" });
    expect(sdk.BESIDE_REGIME_VERSIONS).toEqual(["v5"]);
    expect(sdk.REGIME_COMPOSITE_NORMALISATION).toEqual({ v3: "none", v4: "none", v5: "percentile" });
    expect(sdk.REGIME_KEPT_HISTORY).toEqual({ v3: false, v4: false, v5: true });
    expect(sdk.REGIME_REGISTRY.v4).toBe(sdk.INDICATORS);
    expect(sdk.REGIME_REGISTRY.v5).toBe(sdk.V5_INDICATORS);
    expect(sdk.REGIME_DERIVED_SERIES.v5).toBe(sdk.V5_DERIVED_SERIES);
    expect(Object.keys(sdk.REGIME_BACKTEST_RULES)).toEqual(["v3", "v4", "v5"]);
    expect(Object.keys(sdk.V5_INPUT_IDS)).toEqual(["deficit", "gdp", "vix3m", "vix", "skew", "volume", "close"]);
  });
});

// Issue 1765: the model value and the staged engine are on the package entry,
// with the model portfolio backtest's inputs moved out of bin/backtest.ts.
describe("package entry exports the model value, runModel and the stage cache (issue 1765)", () => {
  test("MODELS, modelOf, runModel and stageCache are on '.', with the stages and drivers they run", () => {
    for (const name of [
      "modelOf", "runModel", "stageCache", "stageKey", "inputDigest", "prepareModel", "scoreIndicators", "fitPanels", "refitDays", "combinePanels",
      "panelIndexSeries", "recomputeHistory", "keptHistory",
    ] as const) {
      expect(typeof sdk[name], name).toBe("function");
    }
    expect(Object.keys(sdk.MODELS)).toEqual(["v3", "v4", "v5"]);
    expect(sdk.modelOf("v4")).toBe(sdk.MODELS.v4);
    expect(sdk.STAGES).toEqual(["prepare", "score", "fit", "combine"]);
    const cache = sdk.stageCache();
    expect(cache.entries.size).toBe(0);
    expect(cache.misses).toEqual({ prepare: 0, score: 0, fit: 0, combine: 0 });
  });
  test("the model portfolio backtest's building blocks are on '.'", () => {
    for (const name of ["checkPortfolio", "checkBacktestOptions", "portfolioSeries", "backtestAxis", "portfolioFill", "portfolioDateAxis", "isDay", "PortfolioError"] as const) {
      expect(typeof sdk[name], name).toBe("function");
    }
    expect(sdk.CASH_RATE_NAMES).toContain("TBILL3M");
    expect(sdk.BACKTEST_FILL.kind).toBe("forward");
    expect(sdk.portfolioDateAxis("2026-01-30", "2026-02-02")).toEqual(["2026-01-30", "2026-01-31", "2026-02-01", "2026-02-02"]);
  });
});

// Issue 1765 (AC 12): the package's exports map. A temporary consumer whose
// node_modules/@robotmoney/analyst-sdk is a symlink to this package imports each
// entry by package name, the way a client does. Nothing is installed and nothing
// reaches the network (`bun --no-install`).
//   "."          src/index.ts, every documented building block
//   "./replay"   src/replay/index.ts
//   "./archive"  src/archive/index.ts, format 1 and the pure reader
//   "./node"     node/index.ts, the node:fs edge (never part of ".")
//   "./src/*"    the deep paths csvb imports, kept for one release
const PKG = join(import.meta.dir, "..");
const NAME = "@robotmoney/analyst-sdk";
const ENTRIES = [".", "./replay", "./archive", "./node", "./src/archive/format1.ts"] as const;
type Entry = (typeof ENTRIES)[number];

setDefaultTimeout(60_000);

async function runConsumer(dir: string, file: string, code: string): Promise<{ code: number; stdout: string; stderr: string }> {
  writeFileSync(join(dir, file), code);
  const p = Bun.spawn(["bun", "--no-install", file], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code: exit, stdout, stderr };
}

const specOf = (entry: Entry) => (entry === "." ? NAME : `${NAME}/${entry.slice(2)}`);

describe("the exports map resolves by package name from a temporary consumer (issue 1765)", () => {
  let dir = "";
  // Each entry's export names and the type of the names this test asserts, as the consumer saw them.
  let seen: { keys: Record<Entry, string[]>; kinds: Record<string, string>; sameReader: boolean; sameEncoder: boolean };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "analyst-sdk-consumer-"));
    mkdirSync(join(dir, "node_modules", "@robotmoney"), { recursive: true });
    symlinkSync(PKG, join(dir, "node_modules", "@robotmoney", "analyst-sdk"), "dir");
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "analyst-sdk-consumer", private: true, type: "module" }));
    const imports = ENTRIES.map((e, i) => `import * as m${i} from ${JSON.stringify(specOf(e))};`).join("\n");
    const r = await runConsumer(dir, "consumer.ts", `${imports}
const keys = { ${ENTRIES.map((e, i) => `${JSON.stringify(e)}: Object.keys(m${i}).sort()`).join(", ")} };
const kinds = {
  "./:runRegime": typeof m0.runRegime, "./:collectRunInputs": typeof m0.collectRunInputs,
  "./:runModel": typeof m0.runModel, "./:modelOf": typeof m0.modelOf, "./:stageCache": typeof m0.stageCache,
  "./replay:replayRun": typeof m1.replayRun,
  "./archive:collectRunInputs": typeof m2.collectRunInputs, "./archive:openArchive": typeof m2.openArchive, "./archive:encodeCsvRow": typeof m2.encodeCsvRow,
  "./node:openBackupsDir": typeof m3.openBackupsDir, "./node:supplementaryFiles": typeof m3.supplementaryFiles, "./node:sha256": typeof m3.sha256, "./node:universeFromFile": typeof m3.universeFromFile,
  "./src/archive/format1.ts:encodeCsvRow": typeof m4.encodeCsvRow,
};
const sameReader = m0.collectRunInputs === m2.collectRunInputs && m2.collectRunInputs === m3.collectRunInputs;
const sameEncoder = m2.encodeCsvRow === m4.encodeCsvRow;
console.log(JSON.stringify({ keys, kinds, sameReader, sameEncoder }));
`);
    if (r.code !== 0) throw new Error(`the consumer failed (exit ${r.code}): ${r.stderr}`);
    seen = JSON.parse(r.stdout);
  });
  afterAll(() => {
    if (!dir) return;
    // Remove the link to the package first, so the recursive removal can never reach the package itself.
    rmSync(join(dir, "node_modules", "@robotmoney", "analyst-sdk"), { force: true });
    rmSync(dir, { recursive: true, force: true });
  });

  test("'.', './replay', './archive', './node' and './src/*' each resolve and expose their building blocks", () => {
    for (const e of ENTRIES) expect(seen.keys[e].length, e).toBeGreaterThan(0);
    for (const [name, kind] of Object.entries(seen.kinds)) expect(kind, name).toBe("function");
    expect(Object.keys(seen.kinds)).toHaveLength(14);
  });

  test("'.' is src/index.ts and never carries the node:fs edge; './archive' and './node' share the one reader", () => {
    expect(seen.keys["."]).toEqual(Object.keys(sdk).sort());
    for (const name of ["openBackupsDir", "diskArchiveFiles", "supplementaryFiles", "writeSupplementary", "universeFromFile", "sha256"]) {
      expect(seen.keys["."], name).not.toContain(name);
      expect(seen.keys["./node"], name).toContain(name);
    }
    expect(seen.sameReader).toBe(true);
    expect(seen.sameEncoder).toBe(true);
  });

  test("an unlisted subpath fails to resolve, though the file is in the package", async () => {
    const unlisted = `${NAME}/bin/regime.ts`;
    expect(existsSync(join(PKG, "bin", "regime.ts"))).toBe(true);
    const r = await runConsumer(dir, "unlisted.ts", `
let resolved = "";
try { resolved = Bun.resolveSync(${JSON.stringify(unlisted)}, import.meta.dir); } catch (e) { resolved = "unresolved: " + (e as Error).message; }
let imported = "";
try { await import(${JSON.stringify(unlisted)}); imported = "imported"; } catch (e) { imported = "import failed: " + (e as Error).message; }
const listed = Bun.resolveSync(${JSON.stringify(`${NAME}/src/archive/format1.ts`)}, import.meta.dir);
console.log(JSON.stringify({ resolved, imported, listed }));
`);
    expect(r.code, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout) as { resolved: string; imported: string; listed: string };
    expect(out.resolved).toStartWith("unresolved: ");
    expect(out.imported).toStartWith("import failed: ");
    // The positive control: a listed deep path resolves into this package.
    expect(out.listed.endsWith(join("analyst-sdk", "src", "archive", "format1.ts"))).toBe(true);
  });
});

// The README's TypeScript blocks import from the package entry, either as
// "./src/index.ts" (run from the package folder) or by the bare package name.
// Every name they import that way is exported from ".". Imports from ./bin/ and
// from "./node" are left out: openBackupsDir reads files, so it is never in ".".
const README_ENTRY_SPECS = new Set(["./src/index.ts", NAME]);

/** Each import in the README's ```ts blocks: its specifier and its named imports (type-only names marked). */
function readmeImports(markdown: string): { spec: string; names: { name: string; type: boolean }[] }[] {
  const out: { spec: string; names: { name: string; type: boolean }[] }[] = [];
  for (const block of markdown.matchAll(/^```ts\n([\s\S]*?)^```/gm)) {
    for (const m of block[1]!.matchAll(/^import\s+(type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/gm)) {
      const names = m[2]!.split(",").map((n) => n.trim()).filter(Boolean).map((n) => {
        const type = Boolean(m[1]) || n.startsWith("type ");
        const name = n.replace(/^type\s+/, "").split(/\s+as\s+/)[0]!.trim();
        return { name, type };
      });
      out.push({ spec: m[3]!, names });
    }
  }
  return out;
}

/** The README names imported from the package entry that "." does not export. */
function missingFromEntry(markdown: string, entryValues: ReadonlySet<string>, entrySource: string): string[] {
  const missing: string[] = [];
  for (const { spec, names } of readmeImports(markdown)) {
    if (!README_ENTRY_SPECS.has(spec)) continue;
    for (const { name, type } of names) {
      const ok = type ? new RegExp(`\\b${name}\\b`).test(entrySource) : entryValues.has(name);
      if (!ok) missing.push(`${spec}: ${name}`);
    }
  }
  return missing;
}

describe("every name the README imports from the package entry is exported from '.' (issue 1765)", () => {
  const readme = readFileSync(join(PKG, "README.md"), "utf8");
  const entrySource = readFileSync(join(PKG, "src", "index.ts"), "utf8");
  const values = new Set(Object.keys(sdk));

  test("the README's blocks import from the entry both ways, and every such name is exported", () => {
    const fromEntry = readmeImports(readme).filter((i) => README_ENTRY_SPECS.has(i.spec));
    expect(fromEntry.some((i) => i.spec === "./src/index.ts")).toBe(true);
    expect(fromEntry.some((i) => i.spec === NAME)).toBe(true);
    expect(fromEntry.flatMap((i) => i.names).length).toBeGreaterThanOrEqual(20);
    expect(missingFromEntry(readme, values, entrySource)).toEqual([]);
  });

  test("red control: a planted README block naming a missing export is flagged; bin/ and ./node imports are skipped", () => {
    const planted = [
      "```ts",
      `import { runRegime, notAnExport } from "${NAME}";`,
      'import {\n  collectRunInputs,\n  alsoMissing,\n} from "./src/index.ts";',
      'import { openBackupsDir } from "./bin/backups-dir.ts";',
      `import { openBackupsDir as open } from "${NAME}/node";`,
      "```",
      "",
    ].join("\n");
    expect(missingFromEntry(planted, values, entrySource)).toEqual([`${NAME}: notAnExport`, "./src/index.ts: alsoMissing"]);
    expect(readmeImports(planted).map((i) => i.spec)).toEqual([NAME, "./src/index.ts", "./bin/backups-dir.ts", `${NAME}/node`]);
  });
});
