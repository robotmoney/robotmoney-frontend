// Regression for the v0.4.0-rc.3 production cutover: `node_modules/@robotmoney/contract`
// was a stale pre-#754 copy (bun copies `file:` deps rather than symlinking them), so
// `ROUTES.swarm.sessionConsensusReceipt` read `undefined` and `scripts/prerender.ts`'s
// `openApiPath()` threw deep inside a call, aborting `static-assembly.sh`. This asserts
// the guard actually distinguishes fresh / stale / missing rather than always passing.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertContractInstallFresh } from "../../lib/contract-freshness.ts";

const dirs: string[] = [];

async function makeRepoRoot(source: string, installed: string | undefined): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "contract-freshness-"));
  dirs.push(root);
  await mkdir(join(root, "contract", "src"), { recursive: true });
  await writeFile(join(root, "contract", "src", "routes.js"), source);
  if (installed !== undefined) {
    await mkdir(join(root, "node_modules", "@robotmoney", "contract", "src"), { recursive: true });
    await writeFile(join(root, "node_modules", "@robotmoney", "contract", "src", "routes.js"), installed);
  }
  return root;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("assertContractInstallFresh", () => {
  test("resolves when the installed copy matches the checkout", async () => {
    const root = await makeRepoRoot("export const ROUTES = {};\n", "export const ROUTES = {};\n");
    await expect(assertContractInstallFresh(root)).resolves.toBeUndefined();
  });

  test("throws a diagnosable error when the installed copy is stale", async () => {
    const root = await makeRepoRoot(
      "export const ROUTES = { swarm: { sessionConsensusReceipt: '/x' } };\n",
      "export const ROUTES = { swarm: {} };\n",
    );
    await expect(assertContractInstallFresh(root)).rejects.toThrow(/STALE/);
    await expect(assertContractInstallFresh(root)).rejects.toThrow(/bun install --force/);
  });

  test("throws a diagnosable error when the install has never run", async () => {
    const root = await makeRepoRoot("export const ROUTES = {};\n", undefined);
    await expect(assertContractInstallFresh(root)).rejects.toThrow(/is missing/);
    await expect(assertContractInstallFresh(root)).rejects.toThrow(/bun install --force/);
  });
});
