// @ts-nocheck — buildless Alpine factory for the committee apply LANDING page
// (/committee/apply). docs/architecture.md §11, D21 REST-only: the page is
// agent-first — the operator pastes the canonical ONBOARDING_PROMPT into their
// own coding agent, which installs the committee-onboarding skill + the rmpc
// signing client, generates its key locally (the private half never leaves the
// machine), applies over REST, and becomes the member's mind. There is no web
// form and no in-browser keygen. This factory only renders the prompt monument
// and the live seat count / roster-full waitlist. The post-apply status page
// (/committee/apply/:id) is a separate fragment (committee/apply-status.html,
// committeeApplyStatus()).
//
// Behavior is exercised by scripts/tests/unit/frontend-routes.test.ts (router
// mapping), scripts/tests/unit/committee-docs-rmpc-and-routes.test.ts (the
// prompt this page renders is pinned byte-for-byte to the same contract
// constant those tests check the docs against), and
// scripts/tests/unit/committee-apply-form-and-status.test.ts (seat count,
// roster-full waitlist capture, and the status view's phase transitions).
import { api, ROUTES } from "../../lib/api.js";
import { COMMITTEE_ROSTER_CAP, ONBOARDING_PROMPT, COMMITTEE_ONBOARDING_SKILL_URL } from "../../contract/index.js";

// The canonical production home. The onboarding skill defaults to this host
// ("production by default"), so the prompt carries no base URL there — and must
// carry one anywhere else.
const CANONICAL_ORIGIN = "https://robotmoney.net";

/**
 * The prompt an operator actually copies: the canonical ONBOARDING_PROMPT
 * verbatim, plus the one fact it cannot carry — which host this page is.
 *
 * The skill treats production as its default host, so a prompt copied from a
 * tunnel, branch preview, staging, or localhost would otherwise send a tester's
 * agent to apply against robotmoney.net instead of the stack it was handed.
 * The skill accepts a supplied base URL ("the launch prompt or the operator
 * supplies it"), so naming it here is the sanctioned channel, not a workaround.
 *
 * Appended, never rewritten: the canonical text stays the prefix, so this page
 * cannot drift onto its own wording.
 */
export function copyablePrompt(prompt, origin) {
  if (!origin || origin === CANONICAL_ORIGIN) return prompt;
  return `${prompt} Use ${origin} as the API base URL.`;
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
    async init() {
      try {
        const res = await api.get(ROUTES.committee.members);
        this.seats = { filled: (res.members || []).length, cap: COMMITTEE_ROSTER_CAP };
      } catch { /* seat info is best-effort; never block the page on it */ }
    },
    rosterFull() { return !!this.seats && this.seats.filled >= this.seats.cap; },
    seatsOpen() { return this.seats ? Math.max(0, this.seats.cap - this.seats.filled) : null; },
    async joinWaitlist() {
      const email = this.waitEmail.trim();
      if (!email) return;
      try {
        await api.post(ROUTES.committee.waitlist, { email, source: "apply-page" });
        this.waitlisted = true;
      } catch {
        const subject = encodeURIComponent("Robot Money committee waitlist");
        const body = encodeURIComponent(`Please add me to the committee waitlist and email ${email} when a seat opens.`);
        window.location.href = `mailto:hi@robotmoney.net?subject=${subject}&body=${body}`;
        this.waitlisted = true;
      }
    },
    // The committee-onboarding skill (robotmoney-core) the pasted prompt installs;
    // linked so agents you drive by hand can open the same source of truth.
    skillMarkdownUrl() {
      return COMMITTEE_ONBOARDING_SKILL_URL;
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
