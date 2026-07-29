// @ts-nocheck — browser-facing plain JS predating the root tsconfig's checkJs
// coverage. It entered the root TS program when frontend-routes.test.ts was
// re-pointed at the real archive loaders below (review-maintainability-026);
// before that it was never typechecked, so this pragma preserves the status
// quo rather than weakening existing coverage. JSDoc-typing this file is a
// worthwhile follow-up, not a drive-by.
import { api, ROUTES, path } from "../lib/api.js";
import { subjectDot } from "./views/shared.js";
import { forgetApplication, rememberApplication } from "../lib/application-memory.js";
import { COMMITTEE_DISCLAIMER } from "../lib/committee-disclaimer.js";

// Sentiment scale on the Beam/Pool/Beacon covenant: conviction reads as the
// green mass (bullish deepest → constructive lighter), neutral as slate, and
// the negative end as sand → beacon (attention/loss). Retires the old
// lime/red/amber Tailwind trio.
const STANCE_COLORS = {
  bullish: "#10b981",
  constructive: "#34d399",
  neutral: "#7e889e",
  cautious: "#e8a640",
  bearish: "#ff7a29",
};

// One series palette, read by the concentration chart and by the holdings
// table's key rule so a colour means the same token in both.
const SERIES_COLORS = ["#00e5ff", "#5fb3a1", "#10b981", "#e8a640", "#ff7a29", "#7e889e", "#6ee7b7"];

const ARCHIVE_LAST_DATE = "2026-06-25";
const KNOWN_ARCHIVE_MEMBERS = ["athena", "robotmoney", "woon"];

async function fetchJson(url) {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`${url} (${res.status})`);
  return res.json();
}

function archivePreferred(date) {
  return String(date || "") < "2026-07-01";
}

function camelSession(raw) {
  if (!raw) return null;
  return {
    id: raw.id || `${raw.date}-${raw.subject_id || raw.subjectId}`,
    date: raw.date,
    subjectId: raw.subjectId || raw.subject_id,
    subjectName: raw.subjectName || raw.subject_name,
    state: raw.state || "published",
    // The API serves regimeSummary with a camelCase OUTER key but snake_case
    // INNER keys (macro_percentile, macro_regime, …); the archive JSON uses
    // snake_case throughout. Normalize inner keys from either source so
    // panelInputs()/regime labels read a consistent camelCase shape.
    regimeSummary: (() => {
      const rs = raw.regimeSummary || raw.regime_summary;
      if (!rs) return null;
      return {
        composite: rs.composite,
        compositePercentile: rs.compositePercentile ?? rs.composite_percentile,
        regime: rs.regime,
        macroRegime: rs.macroRegime ?? rs.macro_regime,
        onchainRegime: rs.onchainRegime ?? rs.onchain_regime,
        factorRegime: rs.factorRegime ?? rs.factor_regime,
        macroPercentile: rs.macroPercentile ?? rs.macro_percentile,
        onchainPercentile: rs.onchainPercentile ?? rs.onchain_percentile,
        factorPercentile: rs.factorPercentile ?? rs.factor_percentile,
        history: rs.history || [],
      };
    })(),
    subjectSnapshotTotalValueUsd: raw.subjectSnapshotTotalValueUsd ?? raw.subject_snapshot_total_value_usd ?? null,
    synthesis: raw.synthesis || "",
    committeeRecommendation: raw.committeeRecommendation || raw.committee_recommendation || null,
    generatedAt: raw.generatedAt || raw.generated_at || null,
  };
}

function camelTake(raw) {
  return {
    id: raw.id || raw.member_id || raw.memberId,
    memberId: raw.memberId || raw.member_id,
    memberName: raw.memberName || raw.member_name,
    mode: raw.mode || "submit",
    stance: raw.stance,
    confidence: Number(raw.confidence ?? 0),
    body: raw.body || "",
    model: raw.model,
    memoUrl: raw.memoUrl || raw.memo_url,
    verified: raw.verified,
    receivedAt: raw.receivedAt || raw.received_at || raw.generated_at || raw.generatedAt,
  };
}

function camelMember(raw) {
  if (!raw) return null;
  return {
    id: raw.id,
    status: raw.status,
    name: raw.name,
    tagline: raw.tagline,
    lens: raw.lens,
    mandate: raw.mandate,
    biases: raw.biases,
    mode: raw.mode,
    operator: raw.operator,
    avatar: raw.avatar,
    wallet: raw.wallet,
    activatedAt: raw.activatedAt || raw.activated_at,
  };
}

function camelSubject(raw) {
  if (!raw) return null;
  return {
    id: raw.id,
    name: raw.name,
    operator: raw.operator,
    homepage: raw.homepage,
    financesPage: raw.finances_page || raw.financesPage,
    xHandle: raw.x_handle || raw.xHandle,
    thesisBlurb: raw.thesis_blurb || raw.thesisBlurb,
    wallets: raw.wallets || [],
    structuralNotes: raw.structural_notes || raw.structuralNotes || [],
    // The subject endpoint has always returned these; nothing mapped them, so
    // every consumer saw `undefined` and rendered nothing. The public subject
    // profile is the first surface that shows them.
    nftContracts: raw.nft_contracts || raw.nftContracts || [],
    recommendationType: raw.recommendation_type || raw.recommendationType,
    linkedMemberId: raw.linked_member_id || raw.linkedMemberId,
  };
}

function normalizeSnapshot(raw) {
  if (!raw) return null;
  return {
    date: raw.date,
    totalValueUsd: Number(raw.total_value_usd ?? raw.totalValueUsd ?? 0),
    positions: raw.positions || [],
    wallets: raw.wallets || [],
    notable: raw.notable || [],
  };
}

// The archive loaders below are the PRODUCTION static-archive path (sessions
// dated before 2026-07-01 render from /data/committee/*.json). They are
// exported so scripts/tests/unit/frontend-routes.test.ts can execute the exact
// loaders the browser runs against the shipped archive files (review 026:
// the previous test covered a dead duplicate normalizer instead).
export async function loadArchiveSession(date, subject) {
  const index = await fetchJson("/data/committee/sessions/index.json");
  // index.json entries are snake_case (subject_id) while the API serves
  // camelCase — read both, matching camelSession's tolerant style, so the
  // existence check can never diverge from the file it just fetched.
  const exists = (index.sessions || []).some((s) => s.date === date && (s.subjectId ?? s.subject_id) === subject);
  if (!exists) throw new Error(`archive session missing: ${date}/${subject}`);
  const raw = await fetchJson(`/data/committee/sessions/${date}-${subject}.json`);
  return { session: camelSession(raw), takes: (raw.takes || []).map(camelTake), source: "archive" };
}

export async function loadArchiveMember(id) {
  return camelMember(await fetchJson(`/data/committee/manifests/members/${id}.json`));
}

export async function loadArchiveSubject(id) {
  return camelSubject(await fetchJson(`/data/committee/manifests/subjects/${id}.json`));
}

export async function loadArchiveSnapshot(subject, date) {
  try { return normalizeSnapshot(await fetchJson(`/data/committee/subjects/${subject}/${date}.json`)); }
  catch (_) { return null; }
}

// Pick the snapshot to render for a session from the API snapshots list and
// normalize it into the SAME shape the archive path produces (via
// normalizeSnapshot), so the portfolio donut/table read identically on both
// data paths. Chooses the latest snapshot dated on-or-before the session date,
// else the most recent overall. Returns null on empty/absent input.
function pickSnapshotFor(snapshots, date) {
  const list = (snapshots || []).filter(Boolean);
  if (!list.length) return null;
  const target = String(date || "");
  const notAfter = list.filter((s) => String(s.date || "") <= target);
  const pool = notAfter.length ? notAfter : list;
  const chosen = pool.reduce((a, b) => (String(a.date || "") >= String(b.date || "") ? a : b));
  return normalizeSnapshot(chosen);
}

