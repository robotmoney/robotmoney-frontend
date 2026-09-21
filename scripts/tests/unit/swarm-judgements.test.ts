// The consensus judge's public record, as the frontend words and counts it
// (frontend/public/assets/js/app/lib/judgements.js). The release call is
// advice, worded, and a "safe" call prints nothing; a seated judge is neither
// absent from a session nor a seat in its "n of m"; and the three routes
// resolve whether or not the vendored contract names them yet.
import { describe, expect, test } from "bun:test";
import {
  adviceLine,
  adviceOf,
  analystAbsent,
  analystCount,
  analystSeats,
  HOUSE_JUDGE_NAME,
  JUDGEMENT_ROUTES,
  judgeHref,
  judgeLabelHtml,
  judgeName,
  normalizeJudgement,
} from "../../../frontend/public/assets/js/app/lib/judgements.js";

const ROSTER = [
  { id: "m-athena", handle: "athena", name: "Athena", role: "member" },
  { id: "m-themis", handle: "themis", name: "Themis", role: "judge" },
];

describe("the judgement routes", () => {
  test("are the paths the backend serves (#1017), named or derived", () => {
    expect(JUDGEMENT_ROUTES.session).toBe("/api/swarm/sessions/:id/judgements");
    expect(JUDGEMENT_ROUTES.one).toBe("/api/swarm/judgements/:id");
    expect(JUDGEMENT_ROUTES.member).toBe("/api/swarm/members/:id/judgements");
  });
});

describe("the advice", () => {
  test("a thin session's hold states the count once, and lists what else it names", () => {
    const advice = adviceOf({
      release: "hold", thinly_supported: true, take_count: 2, min_takes: 3,
      concerns: ["Thinly supported: 2 takes submitted, below the minimum of 3 for this session.", "The brief went unaddressed."],
    });
    expect(advice).toEqual({ line: "Advises: Hold · 2 takes, below the minimum of 3", concerns: ["The brief went unaddressed."] });
  });

  test("one concern goes in the line; several are listed under it", () => {
    expect(adviceOf({ release: "hold", take_count: 5, min_takes: 3, concerns: ["The takes contradict each other on WOON."] }))
      .toEqual({ line: "Advises: Hold · The takes contradict each other on WOON", concerns: [] });
    expect(adviceOf({ release: "hold", take_count: 5, min_takes: 3, concerns: ["One.", "Two."] }))
      .toEqual({ line: "Advises: Hold", concerns: ["One.", "Two."] });
  });

  test("a hold with no reason given reads as the hold alone", () => {
    expect(adviceLine({ release: "hold", take_count: 4, min_takes: 3, concerns: ["Judge withheld release without naming a specific concern."] }))
      .toBe("Advises: Hold");
  });

  test("a safe call prints nothing", () => {
    expect(adviceOf({ release: "safe", take_count: 4, min_takes: 3, concerns: [] })).toBeNull();
    expect(adviceLine({ release: "safe" })).toBe("");
    expect(adviceLine(null)).toBe("");
  });
});

describe("who judged", () => {
  test("a seated judge by its roster name and page, the house judge by its own name", () => {
    expect(judgeName({ judgedBy: "m-themis", judgedByMemberId: "m-themis" }, ROSTER)).toBe("Themis");
    expect(judgeHref({ judged_by: "m-themis", judged_by_member_id: "m-themis" }, ROSTER)).toBe("/swarm/members/themis");
    expect(judgeName({ judgedBy: "robotmoney-in-house", judgedByMemberId: null }, ROSTER)).toBe(HOUSE_JUDGE_NAME);
    expect(judgeHref({ judgedBy: "robotmoney-in-house" }, ROSTER)).toBeNull();
    // A block written before the backend named its judge says only "Judge".
    expect(judgeLabelHtml({ source: "model" }, ROSTER)).toBe("Judge");
  });

  test("a name from a member's profile is escaped before it is bound as markup", () => {
    const label = judgeLabelHtml({ judgedByMemberId: "m-x" }, [{ id: "m-x", name: "<img src=x onerror=alert(1)>" }]);
    expect(label).not.toContain("<img");
    expect(label).toContain("&lt;img");
  });

  test("the stored recommendation's snake_case block normalizes like the route's DTO", () => {
    const j = normalizeJudgement({ id: 7, session_id: "s", judged_by: "m-themis", release_safety: { release: "hold" }, source: "model" });
    expect(j).toMatchObject({ id: "7", sessionId: "s", judgedBy: "m-themis", releaseSafety: { release: "hold" }, source: "model" });
  });
});

describe("judges are not analysts", () => {
  const rec = {
    quorum: { active: 6, submitted: 3 },
    absent: ["m-themis", "m-max", "m-dual"],
    judge: { judged_by: "m-themis", judged_by_member_id: "m-themis" },
  };

  test("a seated judge is neither absent nor a seat", () => {
    expect(analystAbsent(rec, ROSTER)).toEqual(["m-max", "m-dual"]);
    expect(analystSeats(rec, ROSTER)).toBe(5);
    expect(analystCount(ROSTER)).toBe(1);
  });

  test("with no roster, the judge the session names is still known", () => {
    expect(analystSeats(rec)).toBe(5);
    expect(analystAbsent({ ...rec, judge: undefined })).toEqual(rec.absent);
  });

  test("no quorum, no denominator", () => {
    expect(analystSeats({ absent: [] })).toBeNull();
  });
});
