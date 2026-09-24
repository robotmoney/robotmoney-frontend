// The consensus judge's public record, as the frontend words and counts it
// (frontend/public/assets/js/app/lib/judgements.js). The release call is
// advice, worded, and a "safe" call prints nothing; a seated judge is neither
// absent from a session nor a seat in its "n of m"; and a judgement route the
// contract does not declare, or that answers 404, is not served (RM-130).
import { afterAll, describe, expect, test } from "bun:test";
import { setsWeights, adviceCall,
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
  loadJudgement,
  loadMemberJudgements,
  loadSessionJudgements,
  _resetJudgementProbe,
} from "../../../frontend/public/assets/js/app/lib/judgements.js";

// api.js reads the API origin from window.RM_CONFIG at call time; "" is the
// deployed same-origin value.
const realWindow = (globalThis as { window?: unknown }).window;
(globalThis as { window?: unknown }).window = { RM_CONFIG: { API_BASE_URL: "" } };
const realFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
  (globalThis as { window?: unknown }).window = realWindow;
});
function answer(status: number, body: unknown): string[] {
  const asked: string[] = [];
  globalThis.fetch = (async (url: string) => {
    asked.push(String(url));
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return asked;
}

const ROSTER = [
  { id: "m-athena", handle: "athena", name: "Athena", role: "member" },
  { id: "m-themis", handle: "themis", name: "Themis", role: "judge" },
];

// RM-130: a release that holds #1017 back serves no judgement route. Not
// served (null) is kept apart from none yet ([]), so a judge's page can leave
// its record out rather than say nothing was published.
describe("whether judgements are served", () => {
  test("a route the contract does not declare is not asked, and reads as not served", async () => {
    _resetJudgementProbe();
    const saved = { ...JUDGEMENT_ROUTES };
    const asked = answer(200, { judgements: [] });
    Object.assign(JUDGEMENT_ROUTES, { session: null, one: null, member: null });
    try {
      expect(await loadMemberJudgements("themis")).toBeNull();
      expect(await loadSessionJudgements("s-1")).toBeNull();
      expect(await loadJudgement("41")).toBeNull();
      expect(asked).toEqual([]);
    } finally {
      Object.assign(JUDGEMENT_ROUTES, saved);
    }
  });

  test("a 404 reads as not served, and is not asked again in the visit", async () => {
    _resetJudgementProbe();
    const asked = answer(404, { error: "not_found" });
    expect(await loadMemberJudgements("themis")).toBeNull();
    expect(await loadSessionJudgements("s-1")).toBeNull();
    expect(await loadJudgement("41")).toBeNull();
    expect(asked.length).toBe(1);
  });

  test("served and empty is none yet, not unserved", async () => {
    _resetJudgementProbe();
    answer(200, { judgements: [] });
    expect(await loadMemberJudgements("themis")).toEqual([]);
    expect(await loadSessionJudgements(null)).toEqual([]);
  });
});

describe("the judgement routes", () => {
  test("are the paths the backend serves (#1017), as the contract names them", () => {
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
    expect(advice).toEqual({ line: "Advises: Hold · 2 takes, below the minimum of 3", reason: "2 takes, below the minimum of 3", concerns: ["The brief went unaddressed."] });
  });

  test("one concern goes in the line; several are listed under it", () => {
    expect(adviceOf({ release: "hold", take_count: 5, min_takes: 3, concerns: ["The takes contradict each other on WOON."] }))
      .toEqual({ line: "Advises: Hold · The takes contradict each other on WOON", reason: "The takes contradict each other on WOON", concerns: [] });
    expect(adviceOf({ release: "hold", take_count: 5, min_takes: 3, concerns: ["One.", "Two."] }))
      .toEqual({ line: "Advises: Hold", reason: "", concerns: ["One.", "Two."] });
  });

  test("a hold with no reason given reads as the hold alone", () => {
    expect(adviceLine({ release: "hold", take_count: 4, min_takes: 3, concerns: ["Judge withheld release without naming a specific concern."] }))
      .toBe("Advises: Hold");
  });

  test("a call that clears has no reason to give, and its badge reads Update, never the data's word", () => {
    expect(adviceOf({ release: "safe", take_count: 4, min_takes: 3, concerns: [] })).toBeNull();
    expect(adviceLine({ release: "safe" })).toBe("");
    expect(adviceLine(null)).toBe("");
    expect(adviceCall({ release: "safe" })).toEqual({ key: "update", label: "Update" });
    expect(adviceCall({ release: "hold" })).toEqual({ key: "hold", label: "Hold" });
    expect(adviceCall({ release: "maybe" })).toBeNull();
    expect(adviceCall(null)).toBeNull();
  });
});

describe("when a call has anything to act on", () => {
  test("only a weights recommendation that sets weights: no weights, or a portfolio review, has nothing to update", () => {
    expect(setsWeights({ type: "bucket_weights", weights: { conservative_defi_yield: 0.9, agent_tokens: 0.1 } })).toBe(true);
    expect(setsWeights({ type: "bucket_weights", weights: [{ bucket: "agent_tokens", weight: 0.1 }] })).toBe(true);
    expect(setsWeights({ type: "bucket_weights", weights: null })).toBe(false);
    expect(setsWeights({ type: "bucket_weights" })).toBe(false);
    expect(setsWeights({ type: "position_actions", actions: [] })).toBe(false);
    expect(setsWeights(null)).toBe(false);
  });
});

describe("who judged", () => {
  test("a seated judge by its roster name and page, the house judge by its own name", () => {
    expect(judgeName({ judgedBy: "m-themis", judgedByMemberId: "m-themis" }, ROSTER)).toBe("Themis");
    expect(judgeHref({ judged_by: "m-themis", judged_by_member_id: "m-themis" }, ROSTER)).toBe("/swarm/members/themis");
    expect(judgeName({ judgedBy: "robotmoney-in-house", judgedByMemberId: null }, ROSTER)).toBe(HOUSE_JUDGE_NAME);
    expect(judgeHref({ judgedBy: "robotmoney-in-house" }, ROSTER)).toBeNull();
    // A block written before the backend named its judge is the role pill alone.
    expect(judgeLabelHtml({ source: "model" }, ROSTER)).toBe('<span class="rm-role">Judge</span>');
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
