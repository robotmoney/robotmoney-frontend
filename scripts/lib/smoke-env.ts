// Demo data-path resolver. Single source of truth for which data path a
// `bun run smoke` stack — and the required per-PR e2e gate — runs on: ALWAYS
// the production-parity LIVE path.
//
// Issue #147 removed DEMO_HERMETIC and the stubbed/offline smoke path entirely
// (decision: issue #163). There is no hermetic opt-in anymore: every
// `bun run smoke` invocation, local or CI, resolves live external providers
// (Base mainnet RPC, FRED/Coin Metrics/GeckoTerminal/Yahoo/EDGAR). A required
// credential or provider that is unavailable must fail loudly (non-zero exit,
// actionable message) — never silently fall back to a fixture or stub.
//
//   BASE_RPC_URL is left unset so the backend's config.ts falls through to its
//   live default (https://mainnet.base.org); ANALYTICS_SOURCE=live; and
//   ANALYTICS_FLOOR_SEED=1 so a cold live boot seeds the vendored raw-indicator
//   floor instead of re-fetching years of history.
//
// Explicit BASE_RPC_URL / ANALYTICS_SOURCE / ANALYTICS_FLOOR_SEED env
// overrides always win (e.g. pointing at a private RPC, or setting
// ANALYTICS_SOURCE=hermetic to reuse the deterministic offline analytics
// fixture backend unit tests depend on directly —
// backend/src/analytics/access/hermetic-source.ts — for local debugging).
// That fixture is NOT selected by any smoke default; ANALYTICS_SOURCE is a
// general backend config knob unrelated to the removed DEMO_HERMETIC wiring.
//
// This module is imported by scripts/smoke.ts (which re-exports it for the
// unit tests in scripts/tests/unit/smoke-env.test.ts) and MUST stay side-effect free.
//
// It is ALSO where the smoke's cadence profile reaches the analytics-producer:
// ONLY a RESOLVED realistic cadence (`--stage`, or an explicit `--cadence
// realistic` override) injects the realistic profile's PRODUCER_REGIME_CRON /
// PRODUCER_RESEARCH_CRON (scripts/lib/smoke-cadence.ts) so research cadence and
// swarm cadence are stated in ONE file. Under RM_ENV=stage the realistic
// profile's crons are the stage target's boot-anchored hourly pair instead
// (stageProducerCrons, issue 1684, D87): a schedule, never a run started by
// hand; RM_ENV=prod keeps production's 3-hourly pair. A fast-cadence boot — CI, plain
// `bun run smoke`, and the smoke-twin's deliberate `--static-port --cadence fast`
// — injects neither, so compose resolves the COMMITTED production defaults
// untouched and the CI smoke path is byte-for-byte unaffected.
//
// THE CACHE TTLs (issue 1258). HTTP_FETCH_CACHE_TTL_MS and
// TOKEN_PRICE_CACHE_TTL_MS are emitted at one hour ONLY on a local boot that is
// neither the standing stack (`--static-port`) nor RM_ENV=prod. A standing or
// prod boot emits neither, so compose resolves both empty and the backend's
// production defaults apply: the on-disk HTTP fetch cache OFF, the token-price
// cache 30 s. Forcing one hour onto the standing boot is how prod's fetch
// cache filled the host disk.
import { resolveSmokeCadence, stageProducerCrons, type SmokeCadenceProfile } from "./smoke-cadence.ts";

export const NORMAL_DEMO_CACHE_TTL_MS = 3_600_000;

export interface SmokeEnvResolution {
  /**
   * Resolved BASE_RPC_URL for the api/worker containers. `undefined` means
   * "leave unset" → backend config.ts falls through to its live production
   * default (https://mainnet.base.org).
   */
  baseRpcUrl: string | undefined;
  /** Vault-economics DTO provenance the backend will report — always 'live'. */
  baseRpcSource: "live";
  /** Resolved ANALYTICS_SOURCE for the api/worker containers. */
  analyticsSource: string;
  /** Resolved ANALYTICS_FLOOR_SEED for the api/worker containers. */
  analyticsFloorSeed: string;
  /**
   * The exact env entries `scripts/smoke.ts` merges into every `docker compose`
   * invocation. BASE_RPC_URL is intentionally ABSENT unless overridden (so the
   * compose default and backend config default both apply).
   */
  composeEnv: Record<string, string>;
}

/**
 * THE DEPOSIT QUEUE INDEXER (issue 1614). The v0.9 FlowQueue and fund are not
 * deployed on Base mainnet yet, so a local, non-standing, non-prod boot points
 * the indexer at the live deploy-2 gateway and rmUSD vault as stand-ins. That
 * exercises the deployed scan, the migrated tables and the health route on the
 * real chain; it does not exercise the queue views, which those contracts lack.
 * The scan starts FLOW_SMOKE_START_LAG blocks below the head the boot read, so
 * the per-minute job reaches the confirmed head within minutes. An exported
 * FLOW_QUEUE_ADDRESS (DEMO_COMPOSE_PASSTHROUGH) always wins, and a standing or
 * prod boot gets no stand-in: it indexes only what its operator configured.
 */
export const FLOW_SMOKE_STANDINS = Object.freeze({
  queue: "0x8E866418Ba2c9120753b8f9B2C5F7c33246575BE",
  fund: "0x28Bf6E6EDAD526191e8652ee631B56EAd4cE7435",
});
export const FLOW_SMOKE_START_LAG = 60;
/**
 * The public mainnet.base.org answers every eth_getLogs with 429 "request
 * limit reached" (seen from CI and locally, issue 1614), so the stand-in scans
 * through a public RPC that serves logs. Only the flow indexer uses it; an
 * exported BASE_RPC_URL or FLOW_RPC_URL wins.
 */
