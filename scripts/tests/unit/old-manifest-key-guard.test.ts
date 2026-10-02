// The repo guard exits non-zero on a planted old manifest key and zero on the
// real tree.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "../../checks/check-old-manifest-keys.ts");
const run = (root?: string) => Bun.spawnSync(["bun", script, ...(root ? [root] : [])], { stdout: "pipe", stderr: "pipe" });

test("zero on the final tree", () => {
  expect(run().exitCode).toBe(0);
});

test("non-zero on a planted old manifest key", () => {
  const root = mkdtempSync(join(tmpdir(), "oldkey-"));
  mkdirSync(join(root, "test-fixtures/deployments/x"), { recursive: true });
  writeFileSync(join(root, "test-fixtures/deployments/x/vault.json"), JSON.stringify({ vault: "0x1", morpho_adapter: "0x2" }));
  const r = run(root);
  expect(r.exitCode).toBe(1);
  expect(r.stderr.toString()).toContain("morpho_adapter");
});
