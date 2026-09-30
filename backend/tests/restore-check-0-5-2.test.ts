// v0.5.2's Gate C grades the dump against this release's own migration facts.
import { describe, expect, test } from "bun:test";
import { gradeLedger } from "../scripts/upgrades/0.5.1-to-0.5.2/restore-check.ts";
import { PRIOR_RELEASE_MIGRATIONS, RELEASE_MIGRATIONS } from "../scripts/upgrades/0.5.1-to-0.5.2/release.ts";
import { POST_V052_MIGRATIONS } from "./support/post-v052-migrations.ts";

const onDisk = [...PRIOR_RELEASE_MIGRATIONS, ...RELEASE_MIGRATIONS].sort();

describe("v0.5.2 restore-check ledger grading", () => {
  test("production at v0.5.1: exactly 0080 pending, no drift", () => {
    const g = gradeLedger([...PRIOR_RELEASE_MIGRATIONS], onDisk);
    expect(g).toEqual({ missingPrior: [], unexpectedPending: [], orphans: [], releasePending: [...RELEASE_MIGRATIONS] });
  });

  test("a ledger without v0.5.1's 0063 is not the production baseline", () => {
    const g = gradeLedger(PRIOR_RELEASE_MIGRATIONS.filter((m) => m !== "0063_swarm_judge_model_default.sql"), onDisk);
    expect(g.missingPrior).toEqual(["0063_swarm_judge_model_default.sql"]);
    expect(g.unexpectedPending).toEqual(["0063_swarm_judge_model_default.sql"]);
  });

  test("a recorded migration the checkout lacks is drift", () => {
    expect(gradeLedger([...PRIOR_RELEASE_MIGRATIONS, "0099_elsewhere.sql"], onDisk).orphans).toEqual(["0099_elsewhere.sql"]);
  });

  test("the release facts match the checkout's migrations directory", async () => {
    const { readdir } = await import("node:fs/promises");
    const files = (await readdir(new URL("../migrations", import.meta.url))).filter((f) => f.endsWith(".sql"));
    for (const m of RELEASE_MIGRATIONS) expect(files).toContain(m);
    // From 0039 (the first file these lists track) on, every file is either
    // prior, this release's, or one the NEXT release declares (the files the
    // 0.5.x -> main merge brought in; see tests/support/post-v052-migrations.ts).
    const known = [...PRIOR_RELEASE_MIGRATIONS, ...RELEASE_MIGRATIONS, ...POST_V052_MIGRATIONS] as readonly string[];
    expect(files.filter((f) => Number(f.slice(0, 4)) >= 39 && !known.includes(f))).toEqual([]);
    for (const m of POST_V052_MIGRATIONS) expect(files).toContain(m);
  });
});
