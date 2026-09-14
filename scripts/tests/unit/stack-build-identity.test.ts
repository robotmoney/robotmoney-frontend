// AC-ID-03, the producing half: what `docker compose build` is TOLD the source
// is. The consuming half — /version and /health — is graded in
// backend/tests/api-build-identity-endpoint.test.ts; the wiring between them
// (Dockerfile args, compose build args, no runtime `environment:` override) in
// scripts/tests/integration/smoke-compose-config.test.ts.
//
// Hermetic: `buildIdentityFrom` is total over three command outputs, and
// `resolveBuildIdentityEnv` takes its runner, so nothing here spawns git.
import { describe, expect, test } from "bun:test";
import {
  BUILD_COMMIT_COMPOSE_VAR,
  BUILD_TAG_COMPOSE_VAR,
  buildIdentityFrom,
  resolveBuildIdentityEnv,
} from "../../stack/build-identity.ts";

const SHA = "ebc588b4542de4d5a61aecdba0a967af35afcd6b";

describe("buildIdentityFrom", () => {
  test("a clean, exactly-tagged tree reports the commit and the tag", () => {
    expect(buildIdentityFrom({ head: `${SHA}\n`, exactTag: "v0.5.0-rc.2\n", porcelain: "" })).toEqual({
      [BUILD_COMMIT_COMPOSE_VAR]: SHA,
      [BUILD_TAG_COMPOSE_VAR]: "v0.5.0-rc.2",
    });
  });

  test("a clean untagged tree reports the commit and NO tag", () => {
    // `git describe --tags --exact-match` exits non-zero off a tag, which the
    // resolver turns into "". The alternative — plain `git describe` —
    // would answer `v0.5.0-rc.1-3-gabc1234`, a string that reads like a tag in
    // a dashboard and would quietly pass an eyeball comparison against the RC.
    expect(buildIdentityFrom({ head: SHA, exactTag: "", porcelain: "" })).toEqual({
      [BUILD_COMMIT_COMPOSE_VAR]: SHA,
      [BUILD_TAG_COMPOSE_VAR]: "",
    });
  });

  test("a MODIFIED tree cannot report the pinned SHA or the tag", () => {
    // The whole point of AC-ID-03: "no staging host runs a modified or unpinned
    // tree". A dirty build is not the tagged artifact, and the commit it reports
    // must FAIL a string comparison against the RC's SHA rather than match it
    // beside a flag some checker forgets to read.
    const dirty = buildIdentityFrom({ head: SHA, exactTag: "v0.5.0-rc.2", porcelain: " M backend/src/api/index.ts\n" });
    expect(dirty[BUILD_COMMIT_COMPOSE_VAR]).toBe(`${SHA}+dirty`);
    expect(dirty[BUILD_COMMIT_COMPOSE_VAR]).not.toBe(SHA);
    expect(dirty[BUILD_TAG_COMPOSE_VAR]).toBe("");
  });

  test("a tree whose status probe FAILED is unknown, never clean", () => {
    // The fail-open the RC2 review found: `read()` mapped a non-zero exit to
    // "" and `buildIdentityFrom` read an empty porcelain as clean, so a tree
    // whose index could not be read reported the pinned SHA and the exact tag
    // it had not been checked against. `rev-parse` and `describe` read REFS,
    // not the index, so they answer perfectly well while `status` cannot —
    // which is what makes the combination reachable rather than theoretical.
    const unknown = buildIdentityFrom({
      head: SHA, exactTag: "v0.5.0-rc.2", porcelain: "", porcelainUnavailable: true,
    });
    expect(unknown[BUILD_COMMIT_COMPOSE_VAR]).toBe(`${SHA}+unknown`);
    expect(unknown[BUILD_COMMIT_COMPOSE_VAR], "must fail the AC-ID-03 comparison").not.toBe(SHA);
    expect(unknown[BUILD_TAG_COMPOSE_VAR]).toBe("");
    // Distinguishable from a modified tree: the operator reading /version can
    // tell "you changed the checkout" from "I could not look".
    expect(unknown[BUILD_COMMIT_COMPOSE_VAR]).not.toBe(`${SHA}+dirty`);
  });

  test("an unreadable status wins over a porcelain that happens to be empty", () => {
    // Belt and braces: even if the failed probe left a stdout behind, the
    // ANSWER-OR-NOT flag decides, not the string.
    const unknown = buildIdentityFrom({
      head: SHA, exactTag: "", porcelain: " M f.txt\n", porcelainUnavailable: true,
    });
    expect(unknown[BUILD_COMMIT_COMPOSE_VAR]).toBe(`${SHA}+unknown`);
  });

  test("an unreadable repository yields empty values, never a substitute", () => {
    const none = buildIdentityFrom({ head: "", exactTag: "", porcelain: "" });
    expect(none).toEqual({ [BUILD_COMMIT_COMPOSE_VAR]: "", [BUILD_TAG_COMPOSE_VAR]: "" });
    // Nothing that looks like identity without being it.
    expect(JSON.stringify(none)).not.toMatch(/unknown|main|HEAD|\d{4}-\d{2}-\d{2}/);
  });
});

