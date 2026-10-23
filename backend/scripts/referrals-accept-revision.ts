// Append a production version tag's referral configuration to the accepted
// revisions (issue 1371, docs/technical/referrals-spec.md §5; D64, D70).
//
//   bun run referrals:accept-revision --tag vX.Y.Z [--write]
//
// Reads, from git, the tag's time and the three files as they stood in the
// tag's tree (backend/src/referrals/config/{registry,corrections,manifest}.json),
// appends them as the next revision, and validates the whole chain: each
// revision against its predecessor at its own tag time. Without --write it
// prints what it would append and changes nothing. Run on the control machine,
// whose checkout has the tags; CI's shallow checkout never needs git history
// because the result is committed.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadReferralConfig, REFERRAL_CONFIG_DIR, validateAcceptedRevisions, type AcceptedRevision } from "../src/referrals/config-files.ts";

const args = process.argv.slice(2);
const tag = args[args.indexOf("--tag") + 1];
if (!args.includes("--tag") || !tag || !/^v\d+\.\d+\.\d+$/.test(tag)) {
  console.error("usage: referrals-accept-revision.ts --tag vX.Y.Z [--write]  (a production version tag, never an rc)");
  process.exit(2);
}
const git = (a: string[]) => execFileSync("git", a, { encoding: "utf8", cwd: join(import.meta.dir, "..") }).trim();
// creatordate is the tagger date of an annotated tag (every release tag).
const taggedAtRaw = git(["for-each-ref", `refs/tags/${tag}`, "--format=%(creatordate:iso-strict)"]);
if (!taggedAtRaw) {
  console.error(`tag ${tag} not found`);
  process.exit(1);
}
const taggedAt = new Date(taggedAtRaw).toISOString().replace(".000Z", "Z");
const file = (name: string) => {
  try {
    return JSON.parse(execFileSync("git", ["show", `${tag}:backend/src/referrals/config/${name}`], { encoding: "utf8", cwd: join(import.meta.dir, ".."), stdio: ["ignore", "pipe", "ignore"] }));
  } catch {
    console.error(`${tag} has no backend/src/referrals/config/${name}; a tag that predates the referral config is not a revision`);
    process.exit(1);
  }
};
const revision: AcceptedRevision = { tag, taggedAt, registry: file("registry.json"), corrections: file("corrections.json"), manifest: file("manifest.json") };

const config = loadReferralConfig();
if (config.accepted.revisions.some((r) => r.tag === tag)) {
  console.error(`${tag} is already an accepted revision`);
  process.exit(1);
}
const next = { ...config.accepted, revisions: [...config.accepted.revisions, revision] };
const errors = validateAcceptedRevisions(next);
if (errors.length) {
  console.error(`${tag} does not validate against the previous accepted revision:\n${errors.join("\n")}`);
  process.exit(1);
}
if (args.includes("--write")) {
  writeFileSync(join(REFERRAL_CONFIG_DIR, "accepted-revisions.json"), JSON.stringify(next, null, 2) + "\n");
  console.log(`appended ${tag} (tagged ${taggedAt}); commit backend/src/referrals/config/accepted-revisions.json`);
} else {
  console.log(JSON.stringify({ wouldAppend: { tag, taggedAt, codes: revision.registry.codes.length, corrections: revision.corrections.entries.length } }));
}
