// Where the vault figures come from, and the switch that picks between real
// reads and the four-vault test fixtures. /allocation, every /vault/:slug and
// the vault swarm subject all load through here, so one switch moves all
// three together.
//
// THE MOCK-DATA SWITCH (local preview only)
//
//   ?vaults=base      production-like (the default): rmUSDC live on Base, the
//                     other three "Not live on Base".
//   ?vaults=devnet    the synthetic four-vault stack, /data/vaults/devnet/,
//                     labelled "Devnet test data" wherever a figure shows.
//   ?vaults=devnet-unreadable | devnet-no-recommendation | devnet-stale
//                     | devnet-paused
//                     the devnet stack in one review state each.
//
// The choice is kept per tab in sessionStorage ("rm.vaults"), because
// internal links carry no query: a click from /allocation?vaults=devnet to
// /vault/rmagent stays on devnet. ?vaults=base switches back. An unknown value
// is ignored.
//
// It acts only on a local host (vault-data.js isLocalHost: localhost,
// *.localhost, 127.0.0.1, [::1], stage.robotmoney-labs.dev). Every other host
// is production-like whatever it is called: the query and the stored value are
// ignored and never written, and no devnet, saved or archive figure is read.
//
// Base mode, in order:
//   1. GET /api/dashboards/robotmoney-vaults (the four-vault read, when the
//      backend serves it). Its recommendation is authoritative.
//   2. That route absent (404, or the SPA shell answering an unknown path):
//      GET /api/dashboards/vault-economics, the single Base vault, with the
//      latest published robotmoney-allocation recommendation laid over it.
//      The absence is remembered for the rest of the visit.
//   3. Anything else failing: on a local host, the saved Base snapshot
//      (/data/vaults/base/vault-economics.json), labelled "Saved Base
//      snapshot". Elsewhere, "Vault data unavailable".
//
// Loaders take the hostname as a parameter and touch location and
// sessionStorage only inside functions, so the module imports cleanly in a
// test.
import { api, ROUTES, path } from "./api.js";
import {
  VAULTS,
  VAULTS_ENDPOINT,
  bpsFromWeights,
  isLocalHost,
  legacyRaw,
  normalizeOverview,
  numberOrNull,
  vaultBySlug,
  vaultForBucket,
  withRecommendation,
} from "./vault-data.js";
import { weightEntries } from "./session-summary.js";
import { ALLOCATION_SUBJECT_ID, isPublishedAllocationSession } from "./allocation-subject.js";

export const VAULT_MODE_PARAM = "vaults";
export const VAULT_MODE_KEY = "rm.vaults";

export const DEVNET_LABEL = "Devnet test data";
export const SAVED_LABEL = "Saved Base snapshot";
export const STUB_LABEL = "Stub data";
export const VAULT_UNAVAILABLE = "Vault data unavailable";
export const DETAIL_UNAVAILABLE = "Vault detail unavailable";

/**
 * @typedef {"base" | "devnet"} VaultModeName
 * @typedef {null | "unreadable" | "no-recommendation" | "stale" | "paused"} ReviewState
 * @typedef {{ mode: VaultModeName, state: ReviewState }} VaultMode
 * @typedef {{ getItem(key: string): string | null, setItem(key: string, value: string): void }} StorageLike
 * @typedef {{
 *   overview: import("./vault-data.js").Overview | null,
 *   source: "api" | "legacy" | "saved" | "devnet" | null,
 *   mode: VaultModeName,
 *   state: ReviewState,
 *   label: string | null,
 *   error: string | null,
 *   recommendationError: boolean,
 * }} VaultLoad
 */

/** @type {Record<string, VaultMode>} */
const MODES = {
  base: { mode: "base", state: null },
  devnet: { mode: "devnet", state: null },
  "devnet-unreadable": { mode: "devnet", state: "unreadable" },
  "devnet-no-recommendation": { mode: "devnet", state: "no-recommendation" },
  "devnet-stale": { mode: "devnet", state: "stale" },
  "devnet-paused": { mode: "devnet", state: "paused" },
};

