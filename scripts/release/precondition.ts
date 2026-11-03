// scripts/release/precondition.ts — the target precondition every release run
// checks first (Q07-host-identity/P02-host-identity), on every target.
//
// A release run does not create its database. Production's database exists
// before the run. A stage target's database is set up before the run by
// `scripts/release/stage-target.ts up --dump <dir>`. Either way Q07-host-identity/P02-host-identity proves,
// read-only, that the database `~/.env` names is one this repository upgrades:
//   - it answers through `rm_readonly`;
//   - `deployment_identity` is absent, or holds the kind RM_ENV implies
//     (`prod` → `production`, `stage` → `rehearsal`). With the row present, the
//     ledger may also record `0081_deployment_identity.sql`, the file that
//     created it (a remote twin prepared by pre-identity-remote-twin.md).
//
// It holds no past-upgrade fact: the same check passes the ledger production
// runs today and the one it runs after the next patch (issues 1272, 1273).
//
// The ledger's reconciliation with backend/migrations (./ledger.ts, D67) is
// Q12-state-baseline/P07-state-baseline's, once: it refuses on the same receipt this step once read too.
//
// Pure: the caller hands in what it read (the ledger, the identity). No import
// outside node built-ins: it runs before `bun install`.

export const IDENTITY_MIGRATION = "0081_deployment_identity.sql";

/** The identity kind a policy may meet before its first migrate. */
export function expectedIdentity(rmEnv: string | undefined): "production" | "rehearsal" | undefined {
  return rmEnv === "prod" ? "production" : rmEnv === "stage" ? "rehearsal" : undefined;
}

/** PURE. Every reason this database is not one this repository upgrades. */
export function preconditionProblems(input: {
  rmEnv: string | undefined;
  ledger: readonly string[];
  identity: string | null;
}): string[] {
  const expected = expectedIdentity(input.rmEnv);
  if (expected === undefined) return [`RM_ENV is ${input.rmEnv ?? "unset"}; a release run is stage or prod`];
  const out: string[] = [];
  if (input.identity !== null && input.identity !== expected) {
    out.push(`deployment_identity is ${input.identity}; RM_ENV=${input.rmEnv} meets only ${expected} or no row`);
  }
  if (input.identity === null && input.ledger.includes(IDENTITY_MIGRATION)) {
    out.push(`the ledger records ${IDENTITY_MIGRATION} but deployment_identity has no row`);
  }
  return out;
}
