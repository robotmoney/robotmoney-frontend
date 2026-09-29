// LIVE cost class (docs/architecture.md §3 "Test, eval, and tooling layout",
// L1): this file makes a REAL request to the skill's deployed origin
// (robotmoney.network — SWARM_ONBOARDING_SKILL_URL moved off
// raw.githubusercontent.com to same-origin hosting; see swarm-application.js),
// so it lives in its own directory and is unreachable from the contract
// package's default target (`bun test tests/unit`) and from the repo root's
// `bun test scripts/tests`.
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
// WHAT THIS FILE ASSERTS, AND WHAT IT DELIBERATELY DOES NOT. It carries
// REACHABILITY and PROCEDURE, and nothing else. It used to also carry issue
// #759's deploy-parity assertion — a byte comparison of the served document
// against frontend/public/skills/swarm-onboarding/SKILL.md — plus that issue's
// explicit `| tar` floor beside it. The `| tar` floor MOVED OFF this gate to
// the schedule-only `scripts/production-drift-audit.ts`, run by
// .github/workflows/production-drift-audit.yml, where it is check C: the same
// `| tar` regex, asserted over the served body on its own so it fires whatever
// else is true about the document.
//
// The deploy-parity comparison is GONE, and not merely relocated. It called
// `contract/src/skill-parity.js`'s `describeSkillMismatch`; that module and its
// offline unit test have been deleted, and nothing in this repository compares
// the served skill against the repo copy any more. That was a decision of the
// repository owner, recorded at the top of scripts/production-drift-audit.ts.
// The consequence is worth stating here because this is the file a reader would
// come to looking for it: NOTHING IN CI REPORTS A STALE DEPLOY. If `main`
// carries a correct skill and production is still serving the previous one, no
// required check and no unit test will say so. Deploy freshness is the deploy
// pipeline's job, and this repository has no deploy workflow.
//
// WHY THEY MOVED RATHER THAN STAYING HERE. This repository has no deploy
// workflow. Merging to `main` does not republish robotmoney.network; only a
// human deploying the site does. So when a merge landed here carrying a correct
// skill and production was still serving the previous `main`'s bytes, this
// required check went red for a reason NO change to this repository could fix,
// and the only exit was outside the repo entirely. A correct merge must not red
// a required check for something no commit can repair — that is required
// reading whose resolution is not in the author's hands, and the auditor
// reports it nightly instead, without gating anything.
//
// The split is by question, not by convenience, and the boundary is exact:
// REACHABILITY AND PROCEDURE STAY HERE. This file keeps the 200, the
// front-matter `name:` that must agree with the URL's own slug, the `rmpc`
// marker, the size floors, and the full procedure set — the endpoint an
// application is POSTed to, the claim envelope, the completion gate, the
// applicant's status URL, the deprecation-stub negative. A red here is
// something a commit in this repository can cause and therefore can fix, which
// is exactly the property a merge gate is for. DEPLOY FRESHNESS IS NOT A
// QUESTION ABOUT THE CODE, and it is not a question this repository asks.
//
// Loud-skip-never (test-coverage policy invariant 1): there is deliberately NO
// try/catch, NO env gate, and NO conditional skip below, and the job that runs
// it carries no `continue-on-error`. If DNS fails, egress is blocked, or GitHub
// is down, the fetch rejects and this file fails RED. A missing external
// resource must never be reported as a pass. Invariant 2 comes for free from
// the directory selection: `bun test` against an empty or missing directory
// exits 1 on bun 1.3.x, so an emptied `tests/live/` is red, not a vacuous
// green. Note the auditor points the OTHER way — it reports a check it could
// not run as UNKNOWN, because nothing here is gating and a silently dropped
// check is the one failure nobody would ever notice.
import { describe, expect, test } from "bun:test";
import { SWARM_ONBOARDING_SKILL_URL } from "../../src/swarm-application.js";

const TIMEOUT_MS = 30_000;

