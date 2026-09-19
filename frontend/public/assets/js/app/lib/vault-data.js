// The four Robot Money vaults as data: who they are, and the arithmetic that
// sets each one's recommended, applied and actual weight against the others.
//
// The stack is a PortfolioRouter plus four leg vaults, one per sleeve. The
// router routes new deposits by its applied weights and holds nothing itself.
// Production runs rmUSDC alone on Base; the other three exist on the staging
// devnet only, until the mainnet decision.
//
// PURE: no fetching, no DOM, no page state. lib/vault-source.js does the I/O
// and picks the data source; /allocation, /vault/:slug and the vault swarm
// subject all read one overview shape, the documented
// /api/dashboards/robotmoney-vaults DTO, through normalizeOverview() below.
//
// Every weight here is in basis points (0 to 10000). null is never 0: a layer
// nobody reported stays null, prints "—", and is never renormalised into a
// complete-looking allocation.
import { CATEGORICAL } from "./chart-theme.js";
import { changeClass, changeLabel, fmtPctTrim } from "./weight-change.js";
import { BUCKET_NOTES } from "./sleeve-notes.js";

/**
 * @typedef {object} VaultIdentity
 * @property {string} slug        URL slug, never an address (staging addresses reset).
 * @property {string} symbol      The receipt token.
 * @property {string} name        The sleeve the vault implements.
 * @property {string} bucket      The framework's bucket id.
 * @property {string} key         The allocation DTO's bucket key.
 * @property {string} color       CATEGORICAL by published position: one hue everywhere.
 * @property {string} category
 * @property {string | null} baseAddress  The production contract on Base, where one exists.
 */

/**
 * @typedef {"live" | "not_on_network" | "unavailable"} Availability
 * @typedef {{ governance: number | null, flow: number | null, total: number | null }} Gaps
 * @typedef {{ chainId: number | null, label: string, testData: boolean }} Network
 * @typedef {{ address: string | null, availability: Availability, appliedAt: string | null }} Router
 * @typedef {{ sessionId: string | null, publishedAt: string | null, releasedOnChain: boolean | null, date?: string | null, href?: string | null, subjectId?: string | null }} Recommendation
 */

/**
 * One vault as every page reads it: its identity, what the source reported,
 * and the recomputed layers. Detail fields (holdings, history, ...) ride along
 * untouched when the source put them on the row.
 * @typedef {Record<string, any> & VaultIdentity & {
 *   availability: Availability,
 *   status: string | null,
 *   address: string | null,
 *   tvlUsd: number | null,
 *   sharePrice: number | null,
 *   exitFeeBps: number | null,
 *   recommendedBps: number | null,
 *   appliedBps: number | null,
 *   actualBps: number | null,
 *   gaps: Gaps,
 * }} VaultRow
 */

/**
 * @typedef {Record<string, any> & {
 *   asOf: string | null,
 *   network: Network | null,
 *   freshness: { blockNumber?: number | null, indexedAt?: string | null, stale?: boolean } | null,
 *   router: Router | null,
 *   recommendation: Recommendation | null,
 *   vaults: VaultRow[],
 *   combined: { tvlUsd: number | null, vaultsLive: number | null },
 *   trackingErrorBps: number | null,
 * }} Overview
 */

// In the framework's published bucket order (session-summary.js BUCKET_ORDER),
// so VAULTS[i].color === CATEGORICAL[i] === bucketHue(VAULTS[i].bucket).
/** @type {VaultIdentity[]} */
export const VAULTS = [
  {
    slug: "rmusdc",
    symbol: "rmUSDC",
    name: "Conservative DeFi Yield",
    bucket: "conservative_defi_yield",
    key: "defi-yield",
    color: CATEGORICAL[0],
    category: "Lending",
    // The ERC-4626 vault on Base; source of truth frontend/public/skill.md.
    baseAddress: "0x4f835c9f54bcf17daf9040f60cb72951ccbb49dd",
  },
  {
    slug: "rmagent",
    symbol: "rmAGENT",
    name: "Agent Tokens",
    bucket: "agent_tokens",
    key: "agent-tokens",
    color: CATEGORICAL[1],
    category: "Token basket",
    baseAddress: null,
  },
  {
    slug: "rmproto",
    symbol: "rmPROTO",
    name: "Protocol Tokens",
    bucket: "protocol_tokens",
    key: "protocol-tokens",
    color: CATEGORICAL[2],
    category: "Token basket",
    baseAddress: null,
  },
  {
    slug: "rmrwa",
    symbol: "rmRWA",
    name: "Real World Assets",
    bucket: "real_world_assets",
    key: "rwa",
    color: CATEGORICAL[3],
    category: "Token basket",
    baseAddress: null,
  },
];

