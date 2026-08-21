// #625's remaining acceptance criterion: "Precedence is manifest avatar.path
// (or admin-uploaded override, once the companion issue lands) first, derived
// mark second, initials only when no public key exists." Before this,
// memberMark() was called unconditionally at every call site and avatar.path
// was never read at all.
//
// This covers memberAvatarMarkup() itself, the function the precedence check
// now lives in (frontend/public/assets/js/app/lib/member-mark.js). The actual
// browser fallback -- an <img> whose onerror swaps in the derived mark when
// avatar.path 404s, which is the real shape of roster-seed.ts's seeded paths
// today -- is exercised end to end in
// frontend/test/browser/swarm-index.spec.ts ("a member's avatar.path that
// 404s falls back to the derived mark, not a broken image"), since firing a
// real onerror needs an actual image load, which this DOM-less suite cannot
// do. What's asserted here is the markup memberAvatarMarkup() hands the
// browser: the right src, and a fallback payload that decodes to exactly what
// memberMark()/initials() would have rendered had avatar.path been absent —
// i.e. the two code paths agree, so the browser spec is checking a real
// implementation of the contract pinned here, not a divergent one.
import { describe, expect, test } from "bun:test";
import { memberAvatarMarkup, memberMark } from "../../../frontend/public/assets/js/app/lib/member-mark.js";

const initials = (name: string) => (name || "").slice(0, 2).toUpperCase() || "SW";

// Reverses escapeAttr() inside member-mark.js, so the assertions below can
// compare the ATTRIBUTE payload to the plain memberMark()/initials() output
// rather than restating the escaping rules on this side of the test.
const ATTR_UNESCAPES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" };
function unescapeAttr(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|#39);/g, (_m, name) => ATTR_UNESCAPES[name]);
}

describe("memberAvatarMarkup() precedence (#625)", () => {
  test("no avatar.path: renders exactly what memberMark()/initials() would have, unwrapped", () => {
    const withPath = memberAvatarMarkup(undefined, "athena", "Athena", 40, initials);
    const bare = memberMark("athena", 40);
    expect(withPath).toBe(bare);
    expect(withPath).not.toContain("<img");
  });

  test("blank/whitespace avatar.path is treated as absent, same as undefined", () => {
    expect(memberAvatarMarkup("   ", "athena", "Athena", 40, initials)).toBe(memberMark("athena", 40));
    expect(memberAvatarMarkup(null, "athena", "Athena", 40, initials)).toBe(memberMark("athena", 40));
  });

  test("a member with no seed and no avatar.path still falls to initials, never a bare <img> or empty string", () => {
    const out = memberAvatarMarkup(undefined, "", "Nameless Agent", 40, initials);
    expect(out).toBe("NA");
  });

  // THE 404 CASE. roster-seed.ts sets avatar.path to /avatars/swarm/*.jpg for
  // athena/robotmoney/woon and none of those files exist -- #625's own
  // motivation section. The markup returned here must give the browser
  // everything it needs to recover WITHOUT this module running again: an
  // onerror handler and a fallback payload sitting on the element itself.
  test("with avatar.path: returns an <img> whose onerror payload decodes to the exact derived mark", () => {
    const seed = "robotmoney";
    const name = "Robot Money";
    const size = 40;
    const out = memberAvatarMarkup("/avatars/swarm/robotmoney.jpg", seed, name, size, initials);

    expect(out).toContain('src="/avatars/swarm/robotmoney.jpg"');
    expect(out).toContain(`width="${size}"`);
    expect(out).toContain(`height="${size}"`);
    // Wired to recover on its own via an Alpine directive, not an inline
    // `onerror=` HTML attribute: the app's CSP (backend/src/api/static.ts,
    // script-src with no unsafe-inline) blocks inline event-handler content
    // attributes outright, confirmed by driving this markup through a real
    // page (frontend/test/browser/swarm-index.spec.ts).
    expect(out).toContain("x-on:error=");
    expect(out).not.toContain("onerror=");
    expect(out).toContain("$el.dataset.markFallback");

    const fallbackAttrMatch = out.match(/data-mark-fallback="([^"]*)"/);
    expect(fallbackAttrMatch).not.toBeNull();
    const decoded = unescapeAttr(fallbackAttrMatch![1]);
    // The precedence chain's second rung: what a 404 recovers to is byte-for-byte
    // what memberMark() alone (no avatar.path at all) would have rendered --
    // never a different mark, never a broken-image affordance.
    expect(decoded).toBe(memberMark(seed, size));
  });

  test("a real (loadable-shaped) avatar.path takes precedence over the derived mark", () => {
    const out = memberAvatarMarkup("/avatars/swarm/athena.jpg", "athena", "Athena", 40, initials);
    expect(out.startsWith("<img")).toBe(true);
    expect(out).not.toBe(memberMark("athena", 40));
  });

  test("avatar.path is HTML-attribute-escaped, so a hostile manifest value cannot break out of src=\"\"", () => {
    const hostile = '"><script>alert(1)</script>';
    const out = memberAvatarMarkup(hostile, "athena", "Athena", 40, initials);
    expect(out).not.toContain("<script>");
    expect(out).toContain("&quot;&gt;&lt;script&gt;");
  });
});
