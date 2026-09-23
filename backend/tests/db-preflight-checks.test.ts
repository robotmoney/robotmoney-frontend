// Preflight, checks 1-6 (spec §7) — the read-only checks that decide whether a
// database may be served.
//
// These tests are the specification for src/db/preflight.ts. Every function in
// that module throws `NOT IMPLEMENTED` today, so every test here fails; that is
// #1026 W2 step 2's deliverable, not a defect.
//
// THEY RUN AGAINST THE REAL EPHEMERAL POSTGRES (tests/preload.ts), in a
// database cloned for this file alone, because §7.3's whole point is that "CI
// end-to-end runs use the production roles and the production preflight" — a
// mocked catalog would prove nothing about `has_table_privilege`, `pg_has_role`
// or `pg_class.relowner`, which is where checks 1, 2 and 5 actually live.
//
// SEVERAL TESTS MUTATE CLUSTER-WIDE ROLE ATTRIBUTES (`rolsuper`,
// `rolcreaterole`, `rm_owner` membership). Roles are a property of the CLUSTER,
// not of this file's cloned database, so each one restores what it changed in a
// `finally` — a leaked `rm_app SUPERUSER` would make every later file in the
// run meaningless rather than red.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { APPEND_ONLY_TABLES } from "../src/db/append-only-guard.ts";
import { sql } from "../src/db/client.ts";
import {
  checkEnvCredentials,
  checkEnvIdentity,
  checkPrivileges,
  checkProdSchedules,
  checkRoleTokens,
  checkSchemaCompatibility,
  checkSchemaIntegrity,
  findDenylistViolations,
  missingPrivileges,
  preflightReportLines,
  runPreflight,
  type PreflightContext,
  type PreflightFinding,
} from "../src/db/preflight.ts";
import type { RmRole } from "../src/db/registry.ts";
import { SWARM_SCHEDULE_KINDS } from "../scripts/schedules-enable.ts";
import { useCleanDatabase } from "./support/clean-db.ts";

useCleanDatabase(import.meta.file);

const PASSWORDS: Record<"rm_app" | "rm_worker" | "rm_readonly", string> = {
  rm_app: "rm_app_preflight_password",
  rm_worker: "rm_worker_preflight_password",
  rm_readonly: "rm_readonly_preflight_password",
};

const RUNTIME_ROLES: readonly RmRole[] = ["rm_app", "rm_worker", "rm_readonly"];

let tmpDir = "";

beforeAll(async () => {
  for (const [role, password] of Object.entries(PASSWORDS)) {
    await sql.unsafe(`ALTER ROLE ${role} WITH LOGIN PASSWORD '${password}'`);
  }
  tmpDir = mkdtempSync(join(tmpdir(), "rm-preflight-env-"));
});

afterAll(async () => {
  // Leave the cluster exactly as the template built it.
  await sql.unsafe("ALTER ROLE rm_app NOSUPERUSER NOCREATEROLE");
  await sql.unsafe("ALTER ROLE rm_worker NOSUPERUSER NOCREATEROLE");
  await sql.unsafe("ALTER ROLE rm_readonly NOSUPERUSER NOCREATEROLE");
});

function context(over: Partial<PreflightContext> = {}): PreflightContext {
  return {
    env: "stage",
    connection: "local",
    roles: RUNTIME_ROLES,
    codeFilenames: [],
    envFilePath: join(tmpDir, "default.env"),
    ...over,
  };
}

function tokens(over: Partial<Record<RmRole, string>> = {}): ReadonlyMap<RmRole, string> {
  const map = new Map<RmRole, string>([
    ["rm_app", PASSWORDS.rm_app],
    ["rm_worker", PASSWORDS.rm_worker],
    ["rm_readonly", PASSWORDS.rm_readonly],
  ]);
  for (const [role, value] of Object.entries(over)) map.set(role as RmRole, value as string);
  return map;
}

function refusals(findings: readonly PreflightFinding[]): readonly PreflightFinding[] {
  return findings.filter((f) => f.severity === "refuse");
}

function writeEnvFile(name: string, lines: readonly string[]): string {
  const path = join(tmpDir, name);
  writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
  return path;
}

// ───────────────────────────────────────────────────────────────────────────
// Check 1 — every role token authenticates
// ───────────────────────────────────────────────────────────────────────────

