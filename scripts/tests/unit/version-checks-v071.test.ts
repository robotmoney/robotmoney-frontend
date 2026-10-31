// v0.7.1's version checks Q34b and Q38 to Q41 (C22a and C26 to C29)
// (scripts/release/version-checks/v0.7.1/): each check's decision with a
// passing case and a red control, and the runbook that runs them.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LEGACY_JUNCTION } from "../../../packages/analyst-sdk/src/archive/format1-legacy.ts";
import { repoMigrations } from "../../release/ledger.ts";
import { sha256Hex } from "../../release/public-analytics-read.ts";
import { loadReleaseRunbook, stepNameOf } from "../../release/runbook.ts";
import {
  archiveProblems, archiveRecords, BUDGET_MS, chosenBackups, type Answer, type ArchiveDeps,
} from "../../release/version-checks/v0.7.1/archive-records.ts";
import { committedInputs, routeProblems, vintageProblems, type RegimeVintage } from "../../release/version-checks/v0.7.1/committed-inputs.ts";
import { captureProblems, FRAMEWORK, FRAMEWORK_MIGRATION, frameworkProblems, MIGRATION, TRIGGERS } from "../../release/version-checks/v0.7.1/migration-ledger.ts";
import { cspProblems, healthProblems } from "../../release/version-checks/v0.7.1/public-surface.ts";
import { expectedStart, loadSeries, seriesProblems, storageKeyOf, type KeyRow } from "../../release/version-checks/v0.7.1/research-series.ts";

const COMMIT = "a".repeat(40);
const enc = (v: unknown) => new TextEncoder().encode(typeof v === "string" ? v : JSON.stringify(v));

describe("Q38-committed-inputs/C26-committed-inputs (1533, 1536)", () => {
  const vintage = (build: string, id = "700"): RegimeVintage => ({ id, build_identity: build, knowledge_time_cutoff: "2026-10-29 12:30:01.123+00", created_at: "2026-10-29 12:31:00+00", member_count: "183930" });
  const deps = (routeStatus: number, vintages: (RegimeVintage | undefined)[], clock = { t: 0 }) => ({
    http: async (path: string) => path === "/api/version"
      ? { status: 200, text: JSON.stringify({ commit: COMMIT, tag: null }) }
      : { status: routeStatus, text: routeStatus === 401 ? '{"error":"missing analytics-provider bearer token"}' : '{"error":"not found"}' },
    newestRegimeVintage: async () => vintages.length > 1 ? vintages.shift() : vintages[0],
    now: () => clock.t,
    sleep: async (ms: number) => { clock.t += ms; },
    log: () => {},
    waitMs: 60_000, pollMs: 10_000,
  });

  test("passes: the route answers 401 with no credential and the newest regime vintage carries the running commit", async () => {
    const r = await committedInputs(deps(401, [vintage(COMMIT)]));
    expect(r.problems).toEqual([]);
    expect(r.found.polls).toBe(1);
  });
  test("it waits for a regime run of this release, then passes", async () => {
    const r = await committedInputs(deps(401, [vintage("b".repeat(40), "699"), vintage("b".repeat(40), "699"), vintage(COMMIT)]));
    expect(r.problems).toEqual([]);
    expect(r.found.polls).toBe(3);
  });
  test("red: an api without the route (404), another answer, no run of this release within the wait, no vintage, no commit", async () => {
    expect((await committedInputs(deps(404, [vintage(COMMIT)]))).problems.join()).toContain("does not have the committed-inputs route");
    expect(routeProblems(200, "{}").join()).toContain("answered 200, not 401");
    const stale = await committedInputs(deps(401, [vintage("b".repeat(40))]));
    expect(stale.problems.join()).toContain("no regime run of this release has frozen a vintage within the wait");
    expect(stale.found.polls).toBe(7);
    expect(vintageProblems(COMMIT, undefined).join()).toContain("no regime vintage");
    expect(vintageProblems(null, vintage(COMMIT)).join()).toContain("no commit");
  });
});

