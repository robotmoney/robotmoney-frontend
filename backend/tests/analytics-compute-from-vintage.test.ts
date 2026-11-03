// AN-16 (owner decision, issue 1532): a regime run computes from exactly the
// values its frozen vintage pins. The run reads the ledger heads at one
// database-clock cutoff, after every acquisition, computes the registry and
// the backtest extras from them, and freezes its vintage at that same cutoff.
//
// The corrupting sequence the review named: a seed writes S for a date, the
// ledger's first provider observation F is within the D56 tolerance of S, so
// the raw floor keeps S while the ledger head (and the vintage) holds F. The
// run must compute from F. The seed paths now record ledger rows too, so the
// raw-only write below stands in for a seed made before this change.
import { describe, expect, test } from "bun:test";
import { ROUTES } from "@robotmoney/contract";
import { sql } from "../src/db/client.ts";
import { runAnalytics } from "../src/analytics/index.ts";
import { directAnalyticsPersistence } from "../src/analytics/store/direct.ts";
import { loadRawIndicatorHistory, saveRawIndicatorHistory } from "../src/analytics/store/raw-history-store.ts";
import {
  REGIME_STORAGE_KEYS,
  beginRun,
  freezeVintage,
  loadCommittedInputs,
  loadFrozenVintage,
  loadHistoricalSourceValues,
} from "../src/analytics/store/run-ledger-store.ts";
import { saveSourceAcquisition } from "../src/analytics/store/source-ledger-store.ts";
import { handleAnalytics } from "../src/api/routes/analytics.ts";
import { noopTelemetrySink } from "../src/analytics/telemetry.ts";
import { INDICATORS } from "../src/analytics/analyze/indicators.ts";
import { STORED_UNDER, inputHistoryFromStorage, storedIndicatorId } from "../src/analytics/extras.ts";
import { withinTolerance } from "../src/analytics/source-tolerance.ts";
import type { AnalyticsPersistence, CommittedInputs } from "../src/analytics/persistence.ts";
import type { TerminalRunPackageInput } from "../src/analytics/output-snapshots.ts";
import { useCleanDatabasePerTest } from "./support/clean-db.ts";
import { provisionAnalyticsToken } from "./support/automation-auth.ts";
import { ASOF, baseObservations, poisonedSource, type Observations } from "./support/committed-inputs.ts";

useCleanDatabasePerTest(import.meta.file);

interface Captured {
  committed: CommittedInputs[];
  freezeCutoffs: string[];
  packages: TerminalRunPackageInput[];
}

function capturing(): { persistence: AnalyticsPersistence; seen: Captured } {
  const seen: Captured = { committed: [], freezeCutoffs: [], packages: [] };
  const d = directAnalyticsPersistence;
  return {
    seen,
    persistence: {
      ...d,
      async loadCommittedInputs(asof) {
        const c = await d.loadCommittedInputs!(asof);
        seen.committed.push(c);
        return c;
      },
      async freezeVintage(input) {
        seen.freezeCutoffs.push(input.knowledgeTimeCutoff);
        return d.freezeVintage(input);
      },
      async submitTerminalRunPackage(input) {
        seen.packages.push(input);
        return d.submitTerminalRunPackage(input);
      },
    },
  };
}

async function run(obs: Observations) {
  const { persistence, seen } = capturing();
  const source = poisonedSource(obs, 2);
  try {
    const results = await runAnalytics(ASOF, "regime", source, persistence, noopTelemetrySink);
    const vintageId = (results as { __runLedger?: { vintage: { vintageId: string } | null } }).__runLedger!.vintage!.vintageId;
    return { seen, vintageId };
  } finally {
    source.restore();
  }
}