export const FLOW_SMOKE_RPC_URL = "https://base-rpc.publicnode.com";

/** Whether this boot configures the stand-in deposit queue index (and so must read the chain head first). */
export function wantsFlowStandIn(
  env: Record<string, string | undefined>,
  opts: { standingStack: boolean; rmEnv?: string },
): boolean {
  return !opts.standingStack && (opts.rmEnv ?? env.RM_ENV) !== "prod" && !env.FLOW_QUEUE_ADDRESS;
}

/** Read the Base head for the stand-in's start block; three attempts, then a loud failure. */
export async function readBaseHead(rpcUrl: string, fetchImpl: typeof fetch = fetch): Promise<number> {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetchImpl(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }), signal: AbortSignal.timeout(10_000) });
      const body = (await response.json()) as { result?: unknown };
      if (typeof body.result === "string" && /^0x[0-9a-f]+$/i.test(body.result)) return parseInt(body.result, 16);
      last = new Error(`no block number in ${JSON.stringify(body).slice(0, 200)}`);
    } catch (error) {
      last = error;
    }
  }
  throw new Error(`could not read the Base head from ${rpcUrl} for the deposit queue stand-in: ${last instanceof Error ? last.message : String(last)}`);
}

/** The head a local boot starts its stand-in scan below (issue 1614); undefined when it configures none. */
export async function smokeFlowHead(
  env: Record<string, string | undefined>,
  opts: { standingStack: boolean; rmEnv?: string },
  readHead: (rpcUrl: string) => Promise<number> = readBaseHead,
): Promise<number | undefined> {
  return wantsFlowStandIn(env, opts) ? readHead(env.BASE_RPC_URL || "https://mainnet.base.org") : undefined;
}

export function resolveSmokeEnv(
  env: Record<string, string | undefined> = process.env,
  opts: {
    stage?: boolean;
    cadence?: SmokeCadenceProfile;
    /** The standing stack (`--static-port`). Defaults to `stage`. */
    standingStack?: boolean;
    /** The resolved RM_ENV policy. Defaults to env.RM_ENV. */
    rmEnv?: string;
    /** The Base head the boot read, when wantsFlowStandIn(). */
    flowHeadBlock?: number;
    /** The boot's time: a stage boot anchors its analytics schedule to it (issue 1684). */
    now?: Date;
  } = {},
): SmokeEnvResolution {
  const baseRpcUrl = env.BASE_RPC_URL || undefined;
  const baseRpcSource: "live" = "live";
  const analyticsSource = env.ANALYTICS_SOURCE || "live";
  // Cold-DB floor seed: on by default so a cold live boot doesn't re-fetch
  // years of history (idempotent; no-op once warm).
  const analyticsFloorSeed = env.ANALYTICS_FLOOR_SEED || "1";

  // Cadence → analytics-producer. ONLY a resolved REALISTIC cadence injects
  // timers; the fast profile deliberately emits nothing so compose's committed
  // `${PRODUCER_*_CRON:-…}` defaults resolve exactly as they do today. The
  // `cadence` override is how the fast-cadence smoke-twin lands here even
  // though it pins the port.
  const cadence = resolveSmokeCadence({ stage: opts.stage === true, cadence: opts.cadence });
  const standingStack = opts.standingStack ?? opts.stage === true;
  const rmEnv = opts.rmEnv ?? env.RM_ENV;
  // The stage target's first tick lands just after its boot, hourly from then on (issue 1684, D87); production keeps its grid.
  const crons = cadence.profile === "realistic" && rmEnv === "stage" ? stageProducerCrons(opts.now ?? new Date()) : cadence;
  const producerCronEnv: Record<string, string> = cadence.profile === "realistic"
    ? { PRODUCER_REGIME_CRON: crons.regimeCron, PRODUCER_RESEARCH_CRON: crons.researchCron }
    : {};
  const cacheEnv: Record<string, string> = standingStack || rmEnv === "prod"
    ? {}
    : {
        HTTP_FETCH_CACHE_TTL_MS: String(NORMAL_DEMO_CACHE_TTL_MS),
        TOKEN_PRICE_CACHE_TTL_MS: String(NORMAL_DEMO_CACHE_TTL_MS),
      };

  let flowEnv: Record<string, string> = {};
  // Without a head the stand-in is left out; the live-smoke flow leg then fails loudly.
  const head = opts.flowHeadBlock;
  if (head !== undefined && wantsFlowStandIn(env, { standingStack, rmEnv })) {
    if (!Number.isSafeInteger(head) || head <= FLOW_SMOKE_START_LAG) throw new Error(`resolveSmokeEnv: invalid Base head block ${head}`);
    flowEnv = {
      FLOW_QUEUE_ADDRESS: FLOW_SMOKE_STANDINS.queue,
      FLOW_FUND_ADDRESS: FLOW_SMOKE_STANDINS.fund,
      FLOW_INDEX_DEPLOY_BLOCK: String(head - FLOW_SMOKE_START_LAG),
      ...(env.BASE_RPC_URL || env.FLOW_RPC_URL ? {} : { FLOW_RPC_URL: FLOW_SMOKE_RPC_URL }),
    };
  }

  const composeEnv: Record<string, string> = {
    ...(baseRpcUrl !== undefined ? { BASE_RPC_URL: baseRpcUrl } : {}),
    BASE_RPC_SOURCE: baseRpcSource,
    ANALYTICS_SOURCE: analyticsSource,
    ANALYTICS_FLOOR_SEED: analyticsFloorSeed,
    ...cacheEnv,
    ...producerCronEnv,
    ...flowEnv,
  };

  return { baseRpcUrl, baseRpcSource, analyticsSource, analyticsFloorSeed, composeEnv };
}
