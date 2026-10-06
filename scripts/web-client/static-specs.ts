// Which browser specs run in web-client.yml against the assembled static site
// (scripts/web-client/static-site-server.ts), with no api and no Docker.
//
// The rule is "every spec, except the ones named here": a new spec joins the
// web-client gate by default, and one that needs a real api fails there until
// its author stubs the call or lists it below. Each excluded spec states why.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "./version.ts";

export const SPEC_DIR = join(repoRoot, "frontend", "test", "browser");

export const NOT_STATIC: Record<string, string> = {
  "admin-live": "drives the live admin backend; refuses to run without it",
  "analytics-views": "reads live analytics routes at BACKEND_URL",
  "hero-width": "loads pages whose unmocked /api calls must answer, not 404",
  spa: "reads /api/dashboards/vault-economics and other live routes unmocked",
  "swarm-receipts": "verifies a receipt through the real api",
  // These start their own preview-server.ts and ignore BACKEND_URL; the
  // fixtures step in web-client.yml already runs them.
  "preview-smoke": "starts its own preview server",
  "preview-routes": "starts its own preview server",
  "api-unreachable": "starts its own preview server",
  "api-range-mismatch": "starts its own preview server",
};

export function allSpecs(dir: string = SPEC_DIR): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".spec.ts"))
    .map((f) => f.slice(0, -".spec.ts".length))
    .sort();
}

export function staticSpecs(dir: string = SPEC_DIR): string[] {
  return allSpecs(dir).filter((s) => !(s in NOT_STATIC));
}