describe("Q39-migration-ledger/C27-migration-ledger (0128, 0129)", () => {
  const repo = repoMigrations();
  const good = { triggers: TRIGGERS.map((tgname) => ({ tgname, tgenabled: "A" })), constraint: { def: "CHECK ((table_name = ANY (ARRAY['raw_indicator_history'::text, 'regime_snapshots'::text, 'research_signals'::text, 'asset_prices'::text])))", validated: true } };
  test("the release's last two migrations are 0128 and 0129, both compat: additive", () => {
    expect(repo.slice(-2)).toEqual([MIGRATION, FRAMEWORK_MIGRATION]);
    for (const m of [MIGRATION, FRAMEWORK_MIGRATION]) expect(readFileSync(join(import.meta.dir, "../../../backend/migrations", m), "utf8").split("\n")[0]).toBe("-- compat: additive");
  });
  test("passes when 0128 is applied and its triggers and check are in place", () => {
    expect(captureProblems(repo, good)).toEqual([]);
  });
  test("red: 0128 not applied, a missing trigger, a trigger not ALWAYS, a check without asset_prices, a NOT VALID check, no check", () => {
    expect(captureProblems(repo.filter((m) => m !== MIGRATION), good).join()).toContain(`${MIGRATION} is not in schema_migrations`);
    expect(captureProblems(repo, { ...good, triggers: good.triggers.slice(1) }).join()).toContain(`no trigger ${TRIGGERS[0]}`);
    expect(captureProblems(repo, { ...good, triggers: good.triggers.map((t) => ({ ...t, tgenabled: "O" })) }).join()).toContain("not ALWAYS");
    expect(captureProblems(repo, { ...good, constraint: { def: "CHECK ((table_name = 'regime_snapshots'::text))", validated: true } }).join()).toContain("does not admit 'asset_prices'");
    expect(captureProblems(repo, { ...good, constraint: { ...good.constraint, validated: false } }).join()).toContain("NOT VALID");
    expect(captureProblems(repo, { triggers: good.triggers }).join()).toContain("has no analytics_overwrite_events_table_name_check");
  });
});

describe("Q39-migration-ledger/C27-migration-ledger: 0129's allocation framework (1547)", () => {
  const repo = repoMigrations();
  const row = (fw: typeof FRAMEWORK) => ({ asof: "2026-10-31", buckets: fw.map((b) => ({ id: b.id, name: b.id, target_weight: b.weight, items: b.items.map((id) => ({ id, name: id, target_weight: 1 / b.items.length })) })) });
  test("passes when 0129 is applied and the row is 50/7/29/14 with hard_assets", () => {
    expect(frameworkProblems(repo, row(FRAMEWORK))).toEqual([]);
  });
  test("red: 0129 not applied, the old agent_tokens framework, a wrong weight, no row", () => {
    expect(frameworkProblems(repo.filter((m) => m !== FRAMEWORK_MIGRATION), row(FRAMEWORK)).join()).toContain(`${FRAMEWORK_MIGRATION} is not in schema_migrations`);
    const old = FRAMEWORK.map((b) => (b.id === "hard_assets" ? { id: "agent_tokens", weight: 0.14, items: ["virtual"] } : b));
    expect(frameworkProblems(repo, row(old)).join()).toContain("agent_tokens=0.14");
    expect(frameworkProblems(repo, row(FRAMEWORK.map((b) => (b.id === "protocol_tokens" ? { ...b, weight: 0.1 } : b)))).join()).toContain("protocol_tokens=0.1");
    expect(frameworkProblems(repo, undefined).join()).toContain("no row id = 1");
  });
});

