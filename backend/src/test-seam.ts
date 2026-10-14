// THE TEST SEAM (issue #973). The one deliberately supported, non-runtime way a
// test process tells backend code it may use test-only paths: re-point a
// long-lived pool (db/client.ts, db/worker-client.ts setDatabase), serve the
// fixture projects source (projects/access/select.ts), write synthetic regime
// rows (swarm/domain.ts backfillRegimeHistory).
//
// Why a module and not an environment variable. `RM_ENV=ephemeral` used to be
// what opened every one of those paths, and an environment variable is ambient:
// it reaches a deployed process through a compose default, a shell export or a
// forgotten profile line, and the process cannot tell a harness from a stack.
// This flag is armed by exactly one caller, backend/tests/preload.ts, in the
// `bun test` process it bootstraps. No entrypoint, route, handler or script
// under backend/src or backend/scripts arms it (backend/tests/retired-env-guard.test.ts
// pins the caller list), so a deployed process is never armed, whatever its
// environment says. There is no disarm: a test that needs the refusal runs the
// refusing code in a subprocess that never armed.
let armed = false;

/** Arm the test seam for this process. Called by backend/tests/preload.ts only. */
export function armTestSeam(): void {
  armed = true;
}

/** Whether this process is the test harness. False in every deployed process. */
export function testSeamArmed(): boolean {
  return armed;
}

/** The refusal every seam-guarded path throws when the seam is not armed. */
export function testSeamRefusal(what: string, instead: string): Error {
  return new Error(`${what} is a test-only seam and this process is not the test harness (backend/src/test-seam.ts). ${instead}`);
}
