// LIVE cost class (docs/architecture.md §3 "Test, eval, and tooling layout",
// L1): this file makes a REAL request to raw.githubusercontent.com, so it lives
// in its own directory and is unreachable from the contract package's default
// target (`bun test tests/unit`) and from the repo root's `bun test
// scripts/tests`.
//
// WHERE IT RUNS (issue #484). It is invoked by `bun run test:live` in the
// `contract` job of .github/workflows/contract.yml — the same already-required
// job that runs `check-contract` and the offline contract unit tests, on every
// trigger that job has: `pull_request`, `push: branches: [main]`, and the
// nightly schedule that mirrors the merge set.
//
// That is a DELIBERATE CHANGE from what this header used to claim. It used to
// say it ran "only via `bun run test:live` in the `contract-live-urls` job of
// .github/workflows/nightly-fetchers.yml" — a workflow that does not exist, in
// this repo or any branch of it. `grep -rn 'test:live' .github/workflows/`
// returned nothing: the script was declared in contract/package.json and
// invoked by zero of eleven workflows, so this file had never executed in CI at
// any point in its life. It would have caught the #407 rename on its first run.
// A guard nobody runs is exactly the false green this repo's test-coverage
// policy exists to forbid, so the repair is not another schedule-only home —
// it is the per-PR, per-merge, required path, where a red is seen by the person
// who caused it and before the break reaches users. The pre-merge cost is one
// HTTPS GET, on the `contract/**` path filter the job already carries.
//
// What it exists to catch: SWARM_ONBOARDING_SKILL_URL is the single
// discovery mechanism in the D21 onboarding flow — the launch prompt tells the
// member agent to install this skill, and everything downstream (rmpc install,
// keygen, signed apply) is described only inside it. A URL that 404s produces
// no error anywhere in this repo; the agent just fails to onboard. That is
// exactly how the `/main/` form (robotmoney-core's default branch is `dev`)
// survived, and then how #407's rename onto a `robotmoney-swarm` plugin that
// does not exist in robotmoney-core survived for two days in production.
//
// Loud-skip-never (test-coverage policy invariant 1): there is deliberately NO
// try/catch, NO env gate, and NO conditional skip below, and the job that runs
// it carries no `continue-on-error`. If DNS fails, egress is blocked, or GitHub
// is down, the fetch rejects and this file fails RED. A missing external
// resource must never be reported as a pass. Invariant 2 comes for free from
// the directory selection: `bun test` against an empty or missing directory
// exits 1 on bun 1.3.x, so an emptied `tests/live/` is red, not a vacuous
// green.
import { describe, expect, test } from "bun:test";
import { SWARM_ONBOARDING_SKILL_URL } from "../../src/swarm-application.js";

const TIMEOUT_MS = 30_000;

/**
 * The skill slug the URL itself names — the directory immediately above
 * `SKILL.md`. Derived rather than hardcoded so this file keeps asserting "the
 * file served IS the skill this URL claims to serve" across the half-finished
 * cross-repo Committee→Swarm rename: it reads `committee-onboarding` today
 * (that is what robotmoney-core actually publishes) and becomes
 * `swarm-onboarding` the moment the constant is repointed, with no edit here.
 */
const SKILL_SLUG = new URL(SWARM_ONBOARDING_SKILL_URL).pathname.split("/").at(-2)!;

