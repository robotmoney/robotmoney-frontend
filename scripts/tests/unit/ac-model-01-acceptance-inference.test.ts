// AC-MODEL-01, graded at the two places a model and a credential are chosen.
//
// THE RUN THIS FILE EXISTS BECAUSE OF. On 2026-09-13 the standing stage stack
// was found running the keyless free family (`nemotron-3-ultra-free`) with an EMPTY
// `OPENCODE_API_KEY`. Nothing failed. `resolveModelConfig()` accepted it
// silently — a keyless model needs no key, so the "paid model with no key"
// refusal never fired — and the swarm produced a hundred published sessions
// whose every judgement read `model_unconfigured` and whose analyst take count
// was zero. None of it was evidence, and nothing in the system said so.
//
// AC-MODEL-01 is the criterion written from that: every swarm agent —
// proposers/analysts and validators/judges alike — runs paid OpenCode Zen
// inference on exactly the registry's pinned model; no keyless/free-family
// model appears anywhere in an accepted run; the environment carries only the
// selector, never a raw id (D22 rule 1); and an absent or unfunded credential
// FAILS CLOSED rather than degrading.
//
// The raw-id refusal is scoped to staging and production ON PURPOSE: the raw
// `opencode/<id>` escape hatch exists because Zen ships models faster than this
// repo reviews them, and it stays legal on a development path. The keyless
// refusal is not scoped: the registry's `free` family was retired on 2026-11-28
// (D22), so the `free` selector is an unknown family and a keyless id reached
// through the escape hatch is refused on every path, development included.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_AGENT_MODEL } from "../../lib/model-registry.ts";
import { isAcceptancePath, resolveInferencePath, resolveModelConfig } from "../../lib/onboarding-eval.ts";
import { ENV_FILE, READONLY_ENV_FILE, resolveStackZenKey, ZEN_KEY_ENV } from "../../lib/opencode-key.ts";

const FUNDED = { [ZEN_KEY_ENV]: "sk-funded-test-value" };
// A keyless id no registry family lists, reachable only through the raw escape hatch.
const KEYLESS_RAW = "opencode/foo-free";

// ── Which environment is asking ─────────────────────────────────────────────

describe("resolveInferencePath — the caller states it, and no environment value decides it (issue 1326)", () => {
  test("the standing stack is staging", () => {
    // `--static-port` is what identifies the deployment a tunnel points at.
    expect(resolveInferencePath({ standingStack: true })).toBe("staging");
    expect(isAcceptancePath(resolveInferencePath({ standingStack: true }))).toBe(true);
  });

  test("a boot that says it is not the standing stack is development", () => {
    expect(resolveInferencePath({ standingStack: false })).toBe("development");
    expect(isAcceptancePath("development")).toBe(false);
  });

  // The strict default. A caller that states nothing — the api, a participant
  // container, a host driver handed no flag — is the acceptance path.
  test("a caller that states nothing is the acceptance path", () => {
    expect(resolveInferencePath()).toBe("production");
    expect(resolveInferencePath({})).toBe("production");
    expect(isAcceptancePath(resolveInferencePath({}))).toBe(true);
  });

  test("RM_ENV in the environment changes nothing: it is not read", () => {
    // The env record is still resolveModelConfig()'s source of AGENT_MODEL and
    // the key, so a stray RM_ENV there is the realistic shape of the old bug.
    for (const RM_ENV of ["smoke", "stage", "ephemeral", "prod", ""]) {
      expect(() => resolveModelConfig({ RM_ENV, AGENT_MODEL: KEYLESS_RAW })).toThrow(/keyless free-tier model/);
    }
  });

  test("a keyless model is refused when no path is stated — the default has teeth", () => {
    expect(() => resolveModelConfig({ AGENT_MODEL: KEYLESS_RAW })).toThrow(/keyless free-tier model/);
  });

  test("an explicit path wins over the standing-stack flag", () => {
    expect(resolveInferencePath({ path: "development", standingStack: true })).toBe("development");
    expect(resolveInferencePath({ path: "production", standingStack: false })).toBe("production");
  });
});

// ── The development path keeps the raw-id hatch, never a keyless model ─────

