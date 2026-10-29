// The api's answer to a database failure: 503 with a named reason, or null for
// a handler bug, which stays a 500 (issue #968, issue 1034). Its own module so a
// test can reach it without importing api/index.ts, which binds a port.
import { classifyDbFailure } from "../db/client.ts";
import { DbSaturatedError } from "../db/pool-gate.ts";

/** Seconds a refused caller should wait before retrying a saturated or timed-out request. */
export const DB_RETRY_AFTER_SECONDS = 1;

/** A 503 JSON response naming why the database could not answer, or null when `err` is not a database failure. */
export function dbFailureResponse(err: unknown): Response | null {
  const failure = classifyDbFailure(err);
  if (failure === null) return null;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (failure !== "database unavailable") headers["Retry-After"] = String(DB_RETRY_AFTER_SECONDS);
  return new Response(JSON.stringify({ error: failure }), { status: 503, headers });
}

/**
 * The first words of the api's error log for a database failure. A refusal by
 * an admission gate names the gate that refused (issue 1514): the batch or
 * request pool, or a pipeline token's gate (`pipeline:<instance>/<holder>`), so
 * a db_saturated line says which cap was full without reading the error's
 * stack. The "api error (<status> <path>)" prefix is kept for every reader of
 * the old line.
 */
export function dbFailureLogPrefix(status: number, pathname: string, err: unknown): string {
  if (err instanceof DbSaturatedError) return `api error (${status} ${pathname}) db_saturated gate=${err.pool}:`;
  return `api error (${status} ${pathname}):`;
}