describe("resolveBuildIdentityEnv", () => {
  const runner = (answers: Record<string, { exitCode: number; stdout: string }>) =>
    (argv: string[]) => {
      const key = argv.join(" ");
      const a = answers[key];
      if (!a) throw new Error(`unexpected command: ${key}`);
      return { ...a, stderr: "" };
    };

  test("asks exactly rev-parse, exact-match describe, and porcelain status", () => {
    const seen: string[] = [];
    resolveBuildIdentityEnv((argv) => {
      seen.push(argv.join(" "));
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    expect(seen).toEqual([
      "git rev-parse HEAD",
      "git describe --tags --exact-match HEAD",
      "git status --porcelain",
    ]);
  });

  test("a non-zero exit is an absent value, not a captured error string", () => {
    const env = resolveBuildIdentityEnv(runner({
      "git rev-parse HEAD": { exitCode: 0, stdout: SHA },
      // Off a tag, `describe --exact-match` exits 128 and prints to stderr.
      "git describe --tags --exact-match HEAD": { exitCode: 128, stdout: "" },
      "git status --porcelain": { exitCode: 0, stdout: "" },
    }));
    expect(env).toEqual({ [BUILD_COMMIT_COMPOSE_VAR]: SHA, [BUILD_TAG_COMPOSE_VAR]: "" });
  });

  test("a FAILING `git status` is unknown-and-therefore-not-pinned, not clean", () => {
    // The exact shape measured in the RC2 review: rev-parse 0, describe 0,
    // status 128 with empty stdout. Before the fix this returned the bare SHA
    // and `v0.5.0-rc.2`. (The obvious trigger, `.git/index.lock`, does NOT
    // reproduce it — git exits 0 and still prints the dirty entries — so the
    // case is pinned here rather than through a real repository.)
    const env = resolveBuildIdentityEnv(runner({
      "git rev-parse HEAD": { exitCode: 0, stdout: SHA },
      "git describe --tags --exact-match HEAD": { exitCode: 0, stdout: "v0.5.0-rc.2" },
      "git status --porcelain": { exitCode: 128, stdout: "" },
    }));
    expect(env).toEqual({
      [BUILD_COMMIT_COMPOSE_VAR]: `${SHA}+unknown`,
      [BUILD_TAG_COMPOSE_VAR]: "",
    });
  });

  test("a runner that throws only on `status` is likewise unknown", () => {
    const env = resolveBuildIdentityEnv((argv) => {
      const key = argv.join(" ");
      if (key === "git status --porcelain") throw new Error("EACCES .git/index");
      if (key === "git rev-parse HEAD") return { exitCode: 0, stdout: SHA, stderr: "" };
      return { exitCode: 0, stdout: "v0.5.0-rc.2", stderr: "" };
    });
    expect(env[BUILD_COMMIT_COMPOSE_VAR]).toBe(`${SHA}+unknown`);
    expect(env[BUILD_TAG_COMPOSE_VAR]).toBe("");
  });

  test("a thrown runner (no git at all) never fails the bring-up", () => {
    // Reporting `unavailable` loudly at /version must stay deployable; failing
    // the stack here would make an honest "I don't know" impossible to ship.
    expect(resolveBuildIdentityEnv(() => { throw new Error("spawn git ENOENT"); })).toEqual({
      [BUILD_COMMIT_COMPOSE_VAR]: "",
      [BUILD_TAG_COMPOSE_VAR]: "",
    });
  });
});

describe("the stack actually wires it into the build", () => {
  test("scripts/stack/stack.ts resolves the identity before `compose build`", async () => {
    // stack.ts boots nothing on import but does spawn on use; the wiring is
    // asserted over source text, the same way smoke-main-split.test.ts grades
    // scripts/lib/smoke-main.ts.
    const src = await Bun.file(new URL("../../stack/stack.ts", import.meta.url)).text();
    const build = src.slice(src.indexOf("async function build("));
    const resolveAt = build.indexOf("resolveBuildIdentityEnv(");
    const composeAt = build.indexOf("buildArgs(buildServices)");
    expect(resolveAt, "build() resolves the identity").toBeGreaterThan(-1);
    expect(resolveAt, "…and does so BEFORE compose build runs").toBeLessThan(composeAt);
    // Never inherited from the operator's environment: RM_BUILD_* is absent
    // from the docker-client allowlist, so a host value cannot reach a child.
    const config = await Bun.file(new URL("../../stack/config.ts", import.meta.url)).text();
    const allowlist = config.slice(config.indexOf("DOCKER_CLIENT_ENV_ALLOWLIST"), config.indexOf("] as const;", config.indexOf("DOCKER_CLIENT_ENV_ALLOWLIST")));
    expect(allowlist).not.toContain("RM_BUILD_");
  });
});
