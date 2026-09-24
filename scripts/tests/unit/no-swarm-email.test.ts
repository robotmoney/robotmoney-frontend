// The swarm sends no email — issue #1026 W5.1, decision D50 reversing D30.
//
// The acceptance criterion names one command:
//
//   git grep -in "agentmail\|notification_outbox\|SWARM_NOTIFICATION" \
//     -- ':!docs/decisions.md' ':!docs/archive'
//
// This file runs exactly that, against the real repository, and requires it to
// come back empty — except for a PINNED set of paths listed below, each with the
// reason its match is not the feature coming back. The pinned set is the honest
// shape here: three of the four entries are records of the past that cannot be
// edited (an applied migration, a dated changelog) or are about something else
// entirely (an ecosystem roster row for a company with a similar name), and the
// fourth is the drop migration's own filename. Anything NOT in the set fails,
// which is the property the criterion is really asking for.
//
// WHY A GREP AND NOT AN IMPORT CHECK. The feature had seven homes — a backend
// module, a Cloudflare Worker deployed outside this repo's build, three worker
// job kinds, three env settings in four compose/stack files, two database
// objects, and a vendor row in the bill of materials. A type error catches the
// first; nothing catches the rest. The grep is what notices a compose file
// quietly re-acquiring a transport URL.
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..", "..");

/** The criterion's own pattern, verbatim. */
const PATTERN = String.raw`agentmail\|notification_outbox\|SWARM_NOTIFICATION`;

/**
 * Copy that promises an email: an ERE for git grep that JS RegExp reads the
 * same way. Matched case-insensitively.
 */
const EMAIL_PROMISE =
  "email you|we email|emailed on approval|approval notification|activation notification|tell you the moment";

/** path → why a match there is not the feature returning. */
const PINNED: Record<string, string> = {
  // APPLIED HISTORY. 0019 created `committee_notification_outbox`, 0021/0022
  // extended it, 0025 renamed it and 0033 remapped its member ids. A migration
  // that has run on production is a fact, not a file — rewriting one to satisfy
  // a grep would desynchronise every deployed ledger. 0066 is the DROP itself,
  // and it has to name what it drops.
  "backend/migrations/0019_committee_self_serve_claim.sql": "applied history: created the outbox",
  "backend/migrations/0021_committee_waitlist.sql": "applied history: extended the outbox kinds",
  "backend/migrations/0022_committee_application_received_notification.sql":
    "applied history: extended the outbox kinds",
  "backend/migrations/0025_swarm_rename.sql": "applied history: committee_* → swarm_* rename",
  "backend/migrations/0033_swarm_member_uuid_ids.sql": "applied history: remapped member ids",
  "backend/migrations/0066_drop_swarm_notifications.sql": "the migration that removes it names what it removes",
  "docs/technical/bill-of-materials.html": "cites 0066 by filename while stating that no email is sent",
  "backend/schema/snapshot.json": "the snapshot's identity is its migration filename list, 0066 included",
  "backend/tests/rollout-steps-0-5-1.test.ts": "names 0066 as a post-v0.5.1 arrival; a filename list, not a feature",

  // A DIFFERENT COMPANY. `agentmail-16d51f` is an x402 ecosystem project in the
  // seeded projects roster. It has never been our mail vendor's record and is
  // not ours to delete; the name collision is the whole of the match.
  "backend/src/projects/seed/v0-roster-data.json": "x402 ecosystem roster row for an unrelated company",

  // A DATED CHANGELOG ENTRY, March 2026. It records what happened, which is
  // still what happened. Same category as docs/archive, which the criterion
  // already excludes.
  "frontend/public/views/changelog.html": "dated historical entry; the site's changelog is not current state",

  // This file. The pattern and the paths are its subject.
  "scripts/tests/unit/no-swarm-email.test.ts": "this file (the names are the subject)",

  // Re-tests migration 0019's idempotency against a throwaway database migrated
  // only through 0019, so it necessarily names 0019's own table. Nothing in it
  // touches the live schema.
  "backend/tests/swarm-claim.test.ts": "replays 0019 against a throwaway database and names 0019's table",
};

