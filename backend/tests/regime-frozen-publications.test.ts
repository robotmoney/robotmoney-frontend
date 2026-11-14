// Issue 1182, decision D83: every past day serves the figure published that
// day, never a later run's recomputation, in both read modes. Read path only:
// the selection is made at read time from the frozen ledger
// (analytics_output_snapshots), with no migration and no rewrite of
// regime_snapshots, which still holds the newest run's rows.
//
// THE RULE. Day D's published figure is the D row of the last artifact written
// during D (UTC) that carries it; it updates while D is today and never after.
// A day nothing published during the day is published by the first artifact
// written after it (a late run, or a replay of issue 1162). For regime, from
// the ledger start only a run's own as-of row publishes a day, so a day no run
// with that as-of day published is a gap; days before the ledger start come
// from the first regime artifact.
//
// Every scenario is read through GET /api/dashboards/regime-snapshots's
// projection (fetchRegimeSnapshots) in BOTH read modes. Runs written on a past
// day are recorded with that created_at (support/regime-publications.ts); runs
// written now go through the production writer.
import { describe, expect, test } from "bun:test";
import { sql } from "../src/db/client.ts";
import { fixtureDb } from "./support/fixture-db.ts";
import { useCleanDatabasePerTest } from "./support/clean-db.ts";
import {
  ledgerCurrentRegimeSnapshots,
  ledgerCurrentResearchSignals,
  ledgerPublishedRegimeDays,
  selectPublications,
  type PublicationCandidate,
} from "../src/analytics/cutover/ledger-current.ts";
import { checkRegimeSnapshotsParity } from "../src/analytics/cutover/parity.ts";
import { saveRegimeSnapshots } from "../src/analytics/store/regime-store.ts";
import { persistResearchSignal } from "../src/analytics/store/research-store.ts";
import { fetchLatestResearchSignal, fetchRegimeSnapshots } from "../src/analytics/report/projections.ts";
import { loadReportSnapshot } from "../src/analytics/store/output-snapshot-store.ts";
import { handleSwarm } from "../src/api/routes/swarm.ts";
import { bearerHeaders, provisionAnalyticsToken } from "./support/automation-auth.ts";
import { runAnalytics } from "../src/analytics/index.ts";
import { directAnalyticsPersistence } from "../src/analytics/store/direct.ts";
import { noopTelemetrySink } from "../src/analytics/telemetry.ts";
import type { RegimeSnapshotRow } from "../src/analytics/report/regime-projection.ts";
import { ASOF as COMMITTED_ASOF, baseObservations, poisonedSource, secondObservations } from "./support/committed-inputs.ts";
import {
  admitReplayLabel,
  day,
  noon,
  publishNow,
  recordWrittenAt,
  regimeRow,
  researchSignal,
  servedComposites,
  setReadMode,
} from "./support/regime-publications.ts";

useCleanDatabasePerTest(import.meta.file);

/** Both read modes serve exactly `expected` (date → composite). */
async function expectServed(expected: Record<string, number>): Promise<void> {
  const compat = await servedComposites("compatibility");
  const ledger = await servedComposites("ledger");
  await setReadMode("compatibility");
  expect({ mode: "compatibility", served: compat }).toEqual({ mode: "compatibility", served: expected });
  expect({ mode: "ledger", served: ledger }).toEqual({ mode: "ledger", served: expected });
}

const tableComposite = async (date: string) => Number((await sql`SELECT composite FROM regime_snapshots WHERE date = ${date}`)[0]!.composite);

