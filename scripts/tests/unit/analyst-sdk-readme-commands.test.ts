// Issue 1404: the analyst SDK README's quickstart is executed, not just linted,
// in an export of the package's tracked files.
//   - The `<!-- readme-test: acquire -->` blocks (the API-only fill, and the
//     repo-plus-increment fill, both `csvb backup --source api`, issue 1436) run
//     as one bash script against a local fake public API that serves the
//     committed recording of the REAL archive routes
//     (tests/fixtures/archive/api-recorded/, kept equal to the routes by
//     backend/tests/analyst-sdk-public-archive-recording.test.ts). csvb is this
//     checkout's packages/csvb (CSVB), and the copies are made in the export
//     (ARCHIVES), which is outside any checkout.
//   - Then the fake API is shut down, `API` points at a closed port, and every
//     `<!-- readme-test: run -->` line runs as written with a preload that
//     records and refuses any fetch: no stage after acquisition may make an
//     HTTP request, and the API sees no further request.
// Then the generated inputs and reports are checked, the two fills compared,
// and the explicit errors for missing or wrong inputs.
//
// Issue 1765 (AC 13): every ```ts block of the README runs too, after the
// acquisition (so `api-copy` exists). The line above each fence is a marker,
// `<!-- readme-test: ts prelude=<name> -->`, naming the prelude that defines
// the block's free variables from committed fixtures (PRELUDES below); a fence
// with no marker, or a marker naming no prelude, fails. Each block becomes one
// module in the export: the prelude, then the block verbatim, then a line that
// prints a sentinel. It runs with `bun --no-install` under the same
// fetch-throwing preload, and passes only on exit 0 with the sentinel printed,
// so a thrown error, a rejected promise or an early exit fails it, named by its
// README line. Bare '@robotmoney/analyst-sdk' imports resolve through the
// package's own exports map (self-reference), as they do for a client.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { exportPackage, sh } from "./support/analyst-sdk-export.ts";

setDefaultTimeout(180_000);
const root = join(import.meta.dir, "../../..");
const README_PATH = join(root, "packages/analyst-sdk/README.md");
const README = readFileSync(README_PATH, "utf8");

/** The text of every block with this marker, in order. */
export function readmeBlocks(text: string, marker: "run" | "acquire"): string[] {
  const re = new RegExp(`<!-- readme-test: ${marker} -->\\s*\\n\`\`\`sh\\n([\\s\\S]*?)\`\`\``, "g");
  return [...text.matchAll(re)].map((m) => m[1]!);
}

/** The command lines of every block marked to run, in order. */
export function readmeCommands(text: string): string[] {
  const out: string[] = [];
  const re = /<!-- readme-test: run -->\s*\n```sh\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    for (const line of m[1]!.split("\n")) {
      const cmd = line.replace(/\s+#.*$/, "").trim();
      if (cmd) out.push(cmd);
    }
  }
  return out;
}

/** One ```ts fence of a README: its opening line (1-based), the prelude its marker names (null with no marker), and its code. */
export interface TsBlock {
  line: number;
  prelude: string | null;
  code: string;
}

const TS_MARKER = /^<!-- readme-test: ts prelude=([a-z0-9-]+) -->$/;

/**
 * The 1-based line of every fence that opens a TypeScript block in any spelling
 * other than a bare ```ts line: ```typescript, ```tsx, an indented fence or
 * trailing text. readmeTsBlocks reads only bare ```ts fences, so each of these
 * would never run.
 */
export function strayTsFences(text: string): number[] {
  const out: number[] = [];
  text.split("\n").forEach((l, i) => {
    if (/^\s*```\s*(ts|tsx|typescript)\b/i.test(l) && l !== "```ts") out.push(i + 1);
  });
  return out;
}

/** Every ```ts fence of `text`, in order, with the marker on the line directly above it. */
export function readmeTsBlocks(text: string): TsBlock[] {
  const lines = text.split("\n");
  const out: TsBlock[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] !== "```ts") continue;
    const end = lines.indexOf("```", i + 1);
    if (end < 0) throw new Error(`line ${i + 1}: a \`\`\`ts fence is never closed`);
    const marker = i > 0 ? TS_MARKER.exec(lines[i - 1]!) : null;
    out.push({ line: i + 1, prelude: marker ? marker[1]! : null, code: lines.slice(i + 1, end).join("\n") });
    i = end;
  }
  return out;
}

