// LIVE cost class (docs/architecture.md §3 "Test, eval, and tooling layout",
// L1): this file makes a REAL request to raw.githubusercontent.com. It is
// therefore unreachable from the contract package's default target
// (`bun test tests/unit`, wired into the required `integration` job) and from
// the repo root's `bun test scripts/tests`, so it adds NO network dependency to
// the per-PR path. It runs only via `bun run test:live` in the
// `contract-live-urls` job of .github/workflows/nightly-fetchers.yml
// (schedule + workflow_dispatch, no `pull_request` trigger).
//
// What it exists to catch: SWARM_ONBOARDING_SKILL_URL is the single
// discovery mechanism in the D21 onboarding flow — the launch prompt tells the
// member agent to install this skill, and everything downstream (rmpc install,
// keygen, signed apply) is described only inside it. A URL that 404s produces
// no error anywhere in this repo; the agent just fails to onboard. That is
// exactly how the `/main/` form (robotmoney-core's default branch is `dev`)
// survived: contract/tests/ executed in no CI job at all.
//
// Loud-skip-never (test-coverage policy invariant 1): there is deliberately NO
// try/catch, NO env gate, and NO conditional skip below. If DNS fails, egress is
// blocked, or GitHub is down, the fetch rejects and this file fails RED. A
// missing external resource must never be reported as a pass. Invariant 2 comes
// for free from the directory selection: `bun test` against an empty or missing
// directory exits 1 on bun 1.3.x, so an emptied `tests/live/` is red, not a
// vacuous green.
import { describe, expect, test } from "bun:test";
import { SWARM_ONBOARDING_SKILL_URL } from "../../src/swarm-application.js";

const TIMEOUT_MS = 30_000;

describe("SWARM_ONBOARDING_SKILL_URL — live reachability", () => {
  test(
    "serves HTTP 200 and the swarm-onboarding skill's own content",
    async () => {
      const res = await fetch(SWARM_ONBOARDING_SKILL_URL, { redirect: "follow" });

      // 200 only. A 404 (wrong branch segment), a 3xx that did not resolve, or
      // a 5xx are all failures of the same user-visible thing: the agent cannot
      // read the skill.
      expect(res.status).toBe(200);

      const body = await res.text();

      // A 200 is necessary but not sufficient — raw.githubusercontent.com and
      // github.com both happily return 200 with an HTML landing page or a
      // redirect target that is not this file. Assert the skill's OWN markers so
      // a 200-with-wrong-body still fails: the front-matter name, and a mention
      // of the rmpc toolchain the skill exists to install.
      expect(body).toContain("name: swarm-onboarding");
      expect(body).toContain("rmpc");
      expect(body.length).toBeGreaterThan(500);
    },
    TIMEOUT_MS,
  );
});