describe("Part A: the served history is the published one", () => {
  test("a past day serves its publishing run's as-of row; later runs that recompute it change nothing; a day nobody published is a gap", async () => {
    const [d0, d1, d2, gap, today] = [day(-4), day(-3), day(-2), day(-1), day(0)];
    // The first run of the database: published d1 on d1, and its history before it.
    await recordWrittenAt({ asof: d1, writtenAt: noon(d1), compat: true, regime: [regimeRow(d0, 0.30), regimeRow(d1, 0.31)] });
    // d2's run on d2 recomputed d0 and d1 with revised inputs.
    await recordWrittenAt({ asof: d2, writtenAt: noon(d2), compat: true, regime: [regimeRow(d0, 0.40), regimeRow(d1, 0.41), regimeRow(d2, 0.42)] });
    // No run on `gap`. Today: two runs, each recomputing every past day again.
    await publishNow({ asof: today, regime: [regimeRow(d0, 0.5), regimeRow(d1, 0.51), regimeRow(d2, 0.52), regimeRow(gap, 0.53), regimeRow(today, 0.54)] });
    await publishNow({ asof: today, regime: [regimeRow(d0, 0.6), regimeRow(d1, 0.61), regimeRow(d2, 0.62), regimeRow(gap, 0.63), regimeRow(today, 0.64)] });

    // Not vacuous: the compatibility table holds the newest run's recomputation of every day.
    expect([await tableComposite(d0), await tableComposite(d1), await tableComposite(d2), await tableComposite(gap)]).toEqual([0.6, 0.61, 0.62, 0.63]);

    await expectServed({ [d0]: 0.30, [d1]: 0.31, [d2]: 0.42, [today]: 0.64 });
    expect(await ledgerPublishedRegimeDays()).toEqual([d0, d1, d2, today]);
    // The parity sweep still checks the compatibility table against its own semantics (last write wins).
    expect((await checkRegimeSnapshotsParity()).matched).toBe(true);
  });

  test("the current day shows the newest run's figure until the day is over, then it is frozen", async () => {
    const [y, today] = [day(-1), day(0)];
    // Yesterday, while it was the current day: two runs, the later one wins.
    await recordWrittenAt({ asof: y, writtenAt: `${y}T08:00:00Z`, regime: [regimeRow(y, 0.2)] });
    await recordWrittenAt({ asof: y, writtenAt: `${y}T20:00:00Z`, regime: [regimeRow(y, 0.25)] });
    // Today: each new run replaces today's figure.
    await publishNow({ asof: today, regime: [regimeRow(y, 0.8), regimeRow(today, 0.7)] });
    await expectServed({ [y]: 0.25, [today]: 0.7 });
    await publishNow({ asof: today, regime: [regimeRow(y, 0.85), regimeRow(today, 0.75)] });
    await expectServed({ [y]: 0.25, [today]: 0.75 });
    // Yesterday is over: a run written today with yesterday's as-of day changes nothing.
    await publishNow({ asof: y, regime: [regimeRow(y, 0.9, "risk_off")] });
    await expectServed({ [y]: 0.25, [today]: 0.75 });
    expect(await tableComposite(y)).toBe(0.9); // the table took it; readers are not served it
    const { latest } = await fetchRegimeSnapshots(10);
    expect(latest?.date).toBe(today);
  });

  test("a day nothing published during it is published by the first run written after it, and frozen from then on", async () => {
    const [late, today] = [day(-2), day(0)];
    await recordWrittenAt({ asof: day(-3), writtenAt: noon(day(-3)), regime: [regimeRow(day(-3), 0.1)] });
    // No run succeeded during `late`; the first run after the outage, written the next day, publishes it.
    await recordWrittenAt({ asof: late, writtenAt: noon(day(-1)), regime: [regimeRow(late, 0.33)] });
    await publishNow({ asof: late, regime: [regimeRow(late, 0.44)] });
    await publishNow({ asof: today, regime: [regimeRow(late, 0.55), regimeRow(today, 0.5)] });
    await expectServed({ [day(-3)]: 0.1, [late]: 0.33, [today]: 0.5 });
  });

  test("a replay run (source_label 'replay') publishes a day no live run published, and no later run, live or replay, replaces it or a live publication", async () => {
    await admitReplayLabel();
    const [h, g, today] = [day(-3), day(-2), day(0)];
    // h: a live publication during h. g: no live success.
    await recordWrittenAt({ asof: h, writtenAt: noon(h), regime: [regimeRow(h, 0.1)] });
    // The replay of g, written today (issue 1162).
    await publishNow({ asof: g, sourceLabel: "replay", regime: [regimeRow(h, 0.7), regimeRow(g, 0.25)] });
    // A later live run recomputes both; a later replay and a late live run for g follow.
    await publishNow({ asof: today, regime: [regimeRow(h, 0.8), regimeRow(g, 0.35), regimeRow(today, 0.5)] });
    await publishNow({ asof: g, sourceLabel: "replay", regime: [regimeRow(g, 0.45)] });
    await publishNow({ asof: g, sourceLabel: "live", regime: [regimeRow(h, 0.9), regimeRow(g, 0.55)] });

    const labels = await fixtureDb<{ source_label: string }[]>`SELECT source_label FROM analytics_ledger_runs WHERE asof = ${g} ORDER BY id`;
    expect(labels.map((r) => r.source_label)).toEqual(["replay", "replay", "live"]);
    const ledger = Object.fromEntries((await ledgerCurrentRegimeSnapshots()).map((r) => [r.date, r.composite]));
    expect(ledger).toEqual({ [h]: 0.1, [g]: 0.25, [today]: 0.5 });
    await expectServed({ [h]: 0.1, [g]: 0.25, [today]: 0.5 });
  });

  test("days before the ledger start are served from the first run that carries them and never change afterwards", async () => {
    const pre = [day(-30), day(-29), day(-28)];
    const [start, today] = [day(-2), day(0)];
    await recordWrittenAt({ asof: start, writtenAt: noon(start), regime: [...pre.map((d, i) => regimeRow(d, 0.11 + i / 100)), regimeRow(start, 0.2)] });
    await expectServed({ [pre[0]!]: 0.11, [pre[1]!]: 0.12, [pre[2]!]: 0.13, [start]: 0.2 });
    // Later runs recompute every one of those days.
    await publishNow({ asof: today, regime: [...pre.map((d) => regimeRow(d, 0.9)), regimeRow(start, 0.4), regimeRow(today, 0.5)] });
    await publishNow({ asof: today, regime: [...pre.map((d) => regimeRow(d, 0.95)), regimeRow(start, 0.45), regimeRow(today, 0.55)] });
    await expectServed({ [pre[0]!]: 0.11, [pre[1]!]: 0.12, [pre[2]!]: 0.13, [start]: 0.2, [today]: 0.55 });
  });

  test("an artifact whose natural_keys is NULL is not taken as publishing nothing: its payload decides", async () => {
    const [d1, y, today] = [day(-3), day(-1), day(0)];
    // A string holding U+0000 is valid JSON but not a valid jsonb, so migration
    // 0123's rm_analytics_output_natural_keys returns NULL for these payloads.
    const unindexable = (row: RegimeSnapshotRow): RegimeSnapshotRow => ({ ...row, version: "v\u0000nul" });
    await recordWrittenAt({ asof: d1, writtenAt: noon(d1), regime: [unindexable(regimeRow(day(-4), 0.05)), unindexable(regimeRow(d1, 0.1))] });
    await recordWrittenAt({ asof: y, writtenAt: noon(y), regime: [unindexable(regimeRow(d1, 0.15)), unindexable(regimeRow(y, 0.2))] });
    await publishNow({ asof: today, regime: [regimeRow(y, 0.8), regimeRow(today, 0.3)] });
    const nulled = await fixtureDb<{ n: number }[]>`
      SELECT count(*)::int AS n FROM analytics_output_snapshots WHERE artifact_kind = 'regime_snapshots' AND natural_keys IS NULL`;
    expect(nulled[0]!.n).toBe(2); // not vacuous: both of those artifacts have no index
    await expectServed({ [day(-4)]: 0.05, [d1]: 0.1, [y]: 0.2, [today]: 0.3 });
  });
});

