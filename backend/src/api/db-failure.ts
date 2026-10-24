// The api's answer to a database failure: 503 with a named reason, or null for
// a handler bug, which stays a 500 (issue #968, issue 1034). Its own module so a
// test can reach it without importing api/index.ts, which binds a port.
import { classifyDbFailure } from "../db/client.ts";

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
