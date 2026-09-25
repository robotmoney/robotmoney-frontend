// The registered query interface's own specification (spec §7.1), run with
// FIXTURE declarations — and therefore run only in a child process.
//
// NOT A `*.test.ts` FILE, ON PURPOSE. Every case below registers fixture sites
// (`tests/db-registry:*`) on relations such as `jobs`, `job_schedules` and the
// made-up `rm_registry_rel_*`, and `registerQuery` has no removal: the
// registry is process-global. Backend `bun test` runs every file in ONE
// process, so while these cases lived in tests/db-registry.test.ts any file
// that ran after it and folded the in-process registry — an in-process
// preflight, say — inherited requirements nobody's code has (rm_app DELETE on
// a relation that does not exist), and its verdict depended on file order
// (#1026 W2 open problem 5). tests/db-registry.test.ts now runs this file in
// a child `bun test` of its own and asserts every case passed, so the fixture
// registrations die with the child.
//
// Run by hand: `bun test <absolute path to this file>` from outside backend/
// (the backend bunfig preload starts a Postgres this file does not need).
import { describe, expect, test } from "bun:test";
import {
  on,
  registerQuery,
  registeredSites,
  requiredPrivileges,
  type ProbeParam,
  type QueryDeclaration,
  type RegistryDb,
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
    callers: ["src/api/routes/fixture"],
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

describe("on — the registered form a call site issues its statement through", () => {
  /** A stand-in handle that records what it was called with, so the forwarding
   *  is observed without a database. */
  function recordingDb() {
    const calls: { strings: readonly string[]; values: unknown[] }[] = [];
    const db = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ strings: [...strings], values });
      return Promise.resolve([{ ok: 1 }]);
    }) as unknown as RegistryDb;
    return { db, calls };
  }

  test("forwards the template and its values to the handle unchanged", async () => {
    const query = registerQuery(declaration({ site: site("on_forward") }));
    const { db, calls } = recordingDb();
    const rows = await on(db, query)<{ ok: number }>`SELECT ${1} AS ok WHERE ${"x"} = ${"x"}`;
    expect(rows).toEqual([{ ok: 1 }]);
    expect(calls).toEqual([{ strings: ["SELECT ", " AS ok WHERE ", " = ", ""], values: [1, "x", "x"] }]);
  });

  test("accepts the declarations of a join's other relations, and refuses one that was never registered", async () => {
    const samples = registerQuery(declaration({ site: site("on_join_a"), object: "wallet_balance_samples" }));
    const prices = registerQuery(declaration({ site: site("on_join_b"), object: "asset_prices" }));
    const { db, calls } = recordingDb();
    await on(db, samples, prices)`SELECT 1`;
    expect(calls).toHaveLength(1);

    const forged = { declaration: { ...prices.declaration, site: site("never_registered") }, run: prices.run };
    expect(() => on(db, samples, forged)).toThrow("unregistered site");
  });

  // RED CONTROL for the hole the lint cannot see. The structural lint accepts
  // any tag that is a call of `on`, so a hand-built object shaped like a
  // RegisteredQuery would run a statement nothing declared. The version this
  // replaced checked only the joined entries and let the primary through.
  test("refuses a forged PRIMARY query, and never runs its statement", () => {
    const { db, calls } = recordingDb();
    let ran = false;
    const forged = {
      declaration: { site: "x" },
      run: (d: RegistryDb, s: TemplateStringsArray, ...v: unknown[]) => {
        ran = true;
        return (d as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>)(s, ...v);
      },
    } as never;
    expect(() => on(db, forged)`SELECT 1`).toThrow("unregistered site");
    expect(ran).toBe(false);
    expect(calls).toEqual([]);
  });

  test("refuses a forgery that copies a REAL site id — identity, not the name, is what is checked", () => {
    const real = registerQuery(declaration({ site: site("on_identity") }));
    const { db, calls } = recordingDb();
    const copied = { declaration: real.declaration, run: real.run } as never;
    expect(() => on(db, copied)).toThrow("unregistered site");
    const other = registerQuery(declaration({ site: site("on_identity_join") }));
    expect(() => on(db, real, { declaration: other.declaration, run: other.run } as never)).toThrow("unregistered site");
    expect(calls).toEqual([]);
  });
});

