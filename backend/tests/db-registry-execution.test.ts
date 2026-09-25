// Execution under each role against a disposable database (spec §7.1) — the
// runtime half of the registered query interface.
//
// Spec §7.1: the registry "is not a runtime proof: execution under each role
// against a disposable database is a separate CI test." This is that test
// (issue #1026 criterion 78). tests/db-registry.test.ts pins the interface and
// the structural lint; preflight check 2 compares the declared privileges with
// `has_table_privilege`. Neither ever runs a statement, so neither can see a
// declaration that is simply wrong about what its statement needs. This file
// runs every registered site's probe (src/db/registry.ts `QueryProbe`) as the
// site's declared LOGIN role and fails on any refusal.
//
// HOW, step by step:
//
//   1. ENUMERATE IN A CHILD. The registry is process-global and backend
//      `bun test` runs every file in one process, so the in-process registry
//      holds whatever other files registered (fixtures included). A child
//      process imports the api's entry modules, the worker's entry modules and
//      every module on disk that calls `registerQuery`, and prints the
//      declarations it then holds — probes included. Nothing else is in it.
//   2. A DISPOSABLE DATABASE FROM THE REAL SNAPSHOT. A blank database copied
//      from `template0`, owned by rm_owner, bootstrapped by
//      `bootstrapBlankDatabase` from backend/schema/ — the same path a
//      `--local blank` boot takes (§8.1), so the grants under test are
//      grants.sql's, not whatever the migration-built suite template holds.
//   3. EACH ROLE LOGS IN AS ITSELF. The harness sets a password on each of the
//      four §3 roles once and connects as that role — never a superuser under
//      `SET ROLE`, which would carry the superuser's session state and prove
//      nothing about the role's own login.
//   4. EACH PROBE RUNS IN A TRANSACTION THAT IS ROLLED BACK. Any error fails
//      the site: 42501 (the grant is missing) is the one this test exists for,
//      and anything else means the probe no longer matches the schema.
//   5. EXACTNESS. A probe that needed nothing (`SELECT 1`) would pass for any
//      role, so each probe is also run as a scratch LOGIN role holding ONLY
//      what the declarations of its `on(...)` call declare (for a JOIN, each
//      joined relation's same-role declaration; must succeed), and then once
//      per privilege THIS declaration lists with that one privilege taken
//      away (must fail with 42501). That is what makes the probe a proof of
//      the declaration rather than a statement that happens to run.
//   6. THE PROBE IS THE CALL SITE. Steps 4 and 5 prove the probe; the static
//      section below proves the probe is the statement the call site issues:
//      every `on(...)` template is read from source, and the probe must
//      reduce to the same token form. A site whose templates differ must be
//      split, so no declaration stands for a statement it was never run as.
//
// PROBE_PENDING below is the dated backlog of registered sites whose owner
// module had no probe when this test landed. It only shrinks.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import postgres from "postgres";
import ts from "typescript";
import { config } from "../src/config.ts";
import { bootstrapBlankDatabase, loadSnapshot } from "../src/db/schema-snapshot.ts";
import type { QueryDeclaration, RmRole, TablePrivilege } from "../src/db/registry.ts";

const BACKEND = join(import.meta.dir, "..");
const SRC = join(BACKEND, "src");
const SCRIPTS = join(BACKEND, "scripts");
const REGISTRY_FILE = join(SRC, "db", "registry.ts");

const ROLES: readonly RmRole[] = ["rm_owner", "rm_app", "rm_worker", "rm_readonly"];

// ─────────────────────────────────────────────────────────────────────────────
// PROBE_PENDING — registered sites with no probe yet. Recorded 2026-09-25
// (#1026 W3) with 11 entries, every one of them src/db/seed's: seed.ts is
// owned by another package this wave, and w5-epoch-registry gives these sites
// their probes. An entry leaves when its site gains a probe (the stale check
// below fails until it does); NEVER ADD A LINE HERE — a new site ships with
// its probe.
// ─────────────────────────────────────────────────────────────────────────────
const PROBE_PENDING: readonly string[] = [
  "src/db/seed:backfillWalletHistory",
  "src/db/seed:seed.allocationFramework",
  "src/db/seed:seed.coldStart",
  "src/db/seed:seedJobSchedules.deadLetterAnalyticsRun",
  "src/db/seed:seedJobSchedules.deadLetterProducer",
  "src/db/seed:seedJobSchedules.deleteAnalyticsRun",
  "src/db/seed:seedJobSchedules.deleteHourlyRepair",
  "src/db/seed:seedJobSchedules.disableProducer",
  "src/db/seed:seedJobSchedules.insert",
  "src/db/seed:seedSmokeJobSchedules.disable",
  "src/db/seed:seedSmokeJobSchedules.insert",
];

/** The count PROBE_PENDING was recorded with; it may only go down. */
const PROBE_PENDING_CEILING = 11;

/**
 * The number of probed sites that ran when this test was last extended. The
 * equality below (every probed site ran) is the real proof; this floor is
 * what stops a mass removal of registrations from passing quietly. Raise it
 * as sites are added. Lower it only in the change that deletes a registering
 * module, saying which.
 */
const EXECUTED_FLOOR = 204;

/**
 * The number of `on(...)` call sites the static reader resolved when it was
 * last extended (a JOIN is one call site naming several declarations, so this
 * is below the site count). Same rule as EXECUTED_FLOOR.
 */
