// The database classification step: empty bootstraps, populated is adopted by
// an archive boot and refused to a simulation boot.
//
// Runs against the suite's ephemeral Postgres (see tests/preload.ts), which is
// migrated and therefore POPULATED — the adopt/refuse split is exercised for
// real. The EMPTY case cannot be produced on that shared database (dropping
// public would sabotage every other file), so it gets its OWN throwaway
// database on the same Postgres instance — no migrations applied, genuinely
// zero BASE TABLEs in public — mirroring the pattern swarm-claim.test.ts uses
// for the same reason (a schema state the shared suite database can't hold).
import { expect, test } from "bun:test";
import postgres from "postgres";
import { config } from "../src/config.ts";
import { classifyDatabase, parseInitializer, reportLines } from "../scripts/db-preflight.ts";

test("empty database → bootstrap, on a genuinely fresh (unmigrated) database", async () => {
  const base = new URL(config.databaseUrl);
  const dbName = `tmp_preflight_empty_${crypto.randomUUID().slice(0, 8)}`;
  const admin = postgres(base.toString(), { max: 1, onnotice: () => {} });
  await admin.unsafe(`CREATE DATABASE ${dbName}`);
  await admin.end();

  const tmpUrl = new URL(base.toString());
  tmpUrl.pathname = `/${dbName}`;
  const db = postgres(tmpUrl.toString(), { max: 1, onnotice: () => {} });
  try {
    const r = await classifyDatabase("archive", db);
    expect(r).toEqual({ mode: "bootstrap", tables: 0, census: [] });
    // Same result regardless of initializer — EMPTY bootstraps either way,
    // the adopt/refuse split only matters once tables exist.
    const r2 = await classifyDatabase("simulation", db);
    expect(r2).toEqual({ mode: "bootstrap", tables: 0, census: [] });
  } finally {
    await db.end();
    const cleanup = postgres(base.toString(), { max: 1, onnotice: () => {} });
    await cleanup.unsafe(`DROP DATABASE IF EXISTS ${dbName}`);
    await cleanup.end();
  }
});

test("populated + archive boot → adopt, with a census the operator can recognise", async () => {
  const r = await classifyDatabase("archive");
  expect(r.mode).toBe("adopt");
  expect(r.tables).toBeGreaterThan(0);
  expect(r.census.length).toBeGreaterThan(0);
});

test("populated + simulation boot → refuse: demo fixtures overwrite by design", async () => {
  const r = await classifyDatabase("simulation");
  expect(r.mode).toBe("refuse");
  expect(r.tables).toBeGreaterThan(0);
});

test("parseInitializer fails closed — only an explicit archive flag can adopt", () => {
  expect(parseInitializer(["--initializer=archive"])).toBe("archive");
  expect(parseInitializer(["--initializer=simulation"])).toBe("simulation");
  // Missing, misspelled, or malformed all land in the strict branch: adopting
  // a populated database must never be what a forgotten parameter gets you.
  expect(parseInitializer([])).toBe("simulation");
  expect(parseInitializer(["--initializer=Archive"])).toBe("simulation");
  expect(parseInitializer(["--initializer="])).toBe("simulation");
  expect(parseInitializer(["archive"])).toBe("simulation");
});

test("the three reports say what will happen, not just what was found", () => {
  const bootstrap = reportLines("db:5432/x", { mode: "bootstrap", tables: 0, census: [] }).join("\n");
  expect(bootstrap).toContain("empty");
  expect(bootstrap).toContain("migrate + seed + archive restore");

  const adopt = reportLines("db:5432/x", {
    mode: "adopt",
    tables: 55,
    census: [{ table: "raw_indicator_history", rows: 116427 }],
  }).join("\n");
  expect(adopt).toContain("adopting as existing production data");
  expect(adopt).toContain("idempotent and deduplicated");
  expect(adopt).toContain("never overwrites existing rows");
  expect(adopt).toContain("raw_indicator_history ~116427 rows");
  // The adopt report must NOT read as a refusal — an operator scanning the
  // boot log decides from this line whether their data is at risk.
  expect(adopt).not.toContain("REFUSING");

  const refuse = reportLines("db:5432/x", {
    mode: "refuse",
    tables: 55,
    census: [{ table: "raw_indicator_history", rows: 116427 }],
  }).join("\n");
  expect(refuse).toContain("REFUSING a simulation boot");
  expect(refuse).toContain("bun smoke");
  expect(refuse).toContain("Nothing has been written");
});
