// Issue 1182, folded-in issue 999: the last regime write door with no run
// behind it (POST /api/swarm/regime) and the one-shot importer
// (db/import-regime-eq.ts), against the brief. publishBrief shows the newest
// regime row and binds the report of the run with that as-of day, so a row the
// door replaced there would be shown under a report that does not hold it, and
// a future-dated row would be shown while the dashboard hides it.
import { describe, expect, test } from "bun:test";
import { sql } from "../src/db/client.ts";
import { fixtureDb } from "./support/fixture-db.ts";
import { useCleanDatabasePerTest } from "./support/clean-db.ts";
import { handleSwarm } from "../src/api/routes/swarm.ts";
import * as swarmDomain from "../src/swarm/domain.ts";
import { importRegimeEq, loadEqSnapshot } from "../src/db/import-regime-eq.ts";
import { eqSnapshotToRows } from "../src/analytics/report/regime-eq-map.ts";
import type { RegimeSnapshotRow } from "../src/analytics/report/regime-projection.ts";
import { bearerHeaders, provisionAnalyticsToken } from "./support/automation-auth.ts";
import { day, publishNow, recordWrittenAt, regimeRow } from "./support/regime-publications.ts";

useCleanDatabasePerTest(import.meta.file);

const noon = (d: string) => `${d}T12:00:00Z`;

describe("issue 999: the provider door and the importer cannot put unpublished numbers in a brief", () => {
  const postRegime = async (rows: RegimeSnapshotRow[]) => {
    const token = await provisionAnalyticsToken();
    return handleSwarm(
      new Request("http://x/api/swarm/regime", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...bearerHeaders(token) },
        body: JSON.stringify({ snapshots: rows }),
      }),
      new URL("http://x/api/swarm/regime"),
    );
  };

  /** Publish a brief now and return what it shows and the regime artifact row of the run its report belongs to. */
  async function briefNow(): Promise<{ shown: { date: string; composite: number }; reportId: string | null; frozen: { date: string; composite: number } | null }> {
    const subjectId = `issue-999-${crypto.randomUUID().slice(0, 8)}`;
    await swarmDomain.ensureSubject(subjectId, "Issue 999 Subject");
    const session = await swarmDomain.openSession(subjectId);
    await swarmDomain.publishBrief(session.id, 60);
    const [brief] = await sql<{ body: { regime: { date: string; composite: unknown } }; report_snapshot_id: string | null }[]>`
      SELECT body, report_snapshot_id FROM swarm_briefs WHERE session_id = ${session.id}`;
    const shown = { date: String(brief!.body.regime.date).slice(0, 10), composite: Number(brief!.body.regime.composite) };
    if (brief!.report_snapshot_id === null) return { shown, reportId: null, frozen: null };
    const [artifact] = await fixtureDb<{ payload: string }[]>`
      SELECT convert_from(aos.payload_bytes, 'UTF8') AS payload FROM analytics_report_snapshots rs
        JOIN analytics_output_snapshots aos ON aos.run_id = rs.run_id AND aos.artifact_kind = 'regime_snapshots'
       WHERE rs.id = ${brief!.report_snapshot_id}::bigint`;
    const row = (JSON.parse(artifact!.payload) as RegimeSnapshotRow[]).find((r) => r.date === shown.date) ?? null;
    return { shown, reportId: String(brief!.report_snapshot_id), frozen: row && { date: row.date, composite: Number(row.composite) } };
  }

  test("a row posted for a day a frozen run owns is refused with no write, and the brief binds the report whose run froze the numbers it shows", async () => {
    const [y, today] = [day(-1), day(0)];
    const run = await publishNow({ asof: today, regime: [regimeRow(y, 0.2), regimeRow(today, 0.3)] });

    // Today is still being published, and the run that owns it froze it: the door must not replace it.
    const res = await postRegime([regimeRow(today, 0.99)]);
    expect(res!.status).toBe(409);
    expect(res!.body).toMatchObject({ dates: [today] });
    expect((await postRegime([regimeRow(y, 0.98)]))!.status).toBe(409);
    expect(Number((await sql`SELECT composite FROM regime_snapshots WHERE date = ${today}`)[0]!.composite)).toBe(0.3);

    const brief = await briefNow();
    expect(brief.shown).toEqual({ date: today, composite: 0.3 });
    expect(brief.reportId).toBe(run.reportSnapshotId);
    expect(brief.frozen).toEqual(brief.shown);
  });

  test("a future-dated row the door accepts never reaches a published brief body", async () => {
    const [today, tomorrow] = [day(0), day(1)];
    const run = await publishNow({ asof: today, regime: [regimeRow(today, 0.3)] });
    // No frozen run owns tomorrow, so the door still accepts it; the brief must not show it.
    expect((await postRegime([regimeRow(tomorrow, 0.77)]))!.status).toBe(200);
    expect((await sql`SELECT 1 FROM regime_snapshots WHERE date = ${tomorrow}`).length).toBe(1);

    const brief = await briefNow();
    expect(brief.shown).toEqual({ date: today, composite: 0.3 });
    expect(brief.reportId).toBe(run.reportSnapshotId);
    expect(brief.frozen).toEqual(brief.shown);
  });

  test("the provider door still persists a day no frozen run owns", async () => {
    const tomorrow = day(1);
    const res = await postRegime([regimeRow(tomorrow, 0.61)]);
    expect(res!.status).toBe(200);
    expect(res!.body).toMatchObject({ ok: true, saved: 1 });
    expect(Number((await sql`SELECT composite FROM regime_snapshots WHERE date = ${tomorrow}`)[0]!.composite)).toBe(0.61);
  });

  test("import-regime-eq still imports the fixture into a fresh database", async () => {
    const rows = eqSnapshotToRows(loadEqSnapshot());
    await importRegimeEq();
    const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM regime_snapshots`;
    expect(n).toBe(new Set(rows.map((r) => r.date)).size);
    // A brief over imported rows binds no report: none holds those numbers.
    const imported = await briefNow();
    expect(imported.shown.date).toBe(rows.map((r) => r.date).sort().at(-1)!);
    expect(imported.reportId).toBeNull();
  });

  test("import-regime-eq never changes a day a run published", async () => {
    const rows = eqSnapshotToRows(loadEqSnapshot());
    const last = rows.map((r) => r.date).sort().at(-1)!;
    await recordWrittenAt({ asof: last, writtenAt: noon(last), compat: true, regime: [regimeRow(last, 0.123)] });
    await importRegimeEq();
    expect(Number((await sql`SELECT composite FROM regime_snapshots WHERE date = ${last}`)[0]!.composite)).toBe(0.123);
    // The days before the run's as-of day, which no run published, were still imported.
    const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM regime_snapshots`;
    expect(n).toBe(new Set(rows.map((r) => r.date)).size);
  });
});
