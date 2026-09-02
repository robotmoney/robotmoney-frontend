import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { THIS_RELEASE_MIGRATIONS } from "../scripts/upgrades/0.3.0-to-0.4.0/release.ts";

const root = join(import.meta.dir, "..", "..");
const upgradeDir = join(root, "backend/scripts/upgrades/0.3.0-to-0.4.0");

describe("v0.3.0 to v0.4.0 upgrade checks", () => {
  test("names the complete migration delta", () => {
    expect(THIS_RELEASE_MIGRATIONS).toEqual([
      "0039_swarm_judge.sql",
      "0040_swarm_judgements_append_only.sql",
      "0041_swarm_judgement_soak_record.sql",
      "0042_swarm_consensus_receipts.sql",
    ]);
    for (const migration of THIS_RELEASE_MIGRATIONS) {
      expect(existsSync(join(root, "backend/migrations", migration))).toBe(true);
    }
  });

  test("is self-contained rather than importing the v0.3 release scripts", () => {
    for (const file of ["preflight.ts", "postflight.ts", "restore-check.ts", "stage-rehearsal.ts", "steps.ts"]) {
      const source = readFileSync(join(upgradeDir, file), "utf8");
      expect(source).not.toContain("0.2.2-to-0.3.0");
    }
  });
});
