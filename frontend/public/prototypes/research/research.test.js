import { test, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import { adapt, vector, stressRecords } from "./data.js";
import {
  stance,
  prose,
  delta,
  sleeves,
} from "../../assets/js/app/components/research.js";
import { subjectPage, sessionPage } from "./pages.js";
const raw = JSON.parse(
  await readFile(
    new URL(
      "../../data/swarm/sessions/2026-06-24-robotmoney-allocation.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const brief = JSON.parse(
  await readFile(
    new URL(
      "../../data/swarm/briefs/2026-06-24-robotmoney-allocation.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const record = adapt(raw, brief);
test("a dated brief supplies the reference; its absence does not use current policy", () => {
  expect(record.reference).toEqual([95, 5, 0, 0]);
  expect(record.weights).toEqual([95, 3, 0, 2]);
  expect(adapt(raw, null).reference).toBeNull();
});
test("missing analyst weights remain missing and archived text is preserved", () => {
  expect(record.takes[0].weights).toBeNull();
  expect(record.takes[0].body).toBe(raw.takes[0].body);
});
test("raw take arrays normalize; incomplete, duplicate and invalid vectors are rejected", () => {
  expect(
    vector(
      sleeves.map((s, i) => ({ bucket: s.key, weight: [95, 5, 0, 0][i] })),
      { normalize: true },
    ),
  ).toEqual([95, 5, 0, 0]);
  expect(vector({ conservative_defi_yield: 1 })).toBeNull();
  expect(
    vector(sleeves.map((s) => ({ bucket: s.key, weight: NaN }))),
  ).toBeNull();
  expect(
    vector(Array(4).fill({ bucket: sleeves[0].key, weight: 0.25 })),
  ).toBeNull();
});
test("stance distinguishes absent and unrecognized source values from neutral", () => {
  expect(stance(null)).toContain("Stance unavailable");
  expect(stance("undecided")).toContain("Unrecognized stance");
  expect(stance("neutral")).not.toContain("Unavailable");
});
test("financial changes use pp and preserve a known zero", () => {
  expect(delta(3, 5)).toContain("−2 pp");
  expect(delta(0, 0)).toContain("0 pp");
  expect(delta(null, 5)).toContain("Unavailable");
});
test("archive formatting escapes HTML and retains citation links", () => {
  const html = prose(
    "**REGIME**\n- <script>alert(1)</script>\n- Read /blog/regime-conservative-aggressive",
  );
  expect(html).not.toContain("<script>");
  expect(html).toContain("&lt;script&gt;");
  expect(html).toContain("<li>");
  expect(html).toContain('href="/blog/regime-conservative-aggressive"');
});
test("96 uniquely addressable scale sessions include missing fields and long text", () => {
  const records = stressRecords([record]);
  expect(records).toHaveLength(96);
  expect(new Set(records.map((r) => r.id)).size).toBe(96);
  for (const r of records) {
    expect(r.takes).toHaveLength(12);
    expect(r.weights.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 8);
    expect(r.takes[10].weights).toBeNull();
    expect(r.takes[11].confidence).toBeNull();
  }
  expect(records[0].takes[0].body.length).toBeGreaterThan(6000);
});
test("HTML includes complete analyst text without client execution and distinct policy semantics", () => {
  const html = sessionPage(record, [record]);
  expect(html).toContain("WITHIN-BUCKET");
  expect(html).toContain('id="take-athena"');
  expect(html).toContain("Session JSON");
  expect(subjectPage([record], "archive")).toContain(
    "flagship allocation policy",
  );
});

import {
  donutPaths,
  sleeveAssets,
  allocationExplorer,
} from "../../assets/js/app/components/allocation-explorer.js";
test("donut preserves zero slices and rejects incomplete or invalid totals", () => {
  expect(donutPaths([95, 3, 0, 2])[2]).toBe("");
  expect(donutPaths([100, 0, 0, 0])[0]).toContain("A102,102");
  expect(donutPaths([50, 30, 10, 0])).toEqual([]);
  expect(donutPaths([100, -1, 0, 1])).toEqual([]);
  expect(donutPaths([NaN, 0, 0, 0])).toEqual([]);
});
test("asset breakdown distinguishes sleeve share from whole-allocation share", () => {
  const [asset] = sleeveAssets(
    { morpho: 0.35 },
    { items: [{ id: "morpho", name: "Morpho" }] },
    95,
  );
  expect(asset).toEqual({
    id: "morpho",
    name: "Morpho",
    sleeve: 35,
    allocation: 33.25,
  });
  expect(sleeveAssets({ btc: 0.5 }, null, 0)[0].allocation).toBe(0);
  expect(sleeveAssets({ btc: 0.5 }, null, null)[0].allocation).toBe(null);
});
test("both explorer variants preserve zero-sleeve access without drawing a zero mark", () => {
  for (const variant of ["donut", "bar"]) {
    const html = allocationExplorer({
      id: "test-" + variant,
      values: [95, 3, 0, 2],
      within: { protocol_tokens: { btc: 0.5 } },
      variant,
    });
    expect(html).toContain("Protocol Tokens</span><b>0%");
    expect(html).toContain("No allocation proposed.");
    expect(html).not.toContain('data-sleeve="2" data-mark="series"');
    expect(html).toContain("% of allocation");
  }
});
test("explorer preserves missing details and escapes asset names", () => {
  const html = allocationExplorer({
    id: "safe",
    values: [100, 0, 0, 0],
    within: { conservative_defi_yield: { "<script>": 1 } },
  });
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain("<script>");
  expect(html).toContain("Asset-level recommendations were not published");
});

import { conceptTip } from "../../assets/js/app/components/research.js";
import { catalogue } from "./pages.js";
test("concept help uses named definitions and escapes labels", () => {
  expect(conceptTip("pp", "delta-help", { label: "<Change>" })).toContain(
    "&lt;Change&gt;",
  );
  expect(conceptTip("pp", "delta-help")).toContain(
    'aria-describedby="delta-help"',
  );
  expect(conceptTip("pp", "delta-help")).toContain(
    "decrease of 2 percentage points",
  );
  expect(() => conceptTip("invented", "help")).toThrow();
});
test("each page links concept triggers to unique descriptions", () => {
  for (const html of [
    subjectPage([record], "archive"),
    sessionPage(record, [record]),
    catalogue(record),
  ]) {
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((x) => x[1]);
    expect(new Set(ids).size).toBe(ids.length);
    for (const [, target] of html.matchAll(/aria-describedby="([^"]+)"/g))
      expect(ids).toContain(target);
  }
});
