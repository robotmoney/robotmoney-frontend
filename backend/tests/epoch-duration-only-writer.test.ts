// [epoch-duration] (issue #1026, system-scheduler-spec.md §2.3): the admin route
// is the ONLY writer of a subject's three scheduling columns. No env var, seed
// or CLI path writes `epoch_duration_seconds`, `epoch_anchor` or
// `judging_duration_seconds`; a blank database gets them from the schema
// declaration's defaults and a populated one keeps what it has.
//
// A static scan, because a writer added later would pass every behavioural test
// that never happens to run it. Statements are read up to their terminator, so
// a column named in a SELECT or in a session update that merely copies the
// subject's value is not a write to the subject.
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const REPO = join(import.meta.dir, "..", "..");
const ALLOWED_WRITER = "backend/src/swarm/admin.ts";
const COLUMNS = ["epoch_duration_seconds", "epoch_anchor", "judging_duration_seconds"];
const ROOTS = ["backend/src", "backend/scripts", "scripts", "stacks"];
const ENV_NAME = /\b(?:RM_|SMOKE_|SWARM_)?(?:EPOCH_DURATION|EPOCH_ANCHOR|JUDGING_DURATION)\w*\b/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "tests" || name === "test" || name === "goldens") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|sh|ya?ml|sql)$/.test(name) && !/\.test\.ts$/.test(name)) out.push(path);
  }
  return out;
}

/** The statements of `text` that write swarm_subjects and name a scheduling column. */
export function subjectWritesNamingColumns(text: string): string[] {
  const hits: string[] = [];
  for (const m of text.matchAll(/\b(?:UPDATE\s+swarm_subjects|INSERT\s+INTO\s+swarm_subjects)\b/gi)) {
    const rest = text.slice(m.index!);
    const end = rest.search(/;|`\s*[;)\n]/);
    const statement = end === -1 ? rest : rest.slice(0, end);
    if (COLUMNS.some((c) => statement.includes(c))) hits.push(statement.split("\n")[0]!.trim());
  }
  return hits;
}

describe("the admin route is the only writer of the three scheduling columns", () => {
  const files = ROOTS.flatMap((root) => walk(join(REPO, root)));

  test("the scan reads real files", () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files.map((f) => relative(REPO, f))).toContain(ALLOWED_WRITER);
  });

  test("no file but the admin module writes swarm_subjects with one of the columns", () => {
    const writers = files
      .filter((file) => subjectWritesNamingColumns(readFileSync(file, "utf8")).length > 0)
      .map((file) => relative(REPO, file));
    expect(writers).toEqual([ALLOWED_WRITER]);
  });

  test("no env var, compose line or script names a duration, anchor or judging duration setting", () => {
    const hits = files
      .filter((file) => ENV_NAME.test(readFileSync(file, "utf8")))
      .map((file) => relative(REPO, file));
    expect(hits).toEqual([]);
  });

  test("red control: a planted seed that sets the duration is reported", () => {
    const planted = "await sql`UPDATE swarm_subjects SET epoch_duration_seconds = 60 WHERE id = ${id}`;";
    expect(subjectWritesNamingColumns(planted)).toHaveLength(1);
    expect(subjectWritesNamingColumns("await sql`INSERT INTO swarm_subjects (id, name) VALUES (${a}, ${b})`;")).toEqual([]);
    expect(subjectWritesNamingColumns("await sql`UPDATE swarm_sessions SET judging_duration_seconds = t.judging_duration_seconds`;")).toEqual([]);
  });
});
