// Deterministic, backend-free RM_FROZEN data for the hermetic frozen-build tests
// and the offline browser spec. Shapes mirror the real API DTOs so the SAME view
// code renders — the regime snapshot is the committed ground-truth fixture (also
// used by frontend/test/browser/analytics-views.spec.ts); the research payloads
// mirror the shipped gauge contract; committee/comments are minimal-but-real.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { ROUTES, path } from "../../frontend/public/assets/js/app/contract/routes.js";
import type { FrozenData } from "./frozen-build.ts";
import { RESEARCH_KEYS } from "./frozen-endpoints.ts";

const CHANNEL_PAYLOAD = {
  asof: "2026-06-29",
  title: "Channel divergence",
  question: "Is the easy-money → crypto transmission channel breaking down?",
  gauges: [
    { id: "BTC_BETA", name: "BTC beta vs risk appetite", value: 0.412, percentile: 0.55, read: "softening" },
    { id: "BTC_QQQ_RATIO", name: "BTC/QQQ relative strength", value: 0.62, percentile: 0.71, read: "channel intact" },
    { id: "STABLES_QQQ_FLOW", name: "Stablecoin vs QQQ flow (90d)", value: 0.0137, percentile: 0.21, read: "breaking down" },
    { id: "CHANNEL", name: "Composite channel health", value: 0.49, percentile: 0.49, read: "softening" },
  ],
  series: {
    label: "BTC/QQQ ratio",
    points: [
      { date: "2026-06-27", value: 0.61 },
      { date: "2026-06-28", value: 0.62 },
      { date: "2026-06-29", value: 0.63 },
    ],
  },
  indicators: {
    btc_beta_vs_risk_appetite: [{ date: "2026-06-28", value: 0.41 }, { date: "2026-06-29", value: 0.412 }],
    btc_qqq_ratio_percentile: [{ date: "2026-06-28", value: 0.7 }, { date: "2026-06-29", value: 0.71 }],
    stables_vs_qqq_flow: [{ date: "2026-06-28", value: 0.012 }, { date: "2026-06-29", value: 0.0137 }],
  },
};

const LATECYCLE_PAYLOAD = {
  asof: "2026-06-29",
  title: "Late-cycle signals",
  question: "How late in the cycle is this rally?",
  gauges: [
    { id: "CONCENTRATION", name: "Index concentration (SPY/RSP)", value: 1.2841, percentile: 0.88, read: "saturated (late-cycle)" },
    { id: "TOP7_VS_SPY", name: "Top-7 basket vs SPY", value: 1.8342, percentile: 0.91, read: "saturated (late-cycle)" },
    { id: "MNA", name: "M&A activity (S-4 filings)", value: 42, percentile: 0.63, read: "elevated" },
    { id: "MARGIN", name: "Margin debt YoY", value: 0.1523, percentile: 0.74, read: "saturated (late-cycle)" },
    { id: "CONF", name: "Consumer confidence (UMich)", value: 61.7, percentile: 0.32, read: "benign" },
  ],
  series: {
    label: "Index concentration (SPY/RSP)",
    points: [
      { date: "2026-06-27", value: 1.27 },
      { date: "2026-06-28", value: 1.28 },
      { date: "2026-06-29", value: 1.2841 },
    ],
  },
  indicators: {
    concentration_top7_vs_spy: [{ date: "2026-06-28", value: 1.83 }, { date: "2026-06-29", value: 1.8342 }],
    mna_pct: [{ date: "2026-06-28", value: 0.62 }, { date: "2026-06-29", value: 0.63 }],
  },
};

const RESEARCH_PAYLOADS: Record<string, unknown> = {
  "channel-divergence": CHANNEL_PAYLOAD,
  "late-cycle-signals": LATECYCLE_PAYLOAD,
};

