// HERMETICITY GUARD (issue #87). Proves the projects pipeline is NETWORK-FREE on
// the per-PR path: (1) the data-source selector resolves to the offline fixture
// source under CI even if PROJECTS_SOURCE=live leaks into the env, and (2) the
// full pipeline runs to completion with global fetch REPLACED by a throwing stub
// — so any live socket a handler opened would fail this test loudly. Runs against
// the preload's ephemeral Postgres (RM_ENV=ephemeral), so it also fails red when
// Postgres is absent.
import { test, expect, afterAll } from "bun:test";
import { sql } from "../src/db/client.ts";
import { selectProjectsDataSource } from "../src/projects/access/select.ts";
import {
  discover,
  fetchVaults,
  recomputeCoverage,
  refreshCoins,
  refreshWallets,
  snapshotDaily,
  syncRevenue,
} from "../src/worker/handlers/projects.ts";
import { uniqueSlugSource } from "./support/projects-fixture-source.ts";

const realFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
});

test("selectProjectsDataSource is hermetic under CI even when PROJECTS_SOURCE=live leaks in", () => {
  // RM_ENV=ephemeral (preload) forces the fixture source regardless of the knob.
  const src = selectProjectsDataSource({ PROJECTS_SOURCE: "live" });
  expect(src.kind).toBe("fixture");
});

test("the full pipeline completes with global fetch disabled (no live socket)", async () => {
  globalThis.fetch = (() => {
    throw new Error("hermeticity violation: a projects test opened a live network connection");
  }) as unknown as typeof fetch;

  const prefix = `herm_${crypto.randomUUID().slice(0, 8)}`;
  const src = uniqueSlugSource(prefix);

  // None of these may touch the network with the fixture source.
  await discover({}, src);
  const ids = (await sql<{ id: string }[]>`SELECT id FROM projects WHERE slug LIKE ${prefix + "-%"}`).map((r) => r.id);
  await refreshCoins({}, src);
  await refreshWallets({}, src);
  await fetchVaults({}, src);
  await snapshotDaily({ project_ids: ids });
  await syncRevenue({}, src);
  const res = await recomputeCoverage({ project_ids: ids });
  expect(res.ok).toBe(true);
  expect(ids.length).toBe(4);
});
