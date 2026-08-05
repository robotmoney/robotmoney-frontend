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
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { liveProjectsDataSource } from "../src/projects/access/live-source.ts";
import type { DiscoveredProject } from "../src/projects/access/data-source.ts";
import {
  DEFAULT_ROSTER_SEED_PATH,
  DEFAULT_ROSTER_SEED_MANIFEST_PATH,
  MAX_PROJECT_COUNT_DROP_RATIO,
  buildManifest,
  loadV0Roster,
  loadV0RosterWithManifest,
  replaceRosterSeedAtomically,
  validateRoster,
  type RosterSeedManifest,
} from "../src/projects/seed/roster-seed.ts";
import {
  fetchAllRows,
  mapV0RosterRows,
  resolveV0SupabaseConfig,
} from "../src/projects/seed/roster-seed-generator.ts";
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

  // Row count: `> DISCOVERY_DATASET.length` on its own is a `> 4` assertion —
  // a regeneration that collapsed 1,037 projects to 5 would sail past it. The
  // real count assertions are manifest-derived and floor-checked in
  // "the committed roster's row counts match its manifest and clear the
  // regression floor" below; this one only establishes "not the fixture".
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

// ── (d) the seed's real as-of time survives the loader boundary (HIGH-1) ─────
//
// The artifact records when the roster was actually captured. If the loader
// hands callers only `DiscoveredProject[]`, the discovery handler has nothing
// to stamp on the rows it persists but `now()` — and a frozen dataset then
// reports itself as refreshed-within-36h on every nightly run, forever
// (leaderboard-projections.ts's sourceHealth reads exactly that column). These
// assertions fail if the manifest is ever dropped at the loader again.

test("loadV0RosterWithManifest returns the committed manifest alongside the rows, carrying the roster's real as-of time", async () => {
  const { projects, manifest } = await loadV0RosterWithManifest();
  expect(projects.length).toBeGreaterThan(0);
  expect(typeof manifest.generatedAt).toBe("string");
  const generatedAt = new Date(manifest.generatedAt);
  expect(Number.isNaN(generatedAt.getTime())).toBe(false);
  // It is a real historical capture time, not a value derived from "now" —
  // strictly in the past, and the artifact cannot refresh itself.
  expect(generatedAt.getTime()).toBeLessThan(Date.now());
});

test("liveProjectsDataSource.discoveredAsOf() reports the committed manifest's generatedAt, not wall-clock now", async () => {
  const { manifest } = await loadV0RosterWithManifest();
  const asOf = await liveProjectsDataSource.discoveredAsOf!();
  expect(asOf).toBe(manifest.generatedAt);
  // The seed is frozen until an operator regenerates it, so its as-of time must
  // never track the clock: anything within the last minute means a now() leaked
  // back in and the freshness this source reports is fabricated.
  expect(Date.now() - new Date(asOf!).getTime()).toBeGreaterThan(60_000);
});

// ── (e) counts are manifest-derived and floor-checked (MEDIUM-6) ────────────

// Floor for the COMMITTED artifact, well below the 1,037/909/61/793/4 it
// currently carries but far above anything a truncating regeneration would
// leave behind. Deliberately a hard number: a floor derived from the manifest
// under test could not detect the manifest shrinking with the data.
const COMMITTED_ROSTER_FLOOR = { projects: 900, agents: 800, coins: 50, wallets: 700, vaults: 4 };

test("the committed roster's row counts match its manifest and clear the regression floor", async () => {
  const { projects, manifest } = await loadV0RosterWithManifest();
  const actual = {
    projects: projects.length,
    agents: projects.reduce((n, p) => n + p.agents.length, 0),
    coins: projects.reduce((n, p) => n + p.coins.length, 0),
    wallets: projects.reduce((n, p) => n + p.wallets.length, 0),
    vaults: projects.reduce((n, p) => n + p.vaults.length, 0),
  };
  expect(actual).toEqual({
    projects: manifest.projectCount,
    agents: manifest.agentCount,
    coins: manifest.coinCount,
    wallets: manifest.walletCount,
    vaults: manifest.vaultCount,
  });
  for (const table of ["projects", "agents", "coins", "wallets", "vaults"] as const) {
    expect(actual[table]).toBeGreaterThanOrEqual(COMMITTED_ROSTER_FLOOR[table]);
  }
});

