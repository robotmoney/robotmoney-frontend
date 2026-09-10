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

export function allocationFramework() {
  return {
    /** @type {any} */
    allocationFw: null,

    async loadAllocationFw() {
      this.allocationFw = await api.get(ROUTES.dashboards.allocation).catch(() => null);
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
        label: r?.label || `Sleeve ${i + 1}`,
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
    // recommendation directly above its own note saying no session has made
    // one.
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
    // The note carries what the register cannot, and nothing it cannot back.
    //
    // "No session has changed these weights yet" is read from the code rather
    // than from the feed: `allocation_framework` has exactly one writer, the
    // seed, and this row has not moved since it was written. When a real
    // writer lands, this sentence is the whole of the change.
    allocationNote() {
      if (!this.allocationFw) return "The published target could not be read.";
      const zeros = this.allocationTargets().filter((t) => t.pct === 0).length;
      const head = "No session has changed these weights yet.";
      if (!zeros) return head;
      // Counted, not written into the string. The framework is 95/5/0/0 today,
      // and a hardcoded "two" becomes false the first time a weight is edited.
      const word = ["", "one", "two", "three", "four"][zeros] || String(zeros);
      return zeros === 1
        ? `${head} The ${word} sleeve at zero is a target, not a gap.`
        : `${head} The ${word} sleeves at zero are targets, not gaps.`;
    },
  };
}
