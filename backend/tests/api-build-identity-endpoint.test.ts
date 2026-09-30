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
import net from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUILD_COMMIT_ENV,
  BUILD_TAG_ENV,
  buildIdentityJson,
  resolveBuildIdentity,
} from "../src/ops/build-identity.ts";

const backendDir = join(dirname(fileURLToPath(import.meta.url)), "..");
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
function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.on("error", rej);
    s.listen(0, () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => res(p));
    });
  });
}

const spawned: ReturnType<typeof Bun.spawn>[] = [];
afterAll(() => { for (const p of spawned) p.kill(); });

async function bootApi(extraEnv: Record<string, string>): Promise<number> {
  const port = await freePort();
  const proc = Bun.spawn(["bun", "run", "src/api/index.ts"], {
    cwd: backendDir,
    env: { ...process.env, API_PORT: String(port), ...extraEnv },
    stdout: "ignore",
    stderr: "pipe",
  });
  spawned.push(proc);
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (proc.exitCode !== null) {
      throw new Error(`api exited with ${proc.exitCode}:\n${await new Response(proc.stderr as ReadableStream).text()}`);
    }
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return port;
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error(`api never served /health on :${port}`);
    await new Promise((r) => setTimeout(r, 200));
  }
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
  // them. `static` is the SPA half (T26) and is asserted on its own below; a
  // toEqual over the whole body would make every future identity field a test
  // change rather than an addition.
  expect(versionBody.commit).toBe(COMMIT);
  expect(versionBody.tag).toBe(TAG);

  // Unauthenticated, deliberately: an identity endpoint an auditor cannot reach
  // proves nothing, and this body carries no configuration, secret or state.
  expect(version.headers.get("content-type")).toContain("application/json");

  // The SAME object rides on /health, so an existing health check gains the
  // identity without a second request — and the two cannot disagree, because
  // both call the one resolver.
  const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  expect(health.status).toBe("ok");
  expect(health.build).toEqual({ commit: COMMIT, tag: TAG });
});

test("an image built without its identity says so at /version rather than guessing", async () => {
  // The condition AC-ID-03 must be able to detect: a service that cannot name
  // its source. It serves — refusing to boot would make an honest "I don't
  // know" undeployable — and it says `unavailable`, which no comparison against
  // a tag can mistake for a match.
  const port = await bootApi({ [BUILD_COMMIT_ENV]: "", [BUILD_TAG_ENV]: "" });
  const body = await (await fetch(`http://127.0.0.1:${port}/version`)).json();
  const { static: staticIdentity, ...image } = body;
  expect(image).toEqual({
    commit: null,
    tag: null,
    commit_unavailable: `${BUILD_COMMIT_ENV} is unset or blank`,
    tag_unavailable: `${BUILD_TAG_ENV} is unset or blank`,
  });
  // No package version, no timestamp, no branch name, no "unknown".
  expect(JSON.stringify(image)).not.toMatch(/unknown|\d{4}-\d{2}-\d{2}/);
  // An image with no identity cannot be "matched" by a frontend either.
  expect(staticIdentity.matches_image).toBe(false);
});


// ── T26: the SPA the api is SERVING, not only the image it IS ───────────────
test("GET /version reports the served frontend's digest, and whether it agrees with the image", async () => {
  // The gap this closes: `_static` is a read-only bind of a directory assembled
  // on the deploy host AFTER the image exists, so nothing baked in can describe
  // it. A redeploy that rebuilt the image and skipped `bun run static:assemble`
  // left the right api serving the previous release's HTML with every AC-ID-03
  // check still green. Three cases, all against the real process over HTTP.
  const dir = mkdtempSync(join(tmpdir(), "rm-static-identity-"));
  const digest = `sha256:${"a".repeat(64)}`;
  writeFileSync(
    join(dir, ".rm-static-manifest.json"),
    JSON.stringify({ schema: 1, commit: COMMIT, tag: TAG, digest, files: 393, generated_at: "2026-09-14T00:00:00.000Z" }),
  );

  const agreed = await (await fetch(`http://127.0.0.1:${await bootApi({ [BUILD_COMMIT_ENV]: COMMIT, [BUILD_TAG_ENV]: TAG, STATIC_DIR: dir })}/version`)).json();
  expect(agreed.static).toEqual({ digest, commit: COMMIT, tag: TAG, files: 393, generated_at: "2026-09-14T00:00:00.000Z", matches_image: true });

  // The drift itself: same directory, an image built from another commit.
  const drifted = await (await fetch(`http://127.0.0.1:${await bootApi({ [BUILD_COMMIT_ENV]: "0".repeat(40), [BUILD_TAG_ENV]: "v0.4.0", STATIC_DIR: dir })}/version`)).json();
  expect(drifted.static.matches_image).toBe(false);
  expect(drifted.static.digest).toBe(digest);

  // An UNASSEMBLED directory — the shape Docker leaves behind when the bind
  // path did not exist — is `unavailable` with the reason named, never absent.
  const bare = await (await fetch(`http://127.0.0.1:${await bootApi({ [BUILD_COMMIT_ENV]: COMMIT, [BUILD_TAG_ENV]: TAG, STATIC_DIR: mkdtempSync(join(tmpdir(), "rm-static-bare-")) })}/version`)).json();
  expect(bare.static.digest).toBeNull();
  expect(bare.static.matches_image).toBe(false);
  expect(String(bare.static.unavailable)).toMatch(/static-assembly|manifest/);
});