export const VAULT_SLUGS = VAULTS.map((v) => v.slug);

// The four-vault read the backend will serve (Lucas's lane). Deliberately not
// in contract ROUTES until it exists: vault-source.js probes it and falls back.
export const VAULTS_ENDPOINT = "/api/dashboards/robotmoney-vaults";

// What each sleeve IS, keyed on the allocation DTO's bucket key: the swarm
// pages' sleeve notes (lib/sleeve-notes.js), so each vault page's lede and
// every (i) tip on a sleeve, /allocation's recipe included, say the same thing.
/** @type {Record<string, string>} */
export const SLEEVE_NOTE = {
  "defi-yield": BUCKET_NOTES.conservative_defi_yield,
  "agent-tokens": BUCKET_NOTES.agent_tokens,
  "protocol-tokens": BUCKET_NOTES.protocol_tokens,
  rwa: BUCKET_NOTES.real_world_assets,
};

// vault-economics serves the protocol name only ("Morpho"), but Morpho's
// position is a specific curated vault, and saying so is the difference
// between three lending venues and two pooled markets plus a vault somebody
// else sets the caps on. An adapter not in this map keeps its own name.
/** @type {Record<string, { label: string, venueType: string }>} */
export const ADAPTER_DISPLAY = {
  aave: { label: "Aave V3 USDC", venueType: "Pooled market" },
  morpho: { label: "Gauntlet USDC Prime", venueType: "Curated vault" },
  compound: { label: "Compound III USDC", venueType: "Pooled market" },
};

// A position in the vault swarm subject's book by the name its vault page
// gives it: rmUSDC's adapters by their ADAPTER_DISPLAY label (the archive
// reads them as MORPHO, AAVE, COMPOUND), a vault's USDC as "Idle USDC", and
// anything else by its own name, else its token.
/** @param {any} position @param {unknown} [vaultSlug] */
export function positionName(position, vaultSlug) {
  const token = String(position?.token ?? position?.symbol ?? "");
  if (String(vaultSlug ?? "").toLowerCase() === "rmusdc") {
    const adapter = ADAPTER_DISPLAY[token.toLowerCase()];
    if (adapter) return adapter.label;
  }
  if (vaultSlug && token.toUpperCase() === "USDC") return "Idle USDC";
  return String(position?.name || token || "—");
}

const BASE_CHAIN_ID = 8453;
const DAY_MS = 86400000;

