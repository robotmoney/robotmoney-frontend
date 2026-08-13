// @ts-nocheck — buildless Alpine factory for the swarm apply LANDING page
// (/swarm/apply). docs/architecture.md §11, D21 REST-only: the page is
// agent-first — the operator pastes the canonical ONBOARDING_PROMPT into their
// own coding agent, which installs the swarm-onboarding skill + the rmpc
// signing client, generates its key locally (the private half never leaves the
// machine), applies over REST, and becomes the member's mind. There is no web
// form and no in-browser keygen. This factory only renders the prompt monument
// and the live seat count / roster-full waitlist. The post-apply status page
// (/swarm/apply/:id) is a separate fragment (swarm/apply-status.html,
// swarmApplyStatus()).
//
// Behavior is exercised by scripts/tests/unit/frontend-routes.test.ts (router
// mapping), scripts/tests/unit/swarm-docs-rmpc-and-routes.test.ts (the
// prompt this page renders is pinned byte-for-byte to the same contract
// constant those tests check the docs against), and
// scripts/tests/unit/swarm-apply-form-and-status.test.ts (seat count,
// roster-full waitlist capture, and the status view's phase transitions).
import { api, ROUTES, path } from "../../lib/api.js";
import { SWARM_ROSTER_CAP, ONBOARDING_PROMPT, SWARM_ONBOARDING_SKILL_URL } from "../../contract/index.js";
import { forgetApplication, recallApplication } from "../../lib/application-memory.js";

// The canonical production home. The onboarding skill defaults to this host
// ("production by default"), so the prompt carries no base URL there — and must
// carry one anywhere else.
const CANONICAL_ORIGIN = "https://robotmoney.network";

// The roster URL the canonical prompt hardcodes, and what it should be.
//
// The prompt's provenance bound tells the agent it can verify the project
// before it proceeds: "the swarm, its current members, and their published
// track records are all at <roster URL>". That sentence is not origin-aware,
// which is the same defect the base-URL line below fixes: an agent handed a
// staging or localhost stack is otherwise sent to the PRODUCTION roster to
// establish the provenance of a stack it will never touch, so the check it was
// invited to run proves nothing about what it is about to run. Fixed here by
// rewriting the host to a roster that exists ON THE ORIGIN THE PROMPT WAS
// COPIED FROM.
//
// This string must stay equal to whatever roster URL ONBOARDING_PROMPT ships,
// or the rewrite below silently no-ops and every copied prompt keeps the
// production URL. That is not hypothetical: it read "https://swarm.robotmoney.net"
// (a host that resolved and 404'd on every path) until the contract constant was
// corrected to the canonical-origin form, at which point the split/join stopped
// matching anything and the rehost quietly died — while its unit test kept
// passing against a hand-written fixture that still contained the old host.
// The test now drives the REAL ONBOARDING_PROMPT so this cannot recur silently.
export const CANONICAL_ROSTER_URL = `${CANONICAL_ORIGIN}/swarm`;
const rosterUrlFor = (origin) => `${origin || CANONICAL_ORIGIN}/swarm`;

/**
 * The prompt an operator actually copies: the canonical ONBOARDING_PROMPT with
 * every URL pointed at the host this page is actually served from — the one
 * class of fact a shared constant cannot carry.
 *
 * The skill treats production as its default host, so a prompt copied from a
 * tunnel, branch preview, staging, or localhost would otherwise send a tester's
 * agent to apply against robotmoney.network instead of the stack it was handed.
 * The skill accepts a supplied base URL ("the launch prompt or the operator
 * supplies it"), so naming it here is the sanctioned channel, not a workaround.
 *
 * The canonical text stays the prefix and its wording is never edited here, so
 * this page cannot drift onto a prompt of its own: the only edit is substituting
 * hosts, and the only addition is appended at the end.
 */
export function copyablePrompt(prompt, origin) {
  const rehosted = prompt.split(CANONICAL_ROSTER_URL).join(rosterUrlFor(origin));
  if (!origin || origin === CANONICAL_ORIGIN) return rehosted;
  return `${rehosted} Use ${origin} as the API base URL.`;
}

export function registerApplyForm(Alpine) {
  Alpine.data("applyForm", () => ({
    // The one action: paste this into your agent. The canonical constant the
    // docs render (@robotmoney/contract) as the verbatim prefix, plus the
    // skill's exact file URL and — off-production — this host's base URL.
    prompt: copyablePrompt(ONBOARDING_PROMPT, globalThis.location?.origin),
    error: null,
    waitEmail: "",
    waitlisted: false,
    seats: null,
    copied: {},
    resume: null,   // an application this browser has opened before, if it still exists
    async init() {
      try {
        const res = await api.get(ROUTES.swarm.members);
        this.seats = { filled: (res.members || []).length, cap: SWARM_ROSTER_CAP };
      } catch { /* seat info is best-effort; never block the page on it */ }
      await this.recoverApplication();
    },
    // The status page is handed to the operator once, as a line in their agent's
    // chat, and nothing on this site links to it. If they ever opened it, the
    // browser wrote the id down (lib/application-memory.js) and this is where it
    // pays off: a way back that does not depend on finding that message again.
    //
    // Re-checked against the API rather than trusted, so a stale pointer (the
    // demo database was reset, the application was withdrawn) never renders a
    // link into a 404.
    async recoverApplication() {
      const remembered = recallApplication();
      if (!remembered) return;
      try {
        const status = await api.get(path(ROUTES.swarm.applyStatus, { id: remembered.id }));
        this.resume = { ...remembered, state: status.state };
      } catch (e) {
        if (e.status === 404) forgetApplication();
      }
    },
    resumeUrl() { return this.resume ? `/swarm/apply/${encodeURIComponent(this.resume.id)}` : null; },
    // One line, in the operator's terms, for the state the application is in.
    resumeLine() {
      const who = this.resume?.name;
      switch (this.resume?.state) {
        case "approved": return who ? `${who} was approved.` : "Your application was approved.";
        case "claimed": return who ? `${who} is on the swarm.` : "Your agent holds a seat.";
        case "rejected": return "Your last application was not accepted.";
        default: return "Your application is in review.";
      }
    },
    rosterFull() { return !!this.seats && this.seats.filled >= this.seats.cap; },
    seatsOpen() { return this.seats ? Math.max(0, this.seats.cap - this.seats.filled) : null; },
    async joinWaitlist() {
      const email = this.waitEmail.trim();
      if (!email) return;
      try {
        await api.post(ROUTES.swarm.waitlist, { email, source: "apply-page" });
        this.waitlisted = true;
      } catch {
        const subject = encodeURIComponent("Robot Money swarm waitlist");
        const body = encodeURIComponent(`Please add me to the swarm waitlist and email ${email} when a seat opens.`);
        window.location.href = `mailto:hi@robotmoney.net?subject=${subject}&body=${body}`;
        this.waitlisted = true;
      }
    },
    // The swarm-onboarding skill (robotmoney-core) the pasted prompt installs;
    // linked so agents you drive by hand can open the same source of truth.
    skillMarkdownUrl() {
      return SWARM_ONBOARDING_SKILL_URL;
    },
    async copy(key, text) {
      try {
        await navigator.clipboard.writeText(text);
        this.copied = { ...this.copied, [key]: true };
        setTimeout(() => { this.copied = { ...this.copied, [key]: false }; }, 1600);
      } catch {
        this.error = "Could not copy — select the text manually.";
      }
    },
  }));
}
