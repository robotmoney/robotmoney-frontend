// Alpine factory for /submit — public intake (issue #393,
// docs/bot-analytics-ui-port-plan.md §5.17): the CommitForm (tag-agent
// Select, action-type Select, conditional agent-registration sub-panel,
// summary) plus the two informational cards (MCP-card rewrite, Programmatic
// API card). Renders inside views/dash/_layout.html's [data-outlet] — the
// ancestor shell already carries the `.a3` scope class (issue #379), so
// this fragment's root does NOT repeat it (same convention as views/list.js).
//
// The MCP fidelity exception (§1.5 / D21, #265): the original's /submit
// carried a copyable MCP server config JSON block. MCP is retired here, so
// that card's CONTENT is rewritten to point at the real POST endpoint below
// (this repo has no separate agent-onboarding skill to link — reusing the
// unrelated committee-onboarding skill would misrepresent what it does) —
// the purple visual treatment and floating CopyButton are preserved
// verbatim; only the copy changed.
import { api, ROUTES } from "../../lib/api.js";

// Mirrors SUBMISSION_ACTION_TYPES in backend/src/api/routes/submissions.ts —
// keep both lists in sync if a type is ever added/removed.
export const ACTION_TYPES = [
  { value: "register_agent", label: "🤖 Register Agent" },
  { value: "update_agent", label: "Update Agent Info" },
  { value: "link_wallet", label: "Link Wallet" },
  { value: "link_token", label: "Link Token" },
  { value: "link_vault", label: "Link Vault" },
  { value: "report_issue", label: "Report Data Issue" },
  { value: "endorse_agent", label: "Endorse Agent" },
  { value: "general", label: "General Commit" },
];

const POST_EXAMPLE = `POST /api/dashboards/submissions
Content-Type: application/json

{
  "actionType": "register_agent",
  "submitterHandle": "@yourhandle",
  "summary": "Registering my agent for tracking.",
  "registration": {
    "name": "My Agent",
    "walletAddress": "0x...",
    "description": "What it does",
    "claimedRevenueUsd": 1200,
    "claimedTxns": 42,
    "website": "https://example.com",
    "twitter": "@myagent",
    "launchDate": "2026-01-01"
  }
}`;

function emptyForm() {
  return {
    submitterHandle: "",
    agentId: "",
    actionType: "register_agent",
    summary: "",
    registration: {
      name: "",
      walletAddress: "",
      description: "",
      claimedRevenueUsd: "",
      claimedTxns: "",
      claimedUsers: "",
      website: "",
      twitter: "",
      launchDate: "",
    },
  };
}

export function registerSubmitView(Alpine) {
  Alpine.data("submitView", () => ({
    formOpen: true,
    agents: [],
    agentsLoading: true,
    posting: false,
    errors: {},
    form: emptyForm(),

    actionTypes: ACTION_TYPES,
    postExample: POST_EXAMPLE,
    validActionTypeList: ACTION_TYPES.map((t) => t.value).join(", "),

    async init() {
      try {
        const res = await api.get(ROUTES.dashboards.entities);
        this.agents = (res.entities || []).filter((e) => e.type === "agent" && !e.pending);
      } catch (_) {
        // Non-fatal: the tag-agent Select degrades to empty rather than
        // blocking the rest of the (agent-select-independent) form.
        this.agents = [];
      } finally {
        this.agentsLoading = false;
      }
    },

    toggleForm() {
      this.formOpen = !this.formOpen;
    },

    get isRegisterAgent() {
      return this.form.actionType === "register_agent";
    },

    _numOrNull(v) {
      if (v === "" || v == null) return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    },

    validate() {
      const errors = {};
      if (!this.form.submitterHandle.trim()) errors.submitterHandle = "Name / handle is required.";
      if (!this.form.summary.trim()) errors.summary = "Summary is required.";
      if (this.isRegisterAgent && !this.form.registration.name.trim()) {
        errors.registrationName = "Agent name is required.";
      }
      this.errors = errors;
      return Object.keys(errors).length === 0;
    },

    async submit() {
      if (!this.validate()) return;
      this.posting = true;
      try {
        const body = {
          actionType: this.form.actionType,
          submitterHandle: this.form.submitterHandle.trim(),
          agentId: this.form.agentId || null,
          summary: this.form.summary.trim(),
          registration: this.isRegisterAgent
            ? {
                name: this.form.registration.name.trim(),
                walletAddress: this.form.registration.walletAddress.trim() || null,
                description: this.form.registration.description.trim() || null,
                claimedRevenueUsd: this._numOrNull(this.form.registration.claimedRevenueUsd),
                claimedTxns: this._numOrNull(this.form.registration.claimedTxns),
                claimedUsers: this._numOrNull(this.form.registration.claimedUsers),
                website: this.form.registration.website.trim() || null,
                twitter: this.form.registration.twitter.trim() || null,
                launchDate: this.form.registration.launchDate || null,
              }
            : null,
        };
        await api.post(ROUTES.dashboards.submissions, body);
        Alpine.store("a3Toast").push("Commit submitted — thanks! It's in the review queue.", "success");
        this.form = emptyForm();
        this.errors = {};
      } catch (e) {
        Alpine.store("a3Toast").push(`Could not submit (${e.message}).`, "destructive");
      } finally {
        this.posting = false;
      }
    },
  }));
}
