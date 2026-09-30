// R18 — the rc.1→rc.2 repin needed `bun install --force` BY HAND because bun
// copies `file:` deps, so `node_modules/@robotmoney/contract` was still the
// rc.1 copy (C-18). Detection already existed
// (`assertContractInstallFresh`, and it is what turned that into a legible
// error); what did not exist is the boot doing anything about it. R18 says the
// boot guard fixes it or the runbook says it — this is the guard.
//
// THE PROPERTY: a stale copy is REPAIRED EXACTLY ONCE and then RE-VERIFIED, and
// a repair that did not actually work still fails the boot. "Ran an install and
// hoped" is the shape this must not have.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureContractInstallFresh, type ContractInstallRunner } from "../../lib/contract-freshness.ts";

const dirs: string[] = [];
const FRESH = "export const ROUTES = { swarm: { sessionConsensusReceipt: '/x' } };\n";
const STALE = "export const ROUTES = { swarm: {} };\n";

async function makeRepoRoot(source: string | undefined, installed: string | undefined): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "contract-repair-"));
  dirs.push(root);
  if (source !== undefined) {
    await mkdir(join(root, "contract", "src"), { recursive: true });
    await writeFile(join(root, "contract", "src", "routes.js"), source);
  }
  if (installed !== undefined) {
    await mkdir(join(root, "node_modules", "@robotmoney", "contract", "src"), { recursive: true });
    await writeFile(join(root, "node_modules", "@robotmoney", "contract", "src", "routes.js"), installed);
  }
  return root;
}

function recorder(onRun?: (root: string) => Promise<void>): { run: ContractInstallRunner; calls: string[][] } {
  const calls: string[][] = [];
  const run: ContractInstallRunner = async (argv, cwd) => {
    calls.push([...argv, `cwd=${cwd}`]);
    await onRun?.(cwd);
    return 0;
  };
  return { run, calls };
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("ensureContractInstallFresh", () => {
  test("a fresh copy runs no install at all", async () => {
    const root = await makeRepoRoot(FRESH, FRESH);
    const { run, calls } = recorder();
    expect(await ensureContractInstallFresh(root, run)).toBe("fresh");
    expect(calls).toEqual([]);
  });

  test("a STALE copy is repaired with `bun install --force` at the repo root, then re-verified", async () => {
    const root = await makeRepoRoot(FRESH, STALE);
    const { run, calls } = recorder(async (cwd) => {
      // what a real `bun install --force` does to this file
      await writeFile(join(cwd, "node_modules", "@robotmoney", "contract", "src", "routes.js"), FRESH);
    });
    expect(await ensureContractInstallFresh(root, run)).toBe("repaired");
    expect(calls).toEqual([["bun", "install", "--force", `cwd=${root}`]]);
  });

  test("a MISSING copy is repaired the same way", async () => {
    const root = await makeRepoRoot(FRESH, undefined);
    const { run, calls } = recorder(async (cwd) => {
      await mkdir(join(cwd, "node_modules", "@robotmoney", "contract", "src"), { recursive: true });
      await writeFile(join(cwd, "node_modules", "@robotmoney", "contract", "src", "routes.js"), FRESH);
    });
    expect(await ensureContractInstallFresh(root, run)).toBe("repaired");
    expect(calls).toHaveLength(1);
  });

  test("an install that did NOT fix it fails the boot, and is not retried", async () => {
    const root = await makeRepoRoot(FRESH, STALE);
    const { run, calls } = recorder();
    await expect(ensureContractInstallFresh(root, run)).rejects.toThrow(/still STALE|contract-freshness/);
    expect(calls).toHaveLength(1);
  });

  test("a non-zero install exit is reported as the install failing, not as staleness", async () => {
    const root = await makeRepoRoot(FRESH, STALE);
    const run: ContractInstallRunner = async () => 7;
    await expect(ensureContractInstallFresh(root, run)).rejects.toThrow(/exit(ed)? 7/);
  });

  test("a tree with no contract/ source is NOT this checkout — nothing to keep fresh", async () => {
    const root = await makeRepoRoot(undefined, undefined);
    const { run, calls } = recorder();
    expect(await ensureContractInstallFresh(root, run)).toBe("not-applicable");
    expect(calls).toEqual([]);
  });
});
