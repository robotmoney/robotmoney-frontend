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