// The committed fixtures the blocks' free variables come from. Written into the
// export as one module; each prelude imports it as `__fx`, so no prelude name
// can collide with a name a block imports.
const FIXTURES = `import { copyFileSync, readFileSync } from "node:fs";
import { MODELS, V5_INPUT_IDS, parseInput, portfolioDateAxis, ratiosFromLegs, requireComplete, resolveInputHistory, runRegime } from "@robotmoney/analyst-sdk";
import { readSupplementary } from "@robotmoney/analyst-sdk/node";

const HISTORY = "tests/fixtures/raw-indicator-history.csv";
// The supplementary files of the committed v5 golden fixture: the raw inputs of the v5 derived series.
const LEX = "tests/fixtures/lex-equity-golden/supplementary";
// The fixture's last day.
const LAST = "2026-08-15";

/** The README's own input file: the committed fixture, copied to \`to\`. */
export const historyFile = (to: string) => copyFileSync(HISTORY, to);

/** The committed fixture's history, the README's \`raw\`. */
export const raw = () => parseInput(readFileSync(HISTORY, "utf8")).history;

/** The run input of MODELS.v4: storage names resolved, each ratio set from its legs. */
export function v4Input() {
  const h = raw();
  return ratiosFromLegs(h, resolveInputHistory(h, MODELS.v4.seriesMapping, MODELS.v4.storedUnder));
}

/** The fixture plus the five raw inputs of the v5 derived series, cut at the fixture's last day. */
export function v5Raw() {
  const sources = {
    [V5_INPUT_IDS.deficit]: "fred:MTSDS133FMS", [V5_INPUT_IDS.gdp]: "fred:GDP", [V5_INPUT_IDS.vix3m]: "yahoo:^VIX3M",
    [V5_INPUT_IDS.skew]: "yahoo:^SKEW", [V5_INPUT_IDS.volume]: "yahoo-volume:^GSPC",
  };
  const out = raw();
  for (const [id, source] of Object.entries(sources)) out[id] = readSupplementary(LEX, source).points.filter((p) => p.date <= LAST);
  return out;
}

/** The two series a VIX term ratio reads, by source id. */
export const vixSupplementary = () => ({
  "yahoo:^VIX3M": readSupplementary(LEX, "yahoo:^VIX3M").points,
  "yahoo:^VIX": readSupplementary(LEX, "yahoo:^VIX").points,
});

// The fixture's price and cash series. It carries no GLD: gold futures (GC=F) stand in.
function series() {
  const h = raw();
  return { h, spx: h.SPX!, eth: h.ETH!, gld: h["yahoo:GC=F.adjclose"]!, spy: h["yahoo:SPY.adjclose"]!, tbillPercent: h.TBILL3M! };
}

/**
 * A regime run's axis and labels over the fixture, with gold, SPY and the cash
 * rate. The run ends on the cash rate's last day, so the block's bounded fill
 * (cash carried at most 4 days) holds on every day of the axis.
 */
export function portfolio() {
  const { h, gld, spy, tbillPercent } = series();
  const run = requireComplete(runRegime(h, { asof: tbillPercent.at(-1)!.date }));
  return { dateAxis: run.dateAxis, gld, spy, tbillPercent, labels: run.result.regime };
}

/** A calendar axis over the fixture, a fixed 50/30/20 target and its prices. */
export function drift() {
  const { spx, eth, tbillPercent } = series();
  const dateAxis = portfolioDateAxis("2022-01-03", LAST);
  return { dateAxis, schedule: dateAxis.map(() => ({ SPX: 0.5, ETH: 0.3, cash: 0.2 })), prices: { SPX: spx, ETH: eth }, tbillPercent };
}

/** The dates SPX, ETH and gold are all priced, their simple daily returns in that asset order, and their prices. */
export function markowitz() {
  const { spx, eth, gld, tbillPercent } = series();
  const prices = { SPX: spx, ETH: eth, GLD: gld };
  const byDate = Object.values(prices).map((s) => new Map(s.map((p) => [p.date, p.value])));
  const dateAxis = [...byDate[0]!.keys()].filter((d) => byDate.every((m) => m.has(d))).sort();
  const returns = new Map<string, number[]>();
  for (let i = 1; i < dateAxis.length; i++) returns.set(dateAxis[i]!, byDate.map((m) => m.get(dateAxis[i]!)! / m.get(dateAxis[i - 1]!)! - 1));
  return { spx, eth, gld, dateAxis, returns, tbillPercent, prices };
}
`;

