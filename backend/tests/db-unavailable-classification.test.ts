// The line between "the database is not reachable" and "this query is wrong"
// (issue #968). api/index.ts answers the first 503 { error: "database
// unavailable" } and the second 500 { error: "internal error" }, so this
// classifier decides which of those an operator — and the page's error banner
// — is told.
//
// The risk it carries is one-sided and worth stating: a MISSED outage is a
// cosmetic regression (a 500 where a 503 was warranted), while a FALSE positive
// relabels a real defect as an infrastructure blip and sends whoever is on the
// other end looking at the wrong system. Hence the negative cases below — the
// everyday SQLSTATEs a handler bug produces — are as load-bearing as the
// positive ones.
import { describe, expect, test } from "bun:test";
import { classifyDbFailure, isDatabaseUnavailable } from "../src/db/client.ts";
import { DbSaturatedError } from "../src/db/pool-gate.ts";
import { dbFailureResponse } from "../src/api/db-failure.ts";

// Shape of what actually arrives: postgres.js surfaces the socket error
// verbatim (verified against a refused connection — `code: "ECONNREFUSED"`,
// `errno: -111`, `syscall: "connect"`, and NO SQLSTATE), and server-side
// failures as an Error carrying the five-character SQLSTATE as `code`.
function pgError(code: string, message = "boom"): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

describe("isDatabaseUnavailable", () => {
  test("a refused, reset or unroutable connection is an outage", () => {
    for (const code of ["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "EPIPE", "ETIMEDOUT"]) {
      expect(isDatabaseUnavailable(pgError(code))).toBe(true);
    }
  });

  test("a hostname that does not resolve is an outage", () => {
    // What a compose stack gives when the `postgres` service is not running:
    // Docker's embedded DNS has no record for it at all.
    for (const code of ["ENOTFOUND", "EAI_AGAIN"]) {
      expect(isDatabaseUnavailable(pgError(code))).toBe(true);
    }
  });

  test("postgres.js's own connection-lifecycle codes are an outage", () => {
    for (const code of ["CONNECTION_CLOSED", "CONNECTION_DESTROYED", "CONNECTION_ENDED", "CONNECT_TIMEOUT"]) {
      expect(isDatabaseUnavailable(pgError(code))).toBe(true);
    }
  });

  test("SQLSTATE class 08 (connection exception) is an outage", () => {
    // 08000 connection_exception, 08003 connection_does_not_exist,
    // 08006 connection_failure, 08001 sqlclient_unable_to_establish_connection.
    for (const code of ["08000", "08001", "08003", "08006"]) {
      expect(isDatabaseUnavailable(pgError(code))).toBe(true);
    }
  });

  test("a server that is up but refusing connections is an outage", () => {
    // 57P03 cannot_connect_now — what a restarting or still-recovering
    // Postgres answers with, which is exactly the window a redeploy opens.
    expect(isDatabaseUnavailable(pgError("57P03"))).toBe(true);
  });

  // The other half of the contract. Every one of these is a defect in our own
  // code or data and must keep reporting as a 500.
  test("a broken query is NOT an outage", () => {
    const handlerBugs = [
      "42P01", // undefined_table — a typo'd or unmigrated relation
      "42703", // undefined_column
      "42601", // syntax_error
      "23505", // unique_violation
      "23503", // foreign_key_violation
      "22P02", // invalid_text_representation — a bad cast
      "40001", // serialization_failure — a retry concern, not an outage
      "57014", // query_canceled — a statement timeout, not a lost database
      "53300", // too_many_connections — saturation; the database is answering
    ];
    for (const code of handlerBugs) {
      expect(isDatabaseUnavailable(pgError(code)), `${code} must not be reported as an outage`).toBe(false);
    }
  });

  test("an error with no code, or no error at all, is NOT an outage", () => {
    expect(isDatabaseUnavailable(new Error("something went wrong"))).toBe(false);
    expect(isDatabaseUnavailable(new TypeError("undefined is not a function"))).toBe(false);
    expect(isDatabaseUnavailable({ code: 500 })).toBe(false);
    expect(isDatabaseUnavailable(undefined)).toBe(false);
    expect(isDatabaseUnavailable(null)).toBe(false);
    expect(isDatabaseUnavailable("ECONNREFUSED")).toBe(false);
  });
});

// Issue 1034: a busy database is a 503 too, with its own name, because it
// tells the caller to retry rather than that the database is gone. A
// statement the server cancelled (57014) or a lock it gave up on (55P03) is
// `db_timeout`; a query the api's pool refused to queue is `db_saturated`.
// Handler bugs keep their 500.
describe("classifyDbFailure", () => {
  test("57014 and 55P03 classify as db_timeout", () => {
    expect(classifyDbFailure(pgError("57014"))).toBe("db_timeout");
    expect(classifyDbFailure(pgError("55P03"))).toBe("db_timeout");
  });

  test("a refused admission classifies as db_saturated", () => {
    expect(classifyDbFailure(new DbSaturatedError("request", 500))).toBe("db_saturated");
  });

  test("an outage still classifies as database unavailable", () => {
    expect(classifyDbFailure(pgError("ECONNREFUSED"))).toBe("database unavailable");
    expect(classifyDbFailure(pgError("57P03"))).toBe("database unavailable");
  });

  test("42703 and 42P01 still classify as 500", () => {
    for (const code of ["42703", "42P01", "42601", "23505", "53300"]) {
      expect(classifyDbFailure(pgError(code)), code).toBeNull();
      expect(dbFailureResponse(pgError(code)), code).toBeNull();
    }
  });

  test("the response is 503 with the reason, and Retry-After for the busy cases only", async () => {
    const timeout = dbFailureResponse(pgError("57014"))!;
    expect(timeout.status).toBe(503);
    expect(await timeout.json()).toEqual({ error: "db_timeout" });
    expect(timeout.headers.get("retry-after")).toBe("1");
    const saturated = dbFailureResponse(new DbSaturatedError("request", 500))!;
    expect(await saturated.json()).toEqual({ error: "db_saturated" });
    expect(saturated.headers.get("retry-after")).toBe("1");
    const outage = dbFailureResponse(pgError("ECONNREFUSED"))!;
    expect(await outage.json()).toEqual({ error: "database unavailable" });
    expect(outage.headers.get("retry-after")).toBeNull();
  });
});