describe("Part A: the selection rule, pure", () => {
  const c = (key: string, runId: number, writtenOn: string): PublicationCandidate => ({ key, date: key, runId, artifactId: runId, writtenOn });
  test("the last artifact written during the day wins; else the first written after it; run order breaks ties", () => {
    const chosen = selectPublications([
      c("2026-09-26", 121, "2026-09-26"), c("2026-09-26", 128, "2026-09-26"), c("2026-09-26", 300, "2026-09-30"),
      c("2026-09-28", 243, "2026-09-29"), c("2026-09-28", 249, "2026-09-30"),
      c("2026-09-21", 20, "2026-09-21"), c("2026-09-21", 65, "2026-09-24"),
    ]);
    expect(Object.fromEntries([...chosen].map(([k, v]) => [k, v.runId]))).toEqual({ "2026-09-26": 128, "2026-09-28": 243, "2026-09-21": 20 });
  });
});

describe("Part A: through the production pipeline", () => {
  test("a run that revises a past day's inputs does not change what the endpoint returns for that day", async () => {
    const base = await baseObservations();
    await directAnalyticsPersistence.saveRawHistory({ MNA: base.mna }, "fixture");
    const next = "2026-08-16"; // the day after COMMITTED_ASOF
    const published: Record<string, RegimeSnapshotRow[]> = {};
    for (const [asof, obs] of [[COMMITTED_ASOF, base], [next, secondObservations(base)]] as const) {
      const source = poisonedSource(obs, 3);
      try {
        await runAnalytics(asof, undefined, source, {
          ...directAnalyticsPersistence,
          async submitTerminalRunPackage(input) {
            published[asof] = input.regimeSnapshots ?? [];
            return directAnalyticsPersistence.submitTerminalRunPackage(input);
          },
        }, noopTelemetrySink);
      } finally {
        source.restore();
      }
    }
    const first = published[COMMITTED_ASOF]!.find((r) => r.date === COMMITTED_ASOF)!;
    const recomputed = published[next]!.find((r) => r.date === COMMITTED_ASOF)!;
    // Not vacuous: the second run's revised T10Y2Y moved its figure for the first run's day.
    expect(recomputed.composite).not.toBe(first.composite);
    expect(await tableComposite(COMMITTED_ASOF)).toBe(recomputed.composite!);
    const latest = published[next]!.at(-1)!;
    expect(latest.date).toBe(next);
    for (const mode of ["compatibility", "ledger"] as const) {
      const served = await servedComposites(mode, 5000);
      expect({ mode, day: served[COMMITTED_ASOF], next: served[next] }).toEqual({ mode, day: first.composite, next: latest.composite });
    }
    await setReadMode("compatibility");
  }, 600_000);
});

