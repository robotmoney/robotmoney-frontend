// scripts/lib/smoke-inference-preflight.ts — the refusal that makes checklist
// step 1.3's third bullet true at BOOT time, and the delivery that makes it
// true inside the containers.
//
// WHY THIS FILE EXISTS. Until it did, `grep -rn 'preflightInference'` over the
// whole repo returned exactly two hits, both in scripts/lib/smoke-main.ts: the
// import and a comment. The module had no test at all, while its own header
// cited one that never imported it. The uncovered code is load-bearing —
// deleting the write-back, or the returned compose fragment, or the
// preflightInferenceOrExit call itself, left every other test in the repo green
// and silently reproduced the 2026-09-13 staging state: a standing stack running
// `AGENT_MODEL=free` with an empty `OPENCODE_API_KEY`, every judgement
// `model_unconfigured`, and nothing anywhere saying so.
//
// Everything here is driven against a FIXTURE repo root and a PLAIN env object,
// so no test reads the developer's real `.env` and no real credential is ever in
// scope. The values used are obvious fakes.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preflightInference } from "../../lib/smoke-inference-preflight.ts";
import { ENV_FILE, READONLY_ENV_FILE, ZEN_KEY_ENV } from "../../lib/opencode-key.ts";
import { buildSpawnEnv, DEFAULT_COMPOSE_FILES, DEFAULT_STACK_DATABASE, type StackConfig } from "../../stack/index.ts";

