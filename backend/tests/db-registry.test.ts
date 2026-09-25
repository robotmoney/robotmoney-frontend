// The registered query interface (spec §7.1) — the ONE place a database
// statement may be issued from, and the input to preflight check 2.
//
// These tests are the specification for src/db/registry.ts (issue #1026 W2).
// The interface itself — registration, `on`, callers, enumeration, the fold
// check 2 reads, the probe contract — is pinned with FIXTURE declarations in
// tests/registry-interface.cases.ts, which the first block below runs in a
// child `bun test` so those fixtures never enter this process's registry. The
// rest pin the property that makes the registry the input to check 2: no
// module outside the db layer's infrastructure issues a statement except
// through `on(...)` and a declaration, read statically from the source rather
// than from whatever the process happens to have registered. The
// swarm_judge_config declarations get a dedicated reading in
// tests/swarm-judge-config-registry.test.ts.
//
// WHY THE ASSERTIONS ARE ABOUT SHAPE AND NOT ABOUT SQL. §7.1 is explicit that
// the registry "is not a runtime proof: execution under each role against a
// disposable database is a separate CI test". That test is
// tests/db-registry-execution.test.ts. What is pinned here is the three
// properties check 2 depends on: a declaration cannot be ambiguous, every
// declaration is enumerable, and the fold into (role → object → privileges) is
// a union rather than a last-writer-wins overwrite.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";
import { registeredSites, type QueryDeclaration, type RmRole } from "../src/db/registry.ts";

/** The four roles of spec §3. There is no `rm_migrator` (D46/D47) and `doadmin`
 *  is cluster provisioning only (§3, §9.1), so neither may ever appear. */
const TAXONOMY_ROLES: readonly RmRole[] = ["rm_owner", "rm_app", "rm_worker", "rm_readonly"];

