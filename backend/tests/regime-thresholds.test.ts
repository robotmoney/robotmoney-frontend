// Issue #129 / maintainability findings 002 + 009: regime thresholds existed
// three times (analytics classifier 0.33/0.67; swarm domain and MCP memo at
// a diverged 0.45/0.55) and the swarm layer wrote synthetic rows into the
// classifier-owned regime_snapshots table on the LIVE aggregation path. This
// suite pins the remediation:
//   * one canonical classifier in @robotmoney/contract, consumed by the
//     analytics classifier AND the swarm domain layer (mcp/tests pins the
//     memo surface);
//   * buildRegimeSummary (live aggregation) READS stored labels, re-derives
//     only when the stored label is NULL, and never writes synthetic rows;
//   * synthetic backfill is demo-gated (refused under RM_ENV=prod) and reserved
//     for the demo fixture path (ensureDemoSubjectFixtures).
import { test, expect, afterEach } from "bun:test";
import { classifyRegime, REGIME_RISK_OFF, REGIME_RISK_ON } from "@robotmoney/contract";
import { classifyRegime as classifierLabel } from "../src/analytics/analyze/regime.ts";
import { config } from "../src/config.ts";
import { sql } from "../src/db/client.ts";
import {
  backfillRegimeHistory,
  buildRegimeSummary,
  ensureDemoSubjectFixtures,
} from "../src/swarm/domain.ts";
import { useCleanDatabasePerTest } from "./support/clean-db.ts";

// Own database per TEST, cloned from the migrated template: these tests each
// start from an empty table, which used to mean wiping one the previous test
// filled. See support/clean-db.ts.
useCleanDatabasePerTest(import.meta.file);

const origEnv = config.env;
afterEach(() => {
  (config as { env: string }).env = origEnv;
});

