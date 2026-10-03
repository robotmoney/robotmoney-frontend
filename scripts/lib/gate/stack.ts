// Which stack a gate grades: the deployment instance's own stack record.
//
// Spec §1.1: every run acts on one named instance, and what `bun smoke` brought
// up for it is recorded in the instance's `stack-state.json`
// (scripts/lib/smoke-state.ts). A gate selects by `--instance` (or the only
// instance with state on the host) and takes the compose project from that
// record. It never reads `.agents/smoke-state.json`, `SMOKE_PROJECT` or a
// `--db` flag, and it never composes a container name by hand.

import { instanceFlag, readStackState, selectExistingInstance, stateRoot, type InstancePaths, type StackStateRecord } from "../smoke-state.ts";
import { serviceContainer } from "./io.ts";

export interface GateStack {
  instance: string;
  project: string;
  paths: InstancePaths;
  record: StackStateRecord;
  /** The api container: the gate's one door to the database. */
  api: string;
}

export interface ResolveDeps {
  /** Finds a compose service's container; injected so a test needs no Docker. */
  serviceContainer?: (project: string, service: string) => string | null;
}

/**
 * Resolve the stack a gate acts on.
 *
 * Inputs: the gate's argv (for `--instance`), the environment (for the state
 * root) and the database modes the gate accepts. Output: the stack.
 *
 * Refusals (each throws, naming the fix): an unknown or ambiguous instance; an
 * instance that never brought a stack up; a stack of a database mode the gate
 * does not grade (a twin gate on a production stack, or the reverse); a project
 * with no api container.
 */
export function resolveGateStack(
  argv: readonly string[],
  env: Record<string, string | undefined>,
  accepts: readonly string[],
  deps: ResolveDeps = {},
): GateStack {
  const paths = selectExistingInstance(stateRoot(env), instanceFlag(argv));
  const record = readStackState(paths);
  if (record === null) throw new Error(`Refusing: instance ${paths.dir} has no stack record, so there is no stack to grade. Boot it with \`bun smoke\` first.`);
  if (!accepts.includes(record.db)) {
    throw new Error(`Refusing: this instance's stack is db=${record.db}; this gate grades ${accepts.map((a) => `db=${a}`).join(" or ")}.`);
  }
  const api = (deps.serviceContainer ?? serviceContainer)(record.project, "api");
  if (!api) throw new Error(`Refusing: compose project ${record.project} has no api container.`);
  return { instance: record.instance ?? paths.dir, project: record.project, paths, record, api };
}
