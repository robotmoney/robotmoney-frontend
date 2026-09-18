// Public vault identity is independent of deployment addresses and feed order.
// Palette positions match the allocation page's published sleeve order.
import { CATEGORICAL } from "./chart-theme.js";
export const VAULTS = [
  {
    slug: "rmusdc",
    symbol: "rmUSDC",
    name: "Conservative DeFi Yield",
    bucket: "conservative_defi_yield",
    key: "defi-yield",
    color: CATEGORICAL[0],
    strategy: "USDC allocated across lending venues.",
    category: "Lending",
  },
  {
    slug: "rmagent",
    symbol: "rmAGENT",
    name: "Agent Tokens",
    bucket: "agent_tokens",
    key: "agent-tokens",
    color: CATEGORICAL[1],
    strategy: "A basket of tokens from the agent economy.",
    category: "Token basket",
  },
  {
    slug: "rmproto",
    symbol: "rmPROTO",
    name: "Protocol Tokens",
    bucket: "protocol_tokens",
    key: "protocol-tokens",
    color: CATEGORICAL[2],
    strategy: "A basket of protocol tokens.",
    category: "Token basket",
  },
  {
    slug: "rmrwa",
    symbol: "rmRWA",
    name: "Real World Assets",
    bucket: "real_world_assets",
    key: "rwa",
    color: CATEGORICAL[3],
    strategy: "Tokenized exposure to real world assets.",
    category: "Token basket",
  },
];
/** @param {any} v */
export const numberOrNull = (v) =>
  v !== null &&
  v !== undefined &&
  v !== "" &&
  typeof v !== "boolean" &&
  Number.isFinite(Number(v))
    ? Number(v)
    : null;
/** @param {any} v */
export const bps = (v) => {
  const n = numberOrNull(v);
  return n !== null && n >= 0 && n <= 10000 ? n : null;
};
/** @param {any} v */
export const money = (v) =>
  numberOrNull(v) === null
    ? "Not reported"
    : Number(v).toLocaleString("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
/** @param {any} v */
export const weight = (v) =>
  bps(v) === null ? "Not reported" : `${(Number(v) / 100).toFixed(2)}%`;
/** @param {any} v */
export const gapLabel = (v) =>
  numberOrNull(v) === null
    ? "Not reported"
    : `${v > 0 ? "▲ +" : v < 0 ? "▼ −" : ""}${(Math.abs(v) / 100).toFixed(2)} pp`;
/** @param {any} v */
export const dateLabel = (v) =>
  v && Number.isFinite(Date.parse(v))
    ? new Date(v).toLocaleString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "UTC",
      }) + " UTC"
    : "Not reported";
