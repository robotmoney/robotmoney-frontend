// Issue 1450: the committed diagnosis of the three pre-1421 regime runs whose
// replayed composite differs from the one they published (ids 73, 111, 133).
// Required CI reads only the committed JSON. With RM_FORMAT1_ARCHIVE set (a
// format 1 local copy, D72) it also regenerates the file and compares.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { DIAGNOSED_RUN_IDS, FIXTURE_PATH, diagnoseRun, type Diagnosis } from "../scripts/composite-drift-diagnosis.ts";
import { openLocalCopy } from "../../packages/analyst-sdk/bin/local-copy.ts";

const diagnosis = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Record<string, Diagnosis>;
const ARCHIVE = process.env.RM_FORMAT1_ARCHIVE;

describe("composite drift diagnosis (committed file)", () => {
  test("has exactly the keys 73, 111 and 133, each with the four fields", () => {
    expect(Object.keys(diagnosis).sort()).toEqual(["111", "133", "73"]);
    for (const id of DIAGNOSED_RUN_IDS) {
      const e = diagnosis[id]!;
      expect(Array.isArray(e.input_series)).toBe(true);
      expect(typeof e.replayed_vs_computed_delta).toBe("number");
      expect(e).toHaveProperty("composite_effect");
      expect(e).toHaveProperty("cause");
    }
  });

  test("each composite_effect is a finite number", () => {
    for (const id of DIAGNOSED_RUN_IDS) expect(Number.isFinite(diagnosis[id]!.composite_effect)).toBe(true);
  });

  test("each cause is pre-1421-handoff or other", () => {
    for (const id of DIAGNOSED_RUN_IDS) expect(["pre-1421-handoff", "other"]).toContain(diagnosis[id]!.cause);
  });

  test("an entry with cause other links an issue that exists", () => {
    for (const id of DIAGNOSED_RUN_IDS) {
      const e = diagnosis[id]!;
      if (e.cause !== "other") {
        expect(e.linked_issue).toBeNull();
        continue;
      }
      expect(Number.isInteger(e.linked_issue) && (e.linked_issue as number) > 0, `run ${id}: cause other needs linked_issue`).toBe(true);
      const r = Bun.spawnSync(["gh", "api", `repos/robotmoney/robotmoney-frontend/issues/${e.linked_issue}`, "--jq", ".number"]);
      expect(r.exitCode, `run ${id}: linked issue ${e.linked_issue} does not exist (or gh is unavailable): ${r.stderr.toString()}`).toBe(0);
    }
  });

  test("a handoff entry is fully accounted for by its input series", () => {
    for (const id of DIAGNOSED_RUN_IDS) {
      const e = diagnosis[id]!;
      if (e.cause === "pre-1421-handoff") {
        expect(e.input_series.length).toBeGreaterThan(0);
        expect(Math.abs(e.replayed_vs_computed_delta - e.composite_effect)).toBeLessThanOrEqual(1e-12);
      }
    }
  });
});

if (!ARCHIVE) {
  console.warn("SKIP composite-drift-diagnosis regeneration: RM_FORMAT1_ARCHIVE is not set. It needs a format 1 local copy of the csv-backups data (D72); CI has none. The committed file is checked above.");
}
describe.skipIf(!ARCHIVE)("composite drift diagnosis regenerated from a format 1 local copy", () => {
  test("replaying runs 73, 111 and 133 gives the committed file", () => {
    const copy = openLocalCopy(ARCHIVE!);
    for (const id of DIAGNOSED_RUN_IDS) {
      const d = diagnoseRun(copy, id);
      expect({ ...d, linked_issue: diagnosis[id]!.linked_issue }).toEqual(diagnosis[id]!);
    }
  }, 600_000);
});
