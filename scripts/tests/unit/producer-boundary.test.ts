import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildComposeEnv, DEFAULT_COMPOSE_FILES, DEFAULT_STACK_DATABASE, type StackConfig } from "../../stack/config.ts";
import { missingTokenFiles, PROVISION_TOKENS_COMMAND, readServiceToken, tokenReuseRefusal } from "../../lib/smoke-secret.ts";
import { instancePaths, SERVICE_TOKEN_HOLDERS } from "../../lib/smoke-state.ts";

const repo = join(import.meta.dir, "../../..");

/** One compose service's block, from its key to the next top-level service. */
function serviceBlock(compose: string, service: string): string {
  const start = compose.indexOf(`\n  ${service}:\n`);
  expect(start).toBeGreaterThan(-1);
  const rest = compose.slice(start + 1);
  const next = rest.slice(3).search(/\n {2}[a-z][a-z0-9-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next + 3);
}

describe("issue #361 independent producer credential boundary, as service-token files (spec §3, D52)", () => {
  test("the producer reads its own holder's token file; the api holds no token at all", () => {
    const compose = readFileSync(join(repo, "docker-compose.yml"), "utf8");
    const workerBlock = compose.slice(compose.indexOf("x-worker-env:"), compose.indexOf("services:"));
    expect(workerBlock).not.toContain("ANALYTICS_TOKEN");
    const producer = serviceBlock(compose, "analytics-producer");
    expect(producer).toContain("ANALYTICS_TOKEN_FILE: /run/rm-token/token");
    expect(producer).toContain("/tokens/analytics-producer:/run/rm-token:ro");
    expect(producer).not.toMatch(/^[ \t]*DATABASE_URL:/m);
    // The api validates every bearer against its token store (§3): no token
    // env, no token file, no secret mount.
    const api = serviceBlock(compose, "api");
    for (const retired of ["ADMIN_TOKEN:", "AUTOMATION_TOKEN:", "ANALYTICS_TOKEN:", "ANALYTICS_TOKEN_FILE:", "/run/secrets/", "rm-token"]) {
      expect({ retired, found: api.includes(retired) }).toEqual({ retired, found: false });
    }
    // The shared `analytics_token` Docker secret is gone with the comparison it fed.
    expect(compose).not.toMatch(/^secrets:/m);
    expect(compose).not.toContain("ANALYTICS_TOKEN_FILE_HOST");
  });

  test("a stack's compose env carries no service token of any kind", () => {
    const cfg: StackConfig = {
      repoRoot: "/repo", project: "p", profile: "full", composeFiles: DEFAULT_COMPOSE_FILES,
      database: DEFAULT_STACK_DATABASE,
      environment: { class: "local", hash: "0123456789" },
    };
    const env = buildComposeEnv(cfg);
    for (const key of ["ADMIN_TOKEN", "AUTOMATION_TOKEN", "ANALYTICS_TOKEN", "ANALYTICS_TOKEN_FILE_HOST"]) {
      expect({ key, present: key in env }).toEqual({ key, present: false });
    }
  });

  // Spec §3 (issue #1026, criteria 31, 43): each service token is a file in the
  // INSTANCE's state directory, per holder. A boot that may not mint (a remote
  // target, a `--local volume` reattach) reuses the files or refuses.
  test("a remote boot with no token files refuses, naming the explicit provisioning command; a volume reattach refuses too", () => {
    const root = mkdtempSync(join(tmpdir(), "rm-producer-boundary-"));
    try {
      const paths = instancePaths(root, "rm_local_secret_test", { create: true });
      expect(missingTokenFiles(paths)).toEqual([...SERVICE_TOKEN_HOLDERS]);
      const remote = tokenReuseRefusal(paths, "remote");
      expect(remote).toContain(PROVISION_TOKENS_COMMAND);
      expect(remote).toContain(paths.tokenFiles["system-scheduler"]);
      expect(tokenReuseRefusal(paths, "volume")).toContain("--local volume");
      // One holder present is not enough: every missing one is named.
      writeFileSync(paths.tokenFiles.operator, "rmat_operator\n", { mode: 0o600 });
      expect(missingTokenFiles(paths)).toEqual(["system-scheduler", "analytics-producer"]);
      expect(tokenReuseRefusal(paths, "remote")).not.toContain(paths.tokenFiles.operator);
      // An empty file is a missing token, not a present one.
      writeFileSync(paths.tokenFiles["system-scheduler"], "\n", { mode: 0o600 });
      writeFileSync(paths.tokenFiles["analytics-producer"], "rmat_producer\n", { mode: 0o600 });
      expect(missingTokenFiles(paths)).toEqual(["system-scheduler"]);
      writeFileSync(paths.tokenFiles["system-scheduler"], "rmat_scheduler\n", { mode: 0o600 });
      expect(tokenReuseRefusal(paths, "remote")).toBeNull();
      expect(readServiceToken(paths, "operator")).toBe("rmat_operator");
      expect(paths.tokensDir.startsWith(repo)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the boot never writes a token itself: only the provisioning entry module does, after the plan", () => {
    // The inference preflight runs at module scope and exits on refusal; the
    // tokens are written inside main(), by the `prepare (tokens)` step that
    // follows the journaled plan phase (spec §1.2: nothing before the plan),
    // and by backend/scripts/provision-tokens.ts alone.
    const smoke = readFileSync(join(repo, "scripts/lib/smoke-main.ts"), "utf8");
    const preflight = smoke.indexOf("preflightInferenceOrExit(");
    const main = smoke.indexOf("async function main(");
    const planPhase = smoke.indexOf('await begin("plan"');
    const provision = smoke.indexOf('await begin("prepare", "tokens")');
    expect(preflight).toBeGreaterThan(-1);
    expect(main).toBeGreaterThan(preflight);
    expect(planPhase).toBeGreaterThan(main);
    expect(provision).toBeGreaterThan(planPhase);
    expect(smoke.indexOf("runTokenProvisioning(", provision)).toBeGreaterThan(provision);
    // No token value is minted in the boot or in the stack library.
    for (const file of ["scripts/lib/smoke-main.ts", "scripts/stack/config.ts", "scripts/lib/smoke-secret.ts"]) {
      const text = readFileSync(join(repo, file), "utf8");
      expect({ file, mints: /randomBytes|randomUUID\(\)\.replace/.test(text) }).toEqual({ file, mints: false });
    }
  });
});
