// Packaging smoke test (issue #884). D43 designs the eventual frontend/backend
// repo split around `contract/` as the only shared seam, "published/versioned
// per D10's original plan" — but until this issue, that publish path had never
// actually been exercised: no CI step packaged it, and nothing had ever
// installed the packaged artifact outside this monorepo and imported it. A
// package that only ever gets consumed via the in-repo `file:` dependency
// (see root package.json / backend/package.json) can silently accumulate a
// monorepo-relative import, a missing `files` entry, or a broken `main`/
// `exports` target for years without anyone noticing, because the in-repo
// path never resolves through the registry/tarball machinery real consumers
// (the eventual split repos) will use.
//
// Both tests below are self-contained: each does its own `bun pm pack` into a
// throwaway directory rather than sharing one pack across tests, so either can
// be understood (and fail) in isolation.
//
// Runs as part of `bun run test` (`bun test tests/unit`), which the `contract`
// job in .github/workflows/contract.yml already invokes on every pull_request,
// every push to main, and the nightly mirror — so "a CI job packages contract/
// and this succeeds without any monorepo-relative path error" (issue #884 AC2)
// is this test passing in that job, not a separate, untested claim.
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const contractRoot = join(import.meta.dir, "../..");
const repoRoot = join(contractRoot, "..");

async function packInto(destDir: string): Promise<string> {
  const proc = Bun.spawnSync(["bun", "pm", "pack", "--destination", destDir, "--quiet"], {
    cwd: contractRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(
    proc.exitCode,
    `bun pm pack failed: ${proc.stderr.toString()}`,
  ).toBe(0);
  const entries = (await readdir(destDir)).filter((n) => n.endsWith(".tgz"));
  expect(entries, `expected exactly one packed tarball in ${destDir}, found: ${entries.join(", ")}`).toHaveLength(1);
  return join(destDir, entries[0]);
}

describe("contract/ packages as a distributable artifact", () => {
  test("`bun pm pack` produces a non-empty, valid tarball containing the documented main export", async () => {
    const destDir = await mkdtemp(join(tmpdir(), "contract-pack-"));
    try {
      const tarball = await packInto(destDir);

      const size = (await stat(tarball)).size;
      expect(size, "packed tarball must not be empty").toBeGreaterThan(0);

      // Real gzip tarball, not just a non-empty file of the right name — and
      // it must actually carry package.json + the documented main/exports
      // entry point, not merely SOME files.
      const listing = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" });
      const files = listing.trim().split("\n");
      expect(files).toContain("package/package.json");
      expect(files).toContain("package/src/index.js");
      expect(files).toContain("package/src/index.d.ts");
    } finally {
      await rm(destDir, { recursive: true, force: true });
    }
  });

  test("installed from the tarball into a directory outside the monorepo, the package resolves its documented main export", async () => {
    const destDir = await mkdtemp(join(tmpdir(), "contract-pack-"));
    const scratch = await mkdtemp(join(tmpdir(), "contract-install-"));
    try {
      const tarball = await packInto(destDir);

      // Guard the isolation claim itself: a scratch dir that happened to sit
      // under the monorepo would make this test pass for the wrong reason
      // (resolving the in-repo copy instead of the packaged one).
      expect(scratch.startsWith(repoRoot), `scratch dir ${scratch} is not outside the monorepo (${repoRoot})`).toBe(
        false,
      );

      await writeFile(
        join(scratch, "package.json"),
        JSON.stringify({ name: "contract-install-smoke", version: "0.0.0", private: true, type: "module" }),
      );

      const add = Bun.spawnSync(["bun", "add", tarball], { cwd: scratch, stdout: "pipe", stderr: "pipe" });
      expect(add.exitCode, `installing the packaged tarball failed: ${add.stderr.toString()}`).toBe(0);

      // The documented main export (package.json's `exports["."]`/`main`):
      // ROUTES from "@robotmoney/contract", imported by bare specifier so
      // resolution goes through node_modules, not a relative/monorepo path.
      await writeFile(
        join(scratch, "run.mjs"),
        [
          'import { ROUTES } from "@robotmoney/contract";',
          "console.log(JSON.stringify({ hasRoutes: typeof ROUTES === \"object\" && ROUTES !== null }));",
        ].join("\n"),
      );
      const run = Bun.spawnSync(["bun", "run", "run.mjs"], { cwd: scratch, stdout: "pipe", stderr: "pipe" });
      expect(run.exitCode, `importing the installed package failed: ${run.stderr.toString()}`).toBe(0);
      expect(JSON.parse(run.stdout.toString())).toEqual({ hasRoutes: true });
    } finally {
      await rm(destDir, { recursive: true, force: true });
      await rm(scratch, { recursive: true, force: true });
    }
  });
});