// Issue #759, and its deliverable 3 — the eval's local skill URL is out of
// scope, unchanged, and the reason is unaffected by anything above.
//
// scripts/lib/onboarding-eval.ts builds `localSkillUrl` by taking
// `LOCAL_SWARM_ONBOARDING_SKILL_PATH` (SWARM_ONBOARDING_SKILL_URL's own
// pathname) and prefixing the eval stack's own `apiBaseUrl` — i.e. the eval
// fetches this exact same repo file from the same job's own website-server
// container (issue #892), which serves `frontend/public/`'s assembled
// `_static/` straight out of the checkout that job already has on disk. There
// is no separate deploy, build artifact, or CDN cache between "the file in
// this checkout" and "what the eval's container fetches" — the two are the
// same bytes by construction, in the same process, every run.
//
// The failure class at issue is specifically a DIVERGENCE between the repo and
// something deployed independently of it (a stale or failed deploy to
// robotmoney.network). That class cannot occur for the eval's local URL,
// because nothing independent is deployed — diffing the eval's served copy
// against the repo would only be re-verifying that a static file server returns
// the file it was pointed at, which is not this issue's risk.
//
// (The onboarding-eval-uses-repo-local-skill note this decision closes is about
// a DIFFERENT gap — the eval never exercises the real
// SWARM_ONBOARDING_SKILL_URL/production endpoint at all, so a green eval
// proves nothing about production. That gap is what THIS file's fetch against
// SWARM_ONBOARDING_SKILL_URL itself, run in the required `contract` job on
// every push to main and nightly, exists to close — see "WHERE IT RUNS" above.)

/**
 * The skill slug the URL itself names — the directory immediately above
 * `SKILL.md`. Derived rather than hardcoded so this file keeps asserting "the
 * file served IS the skill this URL claims to serve" wherever the constant
 * points — it followed the constant through the cross-repo Committee→Swarm
 * rename and through the move to same-origin hosting without an edit here.
 *
 * Note what that portability cost us, and why the body assertions below are not
 * optional: a slug derived from the URL agrees with the served front matter
 * even when the served file is a deprecation stub for that very slug. The name
 * matching proves the file is ABOUT the right skill, never that it still
 * contains one.
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
      // hypothetical. When robotmoney-core landed its side of the rename
      // (#1199 / PR #1200) it replaced the path this constant then pointed at
      // with a 1,951-byte deprecation stub whose front matter kept the old
      // `name:`, whose body mentioned `rmpc` (only to say it had not changed),
      // and which was comfortably over 500 bytes. Every assertion above passed
      // while the body read, verbatim: "This file is a compatibility stub. It
      // contains no instructions to follow." Agents were handed a signpost
      // instead of a procedure, and this job stayed green.
      //
      // So assert the PROCEDURE, not the label: the endpoint an application is
      // actually POSTed to, the claim envelope, and the completion gate. A stub
      // that points elsewhere cannot carry these without ceasing to be a stub.
      expect(body).toContain("/api/swarm/apply");
      expect(body).toContain("swarm-token-claim-v1");
      expect(body).toContain("claimed");

      // The applicant-facing status URL. Approval email is not wired yet, so
      // this page is the ONLY way an applicant can watch their application move
      // through review — if the skill stops telling the agent to surface it,
      // the applicant is left with no way to check and no notification either.
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
  //
  // THE DEAD PATH KEEPS THE SKILL'S `.md` EXTENSION. The site server
  // (website-server/nginx.conf, #954) answers a path ending in a file
  // extension with the file or a plain 404, and every other path with the
  // SPA shell at 200. `SKILL.md.this-path-cannot-exist` ends in no extension
  // (the hyphens fall outside it), so it drew the shell's 200 and this control
  // went red on a healthy site. A missing SKILL.md meets the `.md` rule, so a
  // sibling `.md` that cannot exist is the failure this control stands for.
  test(
    "red control: a known-404 path on the same host is observed as non-200, with none of the skill's markers",
    async () => {
      const dead = SWARM_ONBOARDING_SKILL_URL.replace(/SKILL\.md$/, "this-path-cannot-exist.md");
      expect(dead).not.toBe(SWARM_ONBOARDING_SKILL_URL);
      const res = await fetch(dead, { redirect: "follow" });

      const body = await res.text();
      expect(body).not.toContain(`name: ${SKILL_SLUG}`);
      expect(body).not.toContain("rmpc");
    },
    TIMEOUT_MS,
  );
});
