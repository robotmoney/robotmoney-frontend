// Extract stage: pull the SIX approved v0 Supabase tables (read-only, GET-only
// PostgREST, same scope R11 used —
// docs/audits/v0-v1-parity/R11-projects-supabase-audit.md: `projects`,
// `lobster_coins`, `openclaw_agents`, `tracked_wallets`, `agent_vaults`;
// `agent_revenue_daily`/`daily_coin_snapshots` are volatile-metric tables and
// are OUT of scope here — nothing from them is read) and map the rows into
// DiscoveredProject[] — the discovery-seed identity roster
// liveProjectsDataSource.discoverProjects() (../access/live-source.ts) serves.
//
// Network-boundary only: no SQL, no writes to v0, nothing beyond
// `GET .../rest/v1/<table>`. Credentials are read from
// V0_ANALYTICS_SOURCE_URL / V0_ANALYTICS_SOURCE_KEY at CALL time —
// never hardcoded, never logged, never written to a tracked file. A missing
// key throws loudly (resolveV0SupabaseConfig) rather than fabricating a
// roster — same discipline as ../access/fixture-source.ts.
//
// Data-quality discipline (never crash the whole pull on one bad row): a
// project/agent/coin/wallet/vault row that is missing a REQUIRED
// DiscoveredProject/DiscoveredAgent/.../DiscoveredVault field, or whose
// project_id does not resolve to an included active project, is SKIPPED and
// recorded in RosterGenerationStats — never silently dropped, never
// fabricated to fit the shape.
import type {
  DiscoveredAgent,
  DiscoveredCoin,
  DiscoveredProject,
  DiscoveredVault,
  DiscoveredWallet,
} from "../access/data-source.ts";
import { buildManifest, type RosterSeedManifest } from "./roster-seed.ts";

export interface V0SupabaseConfig {
  url: string;
  anonKey: string;
}

export function resolveV0SupabaseConfig(env: Record<string, string | undefined> = process.env): V0SupabaseConfig {
  const url = env.V0_ANALYTICS_SOURCE_URL?.trim();
  const anonKey = env.V0_ANALYTICS_SOURCE_KEY?.trim();
  if (!url) throw new Error("missing required env var: V0_ANALYTICS_SOURCE_URL");
  if (!anonKey) throw new Error("missing required env var: V0_ANALYTICS_SOURCE_KEY");
  return { url: url.replace(/\/+$/, ""), anonKey };
}

// ── Raw v0 row shapes (only the columns this generator reads) ───────────────
interface V0Project {
  id: string;
  slug: string;
  display_name: string;
  status: string;
  description: string | null;
  twitter_handle: string | null;
  website_url: string | null;
  // NOT selected from v0 (see the mapping below): every v0 logo_url is an
  // absolute URL on the v0 Supabase project's own storage host
  // (https://<ref>.supabase.co/storage/...), i.e. it embeds v0's project ref.
  // The task's own static-seed field list omits logo_url for exactly this
  // reason, so this generator never reads or carries that column.
}
interface V0Agent {
  id: string;
  project_id: string | null;
  name: string;
  protocol_standard: string | null;
  wallet_address: string | null;
  virtuals_agent_id: string | null;
  x402_score: number | null;
  x402_txn_count: number | null;
  x402_resources_count: number | null;
  x402_volume_usd: number | null;
  productivity_score: number | null;
  source_confidence: string | null;
}
interface V0Coin {
  id: string;
  project_id: string | null;
  name: string;
  ticker: string;
  coingecko_id: string | null;
  contract_address: string | null;
  chain: string | null;
}
interface V0Wallet {
  id: string;
  project_id: string | null;
  label: string;
  chain: string;
  address: string;
}
interface V0Vault {
  id: string;
  project_id: string | null;
  name: string;
  vault_address: string | null;
  chain: string | null;
  strategy_type: string | null;
  protocol: string | null;
  data_source: string | null;
}

const PAGE_SIZE = 1000;

