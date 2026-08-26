// Operator-surface documentation guard for PROJECTS_SOURCE (review findings
// 016 + 001). backend/src/projects/access/select.ts FAIL-CLOSES in prod: the
// projects pipelines throw "projects pipelines require PROJECTS_SOURCE=live in
// prod" rather than serve fixture data as production — yet the knob used to be
// documented NOWHERE an operator looks, so a prod deployment following the
// shipped compose/env files crash-looped on an undiscoverable env var. This
// test pins the fix: every operator surface (.env.example, both compose files,
// docs/runbooks/deployment.md) must keep mentioning PROJECTS_SOURCE, so the
// documentation can never silently regress. It also pins the .env.example
// adapter-block honesty fix: PR #112 made the REAL deployed Base adapter
// addresses the config defaults (backend/src/config.ts resolveVaultAdapters),
// so the old "non-functional placeholders" claim must never reappear.
//
// Runs in the required unit.yml root job via `bun run test`.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../../..");
const read = (rel: string) => readFileSync(join(repoRoot, rel), "utf8");

// Every surface an operator consults when deploying — the finding's exact gap
// was "zero hits across docs/, .env.example, compose files".
const OPERATOR_SURFACES = [
  ".env.example",
  "docker-compose.yml",
  "docker-compose.smoke.yml",
  "docs/runbooks/deployment.md",
] as const;

describe("PROJECTS_SOURCE is documented on every operator surface", () => {
  for (const rel of OPERATOR_SURFACES) {
    test(`${rel} mentions PROJECTS_SOURCE`, () => {
      expect(read(rel)).toContain("PROJECTS_SOURCE");
    });
  }

  test(".env.example documents the prod fail-closed contract (PROJECTS_SOURCE=live)", () => {
    // Not just a name-drop: the operator must learn the required prod value.
    expect(read(".env.example")).toContain("PROJECTS_SOURCE=live");
  });

  test("docs/runbooks/deployment.md documents the prod fail-closed contract (PROJECTS_SOURCE=live)", () => {
    expect(read("docs/runbooks/deployment.md")).toContain("PROJECTS_SOURCE=live");
  });

  test("both compose files pass PROJECTS_SOURCE through to the containers", () => {
    // The passthrough (`${PROJECTS_SOURCE:-}`) is what lets a droplet/.env set
    // the knob without editing the compose files.
    expect(read("docker-compose.yml")).toContain("${PROJECTS_SOURCE:-}");
    expect(read("docker-compose.smoke.yml")).toContain("${PROJECTS_SOURCE:-}");
  });
});

describe(".env.example adapter block is honest about the #112 real defaults", () => {
  test("the stale 'non-functional placeholders' claim is gone", () => {
    // Exact stale wording (pre-fix): "the built-in defaults are non-functional
    // placeholders (no contract at those addresses) until the real deployed
    // addresses are set here." — false since PR #112 baked the real deployed
    // Base mainnet adapter addresses as the config defaults.
    const env = read(".env.example");
    expect(env).not.toContain("non-functional placeholders");
    expect(env).not.toContain("no contract at\n# those addresses");
  });

  test("the adapter block states the defaults are the real deployed addresses", () => {
    expect(read(".env.example")).toContain(
      "REAL deployed Base mainnet adapter addresses are the built-in",
    );
  });
});
