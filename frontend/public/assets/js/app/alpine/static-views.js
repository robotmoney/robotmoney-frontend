// @ts-nocheck — browser-facing plain JS predating the root tsconfig's checkJs
// coverage. It entered the root TS program when frontend-routes.test.ts was
// re-pointed at the real archive loaders below (review-maintainability-026);
// before that it was never typechecked, so this pragma preserves the status
// quo rather than weakening existing coverage. JSDoc-typing this file is a
// worthwhile follow-up, not a drive-by.
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
// exported so scripts/tests/frontend-routes.test.ts can execute the exact
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
    consensusItems() {
      return this.session?.committeeRecommendation?.consensus || [];
    },
    disagreements() {
      return this.session?.committeeRecommendation?.disagreements || [];
    },
  }));
}