describe("AN-16: the regime computes from the ledger heads its vintage pins", () => {
  test("raw holds S, the ledger head holds F within tolerance: the run computes F, the vintage pins F, at the cutoff the compute read", async () => {
    const base = await baseObservations();
    const vix = base.registry.VIX!.filter((p) => p.date <= ASOF);
    const d = vix.at(-1)!.date;
    const S = vix.at(-1)!.value;
    const F = S * (1 + 5e-7);
    expect(F).not.toBe(S);
    expect(withinTolerance("raw_indicator_history:VIX", S, F)).toBe(true);

    // A raw-only seed of S, as the floor and EDGAR seeds wrote before AN-16.
    await saveRawIndicatorHistory({ VIX: [{ date: d, value: S }] }, sql, "seed");
    const obs: Observations = { ...base, registry: { ...base.registry, VIX: base.registry.VIX!.map((p) => (p.date === d ? { date: d, value: F } : p)) } };
    const { seen, vintageId } = await run(obs);

    // The two stores disagree for d, within tolerance.
    expect((await loadRawIndicatorHistory()).VIX!.find((p) => p.date === d)!.value).toBe(S);
    // The compute read F.
    expect(seen.committed).toHaveLength(1);
    const read = seen.committed[0]!.values.find((v) => v.sourceKey === "raw_indicator_history:VIX" && v.marketDate === d)!;
    expect(read.value).toBe(F);
    // The published as-of row reports F as VIX's latest raw value.
    const asofRow = seen.packages[0]!.regimeSnapshots!.at(-1)!;
    const vixRow = (asofRow.indicators as { id: string; raw_value: number | null; raw_date: string | null }[]).find((i) => i.id === "VIX")!;
    expect(vixRow.raw_date).toBe(d);
    expect(vixRow.raw_value).toBe(F);
    // The vintage pins the same version and value.
    const vintage = (await loadFrozenVintage(vintageId))!;
    const member = vintage.members.find((m) => m.sourceKey === "raw_indicator_history:VIX" && m.marketDate === d)!;
    expect(member.versionId).toBe(read.versionId);
    expect(member.value).toBe(F);
    // One cutoff: what the compute read is what the vintage stores, to the microsecond.
    expect(seen.freezeCutoffs).toEqual([seen.committed[0]!.knowledgeTimeCutoff]);
    const [{ same }] = await sql<{ same: boolean }[]>`
      SELECT knowledge_time_cutoff = ${seen.committed[0]!.knowledgeTimeCutoff}::timestamptz AS same
      FROM analytics_data_vintages WHERE id = ${vintageId}::bigint`;
    expect(same).toBe(true);
    // Every value the compute read is a vintage member, unchanged.
    const pinned = new Map(vintage.members.map((m) => [m.versionId, m.value]));
    for (const v of seen.committed[0]!.values) expect(pinned.get(v.versionId)).toBe(v.value);
  }, 300_000);

  test("with no injected mismatch the ledger-head registry equals the raw floor for every (indicator, date)", async () => {
    const { seen } = await run(await baseObservations());
    const fromLedger = inputHistoryFromStorage(seen.committed[0]!.values);
    const floor = await loadRawIndicatorHistory();
    let compared = 0;
    for (const ind of INDICATORS) {
      if (Object.hasOwn(STORED_UNDER, ind.id)) continue;
      const raw = (floor[storedIndicatorId(ind.id)] ?? []).filter((p) => p.date <= ASOF);
      expect(fromLedger[ind.id] ?? [], ind.id).toEqual(raw);
      compared += raw.length;
    }
    expect(compared).toBeGreaterThan(10_000);
  }, 300_000);

  test("a raw-history seed POST records one source_value_versions row per written point, and a repeat records none", async () => {
    const token = await provisionAnalyticsToken();
    const id = `T_${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
    const points = [{ date: "2020-01-01", value: 1.5 }, { date: "2020-01-02", value: 2.5 }, { date: "2020-01-03", value: 3.5 }];
    const post = () =>
      handleAnalytics(
        new Request(`http://x${ROUTES.analytics.rawHistorySeed}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ history: { [id]: points } }),
        }),
        new URL(`http://x${ROUTES.analytics.rawHistorySeed}`),
      );
    const first = await post();
    expect(first?.status).toBe(200);
    expect((first!.body as { seededPoints: number }).seededPoints).toBe(3);
    const rows = () => sql<{ market_date: string; value: number; provenance: string | null }[]>`
      SELECT market_date::text AS market_date, value, provenance FROM source_value_versions
      WHERE source_key = ${`raw_indicator_history:${id}`} ORDER BY market_date`;
    expect((await rows()).map((r) => ({ date: r.market_date, value: Number(r.value), provenance: r.provenance }))).toEqual(
      points.map((p) => ({ ...p, provenance: "seed" })),
    );
    const second = await post();
    expect((second!.body as { seededPoints: number }).seededPoints).toBe(0);
    expect(await rows()).toHaveLength(3);
  });

  test("GET committed-inputs answers the database clock and the ledger heads dated on or before asof", async () => {
    const token = await provisionAnalyticsToken();
    await run(await baseObservations());
    const get = (q: string) => {
      const url = `http://x${ROUTES.analytics.committedInputs}${q}`;
      return handleAnalytics(new Request(url, { headers: { Authorization: `Bearer ${token}` } }), new URL(url));
    };
    expect((await get(""))?.status).toBe(400);
    expect((await get("?asof=2026-02-30"))?.status).toBe(400);
    const res = await get(`?asof=${ASOF}`);
    expect(res?.status).toBe(200);
    const body = res!.body as CommittedInputs;
    expect(Date.parse(body.knowledgeTimeCutoff)).not.toBeNaN();
    expect(body.knowledgeTimeCutoff).toMatch(/\.\d{6}Z$/);
    expect(body.values.length).toBeGreaterThan(0);
    expect(body.values.every((v) => v.marketDate <= ASOF)).toBe(true);
    expect(new Set(body.values.map((v) => v.sourceKey)).has("backtest:^GSPC")).toBe(true);
  }, 300_000);
});