const CALL_SITE_FLOOR = 210;

// ─────────────────────────────────────────────────────────────────────────────
// Static enumeration: what the source says is registered.
// ─────────────────────────────────────────────────────────────────────────────

function tsFilesUnder(dir: string): string[] {
  return (readdirSync(dir, { recursive: true, encoding: "utf8" }) as string[])
    .filter((rel) => rel.endsWith(".ts"))
    .map((rel) => join(dir, rel));
}

/** Absolute path → how many `registerQuery(...)` calls the module makes, for
 *  every module under src/ and scripts/ other than the registry itself. */
function declaringModules(): Map<string, number> {
  const found = new Map<string, number>();
  for (const file of [...tsFilesUnder(SRC), ...tsFilesUnder(SCRIPTS)]) {
    if (file === REGISTRY_FILE) continue;
    const text = readFileSync(file, "utf8");
    if (!text.includes("registerQuery(")) continue;
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    let calls = 0;
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "registerQuery") {
        calls += 1;
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    if (calls > 0) found.set(file, calls);
  }
  return found;
}

/** Every relative module an entry file imports, as absolute paths: the
 *  program's registrations without running the program (the api entry binds
 *  a port and runs its boot guards at import; the worker entry starts loops). */
function entryImports(entry: string): string[] {
  const text = readFileSync(entry, "utf8");
  return [...text.matchAll(/^import\s[^;]*?\sfrom\s+"(\.{1,2}\/[^"]+)";/gm)].map((m) => join(dirname(entry), m[1]!));
}

const API_ENTRY = join(SRC, "api", "index.ts");
const WORKER_ENTRY = join(SRC, "worker", "index.ts");

// ─────────────────────────────────────────────────────────────────────────────
// Static: the statement each call site really issues, and whether the probe IS it.
//
// Running a probe as its declared role proves the probe, not the call site. A
// probe is a string written next to the declaration, so without this section
// a call site could add RETURNING, ON CONFLICT DO UPDATE, FOR UPDATE, a JOIN or
// a WHERE — every one of which changes the privileges the statement needs —
// and the execution below would stay green on the old text. So every `on(...)`
// call site is read from source and reduced to a token FORM, the probe is
// reduced the same way, and the two must be equal. One site may serve several
// templates only when they all reduce to the same form (the two retry
// branches of the job settle differ only in a bound value); a site whose
// templates differ in any token must be split into one site per statement.
//
// THE REDUCTION, which is the whole list of ways a probe may differ from its
// template (each is privilege-neutral: table grants cannot see it):
//   - whitespace, `--` and `/* */` comments, and keyword/identifier case;
//   - a bound value: a template `${expr}` and a probe `$n` both become VALUE,
//     and so does a literal NULL (a bound value may be null);
//   - a cast on a bound value (`$1::uuid`, `${x}::integer`) is dropped;
//   - `IN (v, ...)` and `IN ${sql(list)}` both become `IN LIST`;
//   - postgres.js helper spans are expanded as postgres.js expands them:
//     `${db(rows, "a", "b")}` is `(a, b) VALUES (VALUE, VALUE)`, and a
//     one-argument helper outside `IN` (`SET ${sql(column)} = ...`) is one
//     identifier, matched by any identifier in the probe;
//   - in the probe only, `INSERT INTO t (cols) SELECT <values> WHERE false`
//     is the written form of `INSERT INTO t (cols) VALUES (<values>)`: it
//     plans (and so checks) the same INSERT without needing a parent row for
//     a foreign key on a blank database.
// Anything else — a helper call nested inside a span, a tagged template in a
// span, a statement text that is not a literal — is refused as unreadable.
//
// CATALOG-ONLY STATEMENTS. A statement whose every FROM/JOIN names
// information_schema or pg_catalog needs no table privilege on any relation
// in `public`, so no declaration governs it and no probe can prove it; it is
// skipped by the form rule and pinned by exact list below.
// ─────────────────────────────────────────────────────────────────────────────

const VALUE = "\u0000VALUE";
const LIST = "\u0000LIST";
const IDENT = "\u0000IDENT";
const MARK = { value: "\u0000VALUE\u0000", list: "\u0000LIST\u0000", ident: "\u0000IDENT\u0000" } as const;

/** SQL text (with sentinel marks where spans were) → tokens. */
function lexSql(text: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    const rest = text.slice(i);
    if (/\s/.test(c)) i++;
    else if (rest.startsWith("--")) i = text.indexOf("\n", i) < 0 ? text.length : text.indexOf("\n", i);
    else if (rest.startsWith("/*")) i = text.indexOf("*/", i + 2) < 0 ? text.length : text.indexOf("*/", i + 2) + 2;
    else if (c === "\u0000") {
      const m = /^\u0000(VALUE|LIST|IDENT)\u0000/.exec(rest)!;
      out.push(`\u0000${m[1]}`);
      i += m[0].length;
    } else if (c === "'") {
      let j = i + 1;
      while (j < text.length && !(text[j] === "'" && text[j + 1] !== "'")) j += text[j] === "'" ? 2 : 1;
      out.push(text.slice(i, j + 1));
      i = j + 1;
    } else if (c === '"') {
      const j = text.indexOf('"', i + 1);
      out.push(text.slice(i, j + 1));
      i = j + 1;
    } else if (/^\$\d/.test(rest)) {
      out.push(VALUE);
      i += /^\$\d+/.exec(rest)![0].length;
    } else {
      const m = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(rest) ?? /^\d+(?:\.\d+)?/.exec(rest) ?? /^(?:::|<=|>=|<>|!=|->>|->|\|\||[^\s])/.exec(rest)!;
      out.push(/^[A-Za-z_]/.test(m[0]) ? m[0].toLowerCase() : m[0]);
      i += m[0].length;
    }
  }
  return out;
}

