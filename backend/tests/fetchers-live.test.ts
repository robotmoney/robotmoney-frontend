// Live fetcher drift test (SEPARATE from the deterministic tests/extract.test.ts,
// which is the CI-gating parser coverage). This file HITS REAL KEYLESS ENDPOINTS
// and asserts each fetcher (a) returns >0 recent points and (b) matches the
// vendored raw-indicator-history fixture on overlapping recent dates within a
// LOOSE tolerance (upstream sources revise). It FAILS LOUDLY on real drift or a
// changed response format — the point is to catch a source moving out from under
// us, not to silently skip.
//
// Gating: it runs ONLY when RUN_LIVE_FETCHERS=1 — a nightly/manual job
// (.github/workflows/nightly-fetchers.yml), NOT plain CI. It is deliberately NOT
// gated on CI=true: otherwise it would run on every PR and could flake on a
// transient upstream hiccup, gating unrelated changes on external-API health.
// Per-PR coverage is the deterministic parser suite in tests/extract.test.ts; this
// file only defers the LIVE drift guard to the nightly job. This is a documented
// environment gate, NOT a silent per-assertion skip: when enabled it must reach the
// network and pass (or fail loudly); when disabled it announces why (below).
import { test, expect } from "bun:test";
import type { Point } from "../src/analytics/types.ts";
import { loadRawIndicatorHistory } from "./fixtures/regime/load.ts";
import { fetchFred } from "../src/analytics/extract/fred.ts";
import { fetchYahoo } from "../src/analytics/extract/yahoo.ts";
import { fetchDefillamaTvl, fetchDefillamaStables } from "../src/analytics/extract/defillama.ts";
import { fetchBlockchainComChart } from "../src/analytics/extract/blockchain-com.ts";
import { fetchCoinmetrics } from "../src/analytics/extract/coinmetrics.ts";
import { fetchGeckoTerminalNewPools } from "../src/analytics/extract/geckoterminal.ts";
import { fetchShillerCape } from "../src/analytics/extract/shiller.ts";
import { fetchEdgarS4Monthly } from "../src/analytics/extract/edgar.ts";
import { mergeRatioSeries } from "../src/analytics/extract/sources.ts";

const LIVE = process.env.RUN_LIVE_FETCHERS === "1";
const t = LIVE ? test : test.skip;

// Execution-evidence guard (test-coverage policy invariant 2): the nightly
// workflow sets EXPECT_LIVE=1 alongside the gate. If the gate name ever drifts
// (in the workflow or here), LIVE resolves false while EXPECT_LIVE=1 — every
// live test would silently become a skip and the run would stay green while
// validating nothing. Refuse loudly instead: a module-load throw fails
// `bun test` non-zero. Asserted present by scripts/tests/nightly-fetchers-guard.test.ts.
if (process.env.EXPECT_LIVE === "1" && !LIVE) {
  throw new Error(
    "[fetchers-live] EXPECT_LIVE=1 but the RUN_LIVE_FETCHERS gate is OFF — " +
      "the workflow/test gate wiring has drifted; refusing an all-skip false-green run",
  );
}

if (!LIVE) {
  // Not a silent skip of behavior: parser correctness is covered by
  // tests/extract.test.ts (always runs). This only defers the network drift
  // guard to the nightly job. Announce loudly so a green PR/local run is never
  // mistaken for "the live endpoints were validated".
  // eslint-disable-next-line no-console
  console.warn(
    "[fetchers-live] SKIPPED live drift checks (RUN_LIVE_FETCHERS != 1). " +
      "Deterministic parser coverage in tests/extract.test.ts still gates every PR. " +
      "The nightly workflow (nightly-fetchers.yml) sets RUN_LIVE_FETCHERS=1 to " +
      "validate against real endpoints daily. Set RUN_LIVE_FETCHERS=1 to run locally.",
  );
  test("fetchers-live gate is documented (parser tests remain the gate)", () => {
    expect(LIVE).toBe(false);
  });
}

// Retry a fetch once on transient failure (per task: resilient to a single
// transient source timeout, but loud on real drift).
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch {
    await new Promise((r) => setTimeout(r, 1500));
    return await fn();
  }
}

