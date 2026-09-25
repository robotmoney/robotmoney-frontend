// THE policy × identity matrix of smoke-production-spec.md §4.3 — the one
// implementation. Every tool that decides whether it may touch a database asks
// this module and nothing else:
//
//   - `bun smoke` (scripts/lib/smoke-main.ts, through smoke-env-policy.ts, which
//     re-exports this file) before any service starts;
//   - `bun run migrate` and `bun smoke --migrate` (backend/scripts/migrate-run.ts
//     checkMigrateGates) before an owner password is ever requested;
//   - preflight check 5 (backend/src/db/preflight.ts checkEnvIdentity), which
//     the smoke runs after preparation and which a container could run too.
//
// WHY IT LIVES UNDER backend/src/. backend/Dockerfile copies `backend/` and
// `contract/` and nothing else, so a module under `scripts/` cannot be imported
// by anything that runs in the api image. `scripts/` runs on the host and can
// import this file by relative path. One direction works; the other does not —
// the same reason backend/src/acceptance-path.ts lives here. Three copies of the
// matrix existed before this file (smoke-env-policy.ts, checkMigrateGates and
// checkEnvIdentity), and three copies of a table are three tables: the rows that
// refuse are exactly the rows one copy forgets.
//
// PURE. It reads no environment and opens no connection. The caller reads
// `RM_ENV` and the `deployment_identity` row and hands both in; this module only
// decides.
//
// ── Why the matrix exists ────────────────────────────────────────────────────
//
// The failure it prevents is the one that has no undo: a stage-shaped boot —
// `--allow-insecure`, `--seed`, `--spoof-keys`, a migration — resolving a remote
// connection string that happens to point at the production database. `RM_ENV`
// alone cannot prevent it, because `RM_ENV` is a value the operator types and
// the operator is exactly who is mistaken in that scenario. So the spec pairs
// the operator's DECLARED policy (`RM_ENV`) with the target's own ENROLLED
// identity (`deployment_identity`, §4.2, read from inside the database and
// writable only by `rm_owner`) and refuses every combination that is not
// explicitly listed as safe. Two independent facts must agree before anything
// starts.
//
// Governing spec sections: §4.1 (`RM_ENV` is policy only: `prod | stage`), §4.2
// (the identity row), §4.3 (the matrix and the rehearsal-only preparation
// rule), §4.4 (`--allow-insecure` is a refusal on prod), §7 check 5.

/** The two policy values of spec §4.1. Stage, test and CI share `stage`. */
export type PolicyEnv = "prod" | "stage";

/**
 * How `RM_ENV` arrived. Unset + remote refuses (§4.3), unset + `--local`
 * proceeds as stage with a warning; collapsing the two into "it's stage" would
 * silently allow an operator who forgot to export anything, pointed at a remote
 * database.
 */
export type RmEnvSource = "explicit" | "unset";

/** The two enrolled kinds of §4.2. An un-enrolled database is `null`, never a third kind. */
export type DeploymentIdentityKind = "production" | "rehearsal";

/**
 * How the target database is reached. `remote` is any connection taken from
 * `~/.env` (§3); the three `local-*` arms are the `--local <mode>` modes of §5.
 * §4.3 distinguishes them: `blank` and `dump` have their identity row written by
 * smoke itself, while `volume` reattaches a volume whose row must already say
 * `rehearsal`.
 */
export type TargetConnection = "remote" | "local-blank" | "local-dump" | "local-volume";

/** Everything the matrix needs, and nothing else. */
export interface PolicyInput {
  /** Raw `RM_ENV` as read, before validation; `undefined` when unset. */
  readonly rmEnv: string | undefined;
  readonly connection: TargetConnection;
  /**
   * The identity row read from the target: the kind, `null` when the table has
   * no row, `"unreadable"` when the table is absent or the read failed. For
   * `local-blank` / `local-dump` it is not consulted: the row is the one smoke
   * writes as `rehearsal` during preparation, and preflight check 5 reads the
   * written row back afterwards as `local-volume` does.
   */
  readonly identity: DeploymentIdentityKind | null | "unreadable";
}

/** `production` arms every production guard; `stage` permits the rehearsal-only preparation. */
export type PolicyPosture = "production" | "stage";

export type PolicyVerdict =
  | { readonly allow: true; readonly env: PolicyEnv; readonly posture: PolicyPosture; readonly warnings: readonly string[] }
  | { readonly allow: false; readonly reason: string };

/** §4.3's one warning, verbatim. */
export const RM_ENV_UNSET_WARNING = "RM_ENV not set, running as stage";

/**
 * Validate `RM_ENV` in isolation (§4.1). `prod` and `stage` exactly,
 * case-sensitively; anything else — the retired `smoke` and `ephemeral` values
 * included — is §4.3's "other" row and refuses rather than falling back to
 * stage. Empty and whitespace-only are an absence (`RM_ENV=` in a profile), not
 * an unknown value.
 */