describe("Part A: no writer can change a past day's served figure", () => {
  test("the store writer, a direct runtime UPDATE of regime_snapshots and the provider's swarm door all leave a published past day as served", async () => {
    const [y, gap, today] = [day(-2), day(-1), day(0)];
    await recordWrittenAt({ asof: y, writtenAt: noon(y), compat: true, regime: [regimeRow(y, 0.2)] });
    await publishNow({ asof: today, regime: [regimeRow(y, 0.2), regimeRow(today, 0.3)] });

    await saveRegimeSnapshots([regimeRow(y, 0.77), regimeRow(gap, 0.66)]);
    await sql`UPDATE regime_snapshots SET composite = 0.88 WHERE date = ${y}`;
    expect(await tableComposite(y)).toBe(0.88); // not vacuous: the table row really changed
    const token = await provisionAnalyticsToken();
    const res = await handleSwarm(
      new Request("http://x/api/swarm/regime", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...bearerHeaders(token) },
        body: JSON.stringify({ snapshots: [regimeRow(y, 0.99), regimeRow(gap, 0.44)] }),
      }),
      new URL("http://x/api/swarm/regime"),
    );
    // The door refuses a day the ledger selection publishes, with no write (folded-in issue 999).
    expect(res!.status).toBe(409);
    expect(res!.body).toMatchObject({ dates: [y] });
    expect(await tableComposite(y)).toBe(0.88);

    await expectServed({ [y]: 0.2, [today]: 0.3 });
  });
});