/** @param {unknown} v */
const normKey = (v) => String(v ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** @param {unknown} slug @returns {VaultIdentity | null} */
export function vaultBySlug(slug) {
  const s = String(slug ?? "").toLowerCase();
  return VAULTS.find((v) => v.slug === s) ?? null;
}

// A sleeve spelled any of the ways it arrives: the framework id
// ("conservative_defi_yield"), the allocation DTO key ("defi-yield") or the
// published name ("Conservative DeFi Yield"). Not a slug: vaultBySlug is.
/** @param {unknown} idKeyOrName @returns {VaultIdentity | null} */
export function vaultForBucket(idKeyOrName) {
  const n = normKey(idKeyOrName);
  if (!n) return null;
  return VAULTS.find((v) => normKey(v.bucket) === n || normKey(v.key) === n || normKey(v.name) === n) ?? null;
}

/** @param {unknown} key */
export function sleeveNote(key) {
  const v = vaultForBucket(key);
  return v ? SLEEVE_NOTE[v.key] ?? "" : "";
}

// Where the mock-data switch and the archive fallbacks are allowed to act.
// An ALLOW-list: every host not named here is production-like, whatever it is
// called, so a new domain can never show devnet or saved figures by accident.
// The empty hostname is a file:// page or a test run.
/** @param {unknown} hostname */
export function isLocalHost(hostname) {
  const h = String(hostname ?? "").toLowerCase();
  return h === ""
    || h === "localhost"
    || h.endsWith(".localhost")
    || h === "127.0.0.1"
    || h === "[::1]"
    || h === "::1"
    || h === "stage.robotmoney-labs.dev";
}

/** @param {unknown} v @returns {number | null} */
export const numberOrNull = (v) =>
  v !== null && v !== undefined && v !== "" && typeof v !== "boolean" && Number.isFinite(Number(v))
    ? Number(v)
    : null;

/** @param {unknown} v @returns {number | null} */
export const bps = (v) => {
  const n = numberOrNull(v);
  return n !== null && n >= 0 && n <= 10000 ? n : null;
};

// Two decimals of a basis point, so float residue (0.09 * 10000) never reads
// as a gap of its own and a second pass reproduces the first exactly.
/** @param {number} v */
const round2 = (v) => Math.round(v * 100) / 100;

/** @param {number | null} a @param {number | null} b */
const diff = (a, b) => (a === null || b === null ? null : round2(a - b));

// Fractions of one (0.95) to whole basis points by largest remainder, so
// weights that sum to 1 give exactly 10000 and never 9999 or 10001. An entry
// that is not a non-negative number stays null.
/** @param {Array<unknown>} weights @returns {Array<number | null>} */
export function bpsFromWeights(weights) {
  const raw = (weights || []).map((w) => {
    const n = numberOrNull(w);
    if (n === null || n < 0) return null;
    const x = n * 10000;
    const r = Math.round(x);
    return Math.abs(x - r) < 1e-6 ? r : x;
  });
  /** @type {Array<number | null>} */
  const out = raw.map((x) => (x === null ? null : Math.floor(x)));
  const total = Math.round(raw.reduce((/** @type {number} */ s, x) => s + (x ?? 0), 0));
  let left = total - out.reduce((/** @type {number} */ s, x) => s + (x ?? 0), 0);
  const order = raw
    .map((x, i) => ({ i, frac: x === null ? -1 : x - Math.floor(x) }))
    .filter((r) => r.frac >= 0)
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    out[i] = /** @type {number} */ (out[i]) + 1;
    left -= 1;
  }
  return out;
}

// A layer of four weights is only a layer when all four are known and they
// add up. Anything else is reported as missing, never rescaled to 100%.
/** @param {Array<number | null | undefined>} values */
export function layerComplete(values) {
  if (!Array.isArray(values) || values.length !== VAULTS.length) return false;
  if (!values.every((v) => typeof v === "number" && Number.isFinite(v))) return false;
  const sum = values.reduce((/** @type {number} */ s, v) => s + /** @type {number} */ (v), 0);
  return Math.abs(sum - 10000) <= 1;
}

