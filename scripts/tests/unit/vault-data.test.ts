// The four-vault data layer: lib/vault-data.js (identity, the drift maths,
// formatters) and lib/vault-source.js (the mock-data switch and every read).
//
// The REAL modules run, against the SHIPPED fixtures and archive files: a
// mocked global fetch serves frontend/public as the static server would, and
// answers /api/* per test. So "the devnet overview gives 700 bps of tracking
// error" and "a production host never reads /data/vaults" are assertions
// about the files and code a browser gets, not about a double.
//
// Each fixture is a complete sample of the documented robotmoney-vaults DTO,
// server-computed fields included, so normalizeOverview() recomputing exactly
// what the fixture states is the check that the frontend and the contract
// agree on the arithmetic.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CATEGORICAL } from "../../../frontend/public/assets/js/app/lib/chart-theme.js";
import { BUCKET_ORDER, bookSleeveShares, bucketHue, sessionSummary } from "../../../frontend/public/assets/js/app/lib/session-summary.js";
import {
  VAULTS,
  VAULT_SLUGS,
  VAULTS_ENDPOINT,
  SLEEVE_NOTE,
  bps,
  bpsFromWeights,
  canDeposit,
  explorerLink,
  fmtBps,
  fmtDate,
  fmtUsd,
  freshnessLabel,
  gapParts,
  hasTargetLayer,
  hasAppliedLayer,
  historyModel,
  holdingsComplete,
  isLocalHost,
  layerComplete,
  legacyRaw,
  normalizeOverview,
  positionName,
  receiptApplied,
  recommendationDate,
  recommendationHref,
  sleeveNote,
  statusLabel,
  vaultBySlug,
  vaultForBucket,
  withRecommendation,
} from "../../../frontend/public/assets/js/app/lib/vault-data.js";
import {
  _resetVaultProbe,
  applyReviewState,
  archiveSession,
  latestPublishedRecommendation,
  loadLatestRecommendation,
  loadVaultDetail,
  loadVaultOverview,
  loadVaultSubjectFixture,
  recommendationFromSession,
  resolveVaultMode,
} from "../../../frontend/public/assets/js/app/lib/vault-source.js";
import { loadAllocationDto } from "../../../frontend/public/assets/js/app/lib/allocation-framework.js";

const repoRoot = join(import.meta.dir, "../../..");
const publicDir = join(repoRoot, "frontend/public");
const readJson = (rel: string): any => JSON.parse(readFileSync(join(publicDir, rel), "utf8"));
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

const goldens = JSON.parse(readFileSync(join(repoRoot, "goldens/api-goldens.json"), "utf8"));
const GOLDEN_ECONOMICS = goldens.routes["/api/dashboards/vault-economics"];
const GOLDEN_ALLOCATION = goldens.routes["/api/dashboards/allocation"];
const DEVNET = readJson("data/vaults/devnet/overview.json");
const ALLOCATION_2026_06_24 = { conservative_defi_yield: 9500, agent_tokens: 300, protocol_tokens: 0, real_world_assets: 200 };
const ALLOCATION_2026_06_24_FRACTIONS = { conservative_defi_yield: 0.95, agent_tokens: 0.03, protocol_tokens: 0, real_world_assets: 0.02 };
const PROD_HOSTS = ["robotmoney.network", "robotmoney.network.", "site.robotmoney.net", "app.robotmoney.network", "vaults.example.org"];

// api.js reads the API origin from window.RM_CONFIG at call time. "" is same
// origin, so every API request reaches the mock as a root-relative path.
const realWindow = (globalThis as { window?: unknown }).window;
(globalThis as { window?: unknown }).window = { RM_CONFIG: { API_BASE_URL: "" } };
const realFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
  (globalThis as { window?: unknown }).window = realWindow;
});

let requests: string[] = [];
type Answer = () => Response;
const json = (body: unknown, status = 200): Answer => () =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const statusOnly = (status: number): Answer => json({ error: "unavailable" }, status);
const spaShell: Answer = () =>
  new Response("<!doctype html><html><head><title>Robot Money</title></head></html>", {
    status: 200,
    headers: { "Content-Type": "text/html" },
  });

