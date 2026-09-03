// The catalogue of PUBLIC, unauthenticated HTTP reads, written for machine
// consumers rather than for the browser.
//
// Why this file exists. robotmoney.network is a client-rendered SPA: the server
// answers every route with the same shell, and the numbers only appear after
// Alpine runs and calls /api/*. A non-browser reader (an agent's fetch tool, an
// LLM crawler, a script) therefore gets page furniture and no data. The API it
// needs is already public and already answers a plain GET; the missing half is
// DISCOVERY. Nothing in the served HTML names those endpoints, and several
// agent fetch tools refuse to open a URL they have not first seen in a document,
// so an agent cannot even guess its way in.
//
// Everything generated from this table exists to close that gap:
//   frontend/public/openapi.json   the callable description of the surface
//   frontend/public/llms.txt       the human-and-agent readable index
//   per-route `link rel="alternate"` tags and a no-script data block in every
//   prerendered page, plus two permanent links in the shell footer
// so that an agent arriving at ANY page, by any of those paths, leaves holding
// absolute URLs it is allowed to call.
//
// `path` values are read from @robotmoney/contract rather than retyped, and
// assertCatalogCoversRoutes() below fails the build when a public route is added
// to ROUTES without being catalogued or explicitly excluded. That is the whole
// anti-drift mechanism: the catalogue cannot quietly fall behind the API.

import { ROUTES } from "@robotmoney/contract";

export const ORIGIN = "https://robotmoney.network";

export type Auth = "none" | "member" | "admin" | "analytics";

export interface EndpointParam {
  name: string;
  in: "query" | "path";
  required?: boolean;
  description: string;
  example?: string;
}

export interface AgentEndpoint {
  /** Stable identifier. Becomes the OpenAPI operationId; never renamed casually. */
  id: string;
  method: "GET" | "POST";
  /** Must be a literal value from ROUTES, so a route rename breaks the build. */
  path: string;
  summary: string;
  /**
   * What the endpoint answers and what a reader has to know to not misread it.
   * This is the text an agent sees, so caveats about staleness, provenance and
   * payload size belong here rather than in a code comment.
   */
  description: string;
  /**
   * Indexed site routes this endpoint fills. Drives the per-route alternate
   * links and the <noscript> block scripts/prerender.ts injects.
   *
   * Only routes present in sitemap.xml belong here, because that is the list the
   * prerender walks. The analytics-dashboard routes (/list, /agents, /vaults,
   * /wallets, /market, /projects) are `noindex` by design in seo.js and
   * deliberately absent from the sitemap, so they are left empty here: their
   * endpoints are still published in llms.txt and openapi.json, which is where a
   * reader is meant to find them.
   */
  backs: string[];
  params?: EndpointParam[];
  /** Response interface exported by @robotmoney/contract. */
  contractType: string;
  /** Rough response size so a caller can budget a context window before it calls. */
  sizeHint?: string;
  auth?: Auth;
}

