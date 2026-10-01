// The web client's identity, read from frontend/package.json — the client's
// own manifest, versioned apart from the api/backend (backend/package.json)
// and the contract (contract/package.json). `bun scripts/web-client/version.ts`
// prints it as JSON; scripts/static-assembly.sh writes that into the
// assembled site as /version.json and scripts/preview-server.ts serves the
// same shape from the working tree.
//
// `apiRange` (D54) is the semver range of API versions this client accepts —
// the API's version being contract/package.json's, reported at GET
// /api/version. The page reads it back from /version.json at load and shows a
// reload notice instead of calling an API outside it; `bun smoke:web` and
// `bun smoke` read it from the live site's /version.json before switching
// either side. A manifest without one publishes `apiRange: null`, which every
// consumer treats as admitting no API — never as admitting all of them.
import { join } from "node:path";

export const repoRoot = join(import.meta.dir, "..", "..");

export interface WebClientVersion {
  name: string;
  version: string;
  commit: string;
  apiRange: string | null;
}

export async function webClientVersion(root: string = repoRoot): Promise<WebClientVersion> {
  const pkg = (await Bun.file(join(root, "frontend/package.json")).json()) as { name: string; version: string; apiRange?: unknown };
  const git = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { cwd: root, stdout: "pipe", stderr: "ignore" });
  const commit = git.exitCode === 0 ? git.stdout.toString().trim() : "unknown";
  const apiRange = typeof pkg.apiRange === "string" && pkg.apiRange.trim() !== "" ? pkg.apiRange : null;
  return { name: pkg.name, version: pkg.version, commit, apiRange };
}

if (import.meta.main) {
  console.log(JSON.stringify(await webClientVersion()));
}