/** The probe-only rewrite: `INSERT INTO t (cols) SELECT v... WHERE false` → `... VALUES (v...)`. */
function foldInsertSelectWhereFalse(t: string[]): string[] {
  if (t[0] !== "insert" || t[1] !== "into") return t;
  let i = 3;
  while (t[i] === ".") i += 2;
  if (t[i] !== "(") return t;
  let depth = 0;
  let close = i;
  for (; close < t.length; close++) {
    if (t[close] === "(") depth++;
    else if (t[close] === ")" && --depth === 0) break;
  }
  if (t[close + 1] !== "select") return t;
  depth = 0;
  for (let k = close + 2; k < t.length; k++) {
    if (t[k] === "(") depth++;
    else if (t[k] === ")") depth--;
    else if (depth === 0 && t[k] === "where") {
      if (t[k + 1] !== "false") return t;
      return [...t.slice(0, close + 1), "values", "(", ...t.slice(close + 2, k), ")", ...t.slice(k + 2)];
    } else if (depth === 0 && t[k] === "from") return t;
  }
  return t;
}

/** The privilege-neutral reductions both sides share (see the section header). */
function reduceForm(tokens: string[]): string[] {
  const t = tokens.map((tok) => (tok === "null" ? VALUE : tok));
  const out: string[] = [];
  for (let i = 0; i < t.length; i++) {
    if (t[i] === "in" && t[i + 1] === "(" && t[i + 2] === VALUE) {
      let j = i + 3;
      while (t[j] === "," && t[j + 1] === VALUE) j += 2;
      if (t[j] === ")") {
        out.push("in", LIST);
        i = j;
        continue;
      }
    }
    out.push(t[i]!);
    if (t[i] === VALUE) {
      while (t[i + 1] === "::" && /^[a-z_]/.test(t[i + 2] ?? "")) {
        i += 2;
        while (t[i + 1] === "[" && t[i + 2] === "]") i += 2;
      }
    }
  }
  return out;
}

function probeForm(statement: string): string[] {
  return reduceForm(foldInsertSelectWhereFalse(reduceForm(lexSql(statement))));
}

