// Coverage for the R11 v0-roster seed (issue #495 — the follow-up left open by
// #477/R11's "structural finding": liveProjectsDataSource.discoverProjects()
// used to fall back to the same 4-row DISCOVERY_DATASET fixture CI uses, so the
// "live" discovery path and the hermetic test path served identical made-up
// projects. This file is the FIRST test that actually executes the new code
// path: discoverProjects() serving the real committed roster instead of the
// fixture, the checksum guard failing loud on a tampered artifact, and the
// source_confidence mapper dropping — never defaulting — an unrecognized v0
// value. Network-free throughout (loadV0Roster is pure file I/O), and this
// test explicitly proves that by disabling global fetch, mirroring
// projects-hermeticity.test.ts's guard.
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { liveProjectsDataSource } from "../src/projects/access/live-source.ts";
import {
  DEFAULT_ROSTER_SEED_PATH,
  DEFAULT_ROSTER_SEED_MANIFEST_PATH,
  loadV0Roster,
} from "../src/projects/seed/roster-seed.ts";
import { mapV0RosterRows } from "../src/projects/seed/roster-seed-generator.ts";
import { DISCOVERY_DATASET } from "../src/projects/fixtures/dataset.ts";

// ── (a) discoverProjects() serves the seeded roster, not the 4-row fixture ──

const realFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
});

test("the fixture is really 4 rows (sanity-checks the '> 4' assertion below isn't vacuous)", () => {
  expect(DISCOVERY_DATASET.length).toBe(4);
});

test("liveProjectsDataSource.discoverProjects() serves the real v0-derived roster, not DISCOVERY_DATASET, with no network access", async () => {
  // Prove this is genuinely network-free: any live socket a regression opened
  // here would throw immediately and fail this test loudly, same guard as
  // projects-hermeticity.test.ts.
  globalThis.fetch = (() => {
    throw new Error("hermeticity violation: discoverProjects() opened a live network connection");
  }) as unknown as typeof fetch;

  let projects: Awaited<ReturnType<typeof liveProjectsDataSource.discoverProjects>>;
  try {
    projects = await liveProjectsDataSource.discoverProjects();
  } finally {
    globalThis.fetch = realFetch;
  }

  // Row count: the fixture has 4 rows; the real seed has 1,037 committed
  // projects (per v0-roster-data.manifest.json). Assert strictly greater than
  // the fixture's actual length, not a hardcoded number, so this stays correct
  // if either dataset is regenerated.
  expect(projects.length).toBeGreaterThan(DISCOVERY_DATASET.length);

  // Slugs: none of the fixture's hardcoded synthetic slugs exist in the real
  // roster, and the real roster's slug set is not a subset of (nor equal to)
  // the fixture's — proving this is genuinely different data, not the fixture
  // re-served under a different code path.
  const realSlugs = new Set(projects.map((p) => p.slug));
  const fixtureSlugs = new Set(DISCOVERY_DATASET.map((p) => p.slug));
  for (const fixtureSlug of fixtureSlugs) {
    expect(realSlugs.has(fixtureSlug)).toBe(false);
  }
  expect(realSlugs.has("virtuals-protocol")).toBe(false); // fixture's flagship slug, verified absent from the real roster
  const overlap = [...realSlugs].filter((s) => fixtureSlugs.has(s));
  expect(overlap.length).toBe(0);
});

// ── (b) a tampered manifest checksum fails loud, never loads silently ───────

// Copies the REAL committed seed pair into a fresh temp dir so corruption
// tests never touch the committed backend/src/projects/seed/v0-roster-data*
// files in place — mirrors edgar-seed-integrity.test.ts's writeSeed() helper.
function copyRealSeedToTempDir(): { dataPath: string; manifestPath: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "rm-roster-seed-"));
  const dataPath = join(dir, "v0-roster-data.json");
  const manifestPath = join(dir, "v0-roster-data.manifest.json");
  writeFileSync(dataPath, readFileSync(DEFAULT_ROSTER_SEED_PATH, "utf8"), "utf8");
  writeFileSync(manifestPath, readFileSync(DEFAULT_ROSTER_SEED_MANIFEST_PATH, "utf8"), "utf8");
  return { dataPath, manifestPath, dir };
}

