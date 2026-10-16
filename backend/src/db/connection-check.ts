// The api's connection check: does the pool still answer? Object-less (D55 (13)),
// so it takes the registry's `connectionCheck` shape and declares no relation.
//
// Its own module, and not a statement in src/api/index.ts, because the entry
// binds a port at import: CI enumerates registrations by importing modules, and
// an entry cannot be one of them.
import { sql } from "./client.ts";
import { onStatement, registerStatement } from "./registry.ts";

const connectionCheck = registerStatement({
  role: "rm_app",
  shape: "connectionCheck",
  site: "src/db/connection-check:databaseAnswers",
  purpose: "Answer whether the api's pool still reaches the database, for GET /health.",
  callers: ["src/api/index"],
});

/** True when `SELECT 1` runs on the api's pool; false on any error. */
export async function databaseAnswers(): Promise<boolean> {
  try {
    await onStatement(sql, connectionCheck)`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}
