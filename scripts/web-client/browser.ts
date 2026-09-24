// Run the web client's browser checks against the preview server — no live
// backend, no Docker. `bun run --cwd frontend check` (fixtures) or
// `... check:prod` / `... check:stage` (the same route sweep, with /api/*
// answered by a live api instead of goldens).
//
//   --api fixtures            goldens answer /api/* (the default; the gate)
//   --api prod|stage|<origin> a live api answers /api/* (advisory; the page
//                             must still load with no console errors, but a
//                             live host being down is not a client defect)
//
// Playwright resolves playwright.config.ts from the repo root and the specs
// spawn scripts/preview-server.ts relative to process.cwd(), so this always
// runs from the repo root whatever directory it is invoked from.
import { repoRoot } from "./version.ts";

const FIXTURE_SPECS = ["preview-smoke", "api-unreachable", "api-range-mismatch", "preview-routes"];
const LIVE_SPECS = ["preview-routes"];

const args = process.argv.slice(2);
const apiIdx = args.indexOf("--api");
const api = apiIdx === -1 ? "fixtures" : args[apiIdx + 1];
if (!api) {
  console.error("--api needs a value: fixtures | prod | stage | <origin>");
  process.exit(2);
}
const passthrough = apiIdx === -1 ? args : [...args.slice(0, apiIdx), ...args.slice(apiIdx + 2)];

const specs = api === "fixtures" ? FIXTURE_SPECS : LIVE_SPECS;
const env = { ...process.env, ...(api === "fixtures" ? {} : { PREVIEW_API: api }) };

console.log(`web-client browser check: api=${api} specs=${specs.join(",")}`);
const proc = Bun.spawn(["bunx", "playwright", "test", ...specs, ...passthrough], {
  cwd: repoRoot,
  env,
  stdio: ["inherit", "inherit", "inherit"],
});
process.exit(await proc.exited);
