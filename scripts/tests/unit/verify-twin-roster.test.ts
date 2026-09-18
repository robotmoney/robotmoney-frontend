// The comparison behind INVARIANT #3 (scripts/lib/verify/legs/twin-roster.ts).
//
// The leg itself is HTTP, but the part that can be WRONG IN A WAY A LIVE RUN
// HIDES is the set comparison: key the two sides differently — handle against
// id — and every member reports missing, which reads as a broken stack rather
// than a broken check, and would have people chasing adoption while the bug is
// here. So the comparison is pure and driven directly, with the shapes the live
// API actually serves (verified against stage: takes carry `memberHandle`,
// `memberId` and `archival`).
import { describe, expect, test } from "bun:test";
import { liveTakes, unseatedMembers } from "../../lib/verify/legs/twin-roster.ts";

const member = (handle: string, over: { id?: string; status?: string } = {}) => ({
  id: over.id ?? `id-${handle}`,
  handle,
  name: handle,
  status: over.status ?? "active",
});

// The real stage roster: three personas with committed keys, four real members
// that a twin seats with a per-boot simulated key.
const ACTIVE = ["athena", "robot-money", "noop-analyst", "dualmint", "maximus", "shodai", "woon"].map((h) =>
  member(h),
);

const take = (handle: string, over: { archival?: boolean; id?: string } = {}) => ({
  memberId: over.id ?? `id-${handle}`,
  memberHandle: handle,
  memberName: handle,
  ...(over.archival === undefined ? {} : { archival: over.archival }),
});

describe("unseatedMembers", () => {
  test("a full house reports nobody missing", () => {
    expect(unseatedMembers(ACTIVE, ACTIVE.map((m) => take(m.handle)))).toEqual([]);
  });

  test("the 3-of-7 shortfall this leg exists to catch", () => {
    const takes = ["athena", "robot-money", "noop-analyst"].map((h) => take(h));
    expect(unseatedMembers(ACTIVE, takes).map((m) => m.handle)).toEqual([
      "dualmint",
      "maximus",
      "shodai",
      "woon",
    ]);
  });

  test("a take matched by id alone still seats its member (pre-0030 rows carry no handle)", () => {
    const takes = ACTIVE.map((m) => ({ memberId: m.id }));
    expect(unseatedMembers(ACTIVE, takes)).toEqual([]);
  });

  test("handles compare case-insensitively — the API's casing is not load-bearing", () => {
    expect(unseatedMembers([member("ShodAI")], [take("shodai")])).toEqual([]);
    expect(unseatedMembers([member("shodai")], [take("SHODAI")])).toEqual([]);
  });

  test("an unrelated take does not seat anyone", () => {
    expect(unseatedMembers([member("woon")], [take("someone-else")]).map((m) => m.handle)).toEqual(["woon"]);
  });

  test("no takes at all reports the whole roster, not an empty list", () => {
    expect(unseatedMembers(ACTIVE, [])).toHaveLength(ACTIVE.length);
  });
});

describe("liveTakes", () => {
  test("archival takes are excluded — restored history says nothing about this boot's seating", () => {
    const takes = [take("athena"), take("maximus", { archival: true }), take("woon", { archival: false })];
    expect(liveTakes(takes).map((t) => t.memberHandle)).toEqual(["athena", "woon"]);
  });

  test("a take with no archival field is live (the API omits it for fresh rows)", () => {
    expect(liveTakes([{ memberId: "x" }])).toHaveLength(1);
  });

  test("an all-archival session contributes nothing, so the leg keeps looking", () => {
    expect(liveTakes([take("athena", { archival: true })])).toEqual([]);
  });
});
