// The one place that decides whether a boot is allowed to touch the database
// it is pointed at — `RM_ENV` policy resolution plus the full policy × identity
// matrix of smoke-production-spec.md §4.3, as a single function returning an
// allow/refuse verdict with a human-readable reason.
//
// Implemented for issue #1026, W1.1. The module is pure: it reads no
// environment and opens no connection, so it is additive and behaviour-neutral
// until a caller wires it into the boot path.
//
// ── Why this module exists ──────────────────────────────────────────────────
//
// Today `RM_ENV` is a three-valued backend runtime mode (`ephemeral | smoke |
// prod`) that each caller interprets for itself, and the production host has
// never actually run with `RM_ENV=prod` — spec §9.3 records that it runs
// `RM_ENV=smoke` under the retired compose overlay, which means *no production
// guard in this repository has ever been armed on the machine it was written
// for*. Every protection that reads `RM_ENV` is therefore unproven in the only
// place it matters.
//
// The failure this prevents is the one that has no undo: a stage-shaped boot —
// `--allow-insecure`, `--seed`, `--spoof-keys`, a migration, a schedule rewrite
// — resolving a remote connection string that happens to point at the
// production database. `RM_ENV` alone cannot prevent it, because `RM_ENV` is a
// value the operator types and the operator is exactly who is mistaken in that
// scenario. So the spec pairs the operator's *declared policy* (`RM_ENV`) with
// the target's *own enrolled identity* (`deployment_identity`, §4.2, read from
// inside the database and writable only by `rm_owner`) and refuses every
// combination that is not explicitly listed as safe. Two independent facts must
// agree before anything starts; a single typo can no longer arm production
// behaviour or aim stage behaviour at production data.
//
// ── Why one function, not scattered checks ──────────────────────────────────
//
// Plan W1.1 requires the matrix to be "one function, called before any service
// starts". A matrix spread across call sites is a matrix with holes: the rows
// that refuse are exactly the rows nobody remembers to write. Keeping all
// thirteen rows of §4.3 in one total function makes the missing row a visible
// gap in a table rather than an invisible absence in control flow, and lets the
// W1 acceptance gates (spec §10) be written against this function directly
// instead of against a booted stack.
//
// ── Naming note (read before renaming) ──────────────────────────────────────
//
// The engineering plan's W1.1 row names this file `scripts/lib/smoke-env.ts`.
// That path is ALREADY TAKEN by an unrelated live module: the demo data-path
// resolver (`resolveSmokeEnv`, issues #147/#163) that decides BASE_RPC_URL /
// ANALYTICS_SOURCE for the compose environment. The two have nothing in common
// but the word "env". This module therefore lands as `smoke-env-policy.ts`, and
// the merge of the two names — if it is wanted at all — is an implementation
// decision for a later W1 step, not something a stub may do by overwriting a
// shipping file.
//
// ── Governing spec sections ─────────────────────────────────────────────────
//
//   §4.1  `RM_ENV` is policy only: `prod | stage`. Stage, test and CI are
//         isomorphic and share `stage`. It does NOT name the instance (§1.1).
//   §4.2  `deployment_identity.kind ∈ {production, rehearsal}` marks what the
//         target is enrolled for. Not proof the data is disposable.
//   §4.3  The matrix below, "enforced before any service starts".
//   §4.4  `--allow-insecure` / `--schedules-off` are refusals on `RM_ENV=prod`.
//   §5    `--local <mode>` is a stage-only override.
//   §7.5  Preflight re-checks `RM_ENV` × `deployment_identity` per §4.3.
//
// Acceptance gates served (spec §10, W1): "Unset `RM_ENV` against a remote
// target refuses." and, jointly with smoke-identity.ts, W2's "`RM_ENV=stage` +
// typed owner password against `deployment_identity = production` refuses;
// plain stage boot incl. `--allow-insecure` against production identity
// refuses."

import type { DeploymentIdentityKind } from "./smoke-identity.ts";

/**
 * The two policy values of spec §4.1. Stage, test and CI are isomorphic and all
 * share `stage`; there is no separate CI policy and no `ephemeral` or `smoke`
 * value. The instance name (§1.1) is a different axis entirely and is resolved
 * by smoke-state.ts — `RM_ENV` never names an instance.
 */
export type RmEnv = "prod" | "stage";

/**
 * How `RM_ENV` arrived, because the matrix treats an unset variable differently
 * from an explicit one: unset + remote is a refusal (§4.3 row 9), unset +
 * `--local` proceeds as stage with a warning (§4.3 row 10). Collapsing the two
 * into "it's stage" would silently allow the single most dangerous case — an
 * operator who forgot to export anything, pointed at a remote database.
 */