// PostgREST answers a `Prefer: count=exact` request with
// `Content-Range: <first>-<last>/<total>` (or `*/<total>` for an empty range).
// The total is server-side truth about the FILTERED set — the only number in
// this pipeline that does not come from the rows we happened to receive.
export function parseContentRangeTotal(header: string | null, table: string): number {
  const slash = header ? header.lastIndexOf("/") : -1;
  if (!header || slash < 0) {
    throw new Error(
      `v0 supabase GET ${table}: no row total in the Content-Range response header (got ${JSON.stringify(header)}) — ` +
        `refusing to extract without a server-declared count to check completeness against`,
    );
  }
  const total = Number(header.slice(slash + 1));
  if (!Number.isInteger(total) || total < 0) {
    throw new Error(`v0 supabase GET ${table}: unparseable Content-Range row total in ${JSON.stringify(header)}`);
  }
  return total;
}

// Paginated PostgREST GET. `extraFilter` is an already URL-encoded
// `key=op.value` PostgREST filter string, e.g. "status=eq.active".
//
// KEYSET pagination (`id=gt.<lastId>&order=id.asc`), not limit/offset: `id` is
// a random UUID and the source is a live, concurrently-written database, so an
// insert landing before the current offset shifts the whole window — silently
// skipping a row — and a delete duplicates one. A keyset cursor is anchored to
// a row that was actually seen, so neither can happen.
//
// COMPLETENESS: every request carries `Prefer: count=exact`, and the total the
// server declares on the FIRST page (the only request with no `id=gt.` cursor,
// so the only one whose count covers the whole filtered set) is asserted
// against the number of rows actually collected. Without that assertion an
// anon-key RLS policy hiding rows, a PostgREST `db-max-rows` cap below
// PAGE_SIZE, or an upstream filter change all produce a smaller-but-perfectly-
// self-consistent artifact that no downstream check can distinguish from a
// complete one.
export async function fetchAllRows<T extends { id: string }>(
  cfg: V0SupabaseConfig,
  table: string,
  select: string,
  extraFilter?: string,
): Promise<{ rows: T[]; upstreamTotal: number }> {
  const out: T[] = [];
  let upstreamTotal: number | null = null;
  let cursor: string | null = null;
  for (;;) {
    const params = new URLSearchParams({ select, order: "id.asc", limit: String(PAGE_SIZE) });
    if (cursor !== null) params.set("id", `gt.${cursor}`);
    const url = `${cfg.url}/rest/v1/${table}?${params.toString()}${extraFilter ? `&${extraFilter}` : ""}`;
    const res = await fetch(url, {
      headers: {
        apikey: cfg.anonKey,
        Authorization: `Bearer ${cfg.anonKey}`,
        accept: "application/json",
        Prefer: "count=exact",
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`v0 supabase GET ${table} failed: ${res.status} ${body.slice(0, 300)}`);
    }
    const declared = parseContentRangeTotal(res.headers.get("content-range"), table);
    if (upstreamTotal === null) upstreamTotal = declared;
    const page = (await res.json()) as T[];
    out.push(...page);
    if (page.length < PAGE_SIZE) break;
    const last = page[page.length - 1];
    if (!last || typeof last.id !== "string" || last.id === "") {
      throw new Error(
        `v0 supabase GET ${table}: a full page came back without a usable id on its last row — ` +
          `keyset pagination cannot advance, refusing to fall back to an offset scan`,
      );
    }
    cursor = last.id;
  }
  if (out.length !== upstreamTotal) {
    throw new Error(
      `v0 supabase GET ${table}: fetched ${out.length} row(s) but the server declared ${upstreamTotal} ` +
        `(Prefer: count=exact) — the extract is incomplete or the table changed mid-pull; refusing to build a seed from it`,
    );
  }
  return { rows: out, upstreamTotal };
}

// `*Total` is the number of rows RECEIVED for that table. fetchAllRows has
// already asserted it equals the server-declared `Prefer: count=exact` total,
// so it is upstream truth rather than "however many we happened to get" — but
// the authoritative copy of that number is the one persisted into the manifest
// (RosterSeedManifest.upstreamTotals), not this print-once struct.
export interface RosterGenerationStats {
  projectsTotal: number;
  projectsIncluded: number;
  projectsSkipped: number;
  agentsTotal: number;
  agentsIncluded: number;
  agentsSkipped: number;
  coinsTotal: number;
  coinsIncluded: number;
  coinsSkipped: number;
  walletsTotal: number;
  walletsIncluded: number;
  walletsSkipped: number;
  vaultsTotal: number;
  vaultsIncluded: number;
  vaultsSkipped: number;
  // Human-readable skip/mapping-note log lines, capped so one pathological
  // dataset can never produce an unbounded log.
  notes: string[];
}

function emptyStats(): RosterGenerationStats {
  return {
    projectsTotal: 0, projectsIncluded: 0, projectsSkipped: 0,
    agentsTotal: 0, agentsIncluded: 0, agentsSkipped: 0,
    coinsTotal: 0, coinsIncluded: 0, coinsSkipped: 0,
    walletsTotal: 0, walletsIncluded: 0, walletsSkipped: 0,
    vaultsTotal: 0, vaultsIncluded: 0, vaultsSkipped: 0,
    notes: [],
  };
}

const MAX_NOTES = 200;
function note(stats: RosterGenerationStats, msg: string): void {
  if (stats.notes.length < MAX_NOTES) stats.notes.push(msg);
  else if (stats.notes.length === MAX_NOTES) stats.notes.push("... (further notes suppressed)");
}

// v0's `openclaw_agents.source_confidence` is an evidentiary-STRENGTH tag
// (wallet_proof / payment_proof / directory / social — confirmed against the
// live table; NOT the same three labels v1's DiscoveredAgent.source_confidence
// expects). This audit's own finding, not something R11 mapped. Judgment-call
// mapping by evidentiary strength: on-chain proof -> "high", a directory
// listing -> "medium", a social claim -> "low". Anything else (including null)
// is dropped rather than guessed — never fabricated to fit the enum.
function mapSourceConfidence(
  raw: string | null,
  stats: RosterGenerationStats,
  agentId: string,
): "high" | "medium" | "low" | null {
  if (raw == null) return null;
  switch (raw) {
    case "wallet_proof":
    case "payment_proof":
      return "high";
    case "directory":
      return "medium";
    case "social":
      return "low";
    default:
      note(stats, `agent ${agentId}: unrecognized source_confidence ${JSON.stringify(raw)} — dropped (outside high|medium|low)`);
      return null;
  }
}

// Pure mapping (no network) — kept separate from generateV0RosterArtifact so
// the mapping/skip logic is directly testable against a fixed raw-row fixture.
export function mapV0RosterRows(raw: {
  projects: V0Project[];
  agents: V0Agent[];
  coins: V0Coin[];
  wallets: V0Wallet[];
  vaults: V0Vault[];
}): { projects: DiscoveredProject[]; stats: RosterGenerationStats } {
  const stats = emptyStats();
  const bySlug = new Map<string, DiscoveredProject>();
  const idToSlug = new Map<string, string>();

  stats.projectsTotal = raw.projects.length;
  for (const p of raw.projects) {
    if (p.status !== "active") {
      stats.projectsSkipped++;
      continue; // defensive — the query already filters status=eq.active
    }
    if (!p.slug || !p.display_name) {
      stats.projectsSkipped++;
      note(stats, `project ${p.id}: missing required slug/display_name`);
      continue;
    }
    if (bySlug.has(p.slug)) {
      stats.projectsSkipped++;
      note(stats, `project ${p.id}: duplicate slug ${p.slug} — first occurrence wins`);
      continue;
    }
    const project: DiscoveredProject = {
      slug: p.slug,
      display_name: p.display_name,
      description: p.description ?? null,
      website_url: p.website_url ?? null,
      twitter_handle: p.twitter_handle ?? null,
      // logo_url deliberately dropped — see the V0Project comment above (every
      // v0 value is an absolute URL on v0's OWN Supabase storage host, so
      // carrying it would bake v0's project ref into the committed seed for no
      // functional gain; v1 has no logo-serving surface that reads this field
      // today, and the task's own static-seed field list omits it).
      logo_url: null,
      // v0's `projects` table has NO is_sticky (or equivalent curation) column
      // — confirmed against the live schema (every column returned by
      // select=*). Defaulting false rather than fabricating a curation signal
      // v0 never actually stored.
      is_sticky: false,
      agents: [],
      coins: [],
      wallets: [],
      vaults: [],
    };
    bySlug.set(p.slug, project);
    idToSlug.set(p.id, p.slug);
    stats.projectsIncluded++;
  }

  stats.agentsTotal = raw.agents.length;
  for (const a of raw.agents) {
    const slug = a.project_id ? idToSlug.get(a.project_id) : undefined;
    if (!slug) {
      stats.agentsSkipped++; // unlinked (null project_id) or points at a non-active/duplicate project
      continue;
    }
    if (!a.name || !a.protocol_standard) {
      stats.agentsSkipped++;
      note(stats, `agent ${a.id} (project ${slug}): missing required name/protocol_standard`);
      continue;
    }
    const agent: DiscoveredAgent = {
      name: a.name,
      protocol_standard: a.protocol_standard,
      wallet_address: a.wallet_address ?? null,
      virtuals_agent_id: a.virtuals_agent_id ?? null,
      x402_score: a.x402_score ?? null,
      x402_txn_count: a.x402_txn_count ?? null,
      x402_resources_count: a.x402_resources_count ?? null,
      x402_volume_usd: a.x402_volume_usd ?? null,
      productivity_score: a.productivity_score ?? null,
      source_confidence: mapSourceConfidence(a.source_confidence, stats, a.id),
    };
    bySlug.get(slug)!.agents.push(agent);
    stats.agentsIncluded++;
  }

  stats.coinsTotal = raw.coins.length;
  for (const c of raw.coins) {
    const slug = c.project_id ? idToSlug.get(c.project_id) : undefined;
    if (!slug) {
      stats.coinsSkipped++;
      continue;
    }
    if (!c.name || !c.ticker) {
      stats.coinsSkipped++;
      note(stats, `coin ${c.id} (project ${slug}): missing required name/ticker`);
      continue;
    }
    const coin: DiscoveredCoin = {
      name: c.name,
      ticker: c.ticker,
      coingecko_id: c.coingecko_id ?? null,
      contract_address: c.contract_address ?? null,
      chain: c.chain ?? null,
    };
    bySlug.get(slug)!.coins.push(coin);
    stats.coinsIncluded++;
  }

  stats.walletsTotal = raw.wallets.length;
  for (const w of raw.wallets) {
    const slug = w.project_id ? idToSlug.get(w.project_id) : undefined;
    if (!slug) {
      stats.walletsSkipped++;
      continue;
    }
    if (!w.label || !w.chain || !w.address) {
      stats.walletsSkipped++;
      note(stats, `wallet ${w.id} (project ${slug}): missing required label/chain/address`);
      continue;
    }
    const wallet: DiscoveredWallet = { label: w.label, chain: w.chain, address: w.address };
    bySlug.get(slug)!.wallets.push(wallet);
    stats.walletsIncluded++;
  }

  stats.vaultsTotal = raw.vaults.length;
  for (const v of raw.vaults) {
    const slug = v.project_id ? idToSlug.get(v.project_id) : undefined;
    if (!slug) {
      stats.vaultsSkipped++;
      continue;
    }
    if (!v.name) {
      stats.vaultsSkipped++;
      note(stats, `vault ${v.id} (project ${slug}): missing required name`);
      continue;
    }
    // v0's strategy_type/data_source vocabularies are WIDER than the "erc4626 |
    // lp" / "live | static" the DiscoveredVault comments document (confirmed
    // live: strategy_type also carries "lp-fees"/"erc4626-treasury";
    // data_source also carries "upcoming"). The type itself is a plain
    // `string | null` (not a strict union), so these pass through verbatim
    // rather than being coerced/guessed into the documented pair.
    const vault: DiscoveredVault = {
      name: v.name,
      vault_address: v.vault_address ?? null,
      chain: v.chain ?? null,
      strategy_type: v.strategy_type ?? null,
      protocol: v.protocol ?? null,
      data_source: v.data_source ?? null,
    };
    bySlug.get(slug)!.vaults.push(vault);
    stats.vaultsIncluded++;
  }

  return { projects: [...bySlug.values()], stats };
}

export interface GeneratedRoster {
  projects: DiscoveredProject[];
  manifest: RosterSeedManifest;
  stats: RosterGenerationStats;
}

// Orchestrates the six read-only GETs + mapping. Refuses (throws) rather than
// writing an empty/near-empty seed if the pull produced zero projects — a
// silently-empty roster masquerading as "regenerated successfully" would be
// worse than a loud failure.
export async function generateV0RosterArtifact(cfg: V0SupabaseConfig = resolveV0SupabaseConfig()): Promise<GeneratedRoster> {
  const [projectRows, agentRows, coinRows, walletRows, vaultRows] = await Promise.all([
    fetchAllRows<V0Project>(
      cfg,
      "projects",
      "id,slug,display_name,status,description,twitter_handle,website_url",
      "status=eq.active",
    ),
    fetchAllRows<V0Agent>(
      cfg,
      "openclaw_agents",
      "id,project_id,name,protocol_standard,wallet_address,virtuals_agent_id,x402_score,x402_txn_count,x402_resources_count,x402_volume_usd,productivity_score,source_confidence",
      "is_active=eq.true",
    ),
    fetchAllRows<V0Coin>(
      cfg,
      "lobster_coins",
      "id,project_id,name,ticker,coingecko_id,contract_address,chain",
      "is_active=eq.true",
    ),
    fetchAllRows<V0Wallet>(cfg, "tracked_wallets", "id,project_id,label,chain,address", "is_active=eq.true"),
    fetchAllRows<V0Vault>(
      cfg,
      "agent_vaults",
      "id,project_id,name,vault_address,chain,strategy_type,protocol,data_source",
      "is_active=eq.true",
    ),
  ]);

  const { projects: mapped, stats } = mapV0RosterRows({
    projects: projectRows.rows,
    agents: agentRows.rows,
    coins: coinRows.rows,
    wallets: walletRows.rows,
    vaults: vaultRows.rows,
  });
  if (mapped.length === 0) {
    throw new Error(
      "v0 roster generation produced ZERO projects — refusing to write an empty seed " +
        "(this almost certainly means the fetch/mapping silently failed, not that v0 has no active projects)",
    );
  }
  // Server-declared upstream totals and the skip tallies go INTO the manifest,
  // not just onto the operator's terminal: printed-then-discarded stats cannot
  // be checked by anything later, which is what let a self-derived manifest
  // look complete. validateRoster reconciles included + skipped === upstream on
  // every load from here on.
  const upstreamTotals = {
    projects: projectRows.upstreamTotal,
    agents: agentRows.upstreamTotal,
    coins: coinRows.upstreamTotal,
    wallets: walletRows.upstreamTotal,
    vaults: vaultRows.upstreamTotal,
  };
  const skipped = {
    projects: stats.projectsSkipped,
    agents: stats.agentsSkipped,
    coins: stats.coinsSkipped,
    wallets: stats.walletsSkipped,
    vaults: stats.vaultsSkipped,
  };
  const manifest = buildManifest(mapped, { generatedAt: new Date().toISOString(), upstreamTotals, skipped });
  return { projects: mapped, manifest, stats };
}