// The one reading of the four vaults. Recomputes actual, the gaps, combined
// TVL and tracking error from the inputs; a server's own figures for those are
// ignored, so a backend that computes them differently cannot put two answers
// on one page. Idempotent on its own output.
//
//   actual     = a vault's TVL over the four vaults' TVL. A vault confirmed
//                absent from the network counts as zero; an unreadable or
//                missing one makes every actual null (never renormalised).
//   governance = applied - recommended   (a vote not yet applied)
//   flow       = actual - applied        (deposits not yet routed)
//   total      = actual - recommended
//   tracking error = half the sum of |total| over the four vaults.
/** @param {any} source @returns {Overview} */
export function normalizeOverview(source) {
  const src = source && typeof source === "object" ? source : {};
  const records = Array.isArray(src.vaults) ? src.vaults : [];
  const hasRecommendation = !!src.recommendation;

  const rows = VAULTS.map((identity) => {
    const matches = records.filter((/** @type {any} */ r) => String(r?.slug ?? "").toLowerCase() === identity.slug);
    // A missing or duplicated record is unknown, not zero.
    const raw = matches.length === 1 ? matches[0] : {};
    const availability = /** @type {Availability} */ (
      ["live", "not_on_network", "unavailable"].includes(raw.availability) ? raw.availability : "unavailable"
    );
    const tvl = numberOrNull(raw.tvlUsd);
    return {
      ...raw,
      ...identity,
      availability,
      status: raw.status ?? null,
      address: raw.address ?? null,
      tvlUsd: tvl !== null && tvl >= 0 ? tvl : null,
      sharePrice: numberOrNull(raw.sharePrice),
      exitFeeBps: numberOrNull(raw.exitFeeBps),
      recommendedBps: hasRecommendation ? bps(raw.recommendedBps) : null,
      appliedBps: bps(raw.appliedBps),
    };
  });

  const recommendedOk = layerComplete(rows.map((r) => r.recommendedBps));
  const appliedOk = layerComplete(rows.map((r) => r.appliedBps));

  const complete = rows.every((r) => r.availability === "not_on_network" || (r.availability === "live" && r.tvlUsd !== null));
  const total = complete
    ? rows.reduce((n, r) => n + (r.availability === "not_on_network" ? 0 : /** @type {number} */ (r.tvlUsd)), 0)
    : null;

  /** @type {VaultRow[]} */
  const vaults = rows.map((r) => {
    const recommended = recommendedOk ? r.recommendedBps : null;
    const applied = appliedOk ? r.appliedBps : null;
    const actual = total !== null && total > 0
      ? r.availability === "not_on_network" ? 0 : round2((/** @type {number} */ (r.tvlUsd) * 10000) / total)
      : null;
    return {
      ...r,
      recommendedBps: recommended,
      appliedBps: applied,
      actualBps: actual,
      gaps: {
        governance: diff(applied, recommended),
        flow: diff(actual, applied),
        total: diff(actual, recommended),
      },
    };
  });

  const known = rows.every((r) => r.availability === "live" || r.availability === "not_on_network");
  return {
    ...src,
    asOf: src.asOf ?? null,
    network: src.network ?? null,
    freshness: src.freshness ?? null,
    router: src.router ?? null,
    recommendation: src.recommendation ?? null,
    vaults,
    combined: {
      tvlUsd: total,
      vaultsLive: known ? rows.filter((r) => r.availability === "live").length : null,
    },
    trackingErrorBps: vaults.every((r) => r.gaps.total !== null)
      ? round2(vaults.reduce((n, r) => n + Math.abs(/** @type {number} */ (r.gaps.total)), 0) / 2)
      : null,
  };
}

// Whether the router reported weights: normalizeOverview keeps the Applied
// layer only when it is complete. Without it there is one gap per vault,
// actual against recommended (gaps.total), and no governance or flow gap.
/** @param {any} overview */
export function hasAppliedLayer(overview) {
  const rows = Array.isArray(overview?.vaults) ? overview.vaults : [];
  return rows.length === VAULTS.length && rows.every((/** @type {any} */ r) => typeof r?.appliedBps === "number");
}