/** @param {any} source */
export function normalizeOverview(source) {
  const rows = VAULTS.map((identity) => {
    const records = (source?.vaults || []).filter(
      (/** @type {any} */ r) => r.slug === identity.slug,
    );
    const raw = records.length === 1 ? records[0] : {};
    const tvl = numberOrNull(raw.tvlUsd);
    return {
      ...raw,
      ...identity,
      availability: raw.availability || "unavailable",
      tvlUsd: tvl !== null && tvl >= 0 ? tvl : null,
      recommendedBps: source?.recommendation ? bps(raw.recommendedBps) : null,
      appliedBps: bps(raw.appliedBps),
    };
  });
  // Confirmed absent vaults contribute zero; unreadable or missing vaults do not.
  const complete = rows.every(
    (r) =>
      r.availability === "not_on_network" ||
      (r.availability === "live" && r.tvlUsd !== null),
  );
  const total = complete
    ? rows.reduce(
        (n, r) => n + (r.availability === "not_on_network" ? 0 : r.tvlUsd),
        0,
      )
    : null;
  const vaults = rows.map((r) => {
    const actual =
      total !== null && total > 0
        ? r.availability === "not_on_network"
          ? 0
          : (r.tvlUsd / total) * 10000
        : null;
    const diff = (/** @type {any} */ a, /** @type {any} */ b) =>
      a === null || b === null ? null : a - b;
    return {
      ...r,
      actualBps: actual,
      gaps: {
        governance: diff(r.appliedBps, r.recommendedBps),
        flow: diff(actual, r.appliedBps),
        total: diff(actual, r.recommendedBps),
      },
    };
  });
  return {
    ...source,
    vaults,
    combined: {
      tvlUsd: total,
      vaultsLive: rows.every((r) =>
        ["live", "not_on_network"].includes(r.availability),
      )
        ? rows.filter((r) => r.availability === "live").length
        : null,
    },
    trackingErrorBps: vaults.every((r) => r.gaps.total !== null)
      ? vaults.reduce((n, r) => n + Math.abs(r.gaps.total), 0) / 2
      : null,
  };
}
/** Match an observed application after publication, never infer from today's weight. @param {any} receipt @param {any[]} history */
export function receiptApplied(receipt, history) {
  const time = Date.parse(receipt.t || receipt.recorded_at);
  const target = bps(receipt.recommendedBps);
  return (
    target !== null &&
    Number.isFinite(time) &&
    history.some(
      (row) => Date.parse(row.t) > time && bps(row.appliedBps) === target,
    )
  );
}
/** Existing Base feed has no router or receipt provenance. @param {any} economics */
export function legacyOverview(economics) {
  return normalizeOverview({
    asOf: economics.asOf,
    legacy: true,
    network: {
      chainId: 8453,
      label: "Base",
      testData: economics.source === "stub",
    },
    freshness: { indexedAt: economics.asOf, stale: economics.stale },
    recommendation: null,
    vaults: VAULTS.map((v) =>
      v.slug === "rmusdc"
        ? {
            slug: v.slug,
            availability: "live",
            address: "0x4f835c9f54bcf17daf9040f60cb72951ccbb49dd",
            tvlUsd: economics.tvlUsd,
            sharePrice: economics.sharePrice,
            holdingsAsOf: economics.asOf,
            holdings: [
              ...(economics.adapters || []).map((/** @type {any} */ a) => ({
                kind: "adapter",
                label: a.name,
                address: a.address,
                valueUsd: a.balanceUsd,
                weightBps:
                  economics.tvlUsd > 0 && numberOrNull(a.balanceUsd) !== null
                    ? (a.balanceUsd / economics.tvlUsd) * 10000
                    : null,
              })),
              {
                kind: "idle",
                label: "Idle USDC",
                valueUsd: economics.idleUsdc,
                balance: economics.idleUsdc,
                weightBps:
                  economics.tvlUsd > 0 &&
                  numberOrNull(economics.idleUsdc) !== null
                    ? (economics.idleUsdc / economics.tvlUsd) * 10000
                    : null,
              },
            ],
            legacyApy7d: economics.apy7d,
          }
        : { slug: v.slug, availability: "not_on_network" },
    ),
  });
}
/** @param {any} row */
export function statusLabel(row) {
  if (row.availability === "not_on_network") return "Not live on this network";
  if (row.availability !== "live") return "Data unavailable";
  if (row.flags?.shutdown) return "Shutdown";
  if (row.status === "retired") return "Retired";
  if (row.status === "paused") return "Paused";
  if (row.flags?.depositsPaused) return "Deposits paused";
  if (row.flags?.withdrawalsPaused) return "Withdrawals paused";
  return row.status === "active" ? "Active" : "Deployed";
}
/** Only trusted chain explorers, never feed-supplied URLs. @param {any} network @param {any} value @param {string} [kind] */
export function explorerLink(network, value, kind = "address") {
  if (
    network?.chainId !== 8453 ||
    !new RegExp(
      kind === "tx" ? "^0x[0-9a-fA-F]{64}$" : "^0x[0-9a-fA-F]{40}$",
    ).test(value || "")
  )
    return null;
  return `https://basescan.org/${kind}/${value}`;
}
