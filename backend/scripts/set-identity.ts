// `deployment_identity = production` — production initialization step 4
// (smoke-production-spec.md §9.1, §4.2), the database half of
// `bun scripts/prod-init.ts set-identity`.
//
//   §4.2: "A one-row table in the database, `deployment_identity.kind ∈
//   {production, rehearsal}`, writable only by `rm_owner`. `production` is
//   written once by production initialization (§9.1)."
//   §9.1 step 4: "`deployment_identity = production` — via `rm_owner`, written
//   by the first migrate in the same transaction as 0081 (D55 (9))."
//
// SO THIS STEP WRITES NOTHING. Under D55 (9) the first production migrate
// (`bun run migrate`, backend/scripts/migrate-run.ts applyIdentityFirst) commits
// 0081's DDL, its ledger row and `production` in one fenced transaction, so no
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
// UNDER RM_ENV=stage (D61 rule 2). The stage cutover rehearsal runs the same
// step against a remote target the remote rehearsal pass enrolled
// `rehearsal`: `expected: "rehearsal"` reads and reports that row the same way,
// under the fence, and refuses anything else. The kind is the policy's: prod
// expects `production`, stage expects `rehearsal`, never crosswise.
//
// Its caller holds the §2 session target lock and passes it here to be proven
// held immediately before the read. The owner password arrives in the URL
// (read from `~/.env`, D61) and is never stored.
import type { HeldTargetLock } from "../src/db/target-lock.ts";
import type { DeploymentIdentityRow } from "../../scripts/lib/smoke-identity.ts";

export interface SetIdentityOptions {
  /** An `rm_owner` URL on a direct connection, carrying `~/.env`'s password. Never logged. */
  readonly ownerUrl: string;
  /** The kind the policy names: `production` under prod (the default), `rehearsal` under stage (D61). */
  readonly expected?: "production" | "rehearsal";
  /** The resolved `RM_ENV`. `production` requires `prod`; `rehearsal` requires `stage`. */
  readonly rmEnv: string | undefined;
  /** The operator's explicit `y`. */
  readonly confirmed: boolean;
  /** Kept for the command's interface; the row's note is the first migrate's. */
  readonly note: string | null;
  readonly lock?: HeldTargetLock;
}

export interface SetIdentityResult {
  /** What the row said: the expected kind, the first migrate's write. */
  readonly before: "production" | "rehearsal";
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
  const expected = options.expected ?? "production";
  const policy = expected === "production" ? "prod" : "stage";
  if (options.rmEnv !== policy) {
    throw new Error(
      `deployment_identity: set-identity confirms \`${expected}\` only under RM_ENV=${policy} (D61: never crosswise); ` +
        `RM_ENV is ${options.rmEnv === undefined ? "unset" : `"${options.rmEnv}"`}. Nothing was written.`,
    );
  }
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
    if (before.row.kind !== expected) {
      throw new Error(
        expected === "production"
          ? "deployment_identity: this database is enrolled as `rehearsal`; promoting a rehearsal database to `production` is not a step of §9.1."
          : "deployment_identity: this database is enrolled as `production`; RM_ENV=stage never confirms a production database (§4.3, D61). Nothing was written.",
      );
    }
    if (expected === "rehearsal") {
      // Read, reported, never rewritten: the row is the remote rehearsal pass's.
      return { before: "rehearsal", row: before.row, written: false };
    }
    // The gates (RM_ENV=prod, the confirmation) and the no-rewrite rule are
    // enrollAsProduction's: on a `production` row it returns that row as found.
    const row = await enrollAsProduction(store, { rmEnv: options.rmEnv, confirmed: options.confirmed, note: options.note });
    return { before: "production", row, written: false };
  });
}