// Median relative difference between a fetched series and the fixture over their
// most-recent overlapping dates. Loose by design — sources revise recent values.
function medianRelDiffRecent(
  fetched: Point[],
  fixture: { date: string; value: number }[],
  lookbackDates = 120,
): { overlap: number; median: number } {
  const fm = new Map(fetched.map((p) => [p.date, p.value]));
  const recent = fixture.slice(-lookbackDates);
  const diffs: number[] = [];
  for (const f of recent) {
    const v = fm.get(f.date);
    if (v == null || !Number.isFinite(v)) continue;
    const denom = Math.abs(f.value) > 1e-9 ? Math.abs(f.value) : 1;
    diffs.push(Math.abs(v - f.value) / denom);
  }
  diffs.sort((a, b) => a - b);
  return { overlap: diffs.length, median: diffs.length ? diffs[Math.floor(diffs.length / 2)] : Infinity };
}

// Assert a fetched series is fresh (>0 recent pts) and tracks the fixture.
function assertTracks(
  id: string,
  fetched: Point[],
  fixture: Record<string, { date: string; value: number }[]>,
  tol: number,
  minOverlap = 5,
) {
  expect(fetched.length, `${id}: expected >0 fetched points`).toBeGreaterThan(0);
  const fx = fixture[id];
  expect(fx?.length, `${id}: fixture series missing`).toBeGreaterThan(0);
  const { overlap, median } = medianRelDiffRecent(fetched, fx);
  // eslint-disable-next-line no-console
  console.log(`[fetchers-live] ${id}: fetched=${fetched.length} last=${fetched.at(-1)?.date} overlap=${overlap} medianRelDiff=${median.toFixed(4)} (tol ${tol})`);
  expect(overlap, `${id}: too few overlapping recent dates with fixture`).toBeGreaterThanOrEqual(minOverlap);
  expect(median, `${id}: DRIFT — median relative diff ${median} exceeds ${tol}`).toBeLessThan(tol);
}

t("FRED series track the fixture (T10Y2Y, DXY, ICSA, HY_OAS)", async () => {
  const fx = await loadRawIndicatorHistory();
  assertTracks("T10Y2Y", await withRetry(() => fetchFred("T10Y2Y")), fx, 0.15);
  assertTracks("DXY", await withRetry(() => fetchFred("DTWEXBGS")), fx, 0.05);
  assertTracks("ICSA", await withRetry(() => fetchFred("ICSA")), fx, 0.25);
  assertTracks("HY_OAS", await withRetry(() => fetchFred("BAMLH0A0HYM2")), fx, 0.15);
}, 60_000);

t("Yahoo single-symbol series track the fixture (VIX, SPX_TREND, ETH_TREND)", async () => {
  const fx = await loadRawIndicatorHistory();
  assertTracks("VIX", await withRetry(() => fetchYahoo("^VIX")), fx, 0.15);
  assertTracks("SPX_TREND", await withRetry(() => fetchYahoo("^GSPC")), fx, 0.08); // raw price
  assertTracks("ETH_TREND", await withRetry(() => fetchYahoo("ETH-USD")), fx, 0.12); // raw price
}, 60_000);

t("Yahoo ratio series track the fixture (COPPER_GOLD, IWM_SPY, BTC_ETH)", async () => {
  const fx = await loadRawIndicatorHistory();
  const ratio = async (a: string, b: string) =>
    mergeRatioSeries(await withRetry(() => fetchYahoo(a)), await withRetry(() => fetchYahoo(b)));
  assertTracks("COPPER_GOLD", await ratio("HG=F", "GC=F"), fx, 0.08);
  assertTracks("IWM_SPY", await ratio("IWM", "SPY"), fx, 0.06);
  assertTracks("BTC_ETH", await ratio("BTC-USD", "ETH-USD"), fx, 0.1);
}, 90_000);

t("DefiLlama series track the fixture (DEFI_TVL, STABLES)", async () => {
  const fx = await loadRawIndicatorHistory();
  assertTracks("DEFI_TVL", await withRetry(() => fetchDefillamaTvl()), fx, 0.15);
  assertTracks("STABLES", await withRetry(() => fetchDefillamaStables()), fx, 0.1);
}, 60_000);

