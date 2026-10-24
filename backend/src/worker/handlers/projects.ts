// Projects pipeline handlers (issue #87). Ports the six deprecated bot-analytics
// edge-function buckets onto the kind→handler worker pattern:
//   projects.discover          ← discover-agents/virtuals/acp/wallets
//   projects.refresh_coins     ← refresh-lobster-coins (CoinGecko + DexScreener)
//   projects.refresh_wallets   ← refresh-wallet-balances
//   projects.sync_revenue      ← sync-agent-revenue-virtuals + -x402
//   projects.snapshot_daily    ← snapshot-daily
//   projects.fetch_vaults      ← fetch-vault-data
//   projects.recompute_coverage← resolve_project_identity + compute_project_coverage
//
// Each handler pulls provider payloads through the data-source seam
// (projects/access) and applies the pure transforms (projects/transforms.ts).
// DEGRADE-TO-PERSISTED: every extractor call is done BEFORE any write; if it
// throws, the handler logs loudly, writes NOTHING (last-persisted rows stay
// intact), and returns a non-success status ({ ok:false, status:"degraded" }).
// Nothing on the path is fabricated. All writes upsert on natural keys so a
// re-run never duplicates rows.
// Every read and write goes to the api (pipeline/stores/projects.ts, issue
// 1034): this worker holds no database credential.
import { pipelineIngest, pipelineRead } from "../pipeline-client.ts";
import { PIPELINE_MAX_ROWS, pipelineChunks } from "../../lib/pipeline-wire.ts";
import type { CoinMarketUpdate } from "../../pipeline/stores/projects.ts";
import { declineReplayedSlot, isReplayedSlot } from "./slot.ts";
import { selectProjectsDataSource } from "../../projects/access/select.ts";
import {
  PermanentVaultReadError,
  type DiscoveredProject,
  type ProjectsDataSource,
  type WalletBalanceRead,
} from "../../projects/access/data-source.ts";
import {
  coinGeckoFields,
  computeCoverage,
  coinSnapshotRow,
  dexScreenerBest,
  vaultTvlErc4626,
  virtualsRevenueRow,
  x402RevenueRows,
  type AgentSnapshot,
  type CoverageInputs,
  type RevenueRow,
  type SourceConfidence,
} from "../../projects/transforms.ts";

export interface HandlerResult {
  ok: boolean;
  status: "ok" | "degraded" | "skipped";
  [k: string]: unknown;
}

const today = (): string => new Date().toISOString().slice(0, 10);
const since30 = (): string => new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);

