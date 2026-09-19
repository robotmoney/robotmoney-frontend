// A take's memo link survives the shared take card, and only a web address is
// ever linked.
//
// The member-authored memo ("Read memo ↗") rendered on the session page before
// RM-121 moved every take into one shared card; the card dropped it, and no
// archived take carries a memo, so nothing on the static preview showed the
// loss. The URL is member supplied, so the card links it only when it is
// http(s): a javascript: or data: URL bound to href would run in our origin.
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { memoHref } from "../../../frontend/public/assets/js/app/lib/take-card.js";

test("only an http(s) address is linked", () => {
  expect(memoHref("https://example.org/memo")).toBe("https://example.org/memo");
  expect(memoHref("  http://example.org/m  ")).toBe("http://example.org/m");
  for (const bad of ["javascript:alert(1)", "JAVASCRIPT:alert(1)", "data:text/html,x", "//example.org", "example.org", "https://ex ample.org", "", null, undefined, 42]) {
    expect(memoHref(bad)).toBe("");
  }
});

test("both take-card templates render the memo link through memoHref", () => {
  const root = new URL("../../../frontend/public/views/swarm/", import.meta.url);
  const session = readFileSync(new URL("session.html", root), "utf8");
  const member = readFileSync(new URL("member.html", root), "utf8");
  expect(session).toContain(':href="memoHref(t.memoUrl)"');
  // The in-progress card and the track-record card.
  expect(member.split(':href="memoHref(row.take.memoUrl)"').length - 1).toBe(2);
  // Never the raw field straight into href.
  for (const html of [session, member]) expect(html).not.toMatch(/:href="(t|row\.take)\.memoUrl"/);
});