describe("the interface specification — fixture registrations run in a child process", () => {
  // ORDER-INDEPENDENCE (#1026 W2 open problem 5). The fixture cases register
  // sites on real relations (`jobs`, `job_schedules`) and on made-up ones
  // (`rm_registry_rel_*`), with privileges no program needs. The registry has
  // no removal, and backend `bun test` runs every file in one process, so while
  // those cases ran HERE any later file folding the in-process registry
  // inherited them. In a child they die with the child.
  const CASES = join(import.meta.dir, "registry-interface.cases.ts");

  /** How many `test(...)` calls the cases file makes — what the child must report. */
  function declaredCases(): number {
    const source = ts.createSourceFile(CASES, readFileSync(CASES, "utf8"), ts.ScriptTarget.Latest, true);
    let count = 0;
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "test") count += 1;
      ts.forEachChild(node, visit);
    };
    visit(source);
    return count;
  }

  test("every interface case passes in a child `bun test`, and every one of them ran", () => {
    // Run from outside backend/, so the backend bunfig's Postgres preload does
    // not start for a file that never touches a database.
    const cwd = mkdtempSync(join(tmpdir(), "rm-registry-cases-"));
    try {
      const child = Bun.spawnSync(["bun", "test", CASES], { cwd, env: process.env, stdout: "pipe", stderr: "pipe" });
      // bun test reports on stderr; read both.
      const out = `${child.stdout.toString()}\n${child.stderr.toString()}`;
      const pass = Number(/^\s*(\d+) pass$/m.exec(out)?.[1] ?? -1);
      const fail = Number(/^\s*(\d+) fail$/m.exec(out)?.[1] ?? -1);
      expect({ exitCode: child.exitCode, fail }, out).toEqual({ exitCode: 0, fail: 0 });
      // Non-vacuous: the child ran every case the file declares, so a case
      // cannot quietly stop running (a `.skip`, a broken describe).
      expect(declaredCases()).toBeGreaterThan(30);
      expect(pass).toBe(declaredCases());
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("no fixture site reaches this process's registry", () => {
    // What the move buys, asserted: nothing registered by the cases file
    // (every fixture site id starts `tests/db-registry:`) exists here.
    expect(registeredSites().filter((d) => d.site.startsWith("tests/db-registry:"))).toEqual([]);
  });

  test("this file registers nothing in-process — a fixture added here would leak again", () => {
    const self = readFileSync(import.meta.path, "utf8");
    const source = ts.createSourceFile(import.meta.path, self, ts.ScriptTarget.Latest, true);
    let calls = 0;
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "registerQuery") {
        calls += 1;
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(calls).toBe(0);
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
    // A FRAGMENT WRITTEN INLINE IN A REGISTERED STATEMENT IS PART OF IT.
    // postgres.js composes `on(db, q)`... ${cond ? db`FOR UPDATE` : db``}`` into
    // ONE statement: the inner templates are pieces of the declared statement,
    // never issued on their own. So a tagged template counts as a fragment,
    // not a statement, only when ALL of these hold, read from the syntax:
    //   - it sits directly in a `${...}` of a registered template (or of a
    //     fragment that does), reached through nothing but parentheses and
    //     `?:` branches — never through a call, a variable or a function;
    //   - its tag is the very handle identifier the enclosing `on(...)` was
    //     given as its first argument.
    // A fragment built anywhere else (a helper that returns one, a `const`)
    // is still a raw statement here, however it is later used.
    const fragments = new Set<ts.Node>();
    const collectFragments = (expression: ts.Expression, handle: string): void => {
      let e = expression;
      while (ts.isParenthesizedExpression(e)) e = e.expression;
      if (ts.isConditionalExpression(e)) {
        collectFragments(e.whenTrue, handle);
        collectFragments(e.whenFalse, handle);
        return;
      }
      if (ts.isTaggedTemplateExpression(e) && ts.isIdentifier(e.tag) && e.tag.text === handle) {
        fragments.add(e);
        if (ts.isTemplateExpression(e.template)) {
          for (const span of e.template.templateSpans) collectFragments(span.expression, handle);
        }
      }
    };
    const markInlineFragments = (node: ts.TaggedTemplateExpression): void => {
      const call = node.tag as ts.CallExpression;
      const handle = call.arguments[0];
      if (!handle || !ts.isIdentifier(handle) || !ts.isTemplateExpression(node.template)) return;
      for (const span of node.template.templateSpans) collectFragments(span.expression, handle.text);
    };

    const visit = (node: ts.Node): void => {
      if (ts.isTaggedTemplateExpression(node)) {
        if (isRegisteredTag(node.tag)) markInlineFragments(node);
        else if (!fragments.has(node)) record(node, node.tag);
      }
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
  // grow to admit them. 50 entries remained.
  //
  // 2026-09-25 (#1026 W3): thirty modules moved onto the registry, each with
  // a probe tests/db-registry-execution.test.ts runs as its declared role. 20
  // entries remain; what keeps each one here is reported with the change.
  //
  // NEVER ADD A LINE HERE. An addition would be a new violation of §7.1 being
  // written down instead of fixed, which is the one thing a ratchet exists to
  // prevent. The only legal edit is a deletion.
  const RAW_SQL_ALLOWLIST: readonly string[] = [
    "src/analytics/store/output-snapshot-store",
    "src/analytics/store/regime-store",
    "src/analytics/store/run-ledger-store",
    "src/analytics/store/source-ledger-store",
    "src/api/auth",
    "src/api/index",
    "src/api/routes/admin",
    "src/api/routes/admin-webauthn",
    "src/api/routes/projects",
    "src/ops/asset-prices",
    "src/ops/gap-detector",
    "src/ops/wallet-backfill",
    "src/ops/wallet-snapshot-manifest",
    "src/projects/smoke-seed",
    "src/swarm/admin",
    "src/swarm/consensus-receipt",
    "src/swarm/domain",
    "src/swarm/judge-fault-injection",
    "src/swarm/roster-seed",
    "src/worker/handlers/projects",
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
  // Most entries were release upgrade tooling (scripts/upgrades/*) and the
  // migration runner, which judge or rebuild the database itself. On
  // 2026-09-25 (#1026 W3) the tooling of the four SHIPPED upgrades moved to
  // HISTORICAL_RELEASE_TOOLING below, pinned by equality; what remains here is
  // live backlog.
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
    "scripts/schema-current",
    "scripts/smoke-twin-capture",
    "scripts/upgrades/0.5.0-to-0.5.1/closed-day-allocation",
    "scripts/upgrades/0.5.0-to-0.5.1/functional-rehearsal",
    "scripts/upgrades/0.5.0-to-0.5.1/postflight",
    "scripts/upgrades/0.5.0-to-0.5.1/preflight",
  ];

  // ─────────────────────────────────────────────────────────────────────────
  // HISTORICAL RELEASE TOOLING — upgrade scripts for releases that SHIPPED.
  //
  // Recorded 2026-09-25 (#1026 W3) with 13 entries, all of them moved off the
  // scripts backlog above. Each one graded, rehearsed or restored the upgrade
  // to a tagged, shipped release (v0.2.2, v0.3.0, v0.4.0, v0.5.0). They are
  // the evidence those rollouts ran against, not programs any deployment runs
  // again: their statements read catalogs and baselines of databases that no
  // longer exist in that shape, as whatever operator credential ran the
  // rollout. Rewriting them onto the registry would change the tooling a
  // shipped release was graded with, for no deployment that will ever run it.
  //
  // It is NOT a way around the ratchet. It is pinned by equality below, it can
  // never grow (a release that ships later gets its tooling registered, not
  // listed here), and an entry whose file stops issuing raw statements or
  // disappears must leave. `0.5.0-to-0.5.1` is deliberately absent: v0.5.1
  // has no release tag, so its tooling is live backlog, not history.
  const HISTORICAL_RELEASE_TOOLING: ReadonlyMap<string, string> = new Map([
    ["scripts/upgrades/0.2.1-to-0.2.2/postflight", "graded the shipped v0.2.1 -> v0.2.2 cutover"],
    ["scripts/upgrades/0.2.1-to-0.2.2/preflight", "gated the shipped v0.2.1 -> v0.2.2 cutover"],
    ["scripts/upgrades/0.2.1-to-0.2.2/restore-check", "proved the v0.2.1 backup restorable before v0.2.2 shipped"],
    ["scripts/upgrades/0.2.2-to-0.3.0/postflight", "graded the shipped v0.2.2 -> v0.3.0 cutover"],
    ["scripts/upgrades/0.2.2-to-0.3.0/preflight", "gated the shipped v0.2.2 -> v0.3.0 cutover"],
    ["scripts/upgrades/0.2.2-to-0.3.0/repair-observation", "watched repair dispatch on the v0.3.0 rehearsal twin"],
    ["scripts/upgrades/0.2.2-to-0.3.0/restore-check", "proved the v0.2.2 backup restorable before v0.3.0 shipped"],
    ["scripts/upgrades/0.2.2-to-0.3.0/stage-rehearsal", "rehearsed the shipped v0.3.0 upgrade on a staging twin"],
    ["scripts/upgrades/0.3.0-to-0.4.0/postflight", "graded the shipped v0.3.0 -> v0.4.0 cutover"],
    ["scripts/upgrades/0.3.0-to-0.4.0/preflight", "gated the shipped v0.3.0 -> v0.4.0 cutover"],
    ["scripts/upgrades/0.4.0-to-0.5.0/closed-day-allocation", "checked closed-day allocations across the shipped v0.5.0 read-path switch"],
    ["scripts/upgrades/0.4.0-to-0.5.0/postflight", "graded the shipped v0.4.0 -> v0.5.0 cutover"],
    ["scripts/upgrades/0.4.0-to-0.5.0/preflight", "gated the shipped v0.4.0 -> v0.5.0 cutover"],
  ]);

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

  test("a fragment written inline in a registered statement is part of it, not a statement", () => {
    const REG = 'import { on } from "../db/registry.ts";\n';
    const inline = [
      "export async function ok(db, q, lock) { return on(db, q)`SELECT 1 FROM t ${lock ? db`FOR UPDATE` : db``}`; }",
      "export async function ok(db, q, n) { return on(db, q)`SELECT 1 FROM t ${(n == null ? db`` : db`LIMIT ${n}`)}`; }",
      // Nested ternaries, and a fragment inside a fragment.
      "export async function ok(db, q, a, b) { return on(db, q)`SELECT 1 FROM t WHERE ${a ? db`x = ${a}` : b ? db`y = ${b} ${db`AND true`}` : db`true`}`; }",
    ];
    for (const shape of inline) expect(plant(REG + shape), shape).toEqual([]);
  });

  test("RED CONTROL: a fragment built anywhere but inline, or on another handle, is still a raw statement", () => {
    const REG = 'import { on } from "../db/registry.ts";\n';
    const outside = [
      // Built in a variable, then spliced in.
      "export async function leak(db, q) { const f = db`FOR UPDATE`; return on(db, q)`SELECT 1 FROM t ${f}`; }",
      // Returned by a helper.
      "const lock = (db) => db`FOR UPDATE`;\nexport async function leak(db, q) { return on(db, q)`SELECT 1 FROM t ${lock(db)}`; }",
      // Reached through a call inside the span.
      "export async function leak(db, q) { return on(db, q)`SELECT 1 FROM t ${String(db`DELETE FROM t`)}`; }",
      // Tagged with a different handle than the registered statement runs on.
      "export async function leak(db, other, q) { return on(db, q)`SELECT 1 FROM t ${other`FOR UPDATE`}`; }",
      // Inline in an UNREGISTERED statement: both are raw.
      "export async function leak(db) { return db`SELECT 1 FROM t ${db`FOR UPDATE`}`; }",
    ];
    const expected = [1, 1, 1, 1, 2];
    outside.forEach((shape, i) => expect(plant(REG + shape), shape).toHaveLength(expected[i]!));
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
    // 50 when recorded; 20 after #1026 W3 moved thirty modules onto the registry.
    expect(RAW_SQL_ALLOWLIST.length).toBeLessThanOrEqual(20);
  });

  /** The scripts gate itself: every backend/scripts module issuing a raw
   *  statement that neither `backlog` nor `history` admits, one line each.
   *  The gate test below and its red control run THIS function, so the red
   *  control proves the gate, not a copy of it. */
  function scriptsGateOffenders(
    backlog: readonly string[],
    history: ReadonlyMap<string, string>,
    found: ReadonlyMap<string, RawStatement[]> = rawStatementModules(SCRIPTS),
  ): string[] {
    const allowed = new Set([...backlog, ...history.keys()]);
    return [...found]
      .filter(([moduleId]) => !allowed.has(moduleId))
      .map(([moduleId, statements]) => `${moduleId}: ${statements.map((st) => `${st.line} ${st.tag}`).join(", ")}`)
      .sort();
  }

  test("every backend/scripts module issuing a raw statement is on the dated scripts backlog or shipped-release history", () => {
    const found = rawStatementModules(SCRIPTS);
    // Non-vacuous: the scan reads scripts/ and sees the statements it records.
    expect(found.size).toBeGreaterThan(0);
    expect(scriptsGateOffenders(SCRIPTS_RAW_SQL_ALLOWLIST, HISTORICAL_RELEASE_TOOLING, found)).toEqual([]);
  });

  test("the scripts backlog only shrinks — a converted script must leave it", () => {
    const stillRaw = rawStatementModules(SCRIPTS);
    expect(SCRIPTS_RAW_SQL_ALLOWLIST.filter((m) => !stillRaw.has(m))).toEqual([]);
    expect(new Set(SCRIPTS_RAW_SQL_ALLOWLIST).size).toBe(SCRIPTS_RAW_SQL_ALLOWLIST.length);
    expect(SCRIPTS_RAW_SQL_ALLOWLIST.every((m) => m.startsWith("scripts/"))).toBe(true);
    // The recorded size. A longer list is an addition, whatever it is called.
    // 28 when recorded; 15 once the shipped-release tooling moved to its own
    // set; 13 once scan-low-order-keys and v0-seed-bootstrap registered.
    expect(SCRIPTS_RAW_SQL_ALLOWLIST.length).toBeLessThanOrEqual(13);
  });

  test("the shipped-release tooling set is exactly the thirteen recorded modules, and never grows", () => {
    // Pinned by value, like INFRA: a new entry is an edit here AND a failing
    // expectation, never one quiet line.
    expect([...HISTORICAL_RELEASE_TOOLING.keys()].sort()).toEqual([
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
    ]);
    // Every entry is a shipped release's upgrade directory, carries its reason,
    // still issues raw statements (else it leaves), and is on no other list.
    const stillRaw = rawStatementModules(SCRIPTS);
    const backlog = new Set(SCRIPTS_RAW_SQL_ALLOWLIST);
    for (const [moduleId, reason] of HISTORICAL_RELEASE_TOOLING) {
      expect(/^scripts\/upgrades\/(0\.2\.1-to-0\.2\.2|0\.2\.2-to-0\.3\.0|0\.3\.0-to-0\.4\.0|0\.4\.0-to-0\.5\.0)\//.test(moduleId), moduleId).toBe(true);
      expect(reason.length, moduleId).toBeGreaterThan(10);
      expect(stillRaw.has(moduleId), moduleId).toBe(true);
      expect(backlog.has(moduleId), moduleId).toBe(false);
    }
  });

  test("RED CONTROL: an unreleased upgrade's raw statements are not excused by the history set", () => {
    // The v0.5.1 tooling has no release tag, so the only thing admitting its
    // raw statements is the dated backlog. This runs the gate itself
    // (scriptsGateOffenders) with each v0.5.1 module dropped from the backlog
    // in turn, and requires the gate to name exactly that module — so a gate
    // that stopped reading the backlog, or that let the history set excuse an
    // unreleased upgrade, fails here.
    const found = rawStatementModules(SCRIPTS);
    const unreleased = [...found.keys()].filter((m) => m.startsWith("scripts/upgrades/0.5.0-to-0.5.1/"));
    expect(unreleased.length).toBeGreaterThan(0);
    for (const moduleId of unreleased) {
      expect(HISTORICAL_RELEASE_TOOLING.has(moduleId), moduleId).toBe(false);
      const without = SCRIPTS_RAW_SQL_ALLOWLIST.filter((m) => m !== moduleId);
      expect(without.length, moduleId).toBe(SCRIPTS_RAW_SQL_ALLOWLIST.length - 1);
      const offenders = scriptsGateOffenders(without, HISTORICAL_RELEASE_TOOLING, found);
      expect(offenders.map((line) => line.slice(0, line.indexOf(":"))), moduleId).toEqual([moduleId]);
    }
    // And the history set really is consulted: with every shipped module
    // dropped from it, the gate names each one.
    const shipped = [...HISTORICAL_RELEASE_TOOLING.keys()].sort();
    const withoutHistory = scriptsGateOffenders(SCRIPTS_RAW_SQL_ALLOWLIST, new Map(), found);
    expect(withoutHistory.map((line) => line.slice(0, line.indexOf(":")))).toEqual(shipped);
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
  /** Every `.ts` file under src/ and scripts/, as `src/...` / `scripts/...`
   *  paths relative to backend/. Operator CLIs register too (#1026 W3). */
  function backendModuleFiles(): string[] {
    return (["src", "scripts"] as const).flatMap((root) =>
      (readdirSync(join(SRC, "..", root), { recursive: true, encoding: "utf8" }) as string[]).map((rel) => join(root, rel)),
    );
  }

  function declaringModules(): Map<string, { calls: number; nested: number[] }> {
    const found = new Map<string, { calls: number; nested: number[] }>();
    for (const rel of backendModuleFiles()) {
      if (!rel.endsWith(".ts") || rel === join("src", "db", "registry.ts")) continue;
      const text = readFileSync(join(SRC, "..", rel), "utf8");
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
      if (entry.calls > 0) found.set(rel.replace(/\.ts$/, ""), entry);
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
    // #1026 W3.
    "scripts/scan-low-order-keys",
    "scripts/v0-seed-bootstrap",
    "src/admin/audit",
    "src/admin/overview",
    "src/analytics/cutover/gate",
    "src/analytics/cutover/ledger-current",
    "src/analytics/cutover/parity",
    "src/analytics/cutover/read-mode",
    "src/analytics/report/projections",
    "src/analytics/store/raw-history-store",
    "src/analytics/store/research-store",
    "src/analytics/store/telemetry-store",
    "src/api/routes/swarm/waitlist",
    "src/chain/buyback-logs",
    "src/projects/agent-detail-projections",
    "src/projects/agents-projections",
    "src/projects/coins-vaults-wallets-projections",
    "src/projects/dossier-projections",
    "src/projects/entities-projections",
    "src/projects/leaderboard-projections",
    "src/projects/list2-projections",
    "src/projects/profile-projections",
    "src/projects/projections",
    "src/swarm/judge-replay",
    "src/swarm/judgements",
    "src/swarm/receipt-gap",
    "src/worker/handlers/repair",
    "src/worker/handlers/vault",
    "src/worker/handlers/wallet",
    "src/worker/loop",
    "src/worker/reaper",
    "src/worker/scheduler",
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
