// The legacy v0.5 upgrade preflights read rm_owner's attributes, and D47 moved
// what those attributes should be.
//
// WHY THIS FILE EXISTS. 0053 now creates rm_owner LOGIN (D47: rm_owner is the
// migration login, spec §3), and scripts/ops/provision-db-role-taxonomy.sh
// verifies LOGIN. Both upgrade preflights' `role-readiness` records used to
// FAIL on a LOGIN owner ("0053 creates it NOLOGIN"), so after that edit they
// refused every fresh database and every database §9.1 step 1 had been applied
// to, with a message that was no longer true about 0053. No test covered them.
//
// These cases run each real `roleReadinessCheck` against the suite's cluster:
//   - rm_owner LOGIN without CREATEROLE raises no owner problem;
//   - rm_owner NOLOGIN does not change the verdict, and the record names §9.1
//     step 1 as the thing the next `bun run migrate` needs;
//   - rm_owner CREATEROLE fails.
// rm_owner is a cluster-wide role, so its original attributes are read first
// and restored exactly afterwards.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createChecker, type CheckResult } from "../scripts/lib/checks.ts";
import { roleReadinessCheck as check050 } from "../scripts/upgrades/0.4.0-to-0.5.0/preflight.ts";
import { roleReadinessCheck as check051 } from "../scripts/upgrades/0.5.0-to-0.5.1/preflight.ts";
import { sql } from "../src/db/client.ts";

let original: { rolcanlogin: boolean; rolcreaterole: boolean } | null = null;

beforeAll(async () => {
  const [row] = await sql<{ rolcanlogin: boolean; rolcreaterole: boolean }[]>`
    SELECT rolcanlogin, rolcreaterole FROM pg_roles WHERE rolname = 'rm_owner'`;
  if (!row) throw new Error("rm_owner does not exist on the test cluster");
  original = { rolcanlogin: row.rolcanlogin, rolcreaterole: row.rolcreaterole };
});

afterAll(async () => {
  if (original === null) return;
  await sql.unsafe(
    `ALTER ROLE rm_owner ${original.rolcanlogin ? "LOGIN" : "NOLOGIN"} ${original.rolcreaterole ? "CREATEROLE" : "NOCREATEROLE"}`,
  );
});

async function roleReadiness(check: typeof check050): Promise<CheckResult> {
  const checker = createChecker("[test]");
  await check(sql, checker);
  const result = checker.results.find((r) => r.name === "role-readiness");
  if (!result) throw new Error("roleReadinessCheck recorded no role-readiness result");
  return result;
}

for (const [label, check] of [
  ["0.4.0-to-0.5.0", check050],
  ["0.5.0-to-0.5.1", check051],
] as const) {
  describe(`${label} preflight — role-readiness reads rm_owner the way D47 left it`, () => {
    test("rm_owner LOGIN without CREATEROLE raises no rm_owner problem", async () => {
      await sql.unsafe("ALTER ROLE rm_owner LOGIN NOCREATEROLE");
      const result = await roleReadiness(check);
      expect(result.detail.filter((line) => /^rm_owner (is|holds)/.test(line))).toEqual([]);
      expect(result.detail.join("\n")).not.toContain("0053 creates it NOLOGIN");
    });

    test("rm_owner NOLOGIN leaves the verdict unchanged and names §9.1 step 1", async () => {
      await sql.unsafe("ALTER ROLE rm_owner LOGIN NOCREATEROLE");
      const withLogin = await roleReadiness(check);
      await sql.unsafe("ALTER ROLE rm_owner NOLOGIN NOCREATEROLE");
      try {
        const withoutLogin = await roleReadiness(check);
        expect(withoutLogin.status).toBe(withLogin.status);
        expect(withoutLogin.detail.some((line) => line.includes("§9.1 step 1"))).toBe(true);
      } finally {
        await sql.unsafe("ALTER ROLE rm_owner LOGIN");
      }
    });

    test("rm_owner CREATEROLE fails the record", async () => {
      await sql.unsafe("ALTER ROLE rm_owner LOGIN CREATEROLE");
      try {
        const result = await roleReadiness(check);
        expect(result.status).toBe("FAIL");
        expect(result.detail).toContain(
          "rm_owner holds CREATEROLE — 0053 never grants it, and role creation is doadmin's (spec §3)",
        );
      } finally {
        await sql.unsafe("ALTER ROLE rm_owner NOCREATEROLE");
      }
    });
  });
}
