// [smoke-capture] — the pure half of `bun smoke:capture`
// (backend/scripts/smoke-twin-capture.ts), runnable with Docker unreachable.
//
// Issue #1026 criterion 37: capture connects as rm_readonly to a node that
// serves reads, performs no write, and refuses a primary or a non-readonly
// credential. The runtime proof — main() against a real primary and a real hot
// standby — lives in backend/tests/smoke-twin-capture.test.ts. This file pins
// the decisions that proof depends on: the argument surface has no override
// (D53 decision 5), captureRefusal refuses every non-readonly shape with a
// message that names the problem, and the dump environment carries the
// read-only belt.
import { describe, expect, test } from "bun:test";
import {
  captureRefusal,
  parseArgs,
  READ_ONLY_PGOPTIONS,
  readOnlyDumpEnv,
} from "../../../backend/scripts/smoke-twin-capture.ts";
import type { CaptureProbe } from "../../../backend/scripts/smoke-twin-capture.ts";

/** A probe that passes every rule: rm_readonly, read-only session, standby. */
function clean(overrides: Partial<CaptureProbe> = {}): CaptureProbe {
  return {
    transactionReadOnly: "on",
    role: "rm_readonly",
    inRecovery: true,
    serverVersion: "PostgreSQL 18.6",
    attributes: [],
    writeCapabilities: [],
    ...overrides,
  };
}

describe("argument surface — there is no override", () => {
  test("--allow-primary is an unknown flag", () => {
    expect(parseArgs(["--allow-primary"])).toEqual({ error: 'unknown flag "--allow-primary".' });
  });

  test("--allow-primary beside valid flags is still refused, never silently dropped", () => {
    expect(parseArgs(["--out", "/srv/b", "--allow-primary"])).toEqual({ error: 'unknown flag "--allow-primary".' });
  });

  test("the parsed args carry only --out and --env-file", () => {
    const a = parseArgs(["--out", "/srv/b", "--env-file", "/srv/e"]);
    if ("error" in a) throw new Error(a.error);
    expect(Object.keys(a).sort()).toEqual(["envFile", "out"]);
  });

  test("a flag missing its value is an error", () => {
    expect(parseArgs(["--env-file"])).toEqual({ error: "--env-file requires a value." });
  });
});

describe("captureRefusal — the refusal rule", () => {
  test("rm_readonly, read-only session, on a standby: proceeds", () => {
    expect(captureRefusal(clean())).toBeUndefined();
  });

  test("a primary is refused, with no override offered", () => {
    const why = captureRefusal(clean({ inRecovery: false }));
    expect(why).toContain("pg_is_in_recovery() is FALSE");
    expect(why).toContain("PRIMARY");
    expect(why).toContain("There is no override");
    expect(why).not.toContain("--allow-primary");
  });

  test("a writeable session is refused, whatever else is true", () => {
    const why = captureRefusal(clean({ transactionReadOnly: "off" }));
    expect(why).toContain("SHOW transaction_read_only = 'off'");
    expect(why).toContain("WRITEABLE");
  });

  test("an empty SHOW answer is not 'on' — the session is not proven read-only", () => {
    expect(captureRefusal(clean({ transactionReadOnly: "" }))).toContain("WRITEABLE");
  });

  test("any current_user other than rm_readonly is refused", () => {
    for (const role of ["doadmin", "rm_app", "rm_worker", "rm_owner", "robotmoney", "RM_READONLY"]) {
      expect(captureRefusal(clean({ role }))).toContain(`current_user '${role}', not 'rm_readonly'`);
    }
  });

  test("a role attribute is refused and named", () => {
    const why = captureRefusal(clean({ attributes: ["SUPERUSER", "BYPASSRLS"] }));
    expect(why).toContain("rm_readonly carries SUPERUSER, BYPASSRLS");
    expect(why).toContain("not a read-only credential");
  });

  test("a write capability is refused and each one is listed", () => {
    const why = captureRefusal(
      clean({ writeCapabilities: ["table public.planted: INSERT", "schema public: CREATE"] }),
    );
    expect(why).toContain("holds 2 write capability(ies)");
    expect(why).toContain("not a read-only credential");
    expect(why).toContain("  table public.planted: INSERT");
    expect(why).toContain("  schema public: CREATE");
    expect(why).toContain("REVOKE them");
  });

  test("a long list is truncated to five with a count of the rest", () => {
    const caps = Array.from({ length: 8 }, (_, i) => `table public.t${i}: DELETE`);
    const why = captureRefusal(clean({ writeCapabilities: caps })) ?? "";
    expect(why).toContain("  table public.t4: DELETE");
    expect(why).not.toContain("table public.t5");
    expect(why).toContain("…and 3 more");
  });

  test("a writer credential on a primary is refused as a WRITER first, so the operator fixes the credential", () => {
    const why = captureRefusal(clean({ inRecovery: false, writeCapabilities: ["table public.planted: INSERT"] }));
    expect(why).toContain("not a read-only credential");
    expect(why).not.toContain("pg_is_in_recovery");
  });

  test("the wrong role is reported before its capabilities", () => {
    const why = captureRefusal(clean({ role: "doadmin", attributes: ["SUPERUSER"], writeCapabilities: ["x"] }));
    expect(why).toContain("current_user 'doadmin'");
  });
});

describe("the dump environment — pg_dump and pg_dumpall run read-only", () => {
  test("PGOPTIONS pins default_transaction_read_only=on", () => {
    expect(READ_ONLY_PGOPTIONS).toBe("-c default_transaction_read_only=on");
    expect(readOnlyDumpEnv()).toEqual({ PGOPTIONS: "-c default_transaction_read_only=on" });
  });

  test("an operator's exported PGOPTIONS is replaced, not merged", () => {
    const prev = process.env.PGOPTIONS;
    process.env.PGOPTIONS = "-c default_transaction_read_only=off";
    try {
      expect(readOnlyDumpEnv().PGOPTIONS).toBe(READ_ONLY_PGOPTIONS);
    } finally {
      if (prev === undefined) delete process.env.PGOPTIONS;
      else process.env.PGOPTIONS = prev;
    }
  });
});
