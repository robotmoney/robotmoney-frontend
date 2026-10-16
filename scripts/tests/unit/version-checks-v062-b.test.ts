// v0.6.2's version checks Q41 to Q47 (scripts/release/version-checks/v0.6.2/):
// each check's pure decision, with a red control, against what the shipped
// files actually hold.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BANKR_ROWS_SQL, BANKR_TOKEN_ADDRESSES, bankrTokenRowsProblems } from "../../release/version-checks/v0.6.2/bankr-token-rows.ts";
import { CATCHUP_SQL, LATEST_ONLY_KINDS, latestOnlyProblems } from "../../release/version-checks/v0.6.2/latest-only-catchup.ts";
import { brandMarkProblems, EXPECTED_MARKS, looksLikeImage, MEMBER_LOGOS_PATH, parseMemberLogos } from "../../release/version-checks/v0.6.2/brand-marks.ts";
import { cacheEnvOf, DEFAULT_CONTAINER_CACHE_DIR, fetchCacheProblems, parseDu } from "../../release/version-checks/v0.6.2/fetch-cache.ts";
import { FIXTURE_COUNTS_SQL, FIXTURE_PROJECTS, FIXTURE_VAULTS, FIXTURE_WALLETS, fixtureProblems } from "../../release/version-checks/v0.6.2/fixture-guard.ts";
import { retiredEnvProblems, retiredNamesIn } from "../../release/version-checks/v0.6.2/rm-env-retired.ts";
import { API_REFERENCE_FIELDS, SKILL_REFUSALS, takeRulesProblems } from "../../release/version-checks/v0.6.2/take-rules.ts";

const repo = join(import.meta.dir, "..", "..", "..");
const read = (p: string) => readFileSync(join(repo, p), "utf8");

describe("C27-brand-marks (1344)", () => {
  const shipped = read(`frontend/public${MEMBER_LOGOS_PATH}`);
  const handles = new Set(Object.keys(EXPECTED_MARKS));
  const goodAssets = Object.values(EXPECTED_MARKS).map((path) => ({ path, ok: true, status: 200 }));

  test("the shipped member-logos.js maps both handles to their marks, and both mark files exist", () => {
    const logos = parseMemberLogos(shipped);
    for (const [h, mark] of Object.entries(EXPECTED_MARKS)) expect(logos[h]).toBe(mark);
    expect(logos.shodai).toBe("/avatars/swarm/shodai.svg");
    for (const mark of Object.values(EXPECTED_MARKS)) expect(readFileSync(join(repo, "frontend/public", mark)).length).toBeGreaterThan(0);
    expect(brandMarkProblems({ logosStatus: 200, logos, assets: goodAssets, handles })).toEqual([]);
  });

  test("red: a mark the site does not map, a handle no member holds, an asset that is not its image", () => {
    const before = parseMemberLogos(shipped.replace(/\s*"minds-by-animoca-brands":[^\n]*\n/, "\n"));
    const problems = brandMarkProblems({ logosStatus: 200, logos: before, assets: [{ path: "/avatars/swarm/animoca-brands.svg", ok: false, status: 404 }], handles: new Set(["dualmint-2"]) });
    expect(problems.join("\n")).toContain("maps minds-by-animoca-brands to nothing");
    expect(problems.join("\n")).toContain("no member has the handle minds-by-animoca-brands");
    expect(problems.join("\n")).toContain("animoca-brands.svg answered 404");
    expect(brandMarkProblems({ logosStatus: 404, logos: {}, assets: goodAssets, handles }).join("\n")).toContain(`${MEMBER_LOGOS_PATH} answered 404`);
  });

  test("an image is what its path names: an SVG document or a PNG signature, and 200", () => {
    expect(looksLikeImage("/a.svg", 200, read("frontend/public/avatars/swarm/animoca-brands.svg"))).toBe(true);
    expect(looksLikeImage("/a.png", 200, "\u0089PNG\r\n")).toBe(true);
    // red control: the SPA's index.html answered for a missing file is no image.
    expect(looksLikeImage("/a.svg", 200, "<!doctype html><html>")).toBe(false);
    expect(looksLikeImage("/a.png", 200, "<!doctype html>")).toBe(false);
    expect(looksLikeImage("/a.svg", 404, "<svg>")).toBe(false);
  });
});