/** @param {unknown} v @returns {v is string} */
const isMode = (v) => typeof v === "string" && Object.prototype.hasOwnProperty.call(MODES, v);

/** @param {string} v @returns {VaultMode} */
const modeOf = (v) => ({ ...MODES[v] });

/**
 * @param {{ search?: string, hostname?: string, storage?: StorageLike | null }} [ctx]
 * @returns {VaultMode}
 */
export function resolveVaultMode({ search = "", hostname = "", storage = null } = {}) {
  if (!isLocalHost(hostname)) return modeOf("base");
  /** @type {string | null} */
  let requested = null;
  try {
    requested = new URLSearchParams(search).get(VAULT_MODE_PARAM);
  } catch {
    requested = null;
  }
  if (isMode(requested)) {
    try {
      storage?.setItem(VAULT_MODE_KEY, requested);
    } catch {
      // Storage blocked: the query still applies to this page.
    }
    return modeOf(requested);
  }
  /** @type {string | null} */
  let stored = null;
  try {
    stored = storage?.getItem(VAULT_MODE_KEY) ?? null;
  } catch {
    stored = null;
  }
  return isMode(stored) ? modeOf(stored) : modeOf("base");
}

function currentHostname() {
  return typeof location !== "undefined" ? location.hostname : "";
}
function currentSearch() {
  return typeof location !== "undefined" ? location.search : "";
}
/** @returns {StorageLike | null} */
function sessionStore() {
  try {
    return typeof sessionStorage !== "undefined" ? sessionStorage : null;
  } catch {
    return null;
  }
}

// The mode for this page, from its URL and this tab's stored choice.
/** @returns {VaultMode} */
export function vaultMode() {
  return resolveVaultMode({ search: currentSearch(), hostname: currentHostname(), storage: sessionStore() });
}

/** @param {string} url */
async function readStatic(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}

// ── review states (devnet only) ─────────────────────────────────────────────

/** @param {any} v @param {ReviewState} state */
function reviewRow(v, state) {
  if (!v || typeof v !== "object") return v;
  if (state === "unreadable" && v.slug === "rmproto") {
    v.availability = "unavailable";
    v.tvlUsd = null;
  }
  if (state === "no-recommendation") {
    v.recommendedBps = null;
    if (v.history && Array.isArray(v.history.receipts)) v.history.receipts = [];
  }
  if (state === "paused" && v.slug === "rmusdc") {
    v.status = "paused";
    if (v.flags && typeof v.flags === "object") v.flags.depositsPaused = true;
  }
  return v;
}

// One devnet fixture (the overview, or one vault's detail) in a review state.
// Returns a copy; the input is not touched.
/** @param {any} raw @param {ReviewState} state */
export function applyReviewState(raw, state) {
  if (!raw || typeof raw !== "object") return raw;
  const out = structuredClone(raw);
  if (!state) return out;
  if (Array.isArray(out.vaults)) {
    out.vaults.forEach((/** @type {any} */ v) => reviewRow(v, state));
    if (state === "no-recommendation") out.recommendation = null;
    if (state === "stale") out.freshness = { ...(out.freshness || {}), stale: true };
  } else {
    reviewRow(out, state);
  }
  return out;
}

// ── the latest published recommendation ─────────────────────────────────────

// An archive session file in the API's shape. The archive rows carry no id,
// no state and no publish time of their own: the id is the dated one the
// archive pages use, the state is the index row's.
/** @param {any} indexRow @param {any} raw */
export function archiveSession(indexRow, raw) {
  const r = raw || {};
  return {
    id: r.id ?? `${r.date}-${r.subject_id}`,
    archived: !r.id,
    date: r.date,
    subjectId: r.subjectId ?? r.subject_id,
    state: indexRow?.state,
    publishedAt: r.publishedAt ?? r.published_at ?? r.generated_at ?? null,
    swarmRecommendation: r.swarmRecommendation ?? r.swarm_recommendation ?? r.committee_recommendation,
  };
}

