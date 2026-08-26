// `bun run smoke` entrypoint. The orchestration itself lives in
// scripts/lib/smoke-main.ts; this thin entry exists so the smoke's data-path env
// resolver (scripts/lib/smoke-env.ts, issue #50) is importable from tests
// (scripts/tests/unit/smoke-env.test.ts) WITHOUT triggering the side-effectful smoke
// bring-up — smoke-main allocates ports, opens log files, and drives docker
// compose at module load, so it is only imported when this file is executed
// directly.
export { resolveSmokeEnv, type SmokeEnvResolution } from "./lib/smoke-env.ts";
// Same reason: the --external-pg resolver (scripts/lib/smoke-external-pg.ts) is
// importable by  without dragging in
// smoke-main's side-effectful bring-up.
export {
  externalPgOverlayYaml,
  parseEnvFile,
  redactPostgresUrl,
  resolveExternalPg,
  urlFromDiscreteKeys,
  type ExternalPgResolution,
} from "./lib/smoke-external-pg.ts";
// Same reason again: the `--db` data-path resolver and the argv allowlist
// (scripts/lib/smoke-db-mode.ts) are what smoke-main consumes, so
// scripts/tests/unit/smoke-db-mode.test.ts reaches them through this entrypoint
// rather than the lib — which proves the tested module is the one that boots.
export {
  bannerFor,
  BACKUP_DIR_FLAG,
  DB_FLAG,
  DB_MODES,
  DEMO_FLAGS,
  dataPathOverlayYaml,
  isPrePopulated,
  keptDataDescription,
  ownsData,
  parseDataPath,
  usesComposePostgres,
  validateArgv,
  type DataPathRequest,
  type DbMode,
  type ParsedDataPath,
  type ResolvedDataPath,
} from "./lib/smoke-db-mode.ts";

if (import.meta.main) {
  await import("./lib/smoke-main.ts");
}
