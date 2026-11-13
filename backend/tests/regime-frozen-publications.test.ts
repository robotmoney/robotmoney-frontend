// Issue 1182, decision D83: every past day serves the figure published that
// day, never a later run's recomputation, in both read modes.
//
// THE RULE. Day D's published figure is the as-of-D row of the last run with
// as-of D written on or before D (UTC); it updates while D is the current day
// and never after. A run written after D (a replay, or a late run) publishes D
// only when nothing was published during D, and the first such run does. A day
// after the ledger start that no run with that as-of day published is a gap.
// Days before the ledger start are frozen at cut-over (migration 0132's
// regime_publication_baseline).
//
// Every scenario is read through GET /api/dashboards/regime-snapshots's
// projection (fetchRegimeSnapshots) in BOTH read modes, and the two must agree
// with each other and with the parity sweep. Runs written on a past day are
// recorded with that created_at (support/regime-publications.ts); runs written
// now go through the production writer.
import { describe, expect, test } from "bun:test";
import { sql } from "../src/db/client.ts";
import { fixtureDb } from "./support/fixture-db.ts";
import { useCleanDatabasePerTest } from "./support/clean-db.ts";
import { ledgerCurrentRegimeSnapshots, ledgerCurrentResearchSignals } from "../src/analytics/cutover/ledger-current.ts";
import { checkRegimeSnapshotsParity, checkResearchSignalsParity } from "../src/analytics/cutover/parity.ts";
import { saveRegimeSnapshots, PUBLISHING_DAY_GUARD } from "../src/analytics/store/regime-store.ts";
import { persistResearchSignal } from "../src/analytics/store/research-store.ts";
import { fetchLatestResearchSignal } from "../src/analytics/report/projections.ts";
import { loadReportSnapshot } from "../src/analytics/store/output-snapshot-store.ts";
import { handleSwarm } from "../src/api/routes/swarm.ts";
import { registeredSites } from "../src/db/registry.ts";
import "../src/swarm/domain.ts";
import { bearerHeaders, provisionAnalyticsToken } from "./support/automation-auth.ts";
import { runAnalytics } from "../src/analytics/index.ts";
import { directAnalyticsPersistence } from "../src/analytics/store/direct.ts";
import { noopTelemetrySink } from "../src/analytics/telemetry.ts";
import type { RegimeSnapshotRow } from "../src/analytics/report/regime-projection.ts";
import { ASOF as COMMITTED_ASOF, baseObservations, poisonedSource, secondObservations } from "./support/committed-inputs.ts";
import {
  applyMigration0132,
  day,
  publishNow,
  recordWrittenAt,
  regimeRow,
  researchSignal,
  servedComposites,
  withoutPublicationGuards,
} from "./support/regime-publications.ts";

useCleanDatabasePerTest(import.meta.file);

const noon = (d: string) => `${d}T12:00:00Z`;

/** Both read modes serve exactly `expected` (date → composite), and agree with the parity sweep. */
async function expectServed(expected: Record<string, number>): Promise<void> {
  const compat = await servedComposites("compatibility");
  const ledger = await servedComposites("ledger");
  await fixtureDb`UPDATE analytics_read_mode SET mode = 'compatibility', updated_by = 'issue-1182-test' WHERE id = true`;
  expect({ mode: "compatibility", served: compat }).toEqual({ mode: "compatibility", served: expected });
  expect({ mode: "ledger", served: ledger }).toEqual({ mode: "ledger", served: expected });
  const parity = await checkRegimeSnapshotsParity();
  expect(parity.mismatches).toEqual([]);
  expect(parity.matched).toBe(true);
}

