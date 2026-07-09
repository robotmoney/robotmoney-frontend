// Demo seed for the "Agentic Economy Ecosystem" projects directory (issue #70
// deferred ingestion). Populates the 0013 tables — projects + the agent / coin /
// wallet / vault facets, plus trailing-30d agent revenue and 30d coin price
// snapshots — so `GET /api/projects` returns a populated, sorted table matching
// the reference design instead of "No projects yet.".
//
// This is DEMO-ONLY data. It is wired in behind the DEMO_SEED_PROJECTS env flag
// (see backend/src/db/seed.ts + scripts/lib/demo-main.ts); prod and CI seeds never
// set the flag, so they stay byte-for-byte unchanged and empty here.
//
// The concepts are ported from the deprecated Supabase seed-data function (curated
// agents: Bankr, the x402 facilitators, aixbt/LUNA/G.A.M.E. on Virtuals, Olas,
// ai16z; vaults with tvl/apy), MAPPED onto this backend's 0013 schema. Coins there
// came from a live CoinGecko fetch, so plausible ecosystem tokens are synthesized
// here with realistic market_cap / fdv / 24h numbers.
//
// IDEMPOTENT: projects.slug is UNIQUE, so the project identity row is upserted on
// slug (stable id across runs). Every facet row for that project is then deleted
// and re-inserted inside one transaction — deleting an agent/coin CASCADE-deletes
// its revenue/snapshot rows (0013 FKs) — so repeated runs never duplicate rows and
// the row counts stay stable. All figures are deterministic (seeded by index), so
// re-runs and goldens are byte-stable except for the rolling 30-day date window.
import { sql } from "../db/client.ts";

const DAYS = 30;

interface CoinSeed {
  name: string;
  ticker: string;
  marketCap: number;
  fdv: number;
  change24h: number;
  basePrice: number;
}

interface X402 {
  score: number;
  txns: number;
  resources: number;
}

interface AgentSeed {
  name: string;
  protocol: string;
  x402?: X402;
}

interface WalletSeed {
  label: string;
  chain: string;
  balanceUsd: number;
}

interface DemoProject {
  slug: string;
  displayName: string;
  description: string;
  websiteUrl: string | null;
  twitterHandle: string | null;
  score: number;
  sticky: boolean;
  agent: AgentSeed;
  coins: CoinSeed[];
  wallets: WalletSeed[];
  vault: string | null;
  dailyRevenueBase: number;
  revenueSource: string;
}