describe("check 1 — every role token smoke will hand to a container authenticates", () => {
  test("passes with no findings when every role in the context has a working token", async () => {
    const result = await checkRoleTokens(context(), tokens());
    expect(result.check).toBe("roles_authenticate");
    expect(result.findings).toEqual([]);
  });

  test("refuses, naming the role, when a token does not authenticate", async () => {
    const result = await checkRoleTokens(context(), tokens({ rm_worker: "not-the-password" }));
    expect(refusals(result.findings)).toHaveLength(1);
    expect(result.findings[0]?.check).toBe("roles_authenticate");
    expect(result.findings[0]?.message).toContain("rm_worker");
  });

  test("refuses a role with NO token supplied — an absent token is how a container falls back to another credential", async () => {
    const partial = new Map<RmRole, string>([["rm_app", PASSWORDS.rm_app]]);
    const result = await checkRoleTokens(context({ roles: ["rm_app", "rm_worker"] }), partial);
    expect(refusals(result.findings)).toHaveLength(1);
    expect(result.findings[0]?.message).toContain("rm_worker");
  });

  test("reports every failing role, not the first, so one boot fixes them all", async () => {
    const result = await checkRoleTokens(context(), tokens({ rm_app: "wrong", rm_readonly: "wrong" }));
    const named = result.findings.map((f) => f.message).join(" ");
    expect(refusals(result.findings)).toHaveLength(2);
    expect(named).toContain("rm_app");
    expect(named).toContain("rm_readonly");
  });

  test("a container scope asks only about its own credential", async () => {
    const own = new Map<RmRole, string>([["rm_app", PASSWORDS.rm_app]]);
    const result = await checkRoleTokens(context({ roles: ["rm_app"] }), own);
    expect(result.findings).toEqual([]);
  });

  test("never logs a token value — a finding names the role and nothing else", async () => {
    const secret = "a-secret-that-must-not-be-printed";
    const result = await checkRoleTokens(context({ roles: ["rm_app"] }), new Map([["rm_app", secret]]));
    for (const finding of result.findings) {
      expect(finding.message).not.toContain(secret);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Check 2 — required privileges, and the denylist
// ───────────────────────────────────────────────────────────────────────────

describe("check 2, required half — the registry says what each role's programs need", () => {
  test("missingPrivileges reports nothing for a privilege the role actually holds", async () => {
    // 0053 line 129 grants rm_app SELECT/INSERT/UPDATE/DELETE on all tables.
    expect(await missingPrivileges(sql, "rm_app", "jobs", ["SELECT", "INSERT"])).toEqual([]);
  });

  test("missingPrivileges reports exactly the privileges the role lacks", async () => {
    // 0053 lines 136-137 give rm_readonly SELECT only.
    expect(await missingPrivileges(sql, "rm_readonly", "jobs", ["SELECT", "INSERT", "UPDATE"])).toEqual([
      "INSERT",
      "UPDATE",
    ]);
  });

  test("missingPrivileges refuses a relation that does not resolve in public — a registry bug, not a missing grant", async () => {
    await expect(missingPrivileges(sql, "rm_app", "no_such_relation_anywhere", ["SELECT"])).rejects.toThrow(
      "no_such_relation_anywhere",
    );
  });

  test("missingPrivileges never issues the statement the privilege would permit", async () => {
    const [before] = await sql<{ count: number }[]>`SELECT COUNT(*)::int AS count FROM jobs`;
    await missingPrivileges(sql, "rm_app", "jobs", ["DELETE", "TRUNCATE"]);
    const [after] = await sql<{ count: number }[]>`SELECT COUNT(*)::int AS count FROM jobs`;
    expect(after?.count).toBe(before?.count);
  });

  test("a missing required privilege refuses, naming the call site that declared it", async () => {
    const result = await checkPrivileges(sql, context({ roles: ["rm_readonly"] }));
    expect(result.check).toBe("privileges");
    for (const finding of refusals(result.findings)) {
      // Actionable means "which declaration asked for this", not "something is
      // missing somewhere": the site id is `<module>:<function>`.
      expect(finding.message).toMatch(/[a-z0-9/_-]+:[A-Za-z0-9_]+/);
    }
  });
});

describe("check 2, denylist half — the fixed list of things no runtime role may hold", () => {
  test("a runtime role marked SUPERUSER is a denylist violation", async () => {
    await sql.unsafe("ALTER ROLE rm_app SUPERUSER");
    try {
      const violations = await findDenylistViolations(sql, ["rm_app"]);
      expect(violations).toContainEqual({ rule: "superuser", role: "rm_app", object: null });
    } finally {
      await sql.unsafe("ALTER ROLE rm_app NOSUPERUSER");
    }
  });

  test("a runtime role holding CREATEROLE is a denylist violation — 0053 lines 49-52 pin NOCREATEROLE", async () => {
    await sql.unsafe("ALTER ROLE rm_worker CREATEROLE");
    try {
      const violations = await findDenylistViolations(sql, ["rm_worker"]);
      expect(violations).toContainEqual({ rule: "createrole", role: "rm_worker", object: null });
    } finally {
      await sql.unsafe("ALTER ROLE rm_worker NOCREATEROLE");
    }
  });

  test("a runtime role granted membership in rm_owner is a denylist violation", async () => {
    // 0053 line 56 grants rm_owner to `current_user` and says in its own
    // comment: "This is intentionally the current role, never either runtime
    // role." A runtime role that acquired it makes every other guard decorative.
    await sql.unsafe("GRANT rm_owner TO rm_app");
    try {
      const violations = await findDenylistViolations(sql, ["rm_app"]);
      expect(violations).toContainEqual({ rule: "rm_owner_membership", role: "rm_app", object: "rm_owner" });
    } finally {
      await sql.unsafe("REVOKE rm_owner FROM rm_app");
    }
  });

  test("a runtime role owning an application object is a denylist violation, naming the relation", async () => {
    await sql.unsafe("CREATE TABLE rm_preflight_owned_probe (id integer)");
    await sql.unsafe("ALTER TABLE rm_preflight_owned_probe OWNER TO rm_worker");
    try {
      const violations = await findDenylistViolations(sql, ["rm_worker"]);
      expect(violations).toContainEqual({
        rule: "object_ownership",
        role: "rm_worker",
        object: "rm_preflight_owned_probe",
      });
    } finally {
      await sql.unsafe("DROP TABLE IF EXISTS rm_preflight_owned_probe");
    }
  });

  test("a runtime role holding CREATE on public is a DDL denylist violation — 0053 line 117 revokes it", async () => {
    await sql.unsafe("GRANT CREATE ON SCHEMA public TO rm_app");
    try {
      const violations = await findDenylistViolations(sql, ["rm_app"]);
      expect(violations).toContainEqual({ rule: "ddl", role: "rm_app", object: "public" });
    } finally {
      await sql.unsafe("REVOKE CREATE ON SCHEMA public FROM rm_app");
    }
  });

  test("DELETE on an append-only table is a denylist violation, one per table", async () => {
    // This is TODAY's production state: 0053 line 129 is
    // `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO
    // rm_app` — append-only tables included.
    const violations = await findDenylistViolations(sql, ["rm_app"]);
    const appendOnly = violations.filter((v) => v.rule === "append_only_write");
    expect(appendOnly.map((v) => v.object).sort()).toEqual([...APPEND_ONLY_TABLES].sort());
  });

  test("TRUNCATE on an append-only table is the same violation as DELETE", async () => {
    await sql.unsafe("GRANT TRUNCATE ON swarm_members TO rm_worker");
    try {
      const violations = await findDenylistViolations(sql, ["rm_worker"]);
      expect(violations).toContainEqual({
        rule: "append_only_write",
        role: "rm_worker",
        object: "swarm_members",
      });
    } finally {
      await sql.unsafe("REVOKE TRUNCATE ON swarm_members FROM rm_worker");
    }
  });

  test("a clean runtime role produces no violations at all", async () => {
    // rm_readonly holds SELECT only (0053 lines 136-137) and owns nothing.
    expect(await findDenylistViolations(sql, ["rm_readonly"])).toEqual([]);
  });

  test("reports every violation it finds, not the first", async () => {
    await sql.unsafe("ALTER ROLE rm_readonly SUPERUSER CREATEROLE");
    try {
      const rules = (await findDenylistViolations(sql, ["rm_readonly"])).map((v) => v.rule);
      expect(rules).toContain("superuser");
      expect(rules).toContain("createrole");
    } finally {
      await sql.unsafe("ALTER ROLE rm_readonly NOSUPERUSER NOCREATEROLE");
    }
  });
});

describe("check 2, the asymmetry — the registry is not an allowlist", () => {
  test("a grant absent from the registry is NOT forbidden by that fact alone", async () => {
    // Spec §7 check 2, verbatim. 0053 line 136 grants rm_readonly SELECT on ALL
    // tables and line 137 adds a default privilege for future ones — dozens of
    // grants no call site declares. Treating the registry as an allowlist would
    // make every boot fail on grants that are correct, and a check that always
    // fails gets turned off.
    const result = await checkPrivileges(sql, context({ roles: ["rm_readonly"] }));
    const undeclared = refusals(result.findings).filter((f) => /not declared|undeclared|not in the registry/i.test(f.message));
    expect(undeclared).toEqual([]);
  });

  test("today's 0053 grant — rm_app DELETE on ALL tables — FAILS check 2, which is what W2.2's migration must fix", async () => {
    // Spec §9.1 step 2: "Check 2 fails until it lands." A preflight that passed
    // on today's production would be measuring nothing.
    const result = await checkPrivileges(sql, context({ roles: ["rm_app"] }));
    const refused = refusals(result.findings);
    expect(refused.length).toBeGreaterThan(0);
    const text = refused.map((f) => f.message).join("\n");
    expect(text).toContain("rm_app");
    expect(text).toContain("swarm_members");
    expect(text).toMatch(/DELETE/);
  });

  test("check 2 refuses at `refuse` severity on stage too — a denylist first armed in production is untested", async () => {
    await sql.unsafe("GRANT rm_owner TO rm_worker");
    try {
      for (const env of ["stage", "prod"] as const) {
        const result = await checkPrivileges(sql, context({ env, roles: ["rm_worker"] }));
        const owner = refusals(result.findings).filter((f) => f.message.includes("rm_owner"));
        expect(owner.length).toBeGreaterThan(0);
      }
    } finally {
      await sql.unsafe("REVOKE rm_owner FROM rm_worker");
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Check 3 — integrity (a) and compatibility (b)
// ───────────────────────────────────────────────────────────────────────────

describe("check 3a — integrity against the manifest stored in the database", () => {
  test("refuses a database with no manifest — nothing to compare is not a reason to serve", async () => {
    const result = await checkSchemaIntegrity(sql, context());
    expect(result.check).toBe("schema_integrity");
    expect(refusals(result.findings).length).toBeGreaterThan(0);
    expect(result.findings.map((f) => f.message).join("\n")).toContain("schema_manifest");
  });

  test("refuses an in-progress database — ledger ahead of manifest means nothing verified where it got to", async () => {
    await sql.unsafe(`
      CREATE TABLE schema_manifest (
        format_version integer NOT NULL,
        declaration text NOT NULL,
        filenames text[] NOT NULL,
        content_hash text NOT NULL,
        singleton boolean NOT NULL DEFAULT true UNIQUE CHECK (singleton)
      )`);
    try {
      // A manifest embodying a strict prefix of the ledger is exactly §8.3's
      // *in progress*: the ledger already records migrations the manifest does
      // not describe.
      const ledger = await sql<{ name: string }[]>`SELECT name FROM schema_migrations ORDER BY name`;
      const embodied = ledger.slice(0, -1).map((r) => r.name);
      await sql`
        INSERT INTO schema_manifest (format_version, declaration, filenames, content_hash)
        VALUES (1, 'declaration', ${embodied}, 'unverified')`;

      const result = await checkSchemaIntegrity(sql, context());
      const text = refusals(result.findings).map((f) => f.message).join("\n");
      expect(refusals(result.findings).length).toBeGreaterThan(0);
      expect(text).toContain("in progress");
      expect(text).toContain(ledger[ledger.length - 1]?.name ?? "");
    } finally {
      await sql.unsafe("DROP TABLE IF EXISTS schema_manifest");
    }
  });

  test("compares against the DATABASE's manifest, not the booting image's snapshot", async () => {
    // "Genuine drift fails here whatever code is booting" (§7 check 3a). An old
    // image meeting a newer database compares against that database's own
    // declaration, so an ordinary version difference produces no findings — and
    // that is independent of `codeFilenames`, which 3a must never read.
    const empty = await checkSchemaIntegrity(sql, context({ codeFilenames: [] }));
    const ahead = await checkSchemaIntegrity(sql, context({ codeFilenames: ["9999_from_the_future.sql"] }));
    expect(ahead.findings).toEqual(empty.findings);
  });

  test("a dropped trigger on an append-only table is genuine drift and fails", async () => {
    await sql.unsafe("DROP TRIGGER IF EXISTS swarm_members_append_only ON swarm_members");
    const result = await checkSchemaIntegrity(sql, context());
    const text = refusals(result.findings).map((f) => f.message).join("\n");
    expect(text).toContain("swarm_members");
  });
});

describe("check 3b — does the booting code support the installed version", () => {
  test("no surplus means no findings: the code ships exactly what the ledger records", async () => {
    const ledger = await sql<{ name: string }[]>`SELECT name FROM schema_migrations ORDER BY name`;
    const result = await checkSchemaCompatibility(sql, context({ codeFilenames: ledger.map((r) => r.name) }));
    expect(result.check).toBe("schema_compatibility");
    expect(result.findings).toEqual([]);
  });

  test("refuses a surplus ledger row with a NULL compat — unknown is not 'probably fine'", async () => {
    const ledger = await sql<{ name: string }[]>`SELECT name FROM schema_migrations ORDER BY name`;
    const surplus = ledger[ledger.length - 1]?.name ?? "";
    const result = await checkSchemaCompatibility(sql, context({ codeFilenames: ledger.slice(0, -1).map((r) => r.name) }));
    const text = refusals(result.findings).map((f) => f.message).join("\n");
    expect(refusals(result.findings).length).toBeGreaterThan(0);
    expect(text).toContain(surplus);
  });

  test("refuses when the code is AHEAD of the database — that is a pending migration, not a compatibility question", async () => {
    const ledger = await sql<{ name: string }[]>`SELECT name FROM schema_migrations ORDER BY name`;
    const codeFilenames = [...ledger.map((r) => r.name), "0063_not_applied_here.sql"];
    const result = await checkSchemaCompatibility(sql, context({ codeFilenames }));
    const text = refusals(result.findings).map((f) => f.message).join("\n");
    expect(text).toContain("0063_not_applied_here.sql");
  });

  test("the two 0059 migrations are distinguished by filename, never by number", async () => {
    // `backend/migrations/` holds 0059_analytics_output_and_report_snapshots.sql
    // AND 0059_swarm_framework_subject_snapshot_cleanup.sql, so "at 0059" names
    // two different schemas (§8.1).
    const ledger = await sql<{ name: string }[]>`SELECT name FROM schema_migrations ORDER BY name`;
    const names = ledger.map((r) => r.name);
    const theTwo = names.filter((n) => n.startsWith("0059_"));
    expect(theTwo).toHaveLength(2);

    // Code shipping only ONE of them is not "at 0059 and therefore current":
    // the other is surplus and must be evaluated.
    const codeFilenames = names.filter((n) => n !== "0059_swarm_framework_subject_snapshot_cleanup.sql");
    const result = await checkSchemaCompatibility(sql, context({ codeFilenames }));
    const text = refusals(result.findings).map((f) => f.message).join("\n");
    expect(text).toContain("0059_swarm_framework_subject_snapshot_cleanup.sql");
    expect(text).not.toContain("0059_analytics_output_and_report_snapshots.sql");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Check 4 — ~/.env holds no dangerous credential
// ───────────────────────────────────────────────────────────────────────────

describe("check 4 — ~/.env holds no dangerous credential", () => {
  const SAFE = ["DATABASE_HOST=db.example.invalid", "rm_app=token-a", "rm_worker=token-b", "rm_readonly=token-c"];

  test("a file holding only the three runtime tokens passes", async () => {
    const envFilePath = writeEnvFile("safe.env", SAFE);
    const result = await checkEnvCredentials(context({ env: "prod", envFilePath }));
    expect(result.check).toBe("env_credentials");
    expect(result.findings).toEqual([]);
  });

  test("refuses an rm_owner token on prod", async () => {
    const envFilePath = writeEnvFile("owner.env", [...SAFE, "rm_owner=super-secret-owner-token"]);
    const result = await checkEnvCredentials(context({ env: "prod", envFilePath }));
    expect(refusals(result.findings)).toHaveLength(1);
    expect(result.findings[0]?.message).toContain("rm_owner");
  });

  test("refuses a doadmin token on prod", async () => {
    const envFilePath = writeEnvFile("doadmin.env", [...SAFE, "doadmin=cluster-admin-token"]);
    const result = await checkEnvCredentials(context({ env: "prod", envFilePath }));
    expect(refusals(result.findings)).toHaveLength(1);
    expect(result.findings[0]?.message).toContain("doadmin");
  });

  test("warns and proceeds on stage, where a host legitimately holds an owner credential for --migrate", async () => {
    const envFilePath = writeEnvFile("owner-stage.env", [...SAFE, "rm_owner=super-secret-owner-token"]);
    const result = await checkEnvCredentials(context({ env: "stage", envFilePath }));
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.severity).toBe("warn");
    expect(refusals(result.findings)).toEqual([]);
  });

  test("unset RM_ENV refuses against a remote and warns under --local, per §4.3's unset row", async () => {
    const envFilePath = writeEnvFile("owner-unset.env", [...SAFE, "rm_owner=super-secret-owner-token"]);
    const remote = await checkEnvCredentials(context({ env: null, connection: "remote", envFilePath }));
    expect(remote.findings[0]?.severity).toBe("refuse");
    const local = await checkEnvCredentials(context({ env: null, connection: "local", envFilePath }));
    expect(local.findings[0]?.severity).toBe("warn");
  });

  test("names the offending KEY and never the value — it does not log, hash or compare a secret", async () => {
    const secret = "an-owner-password-that-must-never-be-printed";
    const envFilePath = writeEnvFile("redaction.env", [...SAFE, `rm_owner=${secret}`]);
    const result = await checkEnvCredentials(context({ env: "prod", envFilePath }));
    const text = result.findings.map((f) => f.message).join("\n");
    expect(text).toContain("rm_owner");
    expect(text).not.toContain(secret);
  });

  test("reports every dangerous key present, not the first", async () => {
    const envFilePath = writeEnvFile("all-three.env", [
      ...SAFE,
      "rm_owner=x",
      "doadmin=y",
      "POSTGRES_SUPERUSER_URL=postgres://postgres@host/db",
    ]);
    const result = await checkEnvCredentials(context({ env: "prod", envFilePath }));
    const text = result.findings.map((f) => f.message).join("\n");
    expect(text).toContain("rm_owner");
    expect(text).toContain("doadmin");
    expect(refusals(result.findings).length).toBeGreaterThanOrEqual(2);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Check 5 — RM_ENV x deployment_identity
// ───────────────────────────────────────────────────────────────────────────

describe("check 5 — RM_ENV x deployment_identity resolve per the §4.3 matrix", () => {
  async function withIdentity(value: "production" | "rehearsal" | null, body: () => Promise<void>): Promise<void> {
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS deployment_identity (
        identity text NOT NULL,
        singleton boolean NOT NULL DEFAULT true UNIQUE CHECK (singleton)
      )`);
    await sql.unsafe("DELETE FROM deployment_identity");
    if (value) await sql`INSERT INTO deployment_identity (identity) VALUES (${value})`;
    try {
      await body();
    } finally {
      await sql.unsafe("DROP TABLE IF EXISTS deployment_identity");
    }
  }

  test("prod + remote + production identity passes", async () => {
    await withIdentity("production", async () => {
      const result = await checkEnvIdentity(sql, context({ env: "prod", connection: "remote" }));
      expect(result.check).toBe("env_identity");
      expect(result.findings).toEqual([]);
    });
  });

  test("prod + remote + rehearsal identity refuses", async () => {
    await withIdentity("rehearsal", async () => {
      const result = await checkEnvIdentity(sql, context({ env: "prod", connection: "remote" }));
      expect(refusals(result.findings)).toHaveLength(1);
      expect(result.findings[0]?.message).toContain("rehearsal");
    });
  });

  test("prod + any --local mode refuses", async () => {
    await withIdentity("rehearsal", async () => {
      const result = await checkEnvIdentity(sql, context({ env: "prod", connection: "local" }));
      expect(refusals(result.findings)).toHaveLength(1);
      expect(result.findings[0]?.message).toContain("prod");
    });
  });

  test("stage + remote + production identity refuses — stage policy never touches production data", async () => {
    await withIdentity("production", async () => {
      const result = await checkEnvIdentity(sql, context({ env: "stage", connection: "remote" }));
      expect(refusals(result.findings)).toHaveLength(1);
      expect(result.findings[0]?.message).toContain("production");
    });
  });

  test("stage + local + production identity refuses — a reattached volume gets no weaker policy than a remote", async () => {
    await withIdentity("production", async () => {
      const result = await checkEnvIdentity(sql, context({ env: "stage", connection: "local" }));
      expect(refusals(result.findings)).toHaveLength(1);
    });
  });

  test("unset RM_ENV against a remote refuses", async () => {
    await withIdentity("rehearsal", async () => {
      const result = await checkEnvIdentity(sql, context({ env: null, connection: "remote" }));
      expect(refusals(result.findings)).toHaveLength(1);
      expect(result.findings[0]?.message).toContain("RM_ENV");
    });
  });

  test("unset RM_ENV under --local warns `RM_ENV not set, running as stage` and proceeds", async () => {
    await withIdentity("rehearsal", async () => {
      const result = await checkEnvIdentity(sql, context({ env: null, connection: "local" }));
      expect(refusals(result.findings)).toEqual([]);
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]?.severity).toBe("warn");
      expect(result.findings[0]?.message).toContain("RM_ENV not set, running as stage");
    });
  });

  test("no deployment_identity row refuses — absence of evidence is not evidence of rehearsal", async () => {
    await withIdentity(null, async () => {
      const result = await checkEnvIdentity(sql, context({ env: "stage", connection: "remote" }));
      expect(refusals(result.findings)).toHaveLength(1);
      expect(result.findings[0]?.message).toContain("deployment_identity");
    });
  });

  test("more than one deployment_identity row refuses", async () => {
    await sql.unsafe("CREATE TABLE IF NOT EXISTS deployment_identity (identity text NOT NULL)");
    await sql.unsafe("DELETE FROM deployment_identity");
    await sql.unsafe("INSERT INTO deployment_identity (identity) VALUES ('rehearsal'), ('production')");
    try {
      const result = await checkEnvIdentity(sql, context({ env: "stage", connection: "remote" }));
      expect(refusals(result.findings).length).toBeGreaterThan(0);
    } finally {
      await sql.unsafe("DROP TABLE IF EXISTS deployment_identity");
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Check 6 — the five prod swarm schedules
// ───────────────────────────────────────────────────────────────────────────

describe("check 6 — on prod, the five swarm.* schedule rows are enabled and their crons parse", () => {
  test("reports nothing on stage, where the rows are legitimately off", async () => {
    await sql`UPDATE job_schedules SET enabled = false WHERE kind = ANY(${[...SWARM_SCHEDULE_KINDS]})`;
    const result = await checkProdSchedules(sql, context({ env: "stage" }));
    expect(result.check).toBe("prod_schedules");
    expect(result.findings).toEqual([]);
  });

  test("refuses on prod when a row is disabled, naming the kind", async () => {
    await sql`UPDATE job_schedules SET enabled = true WHERE kind = ANY(${[...SWARM_SCHEDULE_KINDS]})`;
    await sql`UPDATE job_schedules SET enabled = false WHERE kind = 'swarm.publish'`;
    const result = await checkProdSchedules(sql, context({ env: "prod" }));
    expect(refusals(result.findings)).toHaveLength(1);
    expect(result.findings[0]?.message).toContain("swarm.publish");
  });

  test("refuses on prod when a row is missing entirely", async () => {
    await sql`UPDATE job_schedules SET enabled = true WHERE kind = ANY(${[...SWARM_SCHEDULE_KINDS]})`;
    await sql`DELETE FROM job_schedules WHERE kind = 'swarm.aggregate'`;
    const result = await checkProdSchedules(sql, context({ env: "prod" }));
    expect(refusals(result.findings)).toHaveLength(1);
    expect(result.findings[0]?.message).toContain("swarm.aggregate");
  });

  test("refuses on prod when a cron string does not parse", async () => {
    await sql`UPDATE job_schedules SET enabled = true WHERE kind = ANY(${[...SWARM_SCHEDULE_KINDS]})`;
    await sql`UPDATE job_schedules SET cron = 'not a cron' WHERE kind = 'swarm.open_session'`;
    const result = await checkProdSchedules(sql, context({ env: "prod" }));
    const text = refusals(result.findings).map((f) => f.message).join("\n");
    expect(text).toContain("swarm.open_session");
    expect(text).toContain("not a cron");
  });

  test("does NOT refuse on a NULL or overdue next_run_at — refusing would block the boot that repairs it", async () => {
    // Spec §6.3, and this repo's own scar: #614's wedge leaves a `* * * * *`
    // schedule frozen after a long outage, and the CLAMP that drains the
    // backlog only runs if the worker starts.
    await sql`UPDATE job_schedules SET enabled = true WHERE kind = ANY(${[...SWARM_SCHEDULE_KINDS]})`;
    await sql`UPDATE job_schedules SET next_run_at = NULL WHERE kind = 'swarm.open_session'`;
    await sql`UPDATE job_schedules SET next_run_at = now() - interval '30 days' WHERE kind = 'swarm.publish_brief'`;
    const result = await checkProdSchedules(sql, context({ env: "prod" }));
    expect(result.findings).toEqual([]);
  });

  test("never enables a row — enablement is an operator action (`bun run schedules:enable`)", async () => {
    await sql`UPDATE job_schedules SET enabled = false WHERE kind = ANY(${[...SWARM_SCHEDULE_KINDS]})`;
    await checkProdSchedules(sql, context({ env: "prod" }));
    const rows = await sql<{ enabled: boolean }[]>`
      SELECT enabled FROM job_schedules WHERE kind = ANY(${[...SWARM_SCHEDULE_KINDS]})`;
    expect(rows.every((r) => r.enabled === false)).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Orchestrator
// ───────────────────────────────────────────────────────────────────────────

describe("runPreflight — one library, three callers (§7.2)", () => {
  test("`full` scope runs all seven check ids; `container` runs only checks 1-3", async () => {
    const all = await runPreflight(sql, context({ env: "prod" }), "full", tokens());
    expect(all.results.map((r) => r.check)).toEqual([
      "roles_authenticate",
      "privileges",
      "schema_integrity",
      "schema_compatibility",
      "env_credentials",
      "env_identity",
      "prod_schedules",
    ]);

    const own = new Map<RmRole, string>([["rm_app", PASSWORDS.rm_app]]);
    const container = await runPreflight(sql, context({ roles: ["rm_app"] }), "container", own);
    expect(container.results.map((r) => r.check)).toEqual([
      "roles_authenticate",
      "privileges",
      "schema_integrity",
      "schema_compatibility",
    ]);
  });

  test("runs every check before deciding — a database failing 2, 3 and 5 says so in one boot", async () => {
    const report = await runPreflight(sql, context({ env: "prod", connection: "remote" }), "full", tokens());
    const failed = report.results.filter((r) => r.findings.some((f) => f.severity === "refuse")).map((r) => r.check);
    expect(failed).toContain("privileges");
    expect(failed).toContain("schema_integrity");
    expect(failed).toContain("env_identity");
    expect(report.passed).toBe(false);
  });

  test("warnings neither clear nor set `passed`", async () => {
    const envFilePath = writeEnvFile("warn-only.env", ["rm_app=a", "rm_owner=b"]);
    const report = await runPreflight(sql, context({ env: "stage", envFilePath }), "full", tokens());
    const warnings = report.results.flatMap((r) => r.findings).filter((f) => f.severity === "warn");
    expect(warnings.length).toBeGreaterThan(0);
    expect(report.passed).toBe(report.results.every((r) => !r.findings.some((f) => f.severity === "refuse")));
  });

  test("is read-only in every outcome — no row anywhere changes", async () => {
    const [before] = await sql<{ jobs: number; schedules: number }[]>`
      SELECT (SELECT COUNT(*) FROM jobs)::int AS jobs, (SELECT COUNT(*) FROM job_schedules)::int AS schedules`;
    await runPreflight(sql, context({ env: "prod" }), "full", tokens());
    const [after] = await sql<{ jobs: number; schedules: number }[]>`
      SELECT (SELECT COUNT(*) FROM jobs)::int AS jobs, (SELECT COUNT(*) FROM job_schedules)::int AS schedules`;
    expect(after).toEqual(before as { jobs: number; schedules: number });
  });

  test("throws rather than reporting a failed check when the database cannot be queried at all", async () => {
    const dead = postgres("postgres://rm_app:wrong@127.0.0.1:1/nope", { max: 1, onnotice: () => {}, connect_timeout: 1 });
    try {
      await expect(runPreflight(dead, context(), "container", tokens())).rejects.toThrow();
    } finally {
      await dead.end({ timeout: 5 });
    }
  });
});

describe("preflightReportLines — the only thing an operator has when a boot stops", () => {
  test("renders one `[preflight]` line per finding, in check order", async () => {
    const report = await runPreflight(sql, context({ env: "prod", connection: "remote" }), "full", tokens());
    const lines = preflightReportLines(report);
    const findings = report.results.flatMap((r) => r.findings);
    expect(lines).toHaveLength(findings.length);
    expect(lines.every((line) => line.startsWith("[preflight]"))).toBe(true);
    for (const [index, finding] of findings.entries()) {
      expect(lines[index]).toContain(finding.message);
    }
  });

  test("is pure and synchronous — the same report renders identically twice", async () => {
    const report = await runPreflight(sql, context({ env: "prod" }), "full", tokens());
    expect(preflightReportLines(report)).toEqual(preflightReportLines(report));
  });

  test("renders nothing for a clean report", () => {
    expect(preflightReportLines({ results: [], passed: true })).toEqual([]);
  });
});