describe("Part A: the served history is the published one", () => {
  test("a past day serves its publishing run's as-of row; a later run that recomputes it changes nothing; the current day updates; a day nobody published is a gap", async () => {
    const [d0, d1, d2, gap, today] = [day(-4), day(-3), day(-2), day(-1), day(0)];
    // The first run of the database: published d1 on d1, and its history before it.
    await recordWrittenAt({ asof: d1, writtenAt: noon(d1), compat: true, regime: [regimeRow(d0, 0.30), regimeRow(d1, 0.31)] });
    // d2's run on d2 recomputed d0 and d1 with revised inputs.
    await recordWrittenAt({ asof: d2, writtenAt: noon(d2), compat: true, regime: [regimeRow(d0, 0.40), regimeRow(d1, 0.41), regimeRow(d2, 0.42)] });
    // No run on `gap`. Today: two runs, each recomputing every past day again.
    await publishNow({ asof: today, regime: [regimeRow(d0, 0.5), regimeRow(d1, 0.51), regimeRow(d2, 0.52), regimeRow(gap, 0.53), regimeRow(today, 0.54)] });
    await publishNow({ asof: today, regime: [regimeRow(d0, 0.6), regimeRow(d1, 0.61), regimeRow(d2, 0.62), regimeRow(gap, 0.63), regimeRow(today, 0.64)] });

    // Not vacuous: the newest run carries a different figure for every past day.
    const newest = await fixtureDb<{ n: number }[]>`
      SELECT count(*)::int AS n FROM analytics_output_snapshots WHERE artifact_kind = 'regime_snapshots' AND natural_keys @> ARRAY[${gap}]`;
    expect(newest[0]!.n).toBe(2);

    await expectServed({ [d0]: 0.30, [d1]: 0.31, [d2]: 0.42, [today]: 0.64 });
  });

  test("a day is frozen once it is over: a run written after it never replaces what was published during it", async () => {
    const [y, today] = [day(-1), day(0)];
    await recordWrittenAt({ asof: y, writtenAt: noon(y), compat: true, regime: [regimeRow(y, 0.2)] });
    await publishNow({ asof: y, regime: [regimeRow(y, 0.9, "risk_off")] }); // the same as-of day, written today
    await publishNow({ asof: today, regime: [regimeRow(y, 0.8), regimeRow(today, 0.7)] });
    await expectServed({ [y]: 0.2, [today]: 0.7 });
    const [row] = await sql<{ regime: string }[]>`SELECT regime FROM regime_snapshots WHERE date = ${y}`;
    expect(row!.regime).toBe("risk_on");
  });

  test("a replay run publishes a day nothing published, and no later run, live or replay, replaces it or a live publication", async () => {
    const [h, g, today] = [day(-3), day(-2), day(0)];
    // h: a live publication during h. g: no live success.
    await recordWrittenAt({ asof: h, writtenAt: noon(h), compat: true, regime: [regimeRow(h, 0.1)] });
    // The replay of g, written today, recorded as a replay (issue 1162).
    await publishNow({ asof: g, sourceLabel: "replay", regime: [regimeRow(h, 0.7), regimeRow(g, 0.25)] });
    // A later live run recomputes both; a later replay and a late live run for g follow.
    await publishNow({ asof: today, regime: [regimeRow(h, 0.8), regimeRow(g, 0.35), regimeRow(today, 0.5)] });
    await publishNow({ asof: g, sourceLabel: "replay", regime: [regimeRow(g, 0.45)] });
    await publishNow({ asof: g, sourceLabel: "live", regime: [regimeRow(h, 0.9), regimeRow(g, 0.55)] });

    const label = await fixtureDb<{ source_label: string }[]>`
      SELECT r.source_label FROM analytics_ledger_runs r WHERE r.asof = ${g} ORDER BY r.id LIMIT 1`;
    expect(label[0]!.source_label).toBe("replay");
    const ledger = Object.fromEntries((await ledgerCurrentRegimeSnapshots()).map((r) => [r.date, r.composite]));
    expect(ledger).toEqual({ [h]: 0.1, [g]: 0.25, [today]: 0.5 });
    await expectServed({ [h]: 0.1, [g]: 0.25, [today]: 0.5 });
  });

  test("days before the ledger start are frozen at cut-over and never change afterwards", async () => {
    const pre = [day(-30), day(-29), day(-28)];
    const today = day(0);
    // What the table served before the ledger existed (no run recorded yet).
    await saveRegimeSnapshots(pre.map((d, i) => regimeRow(d, 0.11 + i / 100)));
    await applyMigration0132();
    const baseline = await fixtureDb<{ date: string; composite: number }[]>`
      SELECT date::text AS date, (snapshot ->> 'composite')::float8 AS composite FROM regime_publication_baseline ORDER BY date`;
    expect([...baseline]).toEqual(pre.map((date, i) => ({ date, composite: 0.11 + i / 100 })));

    // The first run, and then another, recompute every one of those days.
    await publishNow({ asof: today, regime: [...pre.map((d) => regimeRow(d, 0.9)), regimeRow(day(-1), 0.4), regimeRow(today, 0.5)] });
    await publishNow({ asof: today, regime: [...pre.map((d) => regimeRow(d, 0.95)), regimeRow(day(-1), 0.45), regimeRow(today, 0.55)] });
    await expectServed({ [pre[0]!]: 0.11, [pre[1]!]: 0.12, [pre[2]!]: 0.13, [day(-1)]: 0.4, [today]: 0.55 });
    // The baseline table itself is the migration's alone.
    await expect(sql`UPDATE regime_publication_baseline SET snapshot = '{}'::jsonb`).rejects.toThrow(/permission denied/);
  });

  test("migration 0132 repairs a table every run rewrote to what the rule would have published, and a second application changes nothing", async () => {
    const [d0, d1, d2, d3, d4] = [day(-6), day(-5), day(-4), day(-3), day(-2)];
    const runs = [
      { asof: d1, writtenAt: `${d1}T08:00:00Z`, regime: [regimeRow(d0, 0.30), regimeRow(d1, 0.31)], research: [researchSignal("k", d1, "a")] },
      { asof: d1, writtenAt: `${d1}T20:00:00Z`, regime: [regimeRow(d0, 0.32), regimeRow(d1, 0.33)], research: [researchSignal("k", d1, "b")] },
      // d2: no run. d3's run recomputes it.
      { asof: d3, writtenAt: noon(d3), regime: [regimeRow(d0, 0.40), regimeRow(d1, 0.41), regimeRow(d2, 0.42), regimeRow(d3, 0.43)], research: [researchSignal("k", d3, "c")] },
      // Written on d4 for d1: late, after two publications during d1.
      { asof: d1, writtenAt: noon(d4), regime: [regimeRow(d0, 0.98), regimeRow(d1, 0.99, "risk_off")], research: [researchSignal("k", d1, "late")] },
    ];
    for (const r of runs) await recordWrittenAt(r);
    // The state the code before 0132 left: every run's whole history upserted, the newest winning.
    await withoutPublicationGuards(async (tx) => {
      for (const r of runs) {
        for (const row of r.regime) {
          await tx`INSERT INTO regime_snapshots (date, composite, regime) VALUES (${row.date}, ${row.composite}, ${row.regime})
                   ON CONFLICT (date) DO UPDATE SET composite = EXCLUDED.composite, regime = EXCLUDED.regime`;
        }
        for (const s of r.research) {
          await tx`INSERT INTO research_signals (signal_key, date, payload) VALUES (${s.key}, ${s.date}, ${tx.json(s.payload as never)})
                   ON CONFLICT (signal_key, date) DO UPDATE SET payload = EXCLUDED.payload`;
        }
      }
    });
    expect((await checkRegimeSnapshotsParity()).matched).toBe(false);

    const eventsBefore = await fixtureDb<{ n: number }[]>`SELECT count(*)::int AS n FROM analytics_overwrite_events`;
    await applyMigration0132();
    // d0 is before the ledger start (d1): frozen as served at cut-over, the
    // late run's 0.98. d1 is its last publication during d1; d2 is a gap.
    await expectServed({ [d0]: 0.98, [d1]: 0.33, [d3]: 0.43 });
    const full = await fixtureDb<{ date: string; composite: string; regime: string; version: string | null }[]>`
      SELECT date::text AS date, composite::text AS composite, regime, version FROM regime_snapshots ORDER BY date`;
    expect(full.map((r) => [r.date, r.composite, r.regime])).toEqual([[d0, "0.98", "risk_on"], [d1, "0.33", "risk_on"], [d3, "0.43", "risk_on"]]);
    expect(full[1]!.version).toBe("v-test"); // the whole publication row, not only the composite
    const research = await sql<{ date: string; title: string }[]>`
      SELECT date::text AS date, payload ->> 'title' AS title FROM research_signals WHERE signal_key = 'k' ORDER BY date`;
    expect([...research]).toEqual([{ date: d1, title: "b" }, { date: d3, title: "c" }]);
    expect((await checkResearchSignalsParity()).matched).toBe(true);
    // Every repair is recorded: d1 and d3 rewritten, d2 removed, the d1 signal rewritten.
    const eventsAfter = await fixtureDb<{ n: number }[]>`SELECT count(*)::int AS n FROM analytics_overwrite_events`;
    expect(eventsAfter[0]!.n - eventsBefore[0]!.n).toBe(4);

    await applyMigration0132();
    const eventsAgain = await fixtureDb<{ n: number }[]>`SELECT count(*)::int AS n FROM analytics_overwrite_events`;
    expect(eventsAgain[0]!.n).toBe(eventsAfter[0]!.n);
    await expectServed({ [d0]: 0.98, [d1]: 0.33, [d3]: 0.43 });
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
    const latest = published[next]!.at(-1)!;
    expect(latest.date).toBe(next);
    for (const mode of ["compatibility", "ledger"] as const) {
      const served = await servedComposites(mode);
      expect({ mode, day: served[COMMITTED_ASOF], next: served[next] }).toEqual({ mode, day: first.composite, next: latest.composite });
    }
    await fixtureDb`UPDATE analytics_read_mode SET mode = 'compatibility', updated_by = 'issue-1182-test' WHERE id = true`;
    expect((await checkRegimeSnapshotsParity()).matched).toBe(true);
  }, 600_000);
});