// Issue 1534 (review-data-integrity-001, the regime part of AN-17): a ledger
// writer that INSERTs a row before the committed read and COMMITs after it.
// knowledge_time is the INSERT clock, so the row sits below the read's cutoff
// yet the read could not see it. A freeze that re-selects by the cutoff pins
// it; a freeze from the read's versionIds does not.
const VIX_KEY = "raw_indicator_history:VIX";
const REGIME_KEYS = new Set(REGIME_STORAGE_KEYS);

function racingEvidence(sourceKey: string, marketDate: string, value: number) {
  return {
    id: crypto.randomUUID(), provider: "fixture", parserVersion: "fixture:1", cacheIdentity: "race-1534",
    requestedByRunId: null, events: [], fetches: [],
    values: [{ sourceKey, marketDate, marketInstant: null, value, provenance: "seed" }],
  };
}

/** Record `evidence` on a second connection, run `read` while it is uncommitted, then COMMIT. */
async function readDuringUncommittedInsert<T>(
  evidence: ReturnType<typeof racingEvidence>,
  read: () => Promise<T>,
): Promise<{ result: T; racingId: string }> {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let inserted!: (id: string) => void;
  const ready = new Promise<string>((r) => (inserted = r));
  const racer = sql.begin(async (tx) => {
    const saved = await saveSourceAcquisition(evidence, tx);
    inserted(saved.committed![0]!.versionId);
    await gate;
  });
  // A racer that fails before inserting rejects here instead of hanging the test.
  const racingId = await Promise.race([ready, racer.then(() => ready)]);
  // postgres.js binds a timestamptz parameter through a JS Date (millisecond
  // precision), so cutoff selection compares at the millisecond: keep the
  // racing row's knowledge_time a clear millisecond below the read's clock.
  await Bun.sleep(5);
  try {
    return { result: await read(), racingId };
  } finally {
    release();
    await racer;
  }
}

async function racingRun(sendIds: boolean) {
  const base = await baseObservations();
  const vix = base.registry.VIX!.filter((p) => p.date <= ASOF).at(-1)!;
  const seen = { committed: [] as CommittedInputs[], freezeIds: [] as (readonly string[] | undefined)[], racingId: "" };
  const d = directAnalyticsPersistence;
  const persistence: AnalyticsPersistence = {
    ...d,
    async loadCommittedInputs(asof) {
      const { result, racingId } = await readDuringUncommittedInsert(racingEvidence(VIX_KEY, vix.date, vix.value * 2), () => d.loadCommittedInputs!(asof));
      seen.committed.push(result);
      seen.racingId = racingId;
      return result;
    },
    async freezeVintage(input) {
      seen.freezeIds.push(input.regimeVersionIds);
      if (sendIds) return d.freezeVintage(input);
      const { regimeVersionIds: _dropped, ...withoutIds } = input;
      return d.freezeVintage(withoutIds);
    },
  };
  const source = poisonedSource(base, 2);
  try {
    const results = await runAnalytics(ASOF, "regime", source, persistence, noopTelemetrySink);
    const vintageId = (results as { __runLedger?: { vintage: { vintageId: string } | null } }).__runLedger!.vintage!.vintageId;
    const vintage = (await loadFrozenVintage(vintageId))!;
    const [{ racing_known }] = await sql<{ racing_known: boolean }[]>`
      SELECT v.knowledge_time <= d.knowledge_time_cutoff AS racing_known
      FROM source_value_versions v, analytics_data_vintages d
      WHERE v.id = ${seen.racingId}::bigint AND d.id = ${vintageId}::bigint`;
    return { seen, vintage, racingKnown: racing_known, coordinate: vix };
  } finally {
    source.restore();
  }
}