describe("callers — every declaration names the entry modules that may reach it", () => {
  // Spec §6.2: "nothing but the admin route writes `swarm_judge_config`". A
  // statement about a call site can only be asserted from the registry if the
  // registry records it, so a declaration with no caller is refused rather
  // than read as "anyone".
  test("a declaration carries its callers back, frozen", () => {
    const query = registerQuery(declaration({ callers: ["src/api/routes/swarm-admin", "scripts/swarm-judge-replay"] }));
    expect(query.declaration.callers).toEqual(["src/api/routes/swarm-admin", "scripts/swarm-judge-replay"]);
    expect(Object.isFrozen(query.declaration.callers)).toBe(true);
  });

  test("refuses an empty callers list", () => {
    expect(() => registerQuery(declaration({ callers: [] }))).toThrow("declared no callers");
  });

  test("refuses a missing callers field — a JS caller cannot skip the declaration the type demands", () => {
    const { callers: _omitted, ...rest } = declaration();
    expect(() => registerQuery(rest as unknown as QueryDeclaration)).toThrow("declared no callers");
  });

  test("refuses a caller that is not a module id under src/ or scripts/", () => {
    for (const bad of ["swarm-admin", "src/api/routes/swarm-admin.ts", "/src/api/routes/swarm-admin", "src/", "tests/x", ""]) {
      expect(() => registerQuery(declaration({ callers: [bad] })), bad).toThrow("caller");
    }
  });

  test("refuses the same caller twice", () => {
    expect(() => registerQuery(declaration({ callers: ["src/api/routes/a", "src/api/routes/a"] }))).toThrow("same caller twice");
  });

  test("a re-registration that changes only the callers is a DIFFERENT declaration, and is refused", () => {
    const id = site("callers_changed");
    registerQuery(declaration({ site: id, callers: ["src/api/routes/swarm-admin"] }));
    expect(() => registerQuery(declaration({ site: id, callers: ["src/api/routes/swarm-admin", "src/worker/loop"] })))
      .toThrow(id);
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

describe("probe — the runnable statement tests/db-registry-execution.test.ts executes", () => {
  // The contract is checked at registration, like every other part of a
  // declaration, so a probe the execution test could not run faithfully is a
  // module-load failure rather than a green test that proved nothing.
  const probe = (statement: string, params?: ProbeParam[]) => ({ statement, ...(params ? { params } : {}) });

  test("a declaration carries its probe back, frozen, params and all", () => {
    const query = registerQuery(
      declaration({ probe: probe("SELECT id FROM jobs WHERE kind = $1 AND attempts > $2", ["noop", 0]) }),
    );
    expect(query.declaration.probe).toEqual({ statement: "SELECT id FROM jobs WHERE kind = $1 AND attempts > $2", params: ["noop", 0] });
    expect(Object.isFrozen(query.declaration.probe)).toBe(true);
    expect(Object.isFrozen(query.declaration.probe?.params)).toBe(true);
  });

  test("a probe is optional in the type — the execution test is what refuses a site without one", () => {
    const query = registerQuery(declaration());
    expect(query.declaration.probe).toBeUndefined();
  });

  test("refuses a probe that is not one DML statement", () => {
    for (const statement of ["", "SET ROLE rm_owner", "BEGIN", "COMMIT", "CREATE TABLE jobs2 (id int)", "VACUUM jobs"]) {
      expect(() => registerQuery(declaration({ probe: probe(statement) })), statement).toThrow("probe");
    }
  });

  test("refuses a probe carrying a second statement", () => {
    expect(() => registerQuery(declaration({ probe: probe("SELECT id FROM jobs; DELETE FROM jobs") }))).toThrow("ONE statement");
  });

  test("refuses a probe that never names the declared object", () => {
    expect(() => registerQuery(declaration({ object: "jobs", probe: probe("SELECT 1") }))).toThrow("never names");
    // A longer name that merely CONTAINS the object is not the object.
    expect(() => registerQuery(declaration({ object: "jobs", probe: probe("SELECT 1 FROM job_schedules_jobs") })))
      .toThrow("never names");
  });

  test("refuses a placeholder count that does not match the params", () => {
    expect(() => registerQuery(declaration({ probe: probe("SELECT id FROM jobs WHERE kind = $1") }))).toThrow("placeholder");
    expect(() => registerQuery(declaration({ probe: probe("SELECT id FROM jobs", ["extra"]) }))).toThrow("placeholder");
    expect(() => registerQuery(declaration({ probe: probe("SELECT id FROM jobs WHERE kind = $2", ["a"]) }))).toThrow("placeholder");
  });

  test("refuses a param the child process could not carry as JSON", () => {
    const bad = { statement: "SELECT id FROM jobs WHERE run_at < $1", params: [new Date(0)] } as unknown as QueryDeclaration["probe"];
    expect(() => registerQuery(declaration({ probe: bad }))).toThrow("param");
  });

  test("a re-registration that changes only the probe is a DIFFERENT declaration, and is refused", () => {
    const id = site("probe_changed");
    registerQuery(declaration({ site: id, probe: probe("SELECT id FROM jobs") }));
    expect(() => registerQuery(declaration({ site: id, probe: probe("SELECT kind FROM jobs") }))).toThrow(id);
    expect(() => registerQuery(declaration({ site: id }))).toThrow(id);
  });
});
