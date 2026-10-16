// D54 (issue #1026 W7, criterion 158): CI fails when contract/src/routes.js
// changes without a contract version bump against the merge base.
//
// Every case runs the REAL script as a process (the thing contract.yml runs)
// inside a throwaway git repository, so what is graded is its exit code and
// message against real `git diff` / `git merge-base` answers — not a mocked
// diff. The three base-resolution paths CI uses (explicit --base, a push
// event's `before`, a pull_request's GITHUB_BASE_REF) each get a case.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..", "..");
const SCRIPT = join(repoRoot, "scripts/check-contract-version-bump.ts");

const scratch: string[] = [];
afterAll(() => { for (const d of scratch) rmSync(d, { recursive: true, force: true }); });

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(
    ["git", "-c", "user.email=test@example.invalid", "-c", "user.name=test", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args],
    { cwd, stdout: "pipe", stderr: "pipe" },
  );
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

/** A repo whose `main` has contract 0.1.0 with one route, and a `feature` branch checked out. */
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "contract-version-bump-"));
  scratch.push(dir);
  git(dir, "init", "-q", "-b", "main");
  mkdirSync(join(dir, "contract/src"), { recursive: true });
  writeFileSync(join(dir, "contract/package.json"), JSON.stringify({ name: "@robotmoney/contract", version: "0.1.0" }, null, 2));
  writeFileSync(join(dir, "contract/src/routes.js"), 'export const ROUTES = { health: "/health" };\n');
  writeFileSync(join(dir, "README.md"), "x\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  git(dir, "checkout", "-q", "-b", "feature");
  return dir;
}

function editRoutes(dir: string): void {
  writeFileSync(join(dir, "contract/src/routes.js"), 'export const ROUTES = { health: "/health", apiVersion: "/api/version" };\n');
}

function setVersion(dir: string, version: string): void {
  writeFileSync(join(dir, "contract/package.json"), JSON.stringify({ name: "@robotmoney/contract", version }, null, 2));
}

function commitAll(dir: string, msg: string): string {
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", msg);
  return git(dir, "rev-parse", "HEAD");
}

