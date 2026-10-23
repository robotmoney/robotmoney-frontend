// Issue 1404 (analyst SDK requirements section 7): the package installs and runs
// alone. Exports ONLY packages/analyst-sdk's tracked files (git ls-files, no
// node_modules) into a fresh folder, installs from its own lockfile, and runs
// the real CLI as a process: the golden report byte for byte, relative paths
// from a folder below the package under `bun run`, and both provenance cases.
// No network: the package has no runtime dependency, so a production install
// fetches nothing (the full install with dev dependencies and the typecheck run
// in .github/workflows/analyst-sdk.yml).
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { exportPackage, sh } from "./support/analyst-sdk-export.ts";

setDefaultTimeout(180_000);
const DIR = exportPackage("rm-sdk-sparse-");
afterAll(() => rmSync(DIR, { recursive: true, force: true }));
const GOLDEN = readFileSync(join(DIR, "tests/golden/regime-report.json"), "utf8");

describe("standalone install of packages/analyst-sdk", () => {
  test("the export holds only tracked package files, and installs from its lockfile", async () => {
    expect(existsSync(join(DIR, "node_modules"))).toBe(false);
    expect(existsSync(join(DIR, "bun.lock"))).toBe(true);
    const i = await sh(["bun", "install", "--frozen-lockfile", "--production"], DIR);
    expect(i.code, i.stderr).toBe(0);
  });

  test("the real CLI prints the golden bytes, from the package root and from a folder below it", async () => {
    const [a, b] = await Promise.all([
      sh(["bun", "run", "regime", "tests/fixtures/raw-indicator-history.csv"], DIR),
      sh(["bun", "run", "regime", "fixtures/raw-indicator-history.json"], join(DIR, "tests")),
    ]);
    expect(a.code, a.stderr).toBe(0);
    expect(a.stdout).toBe(GOLDEN);
    expect(b.code, b.stderr).toBe(0);
    expect(b.stdout).toBe(GOLDEN);
  });

  test("provenance: pinned false without a manifest; the recorded real-route API-only copy gives pinned true", async () => {
    const plain = await sh(["bun", "run", "regime", "tests/fixtures/raw-indicator-history.csv", "--provenance"], DIR);
    const e = JSON.parse(plain.stdout);
    expect(e.pinned).toBe(false);
    expect(JSON.stringify(e.report, null, 2) + "\n").toBe(GOLDEN);
    // The recording of the real public archive routes: no private repository access.
    const run = "0f6b6c1e-6a52-4c39-9f4e-1a2b3c4d5ea2";
    const gen = await sh(["bun", "run", "inputs", "--archive", "fixtures/archive/api-recorded", "--run", run, "--out", "../gen"], join(DIR, "tests"));
    expect(gen.code, gen.stderr).toBe(0);
    const env = await sh(["bun", "run", "regime", "gen/inputs.csv", "--replay", "--provenance"], DIR);
    expect(env.code, env.stderr).toBe(0);
    const p = JSON.parse(env.stdout);
    expect(p.pinned).toBe(true);
    expect(p.manifest).toMatchObject({ run_key: run, backup_id: "2001-01-03T000000Z", source: "api", code_revision: "4b4414c0e5a1d2f3b4c5d6e7f8091a2b3c4d5e6f" });
  });
});