// /api/* by exact path (query ignored), 503 for anything unlisted. Everything
// else is a static file under frontend/public, as the preview server serves it.
function serve(apiRoutes: Record<string, Answer> = {}, statics: Record<string, Answer> = {}) {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    requests.push(url);
    const path = url.split("?")[0];
    if (path.startsWith("/api/")) return (apiRoutes[path] ?? statusOnly(503))();
    if (statics[path]) return statics[path]();
    const file = join(publicDir, `.${path}`);
    if (existsSync(file)) {
      return new Response(readFileSync(file, "utf8"), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

class MemStorage {
  map = new Map<string, string>();
  writes = 0;
  getItem(k: string) { return this.map.get(k) ?? null; }
  setItem(k: string, v: string) { this.writes += 1; this.map.set(k, v); }
}

const bySlug = (o: any, slug: string) => o.vaults.find((v: any) => v.slug === slug);
const layer = (o: any, field: string) => o.vaults.map((v: any) => v[field]);

beforeEach(() => {
  _resetVaultProbe();
  requests = [];
});

describe("vault identity", () => {
  test("four vaults in the framework's order, one categorical hue each", () => {
    expect(VAULTS.map((v) => v.bucket)).toEqual(BUCKET_ORDER);
    expect(VAULT_SLUGS).toEqual(["rmusdc", "rmagent", "rmproto", "rmrwa"]);
    VAULTS.forEach((v, i) => {
      expect(v.color).toBe(CATEGORICAL[i]);
      expect(bucketHue(v.bucket)).toBe(v.color);
    });
    expect(VAULTS_ENDPOINT).toBe("/api/dashboards/robotmoney-vaults");
  });

  test("routes.js spells out exactly the four slugs as the /vault/:slug route", () => {
    const routesSrc = readFileSync(join(publicDir, "assets/js/app/routes.js"), "utf8");
    const m = routesSrc.match(/\/\^\\\/vault\\\/\(([a-z|]+)\)\\\/\?\$\//);
    expect(m).not.toBeNull();
    expect(m![1].split("|")).toEqual(VAULT_SLUGS);
  });

  test("the rmUSDC Base address is the one skill.md publishes; no other vault has one", () => {
    const skill = readFileSync(join(publicDir, "skill.md"), "utf8");
    expect(skill).toContain(`\`${VAULTS[0].baseAddress}\``);
    expect(VAULTS.slice(1).every((v) => v.baseAddress === null)).toBe(true);
  });

  test("a sleeve resolves by bucket id, DTO key or published name; a slug by vaultBySlug only", () => {
    for (const v of VAULTS) {
      expect(vaultForBucket(v.bucket)?.slug).toBe(v.slug);
      expect(vaultForBucket(v.key)?.slug).toBe(v.slug);
      expect(vaultForBucket(v.name)?.slug).toBe(v.slug);
      expect(vaultBySlug(v.slug)?.symbol).toBe(v.symbol);
      expect(vaultBySlug(v.slug.toUpperCase())?.slug).toBe(v.slug);
    }
    expect(vaultForBucket("rmusdc")).toBeNull();
    expect(vaultForBucket("")).toBeNull();
    expect(vaultBySlug("nope")).toBeNull();
  });

  test("the sleeve note is one source, with no network in the yield line", () => {
    expect(sleeveNote("conservative_defi_yield")).toBe("Lending USDC. The lowest-volatility sleeve, aimed at capital preservation.");
    expect(sleeveNote("rwa")).toBe(SLEEVE_NOTE.rwa);
    expect(sleeveNote("Agent Tokens")).toBe(SLEEVE_NOTE["agent-tokens"]);
    expect(sleeveNote("nope")).toBe("");
    expect(Object.values(SLEEVE_NOTE).some((s) => /on Base/.test(s))).toBe(false);
  });
});

describe("normalizeOverview: the drift maths", () => {
  test("the devnet overview gives the documented figures", () => {
    const o = normalizeOverview(DEVNET);
    expect(o.combined).toEqual({ tvlUsd: 100000, vaultsLive: 4 });
    // Against the target in force, the router's Applied: half of |flow|.
    expect(o.trackingErrorBps).toBe(200);
    expect(o.targetSource).toBe("router");
    expect(layer(o, "targetBps")).toEqual(layer(o, "appliedBps"));
    expect(layer(o, "actualBps")).toEqual([7200, 900, 1400, 500]);
    expect(bySlug(o, "rmusdc").gaps).toEqual({ governance: 500, flow: 200, total: 700 });
    expect(bySlug(o, "rmagent").gaps).toEqual({ governance: -500, flow: -100, total: -600 });
    expect(bySlug(o, "rmproto").gaps).toEqual({ governance: 0, flow: -100, total: -100 });
    expect(bySlug(o, "rmrwa").gaps).toEqual({ governance: 0, flow: 0, total: 0 });
    expect(o.router).toEqual({ address: null, availability: "live", appliedAt: "2026-09-01T10:00:00Z" });
  });

  test("it recomputes exactly what the fixture states, and ignores the server's own figures", () => {
    const o = normalizeOverview(DEVNET);
    expect(o.combined).toEqual(DEVNET.combined);
    expect(o.trackingErrorBps).toBe(DEVNET.trackingErrorBps);
    for (const raw of DEVNET.vaults) {
      const row = bySlug(o, raw.slug);
      expect(row.actualBps).toBe(raw.actualBps);
      expect(row.gaps).toEqual(raw.gaps);
      expect(row.recommendedBps).toBe(raw.recommendedBps);
      expect(row.appliedBps).toBe(raw.appliedBps);
    }
    const tampered = clone(DEVNET);
    tampered.combined = { tvlUsd: 1, vaultsLive: 9 };
    tampered.trackingErrorBps = 1;
    tampered.vaults[0].actualBps = 1;
    tampered.vaults[0].gaps = { governance: 1, flow: 1, total: 1 };
    expect(normalizeOverview(tampered)).toEqual(o);
  });

  test("idempotent on its own output", () => {
    const o = normalizeOverview(DEVNET);
    expect(normalizeOverview(o)).toEqual(o);
    const legacy = normalizeOverview(withRecommendation(legacyRaw(GOLDEN_ECONOMICS), null));
    expect(normalizeOverview(legacy)).toEqual(legacy);
  });

  test("identity and colour follow the slug, not the feed's order", () => {
    const reversed = clone(DEVNET);
    reversed.vaults.reverse();
    const o = normalizeOverview(reversed);
    expect(o.vaults.map((v) => v.slug)).toEqual(VAULT_SLUGS);
    expect(o.vaults.map((v) => v.color)).toEqual(VAULTS.map((v) => v.color));
    expect(layer(o, "actualBps")).toEqual([7200, 900, 1400, 500]);
  });

  test("an unreadable vault makes every actual, the combined TVL and tracking error null; Recommended stays", () => {
    const o = normalizeOverview(applyReviewState(DEVNET, "unreadable"));
    expect(bySlug(o, "rmproto").availability).toBe("unavailable");
    expect(o.vaults.every((v) => v.actualBps === null && v.gaps.total === null && v.gaps.flow === null)).toBe(true);
    expect(o.combined.tvlUsd).toBeNull();
    expect(o.combined.vaultsLive).toBeNull();
    expect(o.trackingErrorBps).toBeNull();
    expect(bySlug(o, "rmusdc").recommendedBps).toBe(6500);
    expect(bySlug(o, "rmusdc").gaps.governance).toBe(500);
  });

  test("no recommendation: Recommended is null, not zero; flow and tracking error still read", () => {
    const o = normalizeOverview(applyReviewState(DEVNET, "no-recommendation"));
    expect(o.recommendation).toBeNull();
    expect(o.vaults.every((v) => v.recommendedBps === null && v.gaps.governance === null)).toBe(true);
    expect(o.trackingErrorBps).toBe(200);
    expect(bySlug(o, "rmrwa").gaps.flow).toBe(0);
    expect(gapParts(bySlug(o, "rmrwa").gaps.flow).label).toBe("0 pp");
  });

  test("a recommendation object with no weights on the rows is null, not 0", () => {
    const raw = clone(DEVNET);
    for (const v of raw.vaults) delete v.recommendedBps;
    expect(layer(normalizeOverview(raw), "recommendedBps")).toEqual([null, null, null, null]);
  });

  test("all-zero TVL is no allocation at all: actual is null; the zero total is a real zero", () => {
    const raw = clone(DEVNET);
    for (const v of raw.vaults) v.tvlUsd = 0;
    const o = normalizeOverview(raw);
    expect(o.vaults.every((v) => v.actualBps === null)).toBe(true);
    expect(o.combined.tvlUsd).toBe(0);
  });

  test("a missing or duplicated vault record cannot change the denominator", () => {
    const missing = clone(DEVNET);
    missing.vaults.pop();
    expect(normalizeOverview(missing).combined.tvlUsd).toBeNull();
    expect(bySlug(normalizeOverview(missing), "rmrwa").availability).toBe("unavailable");
    const duplicated = clone(DEVNET);
    duplicated.vaults.push(clone(duplicated.vaults[0]));
    expect(normalizeOverview(duplicated).combined.tvlUsd).toBeNull();
    expect(normalizeOverview(null).vaults.map((v) => v.availability)).toEqual(["unavailable", "unavailable", "unavailable", "unavailable"]);
  });
});

describe("layers", () => {
  test("bpsFromWeights: largest remainder, so weights summing to 1 give exactly 10000", () => {
    const thirds = bpsFromWeights([1 / 3, 1 / 3, 1 / 3, 0]);
    expect(thirds.reduce((s: number, v) => s + (v ?? 0), 0)).toBe(10000);
    expect(thirds).toEqual([3334, 3333, 3333, 0]);
    expect(bpsFromWeights([0.95, 0.03, 0, 0.02])).toEqual([9500, 300, 0, 200]);
    expect(bpsFromWeights([0.1429, 0.1429, 0.1429, 0.1429, 0.1429, 0.1428, 0.1427]).reduce((s: number, v) => s + (v ?? 0), 0)).toBe(10000);
    expect(bpsFromWeights([0.5, null, "x", -0.1])).toEqual([5000, null, null, null]);
  });

  test("layerComplete: four known weights within a basis point of 10000", () => {
    expect(layerComplete([6500, 1500, 1500, 500])).toBe(true);
    expect(layerComplete([6500, 1500, 1500, 501])).toBe(true);
    expect(layerComplete([6500, 1500, 1500, 502])).toBe(false);
    expect(layerComplete([6500, 1500, 2000, null])).toBe(false);
    expect(layerComplete([7000, 1000, 2000])).toBe(false);
  });

  test("a 3-bucket recommendation is no recommended layer at all, never rescaled", () => {
    const rec = recommendationFromSession({
      id: "11111111-2222-3333-4444-555555555555",
      subjectId: "robotmoney-allocation",
      state: "published",
      swarmRecommendation: { type: "bucket_weights", weights: { conservative_defi_yield: 0.9, agent_tokens: 0.05, protocol_tokens: 0.05 } },
    });
    expect(rec?.bpsByBucket.real_world_assets).toBeNull();
    const o = normalizeOverview(withRecommendation(legacyRaw(GOLDEN_ECONOMICS), rec));
    expect(layer(o, "recommendedBps")).toEqual([null, null, null, null]);
    expect(o.trackingErrorBps).toBeNull();
  });

  test("an applied layer summing to 9000 is null everywhere, and so are governance and flow", () => {
    const raw = clone(DEVNET);
    raw.vaults[0].appliedBps = 6000;
    const o = normalizeOverview(raw);
    expect(layer(o, "appliedBps")).toEqual([null, null, null, null]);
    expect(o.vaults.every((v) => v.gaps.governance === null && v.gaps.flow === null)).toBe(true);
    expect(o.trackingErrorBps).toBe(700);
  });

  test("bps rejects what is not a weight; zero is a weight", () => {
    expect(bps(0)).toBe(0);
    expect(bps(null)).toBeNull();
    expect(bps("")).toBeNull();
    expect(bps(-1)).toBeNull();
    expect(bps(10001)).toBeNull();
    expect(bps(true)).toBeNull();
  });
});

describe("formatters", () => {
  test("null prints the missing mark; a real zero prints as zero", () => {
    expect(fmtBps(null)).toBe("—");
    expect(fmtBps(0)).toBe("0%");
    expect(fmtBps(6500)).toBe("65%");
    expect(fmtBps(1428.57)).toBe("14.3%");
    expect(fmtUsd(null)).toBe("—");
    expect(fmtUsd(0)).toBe("$0");
    expect(fmtUsd(199.697519)).toBe("$200");
    expect(fmtUsd(100000)).toBe("$100,000");
  });

  test("gaps: weight-change's label and class, in points, no arrow", () => {
    expect(gapParts(null)).toEqual({ cls: "", label: "—" });
    expect(gapParts(0)).toEqual({ cls: "flat", label: "0 pp" });
    expect(gapParts(0.3)).toEqual({ cls: "flat", label: "0 pp" });
    expect(gapParts(500)).toEqual({ cls: "up", label: "+5 pp" });
    expect(gapParts(-300)).toEqual({ cls: "down", label: "−3 pp" });
  });

  test("dates carry a month name", () => {
    expect(fmtDate("2026-09-16T10:00:00Z")).toBe("Sep 16, 2026");
    expect(fmtDate("2026-06-24")).toBe("Jun 24, 2026");
    expect(fmtDate(null)).toBe("—");
    expect(fmtDate("not a date")).toBe("—");
    const o = normalizeOverview(DEVNET);
    expect(freshnessLabel(o)).toBe("Sep 17, 2026 10:00 UTC");
    expect(freshnessLabel(normalizeOverview(applyReviewState(DEVNET, "stale")))).toBe("Sep 17, 2026 10:00 UTC · stale");
    expect(freshnessLabel(null)).toBe("—");
  });

  test("a recommendation reads by its publish time and links only to a real record", () => {
    expect(recommendationDate({ publishedAt: "2026-09-16T10:00:00Z", date: "2026-09-15" })).toBe("2026-09-16T10:00:00Z");
    expect(recommendationDate({ publishedAt: null, date: "2026-06-24" })).toBe("2026-06-24");
    expect(recommendationDate(null)).toBeNull();
    expect(recommendationHref({ href: "/swarm/2026-06-24/robotmoney-allocation" })).toBe("/swarm/2026-06-24/robotmoney-allocation");
    expect(recommendationHref({ sessionId: "11111111-2222-3333-4444-555555555555" })).toBe("/swarm/sessions/11111111-2222-3333-4444-555555555555");
    expect(recommendationHref(DEVNET.recommendation)).toBeNull();
  });
});

describe("the Base feed as an overview", () => {
  test("the saved snapshot is the golden, verbatim", () => {
    expect(readJson("data/vaults/base/vault-economics.json")).toEqual(GOLDEN_ECONOMICS);
  });

  test("rmUSDC alone: actual 100%, the others not on Base at 0%, no router and no applied layer", () => {
    const o = normalizeOverview(withRecommendation(legacyRaw(GOLDEN_ECONOMICS), null));
    const usdc = bySlug(o, "rmusdc");
    expect(usdc.availability).toBe("live");
    expect(usdc.actualBps).toBe(10000);
    expect(usdc.tvlUsd).toBe(199.697519);
    expect(usdc.address).toBe(VAULTS[0].baseAddress);
    expect(usdc.exitFeeBps).toBe(25);
    expect(usdc.auditStatus).toBe("Not audited");
    expect(usdc.sharePrice).toBeCloseTo(1.01196, 4);
    for (const slug of ["rmagent", "rmproto", "rmrwa"]) {
      expect(bySlug(o, slug).availability).toBe("not_on_network");
      expect(bySlug(o, slug).actualBps).toBe(0);
      expect(statusLabel(bySlug(o, slug), o.network?.label)).toBe("Not live on Base");
    }
    expect(layer(o, "appliedBps")).toEqual([null, null, null, null]);
    expect(layer(o, "recommendedBps")).toEqual([null, null, null, null]);
    expect(o.router?.availability).toBe("not_on_network");
    expect(o.network).toEqual({ chainId: 8453, label: "Base", testData: false });
    expect(o.combined).toEqual({ tvlUsd: 199.697519, vaultsLive: 1 });
    expect(fmtUsd(o.combined.tvlUsd)).toBe("$200");
  });

  test("holdings are the three adapters under their display names; no idle row at zero", () => {
    const usdc = bySlug(normalizeOverview(legacyRaw(GOLDEN_ECONOMICS)), "rmusdc");
    expect(usdc.holdings.map((h: any) => h.label)).toEqual(["Gauntlet USDC Prime", "Aave V3 USDC", "Compound III USDC"]);
    expect(usdc.holdings.map((h: any) => h.venueType)).toEqual(["Curated vault", "Pooled market", "Pooled market"]);
    expect(usdc.holdings.every((h: any) => h.kind === "adapter" && h.note === null)).toBe(true);
    expect(holdingsComplete(usdc.holdings)).toBe(true);
    expect(explorerLink(usdc.network, usdc.holdings[0].address)).toBe(`https://basescan.org/address/${GOLDEN_ECONOMICS.adapters[0].address}`);
  });

  test("a stale or late adapter read names itself; idle USDC shows only when held; a stub feed is test data", () => {
    const e = clone(GOLDEN_ECONOMICS);
    e.adapters[1].provenance = "stale";
    e.adapters[2].provenance = "backfilled";
    e.idleUsdc = 5;
    e.source = "stub";
    const raw = legacyRaw(e);
    const usdc: any = raw.vaults[0];
    expect(usdc.holdings[1].note).toBe("stale (Jul 30 16:20 UTC)");
    expect(usdc.holdings[2].note).toBe("caught up late");
    expect(usdc.holdings.at(-1)).toMatchObject({ kind: "idle", label: "Idle USDC", valueUsd: 5 });
    expect(raw.network.testData).toBe(true);
  });

  test("the 2026-06-24 recommendation over it: total gaps and tracking error, governance unknown", () => {
    const rec = {
      sessionId: null,
      date: "2026-06-24",
      subjectId: "robotmoney-allocation",
      publishedAt: "2026-06-24T23:54:23.120Z",
      releasedOnChain: null,
      href: "/swarm/2026-06-24/robotmoney-allocation",
      bpsByBucket: ALLOCATION_2026_06_24,
    };
    const o = normalizeOverview(withRecommendation(legacyRaw(GOLDEN_ECONOMICS), rec));
    expect(layer(o, "recommendedBps")).toEqual([9500, 300, 0, 200]);
    expect(o.vaults.map((v) => v.gaps.total)).toEqual([500, -300, 0, -200]);
    expect(o.vaults.every((v) => v.gaps.governance === null)).toBe(true);
    expect(o.trackingErrorBps).toBe(500);
    expect(recommendationHref(o.recommendation)).toBe("/swarm/2026-06-24/robotmoney-allocation");
    expect(fmtDate(recommendationDate(o.recommendation))).toBe("Jun 24, 2026");
  });

  test("a DTO that carries its own recommendation keeps it", () => {
    const rec = { sessionId: "x", bpsByBucket: ALLOCATION_2026_06_24 };
    expect(withRecommendation(DEVNET, rec)).toBe(DEVNET);
    expect(withRecommendation(legacyRaw(GOLDEN_ECONOMICS), null).recommendation).toBeNull();
  });
});

describe("canDeposit", () => {
  const legacy = normalizeOverview(legacyRaw(GOLDEN_ECONOMICS));
  const usdc = bySlug(legacy, "rmusdc");

  test("the production rmUSDC vault on Base", () => {
    expect(canDeposit(usdc, legacy.network)).toBe(true);
  });

  test("never another address, test data, the devnet, another vault, or a pause", () => {
    expect(canDeposit({ ...usdc, address: "0x" + "1".repeat(40) }, { chainId: 8453, label: "Base", testData: false })).toBe(false);
    expect(canDeposit(usdc, { ...legacy.network, testData: true })).toBe(false);
    const devnet = normalizeOverview(DEVNET);
    expect(canDeposit(bySlug(devnet, "rmusdc"), devnet.network)).toBe(false);
    expect(canDeposit(usdc, legacy.network, { depositsPaused: true })).toBe(false);
    expect(canDeposit(usdc, legacy.network, { shutdown: true })).toBe(false);
    expect(canDeposit({ ...usdc, status: "paused" }, legacy.network)).toBe(false);
    expect(canDeposit({ ...usdc, slug: "rmagent" }, legacy.network)).toBe(false);
    expect(canDeposit({ ...usdc, availability: "unavailable" }, legacy.network)).toBe(false);
  });
});

describe("the latest published recommendation", () => {
  const index = readJson("data/swarm/sessions/index.json");
  const indexRow = index.sessions.find((r: any) => r.file === "2026-06-24-robotmoney-allocation.json");
  const archived = archiveSession(indexRow, readJson("data/swarm/sessions/2026-06-24-robotmoney-allocation.json"));

  test("an archive file reads as a published session with a dated id", () => {
    expect(archived).toMatchObject({
      id: "2026-06-24-robotmoney-allocation",
      archived: true,
      date: "2026-06-24",
      subjectId: "robotmoney-allocation",
      state: "published",
      publishedAt: "2026-06-24T23:54:23.120Z",
    });
    const rec = recommendationFromSession(archived);
    expect(rec?.bpsByBucket).toEqual(ALLOCATION_2026_06_24);
    expect(rec?.href).toBe("/swarm/2026-06-24/robotmoney-allocation");
    expect(rec?.sessionId).toBeNull();
  });

  test("the API's array shape, a real id, and what is not a weights session", () => {
    const id = "11111111-2222-3333-4444-555555555555";
    const rec = recommendationFromSession({
      id,
      date: "2026-09-10",
      subjectId: "robotmoney-allocation",
      state: "published",
      publishedAt: "2026-09-10T12:00:00Z",
      swarmRecommendation: {
        type: "bucket_weights",
        weights: [
          { bucket: "conservative_defi_yield", weight: 0.9 },
          { bucket: "agent_tokens", weight: 0.05 },
          { bucket: "protocol_tokens", weight: 0.03 },
          { bucket: "real_world_assets", weight: 0.02 },
        ],
      },
    });
    expect(rec?.bpsByBucket).toEqual({ conservative_defi_yield: 9000, agent_tokens: 500, protocol_tokens: 300, real_world_assets: 200 });
    expect(rec?.href).toBe(`/swarm/sessions/${id}`);
    expect(rec?.sessionId).toBe(id);
    expect(recommendationFromSession({ id, swarmRecommendation: { type: "position_actions", actions: [] } })).toBeNull();
    const noId = recommendationFromSession({ swarmRecommendation: { type: "bucket_weights", weights: { agent_tokens: 1 } } });
    expect(noId?.href).toBeNull();
  });

  test("the newest published allocation session with weights wins", () => {
    const weights = (w: number) => ({ type: "bucket_weights", weights: { conservative_defi_yield: w, agent_tokens: 1 - w, protocol_tokens: 0, real_world_assets: 0 } });
    const rows = [
      { id: "a", subjectId: "robotmoney-allocation", state: "collecting", publishedAt: "2026-09-18", swarmRecommendation: weights(0.5) },
      { id: "b", subjectId: "robotmoney-vault", state: "published", publishedAt: "2026-09-17", swarmRecommendation: weights(0.6) },
      { id: "c", subjectId: "robotmoney-allocation", state: "published", publishedAt: "2026-09-16", swarmRecommendation: { type: "bucket_weights" } },
      { id: "d", subjectId: "robotmoney-allocation", state: "published", publishedAt: "2026-09-15", swarmRecommendation: weights(0.8) },
      { id: "e", subjectId: "robotmoney-allocation", state: "published", publishedAt: "2026-09-14", swarmRecommendation: weights(0.7) },
    ];
    expect(latestPublishedRecommendation(rows)?.bpsByBucket.conservative_defi_yield).toBe(8000);
    expect(latestPublishedRecommendation([])).toBeNull();
  });

  test("light API rows are read in full; an empty answer is an answer", async () => {
    const id = "11111111-2222-3333-4444-555555555555";
    const light = { id, date: "2026-09-10", subjectId: "robotmoney-allocation", state: "published", publishedAt: "2026-09-10T12:00:00Z" };
    serve({
      "/api/swarm/sessions": json({ sessions: [light] }),
      [`/api/swarm/sessions/${id}`]: json({ session: { ...light, swarmRecommendation: { type: "bucket_weights", weights: ALLOCATION_2026_06_24_FRACTIONS } } }),
    });
    const got = await loadLatestRecommendation({ hostname: "robotmoney.network" });
    expect(got.error).toBe(false);
    expect(got.rec?.bpsByBucket).toEqual(ALLOCATION_2026_06_24);
    expect(got.rec?.href).toBe(`/swarm/sessions/${id}`);

    serve({ "/api/swarm/sessions": json({ sessions: [] }) });
    expect(await loadLatestRecommendation({ hostname: "127.0.0.1" })).toEqual({ rec: null, error: false });
    expect(requests.some((u) => u.startsWith("/data/"))).toBe(false);
  });

  test("the list is read page by page until a session carries weights", async () => {
    const row = (id: string, date: string, rec: unknown) => ({ id, date, subjectId: "robotmoney-allocation", state: "published", publishedAt: `${date}T12:00:00Z`, swarmRecommendation: rec });
    const noCalls = { type: "position_actions", actions: [] };
    const firstPage = ["2026-09-21", "2026-09-20", "2026-09-19", "2026-09-18"].map((d, i) => row(`held-${i}`, d, noCalls));
    const weighted = row("aug-3", "2026-08-03", { type: "bucket_weights", weights: ALLOCATION_2026_06_24_FRACTIONS });
    serve({
      "/api/swarm/sessions": () => {
        const cursor = new URL(requests.at(-1)!, "http://x").searchParams.get("cursor");
        return json(cursor ? { sessions: [weighted], nextCursor: null } : { sessions: firstPage, nextCursor: "p2" })();
      },
    });
    const got = await loadLatestRecommendation({ hostname: "robotmoney.network" });
    expect(got.error).toBe(false);
    expect(got.rec?.date).toBe("2026-08-03");
    expect(got.rec?.bpsByBucket).toEqual(ALLOCATION_2026_06_24);
  });

  test("the archive answers only for a local host when the API cannot", async () => {
    serve();
    const local = await loadLatestRecommendation({ hostname: "127.0.0.1" });
    expect(local.error).toBe(false);
    expect(local.rec?.bpsByBucket).toEqual(ALLOCATION_2026_06_24);
    expect(local.rec?.href).toBe("/swarm/2026-06-24/robotmoney-allocation");

    requests = [];
    for (const hostname of PROD_HOSTS) {
      expect(await loadLatestRecommendation({ hostname })).toEqual({ rec: null, error: true });
    }
    expect(requests.some((u) => u.startsWith("/data/"))).toBe(false);
  });
});


describe("readers", () => {
  test("receiptApplied: only a matching weight recorded after the recommendation", () => {
    const r = { t: "2026-09-16T00:00:00Z", recommendedBps: 500 };
    expect(receiptApplied(r, [{ t: "2026-09-15", appliedBps: 500 }])).toBe(false);
    expect(receiptApplied(r, [{ t: "2026-09-17", appliedBps: 500 }])).toBe(true);
    expect(receiptApplied(r, [{ t: "2026-09-17", appliedBps: 400 }])).toBe(false);
    expect(receiptApplied({ ...r, recommendedBps: null }, [{ t: "2026-09-17", appliedBps: null }])).toBe(false);
  });

  test("statusLabel: the copy sheet's values", () => {
    const live = { availability: "live", status: "active", flags: { depositsPaused: false, withdrawalsPaused: false, shutdown: false } };
    expect(statusLabel(live)).toBe("Active");
    expect(statusLabel({ ...live, status: "paused" })).toBe("Paused");
    expect(statusLabel({ ...live, status: "retired" })).toBe("Retired");
    expect(statusLabel({ ...live, flags: { depositsPaused: true } })).toBe("Deposits paused");
    expect(statusLabel({ ...live, flags: { withdrawalsPaused: true } })).toBe("Withdrawals paused");
    expect(statusLabel({ ...live, flags: { shutdown: true } })).toBe("Shutdown");
    expect(statusLabel({ availability: "unavailable" })).toBe("Data unavailable");
    expect(statusLabel({ availability: "not_on_network" }, "Base")).toBe("Not live on Base");
    expect(statusLabel({ availability: "not_on_network" }, "Staging devnet")).toBe("Not live on Staging devnet");
  });

  test("explorerLink: BaseScan for a well-formed Base value only", () => {
    const addr = "0x" + "a".repeat(40);
    const tx = "0x" + "b".repeat(64);
    expect(explorerLink({ chainId: 8453 }, addr)).toBe(`https://basescan.org/address/${addr}`);
    expect(explorerLink({ chainId: 8453 }, tx, "tx")).toBe(`https://basescan.org/tx/${tx}`);
    expect(explorerLink({ chainId: 918453 }, addr)).toBeNull();
    expect(explorerLink({ chainId: 8453 }, "0x123")).toBeNull();
    expect(explorerLink({ chainId: 8453 }, null)).toBeNull();
    expect(explorerLink({ chainId: 8453 }, addr, "tx")).toBeNull();
  });

  test("holdingsComplete: every weight known and summing to 10000", () => {
    const rmusdc = readJson("data/vaults/devnet/rmusdc.json");
    expect(holdingsComplete(rmusdc.holdings)).toBe(true);
    const missing = clone(rmusdc.holdings);
    missing[0].weightBps = null;
    expect(holdingsComplete(missing)).toBe(false);
    expect(holdingsComplete(rmusdc.holdings.slice(1))).toBe(false);
    expect(holdingsComplete([])).toBe(false);
  });

  test("historyModel: sparse under seven points, one segment for a daily series, a split on a gap over three days", () => {
    const days = (n: number, from = 1) =>
      Array.from({ length: n }, (_, i) => ({ t: `2026-09-${String(from + i).padStart(2, "0")}T10:00:00Z`, tvlUsd: 1000 + i }));
    const six = historyModel(days(6));
    expect(six.sparse).toBe(true);
    expect(six.points).toHaveLength(6);

    const fifteen = historyModel(readJson("data/vaults/devnet/rmusdc.json").history.tvl, DEVNET.asOf);
    expect(fifteen.sparse).toBe(false);
    expect(fifteen.segments).toHaveLength(1);
    expect(fifteen.points).toHaveLength(15);
    expect(fifteen.points[0].x).toBe(0);
    expect(fifteen.points.at(-1)?.x).toBe(1);
    expect(fifteen.points.at(-1)?.y).toBe(1);
    expect(fifteen.max).toBe(72000);

    const gapped = historyModel([...days(4, 1), ...days(4, 9)]);
    expect(gapped.segments.map((s) => s.length)).toEqual([4, 4]);

    const messy = historyModel([{ t: "2026-09-03", tvlUsd: 3 }, { t: "nope", tvlUsd: 1 }, { t: "2026-09-01", tvlUsd: null }, { t: "2026-09-02", tvlUsd: 2 }]);
    expect(messy.points.map((p) => p.value)).toEqual([2, 3]);
    expect(historyModel([]).points).toEqual([]);
  });
});

describe("the mock-data switch", () => {
  test("isLocalHost is an allow-list", () => {
    for (const h of ["localhost", "app.localhost", "127.0.0.1", "[::1]", "stage.robotmoney-labs.dev", ""]) expect(isLocalHost(h)).toBe(true);
    for (const h of [...PROD_HOSTS, "localhost.robotmoney.network", "evil-localhost", "127.0.0.1.nip.io", "stage.robotmoney.net"]) {
      expect(isLocalHost(h)).toBe(false);
    }
  });

  test("base by default; a valid ?vaults= is stored and then persists; base resets it", () => {
    const storage = new MemStorage();
    const at = (search: string) => resolveVaultMode({ search, hostname: "127.0.0.1", storage });
    expect(at("")).toEqual({ mode: "base", state: null });
    expect(at("?vaults=devnet")).toEqual({ mode: "devnet", state: null });
    expect(storage.getItem("rm.vaults")).toBe("devnet");
    expect(at("")).toEqual({ mode: "devnet", state: null });
    expect(at("?other=1")).toEqual({ mode: "devnet", state: null });
    expect(at("?vaults=base")).toEqual({ mode: "base", state: null });
    expect(at("")).toEqual({ mode: "base", state: null });
    expect(at("?vaults=devnet-stale")).toEqual({ mode: "devnet", state: "stale" });
    expect(at("?vaults=nope")).toEqual({ mode: "devnet", state: "stale" });
    expect(at("?vaults=constructor")).toEqual({ mode: "devnet", state: "stale" });
    expect(storage.getItem("rm.vaults")).toBe("devnet-stale");
    for (const s of ["unreadable", "no-recommendation", "paused"] as const) {
      expect(at(`?vaults=devnet-${s}`)).toEqual({ mode: "devnet", state: s });
    }
  });

  test("a throwing storage is survived", () => {
    const storage = {
      getItem(): string | null { throw new Error("blocked"); },
      setItem(): void { throw new Error("blocked"); },
    };
    expect(resolveVaultMode({ search: "?vaults=devnet", hostname: "localhost", storage })).toEqual({ mode: "devnet", state: null });
    expect(resolveVaultMode({ search: "", hostname: "localhost", storage })).toEqual({ mode: "base", state: null });
    expect(resolveVaultMode({ search: "?vaults=devnet", hostname: "localhost", storage: null })).toEqual({ mode: "devnet", state: null });
  });

  test("a production-like host is base whatever the query and storage say, and writes nothing", () => {
    for (const hostname of PROD_HOSTS) {
      const storage = new MemStorage();
      storage.map.set("rm.vaults", "devnet");
      storage.writes = 0;
      expect(resolveVaultMode({ search: "?vaults=devnet", hostname, storage })).toEqual({ mode: "base", state: null });
      expect(resolveVaultMode({ search: "", hostname, storage })).toEqual({ mode: "base", state: null });
      expect(storage.writes).toBe(0);
    }
  });
});

describe("loadVaultOverview", () => {
  const devnetAt = (search = "?vaults=devnet") => ({ hostname: "127.0.0.1", search, storage: new MemStorage() });
  const baseAt = (hostname: string) => ({ hostname, search: "", storage: new MemStorage() });

  test("devnet reads the fixtures and never the API", async () => {
    serve();
    const load = await loadVaultOverview(devnetAt());
    expect(load.source).toBe("devnet");
    expect(load.mode).toBe("devnet");
    expect(load.label).toBe("Devnet test data");
    expect(load.error).toBeNull();
    expect(load.overview?.combined).toEqual({ tvlUsd: 100000, vaultsLive: 4 });
    expect(requests.some((u) => u.startsWith("/api/"))).toBe(false);
  });

  test("a devnet review state applies to the overview", async () => {
    serve();
    const load = await loadVaultOverview(devnetAt("?vaults=devnet-unreadable"));
    expect(load.state).toBe("unreadable");
    expect(bySlug(load.overview, "rmproto").actualBps).toBeNull();
    expect(load.overview?.vaults.every((v) => v.actualBps === null)).toBe(true);
    const paused = await loadVaultOverview(devnetAt("?vaults=devnet-paused"));
    expect(statusLabel(bySlug(paused.overview, "rmusdc"))).toBe("Paused");
  });

  test("the four-vault route answering is authoritative, and labelled when it serves test data", async () => {
    serve({ [VAULTS_ENDPOINT]: json(DEVNET) });
    const load = await loadVaultOverview({ ...baseAt("robotmoney.network"), endpoint: VAULTS_ENDPOINT });
    expect(load.source).toBe("api");
    expect(load.label).toBe("Devnet test data");
    expect(load.overview?.trackingErrorBps).toBe(200);
    expect(requests.some((u) => u.startsWith("/api/swarm"))).toBe(false);
  });

  test("the route absent (404): the Base feed with the archive's recommendation, on a local host", async () => {
    serve({ [VAULTS_ENDPOINT]: statusOnly(404), "/api/dashboards/vault-economics": json(GOLDEN_ECONOMICS) });
    const load = await loadVaultOverview(baseAt("127.0.0.1"));
    expect(load.source).toBe("legacy");
    expect(load.label).toBeNull();
    expect(load.recommendationError).toBe(false);
    expect(layer(load.overview, "recommendedBps")).toEqual([9500, 300, 0, 200]);
    expect(recommendationHref(load.overview?.recommendation)).toBe("/swarm/2026-06-24/robotmoney-allocation");
    expect(bySlug(load.overview, "rmusdc").actualBps).toBe(10000);
  });

  test("the SPA shell answering the route counts as absent", async () => {
    serve({ [VAULTS_ENDPOINT]: spaShell, "/api/dashboards/vault-economics": json(GOLDEN_ECONOMICS) });
    const load = await loadVaultOverview({ ...baseAt("127.0.0.1"), endpoint: VAULTS_ENDPOINT });
    expect(load.source).toBe("legacy");
  });

  test("the route is not requested until the contract declares it", async () => {
    serve({ [VAULTS_ENDPOINT]: json(DEVNET), "/api/dashboards/vault-economics": json(GOLDEN_ECONOMICS) });
    const load = await loadVaultOverview(baseAt("robotmoney.network"));
    expect(load.source).toBe("legacy");
    expect(requests.some((u) => u.split("?")[0] === VAULTS_ENDPOINT)).toBe(false);
  });

  test("on Base the policy's targets are the vaults' targets until a router reports its own (RM-115)", async () => {
    serve({
      [VAULTS_ENDPOINT]: statusOnly(404),
      "/api/dashboards/vault-economics": json(GOLDEN_ECONOMICS),
      "/api/dashboards/allocation": json(GOLDEN_ALLOCATION),
    });
    const load = await loadVaultOverview(baseAt("127.0.0.1"));
    const o = load.overview;
    expect(o?.targetSource).toBe("policy");
    expect(hasTargetLayer(o)).toBe(true);
    const targets = GOLDEN_ALLOCATION.strategy.map((s: { targetPct: number }) => Math.round(s.targetPct * 100));
    expect(layer(o, "targetBps")).toEqual(targets);
    // The router reported nothing: Applied stays empty, only Target fills.
    expect(layer(o, "appliedBps")).toEqual([null, null, null, null]);
    const usdc = bySlug(o, "rmusdc");
    expect(usdc.gaps.flow).toBe(10000 - targets[0]);
    expect(usdc.gaps.governance).toBe(targets[0] - 9500);
    expect(o?.trackingErrorBps).toBe(10000 - targets[0]);
  });

  test("with no policy to read, there is no target and one gap", async () => {
    serve({ [VAULTS_ENDPOINT]: statusOnly(404), "/api/dashboards/vault-economics": json(GOLDEN_ECONOMICS) });
    const load = await loadVaultOverview({ ...baseAt("robotmoney.network"), recommendation: false });
    expect(load.overview?.targetSource).toBeNull();
    expect(hasTargetLayer(load.overview)).toBe(false);
    expect(bySlug(load.overview, "rmusdc").gaps.flow).toBeNull();
  });

  test("a stub feed is labelled", async () => {
    serve({ [VAULTS_ENDPOINT]: statusOnly(404), "/api/dashboards/vault-economics": json({ ...GOLDEN_ECONOMICS, source: "stub" }) });
    const load = await loadVaultOverview(baseAt("127.0.0.1"));
    expect(load.label).toBe("Stub data");
    expect(load.overview?.network?.testData).toBe(true);
  });

  test("the absence is probed once per visit", async () => {
    serve({ [VAULTS_ENDPOINT]: statusOnly(404), "/api/dashboards/vault-economics": json(GOLDEN_ECONOMICS) });
    await loadVaultOverview({ ...baseAt("127.0.0.1"), endpoint: VAULTS_ENDPOINT });
    await loadVaultOverview({ ...baseAt("127.0.0.1"), endpoint: VAULTS_ENDPOINT });
    expect(requests.filter((u) => u.split("?")[0] === VAULTS_ENDPOINT)).toHaveLength(1);
    expect(requests.filter((u) => u.startsWith("/api/dashboards/vault-economics"))).toHaveLength(2);
  });

  test("recommendation: false reads no sessions", async () => {
    serve({ [VAULTS_ENDPOINT]: statusOnly(404), "/api/dashboards/vault-economics": json(GOLDEN_ECONOMICS) });
    const load = await loadVaultOverview({ ...baseAt("127.0.0.1"), recommendation: false });
    expect(load.overview?.recommendation).toBeNull();
    expect(requests.some((u) => u.includes("/swarm/sessions"))).toBe(false);
  });

  test("a 503 on a local host: the saved Base snapshot, labelled", async () => {
    serve();
    const load = await loadVaultOverview(baseAt("127.0.0.1"));
    expect(load.source).toBe("saved");
    expect(load.label).toBe("Saved Base snapshot");
    expect(bySlug(load.overview, "rmusdc").tvlUsd).toBe(199.697519);
    expect(layer(load.overview, "recommendedBps")).toEqual([9500, 300, 0, 200]);
    expect(requests).toContain("/data/vaults/base/vault-economics.json");
  });

  test("a failed Base feed after an absent route also falls back to the saved snapshot locally", async () => {
    serve({ [VAULTS_ENDPOINT]: statusOnly(404) });
    const load = await loadVaultOverview(baseAt("localhost"));
    expect(load.source).toBe("saved");
  });

  test("a production-like host with no answer: unavailable, and no static data is read", async () => {
    for (const hostname of PROD_HOSTS) {
      _resetVaultProbe();
      serve();
      const load = await loadVaultOverview(baseAt(hostname));
      expect(load.overview).toBeNull();
      expect(load.source).toBeNull();
      expect(load.error).toBe("Vault data unavailable");
      serve({ [VAULTS_ENDPOINT]: statusOnly(404) });
      expect((await loadVaultOverview(baseAt(hostname))).error).toBe("Vault data unavailable");
    }
    expect(requests.some((u) => u.startsWith("/data/"))).toBe(false);
  });

  test("devnet requested on a production host reads nothing devnet", async () => {
    serve();
    const storage = new MemStorage();
    const load = await loadVaultOverview({ hostname: "robotmoney.network", search: "?vaults=devnet", storage });
    expect(load.mode).toBe("base");
    expect(load.error).toBe("Vault data unavailable");
    expect(storage.writes).toBe(0);
    expect(requests.some((u) => u.includes("/data/vaults"))).toBe(false);
  });

  test("a production host with the Base feed but no sessions API: no recommendation, flagged as unread", async () => {
    serve({ [VAULTS_ENDPOINT]: statusOnly(404), "/api/dashboards/vault-economics": json(GOLDEN_ECONOMICS) });
    const load = await loadVaultOverview(baseAt("robotmoney.network"));
    expect(load.source).toBe("legacy");
    expect(load.overview?.recommendation).toBeNull();
    expect(load.recommendationError).toBe(true);
    expect(requests.some((u) => u.startsWith("/data/"))).toBe(false);
  });
});

describe("loadVaultDetail", () => {
  test("devnet: the vault's own file, in the review state", async () => {
    serve();
    const load = await loadVaultOverview({ hostname: "127.0.0.1", search: "?vaults=devnet-paused", storage: new MemStorage() });
    const { detail, error } = await loadVaultDetail("rmusdc", load);
    expect(error).toBeNull();
    expect(detail.slug).toBe("rmusdc");
    expect(detail.flags.depositsPaused).toBe(true);
    expect(statusLabel(detail)).toBe("Paused");
    const agent = await loadVaultDetail("rmagent", load);
    expect(agent.detail.holdings.reduce((n: number, h: any) => n + h.valueUsd, 0)).toBe(9000);
  });

  test("the Base feed: the overview row is the detail", async () => {
    serve({ [VAULTS_ENDPOINT]: statusOnly(404), "/api/dashboards/vault-economics": json(GOLDEN_ECONOMICS) });
    const load = await loadVaultOverview({ hostname: "127.0.0.1", search: "", storage: new MemStorage(), recommendation: false });
    const { detail } = await loadVaultDetail("rmusdc", load);
    expect(detail.holdings).toHaveLength(3);
    const agent = await loadVaultDetail("rmagent", load);
    expect(agent.detail.availability).toBe("not_on_network");
  });

  test("the API: a detail for another vault or another chain is refused", async () => {
    const rmusdc = readJson("data/vaults/devnet/rmusdc.json");
    serve({
      [VAULTS_ENDPOINT]: json(DEVNET),
      [`${VAULTS_ENDPOINT}/rmusdc`]: json(rmusdc),
      [`${VAULTS_ENDPOINT}/rmagent`]: json(rmusdc),
      [`${VAULTS_ENDPOINT}/rmproto`]: json({ ...readJson("data/vaults/devnet/rmproto.json"), network: { chainId: 8453, label: "Base", testData: false } }),
    });
    const load = await loadVaultOverview({ hostname: "robotmoney.network", search: "", storage: null, endpoint: VAULTS_ENDPOINT });
    expect((await loadVaultDetail("rmusdc", load)).detail.slug).toBe("rmusdc");
    expect(await loadVaultDetail("rmagent", load)).toEqual({ detail: null, error: "Vault detail unavailable" });
    expect(await loadVaultDetail("rmproto", load)).toEqual({ detail: null, error: "Vault detail unavailable" });
    expect(await loadVaultDetail("rmrwa", load)).toEqual({ detail: null, error: "Vault detail unavailable" });
    expect(await loadVaultDetail("nope", load)).toEqual({ detail: null, error: "Vault detail unavailable" });
    expect(await loadVaultDetail("rmusdc", null)).toEqual({ detail: null, error: "Vault detail unavailable" });
  });
});

describe("loadAllocationDto", () => {
  test("the API first", async () => {
    serve({ "/api/dashboards/allocation": json(GOLDEN_ALLOCATION) });
    expect(await loadAllocationDto("robotmoney.network")).toEqual(GOLDEN_ALLOCATION);
  });

  test("with no API: the manifest, recipe included, on a local host; null elsewhere", async () => {
    serve();
    const dto = await loadAllocationDto("127.0.0.1");
    expect(dto.strategy.map((s: any) => s.targetPct)).toEqual([95, 5, 0, 0]);
    expect(dto.buckets.map((b: any) => b.key)).toEqual(["defi-yield", "agent-tokens", "protocol-tokens", "rwa"]);
    expect(dto.buckets[1].items).toHaveLength(7);
    expect(dto.buckets[1].items[0]).toEqual({ label: "RobotMoney", targetPct: 14.29 });
    expect(dto.buckets.map((b: any) => b.key)).toEqual(GOLDEN_ALLOCATION.buckets.map((b: any) => b.key));

    requests = [];
    expect(await loadAllocationDto("robotmoney.network")).toBeNull();
    expect(requests.some((u) => u.startsWith("/data/"))).toBe(false);
  });
});

describe("the shipped fixtures", () => {
  const details = VAULTS.map((v) => readJson(`data/vaults/devnet/${v.slug}.json`));
  const subject = readJson("data/vaults/devnet/subject.json");

  test("each detail is its overview row plus holdings that sum to its TVL", () => {
    details.forEach((d, i) => {
      const row = DEVNET.vaults[i];
      expect(d.slug).toBe(VAULTS[i].slug);
      for (const k of ["symbol", "bucket", "availability", "status", "tvlUsd", "recommendedBps", "appliedBps", "actualBps", "gaps"]) {
        expect(d[k]).toEqual(row[k]);
      }
      expect(d.holdings.reduce((n: number, h: any) => n + h.valueUsd, 0)).toBe(d.tvlUsd);
      expect(holdingsComplete(d.holdings)).toBe(true);
      // More than a page of events (ten), newest first.
      expect(d.activity.length).toBeGreaterThan(10);
      expect(d.activity.map((a: any) => a.t)).toEqual([...d.activity.map((a: any) => a.t)].sort().reverse());
      expect(d.history.tvl).toHaveLength(15);
      expect(d.history.tvl.at(-1).tvlUsd).toBe(d.tvlUsd);
      expect(receiptApplied(d.history.receipts[0], d.history.weights)).toBe(d.history.receipts[0].applied);
      expect(d.address).toBeNull();
      expect(d.network).toEqual(DEVNET.network);
    });
    // No two vaults read as copies: each has its own share price and events.
    expect(new Set(details.map((d) => d.sharePrice)).size).toBe(VAULTS.length);
    expect(new Set(details.map((d) => JSON.stringify(d.activity))).size).toBe(VAULTS.length);
  });

  test("the subject book: a router holding nothing and four vaults, one per sleeve", () => {
    const [router, ...vaults] = subject.wallets;
    expect(router).toMatchObject({ kind: "router", address: null });
    expect(router.value_usd).toBeUndefined();
    expect(vaults.map((w: any) => w.kind)).toEqual(["vault", "vault", "vault", "vault"]);
    expect(vaults.map((w: any) => w.sleeve)).toEqual(VAULTS.map((v) => v.bucket));
    expect(vaults.map((w: any) => w.vault)).toEqual(VAULT_SLUGS);
  });

  test("fifteen daily readings whose positions sum to each vault, ending on the overview's TVL", () => {
    expect(subject.snapshots).toHaveLength(15);
    expect(subject.snapshots[0].date).toBe("2026-09-03");
    expect(subject.snapshots.at(-1).date).toBe("2026-09-17");
    for (const s of subject.snapshots) {
      expect(s.subject_id).toBe("robotmoney-vault");
      expect(s.positions.every((p: any) => VAULT_SLUGS.includes(p.vault))).toBe(true);
      const sum = s.positions.reduce((n: number, p: any) => n + p.value_usd, 0);
      expect(sum).toBeCloseTo(s.total_value_usd, 6);
      for (const w of s.wallets) {
        const held = s.positions.filter((p: any) => p.vault === w.vault).reduce((n: number, p: any) => n + p.value_usd, 0);
        expect(held).toBeCloseTo(w.value_usd, 6);
      }
    }
    const last = subject.snapshots.at(-1);
    expect(last.total_value_usd).toBe(100000);
    for (const row of DEVNET.vaults) {
      const held = last.positions.filter((p: any) => p.vault === row.slug).reduce((n: number, p: any) => n + p.value_usd, 0);
      expect(held).toBeCloseTo(row.tvlUsd, 6);
    }
  });

  test("the subject fixture loads oldest first, on a local host only", async () => {
    serve();
    const fx = await loadVaultSubjectFixture({ hostname: "127.0.0.1" });
    expect(fx?.wallets).toHaveLength(5);
    expect(fx?.snapshots.map((s: any) => s.date)).toEqual([...fx!.snapshots.map((s: any) => s.date)].sort());
    requests = [];
    expect(await loadVaultSubjectFixture({ hostname: "robotmoney.network" })).toBeNull();
    expect(requests).toEqual([]);
  });

  test("applyReviewState copies; the input is untouched", () => {
    const before = JSON.stringify(DEVNET);
    applyReviewState(DEVNET, "unreadable");
    applyReviewState(DEVNET, "no-recommendation");
    applyReviewState(DEVNET, "paused");
    expect(JSON.stringify(DEVNET)).toBe(before);
    expect(applyReviewState(details[0], "no-recommendation").history.receipts).toEqual([]);
  });

  test("the vault subject manifest names its wallet as the rmUSDC vault", () => {
    const manifest = readJson("data/swarm/manifests/subjects/robotmoney-vault.json");
    expect(manifest.wallets).toEqual([
      { address: VAULTS[0].baseAddress, chain: "base", label: "vault", kind: "vault", vault: "rmusdc", sleeve: "conservative_defi_yield" },
    ]);
  });

  test("no fixture or vault lib promises anything", () => {
    const dir = join(publicDir, "data/vaults");
    const files = [
      ...readdirSync(join(dir, "devnet")).map((f) => join(dir, "devnet", f)),
      ...readdirSync(join(dir, "base")).map((f) => join(dir, "base", f)),
      join(publicDir, "assets/js/app/lib/vault-data.js"),
      join(publicDir, "assets/js/app/lib/vault-source.js"),
    ];
    expect(files.length).toBeGreaterThanOrEqual(8);
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      expect(text, f).not.toMatch(/principal[- ]protected/i);
      expect(text, f).not.toMatch(/guaranteed/i);
    }
  });
});

// The vault swarm subject's book (step 4): a position that names its vault
// counts toward that vault's sleeve whatever its token, and a book read before
// positions named one sums exactly as it always did.
describe("the vault stack's book in sleeves", () => {
  const manifest = readJson("data/swarm/manifests/allocation.json");
  // The framework as loadAllocationFramework() normalises it: ids and
  // uppercase token lists. Conservative DeFi Yield's list includes USDC.
  const framework = {
    buckets: manifest.buckets.map((b: any) => ({ id: b.id, tokens: (b.tokens || []).map((t: string) => String(t).toUpperCase()) })),
  };
  const book = readJson("data/vaults/devnet/subject.json").snapshots.at(-1);
  const shares = (m: Map<string, number>) => BUCKET_ORDER.map((id) => Math.round((m.get(id) ?? NaN) * 10000));

  test("idle USDC inside rmAGENT is Agent Tokens money, not Conservative DeFi Yield", () => {
    expect(framework.buckets[0].tokens).toContain("USDC");
    const idle = book.positions.find((p: any) => p.vault === "rmagent" && p.token === "USDC");
    expect(idle?.value_usd).toBe(400);
    expect(shares(bookSleeveShares(framework, book, "2026-09-17"))).toEqual([7200, 900, 1400, 500]);
  });

  test("a book whose every position names its vault needs no framework", () => {
    expect(shares(bookSleeveShares(null, book, "2026-09-17"))).toEqual([7200, 900, 1400, 500]);
    // Still dated: a book read after the session is not what it acted on.
    expect(bookSleeveShares(null, book, "2026-09-16").size).toBe(0);
  });

  test("a snapshot without vault fields sums by token lists, as before", () => {
    const archived = readJson("data/swarm/subjects/robotmoney-vault/2026-06-22.json");
    expect(archived.positions.some((p: any) => "vault" in p)).toBe(false);
    expect(shares(bookSleeveShares(framework, archived, "2026-06-22"))).toEqual([10000, 0, 0, 0]);
    expect(bookSleeveShares(null, archived, "2026-06-22").size).toBe(0);
  });

  test("in a mixed book, only the positions that name a vault leave the token rule", () => {
    const mixed = {
      date: "2026-09-17",
      total_value_usd: 1000,
      positions: [
        { token: "USDC", value_usd: 600 },
        { token: "USDC", value_usd: 400, vault: "rmrwa" },
      ],
    };
    expect(shares(bookSleeveShares(framework, mixed, "2026-09-17"))).toEqual([6000, 0, 0, 4000]);
    // Not every position names a vault, so no framework means no reading.
    expect(bookSleeveShares(null, mixed, "2026-09-17").size).toBe(0);
  });

  test("the devnet chain reads by its name", () => {
    expect(sessionSummary.chainLabel("devnet")).toBe("Staging devnet");
    expect(sessionSummary.chainLabel("base")).toBe("Base");
  });
});

describe("one name and one layout per vault reading", () => {
  test("positionName: a position in the subject's book reads as its vault page names it", () => {
    const archive = readJson("data/swarm/subjects/robotmoney-vault/2026-06-22.json");
    const economics = normalizeOverview(legacyRaw(GOLDEN_ECONOMICS));
    const pageNames = economics.vaults[0].holdings.map((h: any) => h.label);
    expect(archive.positions.map((p: any) => positionName(p, "rmusdc"))).toEqual(
      expect.arrayContaining(pageNames.filter((n: string) => n !== "Idle USDC")),
    );
    expect(positionName({ token: "USDC", name: "USDC" }, "rmagent")).toBe("Idle USDC");
    // An adapter's name only inside rmUSDC: a MORPHO token elsewhere is a token.
    expect(positionName({ token: "MORPHO", name: "Morpho" }, "rmproto")).toBe("Morpho");
    expect(positionName({ token: "HYPE" }, null)).toBe("HYPE");
    // The devnet book and the devnet vault pages agree, position for position.
    const book = readJson("data/vaults/devnet/subject.json").snapshots.at(-1);
    for (const v of VAULTS) {
      const detail = readJson(`data/vaults/devnet/${v.slug}.json`);
      const names = book.positions.filter((p: any) => p.vault === v.slug).map((p: any) => positionName(p, v.slug));
      expect(names).toEqual(detail.holdings.map((h: any) => h.label));
    }
  });

  test("hasAppliedLayer: only a complete Applied layer", () => {
    expect(hasAppliedLayer(normalizeOverview(DEVNET))).toBe(true);
    expect(hasAppliedLayer(normalizeOverview(legacyRaw(GOLDEN_ECONOMICS)))).toBe(false);
    expect(hasAppliedLayer(null)).toBe(false);
  });
});