t("blockchain.com BTC active addresses track the fixture (BTC_ACTIVE)", async () => {
  const fx = await loadRawIndicatorHistory();
  // Daily active-address counts are volatile; loose tolerance.
  assertTracks("BTC_ACTIVE", await withRetry(() => fetchBlockchainComChart("n-unique-addresses")), fx, 0.5);
}, 60_000);

t("Coinmetrics ETH active addresses track the fixture (ETH_ACTIVE)", async () => {
  const fx = await loadRawIndicatorHistory();
  assertTracks("ETH_ACTIVE", await withRetry(() => fetchCoinmetrics("eth", "AdrActCnt")), fx, 0.5);
}, 60_000);

t("Shiller CAPE is fresh + tracks the fixture over its raw monthly history (SHILLER_CAPE)", async () => {
  // SHILLER_CAPE is MONTHLY. The fixture stores it forward-filled to daily, and
  // its recent tail is a STALE value (when the fixture was captured, multpl.com
  // had broken and it fell back to the datahub mirror, last real point 2023-09,
  // forward-filled ~30.8 through 2026). So we (a) assert FRESHNESS — the fetcher
  // must now return a real point within ~45 days (proves the multpl regex fix
  // works and the source isn't stalled), and (b) assert it tracks the fixture
  // over the FULL overlapping range (dominated by the historical months both
  // agree on) within a loose tolerance. A future format break ⇒ 0 fresh rows ⇒
  // loud fail.
  const fx = await loadRawIndicatorHistory();
  const cape = await withRetry(() => fetchShillerCape());
  expect(cape.length, "SHILLER_CAPE: expected >0 fetched points").toBeGreaterThan(0);
  const last = cape.at(-1)!;
  const ageDays = (Date.now() - Date.parse(last.date + "T00:00:00Z")) / 86400_000;
  // eslint-disable-next-line no-console
  console.log(`[fetchers-live] SHILLER_CAPE: fetched=${cape.length} last=${last.date} value=${last.value} ageDays=${ageDays.toFixed(0)}`);
  expect(ageDays, `SHILLER_CAPE: source is STALE (last ${last.date}) — multpl.com format likely changed`).toBeLessThan(45);
  const { overlap, median } = medianRelDiffRecent(cape, fx.SHILLER_CAPE ?? [], 100_000); // full range
  // eslint-disable-next-line no-console
  console.log(`[fetchers-live] SHILLER_CAPE: full-range overlap=${overlap} medianRelDiff=${median.toFixed(4)}`);
  expect(overlap, "SHILLER_CAPE: too few overlapping dates with fixture").toBeGreaterThanOrEqual(50);
  expect(median, `SHILLER_CAPE: DRIFT — median relative diff ${median} exceeds 0.1`).toBeLessThan(0.1);
}, 60_000);

t("GeckoTerminal new-pools returns a finite 24h count (NEW_TOKENS)", async () => {
  const pts = await withRetry(() => fetchGeckoTerminalNewPools());
  expect(pts.length).toBe(1);
  expect(Number.isFinite(pts[0].value)).toBe(true);
  expect(pts[0].value).toBeGreaterThanOrEqual(0);
  // eslint-disable-next-line no-console
  console.log(`[fetchers-live] NEW_TOKENS: ${pts[0].date} count=${pts[0].value}`);
}, 60_000);

t("EDGAR S-4 monthly counts are fetchable (mna input)", async () => {
  const end = new Date();
  const start = new Date(end.getTime() - 75 * 86400_000); // ~2 months
  const pts = await withRetry(() => fetchEdgarS4Monthly(start.toISOString().slice(0, 10), end.toISOString().slice(0, 10)));
  expect(pts.length, "EDGAR: expected >=1 monthly S-4 count").toBeGreaterThan(0);
  for (const p of pts) expect(Number.isFinite(p.value) && p.value >= 0).toBe(true);
  // eslint-disable-next-line no-console
  console.log(`[fetchers-live] EDGAR S-4 months: ${pts.map((p) => `${p.date}=${p.value}`).join(", ")}`);
}, 60_000);