// A DEVELOPMENT BOOT SAYS SO. The raw-id escape hatch is exercised on the path
// an operator's own `bun smoke` boot states (`standingStack: false`).
describe("development keeps the raw-id escape hatch, and refuses every keyless model", () => {
  const DEV = { standingStack: false };
  const DEV_PATH = { path: "development" as const };

  test("the retired free selector is an unknown family on every path", () => {
    for (const opts of [DEV, DEV_PATH, {}]) {
      expect(() => resolveModelConfig({ ...FUNDED, AGENT_MODEL: "free" }, opts)).toThrow(/unknown model family/);
      expect(() => resolveModelConfig({ ...FUNDED, AGENT_MODEL: "free/nemotron-3-ultra" }, opts)).toThrow(/unknown model family/);
    }
  });

  test("a raw keyless id is refused on a development path, with no key and with a key", () => {
    expect(() => resolveModelConfig({ AGENT_MODEL: KEYLESS_RAW }, DEV_PATH)).toThrow(/keyless/);
    expect(() => resolveModelConfig({ ...FUNDED, AGENT_MODEL: KEYLESS_RAW }, DEV_PATH)).toThrow(/keyless/);
    expect(() => resolveModelConfig({ AGENT_MODEL: "opencode/big-pickle" }, DEV)).toThrow(/keyless/);
  });

  test("the raw-id escape hatch still goes straight through for a paid id", () => {
    const raw = "opencode/some-new-paid-model";
    const cfg = resolveModelConfig({ ...FUNDED, AGENT_MODEL: raw }, DEV);
    expect(cfg.model).toBe(raw);
    expect(cfg.keyless).toBe(false);
  });

  test("a paid model with no key still fails with the long-standing message", () => {
    expect(() => resolveModelConfig({ AGENT_MODEL: "deepseek" }, DEV)).toThrow(/paid OpenCode Zen model/);
  });
});

// ── Staging and production refuse all three ─────────────────────────────────

describe("AC-MODEL-01: staging and production refuse a keyless model", () => {
  for (const path of ["staging", "production"] as const) {
    test(`${path} refuses a keyless model that arrives as a raw id`, () => {
      expect(() => resolveModelConfig({ ...FUNDED, AGENT_MODEL: KEYLESS_RAW }, { path }))
        .toThrow(/disqualified for acceptance/);
      expect(() => resolveModelConfig({ ...FUNDED, AGENT_MODEL: "opencode/nemotron-3-ultra-free" }, { path }))
        .toThrow(/disqualified for acceptance/);
    });
  }

  test("the exact staging misconfiguration of 2026-09-13 is refused, credential and all", () => {
    // The free family's id + an empty key: previously accepted in silence. The
    // selector that produced it is now an unknown family, so the raw id is the
    // only way left to name it.
    expect(() => resolveModelConfig({ AGENT_MODEL: "opencode/nemotron-3-ultra-free", [ZEN_KEY_ENV]: "" }, { path: "staging" }))
      .toThrow(/disqualified for acceptance/);
    expect(() => resolveModelConfig({ AGENT_MODEL: "free", [ZEN_KEY_ENV]: "" }, { path: "staging" }))
      .toThrow(/unknown model family/);
    // And through the standing-stack signal rather than an explicit path, which
    // is how the real boot reaches it.
    expect(() => resolveModelConfig({ AGENT_MODEL: KEYLESS_RAW }, { standingStack: true }))
      .toThrow(/disqualified for acceptance/);
  });
});

describe("AC-MODEL-01 / D22 rule 1: staging and production refuse a raw-id override", () => {
  for (const path of ["staging", "production"] as const) {
    test(`${path} refuses a raw opencode/<id> AGENT_MODEL`, () => {
      // The id below is the registry's OWN default, so this is not refused for
      // naming a bad model — it is refused for naming one at all.
      expect(() => resolveModelConfig({ ...FUNDED, AGENT_MODEL: DEFAULT_AGENT_MODEL }, { path }))
        .toThrow(/raw model id/);
    });
  }

  test("the registry SELECTOR resolving to that same id is accepted", () => {
    // Proves the refusal is about the FORM of the signal, not the model: same
    // resolved id, one reviewable selector instead of an ambient export.
    const cfg = resolveModelConfig({ ...FUNDED, AGENT_MODEL: "deepseek" }, { path: "production" });
    expect(cfg.model).toBe(DEFAULT_AGENT_MODEL);
    expect(cfg.keyless).toBe(false);
    expect(cfg.apiKeyEnv).toBe(ZEN_KEY_ENV);
  });

  test("an unset AGENT_MODEL is fine — the registry default is not a raw override", () => {
    expect(resolveModelConfig(FUNDED, { path: "staging" }).model).toBe(DEFAULT_AGENT_MODEL);
  });
});

