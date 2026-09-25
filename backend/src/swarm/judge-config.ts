// The consensus judge's runtime switch: `swarm_judge_config`, one row.
//
// WHAT THIS FILE IS. The one module that writes `swarm_judge_config`, and the
// one module the admin route reaches to do it. It moved here out of the
// retired `judge-session.ts` (issue #1026, D53 point 4) when the inline judge
// was deleted: the switch outlived the backend judge it used to steer, because
// the scheduler still captures the mode at turnover (system-scheduler-spec.md
// §4.4) and the participant path still reads the third-party flag.
//
// A DATABASE ROW, NOT AN ENVIRONMENT VARIABLE. An operator must be able to take
// the judge off published sessions without restarting the API or the
// scheduler, so the switch is a row behind an audited admin POST.
//
// EVERY STATEMENT IS A REGISTERED QUERY (smoke-production-spec.md §7.1). And
// the two that WRITE declare `src/api/routes/swarm-admin` as their only caller:
// §6.2 says "nothing but the admin route writes `swarm_judge_config`", and the
// declaration is where that claim is stated, reviewed and enumerated —
// `backend/tests/swarm-judge-config-registry.test.ts` asserts it from
// `registeredSites()`, not from a grep.
//
// TWO MODES (D48, and D53 point 1). `off` and `enforce`. The `shadow` mode's
// replay prerequisite was waived, so no write path here accepts it; a row still
// holding a legacy `shadow` reads as `off` — the mode `currentJudgeMode()` in
// domain.ts already captures for it — and the next write through this module
// stores `off` in its place. The CHECK that forbids `shadow` in the column is a
// migration of its own.
import { sql } from "../db/client.ts";
import { on, registerQuery } from "../db/registry.ts";
import { assertJudgeModelAllowed } from "./judge-model-policy.ts";
import type { JudgeMode } from "./domain.ts";

export type { JudgeMode };

/** The modes a write may set. Exported so the admin route validates against the same list. */
export const JUDGE_MODES: readonly JudgeMode[] = Object.freeze(["off", "enforce"]);

export interface JudgeConfig {
  mode: JudgeMode;
  minTakes: number;
  /** The model the judge participant is expected to run, or null — see migration 0039 on why this is a row. */
  model: string | null;
  /**
   * Issue #796, re-keyed by D52. May a judge whose member `operator` is not
   * `robotmoney` have its judgement accepted? Off by default and independent
   * of `mode`. The in-house judge (operator `robotmoney`) is accepted whatever
   * this says (smoke-production-spec.md §6.2, "Third-party gate"): the rollout
   * puts the in-house judge live FIRST, so it cannot depend on the flag that
   * holds third parties back.
   */
  thirdPartyEnabled: boolean;
  updatedAt: string | null;
}

const DEFAULT_CONFIG: JudgeConfig = { mode: "off", minTakes: 3, model: null, thirdPartyEnabled: false, updatedAt: null };

/** The only module that may cause a write to `swarm_judge_config` (§6.2). */
const ADMIN_ROUTE = "src/api/routes/swarm-admin";

const readConfig = registerQuery({
  role: "rm_app",
  object: "swarm_judge_config",
  privileges: ["SELECT"],
  site: "src/swarm/judge-config:getJudgeConfig",
  purpose: "Read the judge switch for the admin surface, for the pair validation of a write, and for the replay audit.",
  callers: [ADMIN_ROUTE, "scripts/swarm-judge-replay"],
  probe: {
    statement: "SELECT mode, min_takes, model, third_party_enabled, updated_at FROM swarm_judge_config WHERE id = 1",
  },
});

const updateConfig = registerQuery({
  role: "rm_app",
  object: "swarm_judge_config",
  // SELECT as well: the SET list reads the row it replaces (COALESCE(..., mode),
  // the policy stamp's IS DISTINCT FROM), and the WHERE and RETURNING read it
  // too. Postgres checks each of those as a read of the column.
  privileges: ["UPDATE", "SELECT"],
  site: "src/swarm/judge-config:setJudgeConfig.update",
  purpose: "Patch the judge switch (mode, min_takes, model, third-party flag) on behalf of an audited admin write.",
  callers: [ADMIN_ROUTE],
  probe: {
    statement: `UPDATE swarm_judge_config SET
        mode = CASE WHEN COALESCE($1, mode) = 'enforce' THEN 'enforce' ELSE 'off' END,
        min_takes = COALESCE($2::integer, min_takes),
        model = COALESCE($3, model),
        third_party_enabled = COALESCE($4::boolean, third_party_enabled),
        updated_at = now(),
        policy_updated_at = CASE WHEN min_takes IS DISTINCT FROM COALESCE($2::integer, min_takes)
                                 THEN now() ELSE policy_updated_at END
      WHERE id = 1
      RETURNING id`,
    params: ["off", null, null, null],
  },
});

