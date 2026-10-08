// scripts/release/precondition.ts — the target precondition every release run
// checks first (R1.2), on every target.
//
// A release run does not create its database. Production's database exists
// before the run. A stage target's database is set up before the run by
// `scripts/release/stage-target.ts up --dump <dir>`. Either way R1.2 proves,
// read-only, that the database `~/.env` names is the one this release upgrades:
//   - it answers through `rm_readonly`;
//   - its ledger equals a supported baseline (backend/src/db/supported-releases.ts);
//   - `deployment_identity` is absent, or holds the kind RM_ENV implies
//     (`prod` → `production`, `stage` → `rehearsal`). With the row present, the
//     ledger may also record `0081_deployment_identity.sql`, the file that
//     created it (a remote twin prepared by pre-identity-remote-twin.md).
//
// Pure, with no import outside node built-ins: it runs before `bun install`.
import { describeUnmatchedLedger, matchSupportedRelease } from "../../backend/src/db/supported-releases.ts";

export const IDENTITY_MIGRATION = "0081_deployment_identity.sql";

/** The identity kind a policy may meet before its first migrate. */
export function expectedIdentity(rmEnv: string | undefined): "production" | "rehearsal" | undefined {
  return rmEnv === "prod" ? "production" : rmEnv === "stage" ? "rehearsal" : undefined;
}

/** PURE. Every reason this database is not the one this release upgrades. */
export function preconditionProblems(input: { rmEnv: string | undefined; ledger: readonly string[]; identity: string | null }): string[] {
  const expected = expectedIdentity(input.rmEnv);
  if (expected === undefined) return [`RM_ENV is ${input.rmEnv ?? "unset"}; a release run is stage or prod`];
  const out: string[] = [];
  if (input.identity !== null && input.identity !== expected) {
    out.push(`deployment_identity is ${input.identity}; RM_ENV=${input.rmEnv} meets only ${expected} or no row`);
  }
  const ledger = input.identity === null ? input.ledger : input.ledger.filter((n) => n !== IDENTITY_MIGRATION);
  if (matchSupportedRelease(ledger) === null) {
    out.push(`the ledger (${input.ledger.length} names) matches no supported baseline: ${describeUnmatchedLedger(ledger)}`);
  }
  return out;
}