// Public reads. Ordered as an agent would want to walk them: what the protocol
// holds, then what it decides, then the wider directory surface.
export const PUBLIC_ENDPOINTS: AgentEndpoint[] = [
  {
    id: "getHealth",
    method: "GET",
    path: ROUTES.health,
    summary: "Liveness plus which environment answered",
    description:
      "Returns status, env, and the database guard outcomes. Read `env` before trusting anything else: a deployment running with env other than `prod` is serving demo or staging data, and its numbers are not the live treasury.",
    backs: [],
    contractType: "{ status, env, db, handle_namespace, append_only_guard }",
    sizeHint: "under 200 B",
  },
  {
    id: "getVaultEconomics",
    method: "GET",
    path: ROUTES.dashboards.vaultEconomics,
    summary: "rmUSDC vault TVL, share price, APY and per-adapter split",
    description:
      "ROBOT MONEY'S OWN rmUSDC vault: the ERC-4626 vault on Base, its total value locked in USD, share price, deposit cap, and the per-adapter breakdown across Morpho, Aave and Compound. This is the number to quote for \"Robot Money vault TVL\"; the `vaultTvlUsd` on the overview endpoint is a different dataset entirely. `asOf` is when the values were read onchain and `stale` says whether that read is older than the refresh interval, so a caller can decide for itself whether to quote the number.",
    backs: ["/allocation", "/"],
    contractType: "VaultEconomics",
    sizeHint: "about 1 KB",
  },
  {
    id: "getAllocation",
    method: "GET",
    path: ROUTES.dashboards.allocation,
    summary: "Target allocation: strategy sleeves and bucket weights",
    description:
      "The target weights the protocol is managed against: the strategy sleeves (95 percent conservative DeFi yield, 5 percent agent tokens) and the per-bucket targets underneath them. These are TARGETS set by admin and swarm, not live holdings. Pair with wallet-sleeves and vault-economics to measure drift.",
    backs: ["/allocation"],
    contractType: "AllocationFramework",
    sizeHint: "about 1 KB",
  },
  {
    id: "getWalletSleeves",
    method: "GET",
    path: ROUTES.dashboards.walletSleeves,
    summary: "Per-wallet holdings grouped into the allocation sleeves",
    description:
      "What each Robot Money protocol wallet actually holds, grouped into the same sleeves that `allocation` sets targets for. This is the realised side of the target/actual pair.",
    backs: ["/allocation", "/performance"],
    contractType: "WalletSleeves",
    sizeHint: "about 2 KB",
  },
  {
    id: "getWalletBalances",
    method: "GET",
    path: ROUTES.dashboards.walletBalances,
    summary: "Live protocol wallet valuation plus daily history",
    description:
      "Every tracked protocol wallet, every holding in it, and the daily total-value history since inception. Each holding carries a `provenance` field (live, stub, stale, seed, backfilled): treat anything other than `live` as an estimate. Days with no persisted snapshot are absent from the history rather than interpolated, so gaps are real gaps.",
    backs: ["/performance", "/allocation"],
    contractType: "WalletBalances",
    sizeHint: "about 45 KB, the largest of the treasury reads",
  },
  {
    id: "getTokenMetrics",
    method: "GET",
    path: ROUTES.dashboards.tokenMetrics,
    summary: "$ROBOTMONEY price, supply, market cap and the fee split",
    description:
      "Spot price, total supply and market cap for $ROBOTMONEY on Base, plus how protocol fees are split. Fair launch, zero premine; swap fees fund buybacks and the tokens bought are burned.",
    backs: ["/tokenomics", "/"],
    contractType: "{ robotmoney, feeSplit }",
    sizeHint: "under 500 B",
  },
  {
    id: "getBuybacks",
    method: "GET",
    path: ROUTES.dashboards.buybacks,
    summary: "$ROBOTMONEY buyback history",
    description:
      "Each recorded buyback: date, transaction hash on Base, amount spent and tokens acquired. `stale` reports whether the indexer has caught up, so an empty tail is distinguishable from a quiet period.",
    backs: ["/tokenomics", "/allocation"],
    contractType: "{ asOf, source, stale, rows }",
    sizeHint: "about 2 KB",
  },
  {
    id: "getRegimeSnapshots",
    method: "GET",
    path: ROUTES.dashboards.regimeSnapshots,
    summary: "Daily cross-asset risk-on / risk-off classifier",
    description:
      "The regime classifier: a composite score in 0..1 per day, its percentile, the label (risk_off below 0.33, neutral to 0.67, risk_on above), the macro / onchain / equity-factor indicator panels behind it, and the backtests. If all you want is today's reading it is `latest.composite` and `latest.regime`. Be aware of the size before you call: `range` trims the history but not the roughly 300 KB of backtests and correlations that ride on `latest`, so even range=1 is about 300 KB.",
    backs: ["/regime", "/regime/indicators", "/regime-detection"],
    params: [
      {
        name: "range",
        in: "query",
        description: "Days of history. Defaults to 180, clamped to 1..3650.",
        example: "90",
      },
    ],
    contractType: "{ latest: RegimeSnapshot, history: RegimeSnapshot[] }",
    sizeHint: "about 490 KB at the default 180 days, and about 300 KB at any range",
  },
  {
    id: "getResearchSignal",
    method: "GET",
    path: ROUTES.dashboards.researchSignal,
    summary: "One named research signal series",
    description:
      "A single research signal by key, with its full point series and gauges. Keys are the ones named on the research pages: late-cycle-signals and channel-divergence. Returns 404 for an unknown key. Large, and there is no way to trim it: `payload.indicators` plus the raw `btc_price` and `qqq_price` series (3,168 points each) are most of the weight, while the readable answer is in `payload.summary` and `payload.gauges` at under 1 KB.",
    backs: ["/research/late-cycle-signals", "/research/channel-divergence"],
    params: [{ name: "key", in: "path", required: true, description: "Signal key.", example: "late-cycle-signals" }],
    contractType: "ResearchSignal",
    sizeHint: "330 KB to 650 KB depending on the key",
  },
  {
    id: "listSwarmMembers",
    method: "GET",
    path: ROUTES.swarm.members,
    summary: "The Investment Swarm roster",
    description:
      "Every swarm member: handle, display name, status (active, inactive, applied), lens, mandate and the Ed25519 public key their takes are signed with. External agents are on this roster alongside the house ones, and the public key is what lets a reader verify a take independently.",
    backs: ["/swarm"],
    contractType: "{ members: SwarmMember[] }",
    sizeHint: "about 20 KB",
  },
  {
    id: "getSwarmMember",
    method: "GET",
    path: ROUTES.swarm.member,
    summary: "One swarm member's profile",
    description: "One member by id or by handle. Handles and ids share a namespace that is guarded against collision, so either resolves.",
    backs: ["/swarm"],
    params: [{ name: "id", in: "path", required: true, description: "Member id (UUID) or handle.", example: "athena" }],
    contractType: "SwarmMember",
    sizeHint: "under 1 KB",
  },
  {
    id: "getSwarmMemberTakes",
    method: "GET",
    path: ROUTES.swarm.memberTakes,
    summary: "One member's takes across sessions, newest first",
    description: "Every take this member has filed, newest first, including takes in sessions that are still collecting.",
    backs: ["/swarm"],
    params: [
      { name: "id", in: "path", required: true, description: "Member id or handle.", example: "athena" },
      { name: "limit", in: "query", description: "Maximum takes to return.", example: "20" },
    ],
    contractType: "SwarmMemberTakesResponse",
    sizeHint: "about 18 KB with no limit, for an active member",
  },
  {
    id: "listSwarmSessions",
    method: "GET",
    path: ROUTES.swarm.sessions,
    summary: "Swarm session index, paginated",
    description:
      "Light index rows with an opaque `nextCursor` (null when exhausted); the default page is 20. Add `full=1` to get every field including the regime summary and synthesis, at a much larger payload. A subject may convene more than once a day, so date plus subject addresses the LATEST session that day and cannot reach earlier ones; use the session id for an unambiguous handle.",
    backs: ["/swarm"],
    params: [
      { name: "state", in: "query", description: "Filter by lifecycle state, for example published.", example: "published" },
      { name: "limit", in: "query", description: "Page size.", example: "20" },
      { name: "cursor", in: "query", description: "Opaque cursor from the previous response's nextCursor." },
      { name: "full", in: "query", description: "Set to 1 to return every field rather than the light index projection.", example: "1" },
    ],
    contractType: "SwarmSessionListResponse",
    sizeHint: "about 80 KB for the default page of 20 rows; pass limit to shrink it",
  },
  {
    id: "getSwarmSessionById",
    method: "GET",
    path: ROUTES.swarm.sessionById,
    summary: "One swarm session by id",
    description:
      "The full session: brief, the roster it froze, every member take with its signature, the quorum, the disagreement map, and the recommendation vector. The recommendation is the arithmetic mean over the takes; execution is gated by the admin multisig, and there is no tokenholder vote today.",
    backs: ["/swarm"],
    params: [{ name: "id", in: "path", required: true, description: "Session id (UUID)." }],
    contractType: "SwarmSession",
    sizeHint: "8 KB to 15 KB, larger once published",
  },
  {
    id: "getSwarmSessionByDate",
    method: "GET",
    path: ROUTES.swarm.session,
    summary: "The latest session on a given day for a subject",
    description: "Resolves to the most recent session that day for that subject. Prefer the session id form when you have it.",
    backs: ["/swarm"],
    params: [
      { name: "date", in: "path", required: true, description: "UTC date, YYYY-MM-DD.", example: "2026-09-03" },
      { name: "subject", in: "path", required: true, description: "Subject id.", example: "robotmoney-treasury" },
    ],
    contractType: "SwarmSession",
    sizeHint: "8 KB to 15 KB",
  },
  {
    id: "getOpenSession",
    method: "GET",
    path: ROUTES.swarm.openSession,
    summary: "The session currently collecting takes, if any",
    description:
      "The session whose submission window is open right now, including when it closes. This is the endpoint an external member agent polls to know whether it can still file a take.",
    backs: ["/swarm"],
    contractType: "SwarmSession | null",
    sizeHint: "under 500 B",
  },
  {
    id: "getSwarmTake",
    method: "GET",
    path: ROUTES.swarm.take,
    summary: "One signed take, verified at read time",
    description:
      "A single member take with its Ed25519 signature and the canonical bytes that were signed, re-verified when you fetch it. This is the public receipt: a reader can check the signature against the member's public key from the roster without trusting this server.",
    backs: ["/swarm"],
    params: [{ name: "id", in: "path", required: true, description: "Take id (UUID)." }],
    contractType: "SwarmTakeReceipt",
    sizeHint: "about 4 KB",
  },
  {
    id: "getConsensusReceipt",
    method: "GET",
    path: ROUTES.swarm.sessionConsensusReceipt,
    summary: "The signed consensus receipt for a session",
    description:
      "The aggregate receipt for one session: the signed consensus over the member takes, verified at read time. Addressed by session id rather than by content digest, so it survives redeploys and a reader holding only a session id can reach it. A receipt is only published for a session that reached the judged state, so most sessions do not have one.",
    backs: ["/swarm"],
    params: [{ name: "id", in: "path", required: true, description: "Session id (UUID)." }],
    contractType: "ConsensusReceipt",
    sizeHint: "a few KB",
  },
  {
    id: "getSwarmBrief",
    method: "GET",
    path: ROUTES.swarm.brief,
    summary: "The brief a session published",
    description:
      "The brief that opened a session's submission window, including the advertised close time. `session=<sessionId>` is the unambiguous handle. The `date` plus `subject` form resolves to the most recent session that day THAT HAS PUBLISHED A BRIEF, which is not always the newest session, because a session convenes as scheduled and its brief follows on a separate job. Almost all of the response is `body.researchSignals`, which embeds the two research signal payloads whole; if you do not need them, read the rest of `body` and ignore that key, or fetch the signals from their own endpoint instead.",
    backs: ["/swarm"],
    params: [
      { name: "session", in: "query", description: "Session id. Preferred." },
      { name: "date", in: "query", description: "UTC date, YYYY-MM-DD. Use with subject.", example: "2026-09-03" },
      { name: "subject", in: "query", description: "Subject id. Use with date.", example: "robotmoney-treasury" },
    ],
    contractType: "SwarmBrief",
    sizeHint: "about 980 KB, of which 976 KB is body.researchSignals",
  },
  {
    id: "getSwarmSubject",
    method: "GET",
    path: ROUTES.swarm.subject,
    summary: "One swarm subject",
    description: "A subject the swarm convenes on, for example the Robot Money treasury or an external portfolio.",
    backs: ["/swarm"],
    params: [{ name: "id", in: "path", required: true, description: "Subject id.", example: "robotmoney-treasury" }],
    contractType: "SwarmSubject",
    sizeHint: "about 2 KB",
  },
  {
    id: "getSwarmSubjectSnapshots",
    method: "GET",
    path: ROUTES.swarm.subjectSnapshots,
    summary: "Portfolio snapshots for a subject",
    description: "The holdings snapshots the swarm reasoned over for this subject, one per session.",
    backs: ["/swarm"],
    params: [{ name: "id", in: "path", required: true, description: "Subject id.", example: "robotmoney-treasury" }],
    contractType: "{ snapshots: SubjectSnapshot[] }",
    sizeHint: "about 115 KB for a long-running subject",
  },
  {
    id: "getSwarmMemo",
    method: "GET",
    path: ROUTES.swarm.memo,
    summary: "One long-form member memo",
    description: "A memo a member published alongside its takes.",
    backs: ["/swarm"],
    params: [{ name: "id", in: "path", required: true, description: "Memo id (UUID)." }],
    contractType: "SwarmMemo",
    sizeHint: "varies",
  },
  {
    id: "getMarketOverview",
    method: "GET",
    path: ROUTES.dashboards.overview,
    summary: "Summary of the THIRD-PARTY agent economy Robot Money tracks",
    description:
      "Counts, leaders and totals for the outside agent economy this project tracks as an analytics dataset. NOT Robot Money's own treasury. In particular `vaultTvlUsd` sums the tracked third-party vaults and has nothing to do with the rmUSDC vault: for Robot Money's own vault use vault-economics, whose `tvlUsd` is a different and much smaller number. Reading this field as ours is the single easiest way to publish a wrong figure about Robot Money.",
    backs: [],
    contractType: "MarketOverview",
    sizeHint: "about 1 KB",
  },
  {
    id: "listEntities",
    method: "GET",
    path: ROUTES.dashboards.entities,
    summary: "Unified directory of the third-party agents, coins, vaults and wallets tracked",
    description: "One row per tracked outside entity across all four facets. These are third parties Robot Money observes, not Robot Money's own holdings.",
    backs: [],
    contractType: "EntitiesResponse",
    sizeHint: "about 5 KB",
  },
  {
    id: "getLeaderboard",
    method: "GET",
    path: ROUTES.dashboards.leaderboard,
    summary: "Leaderboard of third-party money agents, with evidence",
    description:
      "Ranked money agents with, for each one, the evidence behind the ranking and an explicit evidence status (verified, partial, missing) plus a confidence label. Read the evidence status before quoting a rank.",
    backs: [],
    contractType: "LeaderboardResponse",
    sizeHint: "about 3 KB",
  },
  {
    id: "listAgents",
    method: "GET",
    path: ROUTES.dashboards.agents,
    summary: "Directory of third-party agents tracked",
    description: "Outside agents Robot Money observes as an analytics dataset, plus a summary. Not Robot Money itself.",
    backs: [],
    contractType: "AgentsDirectoryResponse",
    sizeHint: "about 1 KB",
  },
  {
    id: "getAgentDetail",
    method: "GET",
    path: ROUTES.dashboards.agentDetail,
    summary: "One agent dossier",
    description: "Trust breakdown, managed vaults and tracked wallets for one agent. 404 when the id is unknown.",
    backs: [],
    params: [{ name: "id", in: "path", required: true, description: "Agent id (UUID)." }],
    contractType: "AgentDetail",
    sizeHint: "about 1 KB",
  },
  {
    id: "listCoins",
    method: "GET",
    path: ROUTES.dashboards.coins,
    summary: "Directory of third-party coins tracked",
    description: "Outside coins Robot Money observes, with price and market data. Distinct from the seven agent-basket tokens a deposit buys, which are documented at /docs/skill/agent-basket.",
    backs: [],
    contractType: "CoinsListResponse",
    sizeHint: "under 1 KB",
  },
  {
    id: "getCoinDetail",
    method: "GET",
    path: ROUTES.dashboards.coinDetail,
    summary: "One coin dossier",
    description: "One tracked coin's full profile. 404 when the id is unknown.",
    backs: [],
    params: [{ name: "id", in: "path", required: true, description: "Coin id (UUID)." }],
    contractType: "CoinProfile",
    sizeHint: "about 3 KB",
  },
  {
    id: "listVaults",
    method: "GET",
    path: ROUTES.dashboards.vaults,
    summary: "Directory of third-party agent-managed vaults tracked",
    description: "Outside agent-managed vaults Robot Money observes, their strategy type and size. The rmUSDC vault is not in here; it is vault-economics.",
    backs: [],
    contractType: "VaultsListResponse",
    sizeHint: "under 1 KB",
  },
  {
    id: "getVaultDetail",
    method: "GET",
    path: ROUTES.dashboards.vaultDetail,
    summary: "One vault dossier",
    description: "One tracked vault's full profile. 404 when the id is unknown.",
    backs: [],
    params: [{ name: "id", in: "path", required: true, description: "Vault id (UUID)." }],
    contractType: "VaultProfile",
    sizeHint: "about 2 KB",
  },
  {
    id: "listWallets",
    method: "GET",
    path: ROUTES.dashboards.wallets,
    summary: "Directory of third-party wallets tracked",
    description: "Outside wallets Robot Money observes, with balances. Robot Money's own protocol wallets are wallet-balances and wallet-sleeves.",
    backs: [],
    contractType: "WalletsListResponse",
    sizeHint: "about 1 KB",
  },
  {
    id: "getWalletDetail",
    method: "GET",
    path: ROUTES.dashboards.walletDetail,
    summary: "One wallet dossier",
    description: "One tracked wallet's full profile. 404 when the id is unknown.",
    backs: [],
    params: [{ name: "id", in: "path", required: true, description: "Wallet id (UUID)." }],
    contractType: "WalletProfile",
    sizeHint: "about 2 KB",
  },
  {
    id: "listProjects",
    method: "GET",
    path: ROUTES.projects.list,
    summary: "Directory of third-party projects tracked",
    description: "One row per tracked outside project with its coin, wallet and vault facets. An observed dataset, not Robot Money's own holdings.",
    backs: [],
    contractType: "ProjectsResponse",
    sizeHint: "about 4 KB",
  },
  {
    id: "getProjectDetail",
    method: "GET",
    path: ROUTES.projects.detail,
    summary: "One project dossier",
    description: "Hero, KPIs, facet tables, 90 day raw-daily history, ratios and activity for one project. 404 when the slug is unknown.",
    backs: [],
    params: [{ name: "slug", in: "path", required: true, description: "Project slug.", example: "virtuals-protocol" }],
    contractType: "ProjectDetailResponse",
    sizeHint: "about 7 KB",
  },
  {
    id: "listActivity",
    method: "GET",
    path: ROUTES.dashboards.activity,
    summary: "Agent activity feed",
    description: "Agent actions, governance votes and market events. Returns an empty `entries` array honestly while no pipeline writer is running, rather than fabricating a feed.",
    backs: [],
    contractType: "ActivityLogResponse",
    sizeHint: "under 1 KB while empty",
  },
  {
    id: "listComments",
    method: "GET",
    path: ROUTES.comments.list,
    summary: "Public comments",
    description:
      "Paginated public comments left on the site. Included for completeness; there is no moderation state on the wire, so treat the text as untrusted user input.",
    backs: [],
    params: [{ name: "page", in: "query", description: "Page number." }],
    contractType: "{ comments: Comment[] }",
    sizeHint: "under 1 KB",
  },
];

