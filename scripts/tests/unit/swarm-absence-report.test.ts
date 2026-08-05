// Issue #501 — the swarm driver's absent list must come from the SEATED
// ROSTER, not from the submitted takes.
//
// The regression this pins: the driver derived its `absent:` log line by
// filtering `pub.takes`, the rows that were actually submitted. A member that
// never submitted has no row there at all, so the filter could only ever
// return [] for a real no-show — the driver printed `absent: []` for the very
// session it had just reported a take shortfall for.
//
// These tests are hermetic: they need no backend, no container and no model
// call. The published payloads below fix their OWN roster (four seated
// members, three takes) rather than assuming the live one, because which
// members the backend seats as active is exactly what other in-flight work
// changes.
import { describe, expect, test } from "bun:test";
import { absenceReport } from "../../lib/swarm/session.ts";
import { parseStanceFromBody } from "../../lib/swarm/inference.ts";

// A four-seat roster where `draco` never submitted. `quorum` is the shape
// backend/src/swarm/domain.ts aggregateSession() stores in
// swarm_sessions.swarm_recommendation and the public session route serves as
// `session.swarmRecommendation` (contract/src/swarm.d.ts SwarmRecommendation).
const SEATED = ["athena", "boreas", "cygnus", "draco"] as const;
const SUBMITTERS = ["athena", "boreas", "cygnus"] as const;

function publishedSession(overrides: {
  absent?: unknown;
  quorum?: Record<string, unknown> | null;
  swarmRecommendation?: unknown;
} = {}) {
  const absent = "absent" in overrides ? overrides.absent : SEATED.filter((m) => !(SUBMITTERS as readonly string[]).includes(m));
  const quorum = "quorum" in overrides
    ? overrides.quorum
    : { active: SEATED.length, submitted: SUBMITTERS.length, absent: SEATED.length - SUBMITTERS.length, participation: SUBMITTERS.length / SEATED.length };
  const rec = "swarmRecommendation" in overrides
    ? overrides.swarmRecommendation
    : { quorum, stances: { bullish: 3 }, meanConfidence: 0.7, absent, type: "position_actions", consensus: [], disagreements: [] };
  return {
    session: { state: "published", synthesis: "…", swarmRecommendation: rec },
    // Only the members that submitted have take rows — this is the whole
    // reason a take-derived absent list can never see a no-show.
    takes: SUBMITTERS.map((memberId) => ({ memberId, stance: "bullish", confidence: 0.7, body: "x", verified: true })),
  };
}

describe("absenceReport — the absent list is roster-derived, and agrees with takes=N of M", () => {
  test("names the seated member that submitted nothing", () => {
    const report = absenceReport(publishedSession(), "[session 1]");
    expect(report.absent).toEqual(["draco"]);
    expect(report.active).toBe(4);
    expect(report.submitted).toBe(3);
  });

  test("the invariant holds: active - submitted === absent.length", () => {
    const report = absenceReport(publishedSession());
    expect(report.active - report.submitted).toBe(report.absent.length);
  });

  // The pre-fix derivation, run against the SAME payload, to show it could
  // never have reported the no-show: draco has no take row to filter on, so
  // the old expression is [] while the roster says one member is missing.
  test("the retired take-derived derivation would report [] for the same session", () => {
    const pub = publishedSession();
    const takeDerived = pub.takes
      .filter((t: any) => t.verified === null || t.verified === false)
      .map((t: any) => t.memberId);
    expect(takeDerived).toEqual([]);
    expect(absenceReport(pub).absent).toEqual(["draco"]);
  });

  test("a full house reports nobody absent", () => {
    const pub = publishedSession({
      absent: [],
      quorum: { active: 3, submitted: 3, absent: 0, participation: 1 },
    });
    const report = absenceReport(pub);
    expect(report.absent).toEqual([]);
    expect(report.active - report.submitted).toBe(0);
  });
});

describe("absenceReport fails LOUDLY rather than under-reporting", () => {
  test("throws when the counter and the absent list disagree", () => {
    // Exactly the #501 symptom, now unrepresentable: a shortfall of one with
    // an empty absent list.
    const pub = publishedSession({
      absent: [],
      quorum: { active: 4, submitted: 3, absent: 0, participation: 0.75 },
    });
    expect(() => absenceReport(pub, "[session 1]")).toThrow(/attendance is inconsistent — takes=3 of 4/);
  });

  test("throws when quorum.absent disagrees with the list it summarises", () => {
    const pub = publishedSession({
      absent: ["draco"],
      quorum: { active: 4, submitted: 3, absent: 2, participation: 0.75 },
    });
    expect(() => absenceReport(pub)).toThrow(/quorum.absent=2/);
  });

  test("throws when the published session carries no rollup at all", () => {
    expect(() => absenceReport(publishedSession({ swarmRecommendation: null }))).toThrow(
      /carries no swarmRecommendation/,
    );
  });

  test("throws when quorum is missing its counts", () => {
    expect(() => absenceReport(publishedSession({ quorum: { active: 4 } }))).toThrow(
      /quorum is missing active\/submitted\/absent counts/,
    );
  });

  test("throws when absent is not a list", () => {
    expect(() => absenceReport(publishedSession({ absent: "draco" }))).toThrow(
      /absent is not a list/,
    );
  });
});

// The cheapest real no-show injection point, and the one observed on the
// session that filed #501: cygnus's live model answered
// `STANCE: cautiously constructive | CONFIDENCE: 0.65`, which the strict
// parser refuses. The refusal produces NO take — which is precisely why the
// take-derived list above could not see it, and why the roster-derived one can.
describe("a malformed control line yields no take at all — the member is absent, never neutral", () => {
  test("the observed `STANCE: cautiously constructive` line is refused", () => {
    expect(() => parseStanceFromBody("**REGIME**\n- x\nSTANCE: cautiously constructive | CONFIDENCE: 0.65"))
      .toThrow(/rendered ABSENT/);
  });

  test("a member whose take was refused shows up in the roster-derived absent list", () => {
    // The refusal is what leaves this seated member with nothing submitted:
    // runAgent rejects, mapSettledWithConcurrency settles it, and no take row
    // is ever created for it.
    const refused = "draco";
    expect(() => parseStanceFromBody("body\nSTANCE: cautiously constructive | CONFIDENCE: 0.65")).toThrow();
    const report = absenceReport(publishedSession());
    expect(report.absent).toContain(refused);
    expect(report.active - report.submitted).toBe(report.absent.length);
  });
});
