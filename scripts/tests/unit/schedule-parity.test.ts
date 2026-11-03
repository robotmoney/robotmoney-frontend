// scripts/tests/unit/schedule-parity.test.ts — C23-subject-spacing check 1's spacing
// assertion (issue 1310): the four production subjects' anchor times of day are
// exactly 21600 s apart in the order vault, woon, allocation, treasury
// (migration 0121, scheduler spec §2.2). The drifted pre-0121 grid fails, the
// 0121 grid parsed from the migration itself passes, and the stage target runs
// the same command as prod.
import { describe, expect, test } from "bun:test";
import { loadReleaseRunbook } from "../../release/runbook.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SUBJECT_CLOSE_ORDER, SUBJECT_CLOSE_SPACING_SECONDS, closeSpacingProblems } from "../../release/schedule-parity.ts";
import { RELEASE_STEPS, renderStep, templateValues } from "../../release/steps.ts";
import { loadTarget } from "../../release/target.ts";
import { PRODUCTION_EPOCH_SECONDS } from "../../release/watch.ts";

const root = join(import.meta.dir, "..", "..", "..");
const migration = join(root, "backend", "migrations", "0121_subject_closes_six_hours_apart.sql");

/** The anchors 0121 writes, read from its VALUES list so the test follows the migration. */
function migrationAnchors(): { id: string; epoch_anchor: string }[] {
  const sql = readFileSync(migration, "utf8");
  const rows = [...sql.matchAll(/\('([a-z-]+)',\s*'([^']+)'::timestamptz\)/g)];
  return rows.map((m) => ({ id: m[1]!, epoch_anchor: m[2]!.replace(" ", "T").replace("+00", "Z") }));
}

/** The anchors 0117 left, as 0121's header records them: the drift of the old 6 h rotation. */
const PRE_0121 = [
  { id: "robotmoney-vault", epoch_anchor: "2026-10-10T00:52:19.990Z" },
  { id: "woon", epoch_anchor: "2026-10-10T06:58:21.970Z" },
  { id: "robotmoney-allocation", epoch_anchor: "2026-10-10T13:00:42.491Z" },
  { id: "robotmoney-treasury", epoch_anchor: "2026-10-10T19:03:59.504Z" },
];

describe("C23-subject-spacing close spacing (issue 1310)", () => {
  test("the spacing is a quarter of the epoch, in the order vault, woon, allocation, treasury", () => {
    expect(SUBJECT_CLOSE_SPACING_SECONDS * 4).toBe(PRODUCTION_EPOCH_SECONDS);
    expect([...SUBJECT_CLOSE_ORDER]).toEqual(["robotmoney-vault", "woon", "robotmoney-allocation", "robotmoney-treasury"]);
  });

  test("the drifted pre-0121 grid fails: gaps 6 h 06 m, 6 h 02 m, 6 h 03 m and 5 h 48 m", () => {
    const problems = closeSpacingProblems(PRE_0121);
    expect(problems.length).toBe(4);
    expect(problems[0]).toContain("robotmoney-vault and woon are 6 h 06 m");
    expect(problems[1]).toContain("woon and robotmoney-allocation are 6 h 02 m");
    expect(problems[2]).toContain("robotmoney-allocation and robotmoney-treasury are 6 h 03 m");
    expect(problems[3]).toContain("robotmoney-treasury and robotmoney-vault are 5 h 48 m");
    for (const p of problems) expect(p).toContain("not 6 h 00 m");
  });

  test("the 0121 grid, read from the migration, passes; the anchor days do not matter", () => {
    const anchors = migrationAnchors();
    expect(anchors.map((a) => a.id)).toEqual([...SUBJECT_CLOSE_ORDER]);
    expect(closeSpacingProblems(anchors)).toEqual([]);
    // Only the time of day counts: anchors on different days, and extra subjects, are fine.
    const shifted = anchors.map((a, i) => ({ ...a, epoch_anchor: new Date(Date.parse(a.epoch_anchor) + i * 3 * PRODUCTION_EPOCH_SECONDS * 1000).toISOString() }));
    expect(closeSpacingProblems([...shifted, { id: "demo", epoch_anchor: "2026-10-10T01:00:00.000Z" }])).toEqual([]);
    // Red control: one millisecond off fails exactly the two gaps that touch the moved subject.
    const off = anchors.map((a) => (a.id === "woon" ? { ...a, epoch_anchor: new Date(Date.parse(a.epoch_anchor) + 1).toISOString() } : a));
    expect(closeSpacingProblems(off).length).toBe(2);
  });

  test("a subject missing from the active set, or with no anchor, is one problem naming it", () => {
    const anchors = migrationAnchors();
    const without = closeSpacingProblems(anchors.filter((a) => a.id !== "woon"));
    expect(without).toEqual(["subject woon is not active, so the 6 h close grid is incomplete"]);
    const noAnchor = closeSpacingProblems(anchors.map((a) => (a.id === "woon" ? { ...a, epoch_anchor: null } : a)));
    expect(noAnchor.length).toBe(1);
    expect(noAnchor[0]).toContain("woon has no readable epoch_anchor");
  });

  test("the stage target runs the check unchanged: the same command as prod, only --sessions differs", () => {
    const targetsDir = join(root, "scripts", "release", "targets");
    const step = loadReleaseRunbook("v0.6.2").steps.find((s) => s.id === "C23-subject-spacing")!;
    const cmd = (name: string) => {
      const t = loadTarget(join(targetsDir, `${name}.json`));
      const remote = renderStep(step, t, templateValues(t, "a".repeat(40), "20261008T000000Z")).remote;
      // The command from the script's name on, with the instance and the receipt dir (target paths) normalised.
      return remote.slice(remote.indexOf("bun scripts/release/schedule-parity.ts")).replace(/--instance \S+/, "--instance X").replace(/--receipt-dir \S+/, "--receipt-dir X");
    };
    expect(cmd("stage")).toBe("bun scripts/release/schedule-parity.ts --instance X --run 20261008T000000Z --sessions deferred --receipt-dir X");
    // Both targets defer sessions in the 30-minute soak (owner, 2026-10-14): the same command.
    expect(cmd("prod")).toBe(cmd("stage"));
    // The spacing check takes the subjects only: no sessions mode can gate it.
    expect(closeSpacingProblems.length).toBe(1);
  });
});