/** @param {any} s */
const sessionRecommendationOf = (s) => s?.swarmRecommendation ?? s?.swarm_recommendation ?? s?.committee_recommendation ?? null;

// A bucket_weights session's weights as basis points per bucket, with where it
// is published. null for any other kind of session or one without weights.
/**
 * @param {any} session
 * @returns {{ sessionId: string | null, date: string | null, subjectId: string | null, publishedAt: string | null, releasedOnChain: null, href: string | null, bpsByBucket: Record<string, number | null> } | null}
 */
export function recommendationFromSession(session) {
  const r = sessionRecommendationOf(session);
  if (!r || r.type !== "bucket_weights") return null;
  /** @type {Map<string, number | null>} */
  const byBucket = new Map();
  for (const [k, w] of weightEntries(r.weights)) {
    const v = vaultForBucket(k);
    if (v) byBucket.set(v.bucket, numberOrNull(w));
  }
  const weights = VAULTS.map((v) => (byBucket.has(v.bucket) ? byBucket.get(v.bucket) ?? null : null));
  if (weights.every((w) => w === null)) return null;
  const list = bpsFromWeights(weights);
  /** @type {Record<string, number | null>} */
  const bpsByBucket = {};
  VAULTS.forEach((v, i) => { bpsByBucket[v.bucket] = list[i]; });
  const date = session?.date ? String(session.date) : null;
  const subjectId = session?.subjectId ?? session?.subject_id ?? null;
  const id = session?.id ? String(session.id) : null;
  const href = session?.archived && date && subjectId
    ? `/swarm/${date}/${subjectId}`
    : id && !session?.archived
      ? `/swarm/sessions/${id}`
      : null;
  return {
    sessionId: session?.archived ? null : id,
    date,
    subjectId,
    publishedAt: session?.publishedAt ?? session?.published_at ?? null,
    releasedOnChain: null,
    href,
    bpsByBucket,
  };
}

// The newest published robotmoney-allocation session that carries weights.
/** @param {any[]} sessions */
export function latestPublishedRecommendation(sessions) {
  const rows = (Array.isArray(sessions) ? sessions : [])
    .filter((s) => isPublishedAllocationSession({ subjectId: s?.subjectId ?? s?.subject_id, state: s?.state }))
    .sort((a, b) => String(b?.publishedAt ?? b?.date ?? "").localeCompare(String(a?.publishedAt ?? a?.date ?? "")));
  for (const s of rows) {
    const rec = recommendationFromSession(s);
    if (rec) return rec;
  }
  return null;
}

async function archiveRecommendation() {
  const index = await readStatic("/data/swarm/sessions/index.json");
  const rows = (Array.isArray(index?.sessions) ? index.sessions : [])
    .filter((/** @type {any} */ r) => (r?.subjectId ?? r?.subject_id) === ALLOCATION_SUBJECT_ID && r?.state === "published")
    .sort((/** @type {any} */ a, /** @type {any} */ b) => String(b.date).localeCompare(String(a.date)))
    .slice(0, 3);
  const sessions = await Promise.all(rows.map(async (/** @type {any} */ r) => {
    const file = String(r.file || `${r.date}-${ALLOCATION_SUBJECT_ID}.json`);
    if (!/^[\w.-]+\.json$/.test(file)) return null;
    try {
      return archiveSession(r, await readStatic(`/data/swarm/sessions/${file}`));
    } catch {
      return null;
    }
  }));
  return latestPublishedRecommendation(sessions.filter(Boolean));
}

// The latest published recommendation for the allocation, from the API. Only
// when the API cannot be reached, and only on a local host, from the shipped
// archive. An API that answers with none is an answer: { rec: null }.
/**
 * @param {{ hostname?: string }} [opts]
 * @returns {Promise<{ rec: ReturnType<typeof recommendationFromSession>, error: boolean }>}
 */