/** Each prelude: the code that defines a block's free variables, by the name its marker gives. */
export const PRELUDES: Readonly<Record<string, string>> = {
  none: "",
  "history-file": `__fx.historyFile("my-history.csv");`,
  raw: "const raw = __fx.raw();",
  "raw-asof": `const raw = __fx.raw();\nconst asof = "2026-08-14";`,
  "v4-input": "const input = __fx.v4Input();",
  portfolio: "const { dateAxis, gld, spy, tbillPercent, labels } = __fx.portfolio();",
  drift: "const { dateAxis, schedule, prices, tbillPercent } = __fx.drift();",
  markowitz: "const { spx, eth, gld, dateAxis, returns, tbillPercent, prices } = __fx.markowitz();",
  "vix-supplementary": "const supplementary = __fx.vixSupplementary();",
  "v5-raw": "const raw = __fx.v5Raw();",
};

const SENTINEL = "readme-ts-block: ran to its end";

/** The module a block runs as: its prelude, the block verbatim, then the sentinel. */
export function blockModule(block: TsBlock, readmeName: string): string {
  return [
    `// ${readmeName} line ${block.line}: prelude ${block.prelude}, then the block verbatim.`,
    `import * as __fx from "./readme-fixtures.ts";`,
    PRELUDES[block.prelude!]!,
    `// ${readmeName} line ${block.line + 1} on:`,
    block.code,
    `console.log(${JSON.stringify(SENTINEL)});`,
    "",
  ].join("\n");
}

/**
 * Run each selected ```ts block of the README at `readmePath` in `dir`.
 * `selected` is the line of every block selected; `failures` says why each
 * one that did not run to its end failed, named by its README line.
 */
export async function runTsBlocks(readmePath: string, dir: string, select: (b: TsBlock) => boolean = () => true): Promise<{ selected: number[]; failures: string[] }> {
  const name = basename(readmePath);
  const failures: string[] = [];
  const blocks = readmeTsBlocks(readFileSync(readmePath, "utf8")).filter(select);
  for (const b of blocks) {
    const where = `${name}:${b.line}`;
    if (b.prelude === null) {
      failures.push(`${where}: the \`\`\`ts fence has no <!-- readme-test: ts prelude=<name> --> marker on the line above it`);
      continue;
    }
    if (!(b.prelude in PRELUDES)) {
      failures.push(`${where}: the marker names prelude ${JSON.stringify(b.prelude)}, which is not one of ${Object.keys(PRELUDES).join(", ")}`);
      continue;
    }
    const file = `readme-block-${name.replace(/[^A-Za-z0-9]+/g, "-")}-${b.line}.ts`;
    writeFileSync(join(dir, file), blockModule(b, name));
    const r = await sh(["bun", "--no-install", file], dir, { API: "http://127.0.0.1:9" });
    if (r.code !== 0 || !r.stdout.includes(SENTINEL)) {
      failures.push(`${where}: the block (prelude ${b.prelude}) exited ${r.code}${r.stdout.includes(SENTINEL) ? "" : " before its end"}\n${r.stderr.trim().split("\n").slice(-20).join("\n")}`);
    }
  }
  return { selected: blocks.map((b) => b.line), failures };
}

const DIR = exportPackage("rm-sdk-readme-");
afterAll(() => rmSync(DIR, { recursive: true, force: true }));
const ATTEMPTS = join(DIR, "network-attempts.log");
// Every `bun` process started in DIR loads this first (top-level bunfig preload).
writeFileSync(
  join(DIR, "tests/readme-no-network.ts"),
  `import { appendFileSync } from "node:fs";
globalThis.fetch = ((input: unknown) => {
  appendFileSync(${JSON.stringify(ATTEMPTS)}, String(input) + "\\n");
  throw new Error("README commands must not use the network after acquisition");
}) as unknown as typeof fetch;
`,
);
writeFileSync(join(DIR, "bunfig.toml"), `preload = ["./tests/readme-no-network.ts"]\n` + readFileSync(join(DIR, "bunfig.toml"), "utf8"));
writeFileSync(join(DIR, "readme-fixtures.ts"), FIXTURES);