describe("C28-fetch-cache (1349)", () => {
  test("a container's cache directory and bound resolve as fetch-cache.ts resolves them", () => {
    expect(cacheEnvOf(["PATH=/bin", "HTTP_FETCH_CACHE_TTL_MS=", "HTTP_FETCH_CACHE_MAX_BYTES="])).toEqual({ dir: DEFAULT_CONTAINER_CACHE_DIR, maxBytes: 256 * 1024 * 1024, maxRaw: "" });
    expect(cacheEnvOf(["FETCH_CACHE_DIR=/data/cache", "HTTP_FETCH_CACHE_MAX_BYTES=1000"])).toEqual({ dir: "/data/cache", maxBytes: 1000, maxRaw: "1000" });
    expect(cacheEnvOf(["HTTP_FETCH_CACHE_MAX_BYTES=lots"])?.maxBytes).toBeNull();
    // a container that runs no fetcher (website-server, a participant) is not read.
    expect(cacheEnvOf(["PATH=/bin", "NGINX_VERSION=1"])).toBeNull();
  });

  test("du output: bytes, absent, or unreadable", () => {
    expect(parseDu(0, "12345\t/tmp/robotmoney-fetch-cache\n")).toBe(12345);
    expect(parseDu(0, "absent\n")).toBe("absent");
    expect(parseDu(1, "")).toBeNull();
    expect(parseDu(0, "garbage")).toBeNull();
  });

  test("in bound passes; red: over the bound, unreadable, no bound, nothing to read", () => {
    const ok = [{ container: "api", dir: "/tmp/c", maxBytes: 1000, bytes: 1000 as const }, { container: "worker", dir: "/tmp/c", maxBytes: 1000, bytes: "absent" as const }];
    expect(fetchCacheProblems(ok, 9)).toEqual([]);
    const bad = fetchCacheProblems([
      { container: "producer", dir: "/tmp/c", maxBytes: 1000, bytes: 1001 },
      { container: "api", dir: "/tmp/c", maxBytes: 1000, bytes: null },
      { container: "worker", dir: "/tmp/c", maxBytes: null, bytes: 5 },
    ], 9).join("\n");
    expect(bad).toContain("producer: /tmp/c holds 1001 bytes, over its 1000-byte bound");
    expect(bad).toContain("api: the size of /tmp/c could not be read");
    expect(bad).toContain("worker: HTTP_FETCH_CACHE_MAX_BYTES is not a non-negative integer");
    expect(fetchCacheProblems([], 0)).toEqual(["no running container of the instance to read"]);
  });
});

describe("C29-rm-env-retired (1325, 1342)", () => {
  test("names only, never values; set to anything counts", () => {
    expect(retiredNamesIn(["PATH=/bin", "RM_ENVIRONMENT=x", "DATABASE_URL=postgres://u:secret@h/d"])).toEqual([]);
    expect(retiredNamesIn(["RM_ENV=prod", "RM_ALLOW_INSECURE="])).toEqual(["RM_ENV", "RM_ALLOW_INSECURE"]);
  });

  test("clean containers pass; red: one that still receives RM_ENV, one unreadable, none at all", () => {
    expect(retiredEnvProblems([{ container: "api", retired: [] }, { container: "participant-judge", retired: [] }])).toEqual([]);
    const bad = retiredEnvProblems([{ container: "participant-judge", retired: ["RM_ENV"] }, { container: "api", retired: null }]);
    expect(bad).toEqual(["participant-judge still receives RM_ENV", "api: its environment could not be read"]);
    expect(bad.join("\n")).not.toContain("prod");
    expect(retiredEnvProblems([])).toEqual(["no running container of the instance to read"]);
  });

  test("no compose file the stack boots from hands RM_ENV or RM_ALLOW_INSECURE to a container (what the check expects to find)", () => {
    expect(read("docker-compose.yml")).not.toMatch(/^\s*RM_ENV\s*:/m);
    expect(read("docker-compose.yml")).not.toMatch(/RM_ALLOW_INSECURE/);
  });
});

describe("C30-fixture-guard (1297, issue 1208)", () => {
  const migration = read("backend/migrations/0118_purge_projects_fixture_rows.sql");

  test("the identities are migration 0118's own: every wallet, vault and slug/logo pair", () => {
    for (const w of FIXTURE_WALLETS) expect(migration).toContain(`'${w}'`);
    for (const v of FIXTURE_VAULTS) expect(migration).toContain(`'${v}'`);
    for (const [slug, logo] of FIXTURE_PROJECTS) expect(migration).toMatch(new RegExp(`\\('${slug}',\\s*'${logo.replace(/[.]/g, "\\.")}'\\)`));
    expect(migration.match(/0xwallet0{31}[a-d]{3}/g)!.length).toBe(FIXTURE_WALLETS.length);
    expect(migration.match(/0xvault0{31}[a-b]{3}/g)!.length).toBe(FIXTURE_VAULTS.length);
  });

  test("the query reads only, and every identity is in it", () => {
    expect(FIXTURE_COUNTS_SQL.trimStart().startsWith("SELECT")).toBe(true);
    expect(FIXTURE_COUNTS_SQL).not.toMatch(/\b(DELETE|UPDATE|INSERT|DROP|ALTER)\b/i);
    for (const x of [...FIXTURE_WALLETS, ...FIXTURE_VAULTS, ...FIXTURE_PROJECTS.flat()]) expect(FIXTURE_COUNTS_SQL).toContain(`'${x}'`);
  });

  test("none passes; red: any fixture row of any kind fails", () => {
    expect(fixtureProblems({ wallets: 0, vaults: 0, projects: 0 })).toEqual([]);
    expect(fixtureProblems({ wallets: 4, vaults: 2, projects: 4 })).toHaveLength(3);
    expect(fixtureProblems({ wallets: 0, vaults: 1, projects: 0 })).toEqual(["1 vault(s) carry a fixture address"]);
  });
});

