// `bun run demo` entrypoint. The orchestration itself lives in
// scripts/lib/demo-main.ts; this thin entry exists so the demo's data-path env
// resolver (scripts/lib/demo-env.ts, issue #50) is importable from tests
// (scripts/tests/demo-env.test.ts) WITHOUT triggering the side-effectful demo
// bring-up — demo-main allocates ports, opens log files, and drives docker
// compose at module load, so it is only imported when this file is executed
// directly.
export { resolveDemoEnv, HERMETIC_STUB_RPC_URL, type DemoEnvResolution } from "./lib/demo-env.ts";

if (import.meta.main) {
  await import("./lib/demo-main.ts");
}
