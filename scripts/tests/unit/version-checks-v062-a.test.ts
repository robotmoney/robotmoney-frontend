// The pure decisions of five v0.6.2 version checks (scripts/release/version-checks/v0.6.2/):
// maintenance-fallback (1293), missed-sessions (1343), closed-session-take (1338),
// starter-takes (1334) and dry-run-take (1341). Each test pairs the shipped shape
// with a red control: the shape before the PR, or the failure the check exists to catch.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { closedTakeProblems, type ClosedTakeObservation } from "../../release/version-checks/v0.6.2/closed-session-take.ts";
import { dryRunProblems, type DryRunObservation } from "../../release/version-checks/v0.6.2/dry-run-take.ts";
import { maintenanceProblems } from "../../release/version-checks/v0.6.2/maintenance-fallback.ts";
import { missedSessionsProblems } from "../../release/version-checks/v0.6.2/missed-sessions.ts";
import { NEW_ADVICE, OLD_ADVICE, starterProblems } from "../../release/version-checks/v0.6.2/starter-takes.ts";
import { dryRunBody, pickInHouseAgent, safeId } from "../../release/version-checks/v0.6.2/_member.ts";

const ROOT = join(import.meta.dir, "..", "..", "..");
const CONF = readFileSync(join(ROOT, "website-server", "nginx.conf"), "utf8");
const TABLE_OK = { exists: true, insert: true, update: false, delete: false, truncate: false };

describe("maintenance-fallback (1293, migration 0120)", () => {
  test("the committed nginx.conf, an insert-only table and a 200 status pass", () => {
    expect(maintenanceProblems({ conf: CONF, table: TABLE_OK, statusCode: 200 })).toEqual([]);
  });
  test("red: the config without the /api/ fallback, an unreadable config, a table rm_app may delete from, and a down status route", () => {
    const stripped = CONF.replace(/error_page\s+502\s+503\s+504\s+=\s+@maintenance_body;/g, "");
    expect(maintenanceProblems({ conf: stripped, table: TABLE_OK, statusCode: 200 }).join()).toContain("/api/ answers @maintenance_body");
    expect(maintenanceProblems({ conf: null, table: TABLE_OK, statusCode: 200 }).join()).toContain("could not be read");
    expect(maintenanceProblems({ conf: CONF, table: { ...TABLE_OK, delete: true }, statusCode: 200 }).join()).toContain("DELETE");
    expect(maintenanceProblems({ conf: CONF, table: { ...TABLE_OK, exists: false }, statusCode: 200 }).join()).toContain("does not exist");
    expect(maintenanceProblems({ conf: CONF, table: TABLE_OK, statusCode: 502 }).join()).toContain("502");
  });
});

describe("missed-sessions (1343, migration 0122)", () => {
  const member = (over: Record<string, unknown> = {}) => ({ id: "m1", status: 200, silentSessions: 0, silentThreshold: 7, ...over });
  test("one baseline row and members with a count pass", () => {
    expect(missedSessionsProblems([{ counted_from: "2026-10-15 19:40:00+00" }], [member(), member({ id: "m2", silentSessions: 3 })])).toEqual([]);
  });
  test("red: no baseline row, a null count (the pre-1343 member shape), a 404 and no seat", () => {
    expect(missedSessionsProblems([], [member()]).join()).toContain("0 row(s)");
    expect(missedSessionsProblems([{ counted_from: "2026-10-15" }], [member({ silentSessions: null })]).join()).toContain("not a count");
    expect(missedSessionsProblems([{ counted_from: "2026-10-15" }], [member({ status: 404 })]).join()).toContain("404");
    expect(missedSessionsProblems([{ counted_from: "2026-10-15" }], []).join()).toContain("no active member-role seat");
  });
});

describe("closed-session-take (1338)", () => {
  const S = "11111111-2222-3333-4444-555555555555";
  const refused = (over: Partial<ClosedTakeObservation> = {}): ClosedTakeObservation => ({
    sessionId: S, status: 200, rowsBefore: 5, rowsAfter: 5,
    verdict: { dryRun: true, sessionId: S, checks: [{ check: "token", ok: true }, { check: "window", ok: false, status: 409, error: `submission window closed (session ${S})`, situational: true }] },
    ...over,
  });
  test("a take naming a published session is refused at that session, and nothing is written", () => {
    expect(closedTakeProblems(refused())).toEqual([]);
  });
  test("red: the pre-1338 behaviour (redirected to the newer session, window open), a row written, a non-200", () => {
    const redirected = refused({ verdict: { dryRun: true, sessionId: "next-session", checks: [{ check: "window", ok: true }] } });
    const problems = closedTakeProblems(redirected).join("\n");
    expect(problems).toContain("redirected");
    expect(problems).toContain("window check passed");
    expect(closedTakeProblems(refused({ rowsAfter: 6 })).join()).toContain("5 to 6");
    expect(closedTakeProblems(refused({ status: 401, verdict: null })).join()).toContain("401");
    const unnamed = refused({ verdict: { dryRun: true, sessionId: S, checks: [{ check: "window", ok: false, status: 409, error: "submission window closed" }] } });
    expect(closedTakeProblems(unnamed).join()).toContain("does not name the session");
  });
});

