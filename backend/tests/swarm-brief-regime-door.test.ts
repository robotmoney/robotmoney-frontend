// Issue 1182, folded-in issue 999: the last regime write door with no run
// behind it (POST /api/swarm/regime) and the one-shot importer
// (db/import-regime-eq.ts), against the brief. The door refuses any day the
// ledger selection publishes (D83, the same selection the regime endpoint
// serves); no trigger or migration is involved. publishBrief shows the newest
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
import { ALLOCATION_FRAMEWORK_SEED } from "../src/chain/allocation-framework.ts";
import { eqSnapshotToRows } from "../src/analytics/report/regime-eq-map.ts";
import type { RegimeSnapshotRow } from "../src/analytics/report/regime-projection.ts";
import { bearerHeaders, provisionAnalyticsToken } from "./support/automation-auth.ts";
import { day, noon, publishNow, recordWrittenAt, regimeRow, richRegimeRow, servedComposites, setReadMode } from "./support/regime-publications.ts";

useCleanDatabasePerTest(import.meta.file);


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

  test("import-regime-eq over a day a run published leaves the served figure as published", async () => {
    const rows = eqSnapshotToRows(loadEqSnapshot());
    const last = rows.map((r) => r.date).sort().at(-1)!;
    await recordWrittenAt({ asof: last, writtenAt: noon(last), compat: true, regime: [regimeRow(last, 0.123)] });
    await importRegimeEq();
    // The importer still writes the table (it is the out-of-band fixture loader) ...
    const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM regime_snapshots`;
    expect(n).toBe(new Set(rows.map((r) => r.date)).size);
    // ... and readers are still served the run's publication for its day, in both read modes.
    for (const mode of ["compatibility", "ledger"] as const) {
      expect({ mode, served: (await servedComposites(mode, 5000))[last] }).toEqual({ mode, served: 0.123 });
    }
    await setReadMode("compatibility");
  });
});

describe("issue 1695: every member reads the same readings and task from the brief", () => {
  async function publishedBody(framework = false): Promise<Record<string, any>> {
    const subjectId = `issue-1695-${crypto.randomUUID().slice(0, 8)}`;
    await swarmDomain.ensureSubject(subjectId, "Issue 1695 Subject");
    if (framework) {
      await sql`UPDATE swarm_subjects SET source = ${sql.json({ type: "framework" })}, recommendation_type = 'bucket_weights' WHERE id = ${subjectId}`;
      await fixtureDb`INSERT INTO allocation_framework (id, asof, vault_contract, buckets)
                VALUES (1, '2026-06-02', ${ALLOCATION_FRAMEWORK_SEED.vault_contract},
                        ${fixtureDb.json(JSON.parse(JSON.stringify(ALLOCATION_FRAMEWORK_SEED.buckets)))})
                ON CONFLICT (id) DO UPDATE SET asof = EXCLUDED.asof, buckets = EXCLUDED.buckets`;
    }
    const session = await swarmDomain.openSession(subjectId);
    await swarmDomain.publishBrief(session.id, 60);
    const [brief] = await sql<{ body: Record<string, any> }[]>`SELECT body FROM swarm_briefs WHERE session_id = ${session.id}`;
    return brief!.body;
  }

  test("the regime block carries the factor label and the three panel percentiles of its own snapshot", async () => {
    const [y, today] = [day(-1), day(0)];
    await publishNow({ asof: today, regime: [regimeRow(y, 0.2), richRegimeRow(today, 0.34)] });
    const { regime } = await publishedBody();
    expect(String(regime.date).slice(0, 10)).toBe(today);
    expect({
      factor_regime: regime.factor_regime,
      macro_percentile: regime.macro_percentile,
      onchain_percentile: regime.onchain_percentile,
      factor_percentile: regime.factor_percentile,
    }).toEqual({ factor_regime: "risk_off", macro_percentile: 0.44, onchain_percentile: 0.81, factor_percentile: 0.19 });
    // The composite's 3-year percentile stays retired (1660).
    expect(regime).not.toHaveProperty("composite_percentile");
  });

  test("a missing percentile is null in the brief, never an estimate", async () => {
    const today = day(0);
    await publishNow({ asof: today, regime: [regimeRow(today, 0.34)] });
    const { regime } = await publishedBody();
    expect([regime.macro_percentile, regime.onchain_percentile, regime.factor_percentile, regime.factor_regime]).toEqual([null, null, null, null]);
  });

  test("additive only: every field the brief carried before keeps its name and type", async () => {
    const today = day(0);
    await publishNow({ asof: today, regime: [richRegimeRow(today, 0.34)] });
    const body = await publishedBody();
    const shape = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v === null ? "null" : Array.isArray(v) ? "array" : typeof v]));
    expect(shape(body)).toMatchObject({
      regime: "object", subject: "object", recentSessions: "array", researchSignals: "array",
      prompt: "object", takeSchema: "object", windowClosesAt: "string",
    });
    expect(shape(body.prompt)).toEqual({ system: "string", user: "string" });
    expect(Object.keys(body.regime)).toEqual(expect.arrayContaining(["date", "composite", "regime", "macro_regime", "onchain_regime", "method"]));
    expect(body.regime.regime).toBe("risk_on");
    expect(body.prompt.user).toStartWith("Review the supplied swarm context for Issue 1695 Subject on ");
    expect(body.prompt.user).toContain("and return one take matching takeSchema.");
  });

  test("the task text names the subject, the sleeves the weights cover, and the targets in force as the starting point", async () => {
    const body = await publishedBody(true);
    const user: string = body.prompt.user;
    const first = body.allocation.buckets[0];
    expect(user).toContain(`The targets in force are ${first.id} ${+(first.target_weight * 100).toFixed(1)}%`);
    expect(user).toContain("The subject under review is Issue 1695 Subject");
    expect(user).toContain(`The weights cover these sleeves: ${body.takeSchema.weights.buckets.join(", ")}.`);
    expect(user).toContain("starting point, not the answer");
    expect(user).toContain("A null reading is missing: do not estimate it.");
  });
});