/** Run the script with no ambient GitHub context unless the case supplies one. */
function run(dir: string, args: string[] = [], env: Record<string, string> = {}): { code: number; out: string } {
  const base: Record<string, string | undefined> = { ...process.env };
  for (const k of ["GITHUB_EVENT_NAME", "GITHUB_EVENT_PATH", "GITHUB_BASE_REF"]) delete base[k];
  const r = Bun.spawnSync(["bun", SCRIPT, ...args], { cwd: dir, env: { ...base, ...env }, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
}

describe("routes.js against the merge base", () => {
  test("changed without a bump fails, naming both versions", () => {
    const dir = repo();
    editRoutes(dir);
    commitAll(dir, "add a route");
    const { code, out } = run(dir, ["--base", "main"]);
    expect(code).toBe(1);
    expect(out).toContain("contract/src/routes.js changed");
    expect(out).toContain("0.1.0 is not greater than the base's 0.1.0");
  });

  test("changed with a bump passes", () => {
    const dir = repo();
    editRoutes(dir);
    setVersion(dir, "0.2.0");
    commitAll(dir, "add a route, bump");
    const { code, out } = run(dir, ["--base", "main"]);
    expect({ code, out }).toEqual({ code: 0, out: expect.stringContaining("bumped 0.1.0 -> 0.2.0") });
  });

  test("unchanged passes, whatever the version did", () => {
    const dir = repo();
    writeFileSync(join(dir, "README.md"), "y\n");
    commitAll(dir, "docs only");
    const { code, out } = run(dir, ["--base", "main"]);
    expect(code).toBe(0);
    expect(out).toContain("unchanged");
  });

  test("a lowered version fails", () => {
    const dir = repo();
    editRoutes(dir);
    setVersion(dir, "0.0.9");
    commitAll(dir, "add a route, lower the version");
    const { code, out } = run(dir, ["--base", "main"]);
    expect(code).toBe(1);
    expect(out).toContain("0.0.9");
    expect(out).toContain("0.1.0");
  });

  test("a prerelease of the same version is not a bump (semver orders it lower)", () => {
    const dir = repo();
    editRoutes(dir);
    setVersion(dir, "0.1.0-rc.1");
    commitAll(dir, "prerelease");
    expect(run(dir, ["--base", "main"]).code).toBe(1);
  });

  test("the working tree counts: an uncommitted routes edit is seen before it is committed", () => {
    const dir = repo();
    editRoutes(dir);
    expect(run(dir, ["--base", "main"]).code).toBe(1);
    setVersion(dir, "0.1.1");
    expect(run(dir, ["--base", "main"]).code).toBe(0);
  });

  test("measured against the merge base: a bump made on main after the branch was cut is not this branch's", () => {
    // The branch bumps once and edits routes twice; meanwhile main moves on
    // with its own bump. Against the merge base the branch's one bump covers
    // both of its edits; against main's tip it would read as unbumped.
    const dir = repo();
    editRoutes(dir);
    setVersion(dir, "0.2.0");
    commitAll(dir, "first route edit + bump");
    writeFileSync(join(dir, "contract/src/routes.js"), 'export const ROUTES = { health: "/health", apiVersion: "/api/version", other: "/api/x" };\n');
    commitAll(dir, "second route edit, no second bump");
    git(dir, "checkout", "-q", "main");
    setVersion(dir, "0.3.0");
    commitAll(dir, "main moves on");
    git(dir, "checkout", "-q", "feature");
    const { code, out } = run(dir, ["--base", "main"]);
    expect(code).toBe(0);
    expect(out).toContain("0.1.0 -> 0.2.0");
  });
});

describe("base resolution in CI", () => {
  test("pull_request: GITHUB_BASE_REF resolves through origin/<base>", () => {
    const dir = repo();
    git(dir, "update-ref", "refs/remotes/origin/main", git(dir, "rev-parse", "main"));
    editRoutes(dir);
    commitAll(dir, "unbumped");
    expect(run(dir, [], { GITHUB_EVENT_NAME: "pull_request", GITHUB_BASE_REF: "main" }).code).toBe(1);
    setVersion(dir, "0.1.1");
    commitAll(dir, "bumped");
    expect(run(dir, [], { GITHUB_EVENT_NAME: "pull_request", GITHUB_BASE_REF: "main" }).code).toBe(0);
  });

  test("push: the event's before SHA is the base", () => {
    const dir = repo();
    setVersion(dir, "0.2.0");
    editRoutes(dir);
    const before = commitAll(dir, "an earlier, bumped push");
    writeFileSync(join(dir, "contract/src/routes.js"), 'export const ROUTES = { health: "/health", late: "/api/late" };\n');
    commitAll(dir, "this push: unbumped");
    const event = join(dir, "..", `${dir.split("/").pop()}-event.json`);
    writeFileSync(event, JSON.stringify({ before }));
    scratch.push(event);
    const { code, out } = run(dir, [], { GITHUB_EVENT_NAME: "push", GITHUB_EVENT_PATH: event });
    expect(code).toBe(1);
    expect(out).toContain("0.2.0 is not greater than the base's 0.2.0");
  });

  test("a base that cannot be found exits 2, never 0", () => {
    const dir = repo();
    editRoutes(dir);
    commitAll(dir, "unbumped");
    // No origin/main in this repo, and no GitHub context: the default base is
    // unresolvable, which must not read as "nothing changed".
    const { code, out } = run(dir);
    expect(code).toBe(2);
    expect(out).toContain("merge base");
  });
});

describe("contract.yml runs the check with the history it needs", () => {
  const wf = readFileSync(join(repoRoot, ".github/workflows/contract.yml"), "utf8");
  const job = wf.slice(wf.indexOf("\n  contract:\n"));

  test("the contract job checks out full history and runs the script", () => {
    expect(job).toMatch(/- uses: actions\/checkout@v4\n\s+with:\n\s+fetch-depth: 0/);
    expect(job).toContain("bun scripts/check-contract-version-bump.ts");
  });

  test("the step is blocking", () => {
    const at = job.indexOf("bun scripts/check-contract-version-bump.ts");
    expect(job.slice(job.lastIndexOf("- name:", at), at)).not.toContain("continue-on-error");
  });
});

describe("this branch's own contract", () => {
  test("contract/package.json declares the version /api/version reports", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "contract/package.json"), "utf8")) as { version: string; exports: Record<string, unknown> };
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
    // The backend reads the version through this export (backend/src/ops/api-version.ts).
    expect(pkg.exports["./package.json"]).toBe("./package.json");
  });
});