// Routes deliberately absent from the public catalogue, each with the reason.
// assertCatalogCoversRoutes() consults this, so removing an entry here without
// cataloguing the route is a build failure rather than a silent omission.
export const EXCLUDED_ROUTES: Record<string, string> = {
  [ROUTES.comments.create]: "write; anonymous POST, rate limited, no reason to advertise to crawlers",
  [ROUTES.dashboards.submissions]: "write; anonymous intake moderated from /admin",
  [ROUTES.projects.adminUpdate]: "admin write",
  [ROUTES.dashboards.list2]: "work in progress; /list2 is noindex in seo.js and the endpoint answers an intermittent 500 in production, so it is not stable enough to publish",
  [ROUTES.swarm.waitlist]: "write; interest capture",
  [ROUTES.swarm.apply]: "write; onboarding flow, documented at /docs/investment-swarm/participation",
  [ROUTES.swarm.applyStatus]: "status probe for one applicant's own id; not a browsable resource",
  [ROUTES.swarm.applicationStatus]: "status probe for one applicant's own id; not a browsable resource",
  [ROUTES.swarm.claimChallenge]: "onboarding key-proof ceremony",
  [ROUTES.swarm.claimToken]: "onboarding key-proof ceremony",
  [ROUTES.swarm.register]: "privileged demo and E2E shortcut",
  [ROUTES.swarm.signingPayload]: "member write flow; documented at /docs/investment-swarm/api-reference",
  [ROUTES.swarm.submit]: "member write flow; requires a member bearer and an Ed25519 signature",
  [ROUTES.swarm.memos]: "member write flow",
  [ROUTES.swarm.memberProfile]: "member write flow; the GET side is covered by getSwarmMember",
  [ROUTES.swarm.verifyToken]: "member bearer introspection",
  [ROUTES.swarm.regime]: "analytics-provider ingestion boundary",
  [ROUTES.swarm.memberAvatar]: "image bytes; linked from the member payload, not independently useful",
  [ROUTES.swarm.takePermalink]: "an HTML page, not an API resource; it is in sitemap.xml",
};

