// HY_OAS / FRED fallback coverage (issue #634's second acceptance criterion:
// "FRED scraper gracefully falls back if API truncates"). Companion to
// regime-fetchers.test.ts, which pins the truncation itself and the
// successful merge recovery. This file exercises the DEGRADED paths: a fetch
// that errors outright, and a fetch that returns nothing at all — proving
// `fetchAll` (extract/sources.ts) never throws the whole run over one bad
// source, and that the production merge (`mergeSeries(persisted, fetched)`,
// analytics/index.ts) falls back to the persisted floor untouched rather than
// losing history. All mocked HTTP — no live network.
import { test, expect } from "bun:test";
import { fetchAll, fetchOne } from "../../src/analytics/extract/sources.ts";
import { INDICATORS } from "../../src/analytics/analyze/indicators.ts";
import { mergeSeries } from "../../src/analytics/transform/math.ts";

const HY_OAS = INDICATORS.find((i) => i.id === "HY_OAS")!;
const PERSISTED = [
  { date: "2023-06-01", value: 4.5 },
  { date: "2023-06-02", value: 4.4 },
  { date: "2024-01-02", value: 3.9 },
];

function mockFetchReject(message: string) {
  return (async () => {
    throw new Error(message);
  }) as unknown as typeof fetch;
}

function mockFetchHttpError(status: number, statusText: string) {
  return (async () => ({
    ok: false,
    status,
    statusText,
    text: async () => "",
  })) as unknown as typeof fetch;
}

function mockFetchEmptyCsv() {
  return (async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    text: async () => "DATE,BAMLH0A0HYM2\n", // header only — 0 usable rows
  })) as unknown as typeof fetch;
}

test("fetchOne(HY_OAS) throws on a network failure — the caller decides the fallback, per its documented contract", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = mockFetchReject("FRED unreachable");
  try {
    await expect(fetchOne(HY_OAS)).rejects.toThrow(/FRED unreachable/);
  } finally {
    globalThis.fetch = orig;
  }
});

test("fetchAll gracefully falls back: a thrown HY_OAS fetch resolves to [] (logged), not a run-wide crash", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = mockFetchHttpError(503, "Service Unavailable");
  const errors: string[] = [];
  const logger = { error: (m: string) => errors.push(m), warn: () => {}, log: () => {} };
  try {
    const out = await fetchAll({ indicators: [HY_OAS], logger });
    expect(out.HY_OAS).toEqual([]);
    expect(errors.some((m) => m.includes("HY_OAS") && m.includes("503"))).toBe(true);
  } finally {
    globalThis.fetch = orig;
  }
});

test("gracefully falls back: an empty live fetch merged against the persisted floor leaves the floor fully intact", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = mockFetchEmptyCsv();
  try {
    const live = await fetchOne(HY_OAS);
    expect(live).toEqual([]);
    const merged = mergeSeries(PERSISTED, live);
    expect(merged).toEqual(PERSISTED); // no data lost — the append-only floor wins entirely
  } finally {
    globalThis.fetch = orig;
  }
});

test("gracefully falls back: a hard fetch failure merged against the persisted floor also leaves the floor fully intact", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = mockFetchHttpError(500, "Internal Server Error");
  const logger = { error: () => {}, warn: () => {}, log: () => {} };
  try {
    const out = await fetchAll({ indicators: [HY_OAS], logger });
    const merged = mergeSeries(PERSISTED, out.HY_OAS ?? []);
    expect(merged).toEqual(PERSISTED);
  } finally {
    globalThis.fetch = orig;
  }
});

// Contrast case: WITHOUT a persisted floor (e.g. a hypothetical cold DB that
// never ran the ANALYTICS_FLOOR_SEED=1 seed step), a truncated live-only fetch
// is all there is — this is exactly why floor-seed-generator.ts's
// UNRECOVERABLE_PRESERVE_IDS keeps HY_OAS's pre-window rows in the committed
// seed rather than relying on a fresh purge-mode fetch to reproduce them.
test("without a persisted floor, a truncated live fetch alone cannot recover pre-window history (motivates the preserve-list floor seed)", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    text: async () => "DATE,BAMLH0A0HYM2\n2023-08-15,3.85\n2023-08-16,3.84\n",
  })) as unknown as typeof fetch;
  try {
    const live = await fetchOne(HY_OAS);
    const merged = mergeSeries([], live);
    expect(merged.every((p) => p.date >= "2023-08-15")).toBe(true);
    expect(merged.some((p) => p.date < "2023-08-15")).toBe(false);
  } finally {
    globalThis.fetch = orig;
  }
});
