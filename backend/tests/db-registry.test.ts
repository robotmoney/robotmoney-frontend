// The registered query interface (spec §7.1) — the ONE place a database
// statement may be issued from, and the input to preflight check 2.
//
// These tests are the specification for src/db/registry.ts (issue #1026 W2).
// The first four blocks pin the interface itself with fixture declarations.
// The last two pin the property that makes it the input to check 2: no module
// outside the db layer's infrastructure issues a statement except through
// `on(...)` and a declaration, read statically from the source rather than
// from whatever the process happens to have registered. The swarm_judge_config
// declarations get a dedicated reading in
// tests/swarm-judge-config-registry.test.ts.
//
// WHY THE ASSERTIONS ARE ABOUT SHAPE AND NOT ABOUT SQL. §7.1 is explicit that
// the registry "is not a runtime proof: execution under each role against a
// disposable database is a separate CI test" (W2.8). So nothing here executes a
// registered statement. What is pinned is the three properties check 2 depends
// on: a declaration cannot be ambiguous, every declaration is enumerable, and
// the fold into (role → object → privileges) is a union rather than a
// last-writer-wins overwrite.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";
import {
  on,
  registerQuery,
  registeredSites,
  requiredPrivileges,
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

describe("structural enforcement — a raw sql call outside the interface is detectable", () => {
  // Spec §7.1: "CI forbids raw `sql` outside it, so the registry cannot drift
  // into a hand-maintained list." This is the half of W2.3's gate that makes
  // the registry COMPLETE rather than merely populated: without it a new call
  // site can write to a table nobody declared, check 2 stays green, and the
  // check is measuring the subset of the code that happened to opt in.
  //
  // WHAT COUNTS AS A RAW STATEMENT. The detector parses each module and reads
  // the SHAPE of every statement, not the name of the handle that issues it:
  //
  //   - every tagged template is a statement, whatever its tag is called and
  //     whether or not it carries a type argument — `sql`, `tx`, `db`, `h`,
  //     `handle`, `conn<Row[]>`, and one split over several lines — UNLESS its
  //     tag is a call of `on(...)` imported from src/db/registry.ts, which is
  //     the registered form;
  //   - every `.unsafe(...)` call is a statement.
  //
  // The detector it replaces matched a tagged template only on the names
  // `sql`, `tx` and `db`, and only with nothing between the name and the
  // backtick, so `sql<Row[]>\`...\`` and `h<Row[]>\`...\`` slipped past it.
  // Ten modules outside the allowlist were issuing statements that way when
  // it was replaced (#1026 W2).
  //
  // Every tagged template in `src/` today is a postgres.js statement. A
  // non-SQL tag (`String.raw`, say) would be reported too, and the answer then
  // is a named exception here with its reason, not a looser detector.
  const SRC = join(import.meta.dir, "..", "src");
  const REGISTRY_FILE = join(SRC, "db", "registry.ts");

  function tsFilesUnder(dir: string): string[] {
    return (readdirSync(dir, { recursive: true, encoding: "utf8" }) as string[])
      .filter((rel) => rel.endsWith(".ts"))
      .map((rel) => join(dir, rel));
  }

  const BACKEND = join(import.meta.dir, "..");
  const SCRIPTS = join(BACKEND, "scripts");

  /** `src/...` or `scripts/...`, relative to backend/, no extension. */
  function moduleIdOf(file: string): string {
    return file.slice(BACKEND.length + 1).replace(/\.ts$/, "");
  }

  interface RawStatement {
    /** 1-based line of the statement's start. */
    readonly line: number;
    /** The tag (or `.unsafe` callee) as written, whitespace collapsed. */
    readonly tag: string;
  }

  /**
   * Every raw statement in one module's source. `file` is the module's path,
   * used only to resolve its imports: `on` counts as the registry's binder
   * only when it is imported from src/db/registry.ts itself.
   */
  function rawStatements(file: string, text: string): RawStatement[] {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const binders = new Set<string>();
    const namespaces = new Set<string>();
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const specifier = statement.moduleSpecifier.text;
      if (!specifier.startsWith(".")) continue;
      const target = resolve(dirname(file), specifier);
      if (target !== REGISTRY_FILE && `${target}.ts` !== REGISTRY_FILE) continue;
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          if ((element.propertyName ?? element.name).text === "on") binders.add(element.name.text);
        }
      } else if (bindings && ts.isNamespaceImport(bindings)) {
        namespaces.add(bindings.name.text);
      }
    }

    const isRegisteredTag = (tag: ts.Expression): boolean => {
      if (!ts.isCallExpression(tag)) return false;
      const callee = tag.expression;
      if (ts.isIdentifier(callee)) return binders.has(callee.text);
      return (
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === "on" &&
        ts.isIdentifier(callee.expression) &&
        namespaces.has(callee.expression.text)
      );
    };

    const found: RawStatement[] = [];
    const record = (node: ts.Node, tag: ts.Node) => {
      found.push({
        line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        tag: tag.getText(source).replace(/\s+/g, " "),
      });
    };
    const visit = (node: ts.Node): void => {
      if (ts.isTaggedTemplateExpression(node) && !isRegisteredTag(node.tag)) record(node, node.tag);
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "unsafe"
      ) {
        record(node, node.expression);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return found;
  }

  /** A planted module, parsed as if it sat at `src/plant/module.ts`. */
  const plant = (text: string): RawStatement[] => rawStatements(join(SRC, "plant", "module.ts"), text);

  // ─────────────────────────────────────────────────────────────────────────
  // THE INFRASTRUCTURE SET — the only modules exempt by what they ARE.
  //
  // These construct and hand out pools, own the registry, apply migrations,
  // hold the target lock, or read the catalog to judge the database itself.
  // None of them issues a statement an application program NEEDS: they issue
  // the statements that decide whether the programs may run at all. So none
  // of them has a (role, object, privilege) to declare.
  //
  // The two append-only boot guards are the only additions to the brief's set
  // (pools, registry, migrate, target lock, preflight, schema-*), and each is
  // here for a reason sharper than "it is in db/". They prove their triggers
  // are armed by attempting a `DELETE ... WHERE false` that MUST be refused,
  // and otherwise read only `pg_trigger`, `pg_class`, `pg_proc` and
  // `schema_migrations`. A declaration is a claim that a role needs a
  // privilege; declaring that probe would make check 2 demand exactly the
  // DELETE on an append-only table the denylist forbids (spec §7 check 2).
  //
  // The handle-namespace guard is NOT here. It reads the application table
  // `swarm_members`, so it declares that read (src/db/handle-namespace.ts).
  // The connection factory the other two guards shared with it moved to
  // src/db/guard-client.ts, which issues nothing, so importing the append-only
  // guard (as preflight.ts does) no longer drags that declaration along.
  //
  // Every other module under src/db/ is a domain store and declares like
  // anything else (automation-tokens, handle-namespace, seed). This is a set of
  // named files, never a directory prefix, and it is not the allowlist: the
  // allowlist is a dated backlog, this is a statement of what the db layer is.
  // It is PINNED below by equality, so a new exemption is a visible edit to
  // two places and a failing test, never one quiet line.
  const INFRA: readonly string[] = [
    "src/db/analytics-ledger-guard",
    "src/db/append-only-guard",
    "src/db/client",
    "src/db/migrate",
    "src/db/preflight",
    "src/db/registry",
    "src/db/schema-compat",
    "src/db/schema-manifest",
    "src/db/schema-snapshot",
    "src/db/target-lock",
    "src/db/worker-client",
  ];

  // ─────────────────────────────────────────────────────────────────────────
  // THE ALLOWLIST IS A RATCHET, AND IT MUST ONLY EVER SHRINK.
  //
  // Recorded 2026-09-23 (#1026 W2.3) with 51 entries, every module under
  // `src/` outside the db layer that issued a raw tagged template the old
  // detector could see on that date. Moving them onto `registerQuery` is a
  // refactor of its own and is tracked separately; enforcing the rule only
  // after that refactor would mean the rule does not exist until then, and a
  // new call site landing in the meantime would be indistinguishable from the
  // backlog.
  //
  // So the gate ships now, with the backlog RECORDED rather than hidden. A
  // module not on this list may not issue a raw statement — that case fails
  // below and is the tooth. A module on this list that has been converted must
  // be REMOVED from it, which the second test enforces, so the list cannot be
  // used to re-admit a module that already left.
  //
  // When the parser replaced the old regex (#1026 W2) the list lost
  // `src/worker/runtime`, which had been admitted only because the regex
  // matched "`sql` is a live binding" inside a comment. The ten modules the
  // old detector missed were converted rather than added; the list did not
  // grow to admit them. 50 entries remain.
  //
  // NEVER ADD A LINE HERE. An addition would be a new violation of §7.1 being
  // written down instead of fixed, which is the one thing a ratchet exists to
  // prevent. The only legal edit is a deletion.
  const RAW_SQL_ALLOWLIST: readonly string[] = [
    "src/admin/audit",
    "src/admin/overview",
    "src/analytics/cutover/gate",
    "src/analytics/cutover/ledger-current",
    "src/analytics/cutover/parity",
    "src/analytics/cutover/read-mode",
    "src/analytics/report/projections",
    "src/analytics/store/output-snapshot-store",
    "src/analytics/store/raw-history-store",
    "src/analytics/store/regime-store",
    "src/analytics/store/research-store",
    "src/analytics/store/run-ledger-store",
    "src/analytics/store/source-ledger-store",
    "src/analytics/store/telemetry-store",
    "src/api/auth",
    "src/api/index",
    "src/api/routes/admin",
    "src/api/routes/admin-webauthn",
    "src/api/routes/projects",
    "src/api/routes/swarm/waitlist",
    "src/chain/buyback-logs",
    "src/ops/asset-prices",
    "src/ops/gap-detector",
    "src/ops/wallet-backfill",
    "src/ops/wallet-snapshot-manifest",
    "src/projects/agent-detail-projections",
    "src/projects/agents-projections",
    "src/projects/coins-vaults-wallets-projections",
    "src/projects/dossier-projections",
    "src/projects/entities-projections",
    "src/projects/leaderboard-projections",
    "src/projects/list2-projections",
    "src/projects/profile-projections",
    "src/projects/projections",
    "src/projects/smoke-seed",
    "src/swarm/admin",
    "src/swarm/consensus-receipt",
    "src/swarm/domain",
    "src/swarm/judge-fault-injection",
    "src/swarm/judge-replay",
    "src/swarm/judgements",
    "src/swarm/receipt-gap",
    "src/swarm/roster-seed",
    "src/worker/handlers/projects",
    "src/worker/handlers/repair",
    "src/worker/handlers/vault",
    "src/worker/handlers/wallet",
    "src/worker/loop",
    "src/worker/reaper",
    "src/worker/scheduler",
  ];

  // ─────────────────────────────────────────────────────────────────────────
  // THE SCRIPTS BACKLOG — the same ratchet, for backend/scripts/.
  //
  // Recorded 2026-09-24 (#1026 W2) with 28 entries: every module under
  // backend/scripts/ that issued a raw tagged template or `.unsafe(...)` on that
  // date, read by the same parser as src/. Criterion 68 forbids raw `sql`
  // outside the registry, and declarations already name `scripts/...` modules
  // as callers (prod-bootstrap, db-preflight, seed-provenance-verify), so the
  // operator CLIs are inside the rule, not beside it. Until this list was
  // recorded nothing scanned them at all.
  //
  // Most entries are release upgrade tooling (scripts/upgrades/*) and the
  // migration runner, which judge or rebuild the database itself; some of those
  // may belong in an infrastructure set of their own rather than on the
  // registry. That is a decision for the package that converts them, and it
  // is recorded here as backlog, not decided by an exemption.
  //
  // NEVER ADD A LINE HERE. The only legal edit is a deletion.
  const SCRIPTS_RAW_SQL_ALLOWLIST: readonly string[] = [
    "scripts/db-preflight",
    "scripts/lib/checks",
    "scripts/lib/postflight-utils",
    "scripts/lib/preflight-utils",
    "scripts/lib/rollout-receipt",
    "scripts/migrate-run",
    "scripts/prod-bootstrap",
    "scripts/scan-low-order-keys",
    "scripts/schema-current",
    "scripts/smoke-twin-capture",
    "scripts/upgrades/0.2.1-to-0.2.2/postflight",
    "scripts/upgrades/0.2.1-to-0.2.2/preflight",
    "scripts/upgrades/0.2.1-to-0.2.2/restore-check",
    "scripts/upgrades/0.2.2-to-0.3.0/postflight",
    "scripts/upgrades/0.2.2-to-0.3.0/preflight",
    "scripts/upgrades/0.2.2-to-0.3.0/repair-observation",
    "scripts/upgrades/0.2.2-to-0.3.0/restore-check",
    "scripts/upgrades/0.2.2-to-0.3.0/stage-rehearsal",
    "scripts/upgrades/0.3.0-to-0.4.0/postflight",
    "scripts/upgrades/0.3.0-to-0.4.0/preflight",
    "scripts/upgrades/0.4.0-to-0.5.0/closed-day-allocation",
    "scripts/upgrades/0.4.0-to-0.5.0/postflight",
    "scripts/upgrades/0.4.0-to-0.5.0/preflight",
    "scripts/upgrades/0.5.0-to-0.5.1/closed-day-allocation",
    "scripts/upgrades/0.5.0-to-0.5.1/functional-rehearsal",
    "scripts/upgrades/0.5.0-to-0.5.1/postflight",
    "scripts/upgrades/0.5.0-to-0.5.1/preflight",
    "scripts/v0-seed-bootstrap",
  ];

  /** Module id → its raw statements, for every module under `root` (src/ by
   *  default, or scripts/) outside
   *  the infrastructure set that issues at least one. Purely static: it reads
   *  files, never the process-wide registry, so its answer cannot depend on
   *  which test files happened to import what before it ran. */
  function rawStatementModules(root: string = SRC): Map<string, RawStatement[]> {
    const infra = new Set(INFRA);
    const found = new Map<string, RawStatement[]>();
    for (const file of tsFilesUnder(root)) {
      const moduleId = moduleIdOf(file);
      if (infra.has(moduleId)) continue;
      const statements = rawStatements(file, readFileSync(file, "utf8"));
      if (statements.length > 0) found.set(moduleId, statements);
    }
    return found;
  }

  test("the detector is not vacuous: it fires on every raw shape, whatever the handle is called", () => {
    const shapes = [
      "export async function leak(db) { return db`SELECT 1`; }",
      // The shape the old detector missed: a generic type argument on the tag.
      "export async function leak(h) { return h<{a:number}[]>`SELECT 1`; }",
      "export async function leak(sql) { return sql<{ a: number }[]>`SELECT 1`; }",
      // Any identifier, not a list of names.
      "export async function leak(handle) { return handle`SELECT 1`; }",
      "export async function leak(conn) { return conn<Row[]>`SELECT 1`; }",
      // A type argument split across lines, which a line-by-line grep cannot see.
      "export async function leak(tx) {\n  return tx<\n    { a: number }[]\n  >`SELECT 1`;\n}",
      "export async function leak(db) { return db.unsafe('SELECT 1'); }",
      // A lookalike `on` that is NOT the registry's is just another tag.
      "const on = (db, q) => db;\nexport async function leak(sql, q) { return on(sql, q)`SELECT 1`; }",
      'import { on } from "../swarm/judge-config.ts";\nexport async function leak(sql, q) { return on(sql, q)`SELECT 1`; }',
    ];
    for (const shape of shapes) {
      expect(plant(shape), shape).toHaveLength(1);
    }
  });

  test("the detector stays silent on the registered form, however the binder is imported", () => {
    const registered = [
      'import { on } from "../db/registry.ts";\nexport async function ok(sql, q) { return on(sql, q)`SELECT 1`; }',
      'import { on } from "../db/registry.ts";\nexport async function ok(sql, q) { return on(sql, q)<{a:number}>`SELECT 1`; }',
      'import { on as stmt } from "../db/registry.ts";\nexport async function ok(sql, q) { return stmt(sql, q)`SELECT 1`; }',
      'import * as registry from "../db/registry.ts";\nexport async function ok(sql, q) { return registry.on(sql, q)`SELECT 1`; }',
      // A value helper inside a registered template is a parameter, not a statement.
      'import { on } from "../db/registry.ts";\nexport async function ok(sql, q, v) { return on(sql, q)`INSERT INTO t VALUES (${sql.json(v)})`; }',
      "export async function ok(q, db) { return q.run(db, ['SELECT 1']); }",
    ];
    for (const shape of registered) {
      expect(plant(shape), shape).toEqual([]);
    }
  });

  test("a module that registers is not thereby exempt — its raw statements still count", () => {
    // The gate this replaced exempted a whole module once any of its call
    // sites registered, and read that from the process-wide registry, so a
    // module's verdict depended on which test file had imported it first.
    const mixed = [
      'import { on, registerQuery } from "../db/registry.ts";',
      'const q = registerQuery({ role: "rm_app", object: "jobs", privileges: ["SELECT"], site: "src/plant/module:ok", purpose: "p", callers: ["src/plant/module"] });',
      "export async function ok(sql) { return on(sql, q)`SELECT 1 FROM jobs`; }",
      "export async function leak(sql) { return sql`DELETE FROM jobs`; }",
    ].join("\n");
    expect(plant(mixed).map((s) => s.tag)).toEqual(["sql"]);
  });

  test("every module issuing a raw statement is infrastructure or a dated allowlist entry", () => {
    const allowed = new Set(RAW_SQL_ALLOWLIST);
    const offenders = [...rawStatementModules()]
      .filter(([moduleId]) => !allowed.has(moduleId))
      .map(([moduleId, statements]) => `${moduleId}: ${statements.map((s) => `${s.line} ${s.tag}`).join(", ")}`)
      .sort();

    // The message is the deliverable: an operator or a reviewer has to be able
    // to read which file and which line broke the property, not just that
    // something did.
    expect(offenders).toEqual([]);
  });

  test("the allowlist only shrinks — a converted module must be removed from it", () => {
    // Without this, the list would be a floor rather than a ceiling: a module
    // moved onto registerQuery would keep its exemption, and the next raw
    // statement added to that same file would land inside it unnoticed.
    const stillRaw = rawStatementModules();
    const stale = RAW_SQL_ALLOWLIST.filter((m) => !stillRaw.has(m));
    expect(stale).toEqual([]);
    expect(new Set(RAW_SQL_ALLOWLIST).size).toBe(RAW_SQL_ALLOWLIST.length);
    // The recorded size. A longer list is an addition, whatever it is called.
    expect(RAW_SQL_ALLOWLIST.length).toBeLessThanOrEqual(50);
  });

  test("every backend/scripts module issuing a raw statement is on the dated scripts backlog", () => {
    const allowed = new Set(SCRIPTS_RAW_SQL_ALLOWLIST);
    const found = rawStatementModules(SCRIPTS);
    // Non-vacuous: the scan reads scripts/ and sees the statements it records.
    expect(found.size).toBeGreaterThan(0);
    const offenders = [...found]
      .filter(([moduleId]) => !allowed.has(moduleId))
      .map(([moduleId, statements]) => `${moduleId}: ${statements.map((st) => `${st.line} ${st.tag}`).join(", ")}`)
      .sort();
    expect(offenders).toEqual([]);
  });

  test("the scripts backlog only shrinks — a converted script must leave it", () => {
    const stillRaw = rawStatementModules(SCRIPTS);
    expect(SCRIPTS_RAW_SQL_ALLOWLIST.filter((m) => !stillRaw.has(m))).toEqual([]);
    expect(new Set(SCRIPTS_RAW_SQL_ALLOWLIST).size).toBe(SCRIPTS_RAW_SQL_ALLOWLIST.length);
    expect(SCRIPTS_RAW_SQL_ALLOWLIST.every((m) => m.startsWith("scripts/"))).toBe(true);
    // The recorded size. A longer list is an addition, whatever it is called.
    expect(SCRIPTS_RAW_SQL_ALLOWLIST.length).toBeLessThanOrEqual(28);
  });

  test("the infrastructure set is exactly the named db layer — an addition fails here", () => {
    // A second exemption list with no ceiling would be a way around the
    // ratchet: any new db/ domain store could be exempted by one line. So the
    // set is pinned by value. Growing it means editing this expectation too,
    // with the reason written next to the entry above.
    expect([...INFRA].sort()).toEqual([
      // The brief's infrastructure: pools, registry, migrate, lock, preflight, schema-*.
      "src/db/client",
      "src/db/migrate",
      "src/db/preflight",
      "src/db/registry",
      "src/db/schema-compat",
      "src/db/schema-manifest",
      "src/db/schema-snapshot",
      "src/db/target-lock",
      "src/db/worker-client",
      // The append-only probes, which must not declare the DELETE they prove is refused.
      "src/db/analytics-ledger-guard",
      "src/db/append-only-guard",
    ].sort());
    // A schema-* entry must be a real schema module, not a name that merely matches.
    for (const moduleId of INFRA) {
      expect(/^src\/db\/(schema-[a-z-]+|client|worker-client|registry|migrate|target-lock|preflight|append-only-guard|analytics-ledger-guard)$/.test(moduleId), moduleId).toBe(true);
    }
  });

  test("the infrastructure set names real files, and never the allowlist's", () => {
    for (const moduleId of INFRA) {
      expect(existsSync(join(SRC, "..", `${moduleId}.ts`)), moduleId).toBe(true);
      expect(moduleId.startsWith("src/db/"), moduleId).toBe(true);
    }
    const allowed = new Set(RAW_SQL_ALLOWLIST);
    expect(INFRA.filter((m) => allowed.has(m))).toEqual([]);
  });
});

