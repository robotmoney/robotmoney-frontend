// `bun run demo` entrypoint. The orchestration itself lives in
// scripts/lib/demo-main.ts; this thin entry exists so the demo's data-path env
// resolver (scripts/lib/demo-env.ts, issue #50) is importable from tests
// (scripts/tests/unit/demo-env.test.ts) WITHOUT triggering the side-effectful demo
// bring-up — demo-main allocates ports, opens log files, and drives docker
// compose at module load, so it is only imported when this file is executed
// directly.
export { resolveDemoEnv, type DemoEnvResolution } from "./lib/demo-env.ts";
// Same reason: the --external-pg resolver (scripts/lib/demo-external-pg.ts) is
// importable by scripts/tests/unit/demo-external-pg.test.ts without dragging in
// demo-main's side-effectful bring-up.
export {
  externalPgOverlayYaml,
  parseEnvFile,
  redactPostgresUrl,
  resolveExternalPg,
  urlFromDiscreteKeys,
  type ExternalPgResolution,
} from "./lib/demo-external-pg.ts";
// Same reason again: the `--db` data-path resolver and the argv allowlist
// (scripts/lib/demo-db-mode.ts) are what demo-main consumes, so
// scripts/tests/unit/demo-db-mode.test.ts reaches them through this entrypoint
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
} from "./lib/demo-db-mode.ts";

if (import.meta.main) {
  await import("./lib/demo-main.ts");
}
