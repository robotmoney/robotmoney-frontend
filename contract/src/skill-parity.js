// Issue #759 — PR #758 (issue #748) closed the unverified `curl | tar xz`
// install form in the REPO-LOCAL swarm-onboarding skill and covered it with a
// test that asserts against that repo-local file only. Nothing checked that
// the bytes actually served over the public web still match — a stale or
// failed deploy could keep the pre-#758 block live while every repo-local
// check stayed green. This module is the shared assertion both a LIVE test
// (real fetch against the deployed URL) and an offline unit test (a fixture
// standing in for a stale deploy) run, so the "goes red on a stale deploy"
// claim is proven against the same logic the live check actually runs, not a
// parallel reimplementation that could quietly diverge from it.
//
// Deliberately returns a description rather than throwing: the caller decides
// how to surface it (a live `expect(...).toBeNull()` for AC1, a unit test
// asserting the returned string's shape for the fixture-goes-red plan item),
// and the caller is the one place that already knows whether it is looking at
// a real production response or a fixture.

const UNVERIFIED_INSTALL_PATTERN = /\|\s*tar\b/;

/**
 * Compare a served skill document's bytes against the repo-local copy it is
 * supposed to mirror.
 *
 * @param {{ url: string, served: string, repoPath: string, repo: string }} params
 *   `url` — the served endpoint, named in the failure output (AC3).
 *   `served` — the bytes actually fetched from `url`.
 *   `repoPath` — the repo-local file's path, named in the failure output.
 *   `repo` — the repo-local file's bytes, read by the caller.
 * @returns {string | null} null when the bytes match; otherwise a message
 *   naming the URL, what differed, and — when the served copy still carries
 *   the unverified pipe-into-tar form the repo's own guard forbids
 *   (scripts/tests/unit/onboarding-skill-rmpc-install-verified.test.ts) —
 *   that the deployed install block may be the unverified form (AC3).
 */
export function describeSkillMismatch({ url, served, repoPath, repo }) {
  if (served === repo) return null;

  const servedLines = served.split("\n");
  const repoLines = repo.split("\n");
  let firstDiff = -1;
  for (let i = 0; i < Math.max(servedLines.length, repoLines.length); i++) {
    if (servedLines[i] !== repoLines[i]) {
      firstDiff = i;
      break;
    }
  }

  const unverified = UNVERIFIED_INSTALL_PATTERN.test(served);

  return [
    `served skill at ${url} does not match the repo-local copy (${repoPath}).`,
    firstDiff === -1
      ? `served has ${servedLines.length} lines, repo has ${repoLines.length} lines, but no line index differs (trailing content mismatch).`
      : `first differing line ${firstDiff + 1}:\n  served: ${JSON.stringify(servedLines[firstDiff] ?? "<missing — served is shorter>")}\n  repo:   ${JSON.stringify(repoLines[firstDiff] ?? "<missing — repo is shorter>")}`,
    unverified
      ? "the served copy contains a `| tar` pipe: the deployed install block may be the pre-#758 unverified curl-into-tar form."
      : "the served copy does not contain an unverified `| tar` pipe, but its bytes still differ from the repo copy — the deploy is stale or diverged some other way.",
  ].join("\n");
}