export async function loadLatestRecommendation({ hostname = currentHostname() } = {}) {
  /** @type {any[]} */
  let rows;
  try {
    const res = await api.get(ROUTES.swarm.sessions, { subject: ALLOCATION_SUBJECT_ID, state: "published", limit: "12" });
    rows = Array.isArray(res?.sessions) ? res.sessions : Array.isArray(res) ? res : [];
  } catch {
    if (!isLocalHost(hostname)) return { rec: null, error: true };
    try {
      return { rec: await archiveRecommendation(), error: false };
    } catch {
      return { rec: null, error: true };
    }
  }
  const published = rows
    .filter((s) => isPublishedAllocationSession({ subjectId: s?.subjectId ?? s?.subject_id, state: s?.state }))
    .sort((a, b) => String(b?.publishedAt ?? b?.date ?? "").localeCompare(String(a?.publishedAt ?? a?.date ?? "")));
  // Light index rows carry no recommendation: read the newest few in full.
  let failed = false;
  const newest = await Promise.all(published.slice(0, 3).map(async (s) => {
    if (sessionRecommendationOf(s) || !s?.id) return s;
    try {
      const d = await api.get(path(ROUTES.swarm.sessionById, { id: s.id }));
      return d?.session ?? d;
    } catch {
      failed = true;
      return s;
    }
  }));
  const rec = latestPublishedRecommendation([...newest, ...published.slice(3)]);
  return { rec, error: !rec && failed };
}

// ── the overview ─────────────────────────────────────────────────────────────

// The four-vault route is either served or not; once it has answered "not
// here", the rest of the visit goes straight to the Base feed. Data is not
// cached, only the absence.
let vaultsEndpointAbsent = false;
/** For tests. */
export function _resetVaultProbe() {
  vaultsEndpointAbsent = false;
}

/** @param {any} e */
const endpointAbsent = (e) => e?.status === 404 || e?.code === "not_json";

/** @param {VaultMode} m @returns {VaultLoad} */
function failed(m) {
  return { overview: null, source: null, mode: m.mode, state: m.state, label: null, error: VAULT_UNAVAILABLE, recommendationError: false };
}

/** @param {VaultMode} m @returns {Promise<VaultLoad>} */
async function loadDevnet(m) {
  try {
    const raw = applyReviewState(await readStatic("/data/vaults/devnet/overview.json"), m.state);
    return { overview: normalizeOverview(raw), source: "devnet", mode: "devnet", state: m.state, label: DEVNET_LABEL, error: null, recommendationError: false };
  } catch {
    return failed(m);
  }
}

/**
 * @param {any} economics
 * @param {{ rec: any, error: boolean }} recResult
 * @param {"legacy" | "saved"} source
 * @returns {VaultLoad}
 */
function legacyLoad(economics, recResult, source) {
  const overview = normalizeOverview(withRecommendation(legacyRaw(economics), recResult.rec));
  const label = source === "saved" ? SAVED_LABEL : economics?.source === "stub" ? STUB_LABEL : null;
  return { overview, source, mode: "base", state: null, label, error: null, recommendationError: recResult.error };
}

/**
 * @param {string} hostname @param {boolean} recommendation
 * @returns {Promise<{ rec: any, error: boolean }>}
 */
function recommendationFor(hostname, recommendation) {
  return recommendation ? loadLatestRecommendation({ hostname }) : Promise.resolve({ rec: null, error: false });
}

// No Base read answered. A local host shows the saved snapshot, labelled;
// every other host says the data is unavailable and reads nothing further.
/**
 * @param {string} hostname
 * @param {Promise<{ rec: any, error: boolean }>} recPromise
 * @returns {Promise<VaultLoad>}
 */
async function savedSnapshot(hostname, recPromise) {
  if (!isLocalHost(hostname)) return failed(modeOf("base"));
  try {
    const [economics, recResult] = await Promise.all([
      readStatic("/data/vaults/base/vault-economics.json"),
      recPromise,
    ]);
    return legacyLoad(economics, recResult, "saved");
  } catch {
    return failed(modeOf("base"));
  }
}

