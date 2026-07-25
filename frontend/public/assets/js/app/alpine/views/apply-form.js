// @ts-nocheck — buildless Alpine factory; behavior is exercised by
// scripts/tests/unit/frontend-routes.test.ts (router mapping) and
// scripts/tests/unit/committee-docs-rmpc-and-routes.test.ts (the prompt this page
// renders is pinned byte-for-byte to the same contract constant those tests
// check the docs against).
// Alpine factory for the committee application form (/committee/apply).
// docs/architecture.md §11 R3/R6: keygen and signing happen on the
// applicant's own agent (rmpc) BEFORE this page is ever used — Robot Money
// never generates a key and never sees a private key. This page has exactly
// two jobs: (a) render the canonical copy-paste prompt (ONBOARDING_PROMPT,
// @robotmoney/contract — the SAME constant the docs render, so this page can
// never drift onto its own copy) with a copy button, and (b) accept the
// agent-produced signed application payload and POST it to the apply API
// verbatim — for owners who prefer submitting by hand (D21: REST-only).
import { api, ROUTES } from "../../lib/api.js";
import { ONBOARDING_PROMPT } from "../../contract/index.js";

export function registerApplyForm(Alpine) {
  Alpine.data("applyForm", () => ({
    prompt: ONBOARDING_PROMPT,
    pasteText: "",
    submitting: false,
    error: null,
    result: null,
    async submit() {
      this.error = null;
      let body;
      try {
        body = JSON.parse(this.pasteText);
      } catch (_e) {
        this.error = "That isn't valid JSON — paste the exact signed application payload your agent produced.";
        return;
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        this.error = "Paste a single JSON object: { name, contact, lens?, publicKey, signature }.";
        return;
      }
      this.submitting = true;
      try {
        this.result = await api.post(ROUTES.committee.apply, body);
      } catch (e) {
        this.error = e.message;
      } finally {
        this.submitting = false;
      }
    },
  }));
}