// ── (f) facet uniqueness on the DB's ACTUAL conflict keys (MEDIUM-4) ────────

function proj(slug: string, extra: Partial<DiscoveredProject> = {}): DiscoveredProject {
  return {
    slug,
    display_name: slug,
    description: null,
    website_url: null,
    twitter_handle: null,
    logo_url: null,
    is_sticky: false,
    agents: [],
    coins: [],
    wallets: [],
    vaults: [],
    ...extra,
  };
}

function manifestFor(projects: DiscoveredProject[]): RosterSeedManifest {
  return buildManifest(projects, { generatedAt: "2026-08-03T20:43:29.019Z" });
}

test("validateRoster rejects two wallets in one project sharing a LABEL (the DB's conflict key) even though their addresses differ", () => {
  // canonicalize() sorts wallets by ADDRESS, so these look distinct to every
  // self-derived check — but worker/handlers/projects.ts upserts
  // ON CONFLICT (project_id, label), so they collapse to one row and the
  // manifest's walletCount=2 then describes a database holding 1.
  const projects = [
    proj("collide", {
      wallets: [
        { label: "treasury", chain: "base", address: "0xaaa" },
        { label: "treasury", chain: "base", address: "0xbbb" },
      ],
    }),
  ];
  const manifest = manifestFor(projects);
  expect(manifest.walletCount).toBe(2);
  expect(() => validateRoster(projects, manifest)).toThrow(/wallet rows sharing label/);
});

test("validateRoster rejects two coins in one project sharing a NAME (the DB's conflict key) even though their tickers differ", () => {
  const projects = [
    proj("collide", {
      coins: [
        { name: "Lobster", ticker: "LOB", coingecko_id: null, contract_address: null, chain: null },
        { name: "Lobster", ticker: "LOB2", coingecko_id: null, contract_address: null, chain: null },
      ],
    }),
  ];
  expect(() => validateRoster(projects, manifestFor(projects))).toThrow(/coin rows sharing name/);
});

test("validateRoster rejects duplicate agent and vault names within a project", () => {
  const agentsDupe = [
    proj("a", { agents: [
      { name: "solver", protocol_standard: "erc8004" },
      { name: "solver", protocol_standard: "x402" },
    ] }),
  ];
  expect(() => validateRoster(agentsDupe, manifestFor(agentsDupe))).toThrow(/agent rows sharing name/);

  const vaultsDupe = [proj("v", { vaults: [{ name: "core" }, { name: "core" }] })];
  expect(() => validateRoster(vaultsDupe, manifestFor(vaultsDupe))).toThrow(/vault rows sharing name/);
});

test("validateRoster still accepts facets that differ only on the DB's conflict key (control: no false positive)", () => {
  const projects = [
    proj("ok", {
      wallets: [
        { label: "treasury", chain: "base", address: "0xaaa" },
        { label: "ops", chain: "base", address: "0xbbb" },
      ],
      coins: [
        { name: "Lobster", ticker: "LOB", coingecko_id: null, contract_address: null, chain: null },
        { name: "Crab", ticker: "CRB", coingecko_id: null, contract_address: null, chain: null },
      ],
    }),
  ];
  expect(() => validateRoster(projects, manifestFor(projects))).not.toThrow();
});

// ── (g) upstream reconciliation, persisted in the manifest (HIGH-2) ─────────

test("validateRoster reconciles included + skipped against the SERVER-declared upstream totals", () => {
  const projects = [proj("one"), proj("two")];
  const base = buildManifest(projects, {
    generatedAt: "2026-08-03T20:43:29.019Z",
    upstreamTotals: { projects: 5, agents: 0, coins: 0, wallets: 0, vaults: 0 },
    skipped: { projects: 3, agents: 0, coins: 0, wallets: 0, vaults: 0 },
  });
  // 2 included + 3 skipped === 5 upstream — accounted for.
  expect(() => validateRoster(projects, base)).not.toThrow();

  // Same artifact, but the server said 9 rows exist: 2 + 3 !== 9, so seven rows
  // vanished between the fetch and the file. Nothing derived from the artifact
  // itself can see this — every self-derived count still agrees.
  const underExtracted = { ...base, upstreamTotals: { ...base.upstreamTotals!, projects: 9 } };
  expect(() => validateRoster(projects, underExtracted)).toThrow(/do not reconcile against upstream/);
});

