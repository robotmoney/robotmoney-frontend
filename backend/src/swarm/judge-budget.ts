// THE JUDGE'S BUDGET, AND WHAT A DEGRADED JUDGE IS ALLOWED TO DO TO A GATE.
//
// A LEAF ON PURPOSE. judge.ts reaches domain.ts, which reaches config.ts and
// the db client — so the smoke driver (scripts/lib/swarm/session.ts) could not
// derive its judge ceiling from the budget without dragging the backend's
// database wiring into a CLI at import time. Everything here is a constant or a
// pure function over tallies, so every surface that must agree about the budget
// and about the fallback share can import THE SAME one.
//
// ── The fallback share, and decision D15 ─────────────────────────────────────
//
// AC-FE-05 makes deterministic fallback prose a FEATURE: when the model
// misbehaves, the judging still produces a labelled, reproducible opinion and
// the session still publishes. That is why no gate in this release looked at
// it — and why a stack in PERMANENT fallback passed every one of them. A
// fallback receipt is still a published receipt with four weights, so
// `/version`, the weights total, `missingReceipts.count == 0` and all four
// postflight checks were green on a stack where every enforce session
// published template prose under the judge's name (run-1 §E.3 + this run's
// 1.12 finding: DEFAULT_JUDGE_TIMEOUT_MS = 60_000 against a pinned model that
// answers the real prompt in ~112 s).
//
// D15 is the policy, and it is deliberately narrow in BOTH directions:
//
//   * REPORT ALWAYS. The share and the reasons are recorded on every run, so a
//     degrading stack is visible long before it is disqualifying — and so a
//     misconfigured BUDGET cannot masquerade as an upstream outage, which is
//     exactly what happened here (R17's "make the fallback rate an alert").
//   * FAIL ONLY AT 100 % over the window. A stack that has never ONCE reached
//     the model is not producing acceptance evidence (AC-MODEL-01). A stack
//     that reached it and was let down some of the time is degraded, and
//     blocking a rollout during a real upstream outage is not this check's job.
//
// Pure, and shared: the postflight check, the rehearsal and the admin overview
// each run their own query (postflight-utils.ts's standalone rule) and hand the
// tallies here, so the three surfaces cannot drift on what the number means.

/**
 * THE PER-CALL MODEL BUDGET, AND WHY IT IS THIS NUMBER.
 *
 * It was 60_000, and that is the whole of run-1 §E.3 / this run's 1.12 finding:
 * the pinned model (`deepseek-v4-flash` over Zen) ANSWERS the real judge prompt
 * — correctly, ~2.5 kB of it — in 58 s to 175 s, measured inside the
 * judge participant container against the funded key. The 60 s default was under the
 * FASTEST of those. So every enforce session aborted at 60 s, was classified
 * `model_timeout` (correctly),
 * and published deterministic fallback prose under the judge's name. Nothing
 * was misconfigured except this constant, and no gate could see it.
 *
 * 300 s is 1.7x the WORST of the three real-prompt measurements on record and
 * ~2.7x the median: the latency is highly variable (58 s, 112 s and 175 s on
 * three-take prompts across two days), so the budget is sized against the bad
 * day, not the good one. It is still far inside the swarm lane's job budget,
 * and JUDGE_WAIT_MS derives from it rather than restating it. It is the
 * DEFAULT,
 * not a ceiling — `SWARM_JUDGE_TIMEOUT_MS` overrides it, and now actually
 * reaches the container through the documented boot (DEMO_COMPOSE_PASSTHROUGH;
 * runbook §2/§4).
 *
 * A budget is not a latency target: raising it cannot make a judging slower, it
 * can only stop one that would have succeeded from being thrown away.
 */
export const DEFAULT_JUDGE_TIMEOUT_MS = 300_000;

/** The window both the alert and the postflight check ask about. */
export const JUDGE_FALLBACK_LOOKBACK_DAYS = 7;

