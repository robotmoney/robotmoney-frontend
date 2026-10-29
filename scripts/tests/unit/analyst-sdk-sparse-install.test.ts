// Issue 1404 (analyst SDK requirements section 8): the package installs and runs
// alone. Exports ONLY packages/analyst-sdk's tracked files (git ls-files, no
// node_modules) into a fresh folder, installs from its own lockfile, and runs
// the real CLI as a process: the golden report byte for byte, relative paths
// from a folder below the package under `bun run`, and both provenance cases.
// No network: the package has no runtime dependency, so a production install
// fetches nothing (the full install with dev dependencies and the typecheck run
// in .github/workflows/analyst-sdk.yml).
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
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

  // Supplementary series (D79, issue 1513): the format and the pure reader import from the export, and the fetch
  // command refuses bad input before any request. The preload makes every HTTP client a thrower, so a request
  // would show up as "must not use the network" in stderr.
  test("supplementary: the exported names exist and the committed fixture reads through openSupplementary", async () => {
    const mod = await import(join(DIR, "src/input/supplementary.ts"));
    for (const name of ["supplementaryPaths", "parseSupplementaryCsv", "validateSupplementaryManifest", "openSupplementary"]) {
      expect(typeof mod[name], name).toBe("function");
    }
    const root = join(DIR, "tests/fixtures/supplementary");
    const walk = (d: string): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [relative(root, join(d, e.name))]));
    const files = {
      read: (p: string) => (existsSync(join(root, p)) ? new Uint8Array(readFileSync(join(root, p))) : null),
      list: () => walk(root),
    };
    const reader = mod.openSupplementary(files);
    expect(reader.list()).toEqual(["yahoo:GC=F"]);
    const got = reader.read("yahoo:GC=F");
    expect(got.manifest.series).toBe("yahoo:GC=F");
    expect(got.points).toHaveLength(got.manifest.row_count);
  });

  test("supplementary: bun bin/fetch.ts exits 2 with no source id and 1 inside a local copy, with no request", async () => {
    const fetch = (...args: string[]) => sh(["bun", "--preload", "./tests/no-network.ts", "bin/fetch.ts", ...args], DIR);
    const usage = await fetch("--into", join(DIR, "supp"));
    expect(usage.code, usage.stderr).toBe(2);
    expect(usage.stderr).toContain("at least one source id");
    const copy = join(DIR, "planted-copy");
    mkdirSync(join(copy, "csv/2026-10-19T202421Z"), { recursive: true });
    writeFileSync(join(copy, "csv/2026-10-19T202421Z/backup.json"), "{}");
    const inside = await fetch("--into", join(copy, "supp"), "yahoo:GC=F");
    expect(inside.code, inside.stderr).toBe(1);
    expect(inside.stderr).toContain("local copy");
    for (const r of [usage, inside]) expect(r.stderr).not.toContain("must not use the network");
    expect(existsSync(join(copy, "supp"))).toBe(false);
  });
});