export type RmEnvSource = "explicit" | "unset";

/**
 * How the target database is reached. `remote` is any connection taken from
 * `~/.env` (spec §3); the three `local-*` arms are the `--local <mode>` modes of
 * spec §5, which smoke owns and which make it ignore every remote connection
 * value ("Args override env", §3).
 *
 * The modes are kept apart rather than folded into one `local` because §4.3
 * distinguishes them: `blank` and `dump` have their identity row *written by
 * smoke* as part of the bootstrap, while `volume` reattaches a pre-existing
 * volume whose identity row must already say `rehearsal` — "a reattached volume
 * gets no weaker policy than a remote".
 */
export type TargetConnection = "remote" | "local-blank" | "local-dump" | "local-volume";

/**
 * Everything the matrix needs, and nothing else. Deliberately not a "smoke
 * options" object: this function must be callable from `bun run migrate`,
 * `bun run schedules:enable` and the §9.1 production-initialization commands,
 * none of which have smoke's option shape.
 */
export interface PolicyInput {
  /** Raw `RM_ENV` as read from the process environment, before validation. */
  readonly rmEnv: string | undefined;
  /** How the target is reached; see {@link TargetConnection}. */
  readonly connection: TargetConnection;
  /**
   * The identity row read from the target (§4.2), or `null` when the table has
   * no row, and `"unreadable"` when the table is absent or the read failed.
   * A missing row is NOT `rehearsal`: an un-enrolled database is "anything
   * else" for every matrix row that names a kind.
   *
   * For `local-blank` / `local-dump` this is the value smoke is ABOUT TO write,
   * so callers pass `"rehearsal"` there per §4.3 ("written by smoke as
   * rehearsal") — the matrix does not reach into the database itself.
   */
  readonly identity: DeploymentIdentityKind | null | "unreadable";
}

/**
 * Which guard posture the run adopts once allowed. `production` arms every
 * production guard (§4.3 row 1) and makes `--allow-insecure`, `--schedules-off`,
 * `--migrate`, `--seed` and `--spoof-keys` refusals (§§4.4, 4.3, 6.4). `stage`
 * permits the rehearsal-only preparation flags, subject to their own guards.
 */
export type PolicyPosture = "production" | "stage";

/**
 * The verdict. A discriminated union rather than a boolean-plus-message so a
 * caller cannot read `reason` on an allow, and — more importantly — cannot
 * forget to branch: `if (!verdict.allow)` is the only way to reach `posture`.
 *
 * `warnings` carries the non-fatal text the spec mandates verbatim, today
 * exactly §4.3's `RM_ENV not set, running as stage`.
 */
export type PolicyVerdict =
  | { readonly allow: true; readonly env: RmEnv; readonly posture: PolicyPosture; readonly warnings: readonly string[] }
  | { readonly allow: false; readonly reason: string };

/**
 * Validate `RM_ENV` in isolation, per spec §4.1.
 *
 * Returns the policy value and how it arrived. `prod` and `stage` are the only
 * accepted spellings; anything else — including the retired `ephemeral` and
 * `smoke` values that `backend/src/config.ts`'s `VALID_ENVS` still accepts, and
 * including case variants like `PROD` — is "other" in §4.3's last row and must
 * be reported as such rather than coerced. An unset variable resolves to
 * `stage` with `source: "unset"`; whether that is ALLOWED is the matrix's
 * decision, not this function's, because it depends on the connection.
 *
 * Refusal cases this must implement:
 *  - a value that is neither `prod` nor `stage` (exactly, case-sensitively)
 *    yields `{ ok: false }` naming the offending value and the two legal ones;
 *    it must NOT fall back to `stage`, because §4.3's "other × any × any" row is
 *    a refusal, not a downgrade.
 *  - an empty string and a whitespace-only string are treated as unset, not as
 *    "other": `RM_ENV=` in a shell profile is an absence, and reporting it as an
 *    unknown value would send the operator hunting for a typo that is not there.
 *
 * Serves spec §10 W1: "Unset `RM_ENV` against a remote target refuses."
 */
export function resolveRmEnv(
  env: Record<string, string | undefined>,
): { ok: true; env: RmEnv; source: RmEnvSource } | { ok: false; reason: string } {
  const raw = env.RM_ENV;
  if (raw === undefined || raw.trim() === "") return { ok: true, env: "stage", source: "unset" };
  if (raw === "prod" || raw === "stage") return { ok: true, env: raw, source: "explicit" };
  return {
    ok: false,
    reason:
      `RM_ENV="${raw}" is not a policy value: refusing — RM_ENV must be exactly ` +
      `prod or stage (spec §4.1). It is not downgraded to stage.`,
  };
}

