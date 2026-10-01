// GET /api/version — WHICH API THIS PROCESS SPEAKS (D54, issue #1026 W7).
//
// The static website is its own release unit: it is built and switched on its
// own schedule, and it declares the API versions it accepts as a semver range
// (frontend/package.json `apiRange`, published in its /version.json). This is
// the other half of that handshake: the running API names its version so the
// site can check it at load, and so `bun smoke:web` can refuse to switch in a
// site whose range excludes the API that is already serving.
//
// `api` IS THE CONTRACT VERSION, not backend/package.json's. What a site
// depends on is the route table and DTO shapes in contract/, so the number
// that must move when they move is contract/package.json's — and CI enforces
// exactly that: scripts/check-contract-version-bump.ts fails a change to
// contract/src/routes.js that does not bump it against the merge base.
//
// `commit` is the image's baked build commit (build-identity.ts, RM_BUILD_COMMIT)
// or null when the image was built without one. Null, never a substitute: the
// same explicit-or-unavailable rule /version follows.
//
// NO DATABASE, NO AUTH, NO CONFIG. This module imports nothing that opens a
// connection or reads config.ts, so the answer is a constant for the life of the
// process and survives a Postgres outage. The site's compatibility check must
// not turn a database outage into a "reload the page" notice — that is the
// api-unreachable path's job. backend/tests/api-version-endpoint.test.ts pins
// the import graph as well as the behaviour.
import contractPackage from "@robotmoney/contract/package.json" with { type: "json" };
import { resolveBuildIdentity } from "./build-identity.ts";

export interface ApiVersionBody {
  /** contract/package.json's version: the API contract this process serves. */
  api: string;
  /** The full commit SHA the image was built from, or null when unbaked. */
  commit: string | null;
}

/** The contract version this process was built against. */
export const API_CONTRACT_VERSION: string = contractPackage.version;

export function apiVersionBody(env: Record<string, string | undefined> = process.env): ApiVersionBody {
  return { api: API_CONTRACT_VERSION, commit: resolveBuildIdentity(env).commit.value };
}

/** The whole route answer. Exported so the test can grade the Response itself. */
export function apiVersionResponse(env: Record<string, string | undefined> = process.env): Response {
  return new Response(JSON.stringify(apiVersionBody(env)), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
