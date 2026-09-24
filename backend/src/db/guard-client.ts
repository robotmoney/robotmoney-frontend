// The bounded connection the three boot integrity guards share, in a module
// that issues no statement and registers no query.
//
// WHY IT IS ITS OWN MODULE (issue #1026 W2). It used to live in
// ./handle-namespace.ts, and ./append-only-guard.ts and
// ./analytics-ledger-guard.ts imported it from there. handle-namespace.ts is a
// domain store: it reads `swarm_members`, so it declares that read in the query
// registry (smoke-production-spec.md §7.1). Importing it for a connection
// factory pulled that declaration into every module graph that holds the
// append-only guard — preflight.ts's own included — so a process that only
// meant to run preflight also demanded `swarm_members` privileges from check 2.
// A connection factory carries no declaration, so the guards import it from
// here and the handle-namespace declaration stays with the programs that
// actually issue the read.
//
// The rationale for the timeouts themselves is on handle-namespace.ts's
// createNamespaceGuardClient, which is this function with its own default
// budget.
import postgres from "postgres";
import type postgresTypes from "postgres";
import { config } from "../config.ts";

/**
 * A single-connection client whose statements the SERVER abandons after half
 * `budgetMs` (statement and lock timeouts as startup parameters), and whose
 * connect attempt gives up on the same bound.
 *
 * Input: the guard's whole wall-clock budget in milliseconds. Output: a
 * postgres.js client the caller must `end()`.
 */
export function createBoundedGuardClient(budgetMs: number): postgresTypes.Sql<{}> {
  const perQueryMs = Math.max(1_000, Math.floor(budgetMs / 2));
  return postgres(config.databaseUrl, {
    max: 1,
    onnotice: () => {},
    connect_timeout: Math.max(1, Math.round(perQueryMs / 1000)),
    connection: {
      statement_timeout: perQueryMs,
      lock_timeout: perQueryMs,
    },
  });
}

/** The name both guards already call it by. */
export const createNamespaceGuardClient = createBoundedGuardClient;
