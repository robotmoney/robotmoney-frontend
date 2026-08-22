// Holds docs/runbooks/rollout-procedure.md to its own premise: it is the
// RELEASE-INDEPENDENT half of every rollout, and must not name any one
// release's facts.
//
// WHY THIS EXISTS. Nothing tested this document. scripts/lint-docs.sh checks
// filenames, conflict markers and emptiness; rollout-steps-<release>.test.ts
// binds each per-release runbook to its own manifest. The shared document sat
// between them with no binding at all, and drifted exactly the way an untested
// document does — it had absorbed v0.2.2's specifics and kept them through two
// releases:
//
//   - §6.5's acceptance criteria hardcoded v0.2.2's SIX migration filenames as
//     "exactly the six migrations this release ships", in the same paragraph
//     that said the list "has one home now: THIS_RELEASE_MIGRATIONS". v0.3.0
//     ships four different ones.
//   - §9.1's check 2 carried a `LIKE '0029%' OR LIKE '003%'` query expecting
//     those same six rows. Against a v0.3.0 database it returns ten and grades
//     nothing.
//   - §10's rollback trigger read "fewer than six migrations".
//
// Every one of those would have had an operator grade the release in front of
// them against a release that already shipped. The rule this test enforces is
// the same one rollout-steps-*.test.ts enforces from the other side: a fact has
// exactly one home. For a migration list that home is THIS_RELEASE_MIGRATIONS
// in each release's release.ts — never this document.
//
// Filesystem-only: no database, no docker, no network.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testDir, "..", "..");
const docPath = join(repoRoot, "docs", "runbooks", "rollout-procedure.md");
const doc = readFileSync(docPath, "utf8");

/** Lines that legitimately contain a version string: the document's own
 *  provenance note, and the `<FROM>-to-<TO>` / `vA.B.C` placeholders it uses to
 *  describe the shape of a per-release path. */
const PLACEHOLDER = /<FROM>|<TO>|vA\.B\.C|A\.B\.x|v0\.2\.2's|rm-backup-v0XY/;

function offendingLines(re: RegExp): string[] {
  return doc
    .split("\n")
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => re.test(line) && !PLACEHOLDER.test(line))
    .map(({ line, n }) => `${n}: ${line.trim().slice(0, 140)}`);
}

describe("rollout-procedure.md stays release-independent", () => {
  test("does not ENUMERATE a release's migration set", () => {
    // Three or more migration filenames on one line is what a release list
    // looks like — §6.5 and §9.1's check 2 each carried six. Citing ONE
    // migration to explain a mechanism is fine and this document does it
    // legitimately (e.g. 0029_admin_passkey.sql's unguarded REVOKEs, a durable
    // Postgres lesson rather than a release fact), so the rule is about
    // enumeration, not mention.
    const enumerated = doc
      .split("\n")
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => (line.match(/\b\d{4}_[a-z][a-z0-9_]*/g) ?? []).length >= 3)
      .map(({ line, n }) => `${n}: ${line.trim().slice(0, 140)}`);
    expect(enumerated).toEqual([]);
  });

  test("does not state how many migrations a release ships", () => {
    // "the six migrations", "fewer than six migrations", "All six migrations
    // recorded" — a count is a release fact exactly as much as a filename is.
    expect(offendingLines(/\b(two|three|four|five|six|seven|eight|nine|ten|\d+)\s+migrations?\b/i)).toEqual([]);
  });

  test("does not fix the number of postflight checks", () => {
    // §6.5 asked for "every §8 check (check 1–12)". v0.2.2 ran twelve; v0.3.0
    // runs seven plus one manual. The count belongs to runChecks().
    expect(offendingLines(/check\s*1\s*[–-]\s*\d+|checks?\s+1\s*(?:to|through)\s*\d+/i)).toEqual([]);
  });

  test("does not assert which gate letters exist", () => {
    // An earlier revision said "There is no Gate A" while §8.2 of this same
    // document required Gate A green and the v0.3.0 manifest carried it.
    expect(offendingLines(/there is no Gate [A-F]|Gate [A-F][–-][A-F]\b/i)).toEqual([]);
  });
});
