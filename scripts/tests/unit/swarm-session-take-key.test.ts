// ONE CARD PER MEMBER, not one per revision (issue #573, ADR D32).
//
// WHAT BROKE, AND WHY A TEST HAD TO GO HERE. Migration 0028 relaxed
// `UNIQUE (session_id, member_id)` on swarm_recommendations so a member can
// amend its take inside a session. Every revision is a distinct row with its
// own `gen_random_uuid()` primary key. frontend/public/views/swarm/session.html
// rendered its two take loops with `:key="t.id || t.memberId"` — the row id
// first — so the day a session carried two revisions from one member, that page
// would have drawn that member twice: two rows in the stance/confidence table
// and two take cards, with the superseded prose sitting next to the current
// prose under the same name.
//
// The server-side half of the guarantee (the session payload carries one take
// per member, resolved latest-per-member) is asserted against a real Postgres
// in backend/tests/swarm-take-revisions.test.ts. This is the OTHER half, and it
// is genuinely independent: a correct payload rendered through a row-id key is
// still correct today and still one regression away from being wrong, and the
// backend suite cannot see a template. Keying on the member also makes any
// future latest-per-member regression LOUD — Alpine raises a duplicate-key
// error rather than silently doubling a member.
//
// Runs in the required `unit.yml` job (`bun run test:unit`, and again in that
// workflow's `bun run test` sweep over scripts/tests). No DB, no network.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SESSION_VIEW = join(root, "frontend/public/views/swarm/session.html");

/**
 * Every `x-for` over `takes` in the session view, with its `:key` expression.
 * Extracted from the real markup rather than hand-copied, so a THIRD take loop
 * added later is covered without anyone remembering to list it here.
 */
function takeLoopKeys(html: string): string[] {
  const keys: string[] = [];
  const re = /<template\s+x-for="([^"]*)"\s+:key="([^"]*)"/g;
  for (const m of html.matchAll(re)) {
    const [, iteration, key] = m;
    if (/\bin\s+takes\b/.test(iteration!)) keys.push(key!);
  }
  return keys;
}

describe("session.html take loops key on the member, not the take row id", () => {
  const html = readFileSync(SESSION_VIEW, "utf8");
  const keys = takeLoopKeys(html);

  test("the loops this test is about still exist", () => {
    // Guards the selector itself: a rename that made `takeLoopKeys` return []
    // would otherwise make every assertion below vacuously green.
    expect(keys.length).toBeGreaterThanOrEqual(2);
  });

  test("every take loop keys on memberId FIRST", () => {
    for (const key of keys) {
      // `t.memberId || t.id` is the shipped form: the member id is what the
      // loop has exactly one of, and the row-id fallback covers the shipped
      // static archive payloads, whose takes carry no id at all.
      expect(key).toMatch(/^t\.memberId\b/);
    }
  });

  test("no take loop keys on the row id first — the form that renders one card per revision", () => {
    for (const key of keys) {
      expect(key).not.toMatch(/^t\.id\b/);
    }
  });

  // The red direction, asserted in CI rather than demonstrated by hand once:
  // the extractor really does reject the pre-#573 markup.
  test("the pre-#573 key form would fail this test", () => {
    const regressed = takeLoopKeys(
      '<template x-for="t in takes" :key="t.id || t.memberId"><article></article></template>',
    );
    expect(regressed).toEqual(["t.id || t.memberId"]);
    expect(regressed[0]).not.toMatch(/^t\.memberId\b/);
    expect(regressed[0]).toMatch(/^t\.id\b/);
  });
});
