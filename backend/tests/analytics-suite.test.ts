// Suite (DB round-trip; ephemeral Postgres via preload.ts). Drives the whole
// analyze→store path through the Registry for a fixed seeded asof and asserts the
// regime snapshots + both research signals land. PROVIDER defaults to seeded, so
// this is deterministic and network-free.
import { test, expect } from "bun:test";
import { sql } from "../src/db/client.ts";
import { runAnalytics } from "../src/analytics/index.ts";

const ASOF = "2024-01-15";

test("runAnalytics(asof) persists regime + both research signals (seeded)", async () => {
  await sql`DELETE FROM regime_snapshots`;
  await sql`DELETE FROM research_signals WHERE date = ${ASOF}`;

  await runAnalytics(ASOF);

  const [{ count }] = await sql`SELECT COUNT(*)::int AS count FROM regime_snapshots`;
  expect(count).toBeGreaterThan(0); // regime classifier wrote its history

  // the latest persisted snapshot is the asof day.
  const [latest] = await sql`SELECT date FROM regime_snapshots ORDER BY date DESC LIMIT 1`;
  const latestDate = typeof latest.date === "string" ? latest.date : new Date(latest.date).toISOString().slice(0, 10);
  expect(latestDate).toBe(ASOF);

  for (const key of ["channel-divergence", "late-cycle-signals"]) {
    const rows = await sql`SELECT payload FROM research_signals WHERE signal_key = ${key} AND date = ${ASOF}`;
    expect(rows.length).toBe(1);
    expect((rows[0].payload as any).asof).toBe(ASOF);
    expect(Array.isArray((rows[0].payload as any).gauges)).toBe(true);
  }
});
