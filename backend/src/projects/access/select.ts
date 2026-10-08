// Projects data-source selection. The fixture (offline) source exists ONLY for
// the ephemeral CI/test env; every deployed env must opt into the live source.
//
// - RM_ENV=ephemeral: ALWAYS the fixture, even if PROJECTS_SOURCE=live leaks into
//   the environment, so the per-PR suite can never reach a live provider (the
//   hermeticity invariant of issue #87).
// - RM_ENV=smoke|stage|prod: the live source when PROJECTS_SOURCE=live, otherwise
//   a refusal. Issue #1208: production v0.5.4 ran RM_ENV=smoke without
//   PROJECTS_SOURCE=live, so this selector served the fixture dataset and the
//   projects worker persisted 4 fabricated projects with their wallets and vaults
//   (real brand names beside invented balances). No deployed process may select
//   the fixture again. The refusal is the error prod has always thrown, naming
//   the env it ran in. Existing fixture rows are left in place (owner decision
//   2026-10-08: guard only, no purge in v0.6.0).
//
// Resolved at call time so tests can flip the env per case.
import { config } from "../../config.ts";
import type { ProjectsDataSource } from "./data-source.ts";
import { fixtureProjectsDataSource } from "./fixture-source.ts";
import { liveProjectsDataSource } from "./live-source.ts";

export function selectProjectsDataSource(
  env: Record<string, string | undefined> = process.env,
): ProjectsDataSource {
  if (config.env === "ephemeral") return fixtureProjectsDataSource;
  if (env.PROJECTS_SOURCE === "live") return liveProjectsDataSource;
  throw new Error(
    `projects pipelines require PROJECTS_SOURCE=live in ${config.env} — refusing to serve fixture data as production`,
  );
}
