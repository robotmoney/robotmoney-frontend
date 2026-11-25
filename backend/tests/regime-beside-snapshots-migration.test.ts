// Migration 0136 adds the artifact kind `regime_beside_snapshots` (issue 1753,
// decision D96): the regime rows of a run whose methodology is published beside
// the main line (v5) are frozen under it.
//
//   * On a database as it was before 0136 (the old CHECK and the old natural
//     keys function, restored here from migrations 0059 and 0123), the new kind
//     is refused. After 0136 it is accepted, and its natural_keys are its row
//     dates in element order, as a `regime_snapshots` artifact's are.
//   * A kind outside the list is still refused, and every kind that was
//     accepted before still is, with the natural keys it had.
//   * A row stored before 0136 keeps its stored natural_keys: nothing is
//     rewritten. A second run of the file changes nothing.
//   * The header declares compat additive, and the file bounds its lock wait.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { parseMigrationHeader } from "../src/db/schema-compat.ts";
import { beginRun } from "../src/analytics/store/run-ledger-store.ts";
import { useCleanDatabase } from "./support/clean-db.ts";
import { fixtureDb } from "./support/fixture-db.ts";

useCleanDatabase(import.meta.file);

const FILE = "0136_regime_beside_snapshots.sql";
const M0136 = readFileSync(join(import.meta.dir, "..", "migrations", FILE), "utf8");
const M0123 = readFileSync(join(import.meta.dir, "..", "migrations", "0123_analytics_parity_sweep_daily.sql"), "utf8");
const CHECK = "analytics_output_snapshots_artifact_kind_check";

// The state 0136 starts from: the natural keys function of 0123 and the CHECK of 0059.
const OLD_FUNCTION = M0123.slice(M0123.indexOf("CREATE OR REPLACE FUNCTION rm_analytics_output_natural_keys"), M0123.indexOf("CREATE OR REPLACE FUNCTION rm_json_bytes_hash"));
const BEFORE_0136 = `${OLD_FUNCTION}
ALTER TABLE analytics_output_snapshots DROP CONSTRAINT ${CHECK};
ALTER TABLE analytics_output_snapshots ADD CONSTRAINT ${CHECK}
  CHECK (artifact_kind IN ('regime_snapshots', 'research_signals', 'warnings', 'logs', 'exceptions'));`;

async function asOwner(text: string): Promise<void> {
  const db = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
  try {
    await db.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE rm_owner");
      await tx.unsafe(text);
    });
  } finally {
    await db.end({ timeout: 5 });
  }
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

async function newRun(): Promise<string> {
  const { runId } = await beginRun({
    runKey: crypto.randomUUID(),
    asof: "2026-11-20",
    toolId: "regime",
    sourceLabel: "fixture",
    methodology: { toolId: "regime", versionLabel: "v5", config: { issue: 1753 } },
    buildIdentity: "issue-1753-migration-test",
  });
  return runId;
}

/** Insert one artifact as the owner; resolves to its natural keys, or rejects with the database's refusal. */
async function insertArtifact(runId: string, kind: string, payload: string): Promise<string[] | null> {
  const [row] = await fixtureDb<{ natural_keys: string[] | null }[]>`
    INSERT INTO analytics_output_snapshots (run_id, artifact_kind, payload_bytes, checksum)
    VALUES (${runId}::bigint, ${kind}, ${Buffer.from(payload)}, ${sha256(payload)})
    RETURNING natural_keys`;
  return row!.natural_keys;
}

const checkDefinition = async (): Promise<string> =>
  (await fixtureDb<{ def: string }[]>`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = ${CHECK}`)[0]!.def;

const ROWS = JSON.stringify([
  { date: "2026-11-18", composite: null, regime: null, version: "v5" },
  { date: "2026-11-19", composite: 0.61, regime: "neutral", version: "v5" },
  { date: "2026-11-20", composite: 0.7, regime: "risk_on", version: "v5" },
]);
const DATES = ["2026-11-18", "2026-11-19", "2026-11-20"];