describe("C31-take-rules (1340)", () => {
  const skill = { status: 200, text: read("frontend/public/skills/swarm-onboarding/SKILL.md") };
  const apiReference = { status: 200, text: read("frontend/public/views/docs/investment-swarm/api-reference.html") };

  test("the shipped skill names every refusal and the API reference documents every field", () => {
    expect(takeRulesProblems(skill, apiReference)).toEqual([]);
    expect(SKILL_REFUSALS.length).toBe(9);
    expect(API_REFERENCE_FIELDS).toEqual(["sessionId", "reportSnapshotId", "schemaVersion"]);
  });

  test("red: the skill before 1340 (no field contract, no refusal table) and an API reference without reportSnapshotId", () => {
    const old = { status: 200, text: skill.text.replace(/member is excused from this session/g, "").replace(/reportSnapshotId does not match this session's brief/g, "") };
    const problems = takeRulesProblems(old, { status: 200, text: apiReference.text.replace(/reportSnapshotId/g, "") });
    expect(problems).toEqual([
      '/skills/swarm-onboarding/SKILL.md does not name the refusal "member is excused from this session"',
      `/skills/swarm-onboarding/SKILL.md does not name the refusal "reportSnapshotId does not match this session's brief"`,
      "/views/docs/investment-swarm/api-reference.html does not document reportSnapshotId",
    ]);
    expect(takeRulesProblems({ status: 404, text: "" }, apiReference)).toEqual(["/skills/swarm-onboarding/SKILL.md answered 404"]);
  });
});

describe("C32-bankr-token-rows (1383, issue 1382)", () => {
  const migration = read("backend/migrations/0124_deactivate_bankr_token_vaults.sql");

  test("the check's addresses are migration 0124's own, and the query reads only lp-fees rows at them", () => {
    for (const a of BANKR_TOKEN_ADDRESSES) expect(migration.toLowerCase()).toContain(a);
    expect(BANKR_ROWS_SQL).toContain("strategy_type = 'lp-fees'");
    for (const a of BANKR_TOKEN_ADDRESSES) expect(BANKR_ROWS_SQL).toContain(a);
    expect(BANKR_ROWS_SQL).not.toMatch(/\b(update|delete|insert)\b/i);
  });

  test("no active row passes, including a database that never held the rows; red: an active row fails", () => {
    expect(bankrTokenRowsProblems({ rows: 0, active: 0 })).toEqual([]);
    expect(bankrTokenRowsProblems({ rows: 2, active: 0 })).toEqual([]);
    expect(bankrTokenRowsProblems({ rows: 2, active: 1 })[0]).toContain("1 of 2 Bankr lp-fees token row(s) are still active");
  });
});

describe("Q47-latest-only-catchup (1381, issue 1378)", () => {
  const migration = read("backend/migrations/0125_job_schedules_latest_only_catchup.sql");

  test("the check's kinds are migration 0125's own, and the query only reads", () => {
    for (const kind of LATEST_ONLY_KINDS) expect(migration).toContain(`'${kind}'`);
    expect(LATEST_ONLY_KINDS).toHaveLength(6);
    for (const kind of LATEST_ONLY_KINDS) expect(CATCHUP_SQL).toContain(`'${kind}'`);
    expect(CATCHUP_SQL).not.toMatch(/\b(update|delete|insert)\b/i);
  });

  test("all six kinds on latest-only pass; red: a missing row or another policy fails", () => {
    const all = LATEST_ONLY_KINDS.map((kind) => ({ kind, catchup_policy: "latest-only" }));
    expect(latestOnlyProblems(all)).toEqual([]);
    expect(latestOnlyProblems(all.slice(1))).toEqual([`${LATEST_ONLY_KINDS[0]} has no job_schedules row`]);
    expect(latestOnlyProblems(all.map((r, i) => (i === 2 ? { ...r, catchup_policy: "all" } : r)))).toEqual([`${LATEST_ONLY_KINDS[2]} catches up with 'all', not 'latest-only'`]);
  });
});
