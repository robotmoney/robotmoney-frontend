// The takes a session collected, expanded in place — and the address of the
// session itself.
//
// The second half of the split lib/session-summary.js started. That module
// answers "what did this session come out with"; this one answers "who said
// what, and where do I go for the whole thing". /swarm and a subject profile
// list the SAME sessions, so a reader who opens a row on one and a row on the
// other must get the same object, not two designs of it.
//
// A factory rather than a plain object, because `openTakes` is mutable state:
// a shared object literal would hand every component that spreads it the same
// map, and opening a row on one surface would open it on another.
import { api, ROUTES, path } from "./api.js";

export function sessionTakes() {
  return {
    // session id → { loading, error, takes }
    /** @type {Record<string, { loading: boolean, error: string, takes: any[] }>} */
    openTakes: {},

    // Link by SESSION ID. Two rows sharing a (date, subject) are two different
    // sessions — a subject may convene more than once a day — and the dated
    // URL resolves to the later of them, so linking by it would leave the
    // earlier session unreachable and make the pair look like one page listed
    // twice.
    //
    // The exception is the composite a static-archive row wears. Those rows
    // carry no id of their own, and subjectProfile.loadSessions mints
    // `${date}-${subjectId}` so x-for has something unique to key on. That
    // composite is a KEY, not a session id, and /swarm/sessions/<composite>
    // resolves to nothing. Recognise it and use the dated URL, which is the
    // archive's real address.
    /** @param {any} s */
    sessionHref(s) {
      // Callers gate the element instead of the value (see swarm.html's x-if
      // over the live strip), but a helper that throws takes the whole render
      // down, so no session at all yields no address.
      if (!s) return "";
      const id = s.id;
      const minted = id && id === `${s.date}-${s.subjectId}`;
      return id && !minted
        ? `/swarm/sessions/${encodeURIComponent(id)}`
        : `/swarm/${s.date}/${encodeURIComponent(s.subjectId)}`;
    },

    // ── takes, on demand ─────────────────────────────────────────────────
    // Not preloaded on /swarm: the list route carries counts but no bodies,
    // and fetching every session's takes to render a list nobody has asked to
    // see would be one request per card on every page load.
    /** @param {any} s */
    takesState(s) { return this.openTakes[s?.id] || null; },
    /** @param {any} s */
    async toggleTakes(s) {
      const id = String(s?.id || "");
      if (!id) return;
      if (this.openTakes[id]) {
        const { [id]: _drop, ...rest } = this.openTakes;
        this.openTakes = rest;
        return;
      }
      // A caller holding the bodies already hands them over instead of paying
      // for them twice: subjectProfile fetches every session's FULL detail to
      // build its cards, so the takes are in memory before the reader clicks.
      if (Array.isArray(s.takeRows)) {
        this.openTakes = { ...this.openTakes, [id]: { loading: false, error: "", takes: sortTakes(s.takeRows) } };
        return;
      }
      this.openTakes = { ...this.openTakes, [id]: { loading: true, error: "", takes: [] } };
      try {
        const d = await this.fetchSessionDetail(s);
        this.openTakes = { ...this.openTakes, [id]: { loading: false, error: "", takes: sortTakes(d?.takes) } };
      } catch (_) {
        this.openTakes = { ...this.openTakes, [id]: { loading: false, error: "These takes could not be loaded.", takes: [] } };
      }
    },
    // By id first, because a portfolio may convene twice in a day and the
    // dated form resolves to the later one. The dated form is the fallback for
    // a row with no id, and for the static archive.
    /** @param {any} s */
    async fetchSessionDetail(s) {
      if (s?.id) {
        try {
          const d = await api.get(path(ROUTES.swarm.sessionById, { id: s.id }));
          if (Array.isArray(d?.takes)) return d;
        } catch (_) { /* fall through to the dated form */ }
      }
      return api.get(path(ROUTES.swarm.session, { date: s.date, subject: s.subjectId }));
    },

    // One line, not the whole memo: the memo is a click away on the session.
    //
    // Take bodies are sectioned "**REGIME** / **ALLOCATION** / **SUBJECT**"
    // bullet lists, and the regime section opens every take with the same read
    // of the same market — expanding a session would print four rows that
    // agree about the composite and say nothing about the portfolio. SUBJECT
    // is the member's read of the thing actually under review, so that is the
    // bullet the row carries when it exists.
    /** @param {any} t */
    takeLine(t) {
      const raw = String(t?.body || "");
      if (!raw.trim()) return "";
      const sections = raw.split(/\n(?=\*\*)/);
      const pick = sections.find((/** @type {string} */ sec) => /^\*\*\s*SUBJECT/i.test(sec.trim())) || sections[0] || raw;
      const bullets = pick
        .replace(/^\*\*[^*]*\*\*/, "")
        .split("\n")
        .map((/** @type {string} */ l) => l.replace(/^[-*•]\s*/, "").replace(/[*_`#>]/g, "").replace(/\s+/g, " ").trim())
        .filter(Boolean);
      // Skip a bullet that only restates the row it sits in. These sections
      // open with "<subject> through a <lens> lens: <stance> at <n>
      // confidence", and the row already prints the stance and the figure — so
      // the excerpt would spend its one line saying nothing new.
      const stance = String(t?.stance || "").toLowerCase();
      const clean = bullets.find((/** @type {string} */ l) => {
        const low = l.toLowerCase();
        return !(stance && low.includes(stance) && low.includes("confidence"));
      }) || bullets[0] || "";
      return clean.length > 190 ? `${clean.slice(0, 187).trimEnd()}...` : clean;
    },

    // The public roster is status=active only, so a member deactivated after
    // this session is missing from `members` and we still print the id rather
    // than drop them. A link to that id still resolves: the member route
    // matches handle or id. A surface with no roster at all (a subject
    // profile does not fetch one) takes the same path.
    /** @param {string} id */
    memberById(id) {
      // `members` belongs to the surface, not to this module: /swarm holds a
      // roster, a subject profile does not.
      const roster = /** @type {any[]} */ ((/** @type {any} */ (this).members) || []);
      return roster.find((m) => m.id === id || m.handle === id) || null;
    },
    /** @param {string} id */
    memberHref(id) {
      const m = this.memberById(id);
      return `/swarm/members/${encodeURIComponent(m?.handle || id)}`;
    },
    /** @param {any} s */
    absentOf(s) {
      return (s?.swarmRecommendation?.absent || []).filter(Boolean).map((/** @type {string} */ id) => ({
        id,
        name: this.memberById(id)?.name || id,
        href: this.memberHref(id),
      }));
    },
  };
}

// Loudest first. A take with no confidence sorts last rather than being
// dropped: it is still an opinion somebody signed.
/** @param {any[] | null | undefined} takes */
function sortTakes(takes) {
  return (takes || []).slice().sort((a, b) => Number(b?.confidence || 0) - Number(a?.confidence || 0));
}
