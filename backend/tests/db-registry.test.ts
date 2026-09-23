// The registered query interface (spec §7.1) — the ONE place a database
// statement may be issued from, and the input to preflight check 2.
//
// These tests are the specification for src/db/registry.ts. They are written
// against the module as it is DOCUMENTED, not as it currently behaves: every
// function in that file throws `NOT IMPLEMENTED` today, so every test here
// fails, and that is the deliverable of #1026 W2 step 2.
//
// WHY THE ASSERTIONS ARE ABOUT SHAPE AND NOT ABOUT SQL. §7.1 is explicit that
// the registry "is not a runtime proof: execution under each role against a
// disposable database is a separate CI test" (W2.8). So nothing here executes a
// registered statement. What is pinned is the three properties check 2 depends
// on: a declaration cannot be ambiguous, every declaration is enumerable, and
// the fold into (role → object → privileges) is a union rather than a
// last-writer-wins overwrite.
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  registerQuery,
  registeredSites,
  requiredPrivileges,
  type QueryDeclaration,
  type RmRole,
} from "../src/db/registry.ts";

/** The four roles of spec §3. There is no `rm_migrator` (D46/D47) and `doadmin`
 *  is cluster provisioning only (§3, §9.1), so neither may ever appear. */
const TAXONOMY_ROLES: readonly RmRole[] = ["rm_owner", "rm_app", "rm_worker", "rm_readonly"];

/** Unique per call so one test's registration cannot decide another's outcome —
 *  `registerQuery` refuses a duplicate id, which is itself under test below. */
let seq = 0;
function site(name: string): string {
  return `tests/db-registry:${name}_${++seq}`;
}

function declaration(over: Partial<QueryDeclaration> = {}): QueryDeclaration {
  return {
    role: "rm_app",
    object: "jobs",
    privileges: ["SELECT"],
    site: site("fixture"),
    purpose: "Fixture declaration for the registry specification tests.",
    ...over,
  };
}

describe("registerQuery — one declaration per call site", () => {
  test("returns a runner carrying back exactly the declaration it was given", () => {
    const decl = declaration({ role: "rm_worker", object: "job_schedules", privileges: ["SELECT", "UPDATE"] });
    const query = registerQuery(decl);
    expect(query.declaration).toEqual(decl);
  });

  test("hands back no route to the underlying client — `run` is the whole surface", () => {
    const query = registerQuery(declaration());
    // An escape hatch is how the registry stops being complete (module header),
    // so the runner exposes the declaration and `run`, and nothing else.
    expect(Object.keys(query).sort()).toEqual(["declaration", "run"]);
  });

  test("refuses a second registration of the same site id with a different declaration", () => {
    const id = site("duplicate");
    registerQuery(declaration({ site: id, privileges: ["SELECT"] }));
    expect(() => registerQuery(declaration({ site: id, privileges: ["SELECT", "INSERT"] }))).toThrow(id);
  });

  test("accepts an identical re-registration of the same site, because it is not ambiguous", () => {
    const id = site("identical");
    const decl = declaration({ site: id });
    const first = registerQuery(decl);
    const second = registerQuery({ ...decl });
    expect(second.declaration).toEqual(first.declaration);
  });

  test("refuses an empty privilege list — a statement needing nothing does not touch the object it named", () => {
    expect(() => registerQuery(declaration({ privileges: [] }))).toThrow("privileges");
  });

  test("refuses a schema-qualified object, which would resolve outside `public` through to_regclass", () => {
    expect(() => registerQuery(declaration({ object: "public.jobs" }))).toThrow("public.jobs");
  });

  test("refuses a quoted object name", () => {
    expect(() => registerQuery(declaration({ object: '"jobs"' }))).toThrow("object");
  });

  test("refuses an object name containing whitespace", () => {
    expect(() => registerQuery(declaration({ object: "jobs " }))).toThrow("object");
  });
});

