// REPOSITORY GUARD for issue #973: `RM_ENV` and `RM_ALLOW_INSECURE` are retired
// from the runtime, and the test-only paths they used to open are opened by
// backend/src/test-seam.ts alone.
//
// What it pins, against the real tree:
//   1. No runtime module reads `RM_ENV`. The only reader left in backend/src
//      is the §4.3 policy input of the OPERATOR tools (deploy-policy.ts);
//      backend/scripts are the operator's commands and not a container's
//      process. The stack's acceptance path reads no environment (issue 1326).
//   2. `config.env`, `config.allowInsecure` and `RM_ALLOW_INSECURE` exist
//      nowhere a process, a compose file or a workflow could read them. The one
//      allowed mention is the refusal that names the retired variable.
//   3. The test seam is armed by backend/tests/preload.ts and by nothing else,
//      and the fixture projects source is injected from backend/tests only.
//   4. The harness sets no `RM_ENV`, so nothing in the runtime can be keyed on
//      it by accident again.
//   5. No container is handed `RM_ENV` (issue 1326): no compose file, stack
//      composefile, workflow step, StackConfig or participant env carries it.
//
// A guard that only ever passes is theatre, so each rule has a red control: the
// scanner is run over a planted violation and must report it.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..", "..");

function walk(dir: string, keep: (name: string) => boolean): string[] {
  if (!statSync(dir, { throwIfNoEntry: false })) return [];
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name === ".git") return [];
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full, keep) : keep(name) ? [full] : [];
  });
}

const isTs = (n: string) => /\.tsx?$/.test(n);
const isYml = (n: string) => /\.ya?ml$/.test(n);

