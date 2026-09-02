// Test: /regime's per-indicator glossary links land on a real anchor.
//
// The panel tables on /regime link each indicator name to
// `/regime/indicators#<id>`, built from the indicator's own id at render time.
// The glossary on the other end is hand-authored HTML — nothing generates it
// from INDICATORS — so the two sides agree only for as long as someone keeps
// them agreeing. They do agree today, all 26 to 26. The failure this guards is
// the quiet one: add a 27th indicator to the analytics universe, ship it to the
// dashboard, and its name is a link to a fragment that does not exist. The
// router's scrollForRoute() falls back to the top of the page, so there is no
// error anywhere — the reader just lands on a wall of 26 other indicators.
//
// It also pins the two fields the dashboard now reads off the snapshot payload
// (description, source_url). Both have been authored per-indicator all along;
// they only started being serialised when the row tooltip and the source label
// began rendering them, which means a new indicator missing either one now
// degrades visible UI rather than nothing at all.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { INDICATORS } from "../../../backend/src/analytics/analyze/indicators.ts";

const repoRoot = join(import.meta.dir, "../../..");
const glossary = readFileSync(
  join(repoRoot, "frontend/public/views/regime/indicators.html"),
  "utf8",
);

// Anchors the dashboard can link INTO: one <section class="ri__ind" id="…">
// per indicator. Deliberately not "every id on the page" — the panel headings
// (#panel-macro et al) are navigation targets, not indicator entries.
const anchors = new Set(
  [...glossary.matchAll(/class="ri__ind"\s+id="([^"]+)"/g)].map((m) => m[1]),
);

describe("regime indicator glossary links", () => {
  test("every indicator the dashboard renders has a glossary anchor to link to", () => {
    const missing = INDICATORS.filter((ind) => !anchors.has(ind.id)).map((ind) => ind.id);
    expect(missing).toEqual([]);
  });

  test("every glossary entry still describes a live indicator", () => {
    const ids = new Set(INDICATORS.map((ind) => ind.id));
    const orphans = [...anchors].filter((id) => !ids.has(id));
    expect(orphans).toEqual([]);
  });

  test("the glossary's own index links resolve on the page they sit on", () => {
    const indexed = [...glossary.matchAll(/class="ri__index-link"\s+href="#([^"]+)"/g)].map(
      (m) => m[1],
    );
    expect(indexed.length).toBe(INDICATORS.length);
    expect(indexed.filter((id) => !anchors.has(id))).toEqual([]);
  });

  test("every indicator carries the prose and the source link the panel table renders", () => {
    const noDescription = INDICATORS.filter((ind) => !ind.description).map((ind) => ind.id);
    const noSourceUrl = INDICATORS.filter((ind) => !ind.source_url).map((ind) => ind.id);
    expect(noDescription).toEqual([]);
    expect(noSourceUrl).toEqual([]);
  });
});
