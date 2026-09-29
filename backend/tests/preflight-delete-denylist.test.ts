// Preflight check 2 refuses DELETE or TRUNCATE on ANY table, for every runtime
// role — issue #1026 criteria 171 and 104, decision D55 (6),
// smoke-production-spec.md §7 check 2.
//
// §7 check 2's denylist: "superuser; `CREATEROLE`; membership in `rm_owner`;
// ownership of any application object; DDL; `DELETE` or `TRUNCATE` on any
// table (§3, D55 (6))." D55 (6): "Preflight's denylist widens from append-only
// tables to every table." Before it the rule read a list — the append-only set,
// the ledgers and the two stream tables — so a DELETE grant on an ordinary
// table such as `jobs` passed preflight. Each case below plants exactly that
// grant, which the narrower rule never saw: it is the red control for the
// widening, not a restatement of the append-only cases
// (tests/db-preflight-checks.test.ts keeps those).
//
// Every grant is planted in this file's own database (useCleanDatabase), where
// migration 0089 has already revoked every runtime DELETE, and revoked again in
// `finally`. The assertions read the denylist (`findDenylistViolations`) and
// the check's own refusal text (`checkPrivileges`), never a statement that
// would delete.
import { describe, expect, test } from "bun:test";
import { sql } from "../src/db/client.ts";
import { checkPrivileges, findDenylistViolations, type PreflightContext } from "../src/db/preflight.ts";
import { useCleanDatabase } from "./support/clean-db.ts";
import { fixtureDb } from "./support/fixture-db.ts";

useCleanDatabase(import.meta.file);

const RUNTIME = ["rm_app", "rm_worker", "rm_readonly"] as const;

const context: PreflightContext = {
  env: "stage",
  connection: "local",
  roles: [...RUNTIME],
  codeFilenames: [],
  envFilePath: "/nonexistent",
};

/** check 2's refusals that name `table`, one line each. */
async function refusalsOn(table: string): Promise<string[]> {
  const result = await checkPrivileges(sql, context);
  return result.findings
    .filter((f) => f.severity === "refuse" && f.message.includes(` holds DELETE/TRUNCATE on ${table}`))
    .map((f) => f.message)
    .sort();
}

describe("check 2's DELETE/TRUNCATE rule covers every table (D55 (6))", () => {
  test("the clean database passes: no runtime role holds DELETE or TRUNCATE anywhere", async () => {
    expect(await findDenylistViolations(sql, RUNTIME)).toEqual([]);
    expect(await refusalsOn("jobs")).toEqual([]);
  });

  for (const role of RUNTIME) {
    for (const privilege of ["DELETE", "TRUNCATE"] as const) {
      test(`a planted ${privilege} grant on the ordinary table jobs fails check 2 for ${role}, naming the table, the role and D55 (6)`, async () => {
        await fixtureDb.unsafe(`GRANT ${privilege} ON jobs TO ${role}`);
        try {
          const violations = await findDenylistViolations(sql, RUNTIME);
          expect(violations).toEqual([{ rule: "append_only_write", role, object: "jobs" }]);
          expect(await refusalsOn("jobs")).toEqual([
            `${role} holds DELETE/TRUNCATE on jobs: only rm_owner may DELETE or TRUNCATE, on any table (D55 (6)). ` +
              "Migration 0089 revokes both from every runtime role and every migrate run re-asserts it, so this " +
              "database has not reached 0089, or a grant re-widened it since",
          ]);
        } finally {
          await fixtureDb.unsafe(`REVOKE ${privilege} ON jobs FROM ${role}`);
        }
        expect(await findDenylistViolations(sql, RUNTIME)).toEqual([]);
      });
    }
  }

  test("every table is covered, not a list: a grant on each of three unrelated tables is three refusals", async () => {
    // One table each from the admin surface, the pipeline and the projects
    // roster, none of them append-only, a ledger or a stream table.
    const tables = ["admin_session", "wallet_balance_samples", "tracked_wallets"];
    await fixtureDb.unsafe(`GRANT DELETE ON ${tables.join(", ")} TO rm_worker`);
    try {
      const violations = await findDenylistViolations(sql, ["rm_worker"]);
      expect(violations.map((v) => v.object).sort()).toEqual([...tables].sort());
    } finally {
      await fixtureDb.unsafe(`REVOKE DELETE ON ${tables.join(", ")} FROM rm_worker`);
    }
  });

  test("a view counts too: an updatable view passes a DELETE through to its table", async () => {
    await fixtureDb.unsafe("CREATE VIEW rm_denylist_planted_view AS SELECT * FROM jobs");
    try {
      await fixtureDb.unsafe("GRANT DELETE ON rm_denylist_planted_view TO rm_app");
      expect(await findDenylistViolations(sql, ["rm_app"])).toContainEqual({
        rule: "append_only_write",
        role: "rm_app",
        object: "rm_denylist_planted_view",
      });
    } finally {
      await fixtureDb.unsafe("DROP VIEW rm_denylist_planted_view");
    }
  });

  test("a table with a reason of its own keeps it: the event log's refusal names the prune rule (D55 (12))", async () => {
    await fixtureDb.unsafe("GRANT DELETE ON swarm_stream_events TO rm_app");
    try {
      expect(await refusalsOn("swarm_stream_events")).toEqual([
        "rm_app holds DELETE/TRUNCATE on swarm_stream_events, which D53 (2) keeps revoked from the runtime roles: " +
          "only rm_owner prunes it, with the manual `bun run prune`, and only rows older than its retention window " +
          "of at least 7 days (D55 (12))",
      ]);
    } finally {
      await fixtureDb.unsafe("REVOKE DELETE ON swarm_stream_events FROM rm_app");
    }
  });
});
