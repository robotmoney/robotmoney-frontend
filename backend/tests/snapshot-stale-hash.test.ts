// "CI fails when a stale hash is committed" — issue #1086, D55 / spec §8.1.
//
// `schema-snapshot.test.ts` refuses a contentHash on a synthesized fixture. This
// file puts the COMMITTED backend/schema/ through it: the real files verify, and
// a copy whose snapshot.json carries a stale contentHash (or whose declaration
// was edited without regenerating the hash) fails `loadSnapshot` by name, so a
// stale hash committed to the repo cannot pass the suite.
import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSnapshot } from "../src/db/schema-snapshot.ts";
import { hashManifest } from "../src/db/schema-manifest.ts";

const COMMITTED = join(import.meta.dir, "..");
const scratch: string[] = [];

/** A temp copy of the committed `schema/` directory, returned as the `dir` loadSnapshot takes. */
function copyOfCommittedSchema(): string {
  const dir = mkdtempSync(join(tmpdir(), "rm-stale-hash-"));
  scratch.push(dir);
  cpSync(join(COMMITTED, "schema"), join(dir, "schema"), { recursive: true });
  return dir;
}

afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

describe("the committed snapshot's contentHash", () => {
  test("verifies: the committed files hash to the committed contentHash", async () => {
    const committed = JSON.parse(readFileSync(join(COMMITTED, "schema", "snapshot.json"), "utf8")) as { contentHash: string };
    const snapshot = await loadSnapshot();
    expect(snapshot.manifest.contentHash).toBe(committed.contentHash);
    expect(hashManifest(snapshot.manifest.declaration, snapshot.filenames)).toBe(committed.contentHash);
  });

  test("a stale hash in snapshot.json fails loadSnapshot, naming the file and the hash", async () => {
    const dir = copyOfCommittedSchema();
    const path = join(dir, "schema", "snapshot.json");
    const metadata = JSON.parse(readFileSync(path, "utf8")) as { contentHash: string };
    const stale = `${metadata.contentHash.slice(0, -1)}${metadata.contentHash.endsWith("0") ? "1" : "0"}`;
    writeFileSync(path, `${JSON.stringify({ ...metadata, contentHash: stale }, null, 2)}\n`);
    await expect(loadSnapshot(dir)).rejects.toThrow(`schema/snapshot.json: content hash ${stale} does not verify`);
  });

  test("a declaration edited without regenerating the hash fails the same way", async () => {
    const dir = copyOfCommittedSchema();
    const path = join(dir, "schema", "snapshot.sql");
    writeFileSync(path, `${readFileSync(path, "utf8")}\n-- edited by hand\n`);
    await expect(loadSnapshot(dir)).rejects.toThrow(/schema\/snapshot\.json: content hash .* does not verify/);
  });

  test("an untouched copy still loads (the tampering above is what fails, not the copy)", async () => {
    await expect(loadSnapshot(copyOfCommittedSchema())).resolves.toBeDefined();
  });
});