test("validateRoster refuses a manifest carrying upstreamTotals without the matching skipped tallies", () => {
  const projects = [proj("one")];
  const half = {
    ...buildManifest(projects, { generatedAt: "2026-08-03T20:43:29.019Z" }),
    upstreamTotals: { projects: 1, agents: 0, coins: 0, wallets: 0, vaults: 0 },
  };
  expect(() => validateRoster(projects, half)).toThrow(/only one of upstreamTotals\/skipped/);
});

// ── (h) fetchAllRows: count=exact completeness + keyset pagination ──────────
//
// HIGH-2 / MEDIUM-3. These drive the real fetchAllRows against a stubbed
// transport — no live socket, and no v0 credentials (the config object is
// literal), so this executes in ordinary CI rather than being nightly-gated.

interface StubPage {
  rows: Array<{ id: string }>;
  total: number | null; // null = server answered without a Content-Range total
}

function stubTransport(pages: StubPage[]): { urls: string[]; preferHeaders: (string | undefined)[] } {
  const urls: string[] = [];
  const preferHeaders: (string | undefined)[] = [];
  let i = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    urls.push(String(input));
    preferHeaders.push((init?.headers as Record<string, string> | undefined)?.Prefer);
    const page = pages[Math.min(i, pages.length - 1)]!;
    i++;
    const headers = new Headers({ "content-type": "application/json" });
    if (page.total !== null) {
      headers.set("content-range", page.rows.length ? `0-${page.rows.length - 1}/${page.total}` : `*/${page.total}`);
    }
    return new Response(JSON.stringify(page.rows), { status: 200, headers });
  }) as unknown as typeof fetch;
  return { urls, preferHeaders };
}

const STUB_CFG = { url: "https://example.invalid", anonKey: "test-key" };

