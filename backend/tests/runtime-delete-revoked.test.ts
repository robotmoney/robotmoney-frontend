// No runtime role holds DELETE or TRUNCATE on any table, on a blank boot or on
// an upgraded database — issue #1026 criterion 171, decision D55 (6),
// smoke-production-spec.md §3 and §9.1 step 3.
//
// D55 (6): "No runtime role (`rm_app`, `rm_worker`, `rm_readonly`) holds
// `DELETE` or `TRUNCATE` on any table, append-only or not." §9.1 step 3: "Grant
// transition — migrations revoking `DELETE` and `TRUNCATE` on every table from
// every runtime role (0053 granted `DELETE` on all tables)." That transition is
// migration 0089; backend/schema/grants.sql re-asserts it on every migrate run.
//
// THE TWO DATABASES, each built the way real ones are:
//   blank      — backend/schema/ bootstrapped by rm_owner, the `--local blank`
//                path (tests/support/startup-preflight.ts
//                createSnapshotTemplate).
//   upgraded   — production's observed ledger, the one supported upgrade
//                source (D55 (8), backend/tests/fixtures/releases/
//                production-2026-09-25), rebuilt from its own migration bytes
//                by its own runner loop, then taken to this branch by the real
//                `bun run migrate` under a terminal: RM_ENV=prod, the typed
//                rm_owner password and an explicit `y` — the first production
//                migrate (§9.1, D55 (5)), which applies 0089. Before that run
//                the release really does grant the runtime roles DELETE (its
//                0053), which is asserted, so the pass after it is the
//                migration's doing.
//
// EVERY REFUSAL IS A REAL LOGIN: rm_app, rm_worker and rm_readonly each connect
// as themselves and get 42501 from the executor. And rm_owner, logged in the
// same way, still deletes: the privilege moved to the one role that may hold
// it, it did not disappear.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import postgres from "postgres";
import { adminUrl } from "./support/cluster.ts";
import { SUPPORTED_RELEASES } from "../src/db/supported-releases.ts";
import {
  applyAsReleaseRunner,
  loadBaseline,
  migrateAtTerminal,
  releaseSteps,
  restoreLogins,
  restoreRoles,
  revokeLoginDefaults,
  saveRoles,
  type SavedRole,
} from "./fixtures/releases/release-fixture.ts";
import { connectAdmin, createSnapshotTemplate, databaseUrl, dropDatabases } from "./support/startup-preflight.ts";

const LOGIN = new URL(adminUrl()).username;
const PASSWORD = randomBytes(12).toString("hex");
const RUNTIME = ["rm_app", "rm_worker", "rm_readonly"] as const;
const suffix = crypto.randomUUID().slice(0, 8);
const UPGRADED_DB = `rm_delete_revoked_upgraded_${suffix}`;

let admin: postgres.Sql<{}>;
let savedRoles: SavedRole[] = [];
let blankDb = "";
const created: string[] = [];
const homes: string[] = [];
/** Held DELETE/TRUNCATE on the release, before the upgrade ran: the red control. */
let heldBeforeUpgrade: string[] = [];
/** The wallet repair pass's evidence copy: rm_worker's INSERT, before the upgrade (0091's red control). */
let evidenceInsertBeforeUpgrade: Record<string, boolean> = {};
const EVIDENCE_TABLES = ["wallet_balance_sample_evidence", "wallet_sleeve_sample_evidence"] as const;

async function workerEvidenceInsert(db: postgres.Sql<{}>): Promise<Record<string, boolean>> {
  const rows = (await db`
    SELECT t, has_table_privilege('rm_worker', 'public.' || t, 'INSERT') AS may
      FROM unnest(${[...EVIDENCE_TABLES]}::text[]) AS t ORDER BY t`) as unknown as { t: string; may: boolean }[];
  return Object.fromEntries(rows.map((r) => [r.t, r.may]));
}

/** Every (role, relation, privilege) a runtime role holds DELETE or TRUNCATE on. */
async function runtimeDeleteGrants(db: postgres.Sql<{}>): Promise<string[]> {
  const rows = (await db`
    SELECT r.rolname || ' ' || c.oid::regclass::text || ' ' || p.privilege AS item
      FROM unnest(${[...RUNTIME]}::text[]) AS r(rolname)
     CROSS JOIN pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     CROSS JOIN (VALUES ('DELETE'), ('TRUNCATE')) AS p(privilege)
     WHERE n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'
       AND c.relkind IN ('r', 'p', 'v', 'f')
       AND has_table_privilege(r.rolname, c.oid, p.privilege)
     ORDER BY 1`) as unknown as { item: string }[];
  return rows.map((r) => r.item);
}

/** How many application tables the check covered: a check of nothing proves nothing. */
async function tableCount(db: postgres.Sql<{}>): Promise<number> {
  const [row] = (await db`
    SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')`) as unknown as { n: number }[];
  return row!.n;
}

