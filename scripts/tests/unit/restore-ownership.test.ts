// The twin's post-restore ownership step (scripts/lib/restore-container.ts).
// Checked against a real Postgres 18 by hand on 2026-09-25; these pin its shape.
import { describe, expect, test } from "bun:test";
import { postTaxonomyOwnershipSql } from "../../lib/restore-container.ts";

describe("postTaxonomyOwnershipSql", () => {
  const sql = postTaxonomyOwnershipSql();

  test("gives rm_owner the schema, relations, sequences and routines", () => {
    expect(sql).toContain("ALTER SCHEMA public OWNER TO rm_owner");
    expect(sql).toContain("OWNER TO rm_owner");
    expect(sql).toContain("ALTER ROUTINE");
  });

  test("leaves extension-owned objects alone (a non-owner cannot re-own them, and should not)", () => {
    expect(sql).toContain("d.deptype = 'e'");
  });

  test("does nothing on a pre-0053 twin that has no rm_owner", () => {
    expect(sql).toContain("IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'rm_owner')");
  });
});