describe("Q41-public-surface/C29-public-surface (1546, 1549)", () => {
  const v070 = "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: https:; font-src 'self' data: https://fonts.gstatic.com; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'";
  const conf = readFileSync(join(import.meta.dir, "../../../website-server/nginx.conf"), "utf8");
  const shipped = /location \/ \{[\s\S]*?add_header Content-Security-Policy "([^"]+)"/.exec(conf)?.[1] ?? "";
  test("passes on the CSP the release's nginx.conf serves on /, and on a 401 from the health route", () => {
    expect(shipped).not.toBe("");
    expect(cspProblems(200, shipped)).toEqual([]);
    expect(healthProblems(401, "")).toEqual([]);
  });
  test("red: v0.7.0's CSP, no header, a non-200 site; the 404 of an api before 1549", () => {
    expect(cspProblems(200, v070).length).toBe(4);
    expect(cspProblems(200, null).join()).toContain("no Content-Security-Policy");
    expect(cspProblems(502, shipped).join()).toContain("answered 502");
    expect(healthProblems(404, "{}").join()).toContain("not 401");
  });
});

describe("Q40-research-series/C28-research-series (1524)", () => {
  const series = loadSeries();
  const rows = (f: (key: string, start: string) => KeyRow | undefined): KeyRow[] =>
    series.map((s) => f(storageKeyOf(s), expectedStart(s))).filter((r): r is KeyRow => r !== undefined);
  test("the inventory lists sixteen series, thirteen under their own id and three under an existing key", () => {
    expect(series.length).toBe(16);
    expect(series.filter((s) => storageKeyOf(s) !== s.id).map(storageKeyOf).sort()).toEqual(["research:BTC-USD", "research:QQQ"]);
    expect(series.every((s) => s.requestedStart === "2016-01-01")).toBe(true);
  });
  test("passes when every key holds versions from its expected start", () => {
    expect(seriesProblems(series, rows((k, start) => ({ source_key: k, earliest: start, versions: "100" })))).toEqual([]);
  });
  test("red: a key with no version, a key that starts at the old 2018 floor, an unread inventory", () => {
    const missing = rows((k, start) => (k === "yahoo:MSTR" ? undefined : { source_key: k, earliest: start, versions: "100" }));
    expect(seriesProblems(series, missing).join()).toContain("yahoo:MSTR: no dated version");
    const old = rows((k, start) => ({ source_key: k, earliest: k === "research:QQQ" ? "2018-01-02" : start, versions: "100" }));
    expect(seriesProblems(series, old).join()).toContain("the earliest dated version under research:QQQ is 2018-01-02");
    expect(seriesProblems([], []).join()).toContain("lists no series");
  });
});

