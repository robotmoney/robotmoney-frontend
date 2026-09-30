// AC-ID-03 — "STAGING RUNS EXACTLY THE PINNED CANDIDATES", asked of the running
// process rather than of the host it happens to sit on.
//
// WHAT WAS MISSING. `/health` reported `{status, env, db, handle_namespace,
// append_only_guard}` and nothing about WHICH SOURCE it was built from. The only
// way to check that a service was running the RC was to ssh to the host and run
// `git rev-parse` in the checkout the image was built from — which answers a
// question about the CHECKOUT, not about the image, and says nothing at all
// once the checkout moves. The 2026-09-13 evaluation recorded exactly that:
// "frontend stage runs untagged f7f08cf7 with RM_ENV=smoke; /health exposes no
// SHA or tag".
//
// EXPLICIT OR UNAVAILABLE — the rule `resolveAumProducerRevision()` already
// applies to producer identity, for the same reason and with the same teeth.
// There is deliberately no fallback to a package version, a build timestamp, a
// branch name or the string "unknown": every one of those LOOKS like identity
// while being unable to identify the source. A blank build arg is persisted as
// `unavailable` with the reason named, and an operator reading `unavailable`
// knows the image was built without its identity rather than reading a value
// that cannot be checked against anything.
//
// NOT READ FROM GIT AT RUNTIME, ever. The container has no repository in it,
// and a process that shelled out to `git` would report the identity of whatever
// tree it could reach — which on a staging host is precisely the unpinned
// checkout AC-ID-03 exists to detect. The values are baked at `docker build`
// time (backend/Dockerfile's ARG/ENV pair, fed by docker-compose.yml's build
// args, whose values scripts/stack/config.ts derives from the tree being
// built), so what the endpoint reports is a property of the IMAGE.

export const BUILD_COMMIT_ENV = "RM_BUILD_COMMIT";
export const BUILD_TAG_ENV = "RM_BUILD_TAG";

export type BuildIdentityField =
  | { status: "available"; value: string; unavailableReason: null }
  | { status: "unavailable"; value: null; unavailableReason: string };

export interface BuildIdentity {
  /** The full 40-character commit SHA the image was built from. */
  commit: BuildIdentityField;
  /** The tag that commit carried at build time, e.g. `v0.5.0-rc.2`. */
  tag: BuildIdentityField;
}

function resolveField(env: Record<string, string | undefined>, key: string): BuildIdentityField {
  const raw = env[key]?.trim();
  return raw
    ? { status: "available", value: raw, unavailableReason: null }
    : { status: "unavailable", value: null, unavailableReason: `${key} is unset or blank` };
}

/** The image's declared build identity. Pure and exported so it can be pinned. */
export function resolveBuildIdentity(
  env: Record<string, string | undefined> = process.env,
): BuildIdentity {
  return { commit: resolveField(env, BUILD_COMMIT_ENV), tag: resolveField(env, BUILD_TAG_ENV) };
}

/**
 * The JSON shape both `/version` and `/health` carry.
 *
 * FLAT AND BORING on purpose: `AC-ID-01` asks that a branch, a full SHA, an RC
 * tag and an artifact digest "all identify the same source", and the check that
 * proves it is a string comparison someone runs from a shell against a URL. A
 * nested or conditionally-shaped body would make that comparison a parsing
 * exercise. `commit` and `tag` are the values or `null`; the `*_unavailable`
 * reasons say why when they are null, and are absent when they are not.
 */
export function buildIdentityJson(identity: BuildIdentity = resolveBuildIdentity()): Record<string, unknown> {
  return {
    commit: identity.commit.value,
    tag: identity.tag.value,
    ...(identity.commit.unavailableReason ? { commit_unavailable: identity.commit.unavailableReason } : {}),
    ...(identity.tag.unavailableReason ? { tag_unavailable: identity.tag.unavailableReason } : {}),
  };
}
