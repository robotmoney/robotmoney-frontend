// Unit specification for scripts/lib/smoke-env-policy.ts — the `RM_ENV` policy
// value (§4.1), the full policy × identity matrix (§4.3), and the
// `--allow-insecure` / `--schedules-off` refusals (§4.4) of
// docs/technical/smoke-production-spec.md.
//
// TDD RED PHASE (issue #1026, W1 step 2). Every function under test currently
// throws `NOT IMPLEMENTED`, so every test here fails today BY DESIGN. Each one
// is written as the requirement it pins, against the behaviour the module must
// have once W1.1 lands — never against the stub.
//
// WHY THE MATRIX IS TESTED ROW BY ROW. §4.3 is thirteen rows and the dangerous
// ones are the refusals. A matrix implemented as "allow the good cases, fall
// through otherwise" passes a spot check and fails the one row nobody wrote. So
// every cell of (prod | stage | unset | other) × (remote | local-blank |
// local-dump | local-volume) × (production | rehearsal | absent | unreadable)
// that the spec names is asserted here, including the two rows whose reasoning
// the spec states in prose and which therefore must survive into the refusal
// text an operator reads.
//
// Acceptance gates served (spec §10, W1):
//   - "Unset `RM_ENV` against a remote target refuses."
//   - "Overlay-free stage boots with the real scheduler" (the §4.4 half: the
//     weakening flags exist and are refused under `prod`).
import { describe, expect, test } from "bun:test";
import {
  describePolicyVerdict,
  refuseWeakeningFlagsOnProd,
  resolveDeploymentPolicy,
  resolveRmEnv,
  type PolicyInput,
  type PolicyVerdict,
  type TargetConnection,
} from "../../lib/smoke-env-policy.ts";
import type { DeploymentIdentityKind } from "../../lib/smoke-identity.ts";

/** Every identity value the matrix distinguishes, including the two non-kinds. */
type Identity = DeploymentIdentityKind | null | "unreadable";

const LOCAL_MODES: readonly TargetConnection[] = ["local-blank", "local-dump", "local-volume"];
const ALL_IDENTITIES: readonly Identity[] = ["production", "rehearsal", null, "unreadable"];

function input(rmEnv: string | undefined, connection: TargetConnection, identity: Identity): PolicyInput {
  return { rmEnv, connection, identity };
}

/** Narrow to the refuse arm, failing the test with the allow arm's contents if it is not one. */
function refusal(verdict: PolicyVerdict): string {
  expect(verdict.allow).toBe(false);
  if (verdict.allow) throw new Error("expected a refusal");
  return verdict.reason;
}

