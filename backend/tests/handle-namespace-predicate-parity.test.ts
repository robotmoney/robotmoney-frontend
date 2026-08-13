// The two handle/id namespace DETECTION predicates must agree — mechanically,
// not by the comment that used to ask for it (issue #602, DI-601-006).
//
// THE TWO. Migration 0031's install-time DO block
// (backend/migrations/0031_swarm_member_handle_namespace.sql) inspects data
// already present when the migration installs. The runtime re-check
// (HANDLE_NAMESPACE_CONFLICT_RELATION in backend/src/db/handle-namespace.ts)
// inspects data a RESTORE loaded behind the trigger's back, and is what the api
// entrypoint and prod-bootstrap run. They answer the same question at two
// different times, and a database is only actually covered where BOTH hold.
//
// WHY A DIFFERENTIAL TEST RATHER THAN A SHARED SQL SOURCE. An applied migration
// is a frozen artefact: src/db/migrate.ts reads each .sql file whole and applies
// it once, tracked by filename, and there is no include/parameterisation seam to
// hang a shared file on. Rewriting 0031 to pull its predicate from elsewhere
// would also change a file already applied on every deployment. So the shared
// source is impossible and the agreement is enforced here instead — in two
// layers, because either alone is defeatable:
//   1. TEXTUAL — the relation is extracted from the .sql file and compared,
//      whitespace-normalised, against the exported constant. Catches a drift in
//      either file even for rows no fixture happens to cover.
//   2. BEHAVIOURAL — both relations are executed against the SAME seeded rows
//      and must return the same pairs, and that set is pinned to an
//      independently-stated expectation. Catches a semantic drift that
//      normalisation would have forgiven, and catches both sides drifting
//      together.
//
// Runs against the suite's ephemeral Postgres (tests/preload.ts), which throws
// rather than skips when Docker is absent. The forbidden rows are built inside a
// transaction that is always rolled back, so the shared suite database never
// actually holds a pair the schema forbids.
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "../src/db/client.ts";
import {
  HANDLE_NAMESPACE_CONFLICT_RELATION,
  handleNamespaceConflicts,
} from "../src/db/handle-namespace.ts";

const migrationPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "migrations",
  "0031_swarm_member_handle_namespace.sql",
);

/** Collapse whitespace so indentation and line breaks are not a difference. */
function normalize(sqlText: string): string {
  return sqlText.replace(/\s+/g, " ").trim();
}

/**
 * The `FROM swarm_members a JOIN swarm_members b ON …` relation as migration
 * 0031's DO block actually spells it, read out of the committed .sql file.
 * Throws — never returns a fallback — if the shape is not found: a silently
 * empty extraction would turn this whole file into a false green.
 */
async function migrationRelation(): Promise<string> {
  const ddl = await readFile(migrationPath, "utf8");
  const doBlock = ddl.match(/DO \$\$[\s\S]*?END \$\$;/);
  if (!doBlock) throw new Error(`no DO $$ … END $$; block found in ${migrationPath}`);
  const m = doBlock[0].match(/(FROM\s+swarm_members\s+a\s+JOIN\s+swarm_members\s+b\s+ON\s+[^;]+?)\s*;/);
  if (!m) throw new Error(`no "FROM swarm_members a JOIN swarm_members b ON …" relation in 0031's DO block`);
  return normalize(m[1]!);
}

test("layer 1 (textual): 0031's DO-block relation is byte-identical to HANDLE_NAMESPACE_CONFLICT_RELATION", async () => {
  const fromMigration = await migrationRelation();
  // The extraction really found something predicate-shaped — otherwise a
  // regex that silently matched an empty string would make this trivially true.
  expect(fromMigration).toContain("b.id");
  expect(fromMigration).toContain("a.handle");
  expect(fromMigration).toBe(normalize(HANDLE_NAMESPACE_CONFLICT_RELATION));
});

