// No runtime path deletes — the inventory ratchet for D55 (6), issue #1026
// (smoke-production-spec.md §10 W2 "No runtime path deletes").
//
// D55 (6): "No runtime role (`rm_app`, `rm_worker`, `rm_readonly`) holds
// `DELETE` or `TRUNCATE` on any table ... Runtime code that deletes today is
// redesigned into one of three shapes" (a tombstone every read filters on, an
// expiry-filtered read with pruning left to rm_owner, or an upsert), and
// "rm_owner deletes only inside migrate, seed, or an explicit operator
// command". The redesign and the revoking migration land together in wave 5;
// until then this file makes the set of deleting code a CLOSED, NAMED set, so
// wave 5 has an exact worklist and nothing new can join it.
//
// WHAT COUNTS AS A DELETE. Every `.ts`/`.js` file under backend/src/ and
// backend/scripts/ is parsed (the TypeScript parser, not a line regex) and two
// things are collected:
//   * a SQL statement: a string or template literal (tagged — `sql\`...\``,
//     `tx\`...\``, `on(db, q)\`...\`` — or passed to `sql.unsafe`, or held in a
//     registry probe's `statement:`) in which a DELETE FROM or TRUNCATE begins
//     a statement: at the start of the literal, after `;`, or after `(` (a
//     data-modifying CTE, `WITH x AS (DELETE ...)`). Prose that mentions the
//     words ("UPDATE/DELETE/TRUNCATE refused", an operator hint "Emergency
//     reset: DELETE FROM ...") does not begin a statement and is not counted.
//   * a registry declaration: an object literal whose `privileges` array names
//     "DELETE" or "TRUNCATE" (src/db/registry.ts `registerQuery`).
// `Map.prototype.delete` / `Set.prototype.delete` calls are not SQL and are not
// counted: the owner's list named routes/comments.ts, routes/submissions.ts,
// chain/historical-prices.ts, chain/token-prices.ts and analytics/analyze/
// tool.ts, and every `.delete(` in them is an in-memory cache or stack
// operation. A test below pins that each of those files has such calls and
// contributes nothing.
//
// EVERY HIT IS ONE OF THREE THINGS, by exact file and table, never a pattern:
//   (i)   the wave-5 BACKLOG — runtime deletes D55 (6) redesigns: the admin
//         revocations (routes/admin.ts), the WebAuthn challenge consume,
//         cleanup and cap (routes/admin-webauthn.ts), and the wallet repair
//         pass (ops/wallet-backfill.ts). Shrink-only: wave 5 deletes each entry
//         as it converts the site onto migrations 0084-0086's columns.
//   (ii)  an rm_owner site reachable only from an rm_owner entry: seed
//         (db/seed.ts, declared rm_owner; projects/smoke-seed.ts, called only
//         from db/seed.ts), the operator's `--clean`
//         (analytics/store/seed-provenance.ts, declared rm_owner), and the
//         manifest publish (db/schema-manifest.ts `writeManifest`, called only
//         by the migrate run and the blank bootstrap, both of which refuse any
//         session but rm_owner).
//   (iii) a guard PROBE: `DELETE FROM public.<t> WHERE false`, issued to prove
//         the append-only or ledger guard refuses it. It matches no row in any
//         outcome, so it removes nothing (src/db/append-only-guard.ts
//         `deleteProbe`, src/db/analytics-ledger-guard.ts `probeFamily`).
// Anything else fails, naming file and line.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import ts from "typescript";
import type { QueryDeclaration } from "../src/db/registry.ts";

const BACKEND = join(import.meta.dir, "..");
const ROOTS = ["src", "scripts"] as const;

/** One delete the detector found. */
interface Hit {
  /** backend/-relative path. */
  readonly file: string;
  readonly line: number;
  /** `statement` — SQL text; `declaration` — a registry privilege list. */
  readonly kind: "statement" | "declaration";
  /** The table the statement removes from (as written, `public.` stripped),
   *  or the declaration's `object`. `${...}` when computed. */
  readonly table: string;
  /** The statement text or the declaration's role, for the messages. */
  readonly text: string;
}

