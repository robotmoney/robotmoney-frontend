// `deployment_identity = production` — production initialization step 4
// (smoke-production-spec.md §9.1, §4.2), the database half of
// `bun scripts/prod-init.ts set-identity`.
//
//   §4.2: "A one-row table in the database, `deployment_identity.kind ∈
//   {production, rehearsal}`, writable only by `rm_owner`. `production` is
//   written once by production initialization (§9.1)."
//   §9.1 step 4: "`deployment_identity = production` — via `rm_owner`, written
//   by the first migrate in the same transaction as 0063 (D55 (9))."
//
// SO THIS STEP WRITES NOTHING. Under D55 (9) the first production migrate
// (`bun run migrate`, backend/scripts/migrate-run.ts applyIdentityFirst) commits
// 0063's DDL, its ledger row and `production` in one fenced transaction, so no
// committed state holds the table without its row. What is left for step 4 is
// the operator's receipted confirmation that the row is there: this command
// reads it, as rm_owner, inside the §2 fence (so no competitor can move it
// while it is read), and REPORTS it. It never rewrites it — the receipt must
// not claim a transition that did not happen — and it writes no row where
// there is none:
//   - `production`  reported, unchanged (enrollAsProduction returns the row it
//                   finds, after its RM_ENV=prod and confirmation gates);
//   - no row        refuses: the first migrate writes the row with the table,
//                   so a table without one was emptied or created out of band
//                   and needs a human, not a second writer;
//   - `rehearsal`   refuses: promoting a rehearsal database is never a §9.1
//                   step;
//   - no table      refuses, naming the first migrate that creates it.
//
// Its caller holds the §2 session target lock and passes it here to be proven
// held immediately before the read. The typed owner password arrives in the
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
  /** Kept for the command's interface; the row's note is the first migrate's. */
  readonly note: string | null;
  readonly lock?: HeldTargetLock;
}

export interface SetIdentityResult {
  /** What the row said: always `production`, the first migrate's write. */
  readonly before: "production";
  /** The row as read, unchanged. */
  readonly row: DeploymentIdentityRow;
  /** Always false: step 4's write is the first migrate's (D55 (9)). */
  readonly written: false;
}

/**
 * Report the target's `production` row, read as rm_owner inside the fence.
 *
 * Refusal cases (nothing is written in any case): `RM_ENV` not `prod`; no
 * confirmation; the table cannot be read (not migrated yet); no row; the row
 * says `rehearsal`; the lock cannot be proven held.
 */
export async function setProductionIdentity(options: SetIdentityOptions): Promise<SetIdentityResult> {
  const { assertStillHeld, withMutationFence } = await import("../src/db/target-lock.ts");
  const { enrollAsProduction, isLoopbackHost, transactionIdentityStore } = await import("../../scripts/lib/smoke-identity.ts");
  if (options.lock) await assertStillHeld(options.lock, "set-identity");
  const remote = !isLoopbackHost(new URL(options.ownerUrl).hostname);
  return withMutationFence({ databaseUrl: options.ownerUrl, label: "identity" }, async (tx) => {
    const store = transactionIdentityStore(tx, { remote });
    const before = await store.read();
    if (before.state === "unreadable") {
      throw new Error(
        `deployment_identity cannot be read (${before.reason}). The first production migrate creates it and writes ` +
          "`production` in the same transaction (§9.1 step 4, D55 (9)): run `bun run migrate` first.",
      );
    }
    if (before.state === "absent") {
      throw new Error(
        "deployment_identity has no row. The first production migrate writes `production` in the transaction that " +
          "creates the table (§9.1 step 4, D55 (9)), so a table without its row was emptied or created out of band. " +
          "set-identity never writes the row; find out how it went missing first. Nothing was written.",
      );
    }
    if (before.row.kind !== "production") {
      throw new Error(
        "deployment_identity: this database is enrolled as `rehearsal`; promoting a rehearsal database to `production` is not a step of §9.1.",
      );
    }
    // The gates (RM_ENV=prod, the confirmation) and the no-rewrite rule are
    // enrollAsProduction's: on a `production` row it returns that row as found.
    const row = await enrollAsProduction(store, { rmEnv: options.rmEnv, confirmed: options.confirmed, note: options.note });
    return { before: "production", row, written: false };
  });
}
