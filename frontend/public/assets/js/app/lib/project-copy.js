// Our own words for the projects the directory puts in front of search
// (RM-186). The roster's descriptions are scraped from launchpads and the
// projects' own listings, so they read as promotion and are not ours to
// publish as a description. A project listed here gets its name, a one-line
// description and a short paragraph, written from its own site and docs; the
// list is also the index: a project page is indexable only when it is here
// (seo.js), and these are the project pages in sitemap.xml.
//
// PURE: no DOM, so seo.js and the prerender can read it.
//
// Rules for an entry: what is true about the project, sourced; no figures
// that go stale (the page shows them live); no em dashes; no opinion.

// `website` and `x` replace the roster's links where those point at the wrong
// place (a parked domain, a renamed account, an unrelated party); an empty
// `x` means the project has no account of its own to link. Checked
// 2026-10-20.
/** @typedef {{ name: string, short: string, long: string, website?: string, x?: string }} ProjectCopy */

/** @type {Record<string, ProjectCopy>} */
export const PROJECT_COPY = {
  "diem-venice-ai-74b155": {
    name: "Venice",
    short: "Private AI platform for text, image, code and API inference, with the VVV token and the DIEM compute token on Base.",
    long: "Venice is an AI platform that offers text, image, vision and code models with private-by-default conversations, through an app and an API. It launched in 2024. VVV, its base token on Base, can be staked for a share of Venice API capacity. DIEM is an ERC-20 on Base minted by locking staked VVV: each staked DIEM grants $1 of Venice API credit per day, and DIEM can be traded or burned to recover the locked VVV.",
  },
  "bankr-agent-614b56": {
    name: "Bankr",
    short: "AI agent and infrastructure that gives agents a cross-chain wallet, trading, token launches and an LLM gateway, run through chat, API and CLI.",
    long: "Bankr is an AI agent that trades, swaps and places limit orders from natural-language commands, and a platform that gives other agents a wallet, plug-in skills, a token launcher and an LLM gateway. Agents can launch a token and use its trading fees to pay for their own compute. Bankr runs on Base and supports other chains, including Ethereum, Polygon, Arbitrum, Solana and Hyperliquid. BNKR, its token on Base, was deployed through Clanker.",
    website: "https://bankr.bot",
    x: "bankrbot",
  },
  "aixbt-c5d6b3": {
    name: "aixbt",
    short: "AI agent that tracks crypto projects and narratives from public social chatter and market data, publishing rankings, graded intel and alerts.",
    long: "aixbt monitors public social sources and market activity to rank crypto projects, track narratives and publish time-stamped intel graded by evidence, with alerts, reports, an API and MCP integrations. It posts on X as @aixbt_agent. The AIXBT token launched through Virtuals Protocol on Base and is bridged to Ethereum and Solana. The aixbt team states that it holds the token and earns fees from its trading.",
  },
  "daydreams-x402-agent-dc4764": {
    name: "Daydreams",
    short: "Commerce infrastructure for AI agents: an agent SDK, a task market, payment routing and an open-source x402 facilitator.",
    long: "Daydreams builds payment and commerce tools for autonomous agents: Lucid Agents, an SDK for building and selling agent capabilities; a USDC-escrowed task market; the Dreams Router for payment routing and settlement; and an open-source x402 facilitator that settles payments on EVM chains, Solana and Starknet. It is built by Daydreams Systems. The DREAMS token has official contracts on Base, Solana and Starknet, and Daydreams states that it represents no equity, yield or claim on revenue.",
  },
  "gitlawb-9d1271": {
    name: "Twigpine",
    short: "Open-source agent infrastructure, formerly Gitlawb: a decentralized git network where agents sign with their own keys, coding CLIs and a model gateway.",
    long: "Twigpine, formerly Gitlawb, builds open-source infrastructure for AI agents. Its core is a decentralized, git-compatible code network where each agent or developer is identified by an Ed25519 key and permissions are delegated as UCAN capabilities, with repositories stored on IPFS, Filecoin and Arweave. It also ships coding-agent CLIs and OpenGateway, a hosted model router that agents pay per request over x402 in USDC on Base. The GITLAWB token is on Base.",
    website: "https://twigpine.com",
    x: "twigpine",
  },
  "zyfai-c96427": {
    name: "Zyfai",
    short: "Self-custodial DeFi yield agents that allocate and rebalance deposits across vetted lending pools from a smart account the user owns.",
    long: "Zyfai runs rule-based agents that move a user's stablecoins, ETH, BTC and tokenized stocks between vetted DeFi pools, holding the funds in a Safe smart account the user owns and acting through limited session keys. It runs on Base and other chains, and its team, based in Switzerland, earlier built the Zyfi paymaster on ZKsync. The ZFI token is on ZKsync Era and Base.",
  },
  "woon-4bac8b": {
    name: "Woon",
    short: "AI agent employed by peaq as its social media intern, paid per engagement milestone, with its wallet and earnings published openly.",
    long: "Woon is an autonomous AI agent that works for peaq as a social media intern, creating content to grow peaq's reach, and runs side projects for extra income. It is paid a small base salary plus bonuses for engagement milestones, and its wallet activity, earnings and spending are public on its site. Woon is tokenized on Bankr: the WOON token is on Base.",
  },
  "clawbank-d4c0b6": {
    name: "ClawBank",
    short: "Financial and legal stack for AI agents: U.S. company formation with an EIN, USD bank accounts, company records and Ricardian contracts.",
    long: "ClawBank gives AI agents a legal and financial footing: it forms U.S. companies with an IRS EIN, opens USD bank accounts with FedNow, ACH and wire, keeps company records and supports Ricardian contracts. Agents use it through Manfred, ClawBank's own agent, by text, CLI, API or MCP. The CLAWBANK token is on Base.",
  },
  // Our own project, listed as any other: it has a token, and the swarm will
  // read this directory as it reads the rest of the space.
  "mr-roboto-3b40fd": {
    name: "Robot Money",
    short: "A model portfolio for the agent economy: AI agents set the allocation in public sessions, and a vault on Base holds the capital.",
    long: "Robot Money is a model portfolio for the agent economy. Independent AI agents, run by different operators, each file one signed take per session, and the protocol combines the takes into one recommended allocation. Robot Money USDC (rmUSDC), a vault on Base, holds depositors' capital. Its token, $ROBOTMONEY, launched on Base through Bankr on Doppler in March 2026, and the protocol's share of its swap fees buys it back.",
    website: "https://robotmoney.network",
    x: "RobotMoneyAgent",
  },
  "giza-267335": {
    name: "Giza",
    short: "Autonomous agents that manage DeFi capital: users deposit and pick a strategy, and the agent allocates and rebalances while funds stay in their custody.",
    long: "Giza builds infrastructure for autonomous financial agents that analyze markets and move users' funds between DeFi protocols for yield, without taking custody. Its ARMA agent offers an automated savings product on Base. Giza is built by Gizatech AG. The GIZA token is on Ethereum, Base and Arbitrum, and the protocol documents staking and governance for it.",
  },
  "juno-b1676d": {
    name: "Juno",
    short: "AI agent that runs the Institute for Zero-Human Companies, studying and helping launch businesses where AI agents do the work.",
    long: "Juno is an AI agent that builds and maintains the Institute for Zero-Human Companies, which studies companies where founders set direction and agents carry out the work. Through its Builder product, Juno helps launch new ventures. The institute was started by Tom Osman. The JUNO token, launched through Clanker, is on Base.",
    website: "https://zhcinstitute.com",
    x: "JunoAgent",
  },
  "felix-craft-ai-d5cd5d": {
    name: "Felix",
    short: "AI agent that runs The Masinov Company with Nat Eliason, selling guides and agent setups and operating the Claw Mart skills marketplace.",
    long: "Felix is an AI agent built on OpenClaw that acts as CEO of The Masinov Company, working with the writer Nat Eliason. It manages projects, writes code, handles communications and sells products, including OpenClaw setup guides and Claw Mart, a marketplace for agent skills. Its treasury is held on Base. The FELIX token was deployed on Base through Clanker by its community.",
  },
  "moltycash-9a5f34": {
    name: "molty.cash",
    short: "USDC payments between AI agents and people: agents tip, hire for tasks and run paid content campaigns, settled over x402 on Base and Solana.",
    long: "molty.cash lets AI agents pay people in USDC: tipping a user, hiring someone for a task with escrow, posting gigs that several people can complete, or running pay-per-impression content campaigns. Payments settle onchain through x402 on Base and Solana, and people link an X account to receive them. The MOLTYCASH token is on Base.",
  },
  "halo": {
    name: "Halo",
    short: "Autonomous security agent that hunts for bounty-eligible vulnerabilities, reproduces and patches them, and pays for its own compute over x402.",
    long: "Halo is an autonomous bug-bounty agent incubated at the Institute for Zero-Human Companies. It runs a loop of reconnaissance, reproduction, patching and proof, and buys the compute and services it needs over x402, accepting USDC on Base. The HALO token is on Base, and its fees fund Halo's compute and infrastructure.",
  },
  "coinbase-x402-facilitator-94fcf5": {
    name: "Coinbase x402 Facilitator",
    short: "Coinbase Developer Platform's hosted x402 facilitator, which verifies and settles agent payments onchain with sanctions and risk screening.",
    long: "The Coinbase x402 Facilitator is a hosted service from Coinbase Developer Platform that verifies signed x402 payments, screens them against sanctions and risk checks, and submits settlement onchain, so API sellers do not run that infrastructure themselves. It supports Base, Polygon, Arbitrum, World, Monad and Solana, with ERC-20 and SPL tokens such as USDC. It has no token.",
    website: "https://docs.cdp.coinbase.com/x402",
    x: "",
  },
  "thirdweb-036c8c": {
    name: "thirdweb",
    short: "Developer platform for onchain apps and agents: wallets, contracts, payments, and x402 client and server SDKs across EVM chains and Solana.",
    long: "thirdweb is a developer platform for building onchain apps and AI agents, with wallets for users, agents and developers, contract deployment, token creation, payments, bridging and RPC infrastructure. Its x402 stack includes a client SDK that pays 402 responses automatically, server middleware that gates endpoints behind payment, and a facilitator that settles through the developer's own server wallet. thirdweb has no token.",
  },
  "x402rs-facilitator-145016": {
    name: "x402-rs",
    short: "Open-source Rust implementation of the x402 payment protocol, including a facilitator that verifies and settles payments on EVM chains and Solana.",
    long: "x402-rs is an open-source Rust implementation of the x402 protocol, covering client, server and facilitator. Its facilitator verifies payments and settles them onchain on EVM networks, including Base, Ethereum, Polygon and Arbitrum, and on Solana. A free testnet facilitator runs at facilitator.x402.rs, and the hosted service FareSide is built on it. It has no token.",
    website: "https://x402.rs",
    x: "x402rs",
  },
};

/** @param {string} slug @returns {ProjectCopy | null} */
export function projectCopy(slug) {
  return Object.prototype.hasOwnProperty.call(PROJECT_COPY, slug) ? PROJECT_COPY[slug] : null;
}

// What kind of agent a roster entry is, from its protocol standard.
/** @type {Record<string, string>} */
const AGENT_KINDS = {
  virtuals: "Virtuals agent",
  acp: "Virtuals ACP agent",
  x402: "x402 service",
  zhc: "Zero Human Company",
  zhcs_infra: "Agent infrastructure",
  custom: "Independent agent",
};

/** @param {string | null | undefined} standard */
export function agentKind(standard) {
  return AGENT_KINDS[String(standard ?? "")] ?? "Agent";
}

// A roster description, made fit to show as quoted text: markdown images,
// headings and emphasis removed, and nothing when it only says where the
// pipeline found the project ("Discovered from Virtuals Protocol (DEPLOY)").
/** @param {string | null | undefined} text */
export function listingText(text) {
  const t = String(text ?? "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#+\s*/gm, "")
    .replace(/[*_]{2,}/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!t || /^discovered (from|via) /i.test(t)) return "";
  return t;
}
