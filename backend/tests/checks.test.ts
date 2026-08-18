// backend/scripts/lib/checks.ts — pure/structural pieces (createChecker,
// printVerdict) plus tableExists/columnExists against the suite's real
// ephemeral Postgres (preload.ts), which is fully migrated so both the
// present and absent cases are exercisable for real.
import { describe, expect, test } from "bun:test";
import postgres from "postgres";
import { columnExists, createChecker, printVerdict, tableExists } from "../scripts/lib/checks.ts";

describe("createChecker — a bound instance, not a module-level global", () => {
  test("two independent checkers do not share results", () => {
    const a = createChecker("[a] ");
    const b = createChecker("[b] ");
    a.record("x", "PASS", "ok");
    expect(a.results).toHaveLength(1);
    expect(b.results).toHaveLength(0);
  });

  test("record() stores status/detail/remediation and returns the same object pushed to results", () => {
    const c = createChecker("");
    const r = c.record("name", "WARN", ["line1", "line2"], "fix it");
    expect(c.results).toEqual([r]);
    expect(r).toEqual({ name: "name", status: "WARN", detail: ["line1", "line2"], remediation: "fix it" });
  });

  test("a single string detail is normalized to a one-element array", () => {
    const c = createChecker("");
    const r = c.record("name", "PASS", "single line");
    expect(r.detail).toEqual(["single line"]);
  });
});

describe("printVerdict", () => {
  const labels = { logPrefix: "", okAll: "OK-ALL", okWithWarnings: "OK-WARN", blocked: "BLOCKED" };

  test("no results at all -> clean, exit 0", () => {
    expect(printVerdict([], labels)).toBe(0);
  });

  test("only PASS -> exit 0", () => {
    expect(printVerdict([{ name: "a", status: "PASS", detail: ["ok"] }], labels)).toBe(0);
  });

  test("PASS + WARN, no FAIL -> still exit 0", () => {
    expect(
      printVerdict(
        [
          { name: "a", status: "PASS", detail: ["ok"] },
          { name: "b", status: "WARN", detail: ["hmm"] },
        ],
        labels,
      ),
    ).toBe(0);
  });

  test("any FAIL -> exit 1, regardless of how many PASS/WARN accompany it", () => {
    expect(
      printVerdict(
        [
          { name: "a", status: "PASS", detail: ["ok"] },
          { name: "b", status: "FAIL", detail: ["bad"] },
        ],
        labels,
      ),
    ).toBe(1);
  });
});

describe("tableExists / columnExists — against the suite's real migrated Postgres", () => {
  const sql = postgres(process.env.DATABASE_URL as string, { max: 1 });

  test("a table that exists (schema_migrations, always present post-migrate)", async () => {
    expect(await tableExists(sql, "schema_migrations")) .toBe(true);
  });

  test("a table that does not exist", async () => {
    expect(await tableExists(sql, "this_table_does_not_exist_anywhere")).toBe(false);
  });

  test("a column that exists post-migration (swarm_members.handle, added by 0030)", async () => {
    expect(await columnExists(sql, "swarm_members", "handle")).toBe(true);
  });

  test("a column that has never existed on any migration", async () => {
    expect(await columnExists(sql, "swarm_members", "this_column_never_existed")).toBe(false);
  });

  test("columnExists on a nonexistent table returns false, does not throw", async () => {
    expect(await columnExists(sql, "this_table_does_not_exist_anywhere", "x")).toBe(false);
  });
});
