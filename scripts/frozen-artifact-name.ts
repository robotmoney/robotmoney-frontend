// Single source of truth for the frozen bundle's downloadable-artifact name
// (issue #24). Both the publish workflow and its unit test call this, so the
// artifact label provably carries the bake timestamp read from the manifest.
//
//   bun run scripts/frozen-artifact-name.ts [path/to/frozen-manifest.json]
//     → prints the artifact name, e.g. frozen-index-html-2026-07-01T18-05-09-546Z
//
// GitHub Actions artifact names may not contain any of  " : < > | * ? / \  or
// CR/LF, so the ISO-8601 `bakedAt` (which has `:` and `.`) is sanitized to a
// filesystem-safe token while remaining an unambiguous, sortable stamp.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PREFIX = "frozen-index-html";

/** Replace GitHub-artifact-illegal characters in a timestamp with `-`. */
export function sanitizeStamp(bakedAt: string): string {
  return bakedAt.replace(/[":<>|*?/\\.\s]/g, "-");
}

/** Artifact name embedding the (sanitized) bake timestamp. */
export function frozenArtifactName(bakedAt: string): string {
  const stamp = sanitizeStamp(bakedAt);
  if (!stamp) throw new Error("frozenArtifactName: empty bakedAt");
  return `${PREFIX}-${stamp}`;
}

/** Read `bakedAt` from a frozen-manifest.json and build the artifact name. */
export function frozenArtifactNameFromManifest(manifestPath: string): string {
  const raw = readFileSync(manifestPath, "utf8");
  const parsed = JSON.parse(raw) as { bakedAt?: unknown };
  if (typeof parsed.bakedAt !== "string" || parsed.bakedAt.length === 0) {
    throw new Error(`frozenArtifactNameFromManifest: no string bakedAt in ${manifestPath}`);
  }
  return frozenArtifactName(parsed.bakedAt);
}

function main(): void {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(scriptDir, "..");
  const manifestPath = process.argv[2] ?? join(repoRoot, "dist", "frozen", "frozen-manifest.json");
  process.stdout.write(frozenArtifactNameFromManifest(manifestPath) + "\n");
}

if (import.meta.main) main();