// Part C: every report surface served to readers, held to the same rule. Each
// entry publishes a figure for a past day, lets a later run (written after the
// day) publish a different one for the same day, and reads the surface in both
// read modes where it has two.
const REPORT_SURFACES: { surface: string; check: () => Promise<void> }[] = [
  {
    surface: "regime history: GET /api/dashboards/regime-snapshots",
    async check() {
      const y = day(-1);
      await recordWrittenAt({ asof: y, writtenAt: noon(y), compat: true, regime: [regimeRow(y, 0.2)] });
      await publishNow({ asof: y, regime: [regimeRow(y, 0.6)] });
      expect(await tableComposite(y)).toBe(0.6);
      await expectServed({ [y]: 0.2 });
    },
  },
  {
    surface: "research signals: GET /api/dashboards/research-signals/:key",
    async check() {
      const y = day(-1);
      await recordWrittenAt({ asof: y, writtenAt: noon(y), compat: true, research: [researchSignal("channel-divergence", y, "published")] });
      await publishNow({ asof: y, research: [researchSignal("channel-divergence", y, "recomputed")] });
      // Not vacuous: the compatibility table holds the later recomputation.
      const [row] = await sql<{ title: string }[]>`SELECT payload ->> 'title' AS title FROM research_signals WHERE signal_key = 'channel-divergence' AND date = ${y}`;
      expect(row!.title).toBe("recomputed");
      for (const mode of ["compatibility", "ledger"] as const) {
        await setReadMode(mode);
        const signal = await fetchLatestResearchSignal("channel-divergence");
        expect({ mode, date: signal?.date, title: (signal?.payload as { title?: string } | undefined)?.title }).toEqual({ mode, date: y, title: "published" });
      }
      await setReadMode("compatibility");
      expect((await ledgerCurrentResearchSignals()).map((s) => (s.payload as unknown as { title: string }).title)).toEqual(["published"]);
      // The current day still updates.
      const today = day(0);
      await publishNow({ asof: today, research: [researchSignal("channel-divergence", today, "first")] });
      await publishNow({ asof: today, research: [researchSignal("channel-divergence", today, "second")] });
      expect(((await fetchLatestResearchSignal("channel-divergence"))?.payload as { title?: string }).title).toBe("second");
    },
  },
  {
    surface: "report snapshots: GET /api/analytics/report-snapshots/:id and GET /api/public/analytics/reports",
    async check() {
      const y = day(-1);
      const first = await publishNow({ asof: y, regime: [regimeRow(y, 0.2)] });
      const before = await loadReportSnapshot(first.reportSnapshotId);
      const later = await publishNow({ asof: y, regime: [regimeRow(y, 0.6)] });
      expect(later.reportSnapshotId).not.toBe(first.reportSnapshotId);
      const after = await loadReportSnapshot(first.reportSnapshotId);
      expect(after!.checksum).toBe(before!.checksum);
      expect(Buffer.from(after!.bytes).toString("utf8")).toBe(`report ${first.runId} ${y}`);
    },
  },
];

describe("Part C: every report surface serves the frozen publication for a past day", () => {
  for (const { surface, check } of REPORT_SURFACES) {
    test(surface, check);
  }
});

describe("compatibility mode on a database no run has written", () => {
  test("serves regime_snapshots and research_signals as before", async () => {
    const y = day(-1);
    await saveRegimeSnapshots([regimeRow(y, 0.42)]);
    await persistResearchSignal("breadth", y, { asof: y, title: "seeded" } as never);
    await setReadMode("compatibility");
    const r = await fetchRegimeSnapshots(10);
    expect({ source: r.source, history: r.history.map((h) => [h.date, h.composite]) }).toEqual({ source: "regime_snapshots", history: [[y, 0.42]] });
    expect(((await fetchLatestResearchSignal("breadth"))?.payload as { title?: string }).title).toBe("seeded");
  });
});
