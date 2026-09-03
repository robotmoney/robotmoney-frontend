// projectBriefResearchSignals (issue #869a): a READ-time projection over
// SwarmBrief.body.researchSignals, applied by the /api/swarm/brief route.
// Pure function, no DB needed — the write path (publishBrief) and the DB
// round-trip are covered separately in swarm.test.ts.
import { expect, test } from "bun:test";
import { ROUTES } from "@robotmoney/contract";
import { projectBriefResearchSignals } from "../src/swarm/projections.ts";
import type { SwarmBrief } from "@robotmoney/contract";

function brief(researchSignals: unknown[]): SwarmBrief {
  return {
    id: "b1",
    date: "2026-09-03",
    subjectId: "subj-1",
    sessionId: "sess-1",
    createdAt: "2026-09-03T00:00:00.000Z",
    body: {
      regime: null,
      subject: null,
      recentSessions: [],
      researchSignals,
      prompt: { system: "s", user: "u" },
      takeSchema: {
        stance: { type: "string", enum: [] },
        confidence: { type: "number", minimum: 0, maximum: 1 },
        body: { type: "string" },
        weights: { type: "array", optional: true, items: { bucket: { type: "string" }, weight: { type: "number", minimum: 0 } } },
      },
      windowClosesAt: "2026-09-03T01:00:00.000Z",
      // biome-ignore lint: test fixture matches the persisted body shape, not SwarmBriefBody exactly
    } as any,
  };
}

test("default (no include): embedded payloads become {signalKey, date, href} references", () => {
  const b = brief([
    { signal_key: "channel-divergence", date: "2026-09-03", payload: { title: "x", btc_price: [1, 2, 3] } },
    { signal_key: "late-cycle-signals", date: "2026-09-03", payload: { title: "y" } },
  ]);
  const projected = projectBriefResearchSignals(b, false);
  expect(projected.body!.researchSignals).toEqual([
    { signalKey: "channel-divergence", date: "2026-09-03", href: "/api/dashboards/research-signals/channel-divergence" },
    { signalKey: "late-cycle-signals", date: "2026-09-03", href: "/api/dashboards/research-signals/late-cycle-signals" },
  ]);
  // The href is fetchable at the real route template.
  expect(ROUTES.dashboards.researchSignal.replace(":key", "channel-divergence")).toBe(
    "/api/dashboards/research-signals/channel-divergence",
  );
});

test("includeFull=true: body passes through unchanged, payload intact", () => {
  const b = brief([{ signal_key: "channel-divergence", date: "2026-09-03", payload: { title: "x", btc_price: [1, 2, 3] } }]);
  const projected = projectBriefResearchSignals(b, true);
  expect(projected).toBe(b); // identity — genuinely untouched, not just deep-equal
  expect((projected.body!.researchSignals[0] as any).payload).toEqual({ title: "x", btc_price: [1, 2, 3] });
});

test("empty researchSignals array projects to an empty array either way", () => {
  const b = brief([]);
  expect(projectBriefResearchSignals(b, false).body!.researchSignals).toEqual([]);
  expect(projectBriefResearchSignals(b, true).body!.researchSignals).toEqual([]);
});

test("null body is passed through untouched (no brief for that day/session)", () => {
  const b: SwarmBrief = { id: "b1", date: "2026-09-03", subjectId: "s", sessionId: null, createdAt: "", body: null };
  expect(projectBriefResearchSignals(b, false)).toBe(b);
});

test("a malformed entry (missing signal_key) still projects without throwing", () => {
  const b = brief([{ date: "2026-09-03", payload: {} }]);
  const projected = projectBriefResearchSignals(b, false);
  expect(projected.body!.researchSignals).toEqual([{ signalKey: "", date: "2026-09-03", href: "/api/dashboards/research-signals/" }]);
});