// Was a recommendation applied? Only if some router weight recorded AFTER it
// equals it. Today's weight matching an old recommendation proves nothing.
/** @param {any} receipt @param {any[]} history */
export function receiptApplied(receipt, history) {
  const time = Date.parse(receipt?.t || receipt?.recorded_at);
  const target = bps(receipt?.recommendedBps);
  return (
    target !== null &&
    Number.isFinite(time) &&
    (history || []).some((row) => Date.parse(row?.t) > time && bps(row?.appliedBps) === target)
  );
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Dates and times written out by hand, in UTC: Intl's "en-US" output differs
// between engines (", " or " at " before the time, a narrow no-break space
// before PM), and the same instant must read the same everywhere.
/** @param {unknown} v @returns {Date | null} */
function utcDate(v) {
  if (v == null || v === "") return null;
  const ms = Date.parse(String(v));
  return Number.isFinite(ms) ? new Date(ms) : null;
}
/** @param {Date} d */
const dayPart = (d) => `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
/** @param {Date} d */
// 24-hour and UTC, as every time on the swarm pages reads: "16:20 UTC".
const timePart = (d) => `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;

/** @param {unknown} iso */
function stampUtc(iso) {
  const d = utcDate(iso);
  return d ? `${dayPart(d)} ${timePart(d)}` : null;
}

// A degraded adapter read names its own observation time; a scheduler
// catch-up is a live read that arrived late (issue #614).
/** @param {any} adapter @param {any} economics */
function adapterNote(adapter, economics) {
  if (adapter?.provenance === "stale") {
    const when = stampUtc(adapter?.balanceObservedAt || economics?.asOf);
    return when ? `stale (${when})` : "stale";
  }
  if (adapter?.provenance === "backfilled") return "caught up late";
  return null;
}

/** @param {number | null} value @param {number | null} tvl */
const shareBps = (value, tvl) => (value !== null && tvl !== null && tvl > 0 ? round2((value / tvl) * 10000) : null);

// Production today: the single rmUSDC vault from /api/dashboards/vault-economics,
// as a raw overview DTO (normalise it with normalizeOverview). It carries no
// router and no recommendation: the other three vaults are not on Base, and
// nothing on Base applies weights yet.
/** @param {any} economics */
export function legacyRaw(economics) {
  const e = economics && typeof economics === "object" ? economics : {};
  const asOf = e.asOf ?? null;
  const tvl = numberOrNull(e.tvlUsd);
  const idle = numberOrNull(e.idleUsdc);
  const adapters = Array.isArray(e.adapters) ? e.adapters : [];
  const holdings = [
    ...adapters.map((/** @type {any} */ a) => {
      const display = ADAPTER_DISPLAY[String(a?.name ?? "").toLowerCase()];
      const value = numberOrNull(a?.balanceUsd);
      return {
        kind: "adapter",
        label: display?.label ?? a?.name ?? "—",
        symbol: null,
        venueType: display?.venueType ?? null,
        address: a?.address ?? null,
        balance: value,
        valueUsd: value,
        weightBps: shareBps(value, tvl),
        targetBps: null,
        priceSource: null,
        note: adapterNote(a, e),
      };
    }),
    ...(idle !== null && idle > 0
      ? [{
          kind: "idle",
          label: "Idle USDC",
          symbol: "USDC",
          address: null,
          balance: idle,
          valueUsd: idle,
          weightBps: shareBps(idle, tvl),
          targetBps: null,
          priceSource: null,
          note: null,
        }]
      : []),
  ];
  const network = { chainId: BASE_CHAIN_ID, label: "Base", testData: e.source === "stub" };
  return {
    asOf,
    legacy: true,
    network,
    freshness: { blockNumber: null, indexedAt: asOf, stale: e.stale === true },
    router: { address: null, availability: "not_on_network", appliedAt: null },
    recommendation: null,
    vaults: VAULTS.map((v) =>
      v.slug === "rmusdc"
        ? {
            slug: v.slug,
            symbol: v.symbol,
            name: v.name,
            bucket: v.bucket,
            availability: "live",
            status: "active",
            address: v.baseAddress,
            tvlUsd: tvl,
            sharePrice: numberOrNull(e.sharePrice),
            // skill.md: redeem returns USDC minus a 0.25% exit fee.
            exitFeeBps: 25,
            // changelog.html launch terms: "No management fee, and no audit."
            auditStatus: "Not audited",
            recommendedBps: null,
            appliedBps: null,
            network,
            holdingsAsOf: asOf,
            holdings,
            flags: null,
            caps: null,
            apy: null,
            depositors: null,
            guards: null,
            contracts: { vault: v.baseAddress, router: null, registry: null },
            mechanics: {
              redeemOnly: false,
              maxSlippageBps: null,
              venues: adapters.map((/** @type {any} */ a) => String(a?.name ?? "")).filter(Boolean),
            },
          }
        : {
            slug: v.slug,
            symbol: v.symbol,
            name: v.name,
            bucket: v.bucket,
            availability: "not_on_network",
            status: null,
            address: null,
            tvlUsd: null,
            recommendedBps: null,
            appliedBps: null,
          },
    ),
  };
}

// Lay a published recommendation over a raw DTO that has none (the legacy
// feed). A DTO that already carries one keeps it: the backend's is
// authoritative. `rec` is recommendationFromSession()'s shape.
/** @param {any} raw @param {any} rec */
export function withRecommendation(raw, rec) {
  if (!raw || typeof raw !== "object" || raw.recommendation || !rec) return raw;
  const by = rec.bpsByBucket || {};
  return {
    ...raw,
    recommendation: {
      sessionId: rec.sessionId ?? null,
      publishedAt: rec.publishedAt ?? null,
      releasedOnChain: typeof rec.releasedOnChain === "boolean" ? rec.releasedOnChain : null,
      date: rec.date ?? null,
      subjectId: rec.subjectId ?? null,
      href: rec.href ?? null,
    },
    vaults: (Array.isArray(raw.vaults) ? raw.vaults : []).map((/** @type {any} */ v) => {
      const id = vaultBySlug(v?.slug);
      return { ...v, recommendedBps: id ? numberOrNull(by[id.bucket]) : null };
    }),
  };
}

// The date a recommendation reads by, and where it links. A session id that
// is a real record links to it; a synthetic one links nowhere.
/** @param {any} rec */
export function recommendationDate(rec) {
  return rec ? rec.publishedAt ?? rec.date ?? null : null;
}
/** @param {any} rec */
export function recommendationHref(rec) {
  if (!rec) return null;
  if (rec.href) return String(rec.href);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(rec.sessionId ?? ""))
    ? `/swarm/sessions/${rec.sessionId}`
    : null;
}