/** Every way a module could READ `RM_ENV` from an environment record (comments and prose are not reads). */
function rmEnvReads(text: string): string[] {
  const re = /\benv\.RM_ENV\b|\benv\[\s*["']RM_ENV["']\s*\]|\bRM_ENV\s*:\s*(?:process\.env|env)\.RM_ENV\b/g;
  return [...text.matchAll(re)].map((m) => m[0]);
}

/** Any mention at all of a retired name, token or field. */
function retiredMentions(text: string): string[] {
  const re = /RM_ALLOW_INSECURE|\bconfig\.env\b|\ballowInsecure\b|--allow-insecure/g;
  return [...text.matchAll(re)].map((m) => m[0]);
}

function hits(files: string[], scan: (text: string) => string[], allow: readonly string[] = []): string[] {
  return files
    .filter((f) => !allow.includes(relative(repoRoot, f)))
    .flatMap((f) => scan(readFileSync(f, "utf8")).map((h) => `${relative(repoRoot, f)}: ${h}`));
}

const BACKEND_SRC = walk(join(repoRoot, "backend", "src"), isTs);

describe("1. no runtime module reads RM_ENV (issue #973)", () => {
  /** The §4.3 policy input: the one operator-facing reader the smoke spec keeps (§4.1, §4.3). */
  const POLICY_READERS = ["backend/src/deploy-policy.ts"];

  test("backend/src reads RM_ENV only in the §4.3 policy readers", () => {
    expect(BACKEND_SRC.length).toBeGreaterThan(50); // walker sanity
    expect(hits(BACKEND_SRC, rmEnvReads, POLICY_READERS)).toEqual([]);
  });

  test("config.ts has no RM_ENV read and exports no `env` field", () => {
    const config = readFileSync(join(repoRoot, "backend", "src", "config.ts"), "utf8");
    expect(rmEnvReads(config)).toEqual([]);
    expect(config).not.toMatch(/^\s*env:\s*RM_ENV/m);
  });

  test("the api and worker entrypoints, the db seams and the selectors read no RM_ENV and no config.env", () => {
    for (const file of [
      "backend/src/api/index.ts",
      "backend/src/worker/index.ts",
      "backend/src/worker/runtime.ts",
      "backend/src/db/client.ts",
      "backend/src/db/worker-client.ts",
      "backend/src/projects/access/select.ts",
      "backend/src/projects/seed/roster-seed.ts",
      "backend/src/swarm/domain.ts",
      "backend/src/acceptance-path.ts",
      "backend/src/swarm/judge-model-policy.ts",
      "backend/src/swarm/judge-config.ts",
      "scripts/agent/participant/judge-client.ts",
      "scripts/lib/onboarding-eval.ts",
    ]) {
      const text = readFileSync(join(repoRoot, file), "utf8");
      expect(`${file}: ${rmEnvReads(text).join(",")}`).toBe(`${file}: `);
      expect(`${file}: ${retiredMentions(text).join(",")}`).toBe(`${file}: `);
    }
  });

  test("red control: the scanner finds each read shape", () => {
    const planted = [
      `const e = process.env.RM_ENV ?? "prod";`,
      `const f = env["RM_ENV"];`,
      `resolveRmEnv({ RM_ENV: process.env.RM_ENV });`,
      `// a comment naming RM_ENV is not a read`,
    ].join("\n");
    expect(rmEnvReads(planted)).toHaveLength(3);
  });
});

describe("2. RM_ALLOW_INSECURE, config.env and allowInsecure exist nowhere a process, compose file or workflow reads", () => {
  /** The one refusal that names the retired variable so a stale shell export is explained, not ignored. */
  const NAMING_REFUSAL = ["scripts/stack/config.ts"];
  /** v0.6.2's version check V09-rm-env-retired names the retired variables to prove no running container holds them. */
  const RETIREMENT_PROOF = ["scripts/release/version-checks/v0.6.2/rm-env-retired.ts"];

  test("backend/src, backend/scripts and scripts/ (tests excluded) mention none of them", () => {
    const files = [
      ...BACKEND_SRC,
      ...walk(join(repoRoot, "backend", "scripts"), isTs),
      ...walk(join(repoRoot, "scripts"), isTs).filter((f) => !f.includes(`${join("scripts", "tests")}/`)),
    ];
    expect(hits(files, retiredMentions, [...NAMING_REFUSAL, ...RETIREMENT_PROOF])).toEqual([]);
    // The refusal is the only thing that file says about it.
    const config = readFileSync(join(repoRoot, "scripts", "stack", "config.ts"), "utf8");
    expect(retiredMentions(config)).toEqual(["RM_ALLOW_INSECURE", "RM_ALLOW_INSECURE"]);
    expect(config).toContain("RM_ALLOW_INSECURE is retired (issue #973)");
  });

  test("docker-compose.yml, the stack composefiles, the workflows and .env.example define none of them", () => {
    const files = [
      join(repoRoot, "docker-compose.yml"),
      join(repoRoot, ".env.example"),
      ...walk(join(repoRoot, "stacks"), isYml),
      ...walk(join(repoRoot, ".github"), isYml),
    ];
    expect(files.length).toBeGreaterThan(5);
    expect(hits(files, retiredMentions)).toEqual([]);
  });

  test("backend/tests and scripts/tests mention none of them, except the planted-string red control of criterion 117", () => {
    const files = [...walk(join(repoRoot, "backend", "tests"), isTs), ...walk(join(repoRoot, "scripts", "tests"), isTs)];
    const allow = [
      "backend/tests/automation-token.test.ts", // criterion 117's planted lines and the retired-env boot proof
      "backend/tests/api/analytics-write.test.ts", // proves the retired name is not an opt-out
      "backend/tests/epoch-lifecycle-auth.test.ts", // same proof against the real api process
      "scripts/tests/unit/swarm-session-insecure.test.ts", // proves the driver is spawned without it
      "scripts/tests/unit/smoke-env-policy.test.ts", // proves the flag is gone
      "scripts/tests/unit/smoke-compose-env.test.ts", // proves the compose env has no such key
      "scripts/tests/integration/smoke-compose-config.test.ts", // proves no service receives it
      "scripts/tests/integration/smoke-stage-vs-production-identity.test.ts", // names the retired flag as absent
      "scripts/tests/unit/version-checks-v062-b.test.ts", // V09-rm-env-retired's red control plants the retired names in a container env
      relative(repoRoot, import.meta.path),
    ];
    expect(hits(files, retiredMentions, allow)).toEqual([]);
  });

  test("red control: the scanner finds each retired mention", () => {
    const planted = `allowInsecure: process.env.RM_ALLOW_INSECURE === "1"; if (config.env === "prod") {} // --allow-insecure`;
    expect(retiredMentions(planted)).toEqual(["allowInsecure", "RM_ALLOW_INSECURE", "config.env", "--allow-insecure"]);
  });
});

describe("3. the test seam is armed by the harness preload and by nothing else", () => {
  const callers = (pattern: RegExp, files: string[]) =>
    files.filter((f) => pattern.test(readFileSync(f, "utf8"))).map((f) => relative(repoRoot, f)).sort();

  test("armTestSeam() is called from backend/tests/preload.ts only", () => {
    const everything = [
      ...BACKEND_SRC,
      ...walk(join(repoRoot, "backend", "scripts"), isTs),
      ...walk(join(repoRoot, "backend", "tests"), isTs),
      ...walk(join(repoRoot, "scripts"), isTs),
    ];
    // A call statement, not the definition (`function armTestSeam(): void`) and not this guard's prose.
    expect(callers(/^\s*armTestSeam\(\);/m, everything)).toEqual(["backend/tests/preload.ts"]);
  });

  test("injectProjectsDataSource() is called from backend/tests only; backend/src only defines it", () => {
    const runtime = [...BACKEND_SRC, ...walk(join(repoRoot, "backend", "scripts"), isTs), ...walk(join(repoRoot, "scripts"), isTs).filter((f) => !f.includes(`${join("scripts", "tests")}/`))];
    expect(callers(/\binjectProjectsDataSource\(/, runtime)).toEqual(["backend/src/projects/access/select.ts"]);
    const select = readFileSync(join(repoRoot, "backend", "src", "projects", "access", "select.ts"), "utf8");
    expect(select).not.toMatch(/^\s*injectProjectsDataSource\(/m); // the definition and its refusal text, no call
    expect(callers(/\binjectProjectsDataSource\(/, walk(join(repoRoot, "backend", "tests"), isTs))).toContain("backend/tests/preload.ts");
  });

  test("every seam-guarded path consults testSeamArmed()", () => {
    for (const file of [
      "backend/src/db/client.ts",
      "backend/src/db/worker-client.ts",
      "backend/src/projects/access/select.ts",
      "backend/src/swarm/domain.ts",
      "backend/src/swarm/judge-draw.ts",
    ]) {
      expect(`${file}: ${/\btestSeamArmed\(\)/.test(readFileSync(join(repoRoot, file), "utf8"))}`).toBe(`${file}: true`);
    }
  });
});

describe("4. the harness declares no environment class", () => {
  test("backend/tests/preload.ts sets no RM_ENV", () => {
    const preload = readFileSync(join(repoRoot, "backend", "tests", "preload.ts"), "utf8");
    expect(preload).not.toMatch(/process\.env\.RM_ENV\s*=/);
  });
});

describe("5. no container is handed RM_ENV (issue 1326)", () => {
  /** A compose or workflow line that SETS `RM_ENV` (a YAML key), not prose naming it. */
  const rmEnvKeys = (text: string): string[] => [...text.matchAll(/^\s*RM_ENV\s*:.*$/gm)].map((m) => m[0].trim());

  test("docker-compose.yml, the stack composefiles and the workflows set no RM_ENV", () => {
    const files = [
      join(repoRoot, "docker-compose.yml"),
      ...walk(join(repoRoot, "stacks"), isYml),
      ...walk(join(repoRoot, ".github", "workflows"), isYml),
    ];
    expect(files.length).toBeGreaterThan(5);
    expect(hits(files, rmEnvKeys)).toEqual([]);
  });

  test("the stack config and the participant renderer emit no RM_ENV", () => {
    for (const file of ["scripts/stack/config.ts", "scripts/lib/participant-compose.ts", "scripts/lib/smoke-plan-configuration.ts"]) {
      const text = readFileSync(join(repoRoot, file), "utf8");
      expect(`${file}: ${/^\s*RM_ENV\s*:/m.test(text)}`).toBe(`${file}: false`);
      expect(`${file}: ${/\brmEnv\b/.test(text)}`).toBe(`${file}: false`);
    }
  });

  test("red control: the scanner finds a compose key and ignores prose", () => {
    expect(rmEnvKeys("  RM_ENV: ${RM_ENV:-prod}\n  # RM_ENV is retired\n        RM_ENV: stage")).toEqual([
      "RM_ENV: ${RM_ENV:-prod}",
      "RM_ENV: stage",
    ]);
  });
});