test("layer 2 (behavioural): both relations flag exactly the same pairs, over rows covering every edge the predicate has an opinion about", async () => {
  const relation = await migrationRelation();
  const tag = crypto.randomUUID().slice(0, 8);
  // Lowercase hex ids, so the uppercase variant below is genuinely a different
  // string and the case-sensitivity edge is real.
  const x = `pp-x-${tag}`;
  const y = `pp-y-${tag}`;
  const u = `pp-u-${tag}`;
  const v = `pp-v-${tag}`;
  const z = `pp-z-${tag}`;
  const w = `pp-w-${tag}`;

  const pairsOf = (rows: { holder: string; shadowed: string }[]) =>
    rows.map((r) => `${r.holder}->${r.shadowed}`).sort();

  let fromMigration: string[] = [];
  let fromRuntime: string[] = [];
  let sentences: string[] = [];

  const rollback = new Error("rollback");
  try {
    await sql.begin(async (tx) => {
      // The pairs below are unreachable through the trigger — that is the whole
      // point — so it is disabled for the inserts and restored with
      // ENABLE ALWAYS, never a plain ENABLE (which silently downgrades
      // tgenabled from 'A' to 'O' and would hand every later test in the shared
      // suite the replica-role bypass 0031 exists to close).
      await tx`ALTER TABLE swarm_members DISABLE TRIGGER swarm_members_handle_namespace_trigger`;

      // A clean row: its handle is nobody's id.
      await tx`INSERT INTO swarm_members (id, status, name, handle) VALUES (${x}, 'active', 'X', ${`${x}-h`})`;
      // VIOLATION: y's handle is x's id.
      await tx`INSERT INTO swarm_members (id, status, name, handle) VALUES (${y}, 'active', 'Y', ${x})`;
      // VIOLATION x2, mutual: each of u/v publishes under the other's id. Both
      // directions must be reported — that is what "iterates all ordered pairs"
      // buys over the trigger's per-row view.
      await tx`INSERT INTO swarm_members (id, status, name, handle) VALUES (${u}, 'active', 'U', ${v})`;
      await tx`INSERT INTO swarm_members (id, status, name, handle) VALUES (${v}, 'active', 'V', ${u})`;
      // NOT a violation: a member whose handle is its OWN id (what 0030's
      // default-handle trigger produces for every writer that supplies none).
      await tx`INSERT INTO swarm_members (id, status, name) VALUES (${z}, 'active', 'Z')`;
      // NOT a violation: a handle that differs from an id only by case. The
      // predicate is an exact string match and both sides must agree that it is.
      await tx`INSERT INTO swarm_members (id, status, name, handle) VALUES (${w}, 'active', 'W', ${x.toUpperCase()})`;

      await tx`ALTER TABLE swarm_members ENABLE ALWAYS TRIGGER swarm_members_handle_namespace_trigger`;

      const scoped = `AND a.id LIKE 'pp-%${tag}' `;
      fromMigration = pairsOf(
        (await tx.unsafe(
          `SELECT a.id AS holder, b.id AS shadowed ${relation} ${scoped}ORDER BY a.id, b.id`,
        )) as unknown as { holder: string; shadowed: string }[],
      );
      fromRuntime = pairsOf(
        (await tx.unsafe(
          `SELECT a.id AS holder, b.id AS shadowed ${HANDLE_NAMESPACE_CONFLICT_RELATION} ${scoped}ORDER BY a.id, b.id`,
        )) as unknown as { holder: string; shadowed: string }[],
      );
      // …and the real exported function over the real (unscoped) relation, so
      // the thing the api actually calls is what is being graded, not a
      // reconstruction of it.
      sentences = (await handleNamespaceConflicts(tx)).filter((s) => s.includes(tag));

      throw rollback;
    });
  } catch (e) {
    if (e !== rollback) throw e;
  }

  // Stated independently of either query, so both sides drifting the same way
  // is still caught.
  const expected = [`${y}->${x}`, `${u}->${v}`, `${v}->${u}`].sort();
  expect(fromMigration).toEqual(expected);
  expect(fromRuntime).toEqual(expected);
  expect(fromRuntime).toEqual(fromMigration);
  expect(sentences).toHaveLength(3);

  // The rollback really did undo it, trigger state included ('A' = ALWAYS).
  expect((await handleNamespaceConflicts()).filter((s) => s.includes(tag))).toEqual([]);
  const [trg] = await sql<{ tgenabled: string }[]>`
    SELECT tgenabled FROM pg_trigger WHERE tgname = 'swarm_members_handle_namespace_trigger'`;
  expect(trg!.tgenabled).toBe("A");
});