test("fetchAllRows asks for count=exact and returns the server-declared upstream total", async () => {
  const { preferHeaders } = stubTransport([{ rows: [{ id: "a" }, { id: "b" }], total: 2 }]);
  try {
    const { rows, upstreamTotal } = await fetchAllRows<{ id: string }>(STUB_CFG, "projects", "id");
    expect(rows.length).toBe(2);
    expect(upstreamTotal).toBe(2);
    expect(preferHeaders[0]).toBe("count=exact");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("fetchAllRows REFUSES an under-extraction the artifact could never reveal: 2 rows returned, 3 declared upstream", async () => {
  stubTransport([{ rows: [{ id: "a" }, { id: "b" }], total: 3 }]);
  try {
    await expect(fetchAllRows<{ id: string }>(STUB_CFG, "openclaw_agents", "id")).rejects.toThrow(
      /fetched 2 row\(s\) but the server declared 3/,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("fetchAllRows refuses to extract at all when the server declares no Content-Range total", async () => {
  stubTransport([{ rows: [{ id: "a" }], total: null }]);
  try {
    await expect(fetchAllRows<{ id: string }>(STUB_CFG, "lobster_coins", "id")).rejects.toThrow(
      /no row total in the Content-Range/,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("fetchAllRows pages by KEYSET cursor (id=gt.<lastId>), never by offset", async () => {
  // A full first page forces a second request. Offset paging over a live,
  // concurrently-written table silently skips/duplicates rows when an insert
  // lands at an earlier random UUID; a cursor anchored to a row we actually saw
  // cannot.
  const firstPage = Array.from({ length: 1000 }, (_, n) => ({ id: `id-${String(n).padStart(4, "0")}` }));
  const { urls } = stubTransport([
    { rows: firstPage, total: 1002 },
    { rows: [{ id: "id-1000" }, { id: "id-1001" }], total: 2 },
  ]);
  try {
    const { rows, upstreamTotal } = await fetchAllRows<{ id: string }>(STUB_CFG, "tracked_wallets", "id");
    expect(rows.length).toBe(1002);
    // The total asserted against is the FIRST page's — the only request with no
    // cursor filter, so the only one whose count covers the whole set.
    expect(upstreamTotal).toBe(1002);
    expect(urls.length).toBe(2);
    for (const u of urls) expect(u).not.toContain("offset=");
    expect(urls[0]).not.toContain("id=gt.");
    expect(urls[1]).toContain("id=gt.id-0999");
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ── (i) the regeneration regression floor (HIGH-2) ──────────────────────────

test("replaceRosterSeedAtomically refuses a regeneration that drops projects below the previous manifest's floor", () => {
  const dir = mkdtempSync(join(tmpdir(), "rm-roster-floor-"));
  const dataPath = join(dir, "v0-roster-data.json");
  const manifestPath = join(dir, "v0-roster-data.manifest.json");
  try {
    const full = Array.from({ length: 100 }, (_, n) => proj(`p-${String(n).padStart(3, "0")}`));
    replaceRosterSeedAtomically(dataPath, manifestPath, full, manifestFor(full));
    expect(JSON.parse(readFileSync(manifestPath, "utf8")).projectCount).toBe(100);

    // A 50% collapse — internally consistent, checksum-valid, and a lie about
    // the roster. The only reference not derived from the new pull is the
    // artifact already on disk.
    const collapsed = full.slice(0, 50);
    expect(() => replaceRosterSeedAtomically(dataPath, manifestPath, collapsed, manifestFor(collapsed))).toThrow(
      /regression floor/,
    );
    // Committed pair untouched by the refusal.
    expect(JSON.parse(readFileSync(manifestPath, "utf8")).projectCount).toBe(100);

    // A drop inside the tolerance still writes (control: not a blanket freeze).
    const slightlySmaller = full.slice(0, 100 - Math.floor(100 * MAX_PROJECT_COUNT_DROP_RATIO));
    replaceRosterSeedAtomically(dataPath, manifestPath, slightlySmaller, manifestFor(slightlySmaller));
    expect(JSON.parse(readFileSync(manifestPath, "utf8")).projectCount).toBe(slightlySmaller.length);

    // …and the operator can still acknowledge a genuine shrink explicitly.
    replaceRosterSeedAtomically(dataPath, manifestPath, collapsed, manifestFor(collapsed), { allowShrink: true });
    expect(JSON.parse(readFileSync(manifestPath, "utf8")).projectCount).toBe(50);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("replaceRosterSeedAtomically writes a first-ever pair with no previous manifest to regress against", () => {
  const dir = mkdtempSync(join(tmpdir(), "rm-roster-first-"));
  const dataPath = join(dir, "v0-roster-data.json");
  const manifestPath = join(dir, "v0-roster-data.manifest.json");
  try {
    const projects = [proj("only-one")];
    expect(existsSync(manifestPath)).toBe(false);
    replaceRosterSeedAtomically(dataPath, manifestPath, projects, manifestFor(projects));
    expect(existsSync(dataPath)).toBe(true);
    expect(JSON.parse(readFileSync(manifestPath, "utf8")).projectCount).toBe(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── (j) the regenerate CLI fails loudly without credentials (AC7) ───────────

test("resolveV0SupabaseConfig throws for each missing credential rather than fabricating a source", () => {
  expect(() => resolveV0SupabaseConfig({})).toThrow(/V0_ANALYTICS_SOURCE_URL/);
  expect(() => resolveV0SupabaseConfig({ V0_ANALYTICS_SOURCE_URL: "https://example.invalid" })).toThrow(
    /V0_ANALYTICS_SOURCE_KEY/,
  );
  expect(() => resolveV0SupabaseConfig({ V0_ANALYTICS_SOURCE_URL: "  ", V0_ANALYTICS_SOURCE_KEY: "k" })).toThrow(
    /V0_ANALYTICS_SOURCE_URL/,
  );
  expect(
    resolveV0SupabaseConfig({ V0_ANALYTICS_SOURCE_URL: "https://example.invalid/", V0_ANALYTICS_SOURCE_KEY: "k" }),
  ).toEqual({ url: "https://example.invalid", anonKey: "k" });
});