describe("resolveRmEnv — §4.1, RM_ENV is policy only and has exactly two spellings", () => {
  test("`prod` resolves to the prod policy and reports that it was set explicitly", () => {
    expect(resolveRmEnv({ RM_ENV: "prod" })).toEqual({ ok: true, env: "prod", source: "explicit" });
  });

  test("`stage` resolves to the stage policy and reports that it was set explicitly", () => {
    expect(resolveRmEnv({ RM_ENV: "stage" })).toEqual({ ok: true, env: "stage", source: "explicit" });
  });

  test("an absent RM_ENV resolves to stage but reports source `unset`, because §4.3 treats the two differently", () => {
    expect(resolveRmEnv({})).toEqual({ ok: true, env: "stage", source: "unset" });
  });

  test("an empty RM_ENV is an absence, not an unknown value — `RM_ENV=` in a profile must not send the operator hunting a typo", () => {
    expect(resolveRmEnv({ RM_ENV: "" })).toEqual({ ok: true, env: "stage", source: "unset" });
  });

  test("a whitespace-only RM_ENV is an absence for the same reason", () => {
    expect(resolveRmEnv({ RM_ENV: "   " })).toEqual({ ok: true, env: "stage", source: "unset" });
  });

  test("the retired `smoke` value refuses and names both legal values, rather than downgrading to stage", () => {
    const result = resolveRmEnv({ RM_ENV: "smoke" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.reason).toContain("smoke");
    expect(result.reason).toContain("prod");
    expect(result.reason).toContain("stage");
  });

  test("the retired `ephemeral` value refuses — config.ts's VALID_ENVS still accepts it and this module must not", () => {
    const result = resolveRmEnv({ RM_ENV: "ephemeral" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.reason).toContain("ephemeral");
  });

  test("the comparison is case-sensitive: `PROD` is an unknown value, never the prod policy", () => {
    const result = resolveRmEnv({ RM_ENV: "PROD" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.reason).toContain("PROD");
  });

  test("a value with surrounding whitespace is not silently trimmed into a legal value", () => {
    expect(resolveRmEnv({ RM_ENV: " prod " }).ok).toBe(false);
  });
});

describe("resolveDeploymentPolicy — §4.3 row: prod × remote × production", () => {
  test("arms the production guards and emits no warning", () => {
    const verdict = resolveDeploymentPolicy(input("prod", "remote", "production"));
    expect(verdict).toEqual({ allow: true, env: "prod", posture: "production", warnings: [] });
  });
});

describe("resolveDeploymentPolicy — §4.3 row: prod × remote × anything else refuses", () => {
  for (const identity of ["rehearsal", null, "unreadable"] as const) {
    test(`refuses against identity ${String(identity)}, naming the policy, the connection and what the target says`, () => {
      const reason = refusal(resolveDeploymentPolicy(input("prod", "remote", identity)));
      expect(reason).toContain("prod");
      expect(reason).toContain("remote");
      expect(reason.toLowerCase()).toContain(identity === null ? "no identity" : String(identity));
    });
  }

  test("an unreadable identity table is not evidence of production — absence of evidence is never evidence", () => {
    const reason = refusal(resolveDeploymentPolicy(input("prod", "remote", "unreadable")));
    expect(reason.toLowerCase()).toContain("unreadable");
  });
});

describe("resolveDeploymentPolicy — §4.3 row: prod × --local × any refuses", () => {
  for (const connection of LOCAL_MODES) {
    for (const identity of ALL_IDENTITIES) {
      test(`${connection} with identity ${String(identity)} refuses: production never runs on a database smoke owns`, () => {
        const reason = refusal(resolveDeploymentPolicy(input("prod", connection, identity)));
        expect(reason).toContain("prod");
        expect(reason).toContain(connection);
      });
    }
  }
});

describe("resolveDeploymentPolicy — §4.3 row: stage × remote × rehearsal", () => {
  test("allows with the stage posture and no warning", () => {
    const verdict = resolveDeploymentPolicy(input("stage", "remote", "rehearsal"));
    expect(verdict).toEqual({ allow: true, env: "stage", posture: "stage", warnings: [] });
  });
});

describe("resolveDeploymentPolicy — §4.3 row: stage × remote × anything else refuses", () => {
  for (const identity of ["production", null, "unreadable"] as const) {
    test(`refuses against identity ${String(identity)}`, () => {
      const reason = refusal(resolveDeploymentPolicy(input("stage", "remote", identity)));
      expect(reason).toContain("stage");
      expect(reason).toContain("remote");
    });
  }

  test("the refusal carries the spec's own reasoning: stage policy never touches production data", () => {
    const reason = refusal(resolveDeploymentPolicy(input("stage", "remote", "production")));
    expect(reason.toLowerCase()).toContain("never touches production data");
  });

  test("no flag relaxes this row — `--allow-insecure` is named in the spec sentence and cannot be an escape", () => {
    const reason = refusal(resolveDeploymentPolicy(input("stage", "remote", "production")));
    expect(reason).toContain("--allow-insecure");
  });
});

describe("resolveDeploymentPolicy — §4.3 row: stage × --local blank/dump", () => {
  for (const connection of ["local-blank", "local-dump"] as const) {
    test(`${connection} allows as stage: the identity row is the one smoke is about to write as rehearsal`, () => {
      const verdict = resolveDeploymentPolicy(input("stage", connection, "rehearsal"));
      expect(verdict).toEqual({ allow: true, env: "stage", posture: "stage", warnings: [] });
    });
  }
});

describe("resolveDeploymentPolicy — §4.3 row: stage × --local volume", () => {
  test("a volume whose identity row says rehearsal allows as stage", () => {
    const verdict = resolveDeploymentPolicy(input("stage", "local-volume", "rehearsal"));
    expect(verdict).toEqual({ allow: true, env: "stage", posture: "stage", warnings: [] });
  });

  for (const identity of ["production", null, "unreadable"] as const) {
    test(`a volume whose identity is ${String(identity)} refuses`, () => {
      const reason = refusal(resolveDeploymentPolicy(input("stage", "local-volume", identity)));
      expect(reason).toContain("local-volume");
    });
  }

  test("the refusal carries the spec's reasoning: a reattached volume gets no weaker policy than a remote", () => {
    const reason = refusal(resolveDeploymentPolicy(input("stage", "local-volume", "production")));
    expect(reason.toLowerCase()).toContain("no weaker policy than a remote");
  });
});

describe("resolveDeploymentPolicy — §4.3 row: unset × remote refuses (the §10 W1 gate)", () => {
  for (const identity of ALL_IDENTITIES) {
    test(`an unset RM_ENV against a remote target refuses even when the identity says ${String(identity)}`, () => {
      const reason = refusal(resolveDeploymentPolicy(input(undefined, "remote", identity)));
      expect(reason).toContain("RM_ENV");
      expect(reason).toContain("remote");
    });
  }

  test("an empty RM_ENV against a remote target refuses the same way an absent one does", () => {
    expect(resolveDeploymentPolicy(input("", "remote", "rehearsal")).allow).toBe(false);
  });

  test("the unset-remote refusal is NOT the unknown-value refusal — it must not claim RM_ENV held a bad value", () => {
    const reason = refusal(resolveDeploymentPolicy(input(undefined, "remote", "rehearsal")));
    expect(reason.toLowerCase()).toContain("not set");
  });
});

describe("resolveDeploymentPolicy — §4.3 row: unset × --local warns and proceeds as stage", () => {
  for (const connection of LOCAL_MODES) {
    test(`${connection} allows as stage with the spec's verbatim warning`, () => {
      const verdict = resolveDeploymentPolicy(input(undefined, connection, "rehearsal"));
      expect(verdict).toEqual({
        allow: true,
        env: "stage",
        posture: "stage",
        warnings: ["RM_ENV not set, running as stage"],
      });
    });
  }

  test("unset × --local volume still requires the rehearsal row — the warning does not relax the volume row", () => {
    expect(resolveDeploymentPolicy(input(undefined, "local-volume", "production")).allow).toBe(false);
  });
});

describe("resolveDeploymentPolicy — §4.3 row: other × any × any refuses", () => {
  for (const connection of ["remote", ...LOCAL_MODES] as const) {
    test(`an unknown RM_ENV refuses on ${connection}, and is not downgraded to stage`, () => {
      const reason = refusal(resolveDeploymentPolicy(input("smoke", connection, "rehearsal")));
      expect(reason).toContain("smoke");
      expect(reason).toContain("prod");
      expect(reason).toContain("stage");
    });
  }
});

describe("refuseWeakeningFlagsOnProd — §4.4, the former overlay knobs are refusals under prod", () => {
  test("`--allow-insecure` under prod refuses, naming the flag", () => {
    const result = refuseWeakeningFlagsOnProd("prod", { allowInsecure: true, schedulesOff: false });
    expect(result.allow).toBe(false);
    if (result.allow) throw new Error("expected a refusal");
    expect(result.reason).toContain("--allow-insecure");
  });

  test("`--schedules-off` under prod refuses, naming the flag", () => {
    const result = refuseWeakeningFlagsOnProd("prod", { allowInsecure: false, schedulesOff: true });
    expect(result.allow).toBe(false);
    if (result.allow) throw new Error("expected a refusal");
    expect(result.reason).toContain("--schedules-off");
  });

  test("the refusal states that parity with production is a tested property, not an overlay", () => {
    const result = refuseWeakeningFlagsOnProd("prod", { allowInsecure: true, schedulesOff: false });
    expect(result.allow).toBe(false);
    if (result.allow) throw new Error("expected a refusal");
    expect(result.reason.toLowerCase()).toContain("parity");
  });

  test("both flags together under prod refuse and the reason names both", () => {
    const result = refuseWeakeningFlagsOnProd("prod", { allowInsecure: true, schedulesOff: true });
    expect(result.allow).toBe(false);
    if (result.allow) throw new Error("expected a refusal");
    expect(result.reason).toContain("--allow-insecure");
    expect(result.reason).toContain("--schedules-off");
  });

  test("neither flag under prod allows — a production boot is not weakened by default", () => {
    expect(refuseWeakeningFlagsOnProd("prod", { allowInsecure: false, schedulesOff: false })).toEqual({ allow: true });
  });

  test("both flags under stage allow: stage is where the weakening is legitimate", () => {
    expect(refuseWeakeningFlagsOnProd("stage", { allowInsecure: true, schedulesOff: true })).toEqual({ allow: true });
  });

  test("the check does not consult the target: the flags are refused on prod whatever the database says", () => {
    expect(refuseWeakeningFlagsOnProd("prod", { allowInsecure: true, schedulesOff: false }).allow).toBe(false);
    expect(refuseWeakeningFlagsOnProd("stage", { allowInsecure: true, schedulesOff: false }).allow).toBe(true);
  });
});

describe("describePolicyVerdict — §1.2, the same four facts in the plan and in the refusal", () => {
  const allowed = input("prod", "remote", "production");

  test("an allow renders the declared policy, the connection, the target's own answer and the resulting posture", () => {
    const verdict = resolveDeploymentPolicy(allowed);
    const text = describePolicyVerdict(allowed, verdict);
    expect(text).toContain("prod");
    expect(text).toContain("remote");
    expect(text).toContain("production");
  });

  test("a refusal renders the same four facts, so an operator can diff it against yesterday's plan", () => {
    const refused = input("stage", "remote", "production");
    const text = describePolicyVerdict(refused, resolveDeploymentPolicy(refused));
    expect(text).toContain("stage");
    expect(text).toContain("remote");
    expect(text).toContain("production");
  });

  test("the rendering is deterministic — the plan's line and the refusal's line are comparable only if it is", () => {
    const verdict = resolveDeploymentPolicy(allowed);
    expect(describePolicyVerdict(allowed, verdict)).toBe(describePolicyVerdict(allowed, verdict));
  });

  test("one fact per line, so a single changed fact is a single changed line", () => {
    const verdict = resolveDeploymentPolicy(allowed);
    const lines = describePolicyVerdict(allowed, verdict).split("\n").filter((l) => l.trim().length > 0);
    expect(lines.length).toBeGreaterThanOrEqual(4);
  });

  test("the plan is redacted: no connection string ever reaches this line", () => {
    const verdict = resolveDeploymentPolicy(allowed);
    expect(describePolicyVerdict(allowed, verdict)).not.toContain("postgres://");
  });
});
