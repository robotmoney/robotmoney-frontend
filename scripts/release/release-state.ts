// scripts/release/release-state.ts — where a release run keeps its files in
// the instance's smoke state directory (scripts/lib/smoke-state.ts).
import { join } from "node:path";
import { instancePaths, stateRoot } from "../lib/smoke-state.ts";

/** `<state root>/<instance>/release/<run>`, the release run's files in the instance state directory. */
export function releaseStateDir(instance: string, run: string, env: Record<string, string | undefined> = process.env): string {
  return join(instancePaths(stateRoot(env), instance).dir, "release", run);
}