const helpers = {
  // Strip punctuation before taking initials. Operators name their agents
  // freely, and "woon (test)" was rendering as "W(" — the second word's first
  // character is a parenthesis, not a letter.
  initials(name = "") {
    return String(name)
      .split(/\s+/)
      .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ""))
      .filter(Boolean)
      .slice(0, 2)
      .map((s) => s[0].toUpperCase())
      .join("") || "IC";
  },
  stanceColor(stance) {
    return STANCE_COLORS[stance] || "#7e889e";
  },
  stanceStyle(stance) {
    const c = this.stanceColor(stance);
    return `border-color:${c}66;color:${c};`;
  },
  fmtPct(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "—";
    return `${Math.round(n * 100)}%`;
  },
  fmtPct1(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "—";
    return `${(n * 100).toFixed(1)}%`;
  },
  fmtUsd(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "—";
    return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  },
  fmtNum(value, digits = 2) {
    const n = Number(value);
    return Number.isFinite(n) ? n.toFixed(digits) : "—";
  },
  clampPct(value) {
    const n = Number(value);
    return Math.max(0, Math.min(100, Number.isFinite(n) ? n : 0));
  },
  regimeLabel(regime) {
    return regime ? String(regime).replace(/_/g, "-") : "—";
  },
  // Regime is DIRECTIONAL — "risk-on" and "risk-off" are opposite readings and
  // were rendering as identical grey type, so the two panels that disagreed
  // looked the same as the two that agreed. Same ends as STANCE_COLORS (Pool
  // green for the constructive end, Beacon for the attention end, slate
  // neutral), carried by a <=8px dot rather than coloured text: Beacon is a
  // POINT in the covenant, never a run of type.
  regimeColor(regime) {
    const key = String(regime || "").replace(/-/g, "_");
    return ({ risk_on: "#10b981", neutral: "#7e889e", risk_off: "#ff7a29" })[key] || "#7e889e";
  },
  formatDate(value, style = "short") {
    if (!value) return "—";
    const date = String(value).includes("T") ? new Date(value) : new Date(`${value}T00:00:00Z`);
    const opts = style === "long"
      ? { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }
      : { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" };
    try { return date.toLocaleDateString("en-US", opts); } catch (_) { return value; }
  },
  memberTagline(member) {
    return member?.tagline || member?.mandate || `${member?.name || "This member"} reads the session through a ${member?.lens || "committee"} lens.`;
  },
  memberBiases(member) {
    if (Array.isArray(member?.biases) && member.biases.length) return member.biases.filter(Boolean);
    return member?.lens ? [member.lens] : ["independent review", "signed recommendations"];
  },
  fallbackMandate(member) {
    return `Evaluate each subject through the ${member?.lens || "committee"} lens and submit a signed stance with confidence and rationale.`;
  },
  takeHref(take) {
    return path(ROUTES.committee.takePermalink, { id: take?.id });
  },
  escapeHtml(text) {
    return String(text ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  },
  // ── Verification badge ──────────────────────────────────────────────────────
  // One wording, one mark, shared by the member, session and permalink pages —
  // "verified" must mean exactly the same thing everywhere it appears.
  verifyLabel(ok) { return ok ? "verified" : "unverified"; },
  verifyTip(ok) {
    return ok
      ? "Signed on the member's own machine with a key only they hold. The signature is re-checked against their public key every time this take is served — not just when it was filed."
      : "This take's signature did not check out against the member's public key. Treat it as unattributed.";
  },
  // Inner glyph of the badge: a check for verified, a cross for not. Drawn
  // rather than typed so it keeps its weight next to mono text at 13px.
  verifyPath(ok) { return ok ? "M4.6 8.2l2.3 2.3 4.6-5" : "M5.4 5.4l5.2 5.2M10.6 5.4l-5.2 5.2"; },

  // Subject hue, from the one shared definition (views/shared.js) so the member
  // profile, the roster and any future surface cannot drift apart. A symbol is
  // one colour everywhere.
  subjectDot(subjectId) { return subjectDot(subjectId); },
  // Inline marks for one line of member-authored text. ESCAPING COMES FIRST and
  // is not optional: take bodies are submitted by third-party agents over a
  // public endpoint, so this output is untrusted input on its way into x-html.
  // Only bold and links are re-introduced, both from patterns matched after the
  // escape, so no attacker-supplied angle bracket can survive as markup.
  inlineMarks(line) {
    return this.escapeHtml(line)
      .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>')
      .replace(/(^|[\s(])(\/[a-zA-Z0-9/_-]+)/g, '$1<a href="$2">$2</a>');
  },
  // Render a member's take body.
  //
  // Takes arrive as markdown: a bold section heading, then a run of bullets,
  // repeated. The previous pass only wrapped a block in <ul> when EVERY line in
  // it was a bullet, so the common "**REGIME**\n- a\n- b" shape emitted
  // <p><strong>REGIME</strong><br><li>a</li><li>b</li></p> — list items orphaned
  // inside a paragraph with no list around them. Invalid, and it looked it.
  //
  // Now each block is walked in runs: consecutive bullets close into one <ul>,
  // a line that is nothing but bold becomes a heading, and everything else
  // accumulates into a paragraph.
  linkified(text) {
    const out = [];
    for (const block of String(text || "").split(/\n\n+/)) {
      const lines = block.split(/\n/).filter((l) => l.trim() !== "");
      let bullets = [];
      let para = [];
      const flushBullets = () => { if (bullets.length) { out.push(`<ul>${bullets.join("")}</ul>`); bullets = []; } };
      const flushPara = () => { if (para.length) { out.push(`<p>${para.join("<br>")}</p>`); para = []; } };
      for (const line of lines) {
        if (/^\s*[-*]\s+/.test(line)) {
          flushPara();
          bullets.push(`<li>${this.inlineMarks(line.replace(/^\s*[-*]\s+/, ""))}</li>`);
          continue;
        }
        flushBullets();
        // A line that is only **bold** is a section heading, not a sentence.
        const heading = line.trim().match(/^\*\*([^*\n]+)\*\*$/);
        if (heading) {
          flushPara();
          out.push(`<h4 class="cv__take-h">${this.escapeHtml(heading[1])}</h4>`);
          continue;
        }
        para.push(this.inlineMarks(line));
      }
      flushBullets();
      flushPara();
    }
    return out.join("");
  },
};

export function registerStaticViews(Alpine) {
  // One string, four committee surfaces. See lib/committee-disclaimer.js for
  // why the wording is production's verbatim and not this repo's to edit.
  Alpine.data("committeeDisclaimer", () => ({ text: COMMITTEE_DISCLAIMER }));

  Alpine.data("committeeTakeReceipt", () => ({
    ...helpers,
    loading: true,
    error: null,
    take: null,
    memo: null,
    signer: null,
    async init() {
      const match = location.pathname.match(/^\/committee\/takes\/([^/]+)\/?$/);
      if (!match) {
        this.error = "Take not found";
        this.loading = false;
        return;
      }
      try {
        const receipt = await api.get(path(ROUTES.committee.take, { id: decodeURIComponent(match[1]) }));
        this.take = camelTake(receipt.take);
        this.memo = receipt.memo;
        this.signer = receipt.signer;
      } catch (e) {
        this.error = e.message || "Take not found";
      } finally {
        this.loading = false;
      }
    },
    // The backend stores a memo whose body is a verbatim copy of the take body
    // (same shape of duplication as the aggregator's consensus echo on the
    // session page), so this receipt printed the identical prose twice under
    // two headings that each promised something different. Suppress the memo
    // panel when it is that copy; the day a memo carries its own text it stops
    // matching and renders. Deliberately shape-agnostic — no backend change is
    // required for it to start working.
    memoIsEcho() {
      const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
      const body = norm(this.memo?.body);
      return !!body && body === norm(this.take?.body);
    },
  }));

  // Public application-status poller (docs/architecture.md §11 R2), the page
  // the runbook promises at <host>/committee/apply/<member-id>. Polls the
  // public, redacted status route until a terminal state (claimed/rejected)
  // or the component unmounts — Alpine's destroy() lifecycle hook (fired on
  // both route navigation via rm:before-view-change→destroyTree and a raw
  // page unload) always clears the timer, so leaving the page never leaves a
  // poll loop running against a stale id.
  Alpine.data("committeeApplyStatus", () => ({
    ...helpers,
    STEPS: ["applied", "approved", "claimed"],
    // The KEYS above are lifecycle states and are pinned by
    // scripts/tests/unit/committee-apply-form-and-status.test.ts. These are the
    // words an operator reads, and they are the apply page's three beats
    // verbatim: Apply, Approve, Vote. "Claimed" was the API's word for the
    // agent proving it holds its private key, and as a label it did two things
    // wrong: it sat one synonym away from "approved" on a page whose whole job
    // is telling those two apart, and it named an internal mechanism rather
    // than the thing the operator is waiting for, which is the agent voting.
    STEP_LABELS: { applied: "Apply", approved: "Approve", claimed: "Vote" },
    stepLabel(step) { return this.STEP_LABELS[step] || step; },
    id: null,
    loading: true,
    error: null,
    status: null,
    member: null, // public projection, best-effort, for the display name
    memberFetchTried: false,
    record: [],          // this member's filed takes, newest first
    recordLoaded: false,
    openSessions: [],    // every session currently collecting, not just one
    pulseTicks: 0,
    copiedId: false,
    pollTimer: null,
    pulseTimer: null,
    async init() {
      const match = location.pathname.match(/^\/committee\/apply\/([^/]+)\/?$/);
      if (!match) {
        this.error = "Application not found";
        this.loading = false;
        return;
      }
      this.id = decodeURIComponent(match[1]);
      await this.refresh();
      this.pollTimer = setInterval(() => this.refresh(), 4000);
      // Heartbeat: only meaningful once approved, so checkPulse() self-gates.
      this.checkPulse();
      this.pulseTimer = setInterval(() => this.checkPulse(), 20000);
    },
    destroy() {
      if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
      if (this.pulseTimer) { clearInterval(this.pulseTimer); this.pulseTimer = null; }
    },
    async refresh() {
      try {
        this.status = await api.get(path(ROUTES.committee.applyStatus, { id: this.id }));
        this.error = null;
        if (["claimed", "rejected"].includes(this.status.state) && this.pollTimer) {
          clearInterval(this.pollTimer);
          this.pollTimer = null;
        }
      } catch (e) {
        // Only surface an error when there is nothing good on screen. This runs
        // on a 4s poll, so an unguarded assignment let one dropped request
        // insert a page-level error above the article, shove everything down,
        // and clear itself four seconds later, on a page that was displaying
        // correct data throughout.
        if (!this.status || e.status === 404) {
          this.error = e.status === 404 ? "No application found for this id." : (e.message || "Could not load application status.");
        }
        if (e.status === 404) {
          // A remembered pointer that 404s is worse than none: it would send the
          // operator here again from the apply page every time.
          forgetApplication();
          if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
        }
      } finally {
        this.loading = false;
      }
      // The redacted status endpoint never echoes the name, so pull it from the
      // public member projection. This is NOT gated on approval: GET
      // /api/committee/members/:id already returns `name` for a member still in
      // `applied` (verified against a live stack), so the status route's
      // redaction was not withholding anything that endpoint does not publish
      // anyway, and gating here only meant the operator stared at a bare UUID
      // during the one phase where they most need to recognise their own agent.
      // Contact and publicKey stay redacted in both places, which is the part
      // that actually matters.
      //
      // Tried once, not once per poll: this runs inside a 4s loop, and a member
      // that genuinely has no public projection would otherwise 404 forever.
      if (!this.member && !this.memberFetchTried) {
        this.memberFetchTried = true;
        try { this.member = camelMember(await api.get(path(ROUTES.committee.member, { id: this.id }))); }
        catch { /* no public projection — every caller falls back to the id */ }
      }
      // Opening this page is the one moment the browser ever learns the id, so
      // it is the one chance to make the page reachable again later. See
      // lib/application-memory.js.
      if (this.status) {
        rememberApplication({ id: this.id, name: this.member?.name, state: this.status.state });
      }
      this.syncTitle();
    },
    // Route-level SEO titleizes the last URL segment, which here is a raw UUID
    // ("88efd6b9 E865 417d Afe1 45d84510338b — Robot Money Investment
    // Committee"). Same fix memberProfile already applies: name the tab after
    // the member once it is known, and after the state until then.
    syncTitle() {
      const suffix = "Robot Money Investment Committee";
      const name = this.member?.name;
      document.title = name
        ? `${name}: ${suffix}`
        : `${this.status?.state === "rejected" ? "Application not accepted" : "Application status"}: ${suffix}`;
    },
    // applied → approved → claimed, per docs/architecture.md §11.2. rejected
    // is a terminal off-ramp: "applied" still reads done (it happened), the
    // remaining steps read neither done nor pending — they're moot, not "next".
    //
    // This is the LIFECYCLE state and its three values are pinned by
    // scripts/tests/unit/committee-apply-form-and-status.test.ts (#245 AC2).
    // Presentation-only distinctions belong in stepClass(), not here.
    stepState(step) {
      const order = ["applied", "approved", "claimed"];
      const idx = order.indexOf(step);
      if (!this.status || idx === -1) return "pending";
      if (this.status.state === "rejected") return step === "applied" ? "done" : "moot";
      const cur = order.indexOf(this.status.state);
      if (cur === -1) return "pending";
      return idx <= cur ? "done" : "pending";
    },
    // What the row actually renders as. Identical to stepState() except that
    // the single step immediately after the current one is "next" rather than
    // "pending", so the list can say where the operator is standing. Every step
    // used to be done-or-pending, which on a finished application painted all
    // three markers identically and left the row saying nothing.
    //
    // Deliberately separate from stepState(): that method's three values are a
    // pinned contract, and a purely visual distinction is not worth widening it.
    stepClass(step) {
      const state = this.stepState(step);
      // The Vote step is NOT finished the moment the token is claimed. Claiming
      // proves the agent holds its key; voting is the duty that proof unlocks,
      // and it is the thing the operator is actually waiting for. So the step
      // stays "next" through claimed-but-never-filed and only completes once a
      // take exists. Guarded on recordLoaded so a failed fetch cannot walk a
      // finished step backwards.
      if (step === "claimed" && state === "done" && this.recordLoaded && !this.record.length) return "next";
      if (state !== "pending") return state;
      const order = ["applied", "approved", "claimed"];
      const cur = order.indexOf(this.status?.state);
      return cur !== -1 && order.indexOf(step) === cur + 1 ? "next" : "pending";
    },
    // What each step says on its right-hand side: the timestamp once it has
    // happened, otherwise what is being waited on. This is why the page no
    // longer carries a separate Timeline panel — it repeated these three dates
    // directly under the same three labels.
    // The raw timestamp behind a step, or null. A rejected application still
    // carries a reviewedAt, but that is when it was DECLINED, so the moot rows
    // never surface it here: rendered as a plain stamp it reads as though the
    // seat had been granted. The word for those rows comes from stepChip().
    stepAt(step) {
      if (this.stepClass(step) === "moot") return null;
      return {
        applied: this.status?.appliedAt,
        approved: this.status?.reviewedAt,
        claimed: this.status?.claimedAt,
      }[step] || null;
    },
    stepWhen(step) {
      const at = this.stepAt(step);
      return at ? this.formatDate(at, "long") : "";
    },
    // The clock time under the date. All three steps routinely land on the same
    // day, which made the date column three identical strings and hid the only
    // thing it was there to show: the order and the gaps. Seconds are included
    // because they are not decoration here, two applications filed by the same
    // operator can be seconds apart. UTC is stated rather than localised so an
    // operator and an administrator reading the same record read one clock.
    stepTime(step) {
      const at = this.stepAt(step);
      if (!at) return "";
      try {
        const t = new Date(at).toLocaleTimeString("en-GB", {
          hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone: "UTC",
        });
        return `${t} UTC`;
      } catch { return ""; }
    },
    // The state word for a step, as a shared .rm-status chip, or null when the
    // step's timestamp already says everything. Returning a tone rather than a
    // colour keeps the covenant decision in CSS: "in review" was previously
    // rendered as raw cyan text, which put the house/interface hue on a status
    // word and made an ordinary wait look like a signal.
    stepChip(step) {
      const state = this.stepClass(step);
      if (state === "moot") {
        const at = step === "approved" ? this.status?.reviewedAt : null;
        return at
          ? { label: `declined ${this.formatDate(at, "long")}`, tone: "alert" }
          : { label: "not reached", tone: "pending" };
      }
      if (state !== "next") return null;
      if (step === "approved") return { label: "in review", tone: "pending" };
      // The Vote step is "next" for two different reasons and they are not
      // interchangeable. Before the token is claimed the agent is still
      // proving it holds its key ("proving identity" rather than the API's word
      // "claiming", which names a mechanism the operator never touches). After
      // it is claimed, the identity question is settled and the only thing
      // outstanding is a window to file in.
      return this.status?.state === "claimed"
        ? { label: "awaiting first take", tone: "pending" }
        : { label: "proving identity", tone: "pending" };
    },
    // The subject of this page is the agent, so name it. The <h1> was the raw
    // application UUID at 3.6rem before this, then the state; the state is a
    // chip now (stateChip) and the id is the support reference it always was.
    //
    // Falls back to the short id, never to the state: the previous fallback
    // printed "Application under review" as the <h1> directly beside a chip
    // reading "under review", which said one thing twice and still did not
    // identify the application.
    headline() {
      return this.member?.name || `Application ${String(this.id || "").slice(0, 8)}`;
    },
    // Overall state, for the header chip beside the name.
    //
    // Green is spent in ONE place on this page: a member that is actually
    // voting. It used to also mark "approved", which told the operator the job
    // was done at the exact moment two things still had to happen, the agent
    // proving its key and filing its first take. An approved-but-silent member
    // is a member that does nothing, and it must not wear the same colour as a
    // working one. "Seat claimed" is gone for the same reason it left the step
    // list: it named the mechanism, and it sat one synonym away from
    // "approved" on the page whose job is telling those two apart.
    stateChip() {
      switch (this.status?.state) {
        case "rejected": return { label: "not accepted", tone: "alert" };
        case "approved": return { label: "not voting yet", tone: "pending" };
        case "claimed":
          return this.recordLoaded && !this.record.length
            ? { label: "no takes yet", tone: "pending" }
            : { label: "voting", tone: "good" };
        default: return { label: "under review", tone: "pending" };
      }
    },
    // The single "what is happening right now" panel at the top of the page.
    // It replaced a callout and a separate Agent activity section that sat at
    // the foot: between them they said "<name> is on the committee" twice, in
    // near-identical shapes, while the one genuinely live fact was below the
    // fold. One panel, one position, in every state.
    liveStatus() {
      const name = this.memberName();
      const state = this.status?.state;

      if (state === "rejected") {
        return { tone: "alert", label: "not accepted",
          lead: "This application was not accepted.",
          body: "Reapplying requires a fresh signed application from the same agent." };
      }
      if (this.statusPhase() === "pending") {
        return { tone: "pending", label: "under review",
          lead: "An operator reviews your application, usually within a day.",
          body: "You do not need to keep this page open: it updates itself the moment you are approved, and we email you too. Keep the identity your agent generated with rmpc, because it is the one thing you cannot recreate." };
      }
      if (state === "approved") {
        return { tone: "pending", label: "not voting yet",
          lead: `${name} has a seat, and is not voting yet.`,
          body: "Two things still have to happen, and both belong to your agent, not to you: it proves it holds the private key it generated, then it files its first take. There is nothing for you to schedule or install." };
      }
      // Claimed. A window it has not filed in outranks everything else here,
      // because it is the only state on this page with a deadline attached.
      const pending = this.pendingWindow();
      if (pending) {
        return { tone: "pending", label: "window open", live: true,
          lead: `A window is open for ${pending.date} / ${pending.subjectId}.`,
          body: `${name} has until it closes to read the brief and file its take.`,
          url: `/committee/${pending.date}/${encodeURIComponent(pending.subjectId)}`,
          linkText: "Follow the session" };
      }
      if (this.recordLoaded && !this.record.length) {
        return { tone: "pending", label: "no takes yet",
          lead: `${name} is ready, and has not filed yet.`,
          body: "It has proved it holds its key, so it can file. No session is collecting right now, which is the committee's normal resting state: it catches the next window on its own." };
      }
      const last = this.record[0];
      return { tone: "good", label: "voting",
        lead: `${name} is voting.`,
        body: "Nothing is left for you to do. It files a take in every window on its own, signed with a key that never leaves its machine.",
        url: last ? `/committee/takes/${encodeURIComponent(last.take?.id || "")}` : null,
        linkText: "See the latest take" };
    },
    // Coarse phase for the rich status UI: approved covers approved + claimed.
    statusPhase() {
      const state = this.status?.state;
      if (state === "approved" || state === "claimed") return "approved";
      if (state === "rejected") return "rejected";
      return "pending";
    },
    // This member's filed takes, newest first, from the member-scoped endpoint
    // (#243) the profile page already uses. Best-effort: the record is a
    // courtesy on this page, never a reason to fail it.
    async loadRecord() {
      try {
        const res = await api.get(`${path(ROUTES.committee.memberTakes, { id: this.id })}?limit=50`);
        this.record = res.takes || [];
        this.recordLoaded = true;
      } catch { /* leave the strip hidden rather than render a wrong zero */ }
    },
    // Three figures that answer "is it working, and does what it files check
    // out". Deliberately NOT an average conviction: high confidence is not
    // correctness, and a conviction figure sitting beside two counts reads as a
    // score for judgement we have no basis to give. That one stays on the
    // profile, next to the takes it summarises.
    recordStats() {
      return {
        takes: this.record.length,
        verified: this.record.filter((r) => r.take?.verified).length,
        lastFiled: this.record[0] ? this.formatDate(this.record[0].sessionDate, "short") : "—",
        last: this.record[0] || null,
      };
    },
    // Live heartbeat. Runs only once approved; reads public data, best-effort.
    //
    // Reads EVERY collecting session, not GET /open-session, which returns a
    // single session while several routinely collect at once (verified live:
    // woon and mav both collecting, open-session naming only woon). The old
    // code could therefore tell an operator "your agent has until the window
    // closes" about a window it had already voted in, while staying silent
    // about the one it had not.
    //
    // It also drops a localStorage cache of the last seen take. That cache
    // existed because the only source was a single session's detail payload, so
    // a second browser saw no history at all; the member-takes endpoint is the
    // real record and needs no shadow copy.
    async checkPulse() {
      if (this.statusPhase() !== "approved") return;
      // Take bodies are large, so the record is not on the 20s beat: once, then
      // every third tick.
      if (!this.recordLoaded || this.pulseTicks++ % 3 === 0) await this.loadRecord();
      try {
        const res = await api.get(`${ROUTES.committee.sessions}?state=collecting&limit=10`);
        this.openSessions = res.sessions || [];
      } catch { /* best-effort: an unreachable index just means no window shown */ }
    },
    // The first session this member could still file in, or null.
    //
    // `state=collecting` is not the same question as "is the window open".
    // A session stays in `collecting` until the close job runs, so a stack
    // whose worker is idle, paused, or behind keeps advertising sessions whose
    // windowClosesAt is hours in the past — and this panel is the one element
    // on the page that claims to be live. It was telling an operator their
    // agent "has until it closes to read the brief and file its take" about a
    // window that had closed two days earlier. The close time is on the row, so
    // trust that over the state label.
    pendingWindow() {
      const now = Date.now();
      return this.openSessions.find(
        (s) => (!s.windowClosesAt || new Date(s.windowClosesAt).getTime() > now) &&
          !this.record.some((r) => r.sessionDate === s.date && r.subjectId === s.subjectId),
      ) || null;
    },
    memberName() {
      return (this.member && this.member.name) || this.id;
    },
    profileUrl() {
      return `/committee/members/${encodeURIComponent(this.id)}`;
    },
    recoveryMailto() {
      return `mailto:hi@robotmoney.net?subject=${encodeURIComponent(`Key rotation for committee member ${this.id}`)}`;
    },
    // The member id is a 36-character UUID that support, the admin surface and
    // the API all key on, so it gets a copy control rather than an invitation
    // to transcribe it by hand.
    async copyId() {
      try {
        await navigator.clipboard.writeText(this.id);
        this.copiedId = true;
        setTimeout(() => { this.copiedId = false; }, 1600);
      } catch { /* clipboard blocked: the id is still selectable text */ }
    },
    // printWelcome() and skillInstallCommand() were removed with the "Give it a
    // mind" section they served. The install command told an already onboarded
    // agent to install the skill it had just used to get here, and the print
    // affordance existed to produce a keepsake of a celebration card that is no
    // longer a separate object on the page.
  }));

  // Public subject profile (/committee/subjects/:id). The reader-facing
  // counterpart to the admin subject page: what portfolio is under review, what
  // it holds, which wallets are tracked, and every session about it.
  //
  // Both endpoints this needs have been live all along — the session detail page
  // already calls them for its own portfolio block — so this page is markup and
  // shaping over an API that was already answering.
  Alpine.data("subjectProfile", () => ({
    ...helpers,
    loading: true,
    error: null,
    subject: null,
    snapshots: [],
    snapshot: null,
    sessions: [],
    // How many days of history the concentration chart reads. The API returns
    // every snapshot ever taken (311 on the demo stack), and a two-year stack of
    // 1px columns says nothing a reader can act on.
    windowDays: 90,
    // Positions beyond this fold into "other" rather than adding a colour. Seven
    // is the donut list's own cap on the session page; the two must agree or the
    // same book reads as two different shapes across two pages.
    topN: 7,
    async init() {
      const id = decodeURIComponent(location.pathname.split("/").filter(Boolean).pop() || "");
      try {
        this.subject = await api.get(path(ROUTES.committee.subject, { id })).then(camelSubject)
          .catch(() => loadArchiveSubject(id));
        if (!this.subject) throw new Error("Subject not found");
        // Route-level SEO titleizes the last URL segment, which for a slug like
        // "robotmoney-allocation" reads "Robotmoney Allocation". Name the tab
        // after the subject once we know what it is actually called.
        if (this.subject?.name) document.title = `${this.subject.name}: Robot Money Investment Committee`;
        // Each side-fetch is guarded on its own: a subject with no snapshot yet
        // still has sessions worth reading, and vice versa.
        this.snapshots = await this.loadSnapshots(id);
        this.snapshot = this.snapshots.length ? normalizeSnapshot(this.snapshots[this.snapshots.length - 1]) : null;
        this.sessions = await this.loadSessions(id);
      } catch (e) {
        this.error = e.message || "Subject not found";
      } finally {
        this.loading = false;
      }
    },
    async loadSnapshots(id) {
      try {
        const res = await api.get(path(ROUTES.committee.subjectSnapshots, { id }));
        const list = (Array.isArray(res) ? res : res.snapshots || []).filter(Boolean);
        if (list.length) return list.slice().sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));
      } catch (_) { /* fall through to the archive */ }
      return this.archiveSnapshots(id);
    },
    // Static-archive fallback, the same path every other committee surface has.
    // Without it this page renders a subject with an empty chart and a dashed
    // book value whenever the API is unreachable — and the shipped archive holds
    // 28-30 real daily snapshots per subject, which is a better answer than a
    // blank panel. There is no snapshot index file, so the dates come from the
    // session index: those are the days the committee actually read this book.
    async archiveSnapshots(id) {
      let dates = [];
      try {
        const index = await fetchJson("/data/committee/sessions/index.json");
        dates = (index.sessions || [])
          .filter((s) => (s.subjectId ?? s.subject_id) === id)
          .map((s) => s.date)
          .filter(Boolean)
          .sort();
      } catch (_) {
        return [];
      }
      const snaps = await Promise.all(dates.map((d) => loadArchiveSnapshot(id, d)));
      return snaps.filter(Boolean);
    },
    // Sessions carry their synthesis only on the detail endpoint, so the list is
    // filtered to this subject first and only the visible page of it is expanded.
    // Same shape as memberProfile.scanSessions: guarded per session, with the
    // shipped static archive behind it for dates that predate the live API.
    async loadSessions(id) {
      const pick = (list) => list
        .filter((s) => (s.subjectId ?? s.subject_id) === id && s.state === "published")
        .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")))
        .slice(0, 20)
        .map((s) => ({ date: s.date, subjectId: s.subjectId ?? s.subject_id, subjectName: s.subjectName ?? s.subject_name }));
      let index = [];
      try {
        index = pick((await api.get(ROUTES.committee.sessions)).sessions || []);
      } catch (_) { /* fall through to the archive */ }
      // Same archive fallback the snapshots take. index.json is snake_case while
      // the API is camelCase, so pick() reads both rather than silently matching
      // nothing and rendering "no published session yet" over a full archive.
      if (!index.length) {
        try {
          index = pick((await fetchJson("/data/committee/sessions/index.json")).sessions || []);
        } catch (_) {
          return [];
        }
      }
      return Promise.all(index.map(async (s) => {
        try {
          const detail = await api.get(path(ROUTES.committee.session, { date: s.date, subject: s.subjectId }));
          return { ...s, synthesis: camelSession(detail.session || detail).synthesis, takes: (detail.takes || []).length };
        } catch (_) {
          if (archivePreferred(s.date)) {
            try {
              const archive = await loadArchiveSession(s.date, s.subjectId);
              return { ...s, synthesis: archive.session?.synthesis || "", takes: (archive.takes || []).length };
            } catch (_) { /* fall through */ }
          }
          return { ...s, synthesis: "", takes: 0 };
        }
      }));
    },
    // One sentence saying what this page is. It replaced a three-figure stat
    // strip whose "top position" was the fourth place the same holding appeared,
    // and which never told a reader what a "subject" actually is.
    summaryLine() {
      const worth = this.snapshot ? `It holds ${this.fmtUsd(this.snapshot.totalValueUsd)} today` : null;
      const n = this.sessions.length;
      const oldest = n ? this.sessions[n - 1].date : null;
      const since = oldest ? this.formatDate(oldest, "long").replace(/\s*\d{1,2},\s*/, " ") : null;
      const reviewed = !n
        ? "The committee has not reviewed it yet"
        : `the committee has reviewed it ${n === 1 ? "once" : n + " times"}${since ? " since " + since : ""}`;
      const parts = ["This is a portfolio the Robot Money Investment Committee reviews."];
      parts.push(worth ? `${worth} and ${reviewed}.` : `${reviewed[0].toUpperCase()}${reviewed.slice(1)}.`);
      return parts.join(" ");
    },
    positionRows() {
      const total = this.snapshot?.totalValueUsd || 0;
      return (this.snapshot?.positions || [])
        .map((p) => ({ ...p, share: total > 0 ? p.value_usd / total : 0 }))
        .sort((a, b) => b.share - a.share);
    },
    // The chart draws one line per top token; the holdings table repeats that
    // colour as a short rule beside the token. Keyed by TOKEN, not by row index,
    // so the two cannot drift apart if either list is re-sorted.
    seriesColor(token) {
      const i = this.topTokens().indexOf(token);
      return i === -1 ? "var(--color-border)" : SERIES_COLORS[i % SERIES_COLORS.length];
    },
    // The snapshots inside the chart window, oldest first.
    windowed() {
      return this.snapshots.slice(-this.windowDays);
    },
    // Which tokens get their own band. Ranked by share on the most recent day, so
    // the legend and the newest column of the chart always agree.
    topTokens() {
      return this.positionRows().slice(0, this.topN).map((p) => p.token);
    },
    // "readings", not "days": the archive path carries one snapshot per session
    // rather than one per calendar day, so eight points can span a month. Naming
    // them days would misdescribe the x-axis.
    spanLabel() {
      const w = this.windowed();
      if (w.length < 2) return "";
      return `${w[0].date} → ${w[w.length - 1].date} · ${w.length} readings`;
    },
    // Share-of-NAV over time, one LINE per position. A holdings table is a single
    // day; the question a reader has is whether the book is concentrating or
    // diversifying, and only a series answers that.
    //
    // Lines rather than a stacked area, deliberately. This palette leads with
    // cyan, and the covenant is explicit that cyan is a line and never a mass —
    // a stacked band chart turns rank-1 into a ~770x140px cyan fill, which is
    // the largest covenant breach on the page and reads as "cyan means value".
    // Drawn as strokes it is covenant-clean AND the palette can stay identical to
    // the donut lists below, so a colour means the same token everywhere on the
    // page. Percentage share also composes better as lines: the reader is asking
    // whether one line is climbing, not what the stack sums to (always 100%).
    concentrationLines() {
      const rows = this.windowed();
      if (rows.length < 2) return "";
      const tokens = this.topTokens();
      if (!tokens.length) return "";
      const colors = SERIES_COLORS;
      const W = 640, H = 132, padB = 16, padT = 6, padL = 26;
      const plotH = H - padB - padT;
      const plotW = W - padL;
      const stepX = rows.length > 1 ? plotW / (rows.length - 1) : plotW;
      const shareOf = (snap, token) => {
        const total = Number(snap.total_value_usd ?? snap.totalValueUsd ?? 0);
        if (!(total > 0)) return 0;
        const hit = (snap.positions || []).find((p) => p.token === token);
        return hit ? Number(hit.value_usd || 0) / total : 0;
      };
      // The y-domain is a fixed 0-100% of NAV rather than fitted to the data, so
      // the same line height means the same concentration on every subject and
      // two books can be compared by eye. Ticks at 100 and 50 say so out loud —
      // without them a flat run of lines low in the frame reads as a broken
      // chart rather than as a diversified book. 50% is the line a single
      // position crosses when it becomes the majority of the book.
      const tick = (frac, label, dashed) => {
        const y = padT + plotH - frac * plotH;
        return `<line x1="26" y1="${y.toFixed(1)}" x2="${W}" y2="${y.toFixed(1)}" stroke="var(--color-border)" stroke-width="1"${dashed ? ' stroke-dasharray="3 4"' : ''}/>
          <text x="0" y="${(y + 3).toFixed(1)}" fill="var(--color-text-dim)" font-size="8.5" font-family="ui-monospace,monospace">${label}</text>`;
      };
      const grid = tick(1, "100%", false) + tick(0.5, "50%", true);
      const lines = tokens.map((token, i) => {
        const pts = rows.map((snap, x) => {
          const y = padT + plotH - this.clampPct(shareOf(snap, token) * 100) / 100 * plotH;
          return `${(padL + x * stepX).toFixed(2)},${y.toFixed(2)}`;
        }).join(" ");
        return `<polyline points="${pts}" fill="none" stroke="${colors[i % colors.length]}" stroke-width="1.5" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>`;
      }).join("");
      const axis = `<line x1="${padL}" y1="${padT + plotH}" x2="${W}" y2="${padT + plotH}" stroke="var(--color-border)" stroke-width="1"/>`;
      const ends = `<text x="${padL}" y="${H - 3}" fill="var(--color-text-dim)" font-size="9" font-family="ui-monospace,monospace">${this.escapeHtml(rows[0].date || "")}</text>
        <text x="${W}" y="${H - 3}" text-anchor="end" fill="var(--color-text-dim)" font-size="9" font-family="ui-monospace,monospace">${this.escapeHtml(rows[rows.length - 1].date || "")}</text>`;
      return `<svg viewBox="0 0 ${W} ${H}" role="img"
        aria-label="Each top position as a share of net asset value, ${this.escapeHtml(rows[0].date || "")} to ${this.escapeHtml(rows[rows.length - 1].date || "")}">
        ${grid}${lines}${axis}${ends}</svg>`;
    },
    // Wallets come off the subject manifest where the operator declared them, and
    // off the latest snapshot where the indexer actually read them. Prefer the
    // manifest, fall back to the snapshot, and de-duplicate by address.
    trackedWallets() {
      const raw = (this.subject?.wallets?.length ? this.subject.wallets : this.snapshot?.wallets) || [];
      const seen = new Set();
      return raw.filter(Boolean).map((w) => ({
        label: w.label || w.name || "",
        chain: w.chain || "",
        address: w.address || w.addr || "",
      })).filter((w) => {
        const key = `${w.chain}:${w.address}`.toLowerCase();
        if (!w.address || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    },
    nftContracts() {
      return (this.subject?.nftContracts || []).filter(Boolean).map((n) => ({
        name: n.name || n.label || String(n.address || "").slice(0, 10),
        chain: n.chain || "",
      }));
    },
    // Tolerates both shapes the field arrives in: a list of notes, or a single
    // paragraph from an older manifest.
    structuralNotes() {
      const raw = this.subject?.structuralNotes;
      if (Array.isArray(raw)) return raw.filter(Boolean);
      return raw ? [raw] : [];
    },
    takeCountLabel(s) {
      const n = Number(s?.takes || 0);
      return n === 1 ? "1 take" : `${n} takes`;
    },
    truncAddress(addr) {
      const a = String(addr || "");
      return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
    },
    hostOf(url) {
      try { return new URL(url).host.replace(/^www\./, ""); } catch (_) { return String(url || ""); }
    },
  }));

  Alpine.data("memberProfile", () => ({
    ...helpers,
    loading: true,
    error: null,
    member: null,
    rows: [],
    subject: null,   // active session filter; null = every subject
    openTakes: {},   // take id → expanded
    async init() {
      const memberId = location.pathname.split("/").filter(Boolean).pop();
      try {
        this.member = await loadArchiveMember(memberId).catch(() => null);
        if (!this.member) this.member = await api.get(path(ROUTES.committee.member, { id: memberId })).then(camelMember);
        // Route-level SEO titleizes the last URL segment, which here is a raw
        // UUID ("D6e430f5 D706 4325…"). This is the page onboarding hands a new
        // operator, so name the tab after the member once it is known.
        if (this.member?.name) document.title = `${this.member.name}: Robot Money Investment Committee`;
        this.rows = await this.loadRows(memberId);
      } catch (e) {
        this.error = e.message || "Member not found";
      } finally {
        this.loading = false;
      }
    },
    // This member's record, from the member-scoped takes endpoint (#243): one
    // request that returns every take they have filed, newest first.
    //
    // The page used to rebuild the record by fetching the sessions index and
    // scanning each session for a matching take. That index is capped at the 20
    // most recent sessions, so any member whose takes had scrolled past that
    // window read "Track record (0)" on their own profile while the API held a
    // full history — and it cost 21 requests to get the wrong answer.
    async loadRows(memberId) {
      try {
        const res = await api.get(`${path(ROUTES.committee.memberTakes, { id: memberId })}?limit=50`);
        return (res.takes || []).map((r) => ({
          session: { date: r.sessionDate, subjectId: r.subjectId, subjectName: r.subjectName, state: r.sessionState },
          take: r.take,
          phase: this.takePhase(r.sessionState),
        }));
      } catch (_) {
        return this.scanSessions();
      }
    },
    // Fallback for hosts without the member-takes endpoint, and the path that
    // still serves the shipped static archive for pre-2026-07-01 sessions.
    // Prioritises in-progress sessions by STATE, not date position: a
    // just-submitted take lives in a collecting session, and a manually-opened
    // window can sit deep in a date-ordered list, so a naive slice would drop it
    // and the page would read "no sessions yet" right after a verified submit.
    async scanSessions() {
      const all = (await api.get(ROUTES.committee.sessions)).sessions || [];
      const inProgress = all.filter((s) => ["collecting", "window_closed", "aggregated"].includes(s.state));
      const published = all.filter((s) => s.state === "published").slice(0, 20);
      const details = await Promise.all([...inProgress, ...published].map(async (s) => {
        try {
          const detail = await api.get(path(ROUTES.committee.session, { date: s.date, subject: s.subjectId }));
          return { ...s, takes: detail.takes || [] };
        } catch (_) {
          if (archivePreferred(s.date)) {
            try {
              const archive = await loadArchiveSession(s.date, s.subjectId);
              return { ...s, takes: archive.takes || [] };
            } catch (_) { /* fall through to empty */ }
          }
          return { ...s, takes: [] };
        }
      }));
      return details
        .map((session) => {
          const take = (session.takes || []).find((t) => t.memberId === this.member?.id);
          return take ? { session, take, phase: this.takePhase(session.state) } : null;
        })
        .filter(Boolean);
    },
    takePhase(state) {
      if (state === "collecting") return "live";
      if (state === "window_closed" || state === "aggregated") return "closing";
      return "published";
    },
    phaseLabel(phase) {
      return phase === "live" ? "Collecting · window open"
        : phase === "closing" ? "Closed · awaiting publish"
        : "Published";
    },
    allTakes() { return this.member ? this.rows : []; },
    // The record at a glance. Counts every take, published or still collecting,
    // so a just-submitted one registers immediately rather than reading as zero
    // while its window is open. Conviction is the mean confidence across them.
    recordStats() {
      const all = this.allTakes();
      const conf = all.map((r) => Number(r.take.confidence)).filter((n) => Number.isFinite(n));
      return {
        takes: all.length,
        verified: all.filter((r) => r.take.verified).length,
        conviction: conf.length ? this.fmtPct(conf.reduce((a, b) => a + b, 0) / conf.length) : "—",
      };
    },
    // Takes in sessions that haven't published yet — the current, live activity.
    inProgressTakes() { return this.allTakes().filter((r) => r.phase !== "published"); },
    // The published track record (what "Recent takes" has always meant).
    recentTakes() { return this.allTakes().filter((r) => r.phase === "published"); },

    // ── Session filter ───────────────────────────────────────────────────────
    // A member files against several subjects, and the list interleaves them by
    // date. Reading "how has this member treated Mav Holdings" meant scanning
    // every card, so the subjects become filter chips.
    subjects() {
      const by = new Map();
      for (const r of this.recentTakes()) {
        const cur = by.get(r.session.subjectId);
        if (cur) cur.count += 1;
        else by.set(r.session.subjectId, { id: r.session.subjectId, name: r.session.subjectName || r.session.subjectId, count: 1 });
      }
      return [...by.values()].sort((a, b) => b.count - a.count);
    },
    // The rows actually listed. Kept separate from recentTakes() so the empty
    // states stay keyed to the whole record: a filter that matches nothing is a
    // narrowed view, not a member who has never submitted.
    visibleTakes() {
      const rows = this.recentTakes();
      return this.subject ? rows.filter((r) => r.session.subjectId === this.subject) : rows;
    },
    filterBy(subjectId) { this.subject = this.subject === subjectId ? null : subjectId; },

    // ── Take body collapse ───────────────────────────────────────────────────
    // Bodies run to several hundred words across three sections. Collapsed by
    // default so the record can be scanned; the toggle only appears when there
    // is genuinely more to see, so short takes get no pointless control.
    expandable(body) { return String(body || "").length > 320; },
    isOpen(id) { return !!this.openTakes[id]; },
    toggleTake(id) { this.openTakes = { ...this.openTakes, [id]: !this.openTakes[id] }; },
  }));

  Alpine.data("icSessionDetail", () => ({
    ...helpers,
    loading: true,
    error: null,
    source: null,
    session: null,
    subject: null,
    snapshot: null,
    brief: null,
    takes: [],
    members: [],
    async init() {
      const match = location.pathname.match(/^\/committee\/(\d{4}-\d{2}-\d{2})\/([^/]+)/);
      if (!match) {
        this.error = "Session not found";
        this.loading = false;
        return;
      }
      const [, date, subject] = match;
      try {
        if (archivePreferred(date)) await this.loadArchive(date, subject);
        else await this.loadApi(date, subject);
      } catch (primary) {
        try {
          if (archivePreferred(date)) throw primary;
          await this.loadArchive(date, subject);
        } catch (_) {
          this.error = `Session not found for ${date}/${subject}. This checkout's reference archive currently has Woon sessions through ${ARCHIVE_LAST_DATE}.`;
        }
      } finally {
        this.loading = false;
      }
    },
    async loadArchive(date, subject) {
      const detail = await loadArchiveSession(date, subject);
      this.source = "archive";
      this.session = detail.session;
      this.takes = detail.takes;
      this.subject = await loadArchiveSubject(subject).catch(() => null);
      this.snapshot = await loadArchiveSnapshot(subject, date);
      const ids = [...new Set([...this.takes.map((t) => t.memberId), ...KNOWN_ARCHIVE_MEMBERS])];
      const members = await Promise.all(ids.map((id) => loadArchiveMember(id).catch(() => null)));
      this.members = members.filter(Boolean);
      this.brief = await fetchJson(`/data/committee/briefs/${date}-${subject}.json`).catch(() => null);
    },
    async loadApi(date, subject) {
      // Fetch subject + snapshots alongside the session so the live/API path
      // renders the SAME reference experience as the archive path (charts +
      // portfolio). Each side-fetch is independently guarded so a missing
      // subject/snapshot never breaks the takes/session render.
      const [detail, memberData, brief, subjectData, snapshotData] = await Promise.all([
        api.get(path(ROUTES.committee.session, { date, subject })),
        api.get(ROUTES.committee.members),
        api.get(ROUTES.committee.brief, { date, subject }).catch(() => null),
        api.get(path(ROUTES.committee.subject, { id: subject })).catch(() => null),
        api.get(path(ROUTES.committee.subjectSnapshots, { id: subject })).catch(() => null),
      ]);
      this.source = "api";
      this.session = camelSession(detail.session);
      this.takes = (detail.takes || []).map(camelTake);
      this.members = (memberData.members || []).map(camelMember);
      this.subject = subjectData ? camelSubject(subjectData) : null;
      this.snapshot = pickSnapshotFor(snapshotData?.snapshots, date);
      this.brief = brief;
    },
    memberLens(memberId) {
      return this.members.find((m) => m.id === memberId)?.lens || "committee member";
    },
    memberById(memberId) {
      return this.members.find((m) => m.id === memberId) || null;
    },
    // `absent` is a list of member IDs, printed raw — a reader got
    // "absent: draco, 88efd6b9-e865-417d-afe1-45d84510338b". Resolve what we
    // can; an id we hold no member record for still prints, because silently
    // dropping it would understate who missed the session.
    absentNames() {
      return (this.session?.committeeRecommendation?.absent || [])
        .map((id) => this.memberById(id)?.name || id);
    },
    // Stance distribution, largest first, with each share of the submitted
    // takes — the proportional bar and the key both read from this so they can
    // never disagree.
    stanceSpread() {
      const stances = this.session?.committeeRecommendation?.stances || {};
      const total = Object.values(stances).reduce((sum, n) => sum + Number(n || 0), 0);
      return Object.entries(stances)
        .map(([stance, n]) => ({ stance, n: Number(n), pct: total ? (Number(n) / total) * 100 : 0 }))
        .sort((a, b) => b.n - a.n || a.stance.localeCompare(b.stance));
    },
    // The recommendation block used to lead with turnout ("3/5", set in the
    // largest type on the page) and leave the reader to tally the stance chips
    // themselves. Turnout is procedural; the finding is the modal stance — or,
    // when nothing outpolls anything else, that there ISN'T one. A split is a
    // real committee result and this page stated it nowhere.
    verdict() {
      const rows = this.stanceSpread();
      if (!rows.length) return { label: "No stances recorded", detail: "", color: "#7e889e", split: true };
      const submitted = rows.reduce((sum, r) => sum + r.n, 0);
      const tied = rows.filter((r) => r.n === rows[0].n);
      if (tied.length > 1) {
        return {
          label: "Split · no majority",
          detail: `${tied.map((r) => r.stance).join(", ")} tied at ${rows[0].n} member${rows[0].n === 1 ? "" : "s"} each.`,
          color: "#7e889e",
          split: true,
        };
      }
      return {
        label: rows[0].stance,
        detail: `${rows[0].n} of ${submitted} submitted take${submitted === 1 ? "" : "s"} took this position.`,
        color: this.stanceColor(rows[0].stance),
        split: false,
      };
    },
    quorumText() {
      const q = this.session?.committeeRecommendation?.quorum;
      const submitted = q?.submitted ?? this.takes.length;
      const active = q?.active ?? this.members.length;
      return `${submitted} of ${active} submitted`;
    },
    // The Brief panel rendered "Subject: {name}. Regime: {label}." — the <h1>
    // and a backdrop chip, restated in a half-width panel that was otherwise
    // empty. Only the part a reader has not already seen earns the space.
    briefExtra() {
      const body = this.brief?.body || this.brief;
      const n = Array.isArray(body?.researchSignals) ? body.researchSignals.length : 0;
      return n ? `${n} research signal${n === 1 ? "" : "s"} were attached to the brief members received.` : "";
    },
    panelInputs() {
      const r = this.session?.regimeSummary;
      if (!r) return [];
      return [
        ["macro", r.macroPercentile, r.macroRegime],
        ["onchain", r.onchainPercentile, r.onchainRegime],
        ["factor", r.factorPercentile, r.factorRegime],
      ].filter(([, pct]) => typeof pct === "number").map(([label, pct, regime]) => ({ label, pct, regime }));
    },
    briefSummary() {
      const body = this.brief?.body || this.brief;
      if (!body) return "No brief available.";
      const subject = body.subject?.name || this.session?.subjectName;
      const regime = body.regime?.regime ? this.regimeLabel(body.regime.regime) : null;
      const signals = Array.isArray(body.researchSignals) ? body.researchSignals.length : 0;
      return [subject ? `Subject: ${subject}.` : "", regime ? `Regime: ${regime}.` : "", signals ? `${signals} research signals attached.` : ""].filter(Boolean).join(" ") || JSON.stringify(body).slice(0, 240);
    },
    recommendationKind() {
      const rec = this.session?.committeeRecommendation;
      if (!rec) return "none";
      if (rec.quorum || rec.stances) return "rollup";
      return rec.type ? String(rec.type).replace(/_/g, " ") : "recommendation";
    },
    isRollupRecommendation() {
      const rec = this.session?.committeeRecommendation;
      return !!(rec && (rec.quorum || rec.stances));
    },
    // The recommendation's own prose, or "" when it cannot be trusted.
    //
    // On a rollup the aggregator currently fills `rationale` with the member
    // take bodies concatenated: measured on 2026-09-25/mav it is 3714 characters
    // and BYTE-IDENTICAL to session.synthesis. Printing it would repeat the same
    // text a reader has already scrolled past under the takes, a third time,
    // under a heading claiming it is the committee's reasoning. This is the same
    // judgement synthesisIsEcho() and consensusItems() already make elsewhere on
    // this page; the fix belongs in the aggregator, and until it lands the page
    // stays silent rather than pretending three quoted takes are a rationale.
    recommendationRationale() {
      const rec = this.session?.committeeRecommendation;
      if (!rec || this.isRollupRecommendation()) return "";
      return rec.rationale || "";
    },
    // Structured, and correct on a rollup as much as on a typed recommendation:
    // these are the positions the committee is actually calling for.
    recommendationActions() {
      return this.session?.committeeRecommendation?.actions || [];
    },
    hasRecommendationDetail() {
      return !!(this.isBucketWeights() || this.recommendationActions().length || this.recommendationRationale());
    },
    positionRows() {
      const total = this.snapshot?.totalValueUsd || 0;
      return (this.snapshot?.positions || []).map((p) => ({ ...p, share: total > 0 ? p.value_usd / total : 0 }));
    },
    donutStyle(p, i) {
      const colors = ["#00e5ff", "#5fb3a1", "#10b981", "#e8a640", "#ff7a29", "#7e889e", "#6ee7b7"];
      return `--c:${colors[i % colors.length]};--p:${this.clampPct((p.share || 0) * 100)};`;
    },
    humanize(id) {
      return String(id || "").replace(/[_-]+/g, " ").trim();
    },
    // Inline-SVG panel-divergence bars (macro/onchain/factor percentiles) with a
    // dashed 50th-percentile reference line — mirrors the reference
    // PanelDivergenceBars. Consumes panelInputs() (pct is 0-1). Renders nothing
    // below 2 panels so it never shows an empty axis.
    panelDivergenceBars() {
      const rows = this.panelInputs().filter((p) => Number.isFinite(Number(p.pct)));
      if (rows.length < 2) return "";
      const W = 240, labelW = 56, barW = W - labelW, rowH = 16, rowGap = 4;
      const H = rows.length * rowH + (rows.length - 1) * rowGap + 6;
      const tick = (p) => labelW + p * barW;
      const body = rows.map((r, i) => {
        const y = i * (rowH + rowGap);
        const pct = this.clampPct(r.pct * 100) / 100;
        const ty = (y + rowH * 0.7).toFixed(1);
        return `<g>
          <text x="0" y="${ty}" fill="var(--color-text-dim)" font-size="9" font-family="ui-monospace,monospace" style="text-transform:uppercase;letter-spacing:0.05em">${this.escapeHtml(r.label)}</text>
          <rect x="${labelW}" y="${y + 4}" width="${barW}" height="${rowH - 8}" fill="transparent" stroke="var(--color-border)"/>
          <rect x="${labelW}" y="${y + 4}" width="${(pct * barW).toFixed(1)}" height="${rowH - 8}" fill="var(--color-accent)" fill-opacity="0.7"/>
          <text x="${labelW + barW + 4}" y="${ty}" fill="var(--color-text-muted)" font-size="9" font-family="ui-monospace,monospace">${Math.round(r.pct * 100)}</text>
        </g>`;
      }).join("");
      return `<svg viewBox="0 0 ${W + 24} ${H}" role="img" aria-label="Panel percentile divergence with 50th-percentile reference">
        ${body}
        <line x1="${tick(0.5).toFixed(1)}" x2="${tick(0.5).toFixed(1)}" y1="2" y2="${H - 2}" stroke="var(--color-border)" stroke-dasharray="2 2"/>
      </svg>`;
    },
    // Normalize a bucket_weights recommendation into rows the bar chart can draw.
    // Prefers explicit bucket rows (name/target/actual/recommended) if the
    // payload carries them; otherwise derives Recommended-only rows from the
    // weights map (target/actual are unavailable without allocation data).
    bucketWeights() {
      const rec = this.session?.committeeRecommendation;
      if (!rec || rec.type !== "bucket_weights") return [];
      const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
      if (Array.isArray(rec.buckets) && rec.buckets.length) {
        return rec.buckets.map((b) => ({
          name: b.name || this.humanize(b.id),
          target: num(b.target ?? b.target_weight),
          actual: num(b.actual ?? b.actual_weight),
          recommended: num(b.recommended ?? b.weight) ?? 0,
        }));
      }
      const weights = rec.weights;
      if (!weights || typeof weights !== "object") return [];
      return Object.entries(weights).map(([id, w]) => ({
        name: this.humanize(id), target: null, actual: null, recommended: num(w) ?? 0,
      }));
    },
    isBucketWeights() {
      const rec = this.session?.committeeRecommendation;
      return !!(rec && rec.type === "bucket_weights" && this.bucketWeights().length);
    },
    // Inline-SVG grouped bars per bucket: Target (open outline), Actual (muted
    // fill), Recommended (accent fill) — mirrors the reference BucketWeightsBars.
    // Target/Actual rows only appear when at least one bucket supplies them, so
    // the chart degrades cleanly to Recommended-only when allocation data is
    // absent. Axis pinned 0-100% for cross-bucket comparability.
    bucketWeightsBars() {
      const buckets = this.bucketWeights();
      if (!buckets.length) return "";
      const hasTarget = buckets.some((b) => b.target != null);
      const hasActual = buckets.some((b) => b.actual != null);
      const series = [
        hasTarget ? { key: "target", label: "T", fill: "transparent", stroke: "var(--color-text-muted)", txt: "var(--color-text-muted)" } : null,
        hasActual ? { key: "actual", label: "A", fill: "var(--color-text-dim)", opacity: "0.6", txt: "var(--color-text-muted)" } : null,
        { key: "recommended", label: "R", fill: "var(--color-accent)", txt: "var(--color-accent)" },
      ].filter(Boolean);
      const W = 520, labelW = 130, valW = 40, barW = W - labelW - valW;
      const nameH = 14, subH = 4, subGap = 4, gap = 8;
      const groupH = nameH + series.length * (subH + subGap);
      const H = buckets.length * (groupH + gap) + 4;
      const x = (v) => labelW + this.clampPct(v * 100) / 100 * barW;
      const body = buckets.map((b, i) => {
        const top = i * (groupH + gap);
        const sub = series.map((s, si) => {
          const v = b[s.key];
          const barY = top + nameH + si * (subH + subGap);
          const txtY = barY + subH + 0.5;
          if (v == null) {
            return `<text x="${labelW + barW + 4}" y="${txtY.toFixed(1)}" fill="var(--color-text-dim)" font-size="9" font-family="ui-monospace,monospace">${s.label} —</text>`;
          }
          const w = Math.max(0, x(v) - labelW);
          const rect = s.fill === "transparent"
            ? `<rect x="${labelW}" y="${barY}" width="${w.toFixed(1)}" height="${subH}" fill="transparent" stroke="${s.stroke}"/>`
            : `<rect x="${labelW}" y="${barY}" width="${w.toFixed(1)}" height="${subH}" fill="${s.fill}"${s.opacity ? ` fill-opacity="${s.opacity}"` : ""}/>`;
          return `${rect}<text x="${labelW + barW + 4}" y="${txtY.toFixed(1)}" fill="${s.txt}" font-size="9" font-family="ui-monospace,monospace">${s.label} ${Math.round(v * 100)}</text>`;
        }).join("");
        return `<g>
          <text x="0" y="${(top + 10).toFixed(1)}" fill="var(--color-text-muted)" font-size="11" font-family="ui-monospace,monospace">${this.escapeHtml(b.name)}</text>
          <line x1="${x(0.5).toFixed(1)}" x2="${x(0.5).toFixed(1)}" y1="${top + nameH - 2}" y2="${top + groupH}" stroke="var(--color-border)" stroke-dasharray="1 3"/>
          ${sub}
        </g>`;
      }).join("");
      return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Bucket weights: recommended${hasTarget ? " vs target" : ""}${hasActual ? " vs actual" : ""}">
        ${body}
      </svg>`;
    },
    regimeSparkline() {
      const h = this.session?.regimeSummary?.history || [];
      if (h.length < 2) return "";
      const W = 260, H = 58, pad = 5;
      const x = (i) => pad + (i / (h.length - 1)) * (W - pad * 2);
      const y = (v) => H - pad - Number(v || 0) * (H - pad * 2);
      const pts = h.map((d, i) => `${x(i).toFixed(1)},${y(d.composite).toFixed(1)}`).join(" ");
      return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Regime composite trailing history">
        <line x1="${pad}" x2="${W - pad}" y1="${y(0.33)}" y2="${y(0.33)}" stroke="var(--color-border)" stroke-dasharray="2 3"/>
        <line x1="${pad}" x2="${W - pad}" y1="${y(0.67)}" y2="${y(0.67)}" stroke="var(--color-border)" stroke-dasharray="2 3"/>
        <polyline fill="none" stroke="var(--color-accent)" stroke-width="1.6" points="${pts}"/>
        <circle cx="${x(h.length - 1)}" cy="${y(h[h.length - 1].composite)}" r="2.8" fill="var(--color-accent)"/>
      </svg>`;
    },
    // The aggregator currently fills `consensus` with every take body verbatim
    // and `disagreements[].positions[].view` with two of those same bodies
    // (backend committee/domain.ts: `authoredTakes.map(t => t.body)`). Rendered
    // literally, one take appears three times on this page under three headings
    // that each promise synthesis.
    //
    // So anything byte-identical to a take already listed above is treated as an
    // echo and dropped. This is deliberately shape-agnostic: the day the
    // aggregator emits real synthesis, those items stop matching any body and
    // appear on their own. Nothing here has to change for that to work.
    // NB: takes live on the factory root (`this.takes`), not under `session` —
    // the page's own x-for iterates `takes`.
    takeBodies() {
      return new Set((this.takes || []).map((t) => this.normText(t.body)).filter(Boolean));
    },
    normText(s) { return String(s || "").replace(/\s+/g, " ").trim(); },
    isEcho(text) { const n = this.normText(text); return !!n && this.takeBodies().has(n); },
    // Synthesis has the same problem one level up: the aggregator builds it by
    // joining every take body, so the section headed "Synthesis" reprints the
    // member takes already listed above it rather than drawing a conclusion
    // from them. Suppressed when it demonstrably contains every body verbatim;
    // a genuine synthesis will not, and will render untouched.
    synthesisIsEcho() {
      const bodies = [...this.takeBodies()];
      if (!bodies.length) return false;
      const n = this.normText(this.session?.synthesis);
      return !!n && bodies.every((b) => n.includes(b));
    },
    takeOf(memberId) { return (this.takes || []).find((t) => t.memberId === memberId); },
    consensusItems() {
      return (this.session?.committeeRecommendation?.consensus || []).filter((c) => !this.isEcho(c));
    },
    // Kept even when every view is an echo: WHO disagreed, and how far apart
    // they sat, is real information the takes list does not state anywhere.
    // Only the duplicated prose is suppressed — see the markup.
    disagreements() {
      return this.session?.committeeRecommendation?.disagreements || [];
    },
  }));
}