/** @param {any} row @param {unknown} [networkLabel] */
export function statusLabel(row, networkLabel) {
  if (!row) return "Data unavailable";
  if (row.availability === "not_on_network") {
    const label = String(networkLabel ?? "").trim();
    return `Not live on ${label || "this network"}`;
  }
  if (row.availability !== "live") return "Data unavailable";
  if (row.flags?.shutdown || row.status === "shutdown") return "Shutdown";
  if (row.status === "retired") return "Retired";
  if (row.status === "paused") return "Paused";
  if (row.flags?.depositsPaused) return "Deposits paused";
  if (row.flags?.withdrawalsPaused) return "Withdrawals paused";
  return "Active";
}

// The one production deposit path: rmUSDC on Base, at the address skill.md
// names, live and accepting deposits. Anything else (another vault, test
// data, the devnet, a different contract) gets no deposit call to action.
/** @param {any} row @param {any} network @param {any} [flags] */
export function canDeposit(row, network, flags) {
  const f = flags ?? row?.flags ?? null;
  return (
    row?.slug === "rmusdc" &&
    network?.chainId === BASE_CHAIN_ID &&
    network?.testData !== true &&
    row?.availability === "live" &&
    typeof row?.address === "string" &&
    row.address.toLowerCase() === VAULTS[0].baseAddress &&
    !["paused", "retired", "shutdown"].includes(row?.status) &&
    !f?.shutdown &&
    !f?.depositsPaused
  );
}

// Only BaseScan, and only for a well-formed address or hash on Base. A feed
// never supplies the URL.
/** @param {any} network @param {unknown} value @param {"address" | "tx"} [kind] */
export function explorerLink(network, value, kind = "address") {
  const pattern = kind === "tx" ? /^0x[0-9a-fA-F]{64}$/ : /^0x[0-9a-fA-F]{40}$/;
  if (network?.chainId !== BASE_CHAIN_ID || !pattern.test(String(value ?? ""))) return null;
  return `https://basescan.org/${kind}/${value}`;
}

// Bars are drawn only for a complete set of weights; otherwise figures only.
/** @param {any[]} holdings */
export function holdingsComplete(holdings) {
  if (!Array.isArray(holdings) || !holdings.length) return false;
  const weights = holdings.map((h) => numberOrNull(h?.weightBps));
  if (weights.some((w) => w === null)) return false;
  const sum = weights.reduce((/** @type {number} */ s, w) => s + /** @type {number} */ (w), 0);
  return Math.abs(sum - 10000) <= 5;
}