// Curated ecosystem directory. Two sticky pins lead the default sort; every
// project is `status='active'` with score ≥ 55 so it clears the projections
// MIN_SCORE gate. Facet mix is deliberately varied (x402 facilitators carry
// protocol/counters but no token; a couple of projects have no vault) so the
// rendered table exercises every facet pill.
const PROJECTS: DemoProject[] = [
  {
    slug: "virtuals-protocol",
    displayName: "Virtuals Protocol",
    description:
      "Agent launchpad and co-ownership layer on Base — the orchestration fabric (G.A.M.E.) powering the largest cohort of tokenized AI agents.",
    websiteUrl: "https://virtuals.io/",
    twitterHandle: "@virtuals_io",
    score: 95,
    sticky: true,
    agent: { name: "G.A.M.E. Protocol Agent", protocol: "virtuals" },
    coins: [
      { name: "Virtuals Protocol", ticker: "VIRTUAL", marketCap: 1_500_000_000, fdv: 1_500_000_000, change24h: 5.2, basePrice: 1.5 },
      { name: "G.A.M.E. by Virtuals", ticker: "GAME", marketCap: 90_000_000, fdv: 120_000_000, change24h: -1.4, basePrice: 0.045 },
    ],
    wallets: [
      { label: "Virtuals Protocol DAO Treasury", chain: "base", balanceUsd: 4_200_000 },
      { label: "Virtuals Creator Vault", chain: "base", balanceUsd: 1_350_000 },
    ],
    vault: "Virtuals Creator Vault",
    dailyRevenueBase: 8_000,
    revenueSource: "virtuals",
  },
  {
    slug: "aixbt",
    displayName: "aixbt",
    description:
      "Leading AI market-intelligence agent on Virtuals — real-time crypto analysis, sentiment tracking, and alpha signals to a 400K+ audience.",
    websiteUrl: "https://aixbt.tech/",
    twitterHandle: "@aixbt_agent",
    score: 92,
    sticky: true,
    agent: { name: "aixbt", protocol: "virtuals" },
    coins: [
      { name: "aixbt", ticker: "AIXBT", marketCap: 320_000_000, fdv: 380_000_000, change24h: -3.1, basePrice: 0.32 },
    ],
    wallets: [{ label: "aixbt Agent Wallet", chain: "base", balanceUsd: 980_000 }],
    vault: null,
    dailyRevenueBase: 12_000,
    revenueSource: "virtuals",
  },
  {
    slug: "bankr",
    displayName: "Bankr",
    description:
      "Autonomous DeFi treasury-management agent on Base (bankrbot.base.eth) — lending, borrowing, and yield strategies via 0x AgentKit.",
    websiteUrl: "https://bankr.bot/",
    twitterHandle: "@bankrbot",
    score: 88,
    sticky: false,
    agent: { name: "Bankr Agent", protocol: "bankr" },
    coins: [
      { name: "Bankr", ticker: "BNKR", marketCap: 42_000_000, fdv: 60_000_000, change24h: 6.8, basePrice: 0.042 },
    ],
    wallets: [
      { label: "Bankr Main Wallet", chain: "base", balanceUsd: 720_000 },
      { label: "Bankr Fee Collector", chain: "base", balanceUsd: 140_000 },
    ],
    vault: "Bankr Treasury Vault",
    dailyRevenueBase: 5_400,
    revenueSource: "bankr",
  },
  {
    slug: "coinbase-x402-facilitator",
    displayName: "Coinbase x402 Facilitator",
    description:
      "High-volume x402 payment facilitator on Base — settles machine-to-machine micropayments for autonomous AI-to-AI commerce.",
    websiteUrl: "https://www.x402.org/",
    twitterHandle: "@coinbase",
    score: 86,
    sticky: false,
    agent: { name: "Coinbase x402 Facilitator", protocol: "x402", x402: { score: 98, txns: 128_400, resources: 42 } },
    coins: [],
    wallets: [
      { label: "Coinbase x402 Facilitator Wallet", chain: "base", balanceUsd: 3_100_000 },
      { label: "x402 Settlement Buffer", chain: "base", balanceUsd: 640_000 },
    ],
    vault: "Coinbase x402 Payment Pool",
    dailyRevenueBase: 15_000,
    revenueSource: "x402",
  },
  {
    slug: "daydreams-x402",
    displayName: "Daydreams x402 Agent",
    description:
      "Highest-activity x402 facilitator on Base — coordinates autonomous AI payment flows across the Daydreams agent network.",
    websiteUrl: "https://dreams.fun/",
    twitterHandle: "@daydreamsagents",
    score: 82,
    sticky: false,
    agent: { name: "Daydreams x402 Agent", protocol: "x402", x402: { score: 91, txns: 94_700, resources: 27 } },
    coins: [],
    wallets: [{ label: "Daydreams x402 Wallet", chain: "base", balanceUsd: 890_000 }],
    vault: "Daydreams Agent Fund",
    dailyRevenueBase: 9_500,
    revenueSource: "x402",
  },
  {
    slug: "luna-virtuals",
    displayName: "LUNA",
    description:
      "AI companion and social agent on Virtuals with the largest holder base — community engagement, entertainment, and autonomous posting.",
    websiteUrl: "https://www.luna.virtuals.io/",
    twitterHandle: "@luna_virtuals",
    score: 80,
    sticky: false,
    agent: { name: "LUNA", protocol: "virtuals" },
    coins: [
      { name: "LUNA by Virtuals", ticker: "LUNA", marketCap: 75_000_000, fdv: 95_000_000, change24h: 2.3, basePrice: 0.075 },
    ],
    wallets: [{ label: "LUNA Agent Wallet", chain: "base", balanceUsd: 410_000 }],
    vault: null,
    dailyRevenueBase: 3_200,
    revenueSource: "virtuals",
  },
  {
    slug: "olas-autonolas",
    displayName: "Olas (Autonolas)",
    description:
      "Autonolas mech + trader services — on-chain AI inference and autonomous prediction-market trading executed for fee on Base and Gnosis.",
    websiteUrl: "https://olas.network/",
    twitterHandle: "@autonolas",
    score: 78,
    sticky: false,
    agent: { name: "Olas Mech Agent", protocol: "olas" },
    coins: [
      { name: "Autonolas", ticker: "OLAS", marketCap: 240_000_000, fdv: 400_000_000, change24h: -0.7, basePrice: 1.8 },
    ],
    wallets: [
      { label: "Olas Mech Wallet", chain: "base", balanceUsd: 320_000 },
      { label: "Olas DAO Community Multisig", chain: "ethereum", balanceUsd: 5_600_000 },
    ],
    vault: "Olas Mech Operations Vault",
    dailyRevenueBase: 6_100,
    revenueSource: "olas",
  },
  {
    slug: "ai16z",
    displayName: "ai16z",
    description:
      "ElizaOS-based AI DAO — the Marc AIndreessen persona agent manages the ai16z treasury, an early autonomous fund manager.",
    websiteUrl: "https://www.elizaos.ai/",
    twitterHandle: "@ai16zdao",
    score: 75,
    sticky: false,
    agent: { name: "Marc AIndreessen", protocol: "eliza" },
    coins: [
      { name: "ai16z", ticker: "AI16Z", marketCap: 190_000_000, fdv: 210_000_000, change24h: 4.9, basePrice: 0.19 },
    ],
    wallets: [{ label: "ai16z DAO Treasury", chain: "solana", balanceUsd: 12_400_000 }],
    vault: null,
    dailyRevenueBase: 4_300,
    revenueSource: "eliza",
  },
  {
    slug: "canza-x402",
    displayName: "Canza x402 Server",
    description:
      "Canza Finance x402 payment server on Base — micropayment facilitation for AI-to-AI commerce via the x402 protocol.",
    websiteUrl: "https://canza.io/",
    twitterHandle: "@CanzaFinance",
    score: 68,
    sticky: false,
    agent: { name: "Canza x402 Server", protocol: "x402", x402: { score: 74, txns: 31_200, resources: 11 } },
    coins: [],
    wallets: [{ label: "Canza x402 Ops", chain: "base", balanceUsd: 210_000 }],
    vault: null,
    dailyRevenueBase: 2_800,
    revenueSource: "x402",
  },
  {
    slug: "x402rs-facilitator",
    displayName: "X402rs Facilitator",
    description:
      "Rust-based x402 facilitator agent on Base — processes x402 protocol payment requests for autonomous agent commerce.",
    websiteUrl: "https://github.com/x402rs",
    twitterHandle: null,
    score: 60,
    sticky: false,
    agent: { name: "X402rs Facilitator", protocol: "x402", x402: { score: 63, txns: 18_900, resources: 8 } },
    coins: [],
    wallets: [{ label: "X402rs Facilitator Wallet", chain: "base", balanceUsd: 95_000 }],
    vault: null,
    dailyRevenueBase: 1_900,
    revenueSource: "x402",
  },
  {
    slug: "degenspartan-ai",
    displayName: "DegenSpartan AI",
    description:
      "High-profile ElizaOS trading agent known for blunt market commentary and autonomous on-chain activity — one of the earliest AI agent personalities.",
    websiteUrl: "https://degenspartan.ai/",
    twitterHandle: "@degenspartan",
    score: 58,
    sticky: false,
    agent: { name: "DegenSpartan AI", protocol: "eliza" },
    coins: [
      { name: "DegenSpartanAI", ticker: "DEGENAI", marketCap: 22_000_000, fdv: 30_000_000, change24h: -5.6, basePrice: 0.022 },
    ],
    wallets: [{ label: "DegenSpartan Wallet", chain: "solana", balanceUsd: 180_000 }],
    vault: null,
    dailyRevenueBase: 900,
    revenueSource: "eliza",
  },
];