const insertConfig = registerQuery({
  role: "rm_app",
  object: "swarm_judge_config",
  // SELECT as well: `ON CONFLICT (id)` reads the arbiter column, which
  // Postgres checks as a read (tests/db-registry-execution.test.ts found the
  // INSERT-only declaration refused with 42501 for a role holding just that).
  privileges: ["INSERT", "SELECT"],
  site: "src/swarm/judge-config:setJudgeConfig.insert",
  purpose: "Create the one judge-switch row on an empty table, for an audited admin write.",
  callers: [ADMIN_ROUTE],
  probe: {
    statement: `INSERT INTO swarm_judge_config (id, mode, min_takes, model, third_party_enabled, updated_at, policy_updated_at)
      VALUES (1, $1, $2::integer, $3, $4::boolean, now(), now())
      ON CONFLICT (id) DO NOTHING`,
    params: ["off", 3, null, false],
  },
});

export async function getJudgeConfig(): Promise<JudgeConfig> {
  const [row] = await on(sql, readConfig)<{
    mode: string; min_takes: number; model: string | null; third_party_enabled: boolean; updated_at: Date | string;
  }>`SELECT mode, min_takes, model, third_party_enabled, updated_at FROM swarm_judge_config WHERE id = 1`;
  if (!row) return DEFAULT_CONFIG;
  return {
    // A legacy `shadow` reads as `off`: that is the mode a session closing now
    // captures for it (domain.ts currentJudgeMode), so the admin surface and the
    // lifecycle report the same thing.
    mode: row.mode === "enforce" ? "enforce" : "off",
    minTakes: Number(row.min_takes),
    model: row.model == null || String(row.model).trim() === "" ? null : String(row.model),
    thirdPartyEnabled: Boolean(row.third_party_enabled),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
  };
}

/**
 * The `opencode/` half of a `provider/model` selector, which this column must
 * NOT carry (issue #969).
 *
 * The judge participant posts `swarm_judge_config.model`'s value as the
 * `model` field of an OpenAI-compatible request, and Zen's REST endpoint
 * answers the prefixed selector with
 *
 *   401 {"type":"error","error":{"type":"ModelError",
 *        "message":"Model opencode/deepseek-v4-flash is not supported"}}
 *
 * while the bare `deepseek-v4-flash` returns 200. (Probed directly against
 * https://opencode.ai/zen/v1 on 2026-09-13.) The participant classifies that
 * answer as `model_not_supported` and refuses (judge-reasons.ts), so a prefix
 * nobody noticed would leave every session `no_consensus` rather than publish
 * anything false — but it is cheaper to store the id the wire takes.
 */
const JUDGE_MODEL_PROVIDER_PREFIX = "opencode/";

/**
 * NORMALISE AT THE WRITE BOUNDARY, so the stored column always equals the wire
 * id. An operator may paste either form; exactly one is ever stored. This is
 * not a model substitution: it is the same model, addressed the way the
 * endpoint addresses it.
 */
export function normalizeJudgeModel(model: string): string {
  const trimmed = model.trim();
  return trimmed.startsWith(JUDGE_MODEL_PROVIDER_PREFIX)
    ? trimmed.slice(JUDGE_MODEL_PROVIDER_PREFIX.length).trim()
    : trimmed;
}

