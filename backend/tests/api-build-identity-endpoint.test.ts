// AC-ID-03 — "STAGING RUNS EXACTLY THE PINNED CANDIDATES", made checkable from
// outside the host.
//
// The 2026-09-13 evaluation recorded the gap in one line: "frontend stage runs
// untagged f7f08cf7 with RM_ENV=smoke; /health exposes no SHA or tag". There
// was no way to ask a RUNNING PROCESS what source it came from — only to ssh in
// and run `git rev-parse` in a checkout beside it, which answers a question
// about the checkout and moves independently of the image.
//
// TWO LAYERS, BOTH GRADED HERE:
//   1. the pure resolver (no fallbacks, honest `unavailable`), and
//   2. the REAL entrypoint — `bun run src/api/index.ts`, the exact command
//      docker-compose.yml's api service runs — spawned as a process and asked
//      over HTTP, because a handler function returning the right object proves
//      nothing about whether the route is reachable.
//
// WHAT THIS FILE CANNOT PROVE, stated for the same reason its neighbour
// api-boot-handle-namespace-guard.test.ts states it: Bun.spawn sets the
// environment directly, so this grades the CODE's handling of RM_BUILD_* and
// says nothing about whether `docker build` bakes them. That half is asserted
// against real `docker compose config` and the Dockerfile text in
// scripts/tests/integration/smoke-compose-config.test.ts.
import { afterAll, expect, test } from "bun:test";
import { bootApi as bootStackApi, type ApiProcess } from "./support/automation-auth.ts";
import { useCleanDatabase } from "./support/clean-db.ts";
import {
  BUILD_COMMIT_ENV,
  BUILD_TAG_ENV,
  buildIdentityJson,
  resolveBuildIdentity,
} from "../src/ops/build-identity.ts";

const COMMIT = "ebc588b4542de4d5a61aecdba0a967af35afcd6b";
const TAG = "v0.5.0-rc.2";

// ── The resolver: explicit, or honestly unavailable ─────────────────────────
test("an explicitly supplied commit and tag are reported verbatim", () => {
  const identity = resolveBuildIdentity({ [BUILD_COMMIT_ENV]: `  ${COMMIT}  `, [BUILD_TAG_ENV]: TAG });
  expect(identity.commit).toEqual({ status: "available", value: COMMIT, unavailableReason: null });
  expect(identity.tag).toEqual({ status: "available", value: TAG, unavailableReason: null });
  expect(buildIdentityJson(identity)).toEqual({ commit: COMMIT, tag: TAG });
});

test("an absent or blank value is UNAVAILABLE with the reason named — never substituted", () => {
  for (const env of [{}, { [BUILD_COMMIT_ENV]: "", [BUILD_TAG_ENV]: "   " }]) {
    const json = buildIdentityJson(resolveBuildIdentity(env));
    expect(json.commit).toBeNull();
    expect(json.tag).toBeNull();
    expect(json.commit_unavailable).toBe(`${BUILD_COMMIT_ENV} is unset or blank`);
    expect(json.tag_unavailable).toBe(`${BUILD_TAG_ENV} is unset or blank`);
  }
});

test("a commit with no tag reports the commit and an absent tag, not a near-miss", () => {
  // `git describe --tags` without `--exact-match` would answer
  // `v0.5.0-rc.1-3-gabc1234` here — a string that reads like a tag and is not
  // one. The resolver has no way to produce that, and this pins the shape a
  // caller actually sees for an untagged build.
  const json = buildIdentityJson(resolveBuildIdentity({ [BUILD_COMMIT_ENV]: COMMIT }));
  expect(json).toEqual({ commit: COMMIT, tag: null, tag_unavailable: `${BUILD_TAG_ENV} is unset or blank` });
});

// ── The real process, over HTTP ─────────────────────────────────────────────
// Booted as a stack boots it (tests/support/automation-auth.ts bootApi): as
// rm_app, on this file's own database, through the real startup preflight.
// There is no harness exception in the entrypoint (issue #973).
useCleanDatabase(import.meta.file);

const spawned: ApiProcess[] = [];
afterAll(() => { for (const p of spawned) p.stop(); });

async function bootApi(extraEnv: Record<string, string>): Promise<number> {
  const api = await bootStackApi({ env: extraEnv });
  spawned.push(api);
  return Number(new URL(api.base).port);
}

test("GET /version reports the identity baked into the running process", async () => {
  const port = await bootApi({ [BUILD_COMMIT_ENV]: COMMIT, [BUILD_TAG_ENV]: TAG });

  const version = await fetch(`http://127.0.0.1:${port}/version`);
  expect(version.status).toBe(200);
  // FLAT AND EXACT: the acceptance check is a string comparison against the RC
  // tag and SHA of AC-ID-01, run with curl, so the body must not require
  // parsing to reach either value.
  const versionBody = await version.json();
  // `commit` and `tag` stay TOP-LEVEL and exact — the acceptance check greps
  // them. D55 (1): the body carries the api's own identity only, no `static`.
  expect(versionBody.commit).toBe(COMMIT);
  expect(versionBody.tag).toBe(TAG);
  expect(versionBody).not.toHaveProperty("static");

  // Unauthenticated, deliberately: an identity endpoint an auditor cannot reach
  // proves nothing, and this body carries no configuration, secret or state.
  expect(version.headers.get("content-type")).toContain("application/json");

  // The SAME object rides on /health, so an existing health check gains the
  // identity without a second request — and the two cannot disagree, because
  // both call the one resolver.
  const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  expect(health.status).toBe("ok");
  expect(health.build).toEqual({ commit: COMMIT, tag: TAG });
  // D55 (1): /health no longer reports the site either.
  expect(health).not.toHaveProperty("static");
}, 60_000);

test("an image built without its identity says so at /version rather than guessing", async () => {
  // The condition AC-ID-03 must be able to detect: a service that cannot name
  // its source. It serves — refusing to boot would make an honest "I don't
  // know" undeployable — and it says `unavailable`, which no comparison against
  // a tag can mistake for a match.
  const port = await bootApi({ [BUILD_COMMIT_ENV]: "", [BUILD_TAG_ENV]: "" });
  const body = await (await fetch(`http://127.0.0.1:${port}/version`)).json();
  expect(body).toEqual({
    commit: null,
    tag: null,
    commit_unavailable: `${BUILD_COMMIT_ENV} is unset or blank`,
    tag_unavailable: `${BUILD_TAG_ENV} is unset or blank`,
  });
  // No package version, no timestamp, no branch name, no "unknown".
  expect(JSON.stringify(body)).not.toMatch(/unknown|\d{4}-\d{2}-\d{2}/);
}, 60_000);

