// @ts-nocheck — browser-facing plain JS predating the root tsconfig's checkJs
// coverage (same status as every other alpine/views/*.js factory — none are
// in tsconfig.json's `include`). Pulled into the root TS program transitively
// by scripts/tests/unit/ask-roboto-matcher.test.ts's import of matchAgents()
// — the exact "a test imports a pure production function straight out of an
// otherwise-uncovered browser module" situation lib/api.js's own @ts-nocheck
// pragma already documents for frontend-routes.test.ts → static-views.js.
// JSDoc-typing the whole file is a follow-up, not a blocker for this issue.
//
// Alpine factory for /ask-mr-roboto — "Ask Mr. Roboto" AI recommendation
// assistant + side-by-side comparison tool (issue #394,
// docs/bot-analytics-ui-port-plan.md §5.18, P5.1). Renders inside views/dash/
// _layout.html's [data-outlet] — the ancestor shell already carries the `.a3`
// scope class (issue #379), so this fragment's root does NOT repeat it.
//
// D4/D5 (plan §9): the original called an LLM edge function on this path;
// docs/architecture.md §11 bans any LLM/AI call anywhere on the projects
// read/write path, and this issue's own scope explicitly excludes LLMs and
// synthetic mock data. matchAgents() below IS the non-LLM backend the plan's
// D5 recommends (option b): a deterministic, keyword-rule matcher over the
// SAME real rows GET /api/dashboards/agents already serves to the /agents
// directory (issue #385) — no new endpoint, no fabricated "thinking" delay,
// no scripted negotiation/payment theater (that would be synthetic
// interactivity with nothing real behind it, and D10 bans a button that does
// nothing). Every match, filter explanation, and comparison cell below is a
// real field off a real tracked-agent row — never fabricated.
import { api, ROUTES } from "../../lib/api.js";
import { fmtUsdCompact } from "../lib/dash-format.js";

// Recognized protocol_standard values (mirrors PROTOCOL_BADGE in
// dash-agents.js) — a query token equal to one of these narrows the pool to
// that protocol.
const PROTOCOLS = ["x402", "acp", "virtuals", "olas", "bankr", "eliza"];

// Sort/ranking keyword rules, checked in order; the first whose token
// appears in the query wins. Falls back to composite `score` when none
// match — the same default sort dash-agents.js itself uses.
const SORT_RULES = [
  { tokens: ["volume", "busiest", "busy"], key: "x402VolumeUsd", label: "x402 volume" },
  { tokens: ["balance", "richest", "wealthiest", "wealthy", "funded"], key: "balanceUsd", label: "wallet balance" },
  { tokens: ["txns", "transaction", "transactions"], key: "x402Txns", label: "x402 transactions" },
];

// Generic filler words in a typical request ("Find ME an AGENT that...")
// that must never be treated as a name-search token — otherwise almost every
// query would spuriously "match" every row whose name contains "agent".
const STOPWORDS = new Set([
  "find", "an", "a", "the", "me", "show", "get", "give", "best", "top",
  "highest", "most", "need", "want", "for", "with", "that", "who", "which",
  "please", "can", "you", "agent", "agents", "is", "are", "has", "have",
  "of", "to", "in", "on", "and", "or", "some", "any", "should", "use", "i",
  "tell", "about", "does", "recommend", "recommendation", "one", "there",
]);

/**
 * Pure, deterministic matcher — the entire "AI recommendation" behind Ask Mr.
 * Roboto. No network call, no randomness, no LLM: every rule reads a real
 * field off `agents` (the exact GET /api/dashboards/agents rows: id, name,
 * protocol, isFacilitator, active, score, x402Txns, x402VolumeUsd,
 * balanceUsd). Exported and unit-tested directly (see
 * scripts/tests/unit/ask-roboto-matcher.test.ts) — the same "import a pure
 * helper straight out of an alpine/ module" pattern frontend-routes.test.ts
 * already uses for alpine/static-views.js's camelSubject/takeHref/etc.
 * @param {string} query
 * @param {Array<Record<string, any>>} agents
 * @returns {{ matches: Array<Record<string, any>>, filters: string[], sortLabel: string, usedFallback: boolean }}
 */
