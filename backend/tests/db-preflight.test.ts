// The database classification step: empty bootstraps, populated is adopted by
// an archive boot and refused to a simulation boot.
//
// Runs against the suite's ephemeral Postgres (see tests/preload.ts), which is
// migrated and therefore POPULATED — the adopt/refuse split is exercised for
// real. The empty case can't be produced on the shared database (dropping
// public would sabotage every other file), so its coverage is split: the
// wording via reportLines, the classification via the demo's own smoke boot
// against a fresh database, which is where it actually matters.
import { expect, test } from "bun:test";
import { classifyDatabase, parseInitializer, reportLines } from "../scripts/db-preflight.ts";

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