async function sqlstate(db: postgres.Sql<{}>, statement: string): Promise<string | null> {
  try {
    await db.unsafe(statement);
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? "no-sqlstate";
  }
}

async function asLogin<T>(database: string, role: string, body: (db: postgres.Sql<{}>) => Promise<T>): Promise<T> {
  const db = postgres(databaseUrl(database, { name: role, password: PASSWORD }), { max: 1, onnotice: () => {} });
  try {
    const [{ who }] = (await db`SELECT current_user AS who`) as unknown as { who: string }[];
    expect(who).toBe(role);
    return await body(db);
  } finally {
    await db.end({ timeout: 5 });
  }
}

beforeAll(async () => {
  admin = connectAdmin();
  savedRoles = await saveRoles(admin);

  blankDb = await createSnapshotTemplate("delete_revoked_blank");
  created.push(blankDb);

  // The production baseline, as its own runner built it.
  const release = loadBaseline(SUPPORTED_RELEASES[0]!.name);
  await admin.unsafe(`CREATE DATABASE ${UPGRADED_DB}`);
  created.push(UPGRADED_DB);
  const db = connectAdmin(UPGRADED_DB);
  try {
    try {
      await applyAsReleaseRunner(db, releaseSteps(release));
    } finally {
      // The release's 0053 re-attributed the cluster's roles; put them back
      // before anything else in this process can observe them.
      await restoreLogins(admin, savedRoles);
    }
    heldBeforeUpgrade = await runtimeDeleteGrants(db);
    evidenceInsertBeforeUpgrade = await workerEvidenceInsert(db);
    // Production's shape: the provisioning login's own defaults are not the
    // schema's (§9.1 step 3's provisioning half).
    await revokeLoginDefaults(db, LOGIN);
  } finally {
    await db.end({ timeout: 5 });
  }

  for (const role of ["rm_owner", ...RUNTIME]) await admin.unsafe(`ALTER ROLE ${role} LOGIN PASSWORD '${PASSWORD}'`);

  // The first production migrate, as the operator runs it.
  const run = await migrateAtTerminal({
    databaseUrl: new URL(databaseUrl(UPGRADED_DB)),
    readonlyPassword: PASSWORD,
    rmEnv: "prod",
    steps: [
      { await: "rm_owner password (not echoed", send: PASSWORD },
      { await: "type y to continue", send: "y" },
    ],
  });
  homes.push(run.home);
  if (run.code !== 0) throw new Error(`bun run migrate failed (exit ${run.code}):\n${run.screen.slice(-3000)}`);
}, 300_000);

afterAll(async () => {
  try {
    await restoreRoles(admin, savedRoles);
  } finally {
    await admin.end({ timeout: 5 });
    await dropDatabases(created);
    for (const home of homes) rmSync(home, { recursive: true, force: true });
  }
});

describe("the grant (catalog): no runtime role holds DELETE or TRUNCATE on any table", () => {
  test("RED CONTROL: the production baseline, before the upgrade, grants the runtime roles DELETE (its 0053)", () => {
    // If the release granted nothing, the pass below would prove nothing about
    // 0089. It granted rm_app DELETE on every ordinary table and rm_worker
    // DELETE on its allowlist.
    expect(heldBeforeUpgrade.filter((item) => item.startsWith("rm_app ") && item.endsWith(" DELETE")).length).toBeGreaterThan(40);
    expect(heldBeforeUpgrade).toContain("rm_app jobs DELETE");
    expect(heldBeforeUpgrade).toContain("rm_worker jobs DELETE");
  });

  for (const [label, name] of [
    ["a blank bootstrap", () => blankDb],
    ["the production baseline after `bun run migrate`", () => UPGRADED_DB],
  ] as const) {
    test(`${label}: has_table_privilege is false for DELETE and TRUNCATE, for every runtime role, on every table`, async () => {
      const db = connectAdmin(name());
      try {
        expect(await tableCount(db)).toBeGreaterThan(50);
        expect(await runtimeDeleteGrants(db)).toEqual([]);
        // And no default privilege hands either one to a runtime role later.
        const defaults = (await db`
          SELECT pg_get_userbyid(d.defaclrole) AS owner, d.defaclacl::text AS acl
            FROM pg_default_acl d
           WHERE d.defaclobjtype = 'r'`) as unknown as { owner: string; acl: string }[];
        for (const { owner, acl } of defaults) {
          expect({ owner, acl: /rm_(app|worker|readonly)=[a-zA-Z]*[dD]/.test(acl) ? acl : "clean" }).toEqual({ owner, acl: "clean" });
        }
      } finally {
        await db.end({ timeout: 5 });
      }
    });
  }

  test("the upgrade recorded 0089 as breaking, and 0088 with it", async () => {
    const db = connectAdmin(UPGRADED_DB);
    try {
      const rows = (await db`
        SELECT name, compat FROM schema_migrations
         WHERE name IN ('0088_webauthn_challenge_slots.sql', '0089_revoke_runtime_delete.sql') ORDER BY name`) as unknown as {
        name: string;
        compat: string;
      }[];
      expect(rows).toEqual([
        { name: "0088_webauthn_challenge_slots.sql", compat: "breaking" },
        { name: "0089_revoke_runtime_delete.sql", compat: "breaking" },
      ]);
    } finally {
      await db.end({ timeout: 5 });
    }
  });
});