export function resolveRmEnv(
  env: Record<string, string | undefined>,
): { ok: true; env: PolicyEnv; source: RmEnvSource } | { ok: false; reason: string } {
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

function describeIdentity(identity: PolicyInput["identity"]): string {
  if (identity === null) return "no identity row";
  if (identity === "unreadable") return "unreadable identity table";
  return identity;
}

/**
 * The whole of spec §4.3 as one total function:
 *
 *   | RM_ENV | connection         | identity row          | result                         |
 *   |--------|--------------------|-----------------------|--------------------------------|
 *   | prod   | remote             | production            | allow, production guards armed |
 *   | prod   | remote             | anything else         | REFUSE                         |
 *   | prod   | --local            | any                   | REFUSE                         |
 *   | stage  | remote             | rehearsal             | allow, stage                   |
 *   | stage  | remote             | anything else         | REFUSE                         |
 *   | stage  | --local blank/dump | written by smoke      | allow, stage                   |
 *   | stage  | --local volume     | rehearsal             | allow, stage                   |
 *   | stage  | --local volume     | anything else         | REFUSE                         |
 *   | unset  | remote             | any                   | REFUSE                         |
 *   | unset  | --local            | as stage              | WARN + allow, stage            |
 *   | other  | any                | any                   | REFUSE                         |
 *
 * Every refusal names the observed `RM_ENV`, the connection, the observed
 * identity and the row that fired, with the spec's own reasoning where it
 * states one ("stage policy (incl. `--allow-insecure`) never touches production
 * data"; "a reattached volume gets no weaker policy than a remote"). A missing
 * row and an unreadable table are never evidence of either kind.
 */
export function resolveDeploymentPolicy(input: PolicyInput): PolicyVerdict {
  const resolved = resolveRmEnv({ RM_ENV: input.rmEnv });
  if (!resolved.ok) return { allow: false, reason: resolved.reason };

  const { connection, identity } = input;
  const seen = describeIdentity(identity);
  const isLocal = connection !== "remote";

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
    if (isLocal) {
      return {
        allow: false,
        reason:
          `RM_ENV=prod with connection ${connection}: refusing — production never runs on a ` +
          `database smoke owns (spec §4.3). Observed identity: ${seen}.`,
      };
    }
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

  if (!isLocal && identity !== "rehearsal") {
    return {
      allow: false,
      reason:
        `RM_ENV=stage against a remote target whose deployment_identity is ${seen}: refusing ` +
        `— stage policy (incl. --allow-insecure) never touches production data (spec §4.3). ` +
        `No flag relaxes this row.`,
    };
  }

  if (connection === "local-volume" && identity !== "rehearsal") {
    return {
      allow: false,
      reason:
        `RM_ENV=stage with connection local-volume whose deployment_identity is ${seen}: ` +
        `refusing — a reattached volume gets no weaker policy than a remote (spec §4.3).`,
    };
  }

  const warnings = resolved.source === "unset" ? [RM_ENV_UNSET_WARNING] : [];
  return { allow: true, env: "stage", posture: "stage", warnings };
}

/**
 * §4.4: `--allow-insecure`, the former overlay's one surviving knob, is a
 * refusal under `RM_ENV=prod` whatever the database says. There is no
 * `--schedules-off` and so no refusal for one: scheduling has no off state.
 */
export function refuseWeakeningFlagsOnProd(
  env: PolicyEnv,
  flags: { readonly allowInsecure: boolean },
): { readonly allow: true } | { readonly allow: false; readonly reason: string } {
  if (env !== "prod" || !flags.allowInsecure) return { allow: true };
  return {
    allow: false,
    reason:
      `--allow-insecure refused under RM_ENV=prod: parity with production is a tested ` +
      `property, not an overlay (spec §4.4).`,
  };
}

/**
 * The same four facts — declared policy, connection, what the target says, the
 * posture — in the plan (§1.2) and in a refusal, one per line, so an operator can
 * diff a refusal against yesterday's plan. No credential, host or connection
 * string ever reaches it.
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

/** The preparation §4.3 makes rehearsal-only: "`--migrate`, `--seed`, `--spoof-keys` require `rehearsal` in addition to their own guards." */
export type RehearsalOnlyPreparation = "migrate" | "seed" | "spoof-keys";

/**
 * The floor under all three rehearsal-only preparations, one function so a
 * fourth cannot ship with two of the checks. "In addition to their own guards":
 * it does not replace `--seed`'s refusal of a populated database or
 * `--migrate`'s prompt-and-`y/n` on a remote.
 *
 * Refuses, each with its own text: `RM_ENV=prod` whatever the identity; any
 * value that is not a policy value; a preparation that was not explicitly
 * requested (§5: never implied by any mode); identity `production`; no row; an
 * unreadable row.
 */
export function requireRehearsalTarget(request: {
  readonly preparation: RehearsalOnlyPreparation;
  readonly rmEnv: string | undefined;
  readonly identity: DeploymentIdentityKind | null | "unreadable";
  readonly explicitlyRequested: boolean;
}): { readonly allow: true } | { readonly allow: false; readonly reason: string } {
  const what = `--${request.preparation}`;
  const rmEnv = request.rmEnv === undefined || request.rmEnv.trim() === "" ? undefined : request.rmEnv;
  if (rmEnv === "prod") {
    return {
      allow: false,
      reason: `${what} is refused under RM_ENV=prod: a production-policy run never prepares a database (§4.3, §8.5).`,
    };
  }
  if (rmEnv !== undefined && rmEnv !== "stage") {
    return {
      allow: false,
      reason: `${what} is refused: RM_ENV="${rmEnv}" is not a policy value (§4.1 allows prod or stage only).`,
    };
  }
  if (!request.explicitlyRequested) {
    return {
      allow: false,
      reason: `${what} is refused because it was not explicitly requested: no mode may imply a preparation (§5, §6.4).`,
    };
  }
  if (request.identity === "production") {
    return {
      allow: false,
      reason: `${what} is refused: this target is enrolled as production, and rehearsal-only preparation requires rehearsal (§4.3).`,
    };
  }
  if (request.identity === null) {
    return {
      allow: false,
      reason: `${what} is refused: this target is not enrolled at all, and an un-enrolled database is not a rehearsal database (§4.3). Enroll it as rehearsal first.`,
    };
  }
  if (request.identity === "unreadable") {
    return {
      allow: false,
      reason: `${what} is refused: deployment_identity is unreadable, so there is no evidence this target is a rehearsal database (§4.3). Check that the credential can read the table.`,
    };
  }
  return { allow: true };
}
