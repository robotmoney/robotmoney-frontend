// Issue 1404: the analyst SDK README's quickstart is executed, not just linted.
// Every ```sh block preceded by `<!-- readme-test: run -->` in
// packages/analyst-sdk/README.md runs line by line, as written, in an export of
// the package's tracked files, against its recorded format 1 local copies.
// Acquisition is over before these commands start (the copies are the recorded
// fills), so every process runs with a preload that records and refuses any
// fetch: an attempt fails the test. Then the generated inputs and reports are
// checked, and the explicit errors for missing or wrong inputs.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { exportPackage, sh } from "./support/analyst-sdk-export.ts";

setDefaultTimeout(180_000);
const root = join(import.meta.dir, "../../..");
const README = readFileSync(join(root, "packages/analyst-sdk/README.md"), "utf8");

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

describe("README quickstart, executed", () => {
  const commands = readmeCommands(README);
  const results: { cmd: string; code: number; stdout: string; stderr: string }[] = [];

  test("the README marks the quickstart blocks (red control: the extractor finds them)", () => {
    expect(commands.length).toBeGreaterThanOrEqual(7);
    expect(commands.some((c) => c.startsWith("bun run inputs"))).toBe(true);
    expect(commands.some((c) => c.includes("--provenance"))).toBe(true);
    expect(readmeCommands("```sh\nbun run regime x\n```")).toEqual([]);
  });

  test("every command runs as written and exits 0, with no network attempt", async () => {
    const i = await sh(["bun", "install", "--frozen-lockfile", "--production"], DIR);
    expect(i.code, i.stderr).toBe(0);
    for (const cmd of commands) {
      const r = await sh(["bash", "-c", cmd], DIR);
      results.push({ cmd, ...r });
      expect(r.code, `${cmd}\n${r.stderr}`).toBe(0);
    }
    expect(existsSync(ATTEMPTS)).toBe(false);
  });

  test("the commands produced the documented inputs and reports", () => {
    const facts = JSON.parse(readFileSync(join(DIR, "tests/fixtures/archive/facts.json"), "utf8"));
    const run = Object.keys(facts.runs)[1]!;
    for (const fill of ["api-fill", "repo-fill"]) {
      expect(readFileSync(join(DIR, fill, "inputs.csv"), "utf8").split("\n")[0]).toBe("date,series,value,kind");
      const m = JSON.parse(readFileSync(join(DIR, fill, "inputs.manifest.json"), "utf8"));
      expect(m).toMatchObject({ run_key: run, backup_id: facts.backup, asof: facts.runs[run].asof, source: "api" });
    }
    const out = (needle: string) => results.find((r) => r.cmd.includes(needle) && r.cmd.includes("regime"))!;
    const report = JSON.parse(results.find((r) => r.cmd === `bun run regime api-fill/inputs.csv --replay --asof ${facts.runs[run].asof}`)!.stdout);
    expect(report.asof).toBe(facts.runs[run].asof);
    expect(report.backtest).not.toBeNull();
    const env = JSON.parse(out("api-fill/inputs.csv --replay --asof 2026-08-15 --provenance").stdout);
    expect(env.pinned).toBe(true);
    expect(JSON.stringify(env.report)).toBe(JSON.stringify(report));
    const unpinned = JSON.parse(out("raw-indicator-history.csv --provenance").stdout);
    expect(unpinned.pinned).toBe(false);
  });

  test("missing or wrong inputs fail explicitly, with no acquisition attempt", async () => {
    const facts = JSON.parse(readFileSync(join(DIR, "tests/fixtures/archive/facts.json"), "utf8"));
    const run = Object.keys(facts.runs)[1]!;
    const [noReplay, noFile, noRun, noArchive] = await Promise.all([
      sh(["bun", "run", "regime", "api-fill/inputs.csv"], DIR),
      sh(["bun", "run", "regime", "no-such-input.csv"], DIR),
      sh(["bun", "run", "inputs", "--archive", "tests/fixtures/archive/api-only", "--run", "00000000-0000-4000-8000-000000000000", "--out", "x"], DIR),
      sh(["bun", "run", "inputs", "--archive", "no-such-copy", "--run", run, "--out", "y"], DIR),
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
  });
});
