// The test harness must run the PostgreSQL major production runs, and must go
// on doing so without an audit (issue #691).
//
// WHAT WENT WRONG, AND WHY A GREEN SUITE DID NOT CATCH IT. tests/preload.ts
// provisioned postgres:17-alpine while production is 18 and the rollout
// tooling's digital smoke-twin (scripts/lib/restore-container.ts) had already moved
// to postgres:18 on purpose. So every migration in backend/migrations/ — the
// artefacts most likely to behave differently across a major — was validated
// on 17 and applied on 18, and the whole suite passed the entire time. There
// was no assertion to fail, because nothing anywhere read the version. The
// mismatch was found by a human reading two files.
//
// The two halves below are the standing replacement for that human:
//
//   1. VERSION. What the running server actually reports, compared against
//      the pinned major. This is the assertion that has to exist for
//      "the suite runs 18" to be a tested fact rather than a claim about a
//      string in a Dockerfile-adjacent file. It executes against the shared
//      ephemeral Postgres from tests/preload.ts, which THROWS rather than
//      skips when Docker is unavailable — so this can never be a false green.
//   2. SINGLE SOURCE. No file under backend/tests/ may carry its own
//      `postgres:<something>` image literal. Five sites spawn a Postgres
//      container between them (preload plus four migration tests that need a
//      pre-migration baseline); five literals is exactly the shape that
//      drifted, and adding a sixth is the likeliest way to reintroduce it.
//      A grep is a weak test in general, but the failure being prevented here
//      IS textual: a literal in a `docker run` argv that no assertion reads.
import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "../src/db/client.ts";
import { POSTGRES_IMAGE, POSTGRES_MAJOR } from "../../scripts/lib/postgres-image.ts";

const testsDir = dirname(fileURLToPath(import.meta.url));

test("the suite's ephemeral Postgres runs the pinned major (production's)", async () => {
  const [server] = (await sql`
    SELECT current_setting('server_version')           AS version,
           current_setting('server_version_num')::int  AS num
  `) as unknown as { version: string; num: number }[];

  // Stated independently of POSTGRES_MAJOR: if both the constant and this
  // assertion were derived from the same expression, editing the constant down
  // to 17 again would keep the test green.
  expect(Math.floor(server.num / 10000)).toBe(18);
  // ...and the constant is what the harness actually launched, so the two must
  // also agree with each other.
  expect(Math.floor(server.num / 10000)).toBe(POSTGRES_MAJOR);
  expect(POSTGRES_IMAGE).toBe(`postgres:${POSTGRES_MAJOR}`);
});

test("no test file pins a Postgres image of its own — the constant is the only source", async () => {
  const entries = await readdir(testsDir, { recursive: true, withFileTypes: true });
  const offenders: string[] = [];
  const scanned: string[] = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (!e.name.endsWith(".ts")) continue;
    const path = join(e.parentPath ?? testsDir, e.name);
    if (path === fileURLToPath(import.meta.url)) continue; // this file names the tags it forbids
    const src = await readFile(path, "utf8");
    scanned.push(path);
    // Only a real image REFERENCE counts: `postgres:` followed by a digit.
    // Prose mentioning `postgres:18` inside a comment would trip this too, and
    // that is the intended strictness — a comment stating a version is a
    // second copy of the fact, and comments are how the last one got stale.
    for (const m of src.matchAll(/postgres:\d[\w.-]*/g)) offenders.push(`${path}: ${m[0]}`);
  }
  expect(offenders).toEqual([]);

  // An empty `offenders` proves nothing unless the walk actually visited the
  // files. Pin the two facts that would make this test vacuous: the walk found
  // the whole directory, and it descended into the subdirectories (a
  // non-recursive walk, or a Dirent without `parentPath`, would silently miss
  // tests/api, tests/db and tests/support).
  expect(scanned.length).toBeGreaterThan(100);
  expect(scanned.some((p) => p.endsWith(`${join("tests", "preload.ts")}`))).toBe(true);
  expect(scanned.some((p) => p.includes(`${join("tests", "api")}`))).toBe(true);
  expect(scanned.some((p) => p.includes(`${join("tests", "support")}`))).toBe(true);
});