// Map the committed snake_case regime snapshot to the { latest, history } DTO the
// regimeView() factory consumes — identical to analytics-views.spec.ts.
function loadRegime(repoRoot: string): { latest: unknown; history: unknown[] } {
  const gz = join(repoRoot, "backend/tests/fixtures/regime/regime-snapshot.json.gz");
  const snap = JSON.parse(gunzipSync(readFileSync(gz)).toString("utf8"));
  const latest = {
    date: snap.asof,
    composite: snap.composite,
    compositePercentile: snap.composite_percentile,
    regime: snap.regime,
    macroRegime: snap.macro_regime,
    onchainRegime: snap.onchain_regime,
    macroIndex: snap.macro_index,
    onchainIndex: snap.onchain_index,
    macroPercentile: snap.macro_percentile,
    onchainPercentile: snap.onchain_percentile,
    version: "v3",
    indicators: snap.indicators,
  };
  const history = (snap.history ?? [])
    .map((h: { date: string; composite: number }) => ({ date: h.date, composite: h.composite }))
    .slice(-180);
  return { latest, history };
}

const SESSION_DATE = "2026-06-29";
const SESSION_SUBJECT = "woon";
const SESSION_SUBJECT_NAME = "Woon Treasury";

const MEMBERS = [
  { id: "athena", name: "Athena", lens: "macro & liquidity", tagline: "Macro strategist", mandate: "Reads the macro regime.", activatedAt: "2026-05-01T00:00:00Z" },
  { id: "apollo", name: "Apollo", lens: "on-chain flows", tagline: "On-chain analyst", mandate: "Tracks stablecoin flows.", activatedAt: "2026-05-04T00:00:00Z" },
  { id: "hermes", name: "Hermes", lens: "volatility", tagline: "Vol trader", mandate: "Watches term structure.", activatedAt: "2026-05-08T00:00:00Z" },
];

const TAKES = [
  { id: 1, memberId: "athena", memberName: "Athena", stance: "risk_on", confidence: 0.72, verified: true, memoUrl: "", body: "Macro backdrop supports risk." },
  { id: 2, memberId: "apollo", memberName: "Apollo", stance: "neutral", confidence: 0.55, verified: true, memoUrl: "", body: "Flows are mixed; stay balanced." },
  { id: 3, memberId: "hermes", memberName: "Hermes", stance: "risk_off", confidence: 0.61, verified: true, memoUrl: "", body: "Vol is cheap; hedge here." },
];

/**
 * The full RM_FROZEN map for a hermetic build. Keyed by pathname exactly as the
 * frozen fetch shim looks them up.
 */
export function fixtureFrozenData(repoRoot: string): FrozenData {
  const data: FrozenData = {};
  data[ROUTES.health] = { status: "ok", env: "frozen", db: "up" };
  data[ROUTES.dashboards.regimeSnapshots] = loadRegime(repoRoot);
  for (const key of RESEARCH_KEYS) {
    data[path(ROUTES.dashboards.researchSignal, { key })] = {
      signalKey: key,
      date: "2026-06-29",
      payload: RESEARCH_PAYLOADS[key],
    };
  }
  data[ROUTES.committee.sessions] = {
    sessions: [
      { id: 1, date: SESSION_DATE, subjectId: SESSION_SUBJECT, subjectName: SESSION_SUBJECT_NAME, state: "published" },
    ],
  };
  data[path(ROUTES.committee.session, { date: SESSION_DATE, subject: SESSION_SUBJECT })] = {
    session: {
      id: 1,
      date: SESSION_DATE,
      subjectId: SESSION_SUBJECT,
      subjectName: SESSION_SUBJECT_NAME,
      state: "published",
      committeeRecommendation: {
        quorum: { submitted: 3, active: 3 },
        stances: { risk_on: 1, neutral: 1, risk_off: 1 },
        absent: [],
      },
    },
    takes: TAKES,
  };
  data[ROUTES.committee.members] = { members: MEMBERS };
  for (const m of MEMBERS) {
    data[path(ROUTES.committee.member, { id: m.id })] = m;
  }
  data[ROUTES.committee.brief] = {
    body: { thesis: "Woon treasury remains diversified across three buckets.", horizon: "quarterly" },
  };
  data[ROUTES.comments.list] = {
    comments: [
      { id: 1, page: "home", author: "satoshi", content: "Fascinating experiment.", createdAt: "2026-06-28T12:00:00Z" },
      { id: 2, page: "home", author: "vitalik", content: "Watching the regime signals closely.", createdAt: "2026-06-29T09:30:00Z" },
    ],
  };
  return data;
}
