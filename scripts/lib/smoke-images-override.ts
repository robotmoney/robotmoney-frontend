// AC-ID-05 — the smoke's side of "run shipped images, build nothing here".
//
// Extracted rather than written inline in scripts/lib/smoke-main.ts for the
// reason scripts/tests/unit/smoke-main-split.test.ts enforces with a budget:
// that file is the one this repo keeps deliberately thin, and a decision with a
// rationale this long belongs where it can be graded without a boot.
//
// WHAT THIS DECIDES. Where the boot's images come from — the flag, then
// `RM_IMAGES_OVERRIDE`, then nowhere (build locally, the normal case on a
// developer machine and in CI). The flag wins over the environment because it
// is the more specific statement. On `rm-frontend-stage-1` the environment is
// what says it, once, written by the ship step; nothing else about that host's
// configuration is allowed to reach a container, but this is not configuration
// of a container — it is the machine-wide fact that this host does not compile.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { IMAGES_OVERRIDE_ENV, IMAGES_OVERRIDE_FLAG, resolveImagesOverride } from "../stack/images.ts";

export interface ImagesOverrideDecision {
  /** Absolute path, or undefined when this boot builds its own images. */
  path?: string;
  /** What to print before anything starts. Never empty when `path` is set. */
  banner: string[];
}

/**
 * PURE apart from the existence check, which is injected so the decision can be
 * graded without a filesystem. A path that does not exist is FATAL rather than
 * a fallback to building: an operator who asked for shipped images and silently
 * got locally-built ones is the exact failure AC-ID-05 records.
 */
export function decideImagesOverride(
  argv: readonly string[],
  env: Record<string, string | undefined>,
  exists: (p: string) => boolean = existsSync,
): ImagesOverrideDecision {
  const raw = resolveImagesOverride(argv, env[IMAGES_OVERRIDE_ENV]);
  if (!raw) return { banner: [] };
  const path = resolve(raw);
  if (!exists(path)) {
    throw new Error(
      `${IMAGES_OVERRIDE_FLAG} ${path} does not exist, and this boot will NOT fall back to building its own ` +
        `images (AC-ID-05). Build and ship them from pinza first: ` +
        `bun scripts/stack/ship-images.ts --tag <rc tag> --host <this host>`,
    );
  }
  return {
    path,
    banner: [
      `IMAGES OVERRIDE: ${path}`,
      `  this boot BUILDS NOTHING on this host — every image was built on pinza at the RC tag and shipped`,
      `  here with \`docker save | ssh docker load\` (AC-ID-05). A missing image stops the boot by name;`,
      `  it is never rebuilt locally.`,
    ],
  };
}
