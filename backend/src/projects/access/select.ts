// Projects data-source selection. The fixture (offline) source exists ONLY for
// the test harness; every deployed process must opt into the live source.
//
// - PROJECTS_SOURCE=live: the live source.
// - Anything else: a refusal. Issue #1208: production v0.5.4 ran without
//   PROJECTS_SOURCE=live, so the old selector served the fixture dataset under
//   its "non-prod" env and the projects worker persisted 4 fabricated projects
//   with their wallets and vaults (real brand names beside invented balances).
//   No deployed process may select the fixture again. Rows already persisted
//   are removed by migration 0118 (D66: production data changes only by
//   migration).
// - The fixture is reachable only through `injectProjectsDataSource`, which
//   refuses unless the test seam is armed (backend/src/test-seam.ts; issue
//   #973). backend/tests/preload.ts injects it for the per-PR suite, so the
//   suite can never reach a live provider (the hermeticity invariant of issue
//   #87) and no environment value, `PROJECTS_SOURCE=live` included, overrides
//   an injected source.
//
// Resolved at call time so tests can flip the env per case.
import { testSeamArmed, testSeamRefusal } from "../../test-seam.ts";
import type { ProjectsDataSource } from "./data-source.ts";
import { liveProjectsDataSource } from "./live-source.ts";

let injected: ProjectsDataSource | null = null;

/** Test seam: make every selector call return `source`. Refuses unless the test seam is armed. */
export function injectProjectsDataSource(source: ProjectsDataSource | null): void {
  if (!testSeamArmed()) {
    throw testSeamRefusal("projects/access/select.injectProjectsDataSource()", "A deployed process selects its source with PROJECTS_SOURCE=live only.");
  }
  injected = source;
}

export function selectProjectsDataSource(
  env: Record<string, string | undefined> = process.env,
): ProjectsDataSource {
  if (injected !== null) return injected;
  if (env.PROJECTS_SOURCE === "live") return liveProjectsDataSource;
  throw new Error(
    "projects pipelines require PROJECTS_SOURCE=live — refusing to serve fixture data as production",
  );
}
