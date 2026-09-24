// The analytics-producer's bearer, as a file in the instance's state directory.
//
// Spec §3: each service token is "a file the boot places in the instance's
// state directory, named per instance and per holder, never in `~/.env` and
// never in an image". It used to be a mkdtemp directory under os.tmpdir(): out
// of the checkout, but also out of the instance, so nothing tied it to the
// deployment it served, a second instance could not find its own, and a reboot
// of the host (tmpfs) silently lost the credential a running stack mounts.
//
// The file is `tokens/analytics-producer/token` (smoke-state.ts
// `InstancePaths.tokenFiles`), mode 0600, inside a 0700 directory. compose
// hands it to api, worker-analytics and analytics-producer as the
// `analytics_token` Docker secret.
import { chmodSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { InstancePaths } from "./smoke-state.ts";

/** Write the analytics bearer into the instance's analytics-producer token file. */
export function provisionSmokeAnalyticsToken(paths: InstancePaths, token: string): string {
  const file = paths.tokenFiles["analytics-producer"];
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}

/**
 * Remove the instance's analytics token file, and only that exact file.
 * Returns false rather than deleting when a stale or tampered state record
 * points anywhere else.
 */
export function removeSmokeAnalyticsToken(file: string, paths: InstancePaths): boolean {
  if (resolve(file) !== resolve(paths.tokenFiles["analytics-producer"])) return false;
  rmSync(file, { force: true });
  return true;
}
