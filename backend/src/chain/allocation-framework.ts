// Admin/swarm-managed allocation framework for GET /api/dashboards/allocation
// (live-data contract §4). This is NOT a chain read and carries NO AI enrichment
// (see the "projects overviews admin-managed" policy): it projects the single-row
// allocation_framework table (migration 0001), which db/seed.ts seeds once from
// robotmoney-site/data/committee/allocation.json and an admin may later rewrite.
//
// Replaces the baked bucket percentages in the frontend allocation view (95%
// Conservative DeFi Yield / 5% Agent Tokens / 0% Protocol / 0% RWA and the
// per-item legend weights). managed:true — the data is intentionally static
// until an admin rewrites the row; there is no chain 'stale' concept here.
import { resolveBaseRpcSource, type BaseRpcSource } from "../config.ts";
import { sql } from "../db/client.ts";
import { ttlCached } from "./ttl-cache.ts";

export interface AllocationStrategy {
  label: string;
  targetPct: number;
}
export interface AllocationItem {
  label: string;
  targetPct: number;
}
export interface AllocationBucket {
  key: string;
  label: string;
  items: AllocationItem[];
}
export interface AllocationFramework {
  strategy: AllocationStrategy[];
  buckets: AllocationBucket[];
  asOf: string;
  source: BaseRpcSource;
  managed: true;
}

// Raw bucket shape as stored in allocation_framework.buckets (faithful to the
// swarm source-of-truth allocation.json — weights are fractions in [0,1]).
interface RawItem {
  id: string;
  name: string;
  target_weight: number;
}
interface RawBucket {
  id: string;
  name: string;
  target_weight: number;
  items?: RawItem[];
}
interface FrameworkSeed {
  asof: string;
  vault_contract: string;
  buckets: RawBucket[];
}

// Seed copied verbatim from robotmoney-site/data/committee/allocation.json
// (target_weight values only — the swarm's authoritative policy). Exported so
// db/seed.ts inserts it ON CONFLICT DO NOTHING (never clobbering an admin edit)
// and so getAllocationFramework can fall back to it if the row is somehow absent.
// Do NOT invent weights the swarm data does not carry.
export const ALLOCATION_FRAMEWORK_SEED: FrameworkSeed = {
  asof: "2026-06-02",
  vault_contract: "0x4f835c9f54bcf17daf9040f60cb72951ccbb49dd",
  buckets: [
    {
      id: "conservative_defi_yield",
      name: "Conservative DeFi Yield",
      target_weight: 0.95,
      items: [
        { id: "aave", name: "Aave", target_weight: 0.25 },
        { id: "morpho", name: "Morpho", target_weight: 0.25 },
        { id: "compound", name: "Compound", target_weight: 0.25 },
        { id: "sky", name: "Sky", target_weight: 0.25 },
      ],
    },
    {
      id: "agent_tokens",
      name: "Agent Tokens",
      target_weight: 0.05,
      items: [
        { id: "robotmoney", name: "RobotMoney", target_weight: 0.1429 },
        { id: "juno", name: "Juno", target_weight: 0.1429 },
        { id: "woon", name: "Woon", target_weight: 0.1429 },
        { id: "peaq", name: "Peaq", target_weight: 0.1429 },
        { id: "zyfai", name: "Zyfai", target_weight: 0.1429 },
        { id: "giza", name: "Giza", target_weight: 0.1428 },
        { id: "deus", name: "DEUS", target_weight: 0.1427 },
      ],
    },
    {
      id: "protocol_tokens",
      name: "Protocol Tokens",
      target_weight: 0.0,
      items: [
        { id: "btc", name: "BTC", target_weight: 0.3333 },
        { id: "eth", name: "ETH", target_weight: 0.3333 },
        { id: "hype", name: "HYPE", target_weight: 0.3334 },
      ],
    },
    {
      id: "real_world_assets",
      name: "Real World Assets",
      target_weight: 0.0,
      items: [
        { id: "spy", name: "SPY", target_weight: 0.5 },
        { id: "gold", name: "Gold", target_weight: 0.5 },
      ],
    },
  ],
};

// Canonical short bucket keys the allocation view's 2x2 cards address (contract
// §4 golden). Unknown buckets fall back to a slug of the source id.
const BUCKET_KEYS: Record<string, string> = {
  conservative_defi_yield: "defi-yield",
  agent_tokens: "agent-tokens",
  protocol_tokens: "protocol-tokens",
  real_world_assets: "rwa",
};

function keyFor(id: string): string {
  return BUCKET_KEYS[id] ?? id.replace(/_/g, "-");
}

// Fraction [0,1] → percentage with 2dp precision (0.95 → 95, 0.1429 → 14.29) so
// the swarm's exact item weights are preserved, not rounded to a losing int.
function pct(weight: number): number {
  return Math.round(weight * 10000) / 100;
}

function toIsoDay(d: Date | string | null | undefined): string {
  if (d == null) return new Date().toISOString().slice(0, 10);
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return String(d).slice(0, 10);
  return date.toISOString().slice(0, 10);
}

interface Row {
  asof: Date | string | null;
  buckets: RawBucket[];
}

const CACHE_TTL_MS = 30_000;

async function computeAllocationFramework(): Promise<AllocationFramework> {
  const now = Date.now();

  const source = resolveBaseRpcSource();

  let asof: Date | string | null;
  let rawBuckets: RawBucket[];
  try {
    const rows = await sql<Row[]>`SELECT asof, buckets FROM allocation_framework WHERE id = 1`;
    const row = rows[0];
    if (row && Array.isArray(row.buckets) && row.buckets.length > 0) {
      asof = row.asof;
      rawBuckets = row.buckets;
    } else {
      // Row absent/empty: fall back to the swarm seed default (managed data
      // is intentionally static; this is not a degraded chain read).
      asof = ALLOCATION_FRAMEWORK_SEED.asof;
      rawBuckets = ALLOCATION_FRAMEWORK_SEED.buckets;
    }
  } catch (err) {
    console.error("allocation-framework: table read failed, serving swarm seed default:", err);
    asof = ALLOCATION_FRAMEWORK_SEED.asof;
    rawBuckets = ALLOCATION_FRAMEWORK_SEED.buckets;
  }

  const strategy: AllocationStrategy[] = rawBuckets.map((b) => ({ label: b.name, targetPct: pct(b.target_weight) }));
  const buckets: AllocationBucket[] = rawBuckets.map((b) => ({
    key: keyFor(b.id),
    label: b.name,
    items: (b.items ?? []).map((i) => ({ label: i.name, targetPct: pct(i.target_weight) })),
  }));

  return { strategy, buckets, asOf: toIsoDay(asof), source, managed: true };
}

export const getAllocationFramework = ttlCached(computeAllocationFramework, CACHE_TTL_MS);

export function _resetAllocationFrameworkCacheForTests(): void {
  getAllocationFramework._resetForTests();
}
