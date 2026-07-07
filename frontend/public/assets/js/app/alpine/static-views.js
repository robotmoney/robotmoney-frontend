import { api, ROUTES, path } from "../lib/api.js";

const STANCE_COLORS = {
  bullish: "#10b981",
  constructive: "#84cc16",
  neutral: "#94a3b8",
  cautious: "#f59e0b",
  bearish: "#ef4444",
};

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
    regimeSummary: raw.regimeSummary || (raw.regime_summary ? {
      composite: raw.regime_summary.composite,
      compositePercentile: raw.regime_summary.composite_percentile,
      regime: raw.regime_summary.regime,
      macroRegime: raw.regime_summary.macro_regime,
      onchainRegime: raw.regime_summary.onchain_regime,
      factorRegime: raw.regime_summary.factor_regime,
      macroPercentile: raw.regime_summary.macro_percentile,
      onchainPercentile: raw.regime_summary.onchain_percentile,
      factorPercentile: raw.regime_summary.factor_percentile,
      history: raw.regime_summary.history || [],
    } : null),
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

async function loadArchiveSession(date, subject) {
  const index = await fetchJson("/data/committee/sessions/index.json");
  const exists = (index.sessions || []).some((s) => s.date === date && s.subjectId === subject);
  if (!exists) throw new Error(`archive session missing: ${date}/${subject}`);
  const raw = await fetchJson(`/data/committee/sessions/${date}-${subject}.json`);
  return { session: camelSession(raw), takes: (raw.takes || []).map(camelTake), source: "archive" };
}

async function loadArchiveMember(id) {
  return camelMember(await fetchJson(`/data/committee/manifests/members/${id}.json`));
}

async function loadArchiveSubject(id) {
  return camelSubject(await fetchJson(`/data/committee/manifests/subjects/${id}.json`));
}

async function loadArchiveSnapshot(subject, date) {
  try { return normalizeSnapshot(await fetchJson(`/data/committee/subjects/${subject}/${date}.json`)); }
  catch (_) { return null; }
}

const helpers = {
  initials(name = "") {
    return String(name).split(/\s+/).filter(Boolean).slice(0, 2).map((s) => s[0]?.toUpperCase()).join("") || "IC";
  },
  stanceColor(stance) {
    return STANCE_COLORS[stance] || "#94a3b8";
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
  escapeHtml(text) {
    return String(text ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  },
  linkified(text) {
    return String(text || "")
      .split(/\n\n+/)
      .map((para) => {
        const lines = para.split(/\n/);
        const html = lines.map((line) => {
          const bullet = /^\s*[-*]\s+/.test(line);
          const clean = this.escapeHtml(line.replace(/^\s*[-*]\s+/, ""))
            .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
            .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>')
            .replace(/(^|[\s(])(\/[a-zA-Z0-9/_-]+)/g, '$1<a href="$2">$2</a>');
          return bullet ? `<li>${clean}</li>` : clean;
        });
        if (lines.every((line) => /^\s*[-*]\s+/.test(line))) return `<ul>${html.join("")}</ul>`;
        return `<p>${html.join("<br>")}</p>`;
      })
      .join("");
  },
};

export function registerStaticViews(Alpine) {
  Alpine.data("memberProfile", () => ({
    ...helpers,
    loading: true,
    error: null,
    member: null,
    sessions: [],
    async init() {
      const memberId = location.pathname.split("/").filter(Boolean).pop();
      try {
        this.member = await loadArchiveMember(memberId).catch(() => null);
        if (!this.member) this.member = await api.get(path(ROUTES.committee.member, { id: memberId })).then(camelMember);
        const sessionData = await api.get(ROUTES.committee.sessions);
        const baseSessions = (sessionData.sessions || []).filter((s) => s.state === "published");
        const details = await Promise.all(baseSessions.slice(0, 20).map(async (s) => {
          try {
            const detail = await api.get(path(ROUTES.committee.session, { date: s.date, subject: s.subjectId }));
            return { ...s, takes: detail.takes || [] };
          } catch (_) {
            return { ...s, takes: [] };
          }
        }));
        this.sessions = details;
      } catch (e) {
        this.error = e.message || "Member not found";
      } finally {
        this.loading = false;
      }
    },
    recentTakes() {
      if (!this.member) return [];
      return this.sessions
        .map((session) => {
          const take = (session.takes || []).find((t) => t.memberId === this.member.id);
          return take ? { session, take } : null;
        })
        .filter(Boolean);
    },
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
      const [detail, memberData, brief] = await Promise.all([
        api.get(path(ROUTES.committee.session, { date, subject })),
        api.get(ROUTES.committee.members),
        api.get(ROUTES.committee.brief, { date, subject }).catch(() => null),
      ]);
      this.source = "api";
      this.session = camelSession(detail.session);
      this.takes = (detail.takes || []).map(camelTake);
      this.members = (memberData.members || []).map(camelMember);
      this.subject = null;
      this.snapshot = null;
      this.brief = brief;
    },
    memberLens(memberId) {
      return this.members.find((m) => m.id === memberId)?.lens || "committee member";
    },
    memberById(memberId) {
      return this.members.find((m) => m.id === memberId) || null;
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
    positionRows() {
      const total = this.snapshot?.totalValueUsd || 0;
      return (this.snapshot?.positions || []).map((p) => ({ ...p, share: total > 0 ? p.value_usd / total : 0 }));
    },
    donutStyle(p, i) {
      const colors = ["#22d3ee", "#a78bfa", "#34d399", "#f59e0b", "#f472b6", "#60a5fa", "#94a3b8"];
      return `--c:${colors[i % colors.length]};--p:${this.clampPct((p.share || 0) * 100)};`;
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
    consensusItems() {
      return this.session?.committeeRecommendation?.consensus || [];
    },
    disagreements() {
      return this.session?.committeeRecommendation?.disagreements || [];
    },
  }));
}