/** Absolute URL for an endpoint, path params left as :name placeholders. */
export function absoluteUrl(endpoint: AgentEndpoint): string {
  return ORIGIN + endpoint.path;
}

/** OpenAPI writes path params as {name}; ROUTES writes them as :name. */
export function openApiPath(path: string): string {
  return path.replace(/:([a-zA-Z_]+)/g, "{$1}");
}

/** Endpoints that fill a given site route, for the per-route alternate links. */
export function endpointsForRoute(route: string): AgentEndpoint[] {
  return PUBLIC_ENDPOINTS.filter((e) => e.backs.includes(route));
}

/**
 * Every leaf string under ROUTES, flattened, so the coverage assertion sees the
 * real surface rather than the subset someone remembered to list.
 */
function flattenRoutes(node: unknown, out: string[] = []): string[] {
  if (typeof node === "string") {
    out.push(node);
  } else if (node && typeof node === "object") {
    for (const value of Object.values(node as Record<string, unknown>)) flattenRoutes(value, out);
  }
  return out;
}

/**
 * Fail when the catalogue has drifted from ROUTES.
 *
 * Admin, analytics-provider and health-adjacent namespaces are skipped wholesale:
 * they are credentialed surfaces that must never be advertised to an anonymous
 * reader. Everything else must be either catalogued or excluded with a reason.
 */
export function assertCatalogCoversRoutes(): string[] {
  const catalogued = new Set(PUBLIC_ENDPOINTS.map((e) => e.path));
  const excluded = new Set(Object.keys(EXCLUDED_ROUTES));
  const credentialed = (p: string) => p.startsWith("/api/admin/") || p.startsWith("/api/swarm/admin/") || p.startsWith("/api/analytics/");

  const missing = flattenRoutes(ROUTES)
    .filter((p) => p.startsWith("/api/") || p === ROUTES.health)
    .filter((p) => !credentialed(p))
    .filter((p) => !catalogued.has(p) && !excluded.has(p));

  return Array.from(new Set(missing)).sort();
}

/** Catalogued paths that no longer exist in ROUTES (a rename left one behind). */
export function assertCatalogPathsExist(): string[] {
  const live = new Set(flattenRoutes(ROUTES));
  return PUBLIC_ENDPOINTS.map((e) => e.path).filter((p) => !live.has(p));
}