describe("the executor (real logins): each runtime role gets 42501, and rm_owner still deletes", () => {
  for (const [label, name] of [
    ["a blank bootstrap", () => blankDb],
    ["the upgraded production baseline", () => UPGRADED_DB],
  ] as const) {
    test(`${label}: rm_app, rm_worker and rm_readonly are each refused DELETE and TRUNCATE on jobs, and DELETE on admin_session`, async () => {
      for (const role of RUNTIME) {
        const refused = await asLogin(name(), role, async (db) => ({
          "DELETE jobs": await sqlstate(db, "DELETE FROM jobs WHERE false"),
          "TRUNCATE jobs": await sqlstate(db, "TRUNCATE jobs"),
          "DELETE admin_session": await sqlstate(db, "DELETE FROM admin_session WHERE false"),
        }));
        expect({ role, refused }).toEqual({
          role,
          refused: {
            "DELETE jobs": "42501",
            "TRUNCATE jobs": "42501",
            "DELETE admin_session": "42501",
          },
        });
      }
    });

    test(`${label}: rm_owner, logged in as itself, deletes a row`, async () => {
      const removed = await asLogin(name(), "rm_owner", async (db) => {
        const [job] = (await db`
          INSERT INTO jobs (kind, payload) VALUES ('rm.delete.revoked.probe', '{}') RETURNING id`) as unknown as { id: number }[];
        return (await db`DELETE FROM jobs WHERE id = ${job!.id} RETURNING id`).length;
      });
      expect(removed).toBe(1);
    });
  }
});

describe("rm_worker may INSERT the wallet repair pass's evidence, and nothing more on it (0091)", () => {
  test("RED CONTROL: the production baseline, before the upgrade, gives rm_worker no INSERT on either evidence table", () => {
    // 0054's allowlist left both off; so the repair pass's evidence copy (src/ops/
    // wallet-backfill.ts repairResolvedDay) failed 42501 for every incomplete day.
    expect(evidenceInsertBeforeUpgrade).toEqual({
      wallet_balance_sample_evidence: false,
      wallet_sleeve_sample_evidence: false,
    });
  });

  for (const [label, name] of [
    ["a blank bootstrap", () => blankDb],
    ["the upgraded production baseline", () => UPGRADED_DB],
  ] as const) {
    test(`${label}: a real rm_worker login inserts an evidence row in each table, and cannot UPDATE or DELETE one`, async () => {
      const outcome = await asLogin(name(), "rm_worker", async (db) => {
        const inserted: Record<string, number> = {};
        const rollback = new Error("rollback: rm_worker cannot remove what it inserted, so the probe row never commits");
        await db
          .begin(async (tx) => {
            const original = -Math.floor(Math.random() * 1e9) - 1;
            inserted.wallet_balance_sample_evidence = (
              await tx`
                INSERT INTO wallet_balance_sample_evidence
                  (original_id, sample_date, symbol, value_usd, provenance, sampled_at, evidence_reason)
                VALUES (${original}, '2026-01-01', 'USDC', 1, 'probe', now(), 'incomplete-snapshot-replacement')
                RETURNING evidence_id`
            ).length;
            inserted.wallet_sleeve_sample_evidence = (
              await tx`
                INSERT INTO wallet_sleeve_sample_evidence
                  (original_id, sample_date, wallet_address, symbol, provenance, sampled_at, evidence_reason)
                VALUES (${original}, '2026-01-01', '0xprobe', 'USDC', 'probe', now(), 'incomplete-snapshot-replacement')
                RETURNING evidence_id`
            ).length;
            throw rollback;
          })
          .catch((error) => {
            if (error !== rollback) throw error;
          });
        const refused: Record<string, string | null> = {};
        for (const table of EVIDENCE_TABLES) {
          refused[`UPDATE ${table}`] = await sqlstate(db, `UPDATE ${table} SET provenance = provenance WHERE false`);
          refused[`DELETE ${table}`] = await sqlstate(db, `DELETE FROM ${table} WHERE false`);
        }
        return { inserted, refused };
      });
      expect(outcome).toEqual({
        inserted: { wallet_balance_sample_evidence: 1, wallet_sleeve_sample_evidence: 1 },
        refused: {
          "UPDATE wallet_balance_sample_evidence": "42501",
          "DELETE wallet_balance_sample_evidence": "42501",
          "UPDATE wallet_sleeve_sample_evidence": "42501",
          "DELETE wallet_sleeve_sample_evidence": "42501",
        },
      });
    });
  }
});