/** How an identity value reads in a refusal or a plan line. */
function describeIdentity(identity: DeploymentIdentityKind | null | "unreadable"): string {
  if (identity === null) return "no identity row";
  if (identity === "unreadable") return "unreadable identity table";
  return identity;
}

/**
 * The whole of spec §4.3, as one total function, evaluated before any service
 * starts and again inside preflight (§7 check 5).
 *
 * Every row of the matrix, reproduced so a reviewer can check this function
 * against the spec without leaving the file:
 *
 *   | RM_ENV | connection   | identity row          | result                          |
 *   |--------|--------------|-----------------------|---------------------------------|
 *   | prod   | remote       | production            | allow, production guards armed  |
 *   | prod   | remote       | anything else         | REFUSE                          |
 *   | prod   | --local      | any                   | REFUSE                          |
 *   | stage  | remote       | rehearsal             | allow, stage                    |
 *   | stage  | remote       | anything else         | REFUSE                          |
 *   | stage  | --local blank/dump | written by smoke as rehearsal | allow, stage          |
 *   | stage  | --local volume | rehearsal           | allow, stage                    |
 *   | stage  | --local volume | anything else       | REFUSE                          |
 *   | unset  | remote       | any                   | REFUSE                          |
 *   | unset  | --local      | as stage              | WARN + allow, stage             |
 *   | other  | any          | any                   | REFUSE                          |
 *
 * Two of those rows carry reasoning the spec states explicitly and that must
 * survive into the refusal text, because a refusal an operator does not
 * understand is a refusal an operator works around:
 *
 *  - `stage` × remote × not-`rehearsal`: "stage policy (incl.
 *    `--allow-insecure`) never touches production data". There is no flag that
 *    relaxes this and none may be added.
 *  - `stage` × `--local volume` × not-`rehearsal`: "a reattached volume gets no
 *    weaker policy than a remote". A volume from an earlier run is not trusted
 *    because it is local; it is trusted because its identity row says
 *    `rehearsal`.
 *
 * Inputs: {@link PolicyInput}. Output: {@link PolicyVerdict} — on allow, the
 * resolved `RM_ENV`, the guard posture, and any warnings; on refuse, a reason
 * string that names the observed `RM_ENV`, the connection, the observed
 * identity, and which of the rows above fired.
 *
 * Refusal cases, each an independent branch:
 *  1. `RM_ENV` is neither `prod` nor `stage` (last row), via {@link resolveRmEnv}.
 *  2. `RM_ENV` unset and the connection is remote — the row that exists so a
 *     forgotten export can never reach a real database.
 *  3. `RM_ENV=prod` with any `--local` mode: production never runs on a
 *     database smoke owns.
 *  4. `RM_ENV=prod`, remote, identity not exactly `production` — including a
 *     missing row and an unreadable table.
 *  5. `RM_ENV=stage`, remote, identity not exactly `rehearsal` — likewise.
 *  6. `RM_ENV=stage`, `--local volume`, identity not exactly `rehearsal`.
 *  7. Identity `"unreadable"` on any row that names a kind: the absence of
 *     evidence is never evidence of rehearsal.
 *
 * The one warning: `RM_ENV` unset with a `--local` mode emits the spec's exact
 * text, `RM_ENV not set, running as stage`, and proceeds.
 *
 * Serves spec §10 W1 ("Unset `RM_ENV` against a remote target refuses") and
 * §10 W2 ("`RM_ENV=stage` + typed owner password against
 * `deployment_identity = production` refuses; plain stage boot incl.
 * `--allow-insecure` against production identity refuses").
 */
