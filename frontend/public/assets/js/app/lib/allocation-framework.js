// The published allocation: four sleeves and the weight each is held to.
//
// The third of the split lib/session-summary.js started. /swarm carries this
// card because the allocation is the flagship product; the allocation
// subject's own page carries it because the subject IS this framework, and a
// reader landing there was shown six sessions ABOUT the weights before being
// shown the weights.
//
// A factory rather than a plain object: `allocationFw` is state, and a shared
// object literal would hand both surfaces the same slot.
import { api, ROUTES } from "./api.js";
import { CATEGORICAL } from "./chart-theme.js";
import { bucketLabel } from "./session-summary.js";
import { isLocalHost, vaultForBucket } from "./vault-data.js";

export function allocationFramework() {
  return {
    /** @type {any} */
    allocationFw: null,

    async loadAllocationFw() {
      this.allocationFw = await api.get(ROUTES.dashboards.allocation).catch(() => null)
        || await archivedFramework();
      return this.allocationFw;
    },

    // One row per sleeve, in the order the framework publishes them.
    //
    // The hue is CATEGORICAL by POSITION, never by rank or magnitude, so a
    // sleeve is the same colour here, on /allocation's donut and on a session
    // card's target-mix bar — and a weight change never repaints the sleeves
    // that did not move.
    allocationTargets() {
      const rows = this.allocationFw?.strategy;
      if (!Array.isArray(rows) || !rows.length) return [];
      return rows.map((/** @type {any} */ r, /** @type {number} */ i) => ({
        // "Sleeve" is the published word for one of the four allocation rows;
        // `buckets` stays the manifest's own field name and is not renamed.
        // The sleeve's name through the one display map (RM-97): the served
        // label is the framework's first name.
        label: r?.label ? bucketLabel(r.label) : `Sleeve ${i + 1}`,
        pct: Number.isFinite(Number(r?.targetPct)) ? Number(r.targetPct) : null,
        hue: CATEGORICAL[i % CATEGORICAL.length],
      }));
    },
    // Bar width, clamped to the scale. A framework whose weights do not sum to
    // 100 draws tracks that do not fill; it is never normalised to its own
    // sum, which would rescale an incomplete policy to look complete.
    //
    // null is not 0. A published zero gets an empty track and a muted figure;
    // an absent target gets no track and an em dash. The two must not look
    // alike, so the track is what separates them.
    /** @param {any} t */
    sleeveBar(t) {
      const pct = Number(t?.pct);
      if (t?.pct === null || !Number.isFinite(pct)) return null;
      return Math.max(0, Math.min(100, pct));
    },
    // Did a SESSION set these weights, or the seed?
    //
    // Keyed on the framework row's own provenance.sessionId — the same test
    // /allocation's state chip uses. NOT the DTO's top-level `managed`, which
    // is true today and is about the VAULT being managed, not about who wrote
    // the targets. Reading that field would have the card claim a swarm
    // recommendation for the seeded row.
    allocationIsFromSession() {
      return !!this.allocationFw?.provenance?.sessionId;
    },
    // The card's heading, which has to stay true in both states. "Latest swarm
    // recommendation" is the right words for weights a session published and
    // the wrong ones for the seeded row in force today, so the heading follows
    // the provenance rather than being typed into the markup.
    allocationTitle() {
      return this.allocationIsFromSession()
        ? "Latest swarm recommendation"
        : "Target weights in force";
    },
    allocationAsOf() {
      const d = this.allocationFw?.asOf;
      // formatDate belongs to the surface (both spread the same `helpers`),
      // not to this module.
      const fmt = /** @type {any} */ (this).formatDate;
      return d ? fmt.call(this, d) : "";
    },
  };
}

// The published targets from the shipped manifest, in the dashboard's shape,
// for a checkout with no API. No provenance: the manifest does not say which
// session set them, so the card reads "Target weights in force".
//
// `buckets` carries each sleeve's constituents the way the allocation DTO
// does ({ key, label, items: [{ label, targetPct }] }), so /allocation can
// draw the recipe on a local preview. A constituent's percentage is rounded to
// the hundredth the DTO serves (0.1429 is 14.29, not 14.290000000000001).
async function archivedFramework() {
  try {
    const res = await fetch("/data/swarm/manifests/allocation.json");
    if (!res.ok) return null;
    const raw = await res.json();
    const strategy = (raw.buckets || []).map((/** @type {any} */ b) => ({
      label: b.name || b.id || "",
      targetPct: Number.isFinite(Number(b.target_weight)) ? Number(b.target_weight) * 100 : null,
    }));
    /** @param {unknown} w */
    const itemPct = (w) => (w !== null && w !== "" && Number.isFinite(Number(w)) ? Math.round(Number(w) * 10000) / 100 : null);
    const buckets = (raw.buckets || []).map((/** @type {any} */ b) => ({
      key: vaultForBucket(b.id)?.key ?? b.id,
      label: b.name || b.id || "",
      items: (b.items || []).map((/** @type {any} */ it) => ({ label: it.name || it.id || "", targetPct: itemPct(it.target_weight) })),
    }));
    return strategy.length ? { asOf: raw.asof || raw.asOf || null, strategy, buckets, provenance: null } : null;
  } catch (_) {
    return null;
  }
}

// /allocation's read of the targets: the API, and the shipped manifest only on
// a local host (vault-data.js isLocalHost). A production-like host with no API
// gets null, which the page states as "Target weights unavailable" rather than
// printing the manifest's June weights as if they were a live read.
/** @param {string} hostname */
export async function loadAllocationDto(hostname) {
  const dto = await api.get(ROUTES.dashboards.allocation).catch(() => null);
  if (dto) return dto;
  return isLocalHost(hostname) ? archivedFramework() : null;
}

