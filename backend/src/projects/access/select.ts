// Projects data-source selection. FAIL-SAFE TOWARD HERMETIC: the fixture
// (offline) source is the default; the live source is used ONLY when a deployer
// explicitly sets PROJECTS_SOURCE=live AND the process is not the ephemeral
// CI/test env. This guarantees the per-PR suite (RM_ENV=ephemeral) can never
// reach a live provider even if PROJECTS_SOURCE leaks into the environment —
// exactly the hermeticity invariant issue #87 requires. Resolved at call time so
// tests can flip the env per case.
import { config } from "../../config.ts";
import type { ProjectsDataSource } from "./data-source.ts";
import { fixtureProjectsDataSource } from "./fixture-source.ts";
import { liveProjectsDataSource } from "./live-source.ts";

export function selectProjectsDataSource(
  env: Record<string, string | undefined> = process.env,
): ProjectsDataSource {
  const wantsLive = env.PROJECTS_SOURCE === "live";
  // The ephemeral CI/test env is ALWAYS hermetic — never live, even if
  // PROJECTS_SOURCE leaks in — so the per-PR suite can never touch a provider.
  if (config.env === "ephemeral") return fixtureProjectsDataSource;
  if (wantsLive) return liveProjectsDataSource;
  // Fail-closed: prod must opt into live explicitly. Refuse to serve the vendored
  // fixture dataset as production data (the "nothing fabricated on the prod path"
  // invariant); smoke may use the fixture directory freely.
  if (config.env === "prod") {
    throw new Error(
      "projects pipelines require PROJECTS_SOURCE=live in prod — refusing to serve fixture data as production",
    );
  }
  return fixtureProjectsDataSource;
}
