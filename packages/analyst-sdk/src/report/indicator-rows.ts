// The per-indicator row detail on the asof regime row (issue 1751). Pure.
import { INDICATORS, fillMaxAgeDays, fillPolicyOf } from "../analyze/indicators.ts";
import type { RegimeComputeResult } from "../analyze/compute.ts";

const nn = (v: number | undefined): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

export function buildRichIndicators(
  i: number,
  r2: RegimeComputeResult,
  r3: RegimeComputeResult,
  transformed: Record<string, number[]>,
  lastRaw: Record<string, { date: string; value: number } | null>,
  dateAxis: string[],
  ages: Record<string, number[]> = {},
) {
  return INDICATORS.map((ind) => {
    const weight =
      ind.panel === "factor" ? r3.weightsByPanel.factor?.[ind.id] : r2.weightsByPanel[ind.panel]?.[ind.id];
    // #402: surface the forward-fill age/expiry alongside the existing raw_date
    // provenance so an indicator whose contribution has been capped reads as
    // visibly degraded — not silently dropped — in the same snapshot payload the
    // dashboard already renders raw_value/raw_date from.
    const ageDays = ages[ind.id]?.[i];
    const forwardFillExpired = Number.isFinite(ageDays) && (ageDays as number) > fillMaxAgeDays(fillPolicyOf(ind));
    return {
      id: ind.id,
      name: ind.name,
      panel: ind.panel,
      source: ind.source,
      // The upstream permalink and the one-line "what it is" have been carried
      // on every INDICATORS entry all along, and the dashboard has read both
      // for as long — /regime's source label is wrapped in `x-if="ind.source_url"`
      // and its row tooltip wants the prose. Neither was ever serialised here,
      // so the source label rendered as inert text and the tooltip had nothing
      // to say but the sign convention. The vendored eq-snapshot fixture DOES
      // carry them, which is why the Playwright baseline showed a linked "FRED"
      // production never had.
      source_url: ind.source_url ?? null,
      description: ind.description ?? null,
      sign: ind.sign,
      transform: ind.transform,
      unit: ind.unit ?? null,
      raw_value: lastRaw[ind.id]?.value ?? null,
      raw_date: lastRaw[ind.id]?.date ?? null,
      transformed_value: nn(transformed[ind.id]?.[i]),
      percentile: nn(r2.ranks[ind.id]?.[i]),
      signed_percentile: nn(r2.signed[ind.id]?.[i]),
      panel_weight: weight ?? null,
      forward_fill_age_days: Number.isFinite(ageDays) ? ageDays : null,
      forward_fill_expired: forwardFillExpired,
      sparkline: monthlySparkline(r2.signed[ind.id], dateAxis, 24),
    };
  });
}

// Trailing `months` calendar months → the last finite value in each month
// (oldest → newest). Missing months become null. Ported from update.js.
export function monthlySparkline(series: number[] | undefined, dateAxis: string[], months: number): (number | null)[] {
  if (!series || series.length === 0) return [];
  const lastDate = dateAxis[dateAxis.length - 1];
  const [ly, lm] = lastDate.split("-").map(Number);
  const monthLast = new Map<string, number>();
  for (let i = 0; i < dateAxis.length; i++) {
    const v = series[i];
    if (!Number.isFinite(v)) continue;
    monthLast.set(dateAxis[i].slice(0, 7), v);
  }
  const out: (number | null)[] = [];
  for (let k = months - 1; k >= 0; k--) {
    let y = ly;
    let m = lm - k;
    while (m <= 0) { m += 12; y -= 1; }
    const ym = `${y}-${String(m).padStart(2, "0")}`;
    const v = monthLast.get(ym);
    out.push(typeof v === "number" && Number.isFinite(v) ? v : null);
  }
  return out;
}
