// The latest allocation recommendation, as /allocation and each vault's page
// set it beside their ring (and /swarm beside its own): the newest allocation
// session that published weights, why, how the room leaned, and the way to it.
// One panel and one look wherever the allocation is shown, so a reader learns
// it once.
//
// A mixin: spread it into a view, call `loadRecommendation()` (or hand it the
// promise the view already read) and draw `views/partials` markup from
// `recSession`. The session comes with its takes (lib/vault-source.js), which
// the tally counts.
import { loadLatestRecommendation } from "../lib/vault-source.js";
import { fmtDate } from "../lib/vault-data.js";
import { sessionSummary } from "../lib/session-summary.js";
import { sessionTakes } from "../lib/session-takes.js";
import { stanceColor } from "../lib/stance.js";
import { loadRoster } from "../lib/judgements.js";
import { helpers } from "./static-views.js";

const { sessionHref } = sessionTakes();

export function latestRecommendation() {
  return {
    recSession: null,
    recLatest: null,
    recLoaded: false,
    recError: false,
    // The public roster, read only when a judge worked on that session: its
    // name goes over the words it wrote, and a seated judge is no seat a take
    // could fill (lib/judgements.js).
    recRoster: [],
    /**
     * @param {string} hostname
     * @param {Promise<any>} [read] the read the view already made, so the
     *   session list is not walked twice
     */
    loadRecommendation(hostname, read) {
      const r = read ?? loadLatestRecommendation({ hostname }).catch(() => ({ rec: null, error: true }));
      return r.then(async (res) => {
        // Before the panel draws, so a judge's name never flashes as its id.
        if (res?.session?.swarmRecommendation?.judge) this.recRoster = await loadRoster();
        this.recSession = res?.session ?? null;
        this.recLatest = res?.latest ?? null;
        this.recError = !!res?.error;
      }).finally(() => { this.recLoaded = true; });
    },
    // A newer session that published no weights held the target.
    recHeldBy() {
      const latest = this.recLatest;
      return latest && this.recSession && latest.id !== this.recSession.id ? latest : null;
    },
    /** @param {any} s */
    recDate(s) { return s?.date ? fmtDate(s.date) : ""; },
    /** @param {any} s */
    recHref(s) { return sessionHref(s); },
    recRationale() { return sessionSummary.rationaleOf.call(sessionSummary, this.recSession); },
    // "Judge: <name>" over a rationale a judge wrote.
    recRationaleLabel() { return sessionSummary.rationaleJudgeLabel.call(sessionSummary, this.recSession, this.recRoster); },
    recTally() { return this.recSession ? sessionSummary.stanceTally.call(sessionSummary, this.recSession) : []; },
    recTallyNote() {
      const s = this.recSession;
      return s ? [sessionSummary.turnoutText.call(sessionSummary, s, this.recRoster), sessionSummary.meanConfidenceText.call(sessionSummary, s)].filter(Boolean).join(" · ") : "";
    },
    /** @param {string} text */
    linkified(text) { return helpers.linkified(text); },
    /** @param {string} s */
    stanceColor(s) { return stanceColor(s); },
  };
}