describe("registeredSites — the enumeration CI reads", () => {
  test("enumerates every declaration made, in registration order", () => {
    const first = declaration({ site: site("order_a"), object: "jobs" });
    const second = declaration({ site: site("order_b"), object: "job_schedules", role: "rm_worker" });
    registerQuery(first);
    registerQuery(second);

    const all = registeredSites();
    const a = all.findIndex((d) => d.site === first.site);
    const b = all.findIndex((d) => d.site === second.site);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(b).toBe(a + 1);
    expect(all[a]).toEqual(first);
    expect(all[b]).toEqual(second);
  });

  test("returns declarations and never the runners, so enumerating cannot execute a call site", () => {
    registerQuery(declaration({ site: site("no_runner") }));
    for (const entry of registeredSites()) {
      expect(entry).not.toHaveProperty("run");
    }
  });

  test("returns a frozen array, so a caller cannot edit the evidence check 2 reads", () => {
    registerQuery(declaration({ site: site("frozen") }));
    expect(Object.isFrozen(registeredSites())).toBe(true);
  });

  test("every declared role is one of the four §3 roles — never `doadmin`, never `rm_migrator`", () => {
    for (const entry of registeredSites()) {
      expect(TAXONOMY_ROLES).toContain(entry.role);
    }
  });

  test("every declared privilege is spelled the way has_table_privilege spells it", () => {
    const catalog = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];
    for (const entry of registeredSites()) {
      for (const privilege of entry.privileges) {
        expect(catalog).toContain(privilege);
      }
    }
  });

  test("site ids are unique across the whole process", () => {
    const ids = registeredSites().map((d) => d.site);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("requiredPrivileges — the fold check 2 consumes", () => {
  test("unions every call site's privileges for one role on one relation", () => {
    registerQuery(declaration({ site: site("fold_read"), role: "rm_app", object: "jobs", privileges: ["SELECT"] }));
    registerQuery(
      declaration({ site: site("fold_write"), role: "rm_app", object: "jobs", privileges: ["INSERT", "UPDATE"] }),
    );

    const byObject = requiredPrivileges().get("rm_app");
    expect(byObject).toBeDefined();
    const jobs = byObject?.get("jobs");
    expect(jobs).toBeDefined();
    // A union, not a last-writer-wins overwrite: the reader that only SELECTs
    // and the writer that INSERTs are both real requirements on `jobs`.
    expect([...(jobs ?? [])].sort()).toEqual(expect.arrayContaining(["INSERT", "SELECT", "UPDATE"]));
  });

  test("keeps roles apart — rm_worker's declarations never appear under rm_app", () => {
    const relation = `rm_registry_fold_probe_${++seq}`;
    registerQuery(declaration({ site: site("role_split"), role: "rm_worker", object: relation, privileges: ["UPDATE"] }));

    const map = requiredPrivileges();
    expect([...(map.get("rm_worker")?.get(relation) ?? [])]).toEqual(["UPDATE"]);
    expect(map.get("rm_app")?.get(relation)).toBeUndefined();
  });

  test("keeps relations apart — a privilege on one table is not required on another", () => {
    const one = `rm_registry_rel_one_${++seq}`;
    const two = `rm_registry_rel_two_${++seq}`;
    registerQuery(declaration({ site: site("rel_one"), object: one, privileges: ["SELECT"] }));
    registerQuery(declaration({ site: site("rel_two"), object: two, privileges: ["DELETE"] }));

    const byObject = requiredPrivileges().get("rm_app");
    expect([...(byObject?.get(one) ?? [])]).toEqual(["SELECT"]);
    expect([...(byObject?.get(two) ?? [])]).toEqual(["DELETE"]);
  });

  test("never yields an empty privilege set, because registerQuery refuses one", () => {
    registerQuery(declaration({ site: site("nonempty") }));
    for (const [, byObject] of requiredPrivileges()) {
      for (const [, privileges] of byObject) {
        expect(privileges.size).toBeGreaterThan(0);
      }
    }
  });

  test("covers exactly the (role, relation) pairs registeredSites() names — no more, no fewer", () => {
    registerQuery(declaration({ site: site("coverage") }));
    const expected = new Set(registeredSites().map((d) => `${d.role}/${d.object}`));
    const actual = new Set<string>();
    for (const [role, byObject] of requiredPrivileges()) {
      for (const [object] of byObject) actual.add(`${role}/${object}`);
    }
    expect(actual).toEqual(expected);
  });
});

describe("structural enforcement — a raw sql call outside the interface is detectable", () => {
  // Spec §7.1: "CI forbids raw `sql` outside it, so the registry cannot drift
  // into a hand-maintained list." This is the half of W2.3's gate that makes
  // the registry COMPLETE rather than merely populated: without it a new call
  // site can write to a table nobody declared, check 2 stays green, and the
  // check is measuring the subset of the code that happened to opt in.
  //
  // `src/db/` is the permitted pool/interface layer — it is where the registry,
  // the client and the guards live, and it is the module allowed to hold a raw
  // statement by construction. Everything else must go through registerQuery.
  const SRC = join(import.meta.dir, "..", "src");
  const RAW_SQL = /(?:^|[^A-Za-z0-9_.])(?:sql|tx|db)(?:\.unsafe)?\s*`/;

  function tsFilesUnder(dir: string): string[] {
    return (readdirSync(dir, { recursive: true, encoding: "utf8" }) as string[])
      .filter((rel) => rel.endsWith(".ts"))
      .map((rel) => join(dir, rel));
  }

  test("every module issuing a raw statement is either the db layer or a registry declarant", () => {
    const declarants = new Set(registeredSites().map((d) => d.site.split(":")[0]));
    const offenders: string[] = [];

    for (const file of tsFilesUnder(SRC)) {
      const relative = file.slice(SRC.length + 1);
      // The db layer itself constructs pools and owns the interface.
      if (relative.startsWith("db/")) continue;
      const text = readFileSync(file, "utf8");
      if (!text.split("\n").some((line) => RAW_SQL.test(line))) continue;
      const moduleId = `src/${relative.replace(/\.ts$/, "")}`;
      if (!declarants.has(moduleId)) offenders.push(moduleId);
    }

    // The detector is not vacuous: it fires on a planted raw statement and
    // stays silent on a registered call site, whose statement is a template
    // handed to `run` rather than a bare tagged template.
    expect(RAW_SQL.test("export async function leak(db) { return db`SELECT 1`; }")).toBe(true);
    expect(RAW_SQL.test("await query.run(db, ...['SELECT 1']);")).toBe(false);

    // The message is the deliverable: an operator or a reviewer has to be able
    // to read which file broke the property, not just that something did.
    expect(offenders).toEqual([]);
  });
});
