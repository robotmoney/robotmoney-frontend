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
// Same reason again: the `--local` data-path resolver and the argv allowlist
// (scripts/lib/smoke-db-mode.ts) are what smoke-main consumes, so
// scripts/tests/unit/smoke-db-mode.test.ts reaches them through this entrypoint
// rather than the lib, which proves the tested module is the one that boots.
export {
  bannerFor,
  LOCK_TIMEOUT_DEFAULT_SECONDS,
  LOCK_TIMEOUT_FLAG,
  lockTimeoutMs,
  cadenceOverride,
  DEMO_FLAGS,
  dataPathOverlayYaml,
  isPrePopulated,
  keptDataDescription,
  LOCAL_FLAG,
  LOCAL_MODES,
  localModeOf,
  MIGRATE_FLAG,
  ownsData,
  parseDataPath,
  parseLocalMode,
  parseVolumeHolders,
  reattachOverlayYaml,
  refuseRetiredEnv,
  refuseVolumeInUse,
  requestsDump,
  requestsMigrate,
  requestsSeed,
  RETIRED_ENV,
  RETIRED_FLAGS,
  SEED_FLAG,
  shouldSeed,
  targetConnection,
  usesComposePostgres,
  validateArgv,
  type DataPathRequest,
  type DbMode,
  type LocalMode,
  type ParsedDataPath,
  type ResolvedDataPath,
} from "./lib/smoke-db-mode.ts";

/**
 * The boot refuses to run on an environment bun filled from the checkout.
 *
 * Bun auto-loads `<cwd>/.env` into process.env before any line here runs, so a
 * checkout's `.env` (the deployment's own, on a shared host) silently became
 * the driver's input: its DATABASE_URL, its tokens, its SMOKE_PROJECT. No boot
 * reads an env file from the checkout (criterion 122): `bun smoke` passes
 * `--no-env-file` (package.json), and a hand-typed `bun scripts/smoke.ts` that
 * did not is refused rather than trusted, because by now it cannot tell which
 * values came from the file.
 */
export function refuseCheckoutEnvFile(
  execArgv: readonly string[],
  entry: { script: string; file: string } = { script: "smoke", file: "scripts/smoke.ts" },
): string | null {
  if (execArgv.includes("--no-env-file")) return null;
  const run = entry.script === "smoke" ? "bun smoke" : `bun run ${entry.script}`;
  return (
    `bun auto-loaded this checkout's .env into the boot's environment. Run \`${run} …\` ` +
    `(it passes --no-env-file), or \`bun --no-env-file ${entry.file} …\`.`
  );
}

if (import.meta.main) {
  const envFileRefusal = refuseCheckoutEnvFile(process.execArgv);
  if (envFileRefusal) {
    console.error(`[smoke] FATAL: ${envFileRefusal}`);
    process.exit(1);
  }
  await import("./lib/smoke-main.ts");
}
