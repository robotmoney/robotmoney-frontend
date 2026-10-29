// Issue #977: the build identity a run/vintage is bound to, so a frozen
// manifest's fingerprint can later prove WHICH build computed it.
//
// Issue 1442: it is the image's baked git commit (RM_BUILD_COMMIT), the same
// value `/version` reports, read through ops/build-identity.ts so the two can
// never disagree. The earlier fallback, `pkg:<package version>+bun:<runtime>`,
// was what production actually recorded (no deploy set RM_BUILD_IDENTITY,
// GIT_SHA or GITHUB_SHA), and it was wrong both ways: the package version never
// moved across code releases, and a Bun upgrade alone gave the same code and
// the same data new fingerprints. The runtime version is never part of it.
//
// AC-ID-03's rule applies: with no commit baked in, the identity is recorded as
// unavailable with the reason named, never a package or runtime string. The
// column is NOT NULL text, so "unavailable" is a string a reader cannot mistake
// for a commit.
//
// Vintages written before this change keep their `pkg:` identity. The ledger is
// append-only, and their manifest digests were hashed over the stored value.
import { resolveBuildIdentity as resolveImageBuildIdentity } from "../ops/build-identity.ts";

export const UNAVAILABLE_BUILD_IDENTITY_PREFIX = "unavailable: ";

export function resolveBuildIdentity(env: Record<string, string | undefined> = process.env): string {
  const { commit } = resolveImageBuildIdentity(env);
  return commit.status === "available"
    ? commit.value.slice(0, 256)
    : `${UNAVAILABLE_BUILD_IDENTITY_PREFIX}${commit.unavailableReason}`;
}
