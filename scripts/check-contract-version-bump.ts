// A change to the API's route table must bump the API's version (D54, issue
// #1026 W7, criterion 158).
//
// The API's version IS contract/package.json's version: GET /api/version
// reports it, and a separately deployed website accepts or refuses an API by
// it (frontend/package.json `apiRange`). A route-table edit that left the
// number alone would let a site built for the old table accept an API that no
// longer serves it, so CI (contract.yml) fails the change instead:
//
//   if contract/src/routes.js differs from the merge base, the working tree's
//   contract/package.json version must be semver-GREATER than the base's.
//
// THE BASE, in order:
//   1. `--base <ref>`                               explicit (tests, local use)
//   2. a `push` event's `before` SHA                 (GITHUB_EVENT_PATH payload)
//   3. merge-base(origin/$GITHUB_BASE_REF, HEAD)     a pull_request run
//   4. merge-base(origin/main, HEAD)                 anything else, incl. local
//
// Against the MERGE BASE, not the base branch's tip: one bump covers every
// routes.js edit a branch makes, and a base branch that moved on after the
// branch was cut does not count as this branch's change. The checkout must
// carry that history — contract.yml checks out with `fetch-depth: 0`.
//
// Exits 0 when routes.js is unchanged or the version rose; 1 naming both
// versions when it did not; 2 when the base cannot be resolved (never a pass:
// a check that cannot find its base has checked nothing).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const ROUTES_FILE = "contract/src/routes.js";
export const CONTRACT_MANIFEST = "contract/package.json";

const ZERO_SHA = /^0+$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export interface BumpCheck {
  ok: boolean;
  base: string;
  routesChanged: boolean;
  baseVersion: string | null;
  headVersion: string | null;
  message: string;
}

function git(cwd: string, args: string[]): { code: number; out: string; err: string } {
  const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
}

function mergeBase(cwd: string, ref: string): string {
  const r = git(cwd, ["merge-base", ref, "HEAD"]);
  if (r.code !== 0 || !r.out) {
    throw new BaseUnresolved(`cannot find the merge base of ${ref} and HEAD (${r.err || "no common ancestor"}); is the checkout shallow?`);
  }
  return r.out;
}

export class BaseUnresolved extends Error {}

/** Which commit this change is measured against. See the header for the order. */
export function resolveBase(
  cwd: string,
  argv: string[] = process.argv.slice(2),
  env: Record<string, string | undefined> = process.env,
): string {
  const i = argv.indexOf("--base");
  if (i !== -1) {
    const ref = argv[i + 1];
    if (!ref) throw new BaseUnresolved("--base needs a ref");
    return mergeBase(cwd, ref);
  }
  if (env.GITHUB_EVENT_NAME === "push" && env.GITHUB_EVENT_PATH && existsSync(env.GITHUB_EVENT_PATH)) {
    const before = (JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8")) as { before?: unknown }).before;
    // A push that created the branch has an all-zero `before`: nothing to
    // compare against on the branch itself, so fall through to origin/main.
    if (typeof before === "string" && before && !ZERO_SHA.test(before)) {
      const r = git(cwd, ["rev-parse", "--verify", `${before}^{commit}`]);
      if (r.code !== 0) throw new BaseUnresolved(`push event's before SHA ${before} is not in this checkout; is it shallow?`);
      return r.out;
    }
  }
  const baseRef = env.GITHUB_BASE_REF?.trim();
  return mergeBase(cwd, baseRef ? `origin/${baseRef}` : "origin/main");
}

function versionAt(cwd: string, base: string): string | null {
  const r = git(cwd, ["show", `${base}:${CONTRACT_MANIFEST}`]);
  if (r.code !== 0) return null;
  const v = (JSON.parse(r.out) as { version?: unknown }).version;
  return typeof v === "string" ? v : null;
}

function workingVersion(cwd: string): string | null {
  const v = (JSON.parse(readFileSync(join(cwd, CONTRACT_MANIFEST), "utf8")) as { version?: unknown }).version;
  return typeof v === "string" ? v : null;
}

/** Compare the working tree against `base`. Pure over the repo at `cwd`. */
export function checkContractVersionBump(cwd: string, base: string): BumpCheck {
  // Working tree against the base, so a local run before committing sees the
  // same answer CI will (in CI the working tree is HEAD).
  const diff = git(cwd, ["diff", "--quiet", base, "--", ROUTES_FILE]);
  if (diff.code > 1) throw new BaseUnresolved(`git diff against ${base} failed: ${diff.err}`);
  const routesChanged = diff.code === 1;
  const baseVersion = versionAt(cwd, base);
  const headVersion = workingVersion(cwd);
  const short = base.slice(0, 12);

  if (!routesChanged) {
    return { ok: true, base, routesChanged, baseVersion, headVersion, message: `${ROUTES_FILE} unchanged since ${short}; no bump needed.` };
  }
  if (!headVersion || !SEMVER.test(headVersion)) {
    return { ok: false, base, routesChanged, baseVersion, headVersion, message: `${ROUTES_FILE} changed since ${short}, and ${CONTRACT_MANIFEST} has no readable version (${JSON.stringify(headVersion)}).` };
  }
  if (baseVersion === null) {
    // The contract did not exist at the base: its first version is a bump.
    return { ok: true, base, routesChanged, baseVersion, headVersion, message: `${CONTRACT_MANIFEST} is new since ${short}; ${headVersion} is its first version.` };
  }
  if (Bun.semver.order(headVersion, baseVersion) === 1) {
    return {
      ok: true, base, routesChanged, baseVersion, headVersion,
      message: `${ROUTES_FILE} changed since ${short}; contract version bumped ${baseVersion} -> ${headVersion}.`,
    };
  }
  return {
    ok: false, base, routesChanged, baseVersion, headVersion,
    message:
      `${ROUTES_FILE} changed since ${short}, but ${CONTRACT_MANIFEST} version ${headVersion} is not greater than the base's ${baseVersion}. ` +
      `Bump the contract version (and frontend/package.json apiRange if the new version falls outside it).`,
  };
}

if (import.meta.main) {
  const cwd = process.cwd();
  let result: BumpCheck;
  try {
    result = checkContractVersionBump(cwd, resolveBase(cwd));
  } catch (err) {
    console.error(`check-contract-version-bump: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
  if (result.ok) {
    console.log(result.message);
  } else {
    console.error(result.message);
    process.exit(1);
  }
}