describe("Part A: no writer can change a past day's served figure", () => {
  test("the store writers, a direct runtime write and the provider's swarm door all leave a published past day as it was", async () => {
    const [y, gap, today] = [day(-2), day(-1), day(0)];
    await recordWrittenAt({ asof: y, writtenAt: noon(y), compat: true, regime: [regimeRow(y, 0.2)], research: [researchSignal("k", y, "published")] });
    await publishNow({ asof: today, regime: [regimeRow(y, 0.2), regimeRow(today, 0.3)] });

    await saveRegimeSnapshots([regimeRow(y, 0.77), regimeRow(gap, 0.66)]);
    await sql`UPDATE regime_snapshots SET composite = 0.88 WHERE date = ${y}`;
    await sql`INSERT INTO regime_snapshots (date, composite, regime) VALUES (${gap}, 0.55, 'neutral')`;
    const token = await provisionAnalyticsToken();
    const res = await handleSwarm(
      new Request("http://x/api/swarm/regime", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...bearerHeaders(token) },
        body: JSON.stringify({ snapshots: [regimeRow(y, 0.99), regimeRow(gap, 0.44)] }),
      }),
      new URL("http://x/api/swarm/regime"),
    );
    expect(res!.status).toBe(200);
    await persistResearchSignal("k", y, { asof: y, title: "revised" } as never);
    await sql`UPDATE research_signals SET payload = '{"title":"edited"}'::jsonb WHERE signal_key = 'k' AND date = ${y}`;

    await expectServed({ [y]: 0.2, [today]: 0.3 });
    const [signal] = await sql<{ title: string }[]>`SELECT payload ->> 'title' AS title FROM research_signals WHERE signal_key = 'k' AND date = ${y}`;
    expect(signal!.title).toBe("published");
    // The current day still updates through the same writers.
    await saveRegimeSnapshots([regimeRow(today, 0.31)]);
    expect(Number((await sql`SELECT composite FROM regime_snapshots WHERE date = ${today}`)[0]!.composite)).toBe(0.31);
  });

  test("every registered regime_snapshots or research_signals upsert replaces a row only while its day is not over, and the guard triggers are armed", async () => {
    // The modules that write either table register their statements on import.
    await import("../src/analytics/store/regime-store.ts");
    await import("../src/analytics/store/research-store.ts");
    const writers = registeredSites().filter(
      (d) => (d.object === "regime_snapshots" || d.object === "research_signals") && /DO\s+UPDATE/i.test(d.probe?.statement ?? ""),
    );
    expect(writers.map((d) => d.site).sort()).toEqual([
      "src/analytics/store/regime-store:saveRegimeSnapshots",
      "src/analytics/store/research-store:persistResearchSignal",
    ]);
    for (const w of writers) {
      const guard = `${w.object}.date >= (clock_timestamp() AT TIME ZONE 'UTC')::date`;
      expect({ site: w.site, guarded: w.probe!.statement.replace(/\s+/g, " ").includes(guard) }).toEqual({ site: w.site, guarded: true });
    }
    expect(PUBLISHING_DAY_GUARD).toBe("regime_snapshots.date >= (clock_timestamp() AT TIME ZONE 'UTC')::date");
    const triggers = await fixtureDb<{ name: string; enabled: string }[]>`
      SELECT tgname::text AS name, tgenabled::text AS enabled FROM pg_trigger
       WHERE tgname IN ('regime_snapshots_publication_guard', 'research_signals_publication_guard') ORDER BY tgname`;
    expect([...triggers]).toEqual([
      { name: "regime_snapshots_publication_guard", enabled: "A" },
      { name: "research_signals_publication_guard", enabled: "A" },
    ]);
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
      await expectServed({ [y]: 0.2 });
    },
  },
  {
    surface: "research signals: GET /api/dashboards/research-signals/:key",
    async check() {
      const y = day(-1);
      await recordWrittenAt({ asof: y, writtenAt: noon(y), compat: true, research: [researchSignal("channel-divergence", y, "published")] });
      await publishNow({ asof: y, research: [researchSignal("channel-divergence", y, "recomputed")] });
      for (const mode of ["compatibility", "ledger"] as const) {
        await fixtureDb`UPDATE analytics_read_mode SET mode = ${mode}, updated_by = 'issue-1182-test' WHERE id = true`;
        const signal = await fetchLatestResearchSignal("channel-divergence");
        expect({ mode, date: signal?.date, title: (signal?.payload as { title?: string } | undefined)?.title }).toEqual({ mode, date: y, title: "published" });
      }
      await fixtureDb`UPDATE analytics_read_mode SET mode = 'compatibility', updated_by = 'issue-1182-test' WHERE id = true`;
      expect((await ledgerCurrentResearchSignals()).map((s) => (s.payload as unknown as { title: string }).title)).toEqual(["published"]);
      expect((await checkResearchSignalsParity()).matched).toBe(true);
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