function degraded(kind: string, err: unknown, extra: Record<string, unknown> = {}): HandlerResult {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[projects.${kind}] extractor failed — keeping last-persisted rows (degraded):`, message);
  return { ok: false, status: "degraded", error: message, ...extra };
}

// ── Discovery ────────────────────────────────────────────────────────────────

// resolved_at / enriched_at describe WHEN THE IDENTITY DATA WAS CAPTURED, not
// when this job last ran — the leaderboard's source-health panel
// (projects/leaderboard-projections.ts sourceHealth) reads enriched_at and
// calls a source "healthy" when it is within 36h. The live source serves a
// committed roster frozen at its manifest's generatedAt, so stamping now() on
// those rows every night would report a months-old dataset as fresh forever.
// A source that declares its as-of wins; one that does not (the hermetic
// fixture) falls back to wall-clock now, which for it is the truth.
export function resolveDiscoveryTimestamp(asOf: string | null | undefined, now: Date = new Date()): Date {
  if (asOf == null) return now;
  const parsed = new Date(asOf);
  if (Number.isNaN(parsed.getTime())) {
    // Never silently substitute now() for an unparseable claim — that is how a
    // fabricated freshness gets in through the back door.
    throw new Error(`projects.discover: data source declared an unparseable discoveredAsOf ${JSON.stringify(asOf)}`);
  }
  return parsed;
}

// A multi-row `ON CONFLICT DO UPDATE` fails outright ("cannot affect row a
// second time") if two rows in the SAME statement collide on the conflict key,
// so the batching above only holds while the payload is unique on exactly the
// keys the upserts target. The seed loader already enforces this
// (projects/seed/roster-seed.ts validateRoster), but discover() accepts any
// data source, so it is re-checked here and reported as a degrade rather than
// surfacing as a raw Postgres error mid-transaction.
export function assertUpsertKeysUnique(projects: readonly DiscoveredProject[]): void {
  const slugs = new Set<string>();
  for (const p of projects) {
    if (slugs.has(p.slug)) throw new Error(`projects.discover: duplicate project slug ${JSON.stringify(p.slug)} in the discovered payload`);
    slugs.add(p.slug);
    const check = (facet: string, key: string, values: string[]) => {
      const seen = new Set<string>();
      for (const v of values) {
        if (seen.has(v)) {
          throw new Error(
            `projects.discover: project ${p.slug} has two ${facet} rows sharing ${key} ${JSON.stringify(v)} — ` +
              `they collide on the (project_id, ${key}) upsert key`,
          );
        }
        seen.add(v);
      }
    };
    check("agent", "name", p.agents.map((a) => a.name));
    check("coin", "name", p.coins.map((c) => c.name));
    check("wallet", "label", p.wallets.map((w) => w.label));
    check("vault", "name", p.vaults.map((v) => v.name));
  }
}

// A discovery run that carries fewer projects than this fraction of what is
// currently live does NOT deactivate anything — it reports the shortfall
// instead. Auto-deactivation is only safe when the incoming roster is trusted
// to be complete; layering it on top of a silent under-extraction would take
// the whole directory down automatically. An operator who means it enqueues the
// job with payload {"allowShrink": true}.
export const DISCOVERY_SHRINK_FLOOR_RATIO = 0.1;

/** Discovered projects in requests of at most PIPELINE_MAX_ROWS rows, a project and its facets each counting one. */
function discoveryChunks(projects: readonly DiscoveredProject[]): DiscoveredProject[][] {
  const out: DiscoveredProject[][] = [];
  let current: DiscoveredProject[] = [];
  let rows = 0;
  for (const p of projects) {
    const n = 1 + p.agents.length + p.coins.length + p.wallets.length + p.vaults.length;
    if (current.length > 0 && rows + n > PIPELINE_MAX_ROWS) {
      out.push(current);
      current = [];
      rows = 0;
    }
    current.push(p);
    rows += n;
  }
  if (current.length > 0) out.push(current);
  return out;
}

export async function discover(
  payload: Record<string, unknown> = {},
  source: ProjectsDataSource = selectProjectsDataSource(),
): Promise<HandlerResult> {
  let projects: DiscoveredProject[];
  let discoveredAt: Date;
  try {
    projects = await source.discoverProjects();
    discoveredAt = resolveDiscoveryTimestamp(await source.discoveredAsOf?.());
    assertUpsertKeysUnique(projects);
  } catch (err) {
    return degraded("discover", err);
  }

  const allowShrink = payload.allowShrink === true;
  let upserted = 0;
  let deactivated = 0;
  let shrinkRefusal: string | null = null;

  // Read BEFORE the upserts, while it still means "rows a previous discovery
  // run left live".
  const activeBefore = await pipelineRead<number>("projects.active_discovered_count");

  // The roster is upserted in requests of at most PIPELINE_MAX_ROWS rows (a
  // project and each of its facets count one), each its own transaction in the
  // api (issue 1034). Every upsert is idempotent on its natural key, so a run
  // that stops between requests leaves rows the next run rewrites, and the
  // reconciliation below only runs once every request has landed.
  for (const chunk of discoveryChunks(projects)) {
    upserted += await pipelineIngest<number>("projects.upsert_discovered", chunk, discoveredAt);
  }

  // ── Reconciliation ────────────────────────────────────────────────────
  // Without this, discovery is append-only: `projections.ts` serves
  // `WHERE status = 'active'`, nothing else in the repo ever deactivates a
  // project, and so a project dropped from the roster — or the entire roster,
  // if this change were reverted — stays in the public directory forever with
  // a frozen resolved_at, removable only by hand-written SQL against prod.
  // Rows are marked inactive, NEVER deleted (pipeline/stores/projects.ts
  // deactivateMissing). Only rows a previous discovery run wrote are eligible.
  const floor = Math.ceil(activeBefore * (1 - DISCOVERY_SHRINK_FLOOR_RATIO));
  if (!allowShrink && activeBefore > 0 && projects.length < floor) {
    shrinkRefusal =
      `discovered ${projects.length} project(s) against ${activeBefore} currently active — below the ` +
      `${Math.round(DISCOVERY_SHRINK_FLOOR_RATIO * 100)}% shrink floor of ${floor}; deactivation SKIPPED ` +
      `(re-enqueue with payload {"allowShrink":true} if the roster really did shrink)`;
    console.error(`[projects.discover] ${shrinkRefusal}`);
  } else {
    deactivated = await pipelineIngest<number>("projects.deactivate_missing", projects.map((p) => p.slug));
    if (deactivated > 0) {
      console.warn(`[projects.discover] deactivated ${deactivated} project(s) absent from the discovered roster`);
    }
  }
  return { ok: true, status: "ok", projects: upserted, deactivated, shrinkRefusal };
}

// ── Market refresh ───────────────────────────────────────────────────────────
export async function refreshCoins(
  _payload: Record<string, unknown> = {},
  source: ProjectsDataSource = selectProjectsDataSource(),
): Promise<HandlerResult> {
  const coins = await pipelineRead<{ id: string; coingecko_id: string | null; contract_address: string | null; chain: string | null }[]>(
    "projects.active_coins",
  );
  if (!coins.length) return { ok: true, status: "ok", updated: 0 };

  const cg = coins.filter((c) => c.coingecko_id);
  const dex = coins.filter((c) => !c.coingecko_id && c.contract_address);

  // Extract first; a single failure degrades the whole run (no partial writes).
  const updates: CoinMarketUpdate[] = [];
  try {
    if (cg.length) {
      const rows = await source.coinGeckoMarkets(cg.map((c) => c.coingecko_id as string));
      const byId = new Map(rows.map((r) => [r.id, r]));
      for (const c of cg) {
        const r = byId.get(c.coingecko_id as string);
        if (r) updates.push({ id: c.id, f: coinGeckoFields(r) });
      }
    }
    for (const c of dex) {
      const payload = await source.dexScreenerToken(c.contract_address as string);
      const res = dexScreenerBest(payload, { contract_address: c.contract_address as string, chain: c.chain });
      if (res.status === "ok") updates.push({ id: c.id, f: res.values });
    }
  } catch (err) {
    return degraded("refresh_coins", err, { updated: 0 });
  }

  for (const chunk of pipelineChunks(updates)) await pipelineIngest("projects.update_coins", chunk);
  return { ok: true, status: "ok", updated: updates.length };
}

// ── Wallet refresh ───────────────────────────────────────────────────────────
// Issue #346: each wallet degrades INDEPENDENTLY. Previously a single wallet's
// read failure (e.g. an unsupported chain, or a transient RPC error) caught at
// the loop level and aborted the WHOLE run — every other wallet's balance,
// including ones on a chain with a real live path, stayed stuck at its last
// value even though nothing was wrong with it. Now a failing wallet keeps its
// last-persisted balance_usd (nothing fabricated) while every wallet whose
// read succeeded still updates.
export async function refreshWallets(
  _payload: Record<string, unknown> = {},
  source: ProjectsDataSource = selectProjectsDataSource(),
): Promise<HandlerResult> {
  const wallets = await pipelineRead<{ id: string; address: string | null; chain: string | null }[]>("projects.active_wallets");
  if (!wallets.length) return { ok: true, status: "ok", updated: 0, failed: 0, unsupported: 0 };

  const updates: { id: string; balance: number }[] = [];
  let failed = 0;
  // Issue 1275: a wallet the source has no live read path for (a non-Base
  // chain, a non-EVM address) is a known, permanent gap, not a failure. It is
  // skipped before any read, keeps its last-persisted balance_usd, and is
  // reported once per run at info level instead of an error line per wallet
  // that also degraded every run.
  let unsupported = 0;
  const byChain = new Map<string, { id: string; address: string }[]>();
  for (const w of wallets) {
    const address = w.address as string;
    const chain = w.chain ?? "base";
    if (!source.supportsWallet(address, chain)) {
      unsupported += 1;
      continue;
    }
    const group = byChain.get(chain) ?? [];
    group.push({ id: w.id, address });
    byChain.set(chain, group);
  }

  // Issue 1373: one batched read per chain (in production only "base"), not one
  // RPC POST per wallet. 793 wallets one at a time took 52 min per attempt at
  // the shared 0.25 calls/s Base RPC budget; the batched read is a few
  // Multicall3 POSTs and one price read. Each wallet still gets its own result,
  // so one failed read fails only that wallet.
  for (const [chain, group] of byChain) {
    let reads: Map<string, WalletBalanceRead>;
    try {
      reads = await source.walletBalancesUsd(group.map((w) => w.address), chain);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      reads = new Map(group.map((w) => [w.address.toLowerCase(), { ok: false, error } as const]));
    }
    for (const w of group) {
      const read = reads.get(w.address.toLowerCase()) ?? { ok: false, error: new Error("no balance returned") };
      if (read.ok) {
        updates.push({ id: w.id, balance: read.balanceUsd });
        continue;
      }
      failed += 1;
      console.error(
        `[projects.refresh_wallets] wallet ${w.id} live read failed, keeping last-persisted balance (degraded):`,
        read.error.message,
      );
    }
  }

  for (const chunk of pipelineChunks(updates)) await pipelineIngest("projects.update_wallet_balances", chunk);

  if (unsupported > 0) {
    console.log(
      `[projects.refresh_wallets] skipped ${unsupported} of ${wallets.length} wallet(s) with no live read path ` +
        "(chain not base, or address not 0x plus 40 hex); kept their last-persisted balance",
    );
  }

  if (failed === 0) return { ok: true, status: "ok", updated: updates.length, failed: 0, unsupported };
  // Some (or all) wallets degraded. `ok` must reflect ANY per-wallet failure
  // (not "did at least one wallet succeed") so it stays consistent with every
  // other handler's ok<->status:"degraded" pairing and with loop.ts's
  // isDegradedResult gate, which keys retry/backoff/admin-visibility purely
  // off `ok === false`. A partial failure that also reported ok:true here
  // fell through to the ordinary success path (status='succeeded', last_error
  // cleared, no backoff, invisible to GET /api/admin/runs?status=degraded).
  // Wallets with no live path never reach here: they are counted in
  // `unsupported` above, so `failed` is only real read failures.
  return { ok: false, status: "degraded", updated: updates.length, failed, unsupported };
}

// ── Revenue sync (virtuals fee revenue + x402 volume rollup) ─────────────────
export async function syncRevenue(
  _payload: Record<string, unknown> = {},
  source: ProjectsDataSource = selectProjectsDataSource(),
): Promise<HandlerResult> {
  const day = today();

  const virtualsAgents = await pipelineRead<{ id: string; virtuals_agent_id: string | null; wallet_address: string | null }[]>(
    "projects.virtuals_agents",
  );

  const rows: RevenueRow[] = [];
  try {
    for (const a of virtualsAgents) {
      const token = a.virtuals_agent_id || a.wallet_address;
      if (!token) continue;
      const payload = await source.dexScreenerToken(token);
      const row = virtualsRevenueRow(payload, { agent_id: a.id, date: day });
      if (row) rows.push(row);
    }
  } catch (err) {
    return degraded("sync_revenue", err, { upserted: 0 });
  }

  // x402 rollup reads already-persisted daily_agent_snapshots (no network).
  const snaps = await pipelineRead<AgentSnapshot[]>("projects.agent_snapshots_since", since30());
  rows.push(...x402RevenueRows(snaps));

  if (!rows.length) return { ok: true, status: "ok", upserted: 0 };
  for (const chunk of pipelineChunks(rows)) await pipelineIngest("projects.upsert_revenue", chunk);
  return { ok: true, status: "ok", upserted: rows.length };
}

// ── Daily snapshots ──────────────────────────────────────────────────────────
// Optional payload.project_ids scopes the snapshot to specific projects (the
// legacy compute was per-project; prod fires it unscoped for the whole directory).
export async function snapshotDaily(payload: Record<string, unknown> = {}): Promise<HandlerResult> {
  // Class C (NOT_BACKFILLABLE, issue #614): this is a rollup of CURRENT
  // persisted state (lobster_coins, openclaw_agents, tracked_wallets,
  // agent_vaults) — there is no historical version of those rows to read, so
  // a replayed slot for a past date would write TODAY's current values under
  // a stale day-key, fabricating history rather than recording it.
  if (isReplayedSlot(payload)) return declineReplayedSlot("projects.snapshot_daily", payload);
  // An explicit empty project_ids:[] means the whole directory, never `IN ()`.
  const ids = Array.isArray(payload.project_ids) && payload.project_ids.length > 0 ? (payload.project_ids as string[]) : null;
  // The rollup reads and writes only persisted state, so the api runs it as one
  // transaction (pipeline/stores/projects.ts snapshotDailyRollup).
  const result = await pipelineIngest<{ coins: number; agents: number; wallets: number; vaults: number }>(
    "projects.snapshot_daily",
    today(),
    ids,
  );
  return { ok: true, status: "ok", ...result };
}

// ── Vault data ───────────────────────────────────────────────────────────────
export async function fetchVaults(
  _payload: Record<string, unknown> = {},
  source: ProjectsDataSource = selectProjectsDataSource(),
): Promise<HandlerResult> {
  const day = today();
  const vaults = await pipelineRead<{ id: string; vault_address: string | null; chain: string | null; strategy_type: string | null; protocol: string | null }[]>(
    "projects.live_vaults",
  );
  if (!vaults.length) return { ok: true, status: "ok", updated: 0, failed: 0 };

  // Issue 1291: each vault is read and validated on its own. One vault that
  // throws (production: the Bankr LP rows, which are not ERC-4626 and revert
  // totalAssets()) used to abort the whole run with updated: 0, so no vault's
  // TVL was refreshed. A failing vault now keeps its last-persisted TVL and is
  // marked last_refresh_status = 'failed'; the others still update.
  const updates: { id: string; tvl: number }[] = [];
  const failures: { id: string; error: Error }[] = [];
  for (const v of vaults) {
    try {
      const read = await source.vaultErc4626Read(v.vault_address as string, v.chain ?? "base");
      updates.push({ id: v.id, tvl: vaultTvlErc4626(read) });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      failures.push({ id: v.id, error });
      console.error(
        `[projects.fetch_vaults] vault ${v.id} live read failed, keeping last-persisted TVL (degraded):`,
        error.message,
      );
    }
  }

  // In requests of at most PIPELINE_MAX_ROWS rows: the refreshed TVLs, then the
  // failed vaults (each keeps its last-persisted TVL and is marked 'failed').
  for (const chunk of pipelineChunks(updates)) await pipelineIngest("projects.record_vault_reads", day, chunk, []);
  for (const chunk of pipelineChunks(failures.map((f) => f.id))) await pipelineIngest("projects.record_vault_reads", day, [], chunk);

  const failed = failures.length;
  if (updates.length > 0) return { ok: true, status: "ok", updated: updates.length, failed };
  // Every vault failed. The run is degraded. When every failure is permanent
  // (a revert, an uncallable address) no retry can change the answer, so the
  // job settles at once (terminal) instead of retrying on the 2 s, 4 s backoff.
  const terminal = failures.every((f) => f.error instanceof PermanentVaultReadError);
  const error = `${failed} of ${vaults.length} vault read(s) failed; first: ${failures[0]!.error.message}`;
  return { ok: false, status: "degraded", error, updated: 0, failed, ...(terminal ? { terminal: true } : {}) };
}

// ── Identity resolution + coverage scoring (no network) ──────────────────────
export async function recomputeCoverage(payload: Record<string, unknown> = {}): Promise<HandlerResult> {
  // Empty project_ids:[] → unscoped (whole directory), never invalid `IN ()`.
  const ids = Array.isArray(payload.project_ids) && payload.project_ids.length > 0 ? (payload.project_ids as string[]) : null;
  // Reads and writes only persisted state, so the api runs it as one
  // transaction (pipeline/stores/projects.ts recomputeCoverageScores).
  const updated = await pipelineIngest<number>("projects.recompute_coverage", ids);
  return { ok: true, status: "ok", updated };
}
