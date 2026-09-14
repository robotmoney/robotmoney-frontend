// T26 — WHAT FRONTEND THIS PROCESS IS SERVING, reported beside what image it is.
//
// backend/src/ops/build-identity.ts answers "which source was this IMAGE built
// from". It cannot answer the other half: the api co-serves the SPA from
// STATIC_DIR, which docker-compose.yml mounts read-only from the deploy host's
// `./_static` — a directory assembled by scripts/static-assembly.sh OUTSIDE the
// image, after the image exists, on the host. Nothing baked into the image can
// know anything about it.
//
// So the assembly writes its own manifest into that directory (commit, tag,
// content digest) and this reads it back. The value of the pair is the
// COMPARISON: `matches_image` is false whenever the SPA was assembled from a
// different commit than the api was built from — the exact shape of a redeploy
// that updated the image and forgot `bun run static:assemble`, which until now
// passed every AC-ID-03 check while serving the previous release's HTML.
//
// READ FROM THE MOUNT, NOT BAKED. This is the one identity in this system that
// MUST be read at runtime: it is a property of a directory that is attached to
// the container, and a value baked at image-build time would describe a
// directory this process has never seen. It is still not a `git` call — the
// manifest is written by the build that produced the bytes.
//
// EXPLICIT OR UNAVAILABLE, the same rule as its neighbour: every failure to
// read, parse or validate reports `digest: null` with a NAMED reason and
// `matches_image: false`. There is deliberately no "assume it matches" branch —
// an unreadable manifest is not evidence of agreement.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveBuildIdentity, type BuildIdentity } from "./build-identity.ts";

export const STATIC_MANIFEST_FILENAME = ".rm-static-manifest.json";

export interface StaticIdentityJson {
  digest: string | null;
  commit: string | null;
  tag: string | null;
  files: number | null;
  generated_at: string | null;
  matches_image: boolean;
  unavailable?: string;
}

function unavailable(reason: string): StaticIdentityJson {
  return { digest: null, commit: null, tag: null, files: null, generated_at: null, matches_image: false, unavailable: reason };
}

/**
 * PURE — the manifest's bytes (or `null` when there were none) plus the image's
 * identity, in; the reported JSON, out.
 */
export function staticIdentityFrom(raw: string | null, image: BuildIdentity): StaticIdentityJson {
  if (raw === null) {
    return unavailable(
      `no ${STATIC_MANIFEST_FILENAME} in STATIC_DIR — the served frontend was not assembled by ` +
        `scripts/static-assembly.sh, or STATIC_DIR is not the assembled directory`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return unavailable(
      `${STATIC_MANIFEST_FILENAME} could not be parsed as JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null) {
    return unavailable(`${STATIC_MANIFEST_FILENAME} is not a JSON object`);
  }
  const m = parsed as Record<string, unknown>;
  // A SHAPE CHECK, NOT A CAST. This file is read from a bind mount an operator
  // can write to; a missing digest reported as `undefined` would render as an
  // absent field and read like "no drift" to the check in runbook §7.
  if (typeof m.digest !== "string" || m.digest === "") {
    return unavailable(`${STATIC_MANIFEST_FILENAME} carries no \`digest\` — it is not a manifest this version writes`);
  }
  const commit = typeof m.commit === "string" && m.commit !== "" ? m.commit : null;
  const tag = typeof m.tag === "string" && m.tag !== "" ? m.tag : null;
  return {
    digest: m.digest,
    commit,
    tag,
    files: typeof m.files === "number" ? m.files : null,
    generated_at: typeof m.generated_at === "string" ? m.generated_at : null,
    // An image with no identity of its own cannot be matched BY anything: two
    // unknowns are not an agreement, and reporting one as a match is how a
    // check that compares booleans gets a green answer from two blanks.
    matches_image: image.commit.status === "available" && commit !== null && commit === image.commit.value,
  };
}

// Read ONCE per process and cached. STATIC_DIR is a read-only bind established
// at container start: within the life of this process it cannot change, and a
// per-request read would put a synchronous filesystem call on /health, which
// the compose healthcheck polls every 15s.
let cached: StaticIdentityJson | undefined;

export function readStaticIdentity(staticDir: string | null, forceReread = false): StaticIdentityJson {
  if (cached && !forceReread) return cached;
  if (!staticDir) {
    cached = unavailable("STATIC_DIR is unset — this process serves no frontend");
    return cached;
  }
  let raw: string | null;
  try {
    raw = readFileSync(join(staticDir, STATIC_MANIFEST_FILENAME), "utf8");
  } catch {
    raw = null;
  }
  cached = staticIdentityFrom(raw, resolveBuildIdentity());
  return cached;
}
