// `deployment_identity = production` — production initialization step 4
// (smoke-production-spec.md §9.1, §4.2), the database write of
// `bun scripts/prod-init.ts set-identity`.
//
//   §4.2: "A one-row table in the database, `deployment_identity.kind ∈
//   {production, rehearsal}`, writable only by `rm_owner`. `production` is
//   written once by production initialization (§9.1)."
//
// ONE FENCED TRANSACTION AS `rm_owner` (§2: "Every mutation (… identity write)
// runs in a transaction that first takes `pg_advisory_xact_lock` on the same
// key, on the connection performing it"). The read that decides and the write
// both happen inside it, through scripts/lib/smoke-identity.ts's
// enrollAsProduction over the fence's own transaction, so no competitor can
// move the row between them.
//
// THE DATABASE THE FIRST MIGRATE JUST UPGRADED (D55 (5)). Production runs
// v0.5.0, which predates the table; the first `bun run migrate` runs once with
// no identity row and creates it. This step then finds the table with NO row
// and writes `production`. An existing `production` row is reported, not
// rewritten; a `rehearsal` row refuses (promoting a rehearsal database is never
// a §9.1 step); a missing table refuses, naming the migrate that creates it.
//
// Its caller holds the §2 session target lock and passes it here to be proven
// held immediately before the write. The typed owner password arrives in the
// URL and is never stored (§3, D47).
import type { HeldTargetLock } from "../src/db/target-lock.ts";
import type { DeploymentIdentityRow } from "../../scripts/lib/smoke-identity.ts";

export interface SetIdentityOptions {
  /** An `rm_owner` URL on a direct connection, carrying the typed password. Never logged. */
  readonly ownerUrl: string;
  /** The resolved `RM_ENV`; enrollAsProduction refuses anything but `prod`. */
  readonly rmEnv: string | undefined;
  /** The operator's explicit `y`. */
  readonly confirmed: boolean;
  /** What the row's note records. */
  readonly note: string | null;
  readonly lock?: HeldTargetLock;
}

export interface SetIdentityResult {
  /** What the row said before: no row (the first migrate's state), or already `production`. */
  readonly before: "absent" | "production";
  readonly row: DeploymentIdentityRow;
}

/**
 * Enroll the target as `production`, inside the fence.
 *
 * Refusal cases (the transaction rolls back and nothing changes): `RM_ENV` not
 * `prod`; no confirmation; the table cannot be read (not migrated yet); the row
 * says `rehearsal`; the lock cannot be proven held.
 */
export async function setProductionIdentity(options: SetIdentityOptions): Promise<SetIdentityResult> {
  const { assertStillHeld, withMutationFence } = await import("../src/db/target-lock.ts");
  const { enrollAsProduction, transactionIdentityStore } = await import("../../scripts/lib/smoke-identity.ts");
  if (options.lock) await assertStillHeld(options.lock, "set-identity");
  return withMutationFence({ databaseUrl: options.ownerUrl, label: "identity" }, async (tx) => {
    const store = transactionIdentityStore(tx);
    const before = await store.read();
    if (before.state === "unreadable") {
      throw new Error(
        `deployment_identity cannot be read (${before.reason}). The first production migrate creates it ` +
          "(§9.1 steps 2-3, D55 (5)): run `bun run migrate` first, then set the identity.",
      );
    }
    const row = await enrollAsProduction(store, { rmEnv: options.rmEnv, confirmed: options.confirmed, note: options.note });
    return { before: before.state === "absent" ? "absent" : "production", row };
  });
}
