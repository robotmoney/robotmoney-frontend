import { expect, test } from "bun:test";
import {
  VAULTS,
  normalizeOverview,
  legacyOverview,
  receiptApplied,
  bps,
  statusLabel,
  explorerLink,
} from "../../public/assets/js/app/lib/vault-data.js";
import { weightLayers } from "../../public/assets/js/app/components/vaults.js";
import {
  vaultData,
  registerVaultView,
} from "../../public/assets/js/app/alpine/views/vault.js";
import { vaultFixtures } from "../../public/prototypes/vaults/fixtures.js";
import {
  viewFor,
  VAULT_DETAIL_VIEW,
  NOT_FOUND_VIEW,
} from "../../public/assets/js/app/routes.js";
import { metaFor, canonicalUrlFor } from "../../public/assets/js/app/seo.js";
const fixture = (mode) =>
  vaultFixtures(mode)["/api/dashboards/robotmoney-vaults"];
test("three-layer math retains full denominator and signed gaps", () => {
  const d = normalizeOverview(fixture());
  expect(d.combined.tvlUsd).toBe(100000);
  expect(d.vaults[0].actualBps).toBe(7200);
  expect(d.vaults[0].gaps).toEqual({ governance: 500, flow: 200, total: 700 });
  expect(d.trackingErrorBps).toBeCloseTo(700, 8);
});
test("unreadable vault suppresses every actual and total, preserving other readings", () => {
  const d = normalizeOverview(fixture("unreadable"));
  expect(d.combined.tvlUsd).toBeNull();
  expect(
    d.vaults.every((r) => r.actualBps === null && r.gaps.total === null),
  ).toBe(true);
  expect(d.vaults[0].recommendedBps).toBe(6500);
  expect(d.trackingErrorBps).toBeNull();
});
test("unknown recommendation is not zero; empty denominator is not a full allocation", () => {
  expect(
    normalizeOverview(fixture("no-receipt")).vaults.every(
      (r) => r.recommendedBps === null,
    ),
  ).toBe(true);
  expect(
    normalizeOverview(fixture("empty")).vaults.every(
      (r) => r.actualBps === null,
    ),
  ).toBe(true);
  expect(bps(0)).toBe(0);
  expect(bps(null)).toBeNull();
  expect(bps("")).toBeNull();
  expect(bps(-1)).toBeNull();
});
test("missing or duplicate vault records cannot silently change denominator", () => {
  const d = fixture();
  d.vaults.pop();
  expect(normalizeOverview(d).combined.tvlUsd).toBeNull();
  d.vaults.push(d.vaults[0]);
  expect(normalizeOverview(d).combined.tvlUsd).toBeNull();
});
test("Base legacy uses only the known vault and never invents router weights", () => {
  const d = legacyOverview({ tvlUsd: 100, idleUsdc: 0, adapters: [] });
  expect(d.combined.tvlUsd).toBe(100);
  expect(d.vaults[0].actualBps).toBe(10000);
  expect(d.vaults[1].availability).toBe("not_on_network");
  expect(
    d.vaults.every((r) => r.appliedBps === null && r.recommendedBps === null),
  ).toBe(true);
});
test("an application must match after the receipt", () => {
  const r = { t: "2026-09-16T00:00:00Z", recommendedBps: 500 };
  expect(receiptApplied(r, [{ t: "2026-09-15", appliedBps: 500 }])).toBe(false);
  expect(receiptApplied(r, [{ t: "2026-09-17", appliedBps: 500 }])).toBe(true);
  expect(
    receiptApplied({ ...r, recommendedBps: null }, [
      { t: "2026-09-17", appliedBps: null },
    ]),
  ).toBe(false);
});
test("identity colors survive reordered responses", () => {
  const f = fixture();
  f.vaults.reverse();
  expect(normalizeOverview(f).vaults.map((r) => r.color)).toEqual(
    VAULTS.map((r) => r.color),
  );
});
test("slugs resolve to one detail and remain noindex pending launch", () => {
  for (const v of VAULTS) {
    expect(viewFor("/vault/" + v.slug)).toBe(VAULT_DETAIL_VIEW);
    expect(metaFor("/vault/" + v.slug).title).toContain(v.symbol);
    expect(canonicalUrlFor("/vault/" + v.slug)).toBe("https://robotmoney.network/vault/" + v.slug);
    expect(metaFor("/vault/" + v.slug).robots).toBe("noindex, follow");
  }
  expect(viewFor("/vault/nope")).toBe(NOT_FOUND_VIEW);
  expect(viewFor("/vaults/example")).not.toBe(VAULT_DETAIL_VIEW);
});
test("renderers escape names and state readers respect pauses", () => {
  const r = normalizeOverview(fixture()).vaults[0];
  expect(weightLayers({ ...r, symbol: "<img onerror=x>" })).not.toContain(
    "<img",
  );
  expect(statusLabel({ ...r, flags: { depositsPaused: true } })).toBe(
    "Deposits paused",
  );
  expect(explorerLink({ chainId: 918453 }, "0x" + "a".repeat(40))).toBeNull();
});
test("factory imports register successfully and sparse history never draws a line", () => {
  let factory;
  registerVaultView({ data: (name, fn) => (factory = fn) });
  expect(typeof factory).toBe("function");
  const d = vaultData();
  d.vaultOverview = normalizeOverview(fixture());
  d.detail = vaultFixtures()["/api/dashboards/robotmoney-vaults/rmusdc"];
  expect(d.historyPoints()).toHaveLength(3);
  expect(d.chartPath()).toBe("");
  d.historyMetric = "sharePrice";
  expect(d.historyPoints()).toHaveLength(0);
});

import { positionComposition } from '../../public/assets/js/app/components/positions.js';
test('position composition never normalizes incomplete or inconsistent weights', () => {
  const p = [{label:'Known',weightBps:5000,valueUsd:500},{label:'Unknown',weightBps:null,valueUsd:null}];
  expect(positionComposition(p)).not.toContain('class="vp-band"');
  expect(positionComposition([{...p[0],weightBps:12000}])).not.toContain('class="vp-band"');
  expect(positionComposition([{...p[0],label:'<img src=x onerror=alert(1)>',weightBps:10000}])).toContain('&lt;img');
  expect(positionComposition([{...p[0],label:'<img src=x onerror=alert(1)>',weightBps:10000}])).not.toContain('<img');
});
test('an unreadable and an empty vault retain distinct position and history states',()=>{
  const unknown=vaultFixtures('unreadable')['/api/dashboards/robotmoney-vaults/rmproto'];
  expect(unknown.holdings.every(h=>h.valueUsd===null && h.weightBps===null)).toBe(true);
  expect(unknown.history.tvl).toEqual([]);
  const empty=vaultFixtures('empty')['/api/dashboards/robotmoney-vaults/rmusdc'];
  expect(empty.tvlUsd).toBe(0);
  expect(empty.holdings).toEqual([]);
});
test('history selection is bounded and preserves price precision',()=>{
  const d=vaultData(); d.vaultOverview=normalizeOverview(fixture());
  d.detail=vaultFixtures()['/api/dashboards/robotmoney-vaults/rmusdc'];
  expect(d.historySelection().value).toBe(72000);
  d.moveHistory(-1); expect(d.historySelection().value).toBe(57600);
  d.moveHistory(-100); expect(d.selectedObservation).toBe(0);
  d.moveHistory(100); expect(d.selectedObservation).toBe(2);
  d.historyMetric='sharePrice'; d.resetHistory();
  expect(d.historySelection()).toBeNull();
  expect(d.historyValue(1.025)).toBe('$1.0250');
});
