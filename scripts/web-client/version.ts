// The web client's identity, read from frontend/package.json — the client's
// own manifest, versioned apart from the api/backend (backend/package.json)
// and the contract (contract/package.json). `bun scripts/web-client/version.ts`
// prints it as JSON; scripts/static-assembly.sh writes that into the
// assembled site as /version.json and scripts/preview-server.ts serves the
// same shape from the working tree.
import { join } from "node:path";

export const repoRoot = join(import.meta.dir, "..", "..");

export interface WebClientVersion {
  name: string;
  version: string;
  commit: string;
}

export async function webClientVersion(): Promise<WebClientVersion> {
  const pkg = (await Bun.file(join(repoRoot, "frontend/package.json")).json()) as { name: string; version: string };
  const git = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { cwd: repoRoot, stdout: "pipe", stderr: "ignore" });
  const commit = git.exitCode === 0 ? git.stdout.toString().trim() : "unknown";
  return { name: pkg.name, version: pkg.version, commit };
}

if (import.meta.main) {
  console.log(JSON.stringify(await webClientVersion()));
}
