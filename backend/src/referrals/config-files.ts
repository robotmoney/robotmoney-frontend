// The referral configuration files and their accepted history (issue 1371,
// docs/technical/referrals-spec.md §5, §7, §8).
//
// Four reviewed files under ./config, shipped in the image with the rest of
// backend/ and read by the public lookup, the admin panel and the report:
//
//   registry.json            codes, lifecycle times and the launch block (§5)
//   corrections.json         the append-only admin correction log (§4)
//   manifest.json            the coverage manifest (§7)
//   accepted-revisions.json  those three files as they stood at each production
//                            version tag, with the tag time (D64, D70)
//
// THE PREVIOUS ACCEPTED REVISION. Registry validation compares against the
// registry at the last production version tag (spec §5). CI checks out without
// git history (backend.yml), so that revision is committed here as data, the
// same way tests/fixtures/releases holds a release's schema. A release appends
// its revision with backend/scripts/referrals-accept-revision.ts, which reads
// the tag and its tree from git. The tag time is the revision's deployment time:
// the report rejects any effective time a revision introduced earlier than it.
// Before any release carried these files, the previous revision is empty.
//
// No environment variable is read here: nothing grants attribution or changes
// policy outside these reviewed files (spec §5).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalStringify, sha256Hex } from "../analytics/run-ledger.ts";
import { checkCorrectionLog, emptyCorrectionLog, validateCorrectionLogHistory, type CorrectionLog } from "./corrections.ts";
import { validateManifest, validateManifestHistory, type ReferralManifest } from "./manifest.ts";
import { emptyRegistry, isoToSeconds, validateRegistryHistory, type ReferralRegistry } from "./registry.ts";

export const REFERRAL_CONFIG_DIR = join(import.meta.dir, "config");

export interface AcceptedRevision {
  /** The production version tag (vX.Y.Z) this revision shipped in. */
  tag: string;
  /** The tag's time, ISO 8601 UTC: the revision's deployment time. */
  taggedAt: string;
  registry: ReferralRegistry;
  corrections: CorrectionLog;
  manifest: ReferralManifest;
}

export interface AcceptedRevisions {
  schemaVersion: 1;
  revisions: AcceptedRevision[];
}

export interface ReferralConfig {
  registry: ReferralRegistry;
  corrections: CorrectionLog;
  manifest: ReferralManifest;
  accepted: AcceptedRevisions;
}

function readJson<T>(dir: string, name: string): T {
  return JSON.parse(readFileSync(join(dir, name), "utf8")) as T;
}

export function loadReferralConfig(dir: string = REFERRAL_CONFIG_DIR): ReferralConfig {
  return {
    registry: readJson(dir, "registry.json"),
    corrections: readJson(dir, "corrections.json"),
    manifest: readJson(dir, "manifest.json"),
    accepted: readJson(dir, "accepted-revisions.json"),
  };
}

/** The canonical sha256 digest the report records for a config file's content. */
export function configDigest(value: unknown): string {
  return sha256Hex(canonicalStringify(value));
}

/** The registry/log/manifest a revision's predecessor held: the previous entry, or empty before the first. */
function predecessor(revisions: AcceptedRevision[], i: number, manifest: ReferralManifest): { registry: ReferralRegistry; corrections: CorrectionLog; manifest: ReferralManifest } {
  const p = revisions[i - 1];
  return p ? { registry: p.registry, corrections: p.corrections, manifest: p.manifest } : { registry: emptyRegistry(), corrections: emptyCorrectionLog(), manifest: { ...manifest, entries: [] } };
}

/**
 * Validate the whole accepted chain: each revision against its predecessor at
 * its own tag time, tags in time order. Every problem is prefixed by its tag.
 */
export function validateAcceptedRevisions(accepted: AcceptedRevisions): string[] {
  const errors: string[] = [];
  if (accepted.schemaVersion !== 1) errors.push("accepted-revisions: schemaVersion must be 1");
  let last = -Infinity;
  accepted.revisions.forEach((rev, i) => {
    const at = isoToSeconds(rev.taggedAt);
    if (!/^v\d+\.\d+\.\d+$/.test(rev.tag)) errors.push(`${rev.tag}: a revision is a production version tag vX.Y.Z`);
    if (at === null) {
      errors.push(`${rev.tag}: taggedAt must be an ISO 8601 UTC time`);
      return;
    }
    if (at < last) errors.push(`${rev.tag}: revisions are listed in tag-time order`);
    last = at;
    const prev = predecessor(accepted.revisions, i, rev.manifest);
    errors.push(...validateRevisionStep(prev, rev, at).map((e) => `${rev.tag}: ${e}`));
  });
  return errors;
}

/** One step: `next` (registry, log, manifest) as the successor of `prev`, deployed at `deployedAt`. */
export function validateRevisionStep(
  prev: { registry: ReferralRegistry; corrections: CorrectionLog; manifest: ReferralManifest },
  next: { registry: ReferralRegistry; corrections: CorrectionLog; manifest: ReferralManifest },
  deployedAt: number,
): string[] {
  return [
    ...validateRegistryHistory(prev.registry, next.registry, deployedAt),
    ...validateCorrectionLogHistory(prev.corrections, next.corrections, deployedAt),
    ...checkCorrectionLog(next.corrections, next.registry).logErrors,
    ...(prev.manifest.entries.length ? validateManifestHistory(prev.manifest, next.manifest) : validateManifest(next.manifest)),
  ];
}

/**
 * The working tree's files against the last accepted revision, deployed no
 * earlier than `now`. This is the CI check: a change whose effective time has
 * already passed before it could ship fails here and must be rescheduled.
 */
export function validateWorkingConfig(config: ReferralConfig, now: number): string[] {
  const revs = config.accepted.revisions;
  const prev = revs.length ? revs[revs.length - 1]! : null;
  const base = prev
    ? { registry: prev.registry, corrections: prev.corrections, manifest: prev.manifest }
    : { registry: emptyRegistry(), corrections: emptyCorrectionLog(), manifest: { ...config.manifest, entries: [] } };
  const deployedAt = Math.max(now, prev ? (isoToSeconds(prev.taggedAt) ?? now) : now);
  return [...validateAcceptedRevisions(config.accepted), ...validateRevisionStep(base, config, deployedAt)];
}