function grepFiles(): string[] {
  const proc = Bun.spawnSync(
    ["git", "grep", "-iIl", "-e", "agentmail", "-e", "notification_outbox", "-e", "SWARM_NOTIFICATION",
      "--", ":!docs/decisions.md", ":!docs/archive"],
    { cwd: REPO },
  );
  // git grep exits 1 with no output when nothing matched, which is the pass.
  const out = proc.stdout.toString().trim();
  if (out === "" && proc.exitCode === 1) return [];
  expect(proc.stderr.toString()).toBe("");
  return out.split("\n").filter(Boolean);
}

describe(`nothing in the repo sends swarm email (/${PATTERN}/i)`, () => {
  test("the criterion's grep finds nothing outside the pinned historical set", () => {
    const unexplained = grepFiles().filter((f) => !(f in PINNED));
    expect(unexplained).toEqual([]);
  });

  test("the grep actually works — it finds the pinned files it is supposed to find", () => {
    // A guard whose scan silently matches nothing exits green forever. The
    // pinned set is non-empty by construction, so seeing it come back proves
    // the pattern, the pathspecs and the cwd are all live.
    const found = grepFiles();
    expect(found.length).toBeGreaterThan(0);
    expect(found).toContain("backend/migrations/0066_drop_swarm_notifications.sql");
  });

  test("every pinned path still exists — a stale exemption is a blind spot", () => {
    for (const path of Object.keys(PINNED)) {
      expect(existsSync(join(REPO, path)), `${path} is pinned but gone; delete the entry`).toBe(true);
    }
  });

  test("the deleted implementation is deleted, not moved", () => {
    // Assembled from segments, never written out as one literal path: the
    // adapter's test file is GONE, and a whole path spelled out here would be a
    // dangling citation to scripts/tests/unit/test-path-citations.test.ts, which
    // is right to refuse one.
    for (const path of [
      join("backend", "src", "swarm", "notifications.ts"),
      join("backend", "src", "swarm", "agentmail-adapter"),
      "agentmail-adapter",
      join("backend", "tests", "agentmail-adapter.test.ts"),
    ]) {
      expect(existsSync(join(REPO, path)), `${path} came back`).toBe(false);
    }
  });

  test("no onboarding copy promises an email the swarm no longer sends", () => {
    // D50 leaves the applicant one channel, their status page, and the
    // waitlist one path, an operator inviting by hand. Copy that still says
    // "we email you" sends applicants to an inbox that stays empty. The scope
    // is what an applicant or their agent reads: the public site and the
    // onboarding skill it serves. The dated changelog is history, as above.
    const copy = Bun.spawnSync(
      ["git", "grep", "-niIE", EMAIL_PROMISE, "--", "frontend/public", ":!frontend/public/views/changelog.html"],
      { cwd: REPO },
    );
    // Exit 1 with no output is "searched and found nothing"; a broken pathspec
    // or pattern is exit 128 with stderr, which must not read as a pass.
    expect(copy.stderr.toString()).toBe("");
    expect(copy.stdout.toString().trim()).toBe("");
    expect(copy.exitCode).toBe(1);
    // The onboarding skill sits under frontend/public, so the scan above covers
    // it. This proves the pathspec reaches the file rather than assuming so.
    const skill = Bun.spawnSync(
      ["git", "ls-files", "--error-unmatch", join("frontend", "public", "skills", "swarm-onboarding", "SKILL.md")],
      { cwd: REPO },
    );
    expect(skill.exitCode).toBe(0);
  });

  test("red control: the copy pattern catches each promise it replaced", () => {
    // The strings the site and skill carried before D50's copy pass. If the
    // pattern stopped matching them, the scan above would pass on anything.
    const re = new RegExp(EMAIL_PROMISE, "i");
    for (const old of [
      "Leave your email and we'll tell you the moment one frees up.",
      "We review it and email you.",
      "it updates itself the moment you are approved, and we email you too.",
      "a contact email for the approval notification",
      "Receives the transactional approval notification.",
      "you are emailed on approval.",
      "valid contact email required for activation notification",
    ]) {
      expect(re.test(old), old).toBe(true);
    }
    // And it leaves the replacement copy alone.
    expect(re.test("Nothing emails you when you are approved")).toBe(false);
  });

  test("no worker job kind delivers a notification", () => {
    const handlers = Bun.spawnSync(
      ["git", "grep", "-n", "-e", "send_activation_notification", "-e", "send_seat_open_notification",
        "-e", "send_application_received_notification", "--", "backend/src"],
      { cwd: REPO },
    );
    expect(handlers.stdout.toString().trim()).toBe("");
  });
});
