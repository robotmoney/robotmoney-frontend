// Issue #892 AC3 (shell check, promoted to an executed test per this repo's
// coverage policy — never a manual-only step): `docker compose build
// website-server` exits 0, and the built image carries no Bun/Node runtime —
// only the nginx binary and whatever `website-server/Dockerfile` COPYs in.
// The image ships NO application code; `_static/` itself is bind-mounted at
// run time (docker-compose.yml), never baked in, so this asserts the image
// layers, not the served content (scripts/tests/integration/
// prerender-static-dir.test.ts covers that).
//
// LOUD, NEVER SKIPPED. Docker is a hard dependency of this repo's test
// harness already (the backend suite boots ephemeral Postgres through it).
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../../..");
const PROJECT = "rm-website-server-image-test";
// Compose's own naming convention for an image it builds: `<project>-<service>`.
const IMAGE_TAG = `${PROJECT}-website-server`;

// `docker compose build <service>` still interpolates the WHOLE file (every
// service's env), not just website-server's — these two are the only
// required (no-default `${VAR:?...}`) interpolations in docker-compose.yml,
// and their value is irrelevant to a build (never a boot).
const composeEnv = { ...process.env, WEB_PORT: "1", POSTGRES_PORT: "1" };
const composeArgv = ["compose", "-p", PROJECT, "-f", "docker-compose.yml"];

function buildWebsiteServer(): void {
  execFileSync("docker", [...composeArgv, "build", "website-server"], {
    cwd: repoRoot,
    env: composeEnv,
    stdio: "pipe",
  });
}

afterAll(() => {
  execFileSync("docker", ["rmi", "-f", IMAGE_TAG], { stdio: "pipe" });
});

test("docker compose build website-server exits 0", () => buildWebsiteServer(), 120_000);

describe("the built image carries no application runtime (issue #892 AC3)", () => {
  test(
    "docker history shows nginx + this repo's nginx.conf only — no bun/node/npm layer",
    () => {
      // Depends on the build test above having run; rebuilding here (cached)
      // is cheap and keeps this test independently runnable
      // (`bun test --test-name-pattern`).
      buildWebsiteServer();

      const history = execFileSync("docker", ["history", "--no-trunc", IMAGE_TAG]).toString();
      const runtimeLines = history
        .split("\n")
        .filter((l) => /\b(bun|node|npm|npx)\b/i.test(l));
      expect(runtimeLines).toEqual([]);
    },
    120_000,
  );
});