/**
 * The overview for the current mode.
 * @param {{ hostname?: string, recommendation?: boolean, search?: string, storage?: StorageLike | null }} [opts]
 *   `search` and `storage` default to this page's; tests pass their own.
 * @returns {Promise<VaultLoad>}
 */
export async function loadVaultOverview({ hostname = currentHostname(), recommendation = true, search, storage } = {}) {
  const m = resolveVaultMode({
    search: search ?? currentSearch(),
    hostname,
    storage: storage === undefined ? sessionStore() : storage,
  });
  if (m.mode === "devnet" && isLocalHost(hostname)) return loadDevnet(m);

  if (!vaultsEndpointAbsent) {
    try {
      const dto = await api.get(VAULTS_ENDPOINT);
      return {
        overview: normalizeOverview(dto),
        source: "api",
        mode: "base",
        state: null,
        label: dto?.network?.testData === true ? DEVNET_LABEL : null,
        error: null,
        recommendationError: false,
      };
    } catch (e) {
      if (!endpointAbsent(e)) {
        return isLocalHost(hostname)
          ? savedSnapshot(hostname, recommendationFor(hostname, recommendation))
          : failed(modeOf("base"));
      }
      vaultsEndpointAbsent = true;
    }
  }

  const recPromise = recommendationFor(hostname, recommendation);
  try {
    const economics = await api.get(ROUTES.dashboards.vaultEconomics);
    return legacyLoad(economics, await recPromise, "legacy");
  } catch {
    return savedSnapshot(hostname, recPromise);
  }
}

// One vault's detail, from the same source its overview came from.
/**
 * @param {string} slug
 * @param {VaultLoad | null | undefined} load
 * @returns {Promise<{ detail: any, error: string | null }>}
 */
export async function loadVaultDetail(slug, load) {
  const v = vaultBySlug(slug);
  if (!v || !load?.overview) return { detail: null, error: DETAIL_UNAVAILABLE };
  try {
    if (load.source === "devnet") {
      const d = applyReviewState(await readStatic(`/data/vaults/devnet/${v.slug}.json`), load.state);
      if (d?.slug !== v.slug) throw new Error("vault detail mismatch");
      return { detail: d, error: null };
    }
    if (load.source === "api") {
      const d = await api.get(`${VAULTS_ENDPOINT}/${encodeURIComponent(v.slug)}`);
      const chain = d?.network?.chainId;
      if (d?.slug !== v.slug || (chain != null && chain !== load.overview.network?.chainId)) throw new Error("vault detail mismatch");
      return { detail: d, error: null };
    }
    // The Base feed has no per-vault route: its overview row is the detail.
    const row = load.overview.vaults.find((r) => r.slug === v.slug) ?? null;
    return row ? { detail: row, error: null } : { detail: null, error: DETAIL_UNAVAILABLE };
  } catch {
    return { detail: null, error: DETAIL_UNAVAILABLE };
  }
}

// The vault swarm subject's four-vault book on the devnet: its wallets (the
// router and the four vaults) and fifteen daily readings, oldest first. Local
// hosts only.
/**
 * @param {{ hostname?: string }} [opts]
 * @returns {Promise<{ wallets: any[], snapshots: any[] } | null>}
 */
export async function loadVaultSubjectFixture({ hostname = currentHostname() } = {}) {
  if (!isLocalHost(hostname)) return null;
  try {
    const raw = await readStatic("/data/vaults/devnet/subject.json");
    const wallets = Array.isArray(raw?.wallets) ? raw.wallets : [];
    const snapshots = (Array.isArray(raw?.snapshots) ? raw.snapshots : [])
      .slice()
      .sort((/** @type {any} */ a, /** @type {any} */ b) => String(a?.date).localeCompare(String(b?.date)));
    return { wallets, snapshots };
  } catch {
    return null;
  }
}