export async function setJudgeConfig(
  patch: { mode?: JudgeMode; minTakes?: number; model?: string | null; thirdPartyEnabled?: boolean },
): Promise<JudgeConfig> {
  // Before every model check below, so "non-empty" is asserted of the value
  // that will actually be STORED — a bare `opencode/` normalises to the empty
  // string and must be refused like any other blank.
  if (typeof patch.model === "string") patch = { ...patch, model: normalizeJudgeModel(patch.model) };
  // `shadow` is refused here by name (D48 as waived by D53): the value the
  // caller sent is not one this system writes any more.
  if (patch.mode !== undefined && !JUDGE_MODES.includes(patch.mode)) {
    throw new Error(`invalid judge mode "${patch.mode}" — expected off | enforce`);
  }
  if (patch.minTakes !== undefined && (!Number.isInteger(patch.minTakes) || patch.minTakes < 1)) {
    throw new Error(`invalid judge minTakes "${patch.minTakes}" — expected a positive integer`);
  }
  if (patch.model !== undefined && patch.model !== null && (typeof patch.model !== "string" || patch.model.trim() === "" || patch.model.length > 200)) {
    throw new Error("invalid judge model — expected a non-empty model id, or null to unset it");
  }
  // WHICH model, not merely SOME model (AC-MODEL-01). The free family is
  // refused everywhere; on an acceptance path only the pinned model is
  // accepted. See judge-model-policy.ts for why the two rules differ in
  // strength.
  if (patch.model !== undefined && patch.model !== null && typeof patch.model === "string") {
    assertJudgeModelAllowed(patch.model);
  }
  if (patch.thirdPartyEnabled !== undefined && typeof patch.thirdPartyEnabled !== "boolean") {
    throw new Error("invalid judge thirdPartyEnabled — expected a boolean");
  }
  // A JUDGE THAT IS ON MUST HAVE A MODEL (issue #969). `mode` and `model` are
  // validated as a PAIR, against the row as it WILL BE rather than as it was —
  // setting the mode and clearing the model in one patch is refused too.
  // Migration 0056 enforces the same rule in the schema for writers that never
  // come through here.
  if (patch.mode !== undefined || patch.model !== undefined) {
    const current = await getJudgeConfig();
    const resultingMode = patch.mode ?? current.mode;
    const resultingModel = patch.model === undefined ? current.model : (patch.model === null ? null : patch.model.trim());
    // WHICH MODEL THE ROW WILL CARRY, not which one this patch mentioned
    // (AC-MODEL-01): `{"mode":"enforce"}` against a row already holding a
    // keyless model would otherwise enable it with no model check at all.
    if (resultingMode !== "off" && resultingModel) {
      assertJudgeModelAllowed(resultingModel);
    }
    if (resultingMode !== "off" && !resultingModel) {
      throw new Error(
        `judge mode "${resultingMode}" requires a model — set { mode, model } together, or leave the judge off. ` +
          "A judge with no model cannot form an opinion, and it must not record one it did not form.",
      );
    }
  }
  // `model: null` UNSETS deliberately, which is why it is passed through
  // separately from the COALESCE-on-undefined the other fields get.
  const clearModel = patch.model === null;
  const nextMode = patch.mode ?? null;

  // ── A PLAIN UPDATE, NOT AN UPSERT (the #969 defect). An
  // `INSERT … ON CONFLICT DO UPDATE` evaluates migration 0056's CHECK against
  // the PROPOSED INSERT TUPLE before the arbiter redirects it, so a mode-only
  // patch carrying model = NULL beside mode = 'enforce' was refused for a row
  // that was never going to be stored. A read-modify-write fixes that and
  // silently reverts a concurrent writer's model change; this form cannot,
  // because the COALESCE reads the row as it stands when the UPDATE runs.
  //
  // A LEGACY `shadow` IS RETIRED BY ANY WRITE. `resolved_mode` stores `off`
  // where the row said `shadow` and the patch named no mode — the reading
  // getJudgeConfig() and the lifecycle already give it — so no write through
  // this module can leave a `shadow` behind.
  //
  // THE POLICY STAMP MOVES ONLY WHEN THE POLICY MOVES (T04, migration 0057).
  // `updated_at` is bumped by every patch; swarm/receipt-gap.ts asks whether
  // today's policy (mode and min_takes) is entitled to speak for a session that
  // published before it, and a model rotation must not answer that.
  const updated = await on(sql, updateConfig)`
    UPDATE swarm_judge_config SET
      mode = CASE WHEN COALESCE(${nextMode}, mode) = 'enforce' THEN 'enforce' ELSE 'off' END,
      min_takes = COALESCE(${patch.minTakes ?? null}::integer, min_takes),
      model = CASE WHEN ${clearModel} THEN NULL
                   ELSE COALESCE(${patch.model ? patch.model.trim() : null}, model) END,
      third_party_enabled = COALESCE(${patch.thirdPartyEnabled ?? null}, third_party_enabled),
      updated_at = now(),
      policy_updated_at = CASE
        WHEN mode IS DISTINCT FROM (CASE WHEN COALESCE(${nextMode}, mode) = 'enforce' THEN 'enforce' ELSE 'off' END)
          OR min_takes IS DISTINCT FROM COALESCE(${patch.minTakes ?? null}::integer, min_takes)
        THEN now() ELSE policy_updated_at END
    WHERE id = 1
    RETURNING id`.catch(rethrowAsNamedModelRefusal(patch));
  if (updated.length === 0) {
    // The empty-table fallback only: migration 0056 seeds id = 1, so in
    // practice the UPDATE always matches. `DO NOTHING` makes a race between two
    // cold starts harmless.
    await on(sql, insertConfig)`
      INSERT INTO swarm_judge_config (id, mode, min_takes, model, third_party_enabled, updated_at, policy_updated_at)
      VALUES (1, ${patch.mode ?? DEFAULT_CONFIG.mode}, ${patch.minTakes ?? DEFAULT_CONFIG.minTakes},
              ${clearModel ? null : (patch.model ? patch.model.trim() : null)},
              ${patch.thirdPartyEnabled ?? DEFAULT_CONFIG.thirdPartyEnabled}, now(), now())
      ON CONFLICT (id) DO NOTHING`.catch(rethrowAsNamedModelRefusal(patch));
  }
  return getJudgeConfig();
}

/**
 * Migration 0056's CHECK, reported in this function's OWN words.
 *
 * The pair validation above refuses the on-with-no-model combination before any
 * statement runs, so the constraint can only fire on a genuine race — a second
 * writer clearing the model between that check and this UPDATE. Every other
 * database error is rethrown untouched.
 */
function rethrowAsNamedModelRefusal(patch: { mode?: JudgeMode }) {
  return (err: unknown): never => {
    const text = err instanceof Error ? err.message : String(err);
    if (text.includes("swarm_judge_config_mode_requires_model_check")) {
      throw new Error(
        `judge mode "${patch.mode ?? "(unchanged)"}" requires a model — set { mode, model } together, or leave the judge off. ` +
          "The stored model was taken away by a concurrent write while this patch was in flight; re-send the patch with both fields.",
      );
    }
    throw err instanceof Error ? err : new Error(text);
  };
}