// UTC yyyy-mm-dd for `d` days before `base` — the date columns are DATE, so we
// only need the day component. Uses the passed Date (not Date.now()) so the whole
// seed shares one clock.
function ymd(base: Date, daysAgo: number): string {
  return new Date(base.getTime() - daysAgo * 86_400_000).toISOString().slice(0, 10);
}

// Deterministic bounded wiggle around `base` — a fixed sine keyed by (seed, day)
// so the 30-day revenue and price series look organic yet are byte-stable across
// runs (no Math.random / Date.now in the values).
function wiggle(base: number, seed: number, day: number, amp: number): number {
  return base * (1 + amp * Math.sin((day + seed) * 0.7));
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
const round6 = (n: number): number => Math.round(n * 1_000_000) / 1_000_000;

// Upsert the demo directory. Safe to call repeatedly (see the file header). All
// work runs in a single transaction so an interrupted run leaves the table intact.
export async function seedDemoProjects(): Promise<void> {
  const now = new Date();

  await sql.begin(async (tx) => {
    for (let i = 0; i < PROJECTS.length; i++) {
      const p = PROJECTS[i];

      // 1) Project identity — upsert on the UNIQUE slug so the id is stable across
      // runs (facet rows below reference it). has_* mirror facet presence for
      // tidiness; the projection recomputes facets live regardless.
      const [{ id }] = await tx`
        INSERT INTO projects (
          slug, display_name, description, overview_short, website_url, twitter_handle,
          data_coverage_score, has_agent, has_coin, has_wallet, has_vault, is_sticky, status
        ) VALUES (
          ${p.slug}, ${p.displayName}, ${p.description}, ${p.description}, ${p.websiteUrl}, ${p.twitterHandle},
          ${p.score}, true, ${p.coins.length > 0}, ${p.wallets.length > 0}, ${p.vault !== null}, ${p.sticky}, 'active'
        )
        ON CONFLICT (slug) DO UPDATE SET
          display_name        = EXCLUDED.display_name,
          description         = EXCLUDED.description,
          overview_short      = EXCLUDED.overview_short,
          website_url         = EXCLUDED.website_url,
          twitter_handle      = EXCLUDED.twitter_handle,
          data_coverage_score = EXCLUDED.data_coverage_score,
          has_agent           = EXCLUDED.has_agent,
          has_coin            = EXCLUDED.has_coin,
          has_wallet          = EXCLUDED.has_wallet,
          has_vault           = EXCLUDED.has_vault,
          is_sticky           = EXCLUDED.is_sticky,
          status              = 'active',
          updated_at          = now()
        RETURNING id
      `;
      const projectId = id as string;

      // 2) Reset this project's facets. Deleting the agent/coin CASCADE-removes its
      // revenue/snapshot rows (0013 FKs), so re-inserting below keeps counts stable.
      await tx`DELETE FROM openclaw_agents WHERE project_id = ${projectId}`;
      await tx`DELETE FROM lobster_coins   WHERE project_id = ${projectId}`;
      await tx`DELETE FROM tracked_wallets WHERE project_id = ${projectId}`;
      await tx`DELETE FROM agent_vaults    WHERE project_id = ${projectId}`;

      // 3) Agent facet (+ optional x402 counters that drive the live X402 flag).
      const x = p.agent.x402;
      const [{ id: agentId }] = await tx`
        INSERT INTO openclaw_agents (project_id, name, protocol_standard, x402_score, x402_txn_count, x402_resources_count)
        VALUES (${projectId}, ${p.agent.name}, ${p.agent.protocol}, ${x?.score ?? null}, ${x?.txns ?? null}, ${x?.resources ?? null})
        RETURNING id
      `;

      // 4) Trailing-30d daily revenue for that agent (all in-window → non-zero 30d sum).
      const revRows = Array.from({ length: DAYS }, (_, d) => ({
        agent_id: agentId as string,
        revenue_date: ymd(now, d),
        revenue_usd: round2(wiggle(p.dailyRevenueBase, i + 3, d, 0.25)),
        source: p.revenueSource,
      }));
      await tx`INSERT INTO agent_revenue_daily ${tx(revRows)}`;

      // 5) Coin facets + a 30d price snapshot series per coin (draws the sparkline).
      for (let ci = 0; ci < p.coins.length; ci++) {
        const c = p.coins[ci];
        const [{ id: coinId }] = await tx`
          INSERT INTO lobster_coins (project_id, name, ticker, market_cap, fdv, percent_change_24h)
          VALUES (${projectId}, ${c.name}, ${c.ticker}, ${c.marketCap}, ${c.fdv}, ${c.change24h})
          RETURNING id
        `;
        const snaps = Array.from({ length: DAYS }, (_, d) => ({
          coin_id: coinId as string,
          snapshot_date: ymd(now, d),
          price_usd: round6(wiggle(c.basePrice, ci + i + 1, d, 0.08)),
        }));
        await tx`INSERT INTO daily_coin_snapshots ${tx(snaps)}`;
      }

      // 6) Wallet facets (summed into walletTotalUsd by the projection).
      if (p.wallets.length > 0) {
        await tx`INSERT INTO tracked_wallets ${tx(
          p.wallets.map((w) => ({ project_id: projectId, label: w.label, chain: w.chain, balance_usd: w.balanceUsd })),
        )}`;
      }

      // 7) Vault facet (presence only → the VLT flag).
      if (p.vault !== null) {
        await tx`INSERT INTO agent_vaults (project_id, name) VALUES (${projectId}, ${p.vault})`;
      }
    }
  });

  console.log(`seeded ${PROJECTS.length} demo projects (idempotent)`);
}