function sameForm(template: readonly string[], probe: readonly string[]): boolean {
  return (
    template.length === probe.length &&
    template.every((tok, i) => tok === probe[i] || (tok === IDENT && /^[a-z_"]/.test(probe[i]!)))
  );
}

const showForm = (form: readonly string[]): string => form.join(" ").replace(/\u0000/g, "");

/** One `on(...)` call site as the source writes it. */
interface CallSiteStatement {
  /** backend-relative file:line. */
  readonly where: string;
  /** The registered sites named in the `on(...)` call, primary first. */
  readonly sites: readonly string[];
  /** The reduced token form; empty when `unreadable` is set. */
  readonly form: readonly string[];
  /** Every FROM/JOIN names information_schema or pg_catalog. */
  readonly catalogOnly: boolean;
  /** Why the statement text could not be read, if it could not. */
  readonly unreadable?: string;
}

/** Every FROM/JOIN target is a catalog schema, and nothing is written. */
function isCatalogOnly(form: readonly string[]): boolean {
  if (form.some((tok) => ["insert", "update", "delete", "truncate"].includes(tok))) return false;
  const targets = form.flatMap((tok, i) => (tok === "from" || tok === "join" ? [form[i + 1] ?? ""] : []));
  return targets.length > 0 && targets.every((target) => target === "information_schema" || target === "pg_catalog");
}

function isOnCall(node: ts.Node): node is ts.CallExpression {
  return ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "on";
}

/**
 * Every `on(...)` statement under src/ and scripts/, resolved to the sites it
 * names. A query argument must be a module-level `const x = registerQuery({
 * site: "<literal>", ... })` in the same file, so the site is read, not guessed.
 */
function callSiteStatements(): CallSiteStatement[] {
  const found: CallSiteStatement[] = [];
  for (const file of [...tsFilesUnder(SRC), ...tsFilesUnder(SCRIPTS)]) {
    if (file === REGISTRY_FILE) continue;
    const text = readFileSync(file, "utf8");
    if (!/\bon\(/.test(text) || !text.includes("registry.ts")) continue;
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const rel = file.slice(BACKEND.length + 1);
    const sites = new Map<string, string>();
    const consts = new Map<string, ts.Expression>();
    const handles = new Set<string>(["sql"]);
    const collect = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        consts.set(node.name.text, node.initializer);
        const init = node.initializer;
        if (ts.isCallExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === "registerQuery") {
          const arg = init.arguments[0];
          const siteProp =
            arg && ts.isObjectLiteralExpression(arg)
              ? arg.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText() === "site")
              : undefined;
          if (siteProp && (ts.isStringLiteral(siteProp.initializer) || ts.isNoSubstitutionTemplateLiteral(siteProp.initializer))) {
            sites.set(node.name.text, siteProp.initializer.text);
          }
        }
      }
      if (isOnCall(node) && node.arguments[0] && ts.isIdentifier(node.arguments[0])) handles.add(node.arguments[0].text);
      ts.forEachChild(node, collect);
    };
    collect(source);

    /** Constant text: a literal, or a template/const/one-argument wrapper of constant text. */
    const constantText = (expr: ts.Expression, depth = 0): string | undefined => {
      if (depth > 8) return undefined;
      if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text;
      if (ts.isParenthesizedExpression(expr)) return constantText(expr.expression, depth + 1);
      if (ts.isIdentifier(expr)) {
        const init = consts.get(expr.text);
        return init ? constantText(init, depth + 1) : undefined;
      }
      if (ts.isTemplateExpression(expr)) {
        let out = expr.head.text;
        for (const span of expr.templateSpans) {
          const part = constantText(span.expression, depth + 1);
          if (part === undefined) return undefined;
          out += part + span.literal.text;
        }
        return out;
      }
      // A strings-array builder (`((text) => [text] as TemplateStringsArray)(TEXT)`).
      if (ts.isCallExpression(expr) && expr.arguments.length === 1) return constantText(expr.arguments[0]!, depth + 1);
      return undefined;
    };

    const isHelperCall = (e: ts.Node): e is ts.CallExpression =>
      ts.isCallExpression(e) && ts.isIdentifier(e.expression) && handles.has(e.expression.text);
    const containsFragment = (e: ts.Node): boolean => {
      let hit = false;
      const walk = (n: ts.Node): void => {
        if (isHelperCall(n) || ts.isTaggedTemplateExpression(n)) hit = true;
        else ts.forEachChild(n, walk);
      };
      walk(e);
      return hit;
    };

    const visit = (node: ts.Node): void => {
      if (isOnCall(node) && node.arguments.length >= 2) {
        const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        const where = `${rel}:${line}`;
        const named = node.arguments.slice(1).map((a) => (ts.isIdentifier(a) ? sites.get(a.text) : undefined));
        const parent = node.parent;
        let form: string[] = [];
        let unreadable: string | undefined;
        if (named.some((s) => s === undefined)) {
          unreadable = "a query argument is not a same-file `const x = registerQuery({ site: \"...\" })`";
        } else if (ts.isTaggedTemplateExpression(parent) && parent.tag === node) {
          const tpl = parent.template;
          if (ts.isNoSubstitutionTemplateLiteral(tpl)) form = reduceForm(lexSql(tpl.text));
          else {
            let sqlText = tpl.head.text;
            for (const span of tpl.templateSpans) {
              const e = span.expression;
              let mark: string = MARK.value;
              if (isHelperCall(e)) {
                const columns = e.arguments.slice(1);
                const before = lexSql(sqlText).at(-1);
                if (columns.length > 0 && columns.every((a) => ts.isStringLiteral(a))) {
                  const names = columns.map((a) => (a as ts.StringLiteral).text);
                  mark = `(${names.join(", ")}) VALUES (${names.map(() => MARK.value).join(", ")})`;
                } else if (before === "in") mark = MARK.list;
                else mark = MARK.ident;
              } else if (containsFragment(e)) {
                unreadable = `the span \${${e.getText()}} nests a helper call or tagged template the checker cannot expand`;
              }
              sqlText += ` ${mark} ${span.literal.text}`;
            }
            form = reduceForm(lexSql(sqlText));
          }
        } else if (ts.isCallExpression(parent) && parent.expression === node && parent.arguments.length === 1) {
          const constant = constantText(parent.arguments[0]!);
          if (constant === undefined) unreadable = "the strings array is not constant text";
          else form = reduceForm(lexSql(constant));
        } else {
          unreadable = "on(...) is neither a template tag nor called with a constant strings array";
        }
        found.push({
          where,
          sites: named.map((s) => s ?? "?"),
          form: unreadable ? [] : form,
          catalogOnly: !unreadable && isCatalogOnly(form),
          ...(unreadable ? { unreadable } : {}),
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
}

/**
 * Every way `site`'s probe fails to be its call sites' statement, as sentences.
 * Empty means the probe reduces to the same form as every template the site is
 * named in, and all of those templates reduce to one form.
 */
function probeMismatches(site: string, probeStatement: string, statements: readonly CallSiteStatement[]): string[] {
  const mine = statements.filter((st) => st.sites.includes(site) && !st.catalogOnly);
  if (mine.length === 0) return [`${site}: no on(...) call site issues it`];
  const forms = new Map<string, CallSiteStatement[]>();
  for (const st of mine) forms.set(showForm(st.form), [...(forms.get(showForm(st.form)) ?? []), st]);
  if (forms.size > 1) {
    return [
      `${site}: one declaration serves ${forms.size} different statements ` +
        `(${[...forms.values()].map((sts) => sts.map((st) => st.where).join("+")).join(", ")}) — give each its own site`,
    ];
  }
  const template = mine[0]!.form;
  const probe = probeForm(probeStatement);
  if (sameForm(template, probe)) return [];
  return [`${site}: probe is not the statement at ${mine.map((st) => st.where).join(", ")}\n  statement: ${showForm(template)}\n  probe:     ${showForm(probe)}`];
}

/**
 * The CATALOG-ONLY statements, pinned by value: each runs through a registered
 * site but reads nothing in `public`, so neither the form rule nor a probe can
 * say anything about it. A new one is an edit here, never a silent skip.
 */
const CATALOG_ONLY_STATEMENTS: readonly string[] = [
  // The readiness half of the boot re-check: does swarm_members.handle exist
  // yet (the pair scan it gates is the site's probe)?
  "src/db/handle-namespace:handleNamespaceConflicts.runtime+src/db/handle-namespace:handleNamespaceConflicts.owner",
];

// ─────────────────────────────────────────────────────────────────────────────
// The disposable database and the role logins.
// ─────────────────────────────────────────────────────────────────────────────

const PASSWORD = "rm_registry_execution_password";
/** A LOGIN role that holds nothing but what the exactness check hands it. */
const SCRATCH = "rm_registry_probe_scratch";

const database = `rm_registry_exec_${crypto.randomUUID().slice(0, 8)}`;
let admin: postgres.Sql<{}>;
const logins = new Map<string, postgres.Sql<{}>>();
/** Each role's login attributes before this file touched them, restored after. */
const saved: { rolname: string; rolcanlogin: boolean; rolpassword: string | null }[] = [];

function urlFor(role: string, name = database): string {
  const url = new URL(config.databaseUrl);
  url.pathname = `/${name}`;
  url.username = role;
  url.password = PASSWORD;
  return url.toString();
}

function login(role: string): postgres.Sql<{}> {
  let db = logins.get(role);
  if (!db) {
    db = postgres(urlFor(role), { max: 1, onnotice: () => {} });
    logins.set(role, db);
  }
  return db;
}

beforeAll(async () => {
  const superuser = postgres(config.databaseUrl, { max: 1, onnotice: () => {} });
  try {
    // The cluster's roles are shared by every file; their login attributes are
    // put back in afterAll so nothing here leaks into a file that runs later.
    saved.push(
      ...(await superuser<{ rolname: string; rolcanlogin: boolean; rolpassword: string | null }[]>`
        SELECT rolname, rolcanlogin, rolpassword FROM pg_authid WHERE rolname = ANY(${ROLES as string[]})`),
    );
    expect(saved.map((r) => r.rolname).sort()).toEqual([...ROLES].sort());
    for (const role of ROLES) await superuser.unsafe(`ALTER ROLE ${role} WITH LOGIN PASSWORD '${PASSWORD}'`);
    await superuser.unsafe(`DROP ROLE IF EXISTS ${SCRATCH}`);
    await superuser.unsafe(`CREATE ROLE ${SCRATCH} LOGIN NOINHERIT PASSWORD '${PASSWORD}'`);
    // A blank database owned by rm_owner (since Postgres 15 only the database
    // owner may CREATE in `public`), copied from template0 so nothing the
    // suite's migration-built template holds comes with it.
    await superuser.unsafe(`CREATE DATABASE ${database} OWNER rm_owner TEMPLATE template0`);
  } finally {
    await superuser.end({ timeout: 5 });
  }

  const adminUrl = new URL(config.databaseUrl);
  adminUrl.pathname = `/${database}`;
  admin = postgres(adminUrl.toString(), { max: 1, onnotice: () => {} });
  // pgcrypto is provider-managed (the snapshot's header: "a managed cluster
  // installs it and rm_owner may not"), so the provider's half is done here.
  await admin.unsafe("CREATE EXTENSION IF NOT EXISTS pgcrypto");
  await admin.unsafe("SET ROLE rm_owner");
  await bootstrapBlankDatabase(admin, await loadSnapshot());
  await admin.unsafe("RESET ROLE");
  // The scratch role reaches `public` and the sequences a serial INSERT
  // draws on, and no relation at all until a case grants it one.
  await admin.unsafe(`GRANT USAGE ON SCHEMA public TO ${SCRATCH}`);
  await admin.unsafe(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${SCRATCH}`);
});

afterAll(async () => {
  await Promise.all([...logins.values()].map((db) => db.end({ timeout: 5 })));
  if (admin) await admin.end({ timeout: 5 });
  const superuser = postgres(config.databaseUrl, { max: 1, onnotice: () => {} });
  try {
    await superuser.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await superuser.unsafe(`DROP ROLE IF EXISTS ${SCRATCH}`);
    for (const row of saved) {
      await superuser.unsafe(`ALTER ROLE ${row.rolname} WITH ${row.rolcanlogin ? "LOGIN" : "NOLOGIN"}`);
      if (row.rolpassword === null) await superuser.unsafe(`ALTER ROLE ${row.rolname} WITH PASSWORD NULL`);
      // A stored verifier is accepted back verbatim: Postgres recognises a
      // SCRAM or md5 string and stores it without hashing it again.
      else await superuser.unsafe(`ALTER ROLE ${row.rolname} WITH PASSWORD '${row.rolpassword.replace(/'/g, "''")}'`);
    }
  } finally {
    await superuser.end({ timeout: 5 });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Running one probe.
// ─────────────────────────────────────────────────────────────────────────────

type Outcome = { ok: true } | { ok: false; code: string; message: string };

class Rollback extends Error {}

/** Run `probe` on `db` inside a transaction that is always rolled back. */
async function runProbe(db: postgres.Sql<{}>, probe: NonNullable<QueryDeclaration["probe"]>): Promise<Outcome> {
  try {
    await db.begin(async (tx) => {
      await tx.unsafe("SET LOCAL statement_timeout = '15s'");
      await tx.unsafe(probe.statement, [...(probe.params ?? [])] as postgres.ParameterOrJSON<never>[]);
      throw new Rollback();
    });
  } catch (error) {
    if (error instanceof Rollback) return { ok: true };
    const e = error as { code?: string; message?: string };
    return { ok: false, code: e.code ?? "unknown", message: e.message ?? String(error) };
  }
  return { ok: false, code: "no-rollback", message: "the probe transaction committed instead of rolling back" };
}

/** Grant the scratch role exactly `held` (relation → privileges), and nothing else. */
async function scratchHolds(held: ReadonlyMap<string, readonly TablePrivilege[]>): Promise<void> {
  for (const [object, privileges] of held) {
    await admin.unsafe(`REVOKE ALL ON public.${object} FROM ${SCRATCH}`);
    if (privileges.length > 0) await admin.unsafe(`GRANT ${privileges.join(", ")} ON public.${object} TO ${SCRATCH}`);
  }
}

/**
 * Every way `declaration` fails, as sentences naming the site: the probe as the
 * declared role, then the exactness pair (see the file header). Empty means
 * the declaration is proved.
 *
 * `group` is every declaration named in the same `on(...)` call as this one
 * (itself included). A probe is the call site's whole statement (see the
 * static section above), so a JOIN's probe touches every joined relation: the
 * scratch role is handed what the SAME-ROLE members of the group declare, and
 * only this declaration's own privileges are then taken away one at a time.
 * A group member of another role is the same statement reached from another
 * program, and is proved by its own run.
 */
async function executeSite(declaration: QueryDeclaration, group: readonly QueryDeclaration[] = [declaration]): Promise<string[]> {
  const probe = declaration.probe;
  if (!probe) return [`${declaration.site}: has no probe`];
  const failures: string[] = [];
  const as = await runProbe(login(declaration.role), probe);
  if (!as.ok) failures.push(`${declaration.site}: as ${declaration.role} → ${as.code} ${as.message}`);

  const held = new Map<string, TablePrivilege[]>();
  for (const member of [declaration, ...group]) {
    if (member.role !== declaration.role) continue;
    held.set(member.object, [...new Set([...(held.get(member.object) ?? []), ...member.privileges])]);
  }
  const heldText = [...held].map(([object, privileges]) => `${privileges.join(", ")} on ${object}`).join("; ");
  try {
    await scratchHolds(held);
    const exact = await runProbe(login(SCRATCH), probe);
    if (!exact.ok) failures.push(`${declaration.site}: needs more than ${heldText} → ${exact.code} ${exact.message}`);
    for (const dropped of declaration.privileges) {
      const without = new Map(held);
      without.set(declaration.object, held.get(declaration.object)!.filter((p) => p !== dropped));
      await scratchHolds(without);
      const outcome = await runProbe(login(SCRATCH), probe);
      if (outcome.ok || outcome.code !== "42501") {
        failures.push(
          `${declaration.site}: declares ${dropped} on ${declaration.object} but its probe ` +
            (outcome.ok ? "runs without it" : `fails with ${outcome.code}, not 42501, without it: ${outcome.message}`),
        );
      }
    }
  } finally {
    for (const object of held.keys()) await admin.unsafe(`REVOKE ALL ON public.${object} FROM ${SCRATCH}`);
  }
  return failures;
}

// ─────────────────────────────────────────────────────────────────────────────
// The child enumeration.
// ─────────────────────────────────────────────────────────────────────────────

let enumerated: { sites: QueryDeclaration[]; declaring: Map<string, number> } | undefined;

/** The declarations a process holds after importing the api's entry modules,
 *  the worker's, and every declaring module on disk — and nothing else. */
async function childSites(): Promise<{ sites: QueryDeclaration[]; declaring: Map<string, number> }> {
  if (enumerated) return enumerated;
  const declaring = declaringModules();
  const modules = [...new Set([...entryImports(API_ENTRY), ...entryImports(WORKER_ENTRY), ...declaring.keys()])];
  const dir = mkdtempSync(join(tmpdir(), "rm-registry-exec-"));
  const script = join(dir, "enumerate.ts");
  writeFileSync(
    script,
    [
      ...modules.map((m) => `await import(${JSON.stringify(m)});`),
      `const { registeredSites } = await import(${JSON.stringify(REGISTRY_FILE)});`,
      `console.log("RM_REGISTRY_EXEC_SITES " + JSON.stringify(registeredSites()));`,
      // An imported module may start a timer; the answer is out, so leave.
      `process.exit(0);`,
    ].join("\n"),
  );
  try {
    // The child's pools point at the disposable database as rm_readonly, the
    // one role that can write nothing: enumeration must not issue a statement,
    // and if a module ever did at import, it could not change what is probed.
    const readonlyUrl = urlFor("rm_readonly");
    const child = Bun.spawn(["bun", "run", script], {
      env: { ...process.env, DATABASE_URL: readonlyUrl, WORKER_DATABASE_URL: readonlyUrl },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const line = out.split("\n").find((l) => l.startsWith("RM_REGISTRY_EXEC_SITES "));
    if (exitCode !== 0 || !line) throw new Error(`registry enumeration child failed (exit ${exitCode}):\n${out}\n${err}`);
    enumerated = { sites: JSON.parse(line.slice("RM_REGISTRY_EXEC_SITES ".length)) as QueryDeclaration[], declaring };
    return enumerated;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The tests.
// ─────────────────────────────────────────────────────────────────────────────

describe("every registered query runs as its declared role on a disposable database (spec §7.1)", () => {
  test("the child holds exactly the sites the source registers — the enumeration is complete", async () => {
    const { sites, declaring } = await childSites();
    const staticCount = [...declaring.values()].reduce((a, b) => a + b, 0);
    // Non-vacuous: the source registers sites, and the child saw every one.
    expect(staticCount).toBeGreaterThan(0);
    expect(sites.length).toBe(staticCount);
    // The api and worker entry graphs add nothing the on-disk scan missed: a
    // registration reachable only through them would be a site this count
    // cannot see.
    expect(new Set(sites.map((s) => s.site)).size).toBe(sites.length);
    for (const site of sites) expect(ROLES, site.site).toContain(site.role);
  });

  test("every site outside PROBE_PENDING carries a probe, and the backlog only shrinks", async () => {
    const { sites } = await childSites();
    const pending = new Set(PROBE_PENDING);
    expect(pending.size).toBe(PROBE_PENDING.length);
    expect(PROBE_PENDING.length).toBeLessThanOrEqual(PROBE_PENDING_CEILING);
    const missing = sites.filter((s) => !s.probe && !pending.has(s.site)).map((s) => s.site);
    expect(missing).toEqual([]);
    // Stale: an entry whose site now has a probe, or no longer exists, leaves.
    const unprobed = new Set(sites.filter((s) => !s.probe).map((s) => s.site));
    expect(PROBE_PENDING.filter((site) => !unprobed.has(site))).toEqual([]);
  });

  test("each probe succeeds as its declared LOGIN role, and needs exactly the declared privileges", async () => {
    const { sites } = await childSites();
    const probed = sites.filter((s) => s.probe);
    const bySite = new Map(sites.map((s) => [s.site, s]));
    const statements = callSiteStatements().filter((st) => !st.catalogOnly && !st.unreadable);
    const failures: string[] = [];
    const ranBy = new Map<RmRole, number>();
    for (const declaration of probed) {
      const group = [
        ...new Set(statements.filter((st) => st.sites.includes(declaration.site)).flatMap((st) => st.sites)),
      ].map((site) => bySite.get(site)!);
      failures.push(...(await executeSite(declaration, group)));
      ranBy.set(declaration.role, (ranBy.get(declaration.role) ?? 0) + 1);
    }
    // The message is the deliverable: each line names the site, the role and
    // the SQLSTATE, so a reader knows which declaration or grant is wrong.
    expect(failures).toEqual([]);
    // Non-vacuous: every probed site ran, and at least as many as last time.
    expect(probed.length).toBe(sites.length - PROBE_PENDING.length);
    expect(probed.length).toBeGreaterThanOrEqual(EXECUTED_FLOOR);
    expect([...ranBy.values()].reduce((a, b) => a + b, 0)).toBe(probed.length);
  }, 120_000);

  test("every on(...) call site is readable and names only registered sites", async () => {
    const { sites } = await childSites();
    const registered = new Set(sites.map((s) => s.site));
    const statements = callSiteStatements();
    // Non-vacuous: the scan reads the call sites the registry serves.
    expect(statements.length).toBeGreaterThanOrEqual(CALL_SITE_FLOOR);
    expect(statements.filter((st) => st.unreadable).map((st) => `${st.where}: ${st.unreadable}`)).toEqual([]);
    expect(statements.flatMap((st) => st.sites.filter((site) => !registered.has(site)).map((site) => `${st.where}: ${site}`))).toEqual([]);
    // Every registered site is issued somewhere: a declaration no statement
    // uses proves nothing about any statement.
    const issued = new Set(statements.flatMap((st) => st.sites));
    expect([...registered].filter((site) => !issued.has(site))).toEqual([]);
    // The catalog-only exemption is exactly the pinned list.
    expect(statements.filter((st) => st.catalogOnly).map((st) => st.sites.join("+")).sort()).toEqual([...CATALOG_ONLY_STATEMENTS].sort());
  });

  test("every probe IS its call site's statement, and each site serves one statement", async () => {
    const { sites } = await childSites();
    const statements = callSiteStatements();
    const probed = sites.filter((s) => s.probe);
    const mismatches = probed.flatMap((s) => probeMismatches(s.site, s.probe!.statement, statements));
    expect(mismatches).toEqual([]);
    // Non-vacuous: every probed site was compared against at least one template.
    expect(probed.length).toBeGreaterThanOrEqual(EXECUTED_FLOOR);
  });

  test("each login really is the declared role, not a superuser", async () => {
    for (const role of [...ROLES, SCRATCH]) {
      const [row] = await login(role)<{ who: string; su: string }[]>`
        SELECT current_user AS who, current_setting('is_superuser') AS su`;
      expect(row).toEqual({ who: role, su: "off" });
    }
  });
});

describe("RED CONTROL — a declaration the role's grants do not cover fails with 42501", () => {
  test("a real probe run as a role that lacks the grant is refused with 42501", async () => {
    const { sites } = await childSites();
    const insert = sites.find((s) => s.site === "src/api/routes/comments:createComment.insert");
    expect(insert?.probe).toBeDefined();
    // rm_readonly holds SELECT on comments and nothing else (grants.sql).
    const outcome = await runProbe(login("rm_readonly"), insert!.probe!);
    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? "" : outcome.code).toBe("42501");
  });

  test("the executor names a declaration whose role lacks the grant", async () => {
    // grants.sql leaves rm_app SELECT only on schema_manifest (§8.3: only
    // rm_owner writes it), so this declaration is exactly the kind of wrong
    // the test exists to catch.
    const wrong: QueryDeclaration = {
      role: "rm_app",
      object: "schema_manifest",
      privileges: ["UPDATE", "SELECT"],
      site: "tests/db-registry-execution:red_control",
      purpose: "A deliberately wrong declaration: rm_app rewriting the schema manifest.",
      callers: ["src/api/index"],
      probe: { statement: "UPDATE schema_manifest SET format_version = format_version WHERE singleton" },
    };
    const failures = await executeSite(wrong);
    expect(failures.some((f) => f.startsWith(`${wrong.site}: as rm_app → 42501`))).toBe(true);
  });

  test("the exactness check names a probe that needs nothing, and one that needs more than declared", async () => {
    // A probe that does not use its declared privilege proves nothing.
    const vacuous = await executeSite({
      role: "rm_app",
      object: "comments",
      privileges: ["INSERT"],
      site: "tests/db-registry-execution:vacuous",
      purpose: "A probe that never exercises its declaration.",
      callers: ["src/api/routes/comments"],
      probe: { statement: "SELECT 1 WHERE false AND EXISTS (SELECT FROM pg_class WHERE relname = 'comments')" },
    });
    expect(vacuous).toContain("tests/db-registry-execution:vacuous: declares INSERT on comments but its probe runs without it");
    // An INSERT ... RETURNING reads the row, so declaring INSERT alone is short.
    const short = await executeSite({
      role: "rm_app",
      object: "comments",
      privileges: ["INSERT"],
      site: "tests/db-registry-execution:short",
      purpose: "A declaration missing the SELECT its RETURNING needs.",
      callers: ["src/api/routes/comments"],
      probe: {
        statement: "INSERT INTO comments (page, author, content) VALUES ($1, $2, $3) RETURNING id",
        params: ["/probe", "probe", "probe"],
      },
    });
    expect(short.some((f) => f.startsWith("tests/db-registry-execution:short: needs more than INSERT on comments → 42501"))).toBe(true);
  });
});

describe("RED CONTROL — a probe that is not its call site's statement is refused", () => {
  const site = "src/api/routes/comments:createComment.insert";

  async function realProbe(): Promise<string> {
    const { sites } = await childSites();
    const statement = sites.find((s) => s.site === site)?.probe?.statement;
    expect(statement).toBeDefined();
    return statement!;
  }

  test("the real probe matches, so the controls below fail for the edit alone", async () => {
    expect(probeMismatches(site, await realProbe(), callSiteStatements())).toEqual([]);
  });

  test("dropping the RETURNING the call site carries is named", async () => {
    const probe = (await realProbe()).replace(/\s+RETURNING[\s\S]*$/i, "");
    const out = probeMismatches(site, probe, callSiteStatements());
    expect(out.length).toBe(1);
    expect(out[0]!.startsWith(`${site}: probe is not the statement at src/api/routes/comments.ts:`)).toBe(true);
  });

  test("a call site that gains ON CONFLICT DO UPDATE, or FOR UPDATE, no longer matches its probe", async () => {
    const statements = callSiteStatements();
    const probe = await realProbe();
    const edited = (suffix: string): CallSiteStatement[] =>
      statements.map((st) => (st.sites.includes(site) ? { ...st, form: reduceForm([...st.form, ...lexSql(suffix)]) } : st));
    expect(probeMismatches(site, probe, edited(" ON CONFLICT (id) DO UPDATE SET content = EXCLUDED.content"))).toHaveLength(1);
    const listSite = "src/api/routes/comments:listComments";
    const { sites } = await childSites();
    const listProbe = sites.find((s) => s.site === listSite)!.probe!.statement;
    expect(probeMismatches(listSite, listProbe, statements)).toEqual([]);
    const locked = statements.map((st) => (st.sites.includes(listSite) ? { ...st, form: reduceForm([...st.form, "for", "update"]) } : st));
    expect(probeMismatches(listSite, listProbe, locked)).toHaveLength(1);
  });

  test("one declaration serving two different statements is refused, whatever its probe", async () => {
    const statements = callSiteStatements();
    const mine = statements.find((st) => st.sites.includes(site))!;
    const twin: CallSiteStatement = { ...mine, where: "src/api/routes/comments.ts:0", form: reduceForm([...mine.form.slice(0, -2)]) };
    const out = probeMismatches(site, await realProbe(), [...statements, twin]);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("one declaration serves 2 different statements");
  });

  test("a span the checker cannot expand makes the call site unreadable, not skipped", () => {
    // The reducer's own vocabulary: a nested helper is a fragment, and a
    // fragment is exactly where RETURNING or FOR UPDATE could hide.
    expect(reduceForm(lexSql("SELECT id FROM t WHERE a IN ($1, $2) AND b = $3::int"))).toEqual(
      reduceForm(lexSql(`select ID from T where a in ${MARK.list} and b = ${MARK.value}`)),
    );
    expect(probeForm("INSERT INTO t (a, b) SELECT $1, NULL::jsonb WHERE false RETURNING id")).toEqual(
      reduceForm(lexSql(`INSERT INTO t (a, b) VALUES (${MARK.value}, ${MARK.value}) RETURNING id`)),
    );
    // WHERE false is the ONLY SELECT form accepted as VALUES.
    expect(probeForm("INSERT INTO t (a) SELECT $1 FROM u")).not.toEqual(reduceForm(lexSql(`INSERT INTO t (a) VALUES (${MARK.value})`)));
  });
});
