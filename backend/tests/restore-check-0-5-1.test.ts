// v0.5.1's Gate C grades the dump against this release's own migration facts.
//
// Ported from releases-0.5.x and adapted. There, restore-check.ts exported a
// pure gradeLedger(). On main the D47-adapted restore-check.ts runs
// preflight.ts's runChecks() instead and executes at import, so it cannot be
// imported here. The same grading is restated below over release.ts's facts
// (the logic preflight.ts's `v0.5-schema` and `pending-is-this-release-only`
// checks apply), so the cases the release branch pinned still hold.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { PRIOR_RELEASE_MIGRATIONS, RELEASE_MIGRATIONS } from "../scripts/upgrades/0.5.0-to-0.5.1/release.ts";

const onDisk = [...PRIOR_RELEASE_MIGRATIONS, ...RELEASE_MIGRATIONS].sort();

function gradeLedger(recorded: readonly string[], disk: readonly string[]) {
  const applied = new Set(recorded);
  const expected = new Set<string>(RELEASE_MIGRATIONS);
  const pending = disk.filter((name) => !applied.has(name));
  return {
    missingPrior: PRIOR_RELEASE_MIGRATIONS.filter((name) => !applied.has(name)),
    unexpectedPending: pending.filter((name) => !expected.has(name)),
    orphans: recorded.filter((name) => !disk.includes(name)),
    releasePending: RELEASE_MIGRATIONS.filter((name) => !applied.has(name)),
  };
}

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

  test("every migration the release facts name exists in the checkout", async () => {
    // Whole-directory equality is owned by rollout-steps-0-5-1.test.ts, which
    // declares the migrations that landed after v0.5.1.
    const { readdir } = await import("node:fs/promises");
    const files = (await readdir(new URL("../migrations", import.meta.url))).filter((f) => f.endsWith(".sql"));
    for (const m of [...PRIOR_RELEASE_MIGRATIONS, ...RELEASE_MIGRATIONS]) expect(files).toContain(m);
  });

  test("main's restore-check still grades through preflight's runChecks", () => {
    const src = readFileSync(new URL("../scripts/upgrades/0.5.0-to-0.5.1/restore-check.ts", import.meta.url), "utf8");
    expect(src).toContain('import { runChecks } from "./preflight.ts"');
  });
});
