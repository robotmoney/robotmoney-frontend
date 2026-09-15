// Issue #977: the build identity a run/vintage is bound to. A real,
// deterministic-per-process value — never fabricated — so a frozen manifest's
// fingerprint can later prove WHICH build computed it. Preference order:
//
//   1. An explicit operator/CI-supplied identity (RM_BUILD_IDENTITY, or the
//      GIT_SHA / GITHUB_SHA a deploy pipeline already exports) — the most
//      precise answer, and the one production should always have set.
//   2. package.json's version + the Bun/Node runtime version, when none of
//      the above is set (local/dev runs, most test runs) — still real,
//      still reproducible from the running process, never a placeholder.
import { readFileSync } from "node:fs";
import { join } from "node:path";

let cachedPackageVersion: string | null = null;

function packageVersion(): string {
  if (cachedPackageVersion !== null) return cachedPackageVersion;
  try {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "package.json"), "utf8")) as { version?: string };
    cachedPackageVersion = typeof pkg.version === "string" && pkg.version ? pkg.version : "0.0.0";
  } catch {
    cachedPackageVersion = "0.0.0";
  }
  return cachedPackageVersion;
}

export function resolveBuildIdentity(env: Record<string, string | undefined> = process.env): string {
  const explicit = env.RM_BUILD_IDENTITY || env.GIT_SHA || env.GITHUB_SHA;
  if (explicit) return explicit.slice(0, 256);
  const runtime = typeof Bun !== "undefined" ? `bun:${Bun.version}` : `node:${process.version}`;
  return `pkg:${packageVersion()}+${runtime}`;
}