describe("AC-MODEL-01: an absent credential fails closed, it does not substitute", () => {
  for (const path of ["staging", "production"] as const) {
    test(`${path} refuses a funded model with no key`, () => {
      expect(() => resolveModelConfig({ AGENT_MODEL: "deepseek" }, { path })).toThrow(/fails closed/);
    });

    test(`${path} treats an EMPTY key exactly as an absent one`, () => {
      expect(() => resolveModelConfig({ AGENT_MODEL: "deepseek", [ZEN_KEY_ENV]: "   " }, { path }))
        .toThrow(/fails closed/);
    });

    test(`${path} never answers a missing credential with a keyless model`, () => {
      // The whole failure mode in one assertion: no return value at all, so
      // there is nothing for a caller to mistake for a working configuration.
      let cfg: unknown;
      try { cfg = resolveModelConfig({ AGENT_MODEL: "deepseek" }, { path }); } catch { /* expected */ }
      expect(cfg).toBeUndefined();
    });
  }
});

// ── Where the standing stack finds the credential ───────────────────────────

describe("resolveStackZenKey: the standing stack reads .env / .env.readonly, or refuses by name", () => {
  const roots: string[] = [];
  const root = (files: Record<string, string>): string => {
    const dir = mkdtempSync(join(tmpdir(), "ac-model-01-"));
    roots.push(dir);
    mkdirSync(dir, { recursive: true });
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
    return dir;
  };
  const cleanup = () => { for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true }); };

  test("the process environment wins — that is how CI and a one-off shell supply it", () => {
    const dir = root({ [ENV_FILE]: `${ZEN_KEY_ENV}=from-dot-env\n` });
    const got = resolveStackZenKey(dir, { [ZEN_KEY_ENV]: "from-process" });
    expect(got).toEqual({ key: "from-process", source: "process environment" });
    cleanup();
  });

  test("`.env` is read — the file an operator correcting a stage host actually edits", () => {
    // This is the gap the 2026-09-13 remediation hit: `.env` was corrected on
    // the host and the boot still could not see the key, because only
    // smoke-twin-rehearsal.ts read a file and it reads .env.readonly alone.
    const dir = root({ [ENV_FILE]: `RM_ENV=prod\n${ZEN_KEY_ENV}="sk-in-dot-env"\n` });
    expect(resolveStackZenKey(dir, {})).toEqual({ key: "sk-in-dot-env", source: `./${ENV_FILE}` });
    cleanup();
  });

  test("`.env.readonly` is the fallback, so the smoke-twin family's file still works", () => {
    const dir = root({ [READONLY_ENV_FILE]: `${ZEN_KEY_ENV}=sk-in-readonly\n` });
    expect(resolveStackZenKey(dir, {})).toEqual({ key: "sk-in-readonly", source: `./${READONLY_ENV_FILE}` });
    cleanup();
  });

  test("`.env` wins over `.env.readonly` when both carry one", () => {
    const dir = root({
      [ENV_FILE]: `${ZEN_KEY_ENV}=sk-in-dot-env\n`,
      [READONLY_ENV_FILE]: `${ZEN_KEY_ENV}=sk-in-readonly\n`,
    });
    expect(resolveStackZenKey(dir, {})).toEqual({ key: "sk-in-dot-env", source: `./${ENV_FILE}` });
    cleanup();
  });

  test("an empty value is not a credential", () => {
    const dir = root({ [ENV_FILE]: `${ZEN_KEY_ENV}=\n` });
    const got = resolveStackZenKey(dir, { [ZEN_KEY_ENV]: "  " });
    expect("error" in got).toBe(true);
    cleanup();
  });

  test("with none of the three, the refusal NAMES all three and offers no keyless workaround", () => {
    const dir = root({});
    const got = resolveStackZenKey(dir, {});
    expect("error" in got).toBe(true);
    const message = (got as { error: string }).error;
    expect(message).toContain(ZEN_KEY_ENV);
    expect(message).toContain(`./${ENV_FILE}`);
    expect(message).toContain(`./${READONLY_ENV_FILE}`);
    expect(message).toContain("no keyless fallback");
    expect(message).not.toContain("AGENT_MODEL=free");
    cleanup();
  });

  test("no credential value is ever part of the refusal text", () => {
    const dir = root({ [ENV_FILE]: "DATABASE_URL=postgres://u:p@h/db\n" });
    const got = resolveStackZenKey(dir, {});
    expect((got as { error: string }).error).not.toContain("postgres://");
    cleanup();
  });
});
