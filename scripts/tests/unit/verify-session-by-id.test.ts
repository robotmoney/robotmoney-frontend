// The verify legs grade specific published rows, so they must load each by its
// own id. /api/swarm/sessions/:date/:subject returns the LATEST session that day
// for the subject; with several sessions a day it returned an open one in place
// of the published row (R7.3, 2026-09-25: "state=published but no publishedAt").
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

for (const leg of ["swarm-pipeline.ts", "twin-roster.ts"]) {
  test(`${leg} loads session detail by id`, () => {
    const src = readFileSync(join(import.meta.dir, "../../lib/verify/legs", leg), "utf8");
    expect(src).toContain("routePath(ROUTES.swarm.sessionById, { id: row.id })");
    expect(src).not.toContain("routePath(ROUTES.swarm.session, { date: row.date, subject: row.subjectId })");
  });
}