describe("declarations — what the converted modules declare, read without depending on file order", () => {
  // `registeredSites()` is process-wide and has no removal, and backend
  // `bun test` runs every file in one process. So nothing here asks "what has
  // been registered so far", and nothing here registers into this process:
  // the declaring modules are found on disk and imported in a CHILD process,
  // which reports exactly the sites each one owns. Another file importing them
  // first changes nothing, and importing them here cannot add requirements to
  // another file's in-process preflight run (tests/schema-snapshot.test.ts).
  const SRC = join(import.meta.dir, "..", "src");

  /** Module id → how many `registerQuery(` calls its source makes, and whether
   *  each is at module level. */
  function declaringModules(): Map<string, { calls: number; nested: number[] }> {
    const found = new Map<string, { calls: number; nested: number[] }>();
    for (const rel of readdirSync(SRC, { recursive: true, encoding: "utf8" }) as string[]) {
      if (!rel.endsWith(".ts") || rel === join("db", "registry.ts")) continue;
      const text = readFileSync(join(SRC, rel), "utf8");
      if (!text.includes("registerQuery(")) continue;
      const source = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true);
      const entry = { calls: 0, nested: [] as number[] };
      const visit = (node: ts.Node, depth: number): void => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "registerQuery") {
          entry.calls += 1;
          if (depth > 0) entry.nested.push(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1);
        }
        const inner = ts.isFunctionLike(node) ? depth + 1 : depth;
        ts.forEachChild(node, (child) => visit(child, inner));
      };
      visit(source, 0);
      if (entry.calls > 0) found.set(`src/${rel.replace(/\.ts$/, "")}`, entry);
    }
    return found;
  }

  /** Module id → the declarations it owns, read from a child process that
   *  imports every declaring module and nothing else. */
  let owned: Map<string, QueryDeclaration[]> | undefined;
  function declarationsOf(moduleId: string): QueryDeclaration[] {
    if (!owned) {
      const modules = [...declaringModules().keys()];
      const script = join(mkdtempSync(join(tmpdir(), "rm-registry-enum-")), "enumerate.ts");
      writeFileSync(script, [
        ...modules.map((m) => `await import(${JSON.stringify(join(SRC, "..", `${m}.ts`))});`),
        `const { registeredSites } = await import(${JSON.stringify(join(SRC, "db", "registry.ts"))});`,
        `console.log("RM_REGISTRY_SITES " + JSON.stringify(registeredSites()));`,
      ].join("\n"));
      try {
        const child = Bun.spawnSync(["bun", "run", script], { env: process.env });
        const line = child.stdout.toString().split("\n").find((l) => l.startsWith("RM_REGISTRY_SITES "));
        if (child.exitCode !== 0 || !line) {
          throw new Error(`registry enumeration child failed (exit ${child.exitCode}):\n${child.stderr.toString()}`);
        }
        const sites = JSON.parse(line.slice("RM_REGISTRY_SITES ".length)) as QueryDeclaration[];
        owned = new Map(modules.map((m) => [m, sites.filter((d) => d.site.startsWith(`${m}:`))]));
      } finally {
        rmSync(dirname(script), { recursive: true, force: true });
      }
    }
    return owned.get(moduleId) ?? [];
  }

  /** Every relation the schema snapshot creates in `public` (spec §8.1). */
  function snapshotRelations(): Set<string> {
    const text = readFileSync(join(SRC, "..", "schema", "snapshot.sql"), "utf8");
    return new Set(
      [...text.matchAll(/CREATE (?:TABLE|VIEW|MATERIALIZED VIEW) public\.([A-Za-z_][A-Za-z0-9_$]*)/g)].map((m) => m[1]),
    );
  }

  // The modules this change moved onto the registry. Listed so a revert that
  // quietly drops a module's declarations fails here rather than only in the
  // raw-statement gate above.
  const CONVERTED: readonly string[] = [
    "src/analytics/store/seed-provenance",
    "src/api/routes/comments",
    "src/api/routes/submissions",
    "src/chain/allocation-framework",
    "src/chain/vault-economics",
    "src/chain/wallet-balances",
    "src/chain/wallet-sleeves",
    "src/chain/wallet-valuation",
    "src/db/automation-tokens",
    "src/db/handle-namespace",
    "src/db/seed",
    "src/projects/activity-log-projections",
    "src/swarm/handle",
  ];

  test("every registerQuery call is at module level, so importing a module enumerates all of it", () => {
    // Registry header: "A registration that happens lazily inside a function
    // body is therefore invisible to CI." This pins that convention.
    const nested = [...declaringModules()]
      .filter(([, entry]) => entry.nested.length > 0)
      .map(([moduleId, entry]) => `${moduleId}: ${entry.nested.join(", ")}`);
    expect(nested).toEqual([]);
  });

  test("every declaring module, once imported, owns exactly as many sites as it has registerQuery calls", () => {
    const mismatched: string[] = [];
    for (const [moduleId, entry] of declaringModules()) {
      const sites = declarationsOf(moduleId);
      // Fewer means a site id names another module (its failures would point
      // at the wrong file); more cannot happen unless ids collide.
      if (sites.length !== entry.calls) mismatched.push(`${moduleId}: ${sites.length} sites for ${entry.calls} calls`);
    }
    expect(mismatched).toEqual([]);
  });

  test("the converted modules declare — none of them is back to raw statements", () => {
    const declaring = declaringModules();
    for (const moduleId of CONVERTED) {
      expect(declaring.has(moduleId), moduleId).toBe(true);
      expect(declarationsOf(moduleId).length, moduleId).toBeGreaterThan(0);
    }
  });

  test("every application declaration names a relation the schema snapshot creates in public", () => {
    const relations = snapshotRelations();
    // Non-vacuous: the snapshot is parsed, and holds the tables named below.
    expect(relations.has("comments")).toBe(true);
    const unknown: string[] = [];
    for (const moduleId of declaringModules().keys()) {
      for (const d of declarationsOf(moduleId)) {
        if (!relations.has(d.object)) unknown.push(`${d.site}: ${d.object}`);
      }
    }
    // Check 2 resolves each object through to_regclass in public and refuses
    // one that does not exist; this catches the typo before a boot does.
    expect(unknown).toEqual([]);
  });

  /** Sites whose statement no entry module reaches yet. Each one names its own
   *  module as the caller, which is a placeholder, not a claim that anything
   *  reaches it. Recorded 2026-09-24 (#1026 W2) with one entry; it only
   *  shrinks, and an entry leaves when the wiring names its real entry module. */
  const UNWIRED_SITES: readonly string[] = [
    // Token provisioning (spec §3, §9.1) is W4's to wire; only tests call it today.
    "src/db/automation-tokens:provisionAutomationToken",
  ];

  /** A module is its own entry point when it is one by the registry's own
   *  definition (QueryDeclaration.callers: "the route that receives the request,
   *  or the job handler that claims the job"), or when it can be run directly
   *  (an operator CLI, or src/db/seed's `bun run src/db/seed.ts`). */
  function isEntryModule(moduleId: string): boolean {
    if (/^src\/api\/routes\/|^src\/worker\/handlers\/|^scripts\//.test(moduleId)) return true;
    const text = readFileSync(join(SRC, "..", `${moduleId}.ts`), "utf8");
    return /import\.meta\.main\b|import\.meta\.url\s*===\s*`file:\/\/\$\{process\.argv\[1\]\}`/.test(text);
  }

  test("every application declaration names a §3 role and at least one entry-module caller", () => {
    const bad: string[] = [];
    const unwired = new Set(UNWIRED_SITES);
    const selfNamed = new Set<string>();
    for (const moduleId of declaringModules().keys()) {
      for (const d of declarationsOf(moduleId)) {
        if (!TAXONOMY_ROLES.includes(d.role)) bad.push(`${d.site}: role ${d.role}`);
        for (const caller of d.callers) {
          if (!existsSync(join(SRC, "..", `${caller}.ts`))) bad.push(`${d.site}: caller ${caller} is not a module`);
          // A declaring module that names ITSELF says nothing about who reaches
          // the statement, unless the module really is an entry point (a route,
          // a job handler, or run directly like src/db/seed) or the site is on
          // the dated unwired list.
          if (caller === moduleId) {
            selfNamed.add(d.site);
            if (!isEntryModule(moduleId) && !unwired.has(d.site)) {
              bad.push(`${d.site}: names its own module as caller, which no entry module reaches`);
            }
          }
        }
      }
    }
    expect(bad).toEqual([]);
    // The unwired list only shrinks: an entry whose site now names a real
    // caller (or no longer exists) must leave it.
    expect(UNWIRED_SITES.filter((site) => !selfNamed.has(site))).toEqual([]);
    expect(UNWIRED_SITES.length).toBeLessThanOrEqual(1);
  });

  test("the self-caller rule is not vacuous: a library module naming itself is refused", () => {
    // Red control: src/db/automation-tokens has no direct-run block, so without
    // the unwired entry its provision site would be refused.
    expect(isEntryModule("src/db/automation-tokens")).toBe(false);
    expect(isEntryModule("src/chain/wallet-balances")).toBe(false);
    expect(isEntryModule("src/db/seed")).toBe(true);
    expect(isEntryModule("src/api/routes/comments")).toBe(true);
  });
});