/** A DELETE FROM / TRUNCATE that begins a statement inside SQL text. */
const STATEMENT =
  /(?:^|[;(])\s*(?:DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?)(?:\s+ONLY)?\s+((?:"?[A-Za-z_][A-Za-z0-9_]*"?\.)?(?:\$\{[^}]*\}|"?[A-Za-z_][A-Za-z0-9_]*"?))/gi;

function literalText(node: ts.Node, source: ts.SourceFile): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    // `${expr}` spans are kept as written, so a computed table reads as one.
    return node.head.text + node.templateSpans.map((span) => `\${${span.expression.getText(source)}}${span.literal.text}`).join("");
  }
  return null;
}

/** Scan one file's text. Exported through `detect` for the red control. */
function scanSource(file: string, text: string): Hit[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const hits: Hit[] = [];
  const lineOf = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const visit = (node: ts.Node): void => {
    const sqlText = literalText(node, source);
    if (sqlText !== null) {
      for (const match of sqlText.matchAll(STATEMENT)) {
        hits.push({
          file,
          line: lineOf(node),
          kind: "statement",
          table: match[1]!.replace(/"/g, "").replace(/^public\./, ""),
          text: sqlText.replace(/\s+/g, " ").trim(),
        });
      }
      // A template expression's spans can hold nested literals; keep walking.
    }
    if (ts.isObjectLiteralExpression(node)) {
      const prop = (name: string) =>
        node.properties.find(
          (p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === name,
        );
      const privileges = prop("privileges");
      if (privileges && ts.isArrayLiteralExpression(privileges.initializer)) {
        const named = privileges.initializer.elements
          .filter((e): e is ts.StringLiteral => ts.isStringLiteral(e))
          .map((e) => e.text);
        if (named.includes("DELETE") || named.includes("TRUNCATE")) {
          const object = prop("object");
          const role = prop("role");
          hits.push({
            file,
            line: lineOf(node),
            kind: "declaration",
            table: object && ts.isStringLiteral(object.initializer) ? object.initializer.text : "?",
            text: role && ts.isStringLiteral(role.initializer) ? role.initializer.text : "?",
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return hits;
}

function sourceFiles(): string[] {
  return ROOTS.flatMap((root) =>
    (readdirSync(join(BACKEND, root), { recursive: true, encoding: "utf8" }) as string[])
      .filter((rel) => /\.(ts|js|mjs)$/.test(rel))
      .map((rel) => join(root, rel)),
  ).sort();
}

const HITS: readonly Hit[] = sourceFiles().flatMap((file) => scanSource(file, readFileSync(join(BACKEND, file), "utf8")));

/** `file kind table` — the unit the inventory is recorded in. */
const keyOf = (hit: Pick<Hit, "file" | "kind" | "table">): string => `${hit.file} ${hit.kind} ${hit.table}`;

function tally(hits: readonly Hit[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const hit of hits) counts.set(keyOf(hit), (counts.get(keyOf(hit)) ?? 0) + 1);
  return counts;
}

// ───────────────────────────────────────────────────────────────────────────
// The inventory. Every line is `file kind table: count`.
// ───────────────────────────────────────────────────────────────────────────

/**
 * (i) THE WAVE-5 BACKLOG. Shrink-only: a converted site's entry is DELETED,
 * never kept, and nothing is ever added. Each names the column its redesign
 * writes.
 */
const BACKLOG: ReadonlyMap<string, number> = new Map([
  // Password change and recovery reset: revoke every passkey and session.
  // → admin_passkey.revoked_at / admin_session.revoked_at (migration 0084).
  ["src/api/routes/admin.ts statement admin_passkey", 2],
  ["src/api/routes/admin.ts statement admin_session", 2],
  // consumeChallenge, and storeChallenge's expired cleanup and cap trim.
  // → admin_webauthn_challenge.consumed_at (0085) plus expiry-filtered reads.
  ["src/api/routes/admin-webauthn.ts statement admin_webauthn_challenge", 3],
  // The repair pass's delete-the-day. → upsert plus superseded_at (0086).
  ["src/ops/wallet-backfill.ts statement wallet_balance_samples", 1],
  ["src/ops/wallet-backfill.ts statement wallet_sleeve_samples", 1],
]);

/** (ii) rm_owner sites, reachable only from an rm_owner entry (proved below). */
const OWNER_SITES: ReadonlyMap<string, number> = new Map([
  // seedJobSchedules's retired-row cleanup: two statements, two declarations.
  ["src/db/seed.ts statement job_schedules", 2],
  ["src/db/seed.ts declaration job_schedules", 2],
  // seedSmokeProjects, called only from src/db/seed.ts.
  ["src/projects/smoke-seed.ts statement openclaw_agents", 1],
  ["src/projects/smoke-seed.ts statement lobster_coins", 1],
  ["src/projects/smoke-seed.ts statement tracked_wallets", 1],
  ["src/projects/smoke-seed.ts statement agent_vaults", 1],
  // verifySeedProvenance's `--clean`: the statement, its registry probe and
  // its declaration.
  ["src/analytics/store/seed-provenance.ts statement raw_indicator_history", 2],
  ["src/analytics/store/seed-provenance.ts declaration raw_indicator_history", 1],
  // writeManifest's one-row replace.
  ["src/db/schema-manifest.ts statement schema_manifest", 1],
]);

/** (iii) Guard probes: `DELETE ... WHERE false`, table computed per guard. */
const PROBES: ReadonlyMap<string, number> = new Map([
  ["src/db/append-only-guard.ts statement ${table}", 1],
  ["src/db/analytics-ledger-guard.ts statement ${table}", 1],
]);

const RECORDED: ReadonlyMap<string, number> = new Map([...BACKLOG, ...OWNER_SITES, ...PROBES]);

/** Everything found that the inventory does not account for, as messages. */
function unrecorded(hits: readonly Hit[]): string[] {
  const found = tally(hits);
  const problems: string[] = [];
  for (const [key, count] of found) {
    const recorded = RECORDED.get(key) ?? 0;
    if (count > recorded) {
      const sites = hits.filter((hit) => keyOf(hit) === key).map((hit) => `${hit.file}:${hit.line} — ${hit.text.slice(0, 160)}`);
      problems.push(`${key}: ${count} found, ${recorded} recorded\n    ${sites.join("\n    ")}`);
    }
  }
  return problems;
}

describe("no runtime path deletes (spec §10 W2, D55 (6))", () => {
  test("the scan really read the tree — it finds the known sites, so an empty result can never pass by reading nothing", () => {
    expect(sourceFiles().length).toBeGreaterThan(200);
    expect(HITS.length).toBeGreaterThanOrEqual([...RECORDED.values()].reduce((a, b) => a + b, 0));
  });

  test("every DELETE and TRUNCATE is recorded: the wave-5 backlog, an rm_owner site, or a guard probe", () => {
    const problems = unrecorded(HITS);
    if (problems.length > 0) {
      throw new Error(
        `D55 (6): only rm_owner may DELETE or TRUNCATE, and no runtime path deletes. ${problems.length} unrecorded ` +
          "site(s) — redesign each as a tombstone, an expiry-filtered read or an upsert (never add it here):\n" +
          problems.join("\n"),
      );
    }
    expect(problems).toEqual([]);
  });

  test("every recorded entry still occurs at exactly its count — a converted site's entry is deleted, and the backlog only shrinks", () => {
    const found = tally(HITS);
    const stale = [...RECORDED].filter(([key, count]) => (found.get(key) ?? 0) !== count).map(([key, count]) => `${key}: recorded ${count}, found ${found.get(key) ?? 0}`);
    expect(stale).toEqual([]);
  });

  test("the backlog is exactly the wave-5 worklist: admin.ts x4, admin-webauthn.ts x3, wallet-backfill.ts x2", () => {
    const perFile = new Map<string, number>();
    for (const [key, count] of BACKLOG) {
      const file = key.split(" ")[0]!;
      perFile.set(file, (perFile.get(file) ?? 0) + count);
    }
    expect(Object.fromEntries(perFile)).toEqual({
      "src/api/routes/admin.ts": 4,
      "src/api/routes/admin-webauthn.ts": 3,
      "src/ops/wallet-backfill.ts": 2,
    });
  });

  test("every guard probe matches no row: its statement ends WHERE false", () => {
    const probes = HITS.filter((hit) => PROBES.has(keyOf(hit)));
    expect(probes.length).toBe(PROBES.size);
    for (const probe of probes) expect(probe.text).toMatch(/^DELETE FROM public\.\$\{table\} WHERE false$/);
  });

  test("Map/Set .delete() in the files the owner named is not SQL: each has such calls and contributes no hit", () => {
    const named = [
      "src/api/routes/comments.ts",
      "src/api/routes/submissions.ts",
      "src/chain/historical-prices.ts",
      "src/chain/token-prices.ts",
      "src/analytics/analyze/tool.ts",
    ];
    for (const file of named) {
      expect(/\.delete\(/.test(readFileSync(join(BACKEND, file), "utf8")), file).toBe(true);
      expect(HITS.filter((hit) => hit.file === file), file).toEqual([]);
    }
  });
});

describe("the rm_owner sites are reachable only from rm_owner entries", () => {
  /** Every `import ... from "<spec>"` in src/ and scripts/, as (importer, resolved backend/-relative target). */
  function importersOf(target: string): string[] {
    const importers: string[] = [];
    for (const file of sourceFiles()) {
      const text = readFileSync(join(BACKEND, file), "utf8");
      for (const match of text.matchAll(/(?:import|export)\s[^;]*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)) {
        const spec = match[1] ?? match[2]!;
        if (!spec.startsWith(".")) continue;
        if (join(dirname(file), spec) === target) importers.push(file);
      }
    }
    return importers.sort();
  }

  test("projects/smoke-seed.ts is imported by db/seed.ts alone", () => {
    expect(importersOf("src/projects/smoke-seed.ts")).toEqual(["src/db/seed.ts"]);
  });

  test("writeManifest (schema-manifest.ts's delete) is called only by the migrate run and the blank bootstrap, each of which refuses any session but rm_owner", () => {
    const callers = sourceFiles().filter((file) =>
      file !== "src/db/schema-manifest.ts" && /\bwriteManifest\s*\(/.test(readFileSync(join(BACKEND, file), "utf8")),
    );
    expect(callers).toEqual(["scripts/migrate-run.ts", "src/db/schema-snapshot.ts"]);
    // The refusals that make those callers rm_owner-only, by their own text.
    expect(readFileSync(join(BACKEND, "scripts/migrate-run.ts"), "utf8")).toContain('if (row.effective === "rm_owner") return;');
    expect(readFileSync(join(BACKEND, "src/db/schema-snapshot.ts"), "utf8")).toContain('if (role !== "rm_owner") {');
  });

  test("every registry declaration of DELETE or TRUNCATE is rm_owner's — read from the registry itself, in a child process", () => {
    // registeredSites() is process-global and backend `bun test` runs every
    // file in one process, so the declaring modules are imported in a CHILD
    // (the same shape as tests/db-registry.test.ts), which reports exactly the
    // declarations they own whatever this process imported first.
    const declaring = sourceFiles().filter(
      (file) => file.endsWith(".ts") && file !== "src/db/registry.ts" && readFileSync(join(BACKEND, file), "utf8").includes("registerQuery("),
    );
    const dir = mkdtempSync(join(tmpdir(), "rm-no-runtime-delete-"));
    const script = join(dir, "enumerate.ts");
    writeFileSync(script, [
      ...declaring.map((file) => `await import(${JSON.stringify(join(BACKEND, file))});`),
      `const { registeredSites } = await import(${JSON.stringify(join(BACKEND, "src", "db", "registry.ts"))});`,
      `console.log("RM_REGISTRY_SITES " + JSON.stringify(registeredSites()));`,
    ].join("\n"));
    let sites: QueryDeclaration[];
    try {
      const child = Bun.spawnSync(["bun", "run", script], { env: process.env });
      const line = child.stdout.toString().split("\n").find((l) => l.startsWith("RM_REGISTRY_SITES "));
      if (child.exitCode !== 0 || !line) throw new Error(`registry enumeration failed (exit ${child.exitCode}):\n${child.stderr.toString()}`);
      sites = JSON.parse(line.slice("RM_REGISTRY_SITES ".length)) as QueryDeclaration[];
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(sites.length).toBeGreaterThan(50);
    const deleting = sites
      .filter((site) => site.privileges.some((p) => p === "DELETE" || p === "TRUNCATE"))
      .map((site) => ({ role: site.role, object: site.object, site: site.site }))
      .sort((a, b) => a.site.localeCompare(b.site));
    expect(deleting).toEqual([
      { role: "rm_owner", object: "raw_indicator_history", site: "src/analytics/store/seed-provenance:verifySeedProvenance.clean" },
      { role: "rm_owner", object: "job_schedules", site: "src/db/seed:seedJobSchedules.deleteAnalyticsRun" },
      { role: "rm_owner", object: "job_schedules", site: "src/db/seed:seedJobSchedules.deleteHourlyRepair" },
    ]);
  }, 60_000);
});

describe("RED CONTROL: the detector catches a planted runtime delete in every shape", () => {
  const planted = [
    'import { sql } from "../db/client.ts";',
    "export async function prune(id: string) {",
    "  await sql`DELETE FROM jobs WHERE id = ${id}`;",
    '  await sql.unsafe("TRUNCATE TABLE job_runs");',
    "  await sql`WITH gone AS (DELETE FROM job_schedules WHERE kind = 'x' RETURNING id) SELECT count(*) FROM gone`;",
    "  await sql`UPDATE jobs SET status = 'x'; delete from comments where true`;",
    "  const m = new Map<string, number>(); m.delete(id);",
    '  const note = "UPDATE/DELETE/TRUNCATE are refused; Emergency reset: DELETE FROM admin_credential;";',
    "  return note;",
    "}",
    "export const q = { role: \"rm_app\", object: \"jobs\", privileges: [\"DELETE\", \"SELECT\"] };",
  ].join("\n");

  test("each planted SQL delete and declaration is found; the Map.delete and the prose are not", () => {
    const hits = scanSource("src/worker/planted.ts", planted);
    expect(hits.map((h) => `${h.kind} ${h.table} :${h.line}`).sort()).toEqual([
      "declaration jobs :11",
      "statement comments :6",
      "statement job_runs :4",
      "statement job_schedules :5",
      "statement jobs :3",
    ]);
  });

  test("the planted file fails the inventory, naming file and line", () => {
    const problems = unrecorded([...HITS, ...scanSource("src/worker/planted.ts", planted)]);
    expect(problems.length).toBe(5);
    expect(problems.join("\n")).toContain("src/worker/planted.ts:3");
  });

  test("one more DELETE in a backlog file fails too — the backlog is a count, not a file exemption", () => {
    const extra = scanSource("src/api/routes/admin.ts", "await tx`DELETE FROM admin_session WHERE token = ${t}`;");
    expect(unrecorded([...HITS, ...extra])).toEqual([
      expect.stringContaining("src/api/routes/admin.ts statement admin_session: 3 found, 2 recorded"),
    ]);
  });
});