export function resolveDeploymentPolicy(input: PolicyInput): PolicyVerdict {
  const resolved = resolveRmEnv({ RM_ENV: input.rmEnv });
  // Row: other × any × any.
  if (!resolved.ok) return { allow: false, reason: resolved.reason };

  const { connection, identity } = input;
  const seen = describeIdentity(identity);
  const isLocal = connection !== "remote";

  // Row: unset × remote × any.
  if (resolved.source === "unset" && !isLocal) {
    return {
      allow: false,
      reason:
        `RM_ENV is not set and the target is reached as a remote connection: refusing ` +
        `(spec §4.3). Export RM_ENV=prod or RM_ENV=stage explicitly; a forgotten export ` +
        `never reaches a real database.`,
    };
  }

  if (resolved.env === "prod") {
    // Row: prod × --local × any.
    if (isLocal) {
      return {
        allow: false,
        reason:
          `RM_ENV=prod with connection ${connection}: refusing — production never runs on a ` +
          `database smoke owns (spec §4.3). Observed identity: ${seen}.`,
      };
    }
    // Row: prod × remote × production, else refuse.
    if (identity !== "production") {
      return {
        allow: false,
        reason:
          `RM_ENV=prod against a remote target whose deployment_identity is ${seen}: refusing ` +
          `— prod policy requires an identity of production (spec §4.3). The absence of ` +
          `evidence is never evidence of production.`,
      };
    }
    return { allow: true, env: "prod", posture: "production", warnings: [] };
  }

  // Row: stage × remote × rehearsal, else refuse.
  if (!isLocal && identity !== "rehearsal") {
    return {
      allow: false,
      reason:
        `RM_ENV=stage against a remote target whose deployment_identity is ${seen}: refusing ` +
        `— stage policy (incl. --allow-insecure) never touches production data (spec §4.3). ` +
        `No flag relaxes this row.`,
    };
  }

  // Row: stage × --local volume × rehearsal, else refuse.
  if (connection === "local-volume" && identity !== "rehearsal") {
    return {
      allow: false,
      reason:
        `RM_ENV=stage with connection local-volume whose deployment_identity is ${seen}: ` +
        `refusing — a reattached volume gets no weaker policy than a remote (spec §4.3).`,
    };
  }

  // Rows: stage × --local blank/dump, stage × remote × rehearsal, stage × volume × rehearsal,
  // and unset × --local (which warns).
  const warnings = resolved.source === "unset" ? ["RM_ENV not set, running as stage"] : [];
  return { allow: true, env: "stage", posture: "stage", warnings };
}

/**
 * The §4.4 companion guard: the former `docker-compose.smoke.yml` knobs are now
 * explicit flags, and each is a refusal under `RM_ENV=prod`.
 *
 * Kept beside the matrix rather than in the argv parser because it is the same
 * question — "does this policy permit this weakening?" — and because the argv
 * parser runs before the target is known while this does not need the target at
 * all: the flags are refused on `prod` regardless of what the database says.
 *
 * Refusal cases: `--allow-insecure` under `prod`; `--schedules-off` under
 * `prod`. Both name the flag and state that parity with production is a tested
 * property, not an overlay (§4.4). Under `stage` both are permitted and the
 * function returns no refusal.
 *
 * Serves spec §10 W1's "Overlay-free stage boots with the real scheduler" by
 * being the thing that makes the flags safe to have at all.
 */
export function refuseWeakeningFlagsOnProd(
  env: RmEnv,
  flags: { readonly allowInsecure: boolean; readonly schedulesOff: boolean },
): { readonly allow: true } | { readonly allow: false; readonly reason: string } {
  if (env !== "prod") return { allow: true };
  const named: string[] = [];
  if (flags.allowInsecure) named.push("--allow-insecure");
  if (flags.schedulesOff) named.push("--schedules-off");
  if (named.length === 0) return { allow: true };
  return {
    allow: false,
    reason:
      `${named.join(" and ")} refused under RM_ENV=prod: parity with production is a tested ` +
      `property, not an overlay (spec §4.4).`,
  };
}

/**
 * Render a {@link PolicyVerdict} for the plan block (§1.2) and for the refusal
 * message, as one deterministic line per fact.
 *
 * It exists so the operator sees the SAME four facts — declared policy, how the
 * target is reached, what the target says it is, and the resulting posture — in
 * the plan that precedes a successful run and in the text of a refusal. An
 * operator comparing a refusal against yesterday's successful plan should be
 * able to spot the one line that changed; that is only possible if both are
 * produced here.
 *
 * Must not include any credential, connection string, host or password: the
 * plan is explicitly "redacted" (§1.2), and this line is part of it.
 */
export function describePolicyVerdict(input: PolicyInput, verdict: PolicyVerdict): string {
  const declared = input.rmEnv === undefined || input.rmEnv.trim() === "" ? "(not set)" : input.rmEnv;
  const lines = [
    `declared policy: RM_ENV=${declared}`,
    `connection: ${input.connection}`,
    `target identity: ${describeIdentity(input.identity)}`,
    verdict.allow ? `posture: ${verdict.posture}` : `posture: refused — ${verdict.reason}`,
  ];
  if (verdict.allow) for (const warning of verdict.warnings) lines.push(`warning: ${warning}`);
  return lines.join("\n");
}