describe("migration 0136: the artifact kind regime_beside_snapshots", () => {
  test("the header declares compat additive, and the file bounds its lock wait and replaces only the kind list", () => {
    expect(parseMigrationHeader(FILE, M0136)).toMatchObject({ filename: FILE, compat: "additive", metadataVersion: 1 });
    expect(M0136).toContain("SET LOCAL lock_timeout = '2s';");
    expect(M0136).toContain(`DROP CONSTRAINT IF EXISTS ${CHECK}`);
    expect(M0136).toContain("NOT VALID");
    expect(M0136).toContain(`VALIDATE CONSTRAINT ${CHECK}`);
    // Nothing is dropped but the constraint it re-adds, and no row is written or rewritten.
    const statements = M0136.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");
    expect(statements.match(/\bDROP\b/g)!.length).toBe(1);
    for (const forbidden of ["DELETE", "UPDATE ", "TRUNCATE", "INSERT", "DROP TABLE", "DROP COLUMN", "ALTER COLUMN"]) expect(statements.includes(forbidden)).toBe(false);
  });

  test("before 0136 the kind is refused; after it the artifact is accepted with natural_keys equal to its row dates", async () => {
    await asOwner(BEFORE_0136);
    expect(await checkDefinition()).not.toContain("regime_beside_snapshots");
    // A regime artifact stored before the migration, with the natural keys the old function gave it.
    const oldRun = await newRun();
    expect(await insertArtifact(oldRun, "regime_snapshots", ROWS)).toEqual(DATES);
    const before = await fixtureDb<{ id: string; natural_keys: string[] | null; xmin: string }[]>`
      SELECT id::text AS id, natural_keys, xmin::text AS xmin FROM analytics_output_snapshots WHERE run_id = ${oldRun}::bigint`;
    const refusedRun = await newRun();
    await expect(insertArtifact(refusedRun, "regime_beside_snapshots", ROWS)).rejects.toThrow(/violates check constraint/);

    await asOwner(M0136);

    expect(await checkDefinition()).toBe(
      "CHECK ((artifact_kind = ANY (ARRAY['regime_snapshots'::text, 'regime_beside_snapshots'::text, 'research_signals'::text, 'warnings'::text, 'logs'::text, 'exceptions'::text])))",
    );
    const [{ convalidated }] = await fixtureDb<{ convalidated: boolean }[]>`SELECT convalidated FROM pg_constraint WHERE conname = ${CHECK}`;
    expect(convalidated).toBe(true);
    // The new kind is accepted, and its natural keys are its row dates, in element order.
    expect(await insertArtifact(refusedRun, "regime_beside_snapshots", ROWS)).toEqual(DATES);
    // The publication selection's question, answered from the index: does it carry its as-of row?
    const [{ carries, misses }] = await fixtureDb<{ carries: boolean; misses: boolean }[]>`
      SELECT natural_keys @> ARRAY['2026-11-20'] AS carries, natural_keys @> ARRAY['2026-11-21'] AS misses
        FROM analytics_output_snapshots WHERE run_id = ${refusedRun}::bigint AND artifact_kind = 'regime_beside_snapshots'`;
    expect([carries, misses]).toEqual([true, false]);
    // The empty list a beside run freezes as its regime_snapshots artifact has no keys.
    expect(await insertArtifact(refusedRun, "regime_snapshots", "[]")).toEqual([]);
    // The row stored before the migration was not rewritten.
    const after = await fixtureDb<{ id: string; natural_keys: string[] | null; xmin: string }[]>`
      SELECT id::text AS id, natural_keys, xmin::text AS xmin FROM analytics_output_snapshots WHERE run_id = ${oldRun}::bigint`;
    expect([...after]).toEqual([...before]);
  });

  test("a kind outside the list is still refused, and every kind accepted before keeps its natural keys", async () => {
    const run = await newRun();
    for (const bad of ["regime_other_snapshots", "regime_beside", "", "REGIME_BESIDE_SNAPSHOTS"]) {
      await expect(insertArtifact(run, bad, ROWS)).rejects.toThrow(/violates check constraint/);
    }
    expect(await insertArtifact(run, "regime_snapshots", ROWS)).toEqual(DATES);
    const research = JSON.stringify([{ key: "channel-divergence", date: "2026-11-20", payload: { title: "t" } }]);
    const researchKeys = await insertArtifact(run, "research_signals", research);
    expect(researchKeys!.length).toBe(1);
    expect(researchKeys![0]!.split("\u001f").slice(0, 2)).toEqual(["2026-11-20", "channel-divergence"]);
    for (const kind of ["warnings", "logs", "exceptions"]) expect(await insertArtifact(run, kind, "[]")).toBeNull();
    // A payload that is not an array has no keys, never an error, under the new kind too.
    const other = await newRun();
    expect(await insertArtifact(other, "regime_beside_snapshots", "{}")).toEqual([]);
  });

  test("a second run of the file changes nothing", async () => {
    const catalog = async () => ({
      check: await checkDefinition(),
      fn: (await fixtureDb<{ def: string }[]>`SELECT pg_get_functiondef('rm_analytics_output_natural_keys(text, bytea)'::regprocedure) AS def`)[0]!.def,
    });
    await asOwner(M0136);
    const once = await catalog();
    await asOwner(M0136);
    expect(await catalog()).toEqual(once);
    expect(once.fn).toContain("'regime_snapshots', 'regime_beside_snapshots', 'research_signals'");
  });
});