const RECORDING = join(DIR, "tests/fixtures/archive/api-recorded");
// The README's csvb, from this checkout, and where its copies go (the export: outside any checkout).
const ENV = { CSVB: `bun run --cwd ${join(root, "packages/csvb")} csvb`, ARCHIVES: DIR };
const served: string[] = [];
const fake = Bun.serve({
  port: 0,
  fetch(req) {
    const path = new URL(req.url).pathname;
    served.push(path);
    const prefix = "/api/public/analytics/archive/";
    if (!path.startsWith(prefix)) return new Response("not found", { status: 404 });
    const rel = path.slice(prefix.length);
    const file = rel === "backups" ? join(RECORDING, "backups.json") : join(RECORDING, rel);
    if (rel.includes("..") || !existsSync(file)) return new Response("not found", { status: 404 });
    return new Response(readFileSync(file), { headers: { "Content-Type": rel.endsWith(".gz") ? "application/gzip" : "application/json" } });
  },
});
afterAll(() => fake.stop(true));

describe("README quickstart, executed", () => {
  const commands = readmeCommands(README);
  const acquire = readmeBlocks(README, "acquire");
  const results: { cmd: string; code: number; stdout: string; stderr: string }[] = [];
  let acquired = 0;

  test("the README marks the acquisition and quickstart blocks (red control: the extractor finds them)", () => {
    expect(acquire.length).toBe(2);
    // Issue 1436: the acquisition is csvb's API source, and the curl loop is gone.
    expect(acquire[0]).toContain("$CSVB backup --source api");
    expect(acquire[0]).toContain('CSVB="${CSVB:-bun run --cwd ../csvb csvb}"');
    for (const b of acquire) expect(b).not.toMatch(/\b(curl|jq|sha256sum)\b/);
    expect(README).not.toContain("curl -fsS --retry");
    expect(commands.length).toBeGreaterThanOrEqual(7);
    expect(commands.some((c) => c.startsWith("bun run inputs"))).toBe(true);
    expect(commands.some((c) => c.includes("--provenance"))).toBe(true);
    expect(readmeCommands("```sh\nbun run regime x\n```")).toEqual([]);
  });

  test("acquisition: the API-only fill and the repo-plus-increment fill, against the recorded real routes", async () => {
    expect(Bun.which("bash"), "bash is required by the README's fill").not.toBeNull();
    const i = await sh(["bun", "install", "--frozen-lockfile", "--production"], DIR);
    expect(i.code, i.stderr).toBe(0);
    const api = `http://127.0.0.1:${fake.port}`;
    const r = await sh(["bash", "-euo", "pipefail", "-c", acquire.join("\n")], DIR, { ...ENV, API: api });
    expect(r.code, r.stderr).toBe(0);
    acquired = served.length;
    const files = (dir: string) => Bun.spawnSync(["find", dir, "-type", "f"], { cwd: DIR }).stdout.toString().trim().split("\n").map((f) => f.slice(dir.length + 1)).sort();
    const recorded = files(RECORDING.slice(DIR.length + 1)).filter((f) => f !== "backups.json");
    expect(files("api-copy")).toEqual(recorded);
    expect(files("repo-copy")).toEqual(recorded);
    // The increment fetched only the backup the stand-in clone lacked.
    const fetchedData = served.filter((p) => p.includes("/data/"));
    expect(fetchedData.filter((p) => p.includes("2001-01-02T000000Z")).length).toBe(recorded.filter((f) => f.startsWith("csv/2001-01-02T000000Z/data/")).length);
    for (const f of recorded) expect(readFileSync(join(DIR, "api-copy", f)).equals(readFileSync(join(RECORDING, f)))).toBe(true);
  });

  test("acquisition refuses an archive that inflates past its record's bytes_raw, and keeps nothing of that backup", async () => {
    // Plant a record whose archive is the real one but whose bytes_raw is one byte short.
    const rec = readdirSync(join(RECORDING, "csv")).sort()[0]!;
    const recPath = `csv/${rec}/backup.json`;
    const record = JSON.parse(readFileSync(join(RECORDING, recPath), "utf8"));
    const f = Object.values(record.append_only as Record<string, { files: { path: string; bytes_raw: number }[] }>).flatMap((t) => t.files)[0]!;
    f.bytes_raw -= 1;
    const bad = join(DIR, "bad-recording");
    mkdirSync(join(bad, "csv", rec), { recursive: true });
    writeFileSync(join(bad, recPath), JSON.stringify(record));
    mkdirSync(join(bad, f.path, ".."), { recursive: true });
    writeFileSync(join(bad, f.path), readFileSync(join(RECORDING, f.path)));
    const srv = Bun.serve({
      port: 0,
      fetch(req) {
        const rel = new URL(req.url).pathname.slice("/api/public/analytics/archive/".length);
        const file = rel === "backups" ? undefined : join(bad, rel);
        if (rel === "backups") return Response.json({ backups: [{ backup: rec, record: recPath }], nextCursor: null });
        return file && existsSync(file) ? new Response(readFileSync(file)) : new Response("not found", { status: 404 });
      },
    });
    try {
      const fill = acquire[0]!.replace(/^fill api-copy$/m, "fill bad-copy");
      const r = await sh(["bash", "-euo", "pipefail", "-c", fill], DIR, { ...ENV, API: `http://127.0.0.1:${srv.port}` });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain(f.path);
      expect(existsSync(join(DIR, "bad-copy", "csv", rec))).toBe(false);
    } finally {
      srv.stop(true);
    }
  }, 60_000);

  test("every later command runs as written and exits 0, with no HTTP request", async () => {
    expect(acquired).toBeGreaterThan(0);
    fake.stop(true);
    for (const cmd of commands) {
      const r = await sh(["bash", "-c", cmd], DIR, { ...ENV, API: "http://127.0.0.1:9" });
      results.push({ cmd, ...r });
      expect(r.code, `${cmd}\n${r.stderr}`).toBe(0);
    }
    expect(existsSync(ATTEMPTS)).toBe(false);
    expect(served.length).toBe(acquired);
  });

  test("the commands produced the documented inputs and reports; both fills give the same input", () => {
    const run = "0f6b6c1e-6a52-4c39-9f4e-1a2b3c4d5ea2";
    for (const fill of ["api-fill", "repo-fill"]) {
      expect(readFileSync(join(DIR, fill, "inputs.csv"), "utf8").split("\n")[0]).toBe("date,series,value,kind");
      const m = JSON.parse(readFileSync(join(DIR, fill, "inputs.manifest.json"), "utf8"));
      expect(m).toMatchObject({ run_key: run, backup_id: "2001-01-03T000000Z", asof: "2026-08-15", source: "api" });
    }
    expect(readFileSync(join(DIR, "api-fill/inputs.csv")).equals(readFileSync(join(DIR, "repo-fill/inputs.csv")))).toBe(true);
    const out = (cmd: string) => results.find((r) => r.cmd === cmd)!;
    const report = JSON.parse(out("bun run regime api-fill/inputs.csv --replay --asof 2026-08-15").stdout);
    expect(report.asof).toBe("2026-08-15");
    expect(report.backtest).not.toBeNull();
    const env = JSON.parse(out("bun run regime api-fill/inputs.csv --replay --asof 2026-08-15 --provenance").stdout);
    expect(env.pinned).toBe(true);
    expect(env.manifest.run_key).toBe(run);
    expect(JSON.stringify(env.report)).toBe(JSON.stringify(report));
    expect(JSON.parse(out("bun run regime tests/fixtures/raw-indicator-history.csv --provenance").stdout).pinned).toBe(false);
  });

  test("missing or wrong inputs fail explicitly, with no acquisition attempt", async () => {
    const [noReplay, noFile, noRun, noArchive] = await Promise.all([
      sh(["bun", "run", "regime", "api-fill/inputs.csv"], DIR),
      sh(["bun", "run", "regime", "no-such-input.csv"], DIR),
      sh(["bun", "run", "inputs", "--archive", "api-copy", "--run", "00000000-0000-4000-8000-000000000000", "--out", "x"], DIR),
      sh(["bun", "run", "inputs", "--archive", "no-such-copy", "--run", "0f6b6c1e-6a52-4c39-9f4e-1a2b3c4d5ea2", "--out", "y"], DIR),
    ]);
    expect(noReplay.code).toBe(1);
    expect(noReplay.stderr).toMatch(/ReplayContractError/);
    expect(noFile.code).toBe(1);
    expect(noFile.stderr).toMatch(/no-such-input\.csv/);
    expect(noRun.code).toBe(1);
    expect(noRun.stderr).toMatch(/not in the local copy's run ledger/);
    expect(noArchive.code).toBe(1);
    expect(noArchive.stderr).toMatch(/is not a format 1 local copy/);
    expect(existsSync(ATTEMPTS)).toBe(false);
    expect(served.length).toBe(acquired);
  });
});

describe("README TypeScript blocks, executed against the package (issue 1765, AC 13)", () => {
  const blocks = readmeTsBlocks(README);

  test("every ```ts fence carries a marker naming a known prelude, and the extractor finds them all", () => {
    expect(blocks.length).toBe((README.match(/^```ts$/gm) ?? []).length);
    // No TypeScript block hides under another fence spelling the extractor skips.
    expect(strayTsFences(README)).toEqual([]);
    expect(blocks.length).toBeGreaterThanOrEqual(12);
    expect(blocks.filter((b) => b.prelude === null).map((b) => b.line)).toEqual([]);
    expect(blocks.filter((b) => !(b.prelude! in PRELUDES)).map((b) => `${b.line}: ${b.prelude}`)).toEqual([]);
    // Every prelude is used, so none drifts out of date unexercised.
    expect([...new Set(blocks.map((b) => b.prelude))].sort()).toEqual(Object.keys(PRELUDES).sort());
    // The lines are the README's own: the fence is at its line, the marker directly above.
    const lines = README.split("\n");
    for (const b of blocks) {
      expect(lines[b.line - 1]).toBe("```ts");
      expect(lines[b.line - 2]).toBe(`<!-- readme-test: ts prelude=${b.prelude} -->`);
    }
  });

  for (const b of blocks) {
    test(`README.md:${b.line} (prelude ${b.prelude}) runs to its end with no thrown error`, async () => {
      expect(existsSync(join(DIR, "api-copy")), "the acquisition test fills api-copy first").toBe(true);
      expect(await runTsBlocks(README_PATH, DIR, (x) => x.line === b.line)).toEqual({ selected: [b.line], failures: [] });
    }, 300_000);
  }

  test("red control: in a real README copy, a block that throws, one with an undefined name, an unmarked fence and an unknown prelude each fail, named by line", async () => {
    const planted = [
      "<!-- readme-test: ts prelude=none -->",
      "```ts",
      'import { MODELS } from "@robotmoney/analyst-sdk";',
      'if (MODELS.v4.id === "v4") throw new Error("planted failure");',
      "```",
      "",
      "<!-- readme-test: ts prelude=none -->",
      "```ts",
      "const n = notDefinedByAnyPrelude.length;",
      "```",
      "",
      "```ts",
      "const unmarked = 1;",
      "```",
      "",
      "<!-- readme-test: ts prelude=no-such-prelude -->",
      "```ts",
      "const unknown = 1;",
      "```",
      "",
      // The positive control: a planted block that runs to its end passes.
      "<!-- readme-test: ts prelude=raw -->",
      "```ts",
      'import { MODELS as M } from "@robotmoney/analyst-sdk";',
      'if (M.v4.id !== "v4" || raw.SPX === undefined) throw new Error("not reached");',
      "```",
      "",
    ].join("\n");
    const copy = join(DIR, "README.planted.md");
    writeFileSync(copy, `${README}\n${planted}`);
    const base = README.split("\n").length;
    const at = (i: number) => base + i + 1; // the README copy's line of planted line i (0-based)
    const fences = [1, 7, 11, 16, 21].map(at);
    const { selected, failures } = await runTsBlocks(copy, DIR, (b) => b.line > base);
    expect(selected).toEqual(fences);
    expect(failures.length).toBe(4);
    expect(failures[0]).toStartWith(`README.planted.md:${fences[0]}: the block (prelude none) exited 1 before its end`);
    expect(failures[0]).toContain("planted failure");
    expect(failures[1]).toStartWith(`README.planted.md:${fences[1]}: the block (prelude none) exited 1 before its end`);
    expect(failures[1]).toContain("ReferenceError");
    expect(failures[1]).toContain("notDefinedByAnyPrelude");
    expect(failures[2]).toStartWith(`README.planted.md:${fences[2]}: the \`\`\`ts fence has no <!-- readme-test: ts prelude=<name> --> marker`);
    expect(failures[3]).toStartWith(`README.planted.md:${fences[3]}: the marker names prelude "no-such-prelude"`);
    expect(failures.join("\n")).not.toContain(`README.planted.md:${fences[4]}:`);
  }, 300_000);

  test("red control: a TypeScript block under any other fence spelling is named by line", () => {
    const planted = ["```ts", "ok", "```", "```typescript", "x", "```", "```tsx", "x", "```", "  ```ts", "x", "  ```", "```ts ", "x", "```", "```TS", "x", "```", "```sh", "x", "```"].join("\n");
    expect(strayTsFences(planted)).toEqual([4, 7, 10, 13, 16]);
  });

  test("no block made an HTTP request", () => {
    expect(existsSync(ATTEMPTS)).toBe(false);
  });
});
