// This file USED TO BE the live test in the deleted `contract/tests/live/` directory,
// and the reason it is here now is the whole content of this header.
//
// WHAT USED TO BE HERE, AND WHERE IT WENT. That file made a REAL HTTPS request
// to `SWARM_ONBOARDING_SKILL_URL` — robotmoney.network — and ran in the required
// `contract` merge gate on every pull request, on the `contract/**` path filter
// it already carried. It carried four things:
//
//   the HTTP 200, the front-matter `name:` that must agree with the URL's own
//   slug, the `rmpc` marker, `/api/swarm/apply`, `swarm-token-claim-v1`,
//   `claimed`, `/swarm/apply/`, the "no instructions to follow" negative and the
//   procedure floor … now check B of
//   .github/workflows/production-drift-audit.yml (its checks C and D moved there
//   in the previous commit; B joins them here)
//
//   the unverified `| tar` install floor … check C of the same auditor
//
//   the RED CONTROL — a sibling path on the same host that cannot exist, used to
//   prove the assertions above can actually fail … check D of the same auditor
//
//   …and ONE hermetic assertion, the one in this file.
//
// WHY ALL THE NETWORK ONES LEFT THE MERGE GATE. Whether robotmoney.network
// answers is not a property of the commit under review. It depends on deploys,
// DNS, TLS, CDN state, and renames and releases in robotmoney-core — none of
// which any diff in this repository can change, and none of which this repository
// owns. It was measured while this move was made: the `contract` job was RED on
// an open pull request with `Received: 502`, caused by nobody in that pull
// request. A required job that reaches the public internet on every PR means any
// contributor with a flaky connection, and any upstream hiccup, holds an
// unmergeable PR for a reason the diff cannot fix. That is required reading
// whose resolution is not in the author's hands, and the repository owner has
// decided that is not a merge gate. The endpoint is still watched — nightly, by
// the auditor, which reports and never gates — but a red report body is not a
// red build.
//
// THE CONSEQUENCE, STATED PLAINLY: NOTHING IN THIS REPOSITORY'S MERGE GATE
// VERIFIES THAT THE SKILL ENDPOINT IS ALIVE OR THAT WHAT IT SERVES IS THE SKILL.
// Not one required check, not one nightly mirror. That is intended, and the only
// CI that looks is `.github/workflows/production-drift-audit.yml` (checks B and
// D), which answers the question once a night and always exits 0. The cost is
// real: a URL that 404s or a skill that becomes a stub is now found by tonight's
// audit rather than on the pull request that introduced it.
//
// WHY THE SURVIVOR IS IN `tests/unit/` AND NOT `tests/live/`. Two reasons, and the
// second is the one that decides it.
//
//   (1) D23 rule 1 (docs/architecture.md §3, docs/decisions.md D23): a directory
//       IS a cost class, and a test's cost class is legible from its path before
//       anything runs. `tests/live/` means "needs real external network". The one
//       assertion left makes no network call, so keeping it there would make the
//       path lie about what the test costs — the same class of lie as tagging a
//       network test `*-unit.test.ts`.
//   (2) `tests/live/` is not kept, empty, either. `bun test <dir>` against an
//       empty or missing directory exits 1 on bun 1.3.x, so keeping the directory
//       while removing the file would either leave `bun run test:live` a step
//       that is permanently red, or leave a `test:live` script that no workflow
//       invokes — which is precisely the false green issue #484 was filed about,
//       when `test:live` was declared in `contract/package.json` and invoked by
//       zero of eleven workflows for the whole life of the guard it named. The
//       directory, the script, and the `contract.yml` step are all deleted, and
//       scripts/tests/unit/ci-workflows-structure.test.ts now asserts that
//       absence, so the next person to add a network test to a merge gate meets
//       a red rather than a precedent.
//
// Loud-skip-never (test-coverage-policy invariant 1) has nothing to say about
// this file, and that is the honest way for it to read: there is no external
// resource here, so there is nothing that could be silently skipped. Invariant
// 2 is likewise not needed — a `tests/live/` selection that collects no tests is
// not a thing that can exist here any more, because the selection and the
// directory are both gone rather than emptied. Invariant 3 needs no argument
// either: this assertion runs in the required `contract` job, via
// `bun run test` (`bun test tests/unit`), on every pull request touching
// `contract/**` and on every push to `main`. If it is ever moved out of that
// selection, the `contract` workflow stops asserting anything about this URL at
// all, which is a visible loss rather than a silent one.
import { describe, expect, test } from "bun:test";
import { SWARM_ONBOARDING_SKILL_URL } from "../../src/swarm-application.js";

/**
 * The skill slug the URL itself names — the directory immediately above
 * `SKILL.md`. Derived rather than hardcoded, so an assertion keyed to the slug
 * keeps meaning "the file served IS the skill this URL claims to serve" wherever
 * the constant points: it followed the constant through the cross-repo
 * Committee→Swarm rename and through the move to same-origin hosting without an
 * edit here. The auditor's check B derives the same slug for its `name:`
 * discriminator, which is why this file still matters to it: a slug derived from
 * a constant that stopped naming a skill directory is some unrelated path
 * segment, and `name: <that>` then matches whatever the served document happens
 * to say.
 */
const SKILL_SLUG = new URL(SWARM_ONBOARDING_SKILL_URL).pathname.split("/").at(-2)!;

describe("SWARM_ONBOARDING_SKILL_URL — the URL constant", () => {
  test("the URL names a skill directory above SKILL.md, so the slug below is really derived", () => {
    // Without this, a constant that stopped ending in `<skill>/SKILL.md` would
    // make SKILL_SLUG some unrelated path segment and quietly weaken the
    // auditor's `name:` discriminator into a match on garbage — and the auditor
    // would have no way to notice, because it derives the slug from the same
    // constant. This is the one assertion about this URL that a commit in this
    // repository can break, and therefore the one that stays merge-gated.
    expect(SWARM_ONBOARDING_SKILL_URL.endsWith("/SKILL.md")).toBe(true);
    expect(SKILL_SLUG).toMatch(/^[a-z0-9-]+-onboarding$/);
  });
});
