// The hardcoded swarm public origin is PRODUCTION CONFIGURATION, and nothing
// used to pin it.
//
// `SWARM_PUBLIC_BASE_URL` is inert: it is named by no compose file (not
// docker-compose.yml's api `environment:` allowlist, not
// docker-compose.demo.yml's, not the x-worker-env anchor), there is no
// `env_file:` anywhere and backend/Dockerfile sets no ENV, and it is absent
// from scripts/lib/demo-main.ts's DEMO_COMPOSE_PASSTHROUGH. So the fallback in
// resolveSwarmPublicBaseUrl IS the value every real deployment computes, and
// every swarm notification email links to it — the applicant claim link at
// src/swarm/notifications.ts:26 most of all, which is the ONLY durable copy of
// a status page reachable by nothing but its opaque member id.
//
// The existing email tests (swarm-waitlist.test.ts, swarm-claim.test.ts) assert
// against `config.swarmPublicBaseUrl` — the VARIABLE — so they stay green no
// matter which host that variable holds. They prove the link is built from the
// configured origin; they prove nothing about the origin being the live one.
// That gap let the default sit at the retired `robotmoney.net` after #603
// moved the site to `robotmoney.network`. This file is the missing pin: it
// fails if the default regresses to any non-canonical host.
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SWARM_PUBLIC_BASE_URL_DEFAULT, resolveSwarmPublicBaseUrl } from "../src/config.ts";

/** The one canonical public origin. Written out literally, NOT imported from
 *  the module under test — a test that reads its expectation out of the
 *  subject can only ever agree with it. */
const CANONICAL_ORIGIN = "https://robotmoney.network";

/** Hosts that are retired or were never live. Any of these appearing as the
 *  default is the exact defect this file exists to catch. */
const NON_CANONICAL_HOSTS = [
  "https://robotmoney.net",
  "https://www.robotmoney.net",
  "https://swarm.robotmoney.net",
  "https://swarm.staging.robotmoney.net",
  "http://localhost:8787",
];

test("the exported default IS the canonical public origin", () => {
  expect(SWARM_PUBLIC_BASE_URL_DEFAULT).toBe(CANONICAL_ORIGIN);
});

test("an UNSET SWARM_PUBLIC_BASE_URL resolves to the canonical origin — the value every container actually computes", () => {
  expect(resolveSwarmPublicBaseUrl({})).toBe(CANONICAL_ORIGIN);
  expect(resolveSwarmPublicBaseUrl({ SWARM_PUBLIC_BASE_URL: "" })).toBe(CANONICAL_ORIGIN);
});

for (const host of NON_CANONICAL_HOSTS) {
  test(`the default is not the retired/never-live host ${host}`, () => {
    expect(resolveSwarmPublicBaseUrl({})).not.toBe(host);
  });
}

test("the default names no .net origin at all", () => {
  expect(resolveSwarmPublicBaseUrl({})).not.toMatch(/robotmoney\.net\b/i);
});

test("the applicant claim link built on the default points at the live site", () => {
  // Same construction as src/swarm/notifications.ts:26 — the artifact the
  // applicant actually receives, not just the origin string in isolation.
  const memberId = "abc-123";
  const claimUrl = `${resolveSwarmPublicBaseUrl({})}/swarm/apply/${encodeURIComponent(memberId)}`;
  expect(claimUrl).toBe("https://robotmoney.network/swarm/apply/abc-123");
});

test("the frontend's canonical origin and this default cannot drift apart", () => {
  // frontend/public/assets/js/app/seo.js is the browser-side owner of the same
  // origin (it stamps canonical/og:url). Two independent hardcodes of one fact
  // is how the .net/.network split survived; assert they agree.
  const seo = readFileSync(
    join(import.meta.dir, "../../frontend/public/assets/js/app/seo.js"),
    "utf8",
  );
  const m = seo.match(/const ORIGIN = "([^"]+)"/);
  expect(m, "seo.js no longer declares `const ORIGIN = \"...\"` — update this test").not.toBeNull();
  expect(m![1]).toBe(SWARM_PUBLIC_BASE_URL_DEFAULT);
});

test("an explicitly set SWARM_PUBLIC_BASE_URL still wins, with trailing slashes stripped", () => {
  // Pinning the default must not quietly disable the override for the one
  // topology that could deliver it (a plain `docker compose` deploy that adds
  // the name to the api `environment:` block).
  expect(resolveSwarmPublicBaseUrl({ SWARM_PUBLIC_BASE_URL: "https://staging.example/" })).toBe(
    "https://staging.example",
  );
  expect(resolveSwarmPublicBaseUrl({ SWARM_PUBLIC_BASE_URL: "https://staging.example///" })).toBe(
    "https://staging.example",
  );
});