describe("dry-run-take (1341)", () => {
  const ok = (over: Partial<DryRunObservation> = {}): DryRunObservation => ({
    anonymousStatus: 401, status: 200, rowsBefore: 9, rowsAfter: 9,
    verdict: { dryRun: true, sessionId: "s", checks: [{ check: "fields", ok: true }, { check: "token", ok: true }, { check: "signature", ok: false, status: 400 }] },
    ...over,
  });
  test("a 401 without a bearer, a 200 verdict with the token ok and the unsigned body refused, nothing written", () => {
    expect(dryRunProblems(ok())).toEqual([]);
  });
  test("red: the route missing (404 both ways), a row written, an unsigned body accepted", () => {
    expect(dryRunProblems(ok({ anonymousStatus: 404, status: 404, verdict: null })).length).toBe(2);
    expect(dryRunProblems(ok({ rowsAfter: 10 })).join()).toContain("9 to 10");
    const accepted = ok({ verdict: { dryRun: true, checks: [{ check: "token", ok: true }, { check: "signature", ok: true }] } });
    expect(dryRunProblems(accepted).join()).toContain("unsigned body passed");
  });
  test("the body carries every field submit requires, never a real signature, and the session only when named", () => {
    const body = dryRunBody({ memberId: "m", subjectId: "woon", date: "2026-10-15", nonce: "n" });
    expect(body).toEqual({ memberId: "m", date: "2026-10-15", subjectId: "woon", nonce: "n", stance: "neutral", confidence: 0.5, signature: "version-check-unsigned" });
    expect(dryRunBody({ memberId: "m", subjectId: "woon", date: "2026-10-15", sessionId: "s" }).sessionId).toBe("s");
    expect(dryRunBody({ memberId: "m", subjectId: "w", date: "2026-10-15" }).nonce).not.toBe(dryRunBody({ memberId: "m", subjectId: "w", date: "2026-10-15" }).nonce);
  });
  test("the in-house agent is picked from the credential file's agents, in order; a judge or an empty bearer never", () => {
    expect(pickInHouseAgent({ athena: { memberId: "a", bearer: "x" }, "noop-analyst": { memberId: "n", bearer: "y" } })?.handle).toBe("noop-analyst");
    expect(pickInHouseAgent({ "noop-analyst": { memberId: "n", bearer: "" }, athena: { memberId: "a", bearer: "x" } })?.handle).toBe("athena");
    expect(pickInHouseAgent({ themis: { memberId: "t", bearer: "z" } })).toBeUndefined();
    expect(safeId("11111111-2222-3333-4444-555555555555")).toBe(true);
    expect(safeId("x'; DROP TABLE t; --")).toBe(false);
  });
});

describe("starter-takes (1334)", () => {
  const page = (text: string, path = "/views/docs/investment-swarm/api-reference.html") => ({ path, status: 200, text });
  test("open-sessions equals the collecting sessions, and both pages advise polling it", () => {
    expect(starterProblems({ apiStatus: 200, apiIds: ["a", "b"], dbIds: ["b", "a"], docs: [page(`x ${NEW_ADVICE} y`), page(NEW_ADVICE, "/p.html")] })).toEqual([]);
  });
  test("the committed pages carry the new advice and not the old", () => {
    for (const f of ["api-reference", "participation"]) {
      const text = readFileSync(join(ROOT, "frontend", "public", "views", "docs", "investment-swarm", `${f}.html`), "utf8");
      expect(starterProblems({ apiStatus: 200, apiIds: [], dbIds: [], docs: [page(text)] })).toEqual([]);
    }
  });
  test("red: a collecting session missing from the list, a stale extra, the pre-1334 advice, a missing page", () => {
    expect(starterProblems({ apiStatus: 200, apiIds: ["a"], dbIds: ["a", "b"], docs: [] }).join()).toContain("b is missing");
    expect(starterProblems({ apiStatus: 200, apiIds: ["a", "z"], dbIds: ["a"], docs: [] }).join()).toContain("lists z");
    const old = starterProblems({ apiStatus: 200, apiIds: [], dbIds: [], docs: [page(`On reads, ${OLD_ADVICE} at a reasonable interval`)] }).join("\n");
    expect(old).toContain("does not tell an agent to poll open-sessions");
    expect(old).toContain("still tells an agent to poll open-session");
    expect(starterProblems({ apiStatus: 200, apiIds: [], dbIds: [], docs: [{ path: "/p", status: 404, text: "" }] }).join()).toContain("404");
  });
});