/**
 * @typedef {{ t: string, ms: number, value: number, x: number, y: number }} HistoryPoint
 * @typedef {{ points: HistoryPoint[], segments: HistoryPoint[][], sparse: boolean, min: number | null, max: number | null, start: number | null, end: number | null }} HistoryModel
 */

// A series as the chart draws it. Readings that are not a number on a real
// date are dropped, the rest sorted. Fewer than seven is sparse (points, no
// line). A line never bridges more than three days without a reading. x runs
// 0..1 from the first reading to the later of the last reading and `asOf`;
// y runs 0..1 from zero to the largest value.
/** @param {any[]} points @param {unknown} [asOf] @returns {HistoryModel} */
export function historyModel(points, asOf) {
  const clean = (Array.isArray(points) ? points : [])
    .map((p) => ({
      t: String(p?.t ?? ""),
      ms: Date.parse(String(p?.t ?? "")),
      value: numberOrNull(p?.tvlUsd ?? p?.value ?? p?.valueUsd),
    }))
    .filter((p) => Number.isFinite(p.ms) && p.value !== null)
    .sort((a, b) => a.ms - b.ms);
  if (!clean.length) return { points: [], segments: [], sparse: true, min: null, max: null, start: null, end: null };
  const values = clean.map((p) => /** @type {number} */ (p.value));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const start = clean[0].ms;
  const asOfMs = Date.parse(String(asOf ?? ""));
  const end = Math.max(clean[clean.length - 1].ms, Number.isFinite(asOfMs) ? asOfMs : -Infinity);
  const lo = Math.min(0, min);
  const span = end - start;
  /** @type {HistoryPoint[]} */
  const out = clean.map((p) => {
    const value = /** @type {number} */ (p.value);
    return {
      t: p.t,
      ms: p.ms,
      value,
      x: span > 0 ? (p.ms - start) / span : 0.5,
      y: max > lo ? (value - lo) / (max - lo) : 0.5,
    };
  });
  /** @type {HistoryPoint[][]} */
  const segments = [];
  out.forEach((p, i) => {
    if (i === 0 || p.ms - out[i - 1].ms > 3 * DAY_MS) segments.push([p]);
    else segments[segments.length - 1].push(p);
  });
  return { points: out, segments, sparse: out.length < 7, min, max, start, end };
}

/** @param {unknown} v */
export function fmtUsd(v) {
  const n = numberOrNull(v);
  if (n === null) return "—";
  // Whole dollars, as the swarm pages state a book ("$18,390").
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

// A date with its month name: "Sep 16, 2026".
/** @param {unknown} v */
export function fmtDate(v) {
  const d = utcDate(v);
  return d ? `${dayPart(d)}, ${d.getUTCFullYear()}` : "—";
}

// A date and time: "Jul 30, 2026 16:20 UTC".
/** @param {unknown} v */
export function fmtDateTime(v) {
  const d = utcDate(v);
  return d ? `${dayPart(d)}, ${d.getUTCFullYear()} ${timePart(d)}` : "—";
}

// A weight in basis points as a percentage: 6500 -> "65%", 0 -> "0%".
/** @param {unknown} v */
export function fmtBps(v) {
  const n = numberOrNull(v);
  return n === null ? "—" : fmtPctTrim(n / 100);
}

// A gap as the class and the label weight-change.js gives every move on the
// site: percentage points, no arrow. A zero gap is a reading ("0 pp", flat); a
// missing one is "—" with no class.
/** @param {unknown} v @returns {{ cls: string, label: string }} */
export function gapParts(v) {
  const n = numberOrNull(v);
  if (n === null) return { cls: "", label: "—" };
  const d = Math.round(n) / 100;
  if (d === 0) return { cls: "flat", label: "0 pp" };
  return { cls: changeClass(d), label: changeLabel(d) };
}

// When the vault figures were read, and whether the source says they are old.
/** @param {any} overview */
export function freshnessLabel(overview) {
  const when = fmtDateTime(overview?.freshness?.indexedAt ?? overview?.asOf);
  if (when === "—") return "—";
  return overview?.freshness?.stale === true ? `${when} · stale` : when;
}
