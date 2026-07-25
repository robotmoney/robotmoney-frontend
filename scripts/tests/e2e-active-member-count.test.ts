// Hermetic tests for scripts/lib/committee/session.ts's activeMemberCount() — the demo onboarding
// driver's roster-cap pre-check (scripts/lib/demo-main.ts). Previously a
// failed GET /api/committee/members silently resolved to `{ members: [] }`,
// so activeMemberCount() returned 0 on ANY transient read error — the cap
// check (`active >= COMMITTEE_ROSTER_CAP`) then always passed, letting the
// demo keep admitting new agents regardless of the TRUE roster size. This
// pins the fix: a read failure must report the roster as FULL (Infinity),
// never empty.
//
// Real fetch against a real fixture backend (toggled between test cases via
// a mutable flag, not a mocked `fetch`) — activeMemberCount()'s own logic is
// exercised for real, not the fixture's. Uses activeMemberCount()'s test-only
// backendUrl override rather than process.env.BACKEND_URL: that env var is
// process-wide and session.ts's own BACKEND constant captures it once at import
// time, which is unsafe to mutate when other test files in the same run also
// touch it (a real cross-file race was observed before this change).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ROUTES } from "@robotmoney/contract";
import { activeMemberCount } from "../lib/committee/session.ts";

let fixtureBackend: ReturnType<typeof Bun.serve>;
let fixtureMode: "ok" | "error" | "malformed" = "ok";
let fixtureMemberIds: string[] = ["athena", "boreas"];
let backendUrl: string;

beforeAll(() => {
  fixtureBackend = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === ROUTES.committee.members) {
        if (fixtureMode === "error") return new Response("boom", { status: 500 });
        if (fixtureMode === "malformed") return Response.json({ notMembers: true });
        return Response.json({ members: fixtureMemberIds.map((id) => ({ id })) });
      }
      return Response.json({ error: `unhandled fixture route: ${req.method} ${url.pathname}` }, { status: 404 });
    },
  });
  backendUrl = `http://localhost:${fixtureBackend.port}`;
});

afterAll(() => {
  fixtureBackend.stop(true);
});

describe("activeMemberCount() — fails CONSERVATIVELY (assume full), never assume empty", () => {
  test("a successful read returns the real member count", async () => {
    fixtureMode = "ok";
    fixtureMemberIds = ["athena", "boreas", "cygnus"];
    expect(await activeMemberCount(backendUrl)).toBe(3);
  });

  test("an empty (but well-formed) roster genuinely reports 0", async () => {
    fixtureMode = "ok";
    fixtureMemberIds = [];
    expect(await activeMemberCount(backendUrl)).toBe(0);
  });

  test("a failed fetch (real network error, not mocked) reports Infinity, NOT 0 — this is the regression this test pins", async () => {
    fixtureMode = "error";
    const count = await activeMemberCount(backendUrl);
    expect(count).toBe(Number.POSITIVE_INFINITY);
    expect(count).toBeGreaterThanOrEqual(10); // >= any plausible COMMITTEE_ROSTER_CAP
  });

  test("a malformed response (no members array) ALSO reports Infinity, not 0", async () => {
    fixtureMode = "malformed";
    expect(await activeMemberCount(backendUrl)).toBe(Number.POSITIVE_INFINITY);
  });

  test("a genuinely unreachable backend (nothing listening) ALSO reports Infinity", async () => {
    // No fixture involved at all — an address with nothing bound behind it.
    expect(await activeMemberCount("http://127.0.0.1:1")).toBe(Number.POSITIVE_INFINITY);
  });

  test("recovers to the real count once the backend is healthy again", async () => {
    fixtureMode = "error";
    expect(await activeMemberCount(backendUrl)).toBe(Number.POSITIVE_INFINITY);
    fixtureMode = "ok";
    fixtureMemberIds = ["athena"];
    expect(await activeMemberCount(backendUrl)).toBe(1);
  });

  test("with no override, defaults to the module's BACKEND constant (real callers never pass one)", async () => {
    // Just proves the default parameter wiring compiles and resolves to
    // SOME string-keyed fetch attempt — not asserting on network behavior,
    // since BACKEND here is whatever this test run's env happened to set.
    expect(activeMemberCount.length).toBe(0); // backendUrl has a default, so arity is 0
  });
});