test("the real committed seed pair loads cleanly via the temp-copy helper (control case for the corruption tests below)", async () => {
  const { dataPath, manifestPath, dir } = copyRealSeedToTempDir();
  try {
    const projects = await loadV0Roster(dataPath, manifestPath);
    expect(projects.length).toBeGreaterThan(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("corruption: a tampered v0-roster-data.json (content changed, manifest untouched) fails the checksum loudly instead of loading", async () => {
  const { dataPath, manifestPath, dir } = copyRealSeedToTempDir();
  try {
    const projects = JSON.parse(readFileSync(dataPath, "utf8")) as Array<{ display_name: string }>;
    expect(projects.length).toBeGreaterThan(0);
    projects[0]!.display_name = `${projects[0]!.display_name} (TAMPERED)`;
    writeFileSync(dataPath, JSON.stringify(projects, null, 2), "utf8");

    await expect(loadV0Roster(dataPath, manifestPath)).rejects.toThrow(/checksum mismatch/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("corruption: a tampered manifest checksum field (data untouched) fails loudly instead of loading", async () => {
  const { dataPath, manifestPath, dir } = copyRealSeedToTempDir();
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { checksum: string };
    manifest.checksum = "0".repeat(64);
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

    await expect(loadV0Roster(dataPath, manifestPath)).rejects.toThrow(/checksum mismatch/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── (c) the source_confidence mapper drops unrecognized values ──────────────
//
// mapSourceConfidence() itself is a private helper inside roster-seed-generator.ts;
// mapV0RosterRows() is its exported, pure, directly-testable surface (per the
// file's own comment: "kept separate from generateV0RosterArtifact so the
// mapping/skip logic is directly testable against a fixed raw-row fixture"), so
// this drives the mapping through that surface rather than exporting a new one.

function rawProject(id: string, slug: string) {
  return { id, slug, display_name: slug, status: "active", description: null, twitter_handle: null, website_url: null };
}
function rawAgent(id: string, projectId: string, name: string, sourceConfidence: string | null) {
  return {
    id,
    project_id: projectId,
    name,
    protocol_standard: "erc8004",
    wallet_address: null,
    virtuals_agent_id: null,
    x402_score: null,
    x402_txn_count: null,
    x402_resources_count: null,
    x402_volume_usd: null,
    productivity_score: null,
    source_confidence: sourceConfidence,
  };
}

test("mapV0RosterRows maps recognized v0 source_confidence values by evidentiary strength (proof->high, directory->medium, social->low)", () => {
  const { projects } = mapV0RosterRows({
    projects: [rawProject("p1", "test-project")],
    agents: [
      rawAgent("a1", "p1", "wallet-proof-agent", "wallet_proof"),
      rawAgent("a2", "p1", "payment-proof-agent", "payment_proof"),
      rawAgent("a3", "p1", "directory-agent", "directory"),
      rawAgent("a4", "p1", "social-agent", "social"),
    ],
    coins: [],
    wallets: [],
    vaults: [],
  });

  const bySlugAgentName = new Map(projects[0]!.agents.map((a) => [a.name, a.source_confidence]));
  expect(bySlugAgentName.get("wallet-proof-agent")).toBe("high");
  expect(bySlugAgentName.get("payment-proof-agent")).toBe("high");
  expect(bySlugAgentName.get("directory-agent")).toBe("medium");
  expect(bySlugAgentName.get("social-agent")).toBe("low");
});

test("mapV0RosterRows drops an unrecognized v0 source_confidence value (null) rather than defaulting it to high/medium/low", () => {
  const { projects, stats } = mapV0RosterRows({
    projects: [rawProject("p1", "test-project")],
    agents: [
      rawAgent("a1", "p1", "garbage-value-agent", "totally_unrecognized_value"),
      rawAgent("a2", "p1", "null-value-agent", null),
    ],
    coins: [],
    wallets: [],
    vaults: [],
  });

  const bySlugAgentName = new Map(projects[0]!.agents.map((a) => [a.name, a.source_confidence]));
  // Dropped, not defaulted: neither the unrecognized string nor the null input
  // is coerced into "high" | "medium" | "low" — both come back null.
  expect(bySlugAgentName.get("garbage-value-agent")).toBe(null);
  expect(bySlugAgentName.get("null-value-agent")).toBe(null);
  expect(["high", "medium", "low"]).not.toContain(bySlugAgentName.get("garbage-value-agent"));

  // Both agents are still INCLUDED (only the source_confidence field is
  // dropped, not the whole row) — a real skip would show up in stats instead.
  expect(projects[0]!.agents.length).toBe(2);
  expect(stats.agentsIncluded).toBe(2);
  expect(stats.agentsSkipped).toBe(0);
  // The unrecognized value is recorded in the human-readable notes log.
  expect(stats.notes.some((n) => n.includes("totally_unrecognized_value"))).toBe(true);
});
