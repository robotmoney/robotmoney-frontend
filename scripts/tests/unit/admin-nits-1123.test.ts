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
