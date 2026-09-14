// Bun copies `file:` dependencies rather than symlinking them, so
// `node_modules/@robotmoney/contract` is a POINT-IN-TIME COPY of `contract/`,
// taken at the last `bun install`. A checkout that fast-forwards past a commit
// touching `contract/` without re-running install keeps serving the OLD copy —
// silently, because nothing about `import { ROUTES } from "@robotmoney/contract"`
// fails; a route added since the last install is just `undefined` wherever it
// is read.
//
// That is exactly what broke the v0.4.0-rc.3 production cutover:
// `node_modules/@robotmoney/contract` was still the Aug 25 v0.3.0 copy,
// `ROUTES.swarm.sessionConsensusReceipt` (issue #754) did not exist in it, and
// `scripts/prerender.ts`'s `openApiPath()` threw deep inside a call three
// frames from here — a confusing crash for what is actually a one-line,
// one-command fix. Call this at the top of anything that reads
// `@robotmoney/contract` at boot/build time, so the failure is legible instead
// of a `TypeError: undefined` stack trace.
import { join } from "node:path";

const DEFAULT_REPO_ROOT = join(import.meta.dir, "..", "..");
const CONTRACT_RELATIVE = join("src", "routes.js");

/**
 * Throws a clear, actionable error if the installed contract copy is stale or
 * missing. `repoRoot` defaults to this checkout; tests pass a throwaway one.
 */
export async function assertContractInstallFresh(repoRoot: string = DEFAULT_REPO_ROOT): Promise<void> {
  const sourcePath = join(repoRoot, "contract", CONTRACT_RELATIVE);
  const installedPath = join(repoRoot, "node_modules", "@robotmoney", "contract", CONTRACT_RELATIVE);

  const source = await Bun.file(sourcePath).text();
  const installed = await Bun.file(installedPath)
    .text()
    .catch(() => null);

  if (installed === null) {
    throw new Error(
      `[contract-freshness] ${installedPath} is missing.\n` +
        `[contract-freshness] Fix: bun install --force (repo root; the "postinstall" script reinstalls backend/ too).`,
    );
  }
  if (installed !== source) {
    throw new Error(
      `[contract-freshness] node_modules/@robotmoney/contract is STALE — its ${CONTRACT_RELATIVE} does not match ` +
        `contract/${CONTRACT_RELATIVE} in this checkout.\n` +
        `[contract-freshness] Bun copies "file:" deps rather than symlinking them, so a checkout that moved past a ` +
        `commit touching contract/ needs a fresh install before anything importing @robotmoney/contract can be trusted.\n` +
        `[contract-freshness] Fix: bun install --force (repo root; the "postinstall" script reinstalls backend/ too).`,
    );
  }
}

/**
 * How `ensureContractInstallFresh` runs the repair. Injected so the boot's
 * single spawn seam (scripts/stack/stack.ts's StackRuntime) stays the only
 * place this process creates a child, and so the repair can be graded without
 * running a real install.
 */
export type ContractInstallRunner = (argv: string[], cwd: string) => Promise<number>;

export type ContractFreshness = "fresh" | "repaired" | "not-applicable";

/**
 * R18 — DETECT AND FIX, then check the fix.
 *
 * The rc.1→rc.2 repin (QA checklist C-18) needed `bun install --force` run by
 * hand: the checkout moved past a commit touching `contract/`, bun's copy of
 * the `file:` dep stayed at rc.1, and nothing failed until the prerenderer
 * threw on a route that "existed". Every repin has that shape, so the boot
 * repairs it rather than a runbook line asking an operator to remember.
 *
 * WHY IT RE-VERIFIES RATHER THAN TRUSTING THE EXIT CODE. `bun install` exits 0
 * in situations that leave this copy untouched (a lockfile it decides is
 * already satisfied, a workspace resolution that skips the root). The whole
 * point of this guard is that a stale copy is INVISIBLE, so "the install
 * returned 0" is not evidence about the file — the file is. A repair that did
 * not repair fails the boot here, loudly, with the original diagnosis attached.
 *
 * WHY A MISSING `contract/` SOURCE IS NOT A FAILURE. This guard is about a
 * stale COPY of a source that is present. A tree with no `contract/src/routes.js`
 * at all is not a checkout of this repository (a test's throwaway root, a
 * vendored subtree), and there is nothing there to keep fresh — reported as
 * `not-applicable` rather than papered over as `fresh`.
 */
export async function ensureContractInstallFresh(
  repoRoot: string = DEFAULT_REPO_ROOT,
  run: ContractInstallRunner,
): Promise<ContractFreshness> {
  const sourcePath = join(repoRoot, "contract", CONTRACT_RELATIVE);
  if (!(await Bun.file(sourcePath).exists())) return "not-applicable";

  const first = await assertContractInstallFresh(repoRoot).then(
    () => null,
    (e: unknown) => (e instanceof Error ? e : new Error(String(e))),
  );
  if (first === null) return "fresh";

  console.warn(`[contract-freshness] ${first.message}`);
  console.warn("[contract-freshness] repairing: bun install --force");
  const code = await run(["bun", "install", "--force"], repoRoot);
  if (code !== 0) {
    throw new Error(
      `[contract-freshness] the installed @robotmoney/contract copy is stale or missing and the repair ` +
        `failed: \`bun install --force\` in ${repoRoot} exited ${code}.\n` +
        `[contract-freshness] Original diagnosis: ${first.message}`,
    );
  }
  await assertContractInstallFresh(repoRoot).catch((e: unknown) => {
    throw new Error(
      `[contract-freshness] \`bun install --force\` exited 0 but node_modules/@robotmoney/contract is STILL ` +
        `stale or missing — the install did not touch this copy, so nothing importing @robotmoney/contract ` +
        `can be trusted and this boot stops here.\n` +
        `[contract-freshness] ${e instanceof Error ? e.message : String(e)}`,
    );
  });
  return "repaired";
}
