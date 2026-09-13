// The judge's model allowlist lives in backend/, the pinned registry lives in
// scripts/. This test is the only thing that keeps them equal.
//
// WHY THE DUPLICATION EXISTS AT ALL. backend/Dockerfile copies `backend/` and
// `contract/` and nothing else (docker-compose.yml builds the api and every
// worker lane from it), so an `import` of scripts/lib/model-registry.ts inside
// backend/src would type-check on this host and then fail at container start —
// the worst possible place to discover it. The ids are therefore written twice,
// and this test is the price: it reads BOTH files and fails when they disagree,
// so the copy cannot rot into a second, older opinion about which models are
// keyless.
//
// It also pins the ACCEPTANCE model itself: AC-MODEL-01 names exactly
// `opencode/deepseek-v4-flash`, the registry's default resolves to it, and the
// judge's `PINNED_JUDGE_MODEL` is that same id with the `opencode/` prefix
// stripped — the wire form Zen's REST endpoint accepts (the prefixed form 401s,
// which is what commit a8fcbf26 exists for).
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_AGENT_MODEL,
  isKeylessModel,
  MODEL_FAMILIES,
  ZEN_PREFIX,
} from "../../lib/model-registry.ts";
import {
  assertJudgeModelAllowed,
  FREE_FAMILY_JUDGE_MODELS,
  isAcceptanceJudgeEnv,
  isKeylessJudgeModel,
  PINNED_JUDGE_MODEL,
} from "../../../backend/src/swarm/judge-model-policy.ts";

describe("the judge's model policy agrees with the pinned registry", () => {
  test("PINNED_JUDGE_MODEL is the registry's default, in wire form", () => {
    expect(DEFAULT_AGENT_MODEL).toBe(`${ZEN_PREFIX}deepseek-v4-flash`);
    expect(PINNED_JUDGE_MODEL).toBe(DEFAULT_AGENT_MODEL.slice(ZEN_PREFIX.length));
    // And the wire form is NOT the prefixed one — the defect a8fcbf26 fixed.
    expect(PINNED_JUDGE_MODEL.startsWith(ZEN_PREFIX)).toBe(false);
  });

  test("the backend's free-family list is exactly the registry's keyless ids", () => {
    const registryKeyless = Object.values(MODEL_FAMILIES)
      .filter((f) => f.keyless)
      .flatMap((f) => Object.values(f.models))
      .sort();
    expect([...FREE_FAMILY_JUDGE_MODELS].sort()).toEqual(registryKeyless);
    // Non-vacuous, and specifically covering the suffix-less one.
    expect(registryKeyless.length).toBeGreaterThan(1);
    expect(registryKeyless).toContain("big-pickle");
  });

  test("both keyless predicates answer identically for every registry id", () => {
    const everyId = Object.values(MODEL_FAMILIES).flatMap((f) => Object.values(f.models));
    expect(everyId.length).toBeGreaterThan(20);
    for (const id of everyId) {
      expect(isKeylessJudgeModel(id), id).toBe(isKeylessModel(id));
      expect(isKeylessJudgeModel(`${ZEN_PREFIX}${id}`), `${ZEN_PREFIX}${id}`).toBe(isKeylessModel(id));
    }
  });
});

describe("assertJudgeModelAllowed refuses what AC-MODEL-01 disqualifies", () => {
  const prod = { RM_ENV: "prod" };
  const dev = { RM_ENV: "ephemeral" };

  test("the free family is refused on EVERY path, acceptance or not", () => {
    for (const id of FREE_FAMILY_JUDGE_MODELS) {
      expect(() => assertJudgeModelAllowed(id, prod)).toThrow(/keyless free family|DISQUALIFIED/);
      expect(() => assertJudgeModelAllowed(id, dev)).toThrow(/keyless free family|DISQUALIFIED/);
      expect(() => assertJudgeModelAllowed(`${ZEN_PREFIX}${id}`, dev)).toThrow(/DISQUALIFIED/);
    }
  });

  test("an acceptance path takes the pinned model and nothing else", () => {
    expect(() => assertJudgeModelAllowed(PINNED_JUDGE_MODEL, prod)).not.toThrow();
    expect(() => assertJudgeModelAllowed("test/judge-model", prod)).toThrow(/not the pinned acceptance model/);
    expect(() => assertJudgeModelAllowed("deepseek-v4-pro", prod)).toThrow(/not the pinned acceptance model/);
    // The PREFIXED form is not the wire id, and is refused with it.
    expect(() => assertJudgeModelAllowed(`${ZEN_PREFIX}${PINNED_JUDGE_MODEL}`, prod)).toThrow(/not the pinned acceptance model/);
  });

  test("development keeps its stub ids — its judgements are not evidence", () => {
    expect(() => assertJudgeModelAllowed("test/judge-model", dev)).not.toThrow();
    expect(() => assertJudgeModelAllowed("stub-judge", { RM_ENV: "smoke" })).not.toThrow();
  });

  test("an unset RM_ENV is an acceptance path — the fail-closed default", () => {
    // backend/src/config.ts defaults RM_ENV to "prod" for exactly this reason:
    // an environment that forgot to say what it is must get the strict rules.
    expect(isAcceptanceJudgeEnv({})).toBe(true);
    expect(() => assertJudgeModelAllowed("test/judge-model", {})).toThrow(/not the pinned acceptance model/);
  });
});