export function matchAgents(query, agents) {
  const tokens = String(query || "").toLowerCase().match(/[a-z0-9]+/g) || [];
  const filters = [];
  let pool = agents.slice();

  if (tokens.includes("facilitator") || tokens.includes("facilitators")) {
    pool = pool.filter((a) => a.isFacilitator);
    filters.push("facilitators only");
  } else {
    const proto = PROTOCOLS.find((p) => tokens.includes(p));
    if (proto) {
      pool = pool.filter((a) => (a.protocol || "").toLowerCase() === proto);
      filters.push(`protocol: ${proto}`);
    }
  }

  if (tokens.includes("active")) {
    pool = pool.filter((a) => a.active);
    filters.push("active only");
  } else if (tokens.includes("idle") || tokens.includes("inactive")) {
    pool = pool.filter((a) => !a.active);
    filters.push("idle only");
  }

  // Words already consumed by a filter/sort rule above must never ALSO be
  // treated as a name-search token (e.g. "active" would otherwise be tried
  // against every agent name too, on top of already filtering active===true).
  const consumedTokens = new Set([
    "facilitator", "facilitators", "active", "idle", "inactive",
    ...PROTOCOLS,
    ...SORT_RULES.flatMap((r) => r.tokens),
  ]);
  const nameTokens = tokens.filter((t) => t.length >= 3 && !STOPWORDS.has(t) && !consumedTokens.has(t));
  if (nameTokens.length) {
    // Only the tokens that actually matched at least one agent name are
    // reported back — an unmatched filler word (not in STOPWORDS, but also
    // not part of any real name) must not appear in the honest explanation.
    const matchedNameTokens = nameTokens.filter((t) => pool.some((a) => a.name.toLowerCase().includes(t)));
    if (matchedNameTokens.length) {
      pool = pool.filter((a) => matchedNameTokens.some((t) => a.name.toLowerCase().includes(t)));
      filters.push(`name contains "${matchedNameTokens.join(" ")}"`);
    }
  }

  const sortRule = SORT_RULES.find((r) => r.tokens.some((t) => tokens.includes(t)));
  const sortKey = sortRule ? sortRule.key : "score";
  const sortLabel = sortRule ? sortRule.label : "composite score";

  // Nothing survived the filters: fall back to the FULL roster (never an
  // empty "no results" dead end) but say so honestly (usedFallback) rather
  // than silently widening without explanation.
  const usedFallback = pool.length === 0 && agents.length > 0;
  const ranked = (usedFallback ? agents.slice() : pool).sort((a, b) => {
    const av = a[sortKey];
    const bv = b[sortKey];
    const an = typeof av === "number" && isFinite(av) ? av : -Infinity;
    const bn = typeof bv === "number" && isFinite(bv) ? bv : -Infinity;
    if (an === bn) return a.name.localeCompare(b.name);
    return bn - an;
  });

  return { matches: ranked.slice(0, 3), filters, sortLabel, usedFallback };
}

const SUGGESTIONS = [
  "Find an active x402 agent",
  "Highest volume agent",
  "Show me facilitators",
  "Best balance holder",
];

export function registerAskRobotoView(Alpine) {
  Alpine.data("askRobotoView", () => ({
    loading: true,
    error: null,
    agents: [],
    suggestions: SUGGESTIONS,

    query: "",
    // { id, role: 'user'|'roboto', text, matches?, filters? }
    log: [],
    // ordered list of agent ids added to the comparison tray; accumulates
    // across separate questions so a user can build up a comparison from
    // several asks, not just one response's matches.
    compareIds: [],

    async init() {
      await this.load();
    },

    async load() {
      this.loading = true;
      this.error = null;
      try {
        const res = await api.get(ROUTES.dashboards.agents);
        this.agents = res.agents || [];
      } catch (e) {
        this.error = e.message;
      } finally {
        this.loading = false;
      }
    },

    // ── conversation ──────────────────────────────────────────────────────
    ask(text) {
      const q = (text ?? this.query).trim();
      if (!q) return;
      this.log = [...this.log, { id: `u${this.log.length}`, role: "user", text: q }];

      if (this.agents.length === 0) {
        this.log = [...this.log, {
          id: `r${this.log.length}`,
          role: "roboto",
          text: "No agents tracked yet — nothing to match against.",
          matches: [],
          filters: [],
        }];
      } else {
        const { matches, filters, sortLabel, usedFallback } = matchAgents(q, this.agents);
        const responseText = usedFallback
          ? `No agent matched those filters exactly — showing the top agents by ${sortLabel} instead.`
          : `Matched${filters.length ? " on " + filters.join(", ") : ""}, sorted by ${sortLabel}.`;
        this.log = [...this.log, {
          id: `r${this.log.length}`,
          role: "roboto",
          text: responseText,
          matches,
          filters,
        }];
      }
      this.query = "";
    },
    submitAsk() {
      this.ask();
    },
    askSuggestion(text) {
      this.ask(text);
    },

    // ── compare tray ─────────────────────────────────────────────────────────
    isComparing(id) {
      return this.compareIds.includes(id);
    },
    toggleCompare(id) {
      if (this.compareIds.includes(id)) {
        this.compareIds = this.compareIds.filter((x) => x !== id);
      } else if (this.compareIds.length < 4) {
        this.compareIds = [...this.compareIds, id];
      }
    },
    clearCompare() {
      this.compareIds = [];
    },
    get compareRows() {
      return this.compareIds.map((id) => this.agents.find((a) => a.id === id)).filter(Boolean);
    },

    // ── formatting (same conventions as dash-agents.js) ──────────────────────
    fmtUsd(n) {
      return fmtUsdCompact(n);
    },
    fmtScore(n) {
      return n == null || !isFinite(n) ? "—" : n.toFixed(1);
    },
    protocolLabel(agent) {
      if (agent.isFacilitator) return "Facilitator";
      return agent.protocol ? agent.protocol.toUpperCase() : "—";
    },
  }));
}
