// Issue 1123 nits. The admin session page's non-forced excuse must not send `reason`.
// backend/src/api/routes/swarm-admin.ts answers 400 to a `reason` without
// `force: true`, and this form never sends `force`. Add and restore ignore the
// field, so they keep sending it.
import { expect, test } from "bun:test";

(globalThis as { window?: unknown }).window ??= { RM_CONFIG: { API_BASE_URL: "" } };
(globalThis as { sessionStorage?: unknown }).sessionStorage ??= { getItem: () => "tok", setItem() {}, removeItem() {} };

const { api } = (await import("../../../frontend/public/assets/js/app/lib/api.js")) as {
  api: { adminPost: (route: string, token: string, body: unknown) => Promise<unknown> };
};
// A variable specifier keeps this unchecked browser module out of the root
// TypeScript program (it carries no @ts-nocheck pragma).
const sessionViewPath = "../../../frontend/public/assets/js/app/alpine/views/admin/swarm-session.js";
const { registerAdminSwarmSession } = (await import(sessionViewPath)) as {
  registerAdminSwarmSession: (a: unknown) => void;
};

async function submit(operation: string): Promise<{ route: string; body: Record<string, unknown> }> {
  let factory!: () => Record<string, any>;
  registerAdminSwarmSession({ data: (_n: string, f: () => Record<string, any>) => (factory = f) });
  const view = factory();
  view.sessionId = "sess-1";
  view.load = async () => {};
  view.rosterForm = { operation, memberId: "nova", reason: "a reason of enough length" };
  const real = api.adminPost;
  let seen!: { route: string; body: Record<string, unknown> };
  api.adminPost = async (route, _t, body) => { seen = { route, body: body as Record<string, unknown> }; return {}; };
  try {
    await view.submitRosterForm();
  } finally {
    api.adminPost = real;
  }
  return seen;
}

test("excuse sends only memberId", async () => {
  const { route, body } = await submit("excuse");
  expect(route).toContain("/roster/excuse");
  expect(body).toEqual({ memberId: "nova" });
});

test("topic-deactivate dialog does not claim to close the open session", async () => {
  // deactivateSubjectAdmin closes nothing: the window runs to its close (D55 (4)).
  const html = await Bun.file(
    new URL("../../../frontend/public/views/admin/swarm-subject.html", import.meta.url),
  ).text();
  expect(html).not.toMatch(/Closes the topic's open session/);
  expect(html).toMatch(/keeps collecting until its scheduled close/);
});

test("add and restore still send the reason", async () => {
  for (const op of ["add", "restore"]) {
    expect((await submit(op)).body).toEqual({ memberId: "nova", reason: "a reason of enough length" });
  }
});

function sessionView(): Record<string, any> {
  let factory!: () => Record<string, any>;
  registerAdminSwarmSession({ data: (_n: string, f: () => Record<string, any>) => (factory = f) });
  return factory();
}

test("the admin session page labels the winning answer as drawn, never 'NOT applied (awaiting_draw)' (D71)", () => {
  const view = sessionView();
  view.session = { state: "published" };
  const winner = { mode: "enforce", applied: true, drawn: true, appliedSkippedReason: null, carriedBySession: true };
  expect(view.judgementEffect(winner)).toBe("drawn — this answer is the session's judgement");
  // A drawn row whose session no longer carries it reads as superseded, still as drawn.
  expect(view.judgementEffect({ ...winner, carriedBySession: false, supersededReason: "recommendation_overwritten" })).toContain("drawn, then SUPERSEDED");
});

test("an on-time answer that lost the draw reads as recorded and not drawn, and before the draw as awaiting it", () => {
  const view = sessionView();
  const loser = { mode: "enforce", applied: false, drawn: false, appliedSkippedReason: "awaiting_draw" };
  view.session = { state: "published" };
  expect(view.judgementEffect(loser)).toBe("recorded on time, not drawn");
  expect(view.judgementEffect(loser)).not.toContain("NOT applied");
  view.session = { state: "judging" };
  expect(view.judgementEffect(loser)).toContain("awaiting the draw");
});

test("an answer after the deadline and a session published before the draw read as they always did", () => {
  const view = sessionView();
  view.session = { state: "published" };
  expect(view.judgementEffect({ mode: "enforce", applied: false, appliedSkippedReason: "after_deadline" })).toBe("recorded, NOT applied (after_deadline)");
  expect(view.judgementEffect({ mode: "enforce", applied: true, carriedBySession: true })).toBe("applied to the session");
});

test("a drawn session skips the legacy 'judged' step on the lifecycle", () => {
  const view = sessionView();
  view.session = { state: "published" };
  view.judgements = [{ drawn: true }];
  const steps = Object.fromEntries(view.lifecycleSteps().map((s: { state: string; status: string }) => [s.state, s.status]));
  expect(steps.judging).toBe("done");
  expect(steps.judged).toBe("skipped");
  expect(steps.published).toBe("current");
});
