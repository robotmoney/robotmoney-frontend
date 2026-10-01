// Issue 1081: `camelSession` (frontend/public/assets/js/app/alpine/static-views.js) is the whitelist that turns an API
// session into the page's model. It dropped `openedAt` and `publishedAt`, so the session page printed the day the row
// was created for a session that opened days later. This guards the next omission: every field the API session carries
// that a page reads must come through.
import { expect, test } from "bun:test";
import { camelSession } from "../../../frontend/public/assets/js/app/alpine/static-views.js";

const API_SESSION = {
  id: "12a04ae6-9d4e-4462-ac62-85d3800b8139",
  date: "2026-09-28",
  subjectId: "robotmoney-vault",
  subjectName: "Robot Money Vault",
  state: "collecting",
  windowClosesAt: "2026-10-01T08:11:10.439Z",
  openedAt: "2026-10-01T02:11:10.439Z",
  publishedAt: "2026-10-01T08:12:00.000Z",
  generatedAt: "2026-09-28T00:11:45.953Z",
  synthesis: "s",
  swarmRecommendation: { type: "position_actions" },
  regimeSummary: null,
};

test("camelSession keeps when the session opened and when it published", () => {
  const s = camelSession(API_SESSION)!;
  expect(s.openedAt).toBe("2026-10-01T02:11:10.439Z");
  expect(s.publishedAt).toBe("2026-10-01T08:12:00.000Z");
  // and does not confuse them with the row-creation fields
  expect(s.generatedAt).toBe("2026-09-28T00:11:45.953Z");
  expect(s.date).toBe("2026-09-28");
});

test("snake_case sessions (the archive's spelling) come through too, and absent fields are null, not undefined", () => {
  const s = camelSession({ id: "a", date: "2026-09-20", subject_id: "x", opened_at: "2026-09-20T01:00:00Z", published_at: "2026-09-20T07:00:00Z" })!;
  expect(s.openedAt).toBe("2026-09-20T01:00:00Z");
  expect(s.publishedAt).toBe("2026-09-20T07:00:00Z");
  const bare = camelSession({ id: "b", date: "2026-06-01", subject_id: "x" })!;
  expect(bare.openedAt).toBeNull();
  expect(bare.publishedAt).toBeNull();
});

test("every field a session page reads from the API session survives the whitelist", () => {
  const s = camelSession(API_SESSION)! as Record<string, unknown>;
  for (const key of ["id", "date", "subjectId", "subjectName", "state", "windowClosesAt", "openedAt", "publishedAt", "generatedAt", "synthesis", "swarmRecommendation"]) {
    expect(key in s, `camelSession dropped ${key}`).toBe(true);
    expect(s[key], `camelSession lost the value of ${key}`).not.toBeUndefined();
  }
  expect(camelSession(null)).toBeNull();
});
