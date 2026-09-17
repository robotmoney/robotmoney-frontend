// @ts-nocheck — buildless DOM rendering; contract and behavior are validated by research tests.
import { sleeves } from "../components/research.js";
export function vector(input, { normalize = false } = {}) {
  if (Array.isArray(input)) {
    if (input.length !== 4 || new Set(input.map((x) => x?.bucket)).size !== 4)
      return null;
    input = Object.fromEntries(input.map((x) => [x.bucket, x.weight]));
  }
  const v = sleeves.map((s) => input?.[s.key]);
  if (v.some((x) => typeof x !== "number" || !Number.isFinite(x) || x < 0))
    return null;
  const total = v.reduce((a, b) => a + b, 0);
  if (total <= 0 || (!normalize && Math.abs(total - 1) > 0.0002)) return null;
  return v.map((x) => (x / (normalize ? total : 1)) * 100);
}
export function adapt(raw, brief, members = {}, mode = "archive") {
  const takes = raw.takes || [];
  raw = raw.session ? { ...raw.session, takes } : raw;
  brief = brief?.body ?? brief;
  if (!brief && raw.referenceAllocation) brief = { allocation: raw.referenceAllocation };
  const rec = raw.swarmRecommendation || raw.committee_recommendation || {},
    date = raw.date;
  const reference = brief?.allocation?.buckets
    ? vector(
        Object.fromEntries(
          brief.allocation.buckets.map((b) => [b.id, b.target_weight]),
        ),
      )
    : null;
  return {
    id: raw.id || date,
    date,
    subjectId: raw.subjectId || raw.subject_id,
    mode,
    state: raw.state || "published",
    takeCount: raw.takeCount ?? (raw.takes || []).length,
    generatedAt: raw.generated_at || raw.generatedAt,
    publishedAt: raw.publishedAt || raw.published_at || null,
    weights: vector(rec.weights),
    reference,
    referenceAsOf: reference ? brief.allocation.asof : null,
    within: rec.within_bucket_weights || {},
    buckets: brief?.allocation?.buckets || [],
    rationale: rec.rationale || "",
    synthesis: raw.synthesis || "",
    consensus: rec.consensus || [],
    disagreements: rec.disagreements || [],
    regime: raw.regime_summary || raw.regimeSummary || {},
    takes: (raw.takes || []).map((t, i) => ({
      id: t.id || t.member_id || String(i),
      memberId: t.member_id || t.memberId,
      memberHandle: t.memberHandle || t.member_id || t.memberId,
      verified: t.verified === true,
      archival: mode === "archive" || t.archival === true,
      name:
        t.member_name ||
        t.memberName ||
        members[t.member_id]?.name ||
        t.member_id ||
        "Unnamed analyst",
      lens: members[t.member_id || t.memberId]?.lens || "",
      stance: t.stance,
      confidence: t.confidence,
      body: t.body || "",
      weights: vector(t.weights, { normalize: true }),
    })),
    source: mode === "live" ? `/api/swarm/sessions/${encodeURIComponent(raw.id)}` : `/data/swarm/sessions/${date}-robotmoney-allocation.json`,
    brief: brief
      ? mode === "live" ? `/api/swarm/brief?session=${encodeURIComponent(raw.id)}` : `/data/swarm/briefs/${date}-robotmoney-allocation.json`
      : null,
  };
}
export function stressRecords(records) {
  return Array.from({ length: 96 }, (_, i) => {
    const source = records[i % records.length],
      date = new Date(
        Date.UTC(2026, 8, 17, 18) - i * 6 * 3600000,
      ).toISOString();
    const takes = Array.from({ length: 12 }, (_, j) => {
      const original = source.takes[j % source.takes.length],
        a = 58 + (j % 4) * 4 + (i % 4) * 2,
        b = 8 + (j % 3) * 2,
        c = 6 + (j % 2) * 2;
      return {
        ...original,
        id: `test-${j + 1}`,
        memberId: `test-${j + 1}`,
        name: `Test analyst ${String(j + 1).padStart(2, "0")}${j === 7 ? " · Cross-asset and machine-economy research" : ""}`,
        weights: j === 10 ? null : [a, b, c, 100 - a - b - c],
        confidence: j === 11 ? null : original.confidence,
        body:
          j === 0 ? Array(4).fill(original.body).join("\n\n") : original.body,
      };
    });
    const valid = takes.filter((t) => t.weights),
      weights = sleeves.map(
        (_, k) => valid.reduce((n, t) => n + t.weights[k], 0) / valid.length,
      );
    return {
      ...source,
      id: `scale-${96 - i}`,
      date,
      mode: "stress",
      sourceDate: source.date,
      reference: null,
      referenceAsOf: null,
      takes,
      weights,
      synthesis:
        i === 0
          ? Array(4).fill(source.synthesis).join("\n\n")
          : source.synthesis,
    };
  });
}