describe("SWARM_ONBOARDING_SKILL_URL — live reachability", () => {
  test("the URL names a skill directory above SKILL.md, so the slug below is really derived", () => {
    // Without this, a constant that stopped ending in `<skill>/SKILL.md` would
    // make SKILL_SLUG some unrelated path segment and quietly weaken every
    // body assertion below into a match on garbage.
    expect(SWARM_ONBOARDING_SKILL_URL.endsWith("/SKILL.md")).toBe(true);
    expect(SKILL_SLUG).toMatch(/^[a-z0-9-]+-onboarding$/);
  });

  test(
    "serves HTTP 200 and the onboarding skill's own content",
    async () => {
      const res = await fetch(SWARM_ONBOARDING_SKILL_URL, { redirect: "follow" });

      // 200 only. A 404 (wrong branch segment, or a plugin/skill directory that
      // does not exist in robotmoney-core), a 3xx that did not resolve, or a 5xx
      // are all failures of the same user-visible thing: the agent cannot read
      // the skill.
      expect(res.status).toBe(200);

      const body = await res.text();

      // A 200 is necessary but not sufficient — raw.githubusercontent.com and
      // github.com both happily return 200 with an HTML landing page or a
      // redirect target that is not this file. Assert the skill's OWN markers so
      // a 200-with-wrong-body still fails: the front-matter name (which must
      // agree with the slug the URL names — a URL pointing into one skill's
      // directory while serving another skill's file is a misconfiguration, not
      // a success), and a mention of the rmpc toolchain the skill exists to
      // install.
      expect(body).toContain(`name: ${SKILL_SLUG}`);
      expect(body).toContain("rmpc");
      expect(body.length).toBeGreaterThan(500);

      // A 200 with the right NAME is still not sufficient — measured, not
      // hypothetical. When core landed its rename (core#1199 / PR #1200) it
      // replaced the path this constant then pointed at with a 1,951-byte
      // deprecation stub. The stub kept the old front-matter `name:`, mentioned
      // `rmpc` (only to say it had not changed), and cleared the 500-byte floor,
      // so every assertion above passed while the served body read, verbatim:
      // "This file is a compatibility stub. It contains no instructions to
      // follow." Agents were handed a signpost instead of a procedure and this
      // job stayed green for a day.
      //
      // The root cause is structural: SKILL_SLUG is derived from the URL, so it
      // agrees with the served front matter even when the served file is a
      // deprecation notice FOR THAT VERY SLUG. Name matching proves the file is
      // ABOUT the right skill, never that it still contains one.
      //
      // So assert the PROCEDURE. These are the steps an operator's agent cannot
      // onboard without, and a stub that redirects elsewhere cannot carry them
      // without ceasing to be a stub.
      //
      // These must be spelled the way robotmoney-core spells them, since this
      // constant points at core's copy — and core moved under us mid-review.
      // core#1193 (PR #1194) rewrote the skill from `/api/committee/*` to
      // `/api/swarm/*` throughout: zero `committee` API paths remain, and the
      // applicant status URL it prints became `<host>/swarm/apply/<uuid>`.
      // `committee-identity` is the exception and stays — it is the rmpc CLI
      // subcommand, which core#1201 has deliberately NOT renamed ("Investment
      // Committee" remains the on-chain governance body; "Swarm" is the product
      // surface), so it is a stable marker rather than an oversight.
      expect(body).toContain("committee-identity");
      expect(body).toContain("/api/swarm/apply");
      expect(body).toContain("token-claim");

      // The applicant-facing status URL. Approval email is not wired yet, so
      // this page is the only way an applicant can watch their application move
      // through review — if the skill stops telling the agent to surface it,
      // the applicant has no way to check and no notification either.
      expect(body).toContain("/swarm/apply/");

      // Belt and braces on the stub shape itself: a deprecation notice is not a
      // procedure, whatever else it happens to contain.
      expect(body.toLowerCase()).not.toContain("no instructions to follow");
      expect(body.length).toBeGreaterThan(10_000);
    },
    TIMEOUT_MS,
  );

  // RED CONTROL (issue #484). Everything above is a green assertion over a
  // working URL, and a green assertion cannot tell you whether the check would
  // have gone red on the broken input: a stubbed fetch, an egress proxy that
  // answers 200 for everything, or a `res.status` that is never really compared
  // would all leave the test above passing. So this control drives the SAME
  // fetch against a path on the SAME host that cannot exist, and asserts that
  // every discriminator the test above depends on actually fires — a non-200
  // status, and a body carrying neither the front-matter name nor the toolchain
  // marker.
  //
  // Concretely: this is what a run with the constant pointed at a known-404
  // path observes, and therefore why such a run fails this job rather than
  // passing vacuously.
  test(
    "red control: a known-404 path on the same host is observed as non-200, with none of the skill's markers",
    async () => {
      const dead = `${SWARM_ONBOARDING_SKILL_URL}.this-path-cannot-exist`;
      const res = await fetch(dead, { redirect: "follow" });

      expect(res.status).not.toBe(200);
      expect(res.status).toBe(404);

      const body = await res.text();
      expect(body).not.toContain(`name: ${SKILL_SLUG}`);
      expect(body).not.toContain("rmpc");
    },
    TIMEOUT_MS,
  );
});
