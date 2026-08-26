// A smoke-twin, with a database connection open on it.
//
// WHY THIS IS A SEPARATE MODULE, and not another export of
// scripts/lib/restore-container.ts: `postgres` is a backend/package.json
// dependency. restore-container.ts lives in the root tree, which the smoke and
// stack tooling import, and dragging a backend-only driver into that graph to
// serve one caller would be the wrong trade. So the root tree owns the
// CONTAINER lifecycle (withSmokeTwinContainer) and this thin backend-side wrapper
// adds the CONNECTION lifecycle on top.
//
// Both halves guarantee cleanup in a `finally`, which is the whole point of the
// pair: a checker that returns early from the middle of its own try block is
// exactly how a container holding a copy of production, or a pool holding it
// open, gets left behind.
import postgres from "postgres";
import { withSmokeTwinContainer } from "../../../scripts/lib/restore-container.ts";
import type { Db } from "./preflight-utils.ts";

/**
 * Restore a backup into a throwaway container, open a connection to it, run
 * `fn`, then close the pool and tear the container down — in that order, on
 * every path including a throw.
 *
 * Returns `{ error, code: 2 }` when the smoke-twin could not be created at all, which
 * is the upgrade scripts' "could not run" exit code, distinct from 1 = "ran and
 * found a problem".
 */
export async function withSmokeSmokeTwinDatabase<T>(
  opts: { backupDir?: string; log: (m: string) => void; bindHost?: string },
  fn: (db: Db) => Promise<T>,
): Promise<T | { error: string; code: 2 }> {
  return withSmokeTwinContainer(opts, async (restored) => {
    const db = postgres({
      host: restored.host,
      port: restored.port,
      username: restored.username,
      password: restored.password,
      database: restored.database,
      max: 1,
    });
    try {
      return await fn(db);
    } finally {
      await db.end({ timeout: 5 });
    }
  });
}
