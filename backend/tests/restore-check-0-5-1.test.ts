// v0.5.1's Gate C grades the dump against this release's own migration facts.
import { describe, expect, test } from "bun:test";
import { gradeLedger } from "../scripts/upgrades/0.5.0-to-0.5.1/restore-check.ts";
import { PRIOR_RELEASE_MIGRATIONS, RELEASE_MIGRATIONS } from "../scripts/upgrades/0.5.0-to-0.5.1/release.ts";

const onDisk = [...PRIOR_RELEASE_MIGRATIONS, ...RELEASE_MIGRATIONS].sort();

describe("v0.5.1 restore-check ledger grading", () => {
  test("production at v0.5.0 (with the out-of-band 0062): exactly 0061 and 0063 pending, no drift", () => {
    const g = gradeLedger([...PRIOR_RELEASE_MIGRATIONS], onDisk);
    expect(g).toEqual({ missingPrior: [], unexpectedPending: [], orphans: [], releasePending: [...RELEASE_MIGRATIONS] });
  });

  test("a ledger without 0062 is not the production baseline", () => {
    const g = gradeLedger(PRIOR_RELEASE_MIGRATIONS.filter((m) => m !== "0062_rm_readonly_sequence_select.sql"), onDisk);
    expect(g.missingPrior).toEqual(["0062_rm_readonly_sequence_select.sql"]);
    expect(g.unexpectedPending).toEqual(["0062_rm_readonly_sequence_select.sql"]);
  });

  test("a recorded migration the checkout lacks is drift", () => {
    expect(gradeLedger([...PRIOR_RELEASE_MIGRATIONS, "0099_elsewhere.sql"], onDisk).orphans).toEqual(["0099_elsewhere.sql"]);
  });

  test("the release facts match the checkout's migrations directory", async () => {
    const { readdir } = await import("node:fs/promises");
    const files = (await readdir(new URL("../migrations", import.meta.url))).filter((f) => f.endsWith(".sql"));
    for (const m of RELEASE_MIGRATIONS) expect(files).toContain(m);
    // From 0039 (the first file these lists track) on, every file is either prior or this release's.
    expect(files.filter((f) => Number(f.slice(0, 4)) >= 39 && ![...PRIOR_RELEASE_MIGRATIONS, ...RELEASE_MIGRATIONS].includes(f as never))).toEqual([]);
  });
});