describe("issue 1534: the vintage freezes the exact versions the regime read", () => {
  test("a head inserted before the cutoff and committed after the read is not a member; the regime-key members are the read's versionIds", async () => {
    const { seen, vintage, racingKnown } = await racingRun(true);
    expect(seen.committed).toHaveLength(1);
    const readIds = seen.committed[0]!.values.map((v) => v.versionId);
    expect(seen.freezeIds).toEqual([readIds]);
    // The race was hit: the racing row is dated below the vintage's cutoff, and the read did not see it.
    expect(racingKnown).toBe(true);
    expect(readIds).not.toContain(seen.racingId);
    const regimeMembers = vintage.members.filter((m) => REGIME_KEYS.has(m.sourceKey)).map((m) => m.versionId);
    expect(new Set(regimeMembers)).toEqual(new Set(readIds));
    expect(regimeMembers).toHaveLength(readIds.length);
    expect(vintage.members.map((m) => m.versionId)).not.toContain(seen.racingId);
  }, 300_000);

  test("red control: the same interleaving frozen by cutoff selection (no regimeVersionIds) pins the racing row", async () => {
    const { seen, vintage, racingKnown } = await racingRun(false);
    expect(racingKnown).toBe(true);
    expect(seen.committed[0]!.values.map((v) => v.versionId)).not.toContain(seen.racingId);
    expect(vintage.members.map((m) => m.versionId)).toContain(seen.racingId);
  }, 300_000);

  test("store level: freezeVintage with the read's cutoff and versionIds pins those ids under regime keys and the cutoff selection elsewhere, and replays its digest", async () => {
    const asof = "2024-01-10";
    const series = (key: string, scale: number) =>
      saveSourceAcquisition({
        ...racingEvidence(key, "2024-01-01", 0),
        values: Array.from({ length: 5 }, (_, i) => ({
          sourceKey: key, marketDate: `2024-01-0${i + 1}`, marketInstant: null, value: (i + 1) * scale, provenance: "seed",
        })),
      });
    await series(VIX_KEY, 10);
    await series("research:QQQ", 3);
    expect(REGIME_KEYS.has("research:QQQ")).toBe(false);

    const { result: committed, racingId } = await readDuringUncommittedInsert(
      racingEvidence(VIX_KEY, "2024-01-05", 999),
      () => loadCommittedInputs(REGIME_STORAGE_KEYS, asof),
    );
    const readIds = committed.values.map((v) => v.versionId);
    expect(readIds).toHaveLength(5);
    expect(readIds).not.toContain(racingId);

    const { runId, methodologyVersionId } = await beginRun({
      runKey: crypto.randomUUID(), asof, toolId: "race-1534", sourceLabel: "fixture",
      methodology: { toolId: "race-1534", versionLabel: "v-test", config: { test: "1534" } },
      buildIdentity: "race-1534-build",
    });
    const frozen = await freezeVintage({
      runId, toolId: "race-1534", knowledgeTimeCutoff: committed.knowledgeTimeCutoff, marketTimeCutoff: asof,
      methodologyVersionId, buildIdentity: "race-1534-build", regimeVersionIds: readIds,
    });
    const vintage = (await loadFrozenVintage(frozen.vintageId))!;
    expect(vintage.manifestDigest).toBe(frozen.manifest.manifestDigest);
    const regime = vintage.members.filter((m) => REGIME_KEYS.has(m.sourceKey)).map((m) => m.versionId);
    expect(new Set(regime)).toEqual(new Set(readIds));
    expect(regime).not.toContain(racingId);
    const byCutoff = await loadHistoricalSourceValues(committed.knowledgeTimeCutoff, asof);
    // The racing row is under the cutoff: a re-selection would have pinned it.
    expect(byCutoff.map((m) => m.versionId)).toContain(racingId);
    const others = vintage.members.filter((m) => !REGIME_KEYS.has(m.sourceKey)).map((m) => m.versionId).sort();
    expect(others).toEqual(byCutoff.filter((m) => !REGIME_KEYS.has(m.sourceKey)).map((m) => m.versionId).sort());
    expect(others).toHaveLength(5);
    expect(vintage.memberCount).toBe(10);
  });
});