describe("Q34b-archive-records/C22a-archive-records (1524, 1526)", () => {
  const ids = ["2026-09-22T000000Z", "2026-10-28T000000Z", LEGACY_JUNCTION.id, "2026-10-29T000000Z"];
  const record = enc({ format: 1, backup: "x" });
  const answer = (status: number, bytes: Uint8Array = enc(""), extra: Partial<Answer> = {}): Answer => ({ status, ms: 120, retryAfter: status === 503 ? "10" : null, xsha: status === 200 ? sha256Hex(bytes) : null, bytes, ...extra });
  const fake = (opts: { firstListing?: Answer; building?: number; recordStatus?: number; slowRecord?: boolean; listed?: string[] } = {}) => {
    const clock = { t: 0 };
    const seen = new Map<string, number>();
    let listings = 0;
    const deps: ArchiveDeps = {
      async get(path) {
        if (path.includes("/archive/backups")) {
          listings++;
          if (listings === 1 && opts.firstListing) return opts.firstListing;
          return answer(200, enc({ format: 1, backups: (opts.listed ?? ids).map((backup) => ({ backup })), nextCursor: null }));
        }
        const n = (seen.get(path) ?? 0) + 1;
        seen.set(path, n);
        if (opts.recordStatus) return answer(opts.recordStatus);
        if (n <= (opts.building ?? 1)) return answer(503, enc(""), { ms: 4_010 });
        return answer(200, record, opts.slowRecord ? { ms: BUDGET_MS + 1 } : {});
      },
      now: () => clock.t,
      sleep: async (ms) => { clock.t += ms; },
      log: () => {},
      recordWaitMs: 60_000,
    };
    return deps;
  };

  test("it builds the first, the junction and the newest record", () => {
    expect(chosenBackups(ids)).toEqual(["2026-09-22T000000Z", LEGACY_JUNCTION.id, "2026-10-29T000000Z"]);
    expect(chosenBackups(["2026-09-22T000000Z"])).toEqual(["2026-09-22T000000Z"]);
  });
  test("passes: a 200 listing under budget and three records that build after a 503 each", async () => {
    const r = await archiveRecords(fake());
    expect(archiveProblems(r)).toEqual([]);
    expect(r.records.map((x) => x.attempts.length)).toEqual([2, 2, 2]);
    expect(r.junctionListed).toBe(true);
  });
  test("red: a first listing the junction check failed, a slow request, a record that never builds, a refused record, a wrong hash, no junction", async () => {
    expect(archiveProblems(await archiveRecords(fake({ firstListing: answer(503, enc(""), { ms: 4_200 }) }))).join()).toContain("the junction check");
    expect(archiveProblems(await archiveRecords(fake({ firstListing: answer(200, enc({ backups: ids.map((backup) => ({ backup })), nextCursor: null }), { ms: 6_000 }) }))).join()).toContain("at or over the 5000 ms budget");
    expect(archiveProblems(await archiveRecords(fake({ slowRecord: true }))).join()).toContain("at or over the 5000 ms budget");
    expect(archiveProblems(await archiveRecords(fake({ building: 1_000 }))).join()).toContain("did not answer 200 within");
    expect(archiveProblems(await archiveRecords(fake({ recordStatus: 500 }))).join()).toContain("answered 500, neither 200 nor a 503");
    expect(archiveProblems(await archiveRecords(fake({ listed: ids.filter((i) => i !== LEGACY_JUNCTION.id) }))).join()).toContain(`legacy junction backup ${LEGACY_JUNCTION.id} is not listed`);
    const r = await archiveRecords(fake());
    const bad = { ...r, records: r.records.map((x) => ({ ...x, built: { ...x.built!, shaMatches: false, format: 2 } })) };
    expect(archiveProblems(bad).join()).toContain("carries format 2, not 1");
    expect(archiveProblems(bad).join()).toContain("is not the sha256 of the bytes");
  });
});

describe("the v0.7.1 runbook", () => {
  const runbook = loadReleaseRunbook("v0.7.1");
  const added = runbook.steps.filter((s) => s.added === "v0.7.1");
  test("it carries the load check and the archive, committed-inputs, migration, series and public-surface checks, each with a production twin", () => {
    expect(runbook.steps.some((s) => s.id === "Q34a-analytics-load")).toBe(true);
    expect(added.map((s) => s.id)).toEqual([
      "Q34b-archive-records", "Q38-committed-inputs", "Q39-migration-ledger", "Q40-research-series", "Q41-public-surface",
      "C22a-archive-records", "C26-committed-inputs", "C27-migration-ledger", "C28-research-series", "C29-public-surface",
    ]);
    for (const s of added) {
      const name = stepNameOf(s.id);
      expect(s.cmds[0]).toContain(name);
      expect(s.receipts[0]!.pattern).toBe(`version-check-${name}.json`);
      expect(readFileSync(join(import.meta.dir, "../../release/version-checks/v0.7.1", `${name}.ts`), "utf8")).toContain("satisfies VersionCheck");
    }
  });
  test("the archive records run before the SDK's archive routes, on stage after the load check", () => {
    const ids = runbook.steps.map((s) => s.id);
    expect(ids.indexOf("Q34b-archive-records")).toBe(ids.indexOf("Q34a-analytics-load") + 1);
    expect(ids.indexOf("Q35-archive-routes")).toBe(ids.indexOf("Q34b-archive-records") + 1);
    expect(ids.indexOf("C23-archive-routes")).toBe(ids.indexOf("C22a-archive-records") + 1);
  });
  test("no migration is breaking, so it declares none; every scope check is a step of the runbook", () => {
    expect(runbook.breaking).toBeUndefined();
    const ids = new Set(runbook.steps.map((s) => s.id));
    for (const e of runbook.scope) if (e.check) expect(ids.has(e.check)).toBe(true);
  });
});