async function snapshotCount(): Promise<number> {
  const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM regime_snapshots`;
  return Number(n);
}

// ── AC: one classifier, identical labels on every surface ────────────────────

test("canonical thresholds are 0.33/0.67 and classifyRegime matches analyze/regime.ts's label rule", () => {
  expect(REGIME_RISK_OFF).toBe(0.33);
  expect(REGIME_RISK_ON).toBe(0.67);

  // The analytics classifier re-exports the very same function — not a copy.
  expect(classifierLabel).toBe(classifyRegime);

  // The AC triple: 0.60 is NEUTRAL under canon (the old swarm/mcp 0.45/0.55
  // rule wrongly called it risk_on), 0.70 is risk_on, 0.30 is risk_off.
  expect(classifyRegime(0.6)).toBe("neutral");
  expect(classifierLabel(0.6)).toBe("neutral");
  expect(classifyRegime(0.7)).toBe("risk_on");
  expect(classifierLabel(0.7)).toBe("risk_on");
  expect(classifyRegime(0.3)).toBe("risk_off");
  expect(classifierLabel(0.3)).toBe("risk_off");

  // Boundary semantics exactly as analyze/regime.ts always had them:
  // s < 0.33 → risk_off (0.33 itself is neutral); s >= 0.67 → risk_on.
  expect(classifyRegime(0.33)).toBe("neutral");
  expect(classifyRegime(0.3299)).toBe("risk_off");
  expect(classifyRegime(0.67)).toBe("risk_on");
  expect(classifyRegime(0.6699)).toBe("neutral");
});

test("swarm domain labeling path (buildRegimeSummary NULL-label fallback) uses the canonical classifier", async () => {
  for (const [composite, expected] of [
    [0.6, "neutral"],
    [0.7, "risk_on"],
    [0.3, "risk_off"],
  ] as const) {
    // Upsert, because the loop deliberately reuses one date: correcting the day's
    // composite is an UPDATE, which is what "append-only" leaves available (and
    // what the production write path does anyway).
    await sql`INSERT INTO regime_snapshots (date, composite, regime) VALUES ('2026-07-01', ${composite}, NULL)
              ON CONFLICT (date) DO UPDATE SET composite = EXCLUDED.composite, regime = NULL`;
    const summary = await buildRegimeSummary("2026-07-01", 1);
    expect(summary.regime).toBe(expected);
    // The stored (real) point in history is labeled by the same rule.
    expect(summary.history[summary.history.length - 1].regime).toBe(expected);
  }
});

// ── AC: live path reads STORED labels and never re-derives over them ─────────

test("buildRegimeSummary echoes a contrarian STORED label instead of re-deriving it", async () => {
  // 0.60 is "neutral" under canon — store the contrarian label on purpose.
  await sql`
    INSERT INTO regime_snapshots (date, composite, regime, macro_regime, onchain_regime, factor_regime)
    VALUES ('2026-07-02', 0.60, 'risk_on', 'risk_off', 'risk_on', 'risk_off')`;
  const summary = await buildRegimeSummary("2026-07-02", 1);
  expect(summary.regime).toBe("risk_on"); // stored, NOT classifyRegime(0.60) === "neutral"
  expect(summary.macro_regime).toBe("risk_off");
  expect(summary.onchain_regime).toBe("risk_on");
  expect(summary.factor_regime).toBe("risk_off");
  expect(summary.history[summary.history.length - 1].regime).toBe("risk_on");
});

test("LIVE aggregation path: buildRegimeSummary writes NO synthetic rows when regime_snapshots is sparse", async () => {
  await sql`INSERT INTO regime_snapshots (date, composite, regime) VALUES ('2026-07-03', 0.52, 'neutral')`;
  await sql`INSERT INTO regime_snapshots (date, composite, regime) VALUES ('2026-07-04', 0.61, 'neutral')`;
  const before = await snapshotCount();
  expect(before).toBe(2);

  const summary = await buildRegimeSummary("2026-07-04");

  // Sparkline minimum still honored — via IN-MEMORY padding only.
  expect(summary.history.length).toBeGreaterThanOrEqual(8);
  expect(await snapshotCount()).toBe(before); // nothing persisted

  // Every in-memory padded point is labeled by the canonical classifier.
  const storedDates = new Set(["2026-07-03", "2026-07-04"]);
  const padded = summary.history.filter((h) => !storedDates.has(h.date));
  expect(padded.length).toBeGreaterThanOrEqual(6);
  for (const p of padded) expect(p.regime).toBe(classifyRegime(p.composite));
});

// ── AC: synthetic backfill is demo-gated ─────────────────────────────────────

test("demo-gated backfill still seeds >= 8 persisted points, labeled by the canonical classifier", async () => {
  expect(config.env).not.toBe("prod"); // tests run under RM_ENV=ephemeral
  await backfillRegimeHistory("2026-07-05");
  expect(await snapshotCount()).toBeGreaterThanOrEqual(8);

  const rows = await sql<{ composite: number; regime: string; macro: number; macro_regime: string }[]>`
    SELECT composite::float8 AS composite, regime, macro_index::float8 AS macro, macro_regime
    FROM regime_snapshots ORDER BY date`;
  for (const r of rows) {
    expect(r.regime).toBe(classifyRegime(Number(r.composite)));
    expect(r.macro_regime).toBe(classifyRegime(Number(r.macro)));
  }
});

test("demo fixture path (ensureDemoSubjectFixtures) keeps demo sparklines at >= 8 persisted points", async () => {
  await ensureDemoSubjectFixtures("regime_thresholds_subj", "Threshold Subject", "2026-07-06");
  expect(await snapshotCount()).toBeGreaterThanOrEqual(8);
  const summary = await buildRegimeSummary("2026-07-06");
  expect(summary.history.length).toBeGreaterThanOrEqual(8);
});

test("backfillRegimeHistory REFUSES to write synthetic rows under RM_ENV=prod", async () => {
  (config as { env: string }).env = "prod";
  await backfillRegimeHistory("2026-07-07");
  expect(await snapshotCount()).toBe(0);
});