/**
 * The pinned model's MEASURED latency on the real judge prompt, in ms.
 *
 * Not an estimate and not a guess at a vendor SLA. Measured inside the
 * judge participant container against the funded key, through the application's own
 * buildJudgeInput/renderJudgePrompt/resolveJudgeTransport, on three real
 * three-take prompts across two days: 58.1 s, 112.1 s and 174.9 s (run-1
 * `phase1-rc2/1.12-judge-timeout-FINDING.txt`, run-2
 * `phase4-frontend/F4/T18-judge-latency-measurement.txt`).
 *
 * This constant is the WORST of them, deliberately: a budget sized on the
 * median is a budget that fails on the day it matters. It lives here rather
 * than in a comment so that lowering DEFAULT_JUDGE_TIMEOUT_MS back under the
 * measurement has to delete an assertion to do it
 * (tests/judge-budget-fallback-rate.test.ts).
 */
export const MEASURED_PINNED_JUDGE_LATENCY_MS = 174_902;

export interface JudgeSourceTally {
  /** `model` or `fallback` — swarm_session_judgements.source. */
  source: string;
  /** Null for a model row; the bounded reason for a fallback row. */
  fallbackReason: string | null;
  n: number;
}

export type JudgeFallbackVerdict = "PASS" | "WARN" | "FAIL";

export interface JudgeFallbackSummary {
  total: number;
  model: number;
  fallback: number;
  /** fallback / total, or 0 for an empty window. */
  share: number;
  /** Reasons, most frequent first — the WHY, so nobody has to write SQL for it. */
  reasons: { reason: string; n: number }[];
  verdict: JudgeFallbackVerdict;
  detail: string;
}

export function summarizeJudgeSources(rows: readonly JudgeSourceTally[]): JudgeFallbackSummary {
  let total = 0;
  let fallback = 0;
  const byReason = new Map<string, number>();
  for (const r of rows) {
    const n = Number(r.n) || 0;
    total += n;
    if (r.source === "fallback") {
      fallback += n;
      const reason = (r.fallbackReason ?? "").trim() || "(unrecorded)";
      byReason.set(reason, (byReason.get(reason) ?? 0) + n);
    }
  }
  const reasons = [...byReason.entries()]
    .map(([reason, n]) => ({ reason, n }))
    // Frequency first, then name, so the ordering is total and the detail
    // string is stable enough to diff between two postflight runs.
    .sort((a, b) => b.n - a.n || a.reason.localeCompare(b.reason));
  const share = total === 0 ? 0 : fallback / total;
  const pct = `${(share * 100).toFixed(1)} %`;
  const because = reasons.length ? ` (${reasons.map((r) => `${r.reason} x${r.n}`).join(", ")})` : "";

  if (total === 0) {
    return { total, model: 0, fallback, share, reasons, verdict: "WARN",
      detail: `no judgement rows in the last ${JUDGE_FALLBACK_LOOKBACK_DAYS} day(s) — the judge has produced nothing to assess` };
  }
  if (fallback === total) {
    return { total, model: total - fallback, fallback, share, reasons, verdict: "FAIL",
      detail: `ALL ${total} judgement(s) in the last ${JUDGE_FALLBACK_LOOKBACK_DAYS} day(s) are deterministic fallback${because} — ` +
        "this stack has never once reached the model in the window, so it is not producing acceptance evidence (AC-MODEL-01, decision D15)" };
  }
  if (fallback > 0) {
    return { total, model: total - fallback, fallback, share, reasons, verdict: "WARN",
      detail: `${fallback} of ${total} judgement(s) (${pct}) fell back in the last ${JUDGE_FALLBACK_LOOKBACK_DAYS} day(s)${because} — ` +
        "reported, not blocking: a model was reached for the rest (AC-FE-05, decision D15)" };
  }
  return { total, model: total, fallback, share, reasons, verdict: "PASS",
    detail: `all ${total} judgement(s) in the last ${JUDGE_FALLBACK_LOOKBACK_DAYS} day(s) were authored by the model` };
}