const root = mkdtempSync(join(tmpdir(), "rm-inference-preflight-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const FAKE_KEY = "sk-not-a-real-key-env";
const FAKE_ENV_FILE_KEY = "sk-not-a-real-key-dotenv";
const FAKE_READONLY_KEY = "sk-not-a-real-key-readonly";

beforeEach(() => {
  rmSync(join(root, ENV_FILE), { force: true });
  rmSync(join(root, READONLY_ENV_FILE), { force: true });
});

/** Log lines, so the "never prints the value" property is assertable. */
function run(env: Record<string, string | undefined>, standingStack = true) {
  const logged: string[] = [];
  const composeEnv = preflightInference({ standingStack, repoRoot: root, env, log: (m) => logged.push(m) });
  return { composeEnv, logged, env };
}

describe("the standing stack resolves its credential from all three sources", () => {
  test("the process environment", () => {
    const { composeEnv, logged, env } = run({ [ZEN_KEY_ENV]: FAKE_KEY, AGENT_MODEL: "deepseek", RM_ENV: "prod" });
    expect(env[ZEN_KEY_ENV]).toBe(FAKE_KEY);
    expect(composeEnv[ZEN_KEY_ENV]).toBe(FAKE_KEY);
    expect(logged.join("\n")).toContain("from process environment");
    // THE VALUE IS NEVER PRINTED — only which of the three places held it.
    expect(logged.join("\n")).not.toContain(FAKE_KEY);
  });

  test("./.env — the file an operator correcting a stage host actually edits", () => {
    writeFileSync(join(root, ENV_FILE), `DATABASE_URL=postgres://x\n${ZEN_KEY_ENV}=${FAKE_ENV_FILE_KEY}\n`);
    const { composeEnv, logged, env } = run({ AGENT_MODEL: "deepseek", RM_ENV: "prod" });
    expect(env[ZEN_KEY_ENV]).toBe(FAKE_ENV_FILE_KEY);
    expect(composeEnv[ZEN_KEY_ENV]).toBe(FAKE_ENV_FILE_KEY);
    expect(logged.join("\n")).toContain(`from ./${ENV_FILE}`);
  });

  test("./.env.readonly", () => {
    writeFileSync(join(root, READONLY_ENV_FILE), `${ZEN_KEY_ENV}="${FAKE_READONLY_KEY}"\n`);
    const { composeEnv, env } = run({ AGENT_MODEL: "deepseek", RM_ENV: "prod" });
    expect(env[ZEN_KEY_ENV]).toBe(FAKE_READONLY_KEY);
    expect(composeEnv[ZEN_KEY_ENV]).toBe(FAKE_READONLY_KEY);
  });

  test("process environment wins over ./.env, which wins over ./.env.readonly", () => {
    writeFileSync(join(root, ENV_FILE), `${ZEN_KEY_ENV}=${FAKE_ENV_FILE_KEY}\n`);
    writeFileSync(join(root, READONLY_ENV_FILE), `${ZEN_KEY_ENV}=${FAKE_READONLY_KEY}\n`);
    expect(run({ [ZEN_KEY_ENV]: FAKE_KEY, AGENT_MODEL: "deepseek", RM_ENV: "prod" }).composeEnv[ZEN_KEY_ENV]).toBe(FAKE_KEY);
    expect(run({ AGENT_MODEL: "deepseek", RM_ENV: "prod" }).composeEnv[ZEN_KEY_ENV]).toBe(FAKE_ENV_FILE_KEY);
  });
});

describe("the standing stack refuses to boot rather than produce nothing", () => {
  test("no credential anywhere: the refusal names all three places", () => {
    let thrown: unknown;
    try { run({ AGENT_MODEL: "deepseek", RM_ENV: "prod" }); } catch (err) { thrown = err; }
    const message = String((thrown as Error)?.message ?? "");
    expect(message).toContain(ZEN_KEY_ENV);
    expect(message).toContain(`./${ENV_FILE}`);
    expect(message).toContain(`./${READONLY_ENV_FILE}`);
    // And it forecloses the workaround that caused the incident.
    expect(message).toMatch(/AGENT_MODEL=free/);
  });

  test("AGENT_MODEL=free with a credential present is still refused — the free family is disqualified", () => {
    let thrown: unknown;
    try { run({ [ZEN_KEY_ENV]: FAKE_KEY, AGENT_MODEL: "free", RM_ENV: "prod" }); } catch (err) { thrown = err; }
    expect(String((thrown as Error)?.message ?? "")).toMatch(/disqualified for acceptance/i);
  });

  test("a raw opencode/<id> override is refused on the standing stack (D22 rule 1)", () => {
    let thrown: unknown;
    try { run({ [ZEN_KEY_ENV]: FAKE_KEY, AGENT_MODEL: "opencode/deepseek-v4-flash", RM_ENV: "prod" }); } catch (err) { thrown = err; }
    expect(thrown).toBeInstanceOf(Error);
  });
});

describe("a NON-standing boot is left exactly as it was", () => {
  test("no credential is resolved, no env is touched, and AGENT_MODEL=free still runs", () => {
    const env: Record<string, string | undefined> = { AGENT_MODEL: "free", CI: "1" };
    const composeEnv = preflightInference({ standingStack: false, repoRoot: root, env, log: () => {} });
    expect(composeEnv).toEqual({});
    expect(env[ZEN_KEY_ENV]).toBeUndefined();
    // The local `bun run smoke` keeps every escape hatch D22-as-amended left open.
  });
});

// ── The delivery half, and the reason this module was wrong the first time ──
//
// The api container does NOT come up through the direct
// `docker compose` calls that read `dockerEnv`; it comes up through
// `stack.up()`, whose child env is `buildSpawnEnv()` — a fixed allowlist plus
// `buildComposeEnv()`. Writing `process.env` alone therefore delivered nothing
// for two of the three sources. These two tests are the ones that would have
// caught it, and they use the REAL builders, not a description of them.
describe("the resolved credential actually reaches the compose child", () => {
  const cfg = (extraComposeEnv: Record<string, string>): StackConfig => ({
    repoRoot: root,
    project: "rm_smoke_stack_0123456789",
    profile: "core",
    composeFiles: DEFAULT_COMPOSE_FILES,
    database: DEFAULT_STACK_DATABASE,
    credentials: { adminToken: "a", automationToken: "b", analyticsToken: "c" },
    environment: { class: "local", hash: "0123456789" },
    extraComposeEnv,
  });

  test("the process environment alone does NOT deliver it — the defect, pinned", () => {
    const spawnEnv = buildSpawnEnv(cfg({}), { PATH: "/usr/bin", [ZEN_KEY_ENV]: FAKE_KEY });
    expect(spawnEnv[ZEN_KEY_ENV]).toBeUndefined();
  });

  test("the returned fragment does deliver it, for a key from the process environment", () => {
    const { composeEnv } = run({ [ZEN_KEY_ENV]: FAKE_KEY, AGENT_MODEL: "deepseek", RM_ENV: "prod" });
    const spawnEnv = buildSpawnEnv(cfg(composeEnv), { PATH: "/usr/bin" });
    expect(spawnEnv[ZEN_KEY_ENV]).toBe(FAKE_KEY);
  });

  test("and for a key from ./.env.readonly, which compose's own interpolation never reads", () => {
    writeFileSync(join(root, READONLY_ENV_FILE), `${ZEN_KEY_ENV}=${FAKE_READONLY_KEY}\n`);
    const { composeEnv } = run({ AGENT_MODEL: "deepseek", RM_ENV: "prod" });
    const spawnEnv = buildSpawnEnv(cfg(composeEnv), { PATH: "/usr/bin" });
    expect(spawnEnv[ZEN_KEY_ENV]).toBe(FAKE_READONLY_KEY);
  });

  test("smoke-main.ts really merges the fragment into extraComposeEnv", () => {
    // The wiring, asserted at the one call site, so a future refactor that drops
    // the merge goes red here rather than on a staging host three weeks later.
    const source = Bun.file(join(import.meta.dir, "..", "..", "lib", "smoke-main.ts"));
    return source.text().then((text) => {
      expect(text).toContain("Object.assign(inferenceComposeEnv, preflightInferenceOrExit(");
      expect(text).toMatch(/extraComposeEnv: \{[^}]*\.\.\.inferenceComposeEnv[^}]*\}/);
    });
  });
});
