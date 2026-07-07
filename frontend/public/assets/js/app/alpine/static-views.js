import { api, ROUTES, path } from "../lib/api.js";

const ARCHIVE_ROOT = "/data/committee";

async function json(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

async function maybeJson(url) {
  try {
    return await json(url);
  } catch {
    return null;
  }
}

function titleCase(value) {
  return String(value || "")
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function pct(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${Math.round(n * 100)}%` : "n/a";
}

function usd(value) {
  const n = Number(value);
  return Number.isFinite(n)
    ? n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })
    : "n/a";
}

function md(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    .replace(/\n- /g, "\n<li>")
    .replace(/\n\n/g, "</p><p>")
    .replace(/\n/g, "<br>");
}

function normalizeSession(session, brief) {
  const subject = brief?.subject || {};
  const recommendation = session.committee_recommendation || session.committeeRecommendation || null;
  return {
    date: session.date,
    subjectId: session.subject_id || session.subjectId,
    subjectName: session.subject_name || session.subjectName || subject.name,
    state: session.state || "published",
    regimeSummary: session.regime_summary || session.regimeSummary || brief?.regime || null,
    subjectSnapshotTotalValueUsd: session.subject_snapshot_total_value_usd || brief?.subject_snapshot?.total_value_usd,
    committeeRecommendation: recommendation,
    synthesis: session.synthesis || "",
    takes: (session.takes || []).map((take, index) => ({
      id: take.id || `${session.date}-${take.member_id || take.memberId || index}`,
      memberId: take.member_id || take.memberId,
      memberName: take.member_name || take.memberName,
      stance: take.stance || "neutral",
      confidence: Number(take.confidence || 0),
      body: take.body || "",
      memoUrl: take.memo_url || take.memoUrl || "",
      verified: take.verified !== false,
    })),
    subject,
    brief,
  };
}

function positionRows(brief) {
  const raw = brief?.subject_snapshot?.positions || brief?.positions || brief?.portfolio?.positions || [];
  const total = Number(brief?.subject_snapshot?.total_value_usd || brief?.portfolio?.total_value_usd || 0);
  return raw
    .map((p) => {
      const value = Number(p.value_usd || p.valueUsd || p.usd || 0);
      return {
        token: p.token || p.symbol || p.asset || "asset",
        chain: p.chain || p.network || "-",
        value_usd: value,
        share: Number(p.share || p.weight || (total > 0 ? value / total : 0)),
      };
    })
    .sort((a, b) => b.value_usd - a.value_usd);
}

function sparkline(points) {
  if (!points?.length) return "";
  const values = points.map((p) => Number(p.composite)).filter(Number.isFinite);
  if (values.length < 2) return "";
  const w = 360;
  const h = 92;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const d = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * w;
      const y = h - ((v - min) / span) * (h - 16) - 8;
      return `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
  return `<svg viewBox="0 0 ${w} ${h}" role="img"><path d="${d}" fill="none" stroke="var(--color-accent)" stroke-width="2"/><line x1="0" x2="${w}" y1="${h / 2}" y2="${h / 2}" stroke="var(--color-border)" stroke-dasharray="4 4"/></svg>`;
}

export function registerStaticViews(Alpine) {
  Alpine.data("memberProfile", () => ({
    loading: true,
    error: "",
    member: null,
    sessions: [],
    takes: [],
    async init() {
      const memberId = location.pathname.split("/").filter(Boolean).pop();
      try {
        this.member = await json(`${ARCHIVE_ROOT}/manifests/members/${memberId}.json`);
        const index = await maybeJson(`${ARCHIVE_ROOT}/sessions/index.json`);
        const sessionRefs = (index?.sessions || []).filter((s) => s.file).slice(0, 40);
        const sessions = await Promise.all(
          sessionRefs.map(async (ref) => maybeJson(`${ARCHIVE_ROOT}/sessions/${ref.file}`)),
        );
        this.sessions = sessions
          .filter(Boolean)
          .filter((s) => (s.takes || []).some((t) => (t.member_id || t.memberId) === memberId))
          .slice(0, 10);
        this.takes = this.sessions.map((s) => {
          const take = (s.takes || []).find((t) => (t.member_id || t.memberId) === memberId) || {};
          return {
            date: s.date,
            subjectId: s.subject_id,
            subjectName: s.subject_name,
            stance: take.stance,
            confidence: take.confidence,
            body: take.body,
          };
        });
      } catch {
        try {
          this.member = await api.get(path(ROUTES.committee.member, { id: memberId }));
        } catch {
          this.error = "Member not found.";
        }
      } finally {
        this.loading = false;
      }
    },
    initials(name) {
      return String(name || "?").split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase();
    },
    fmtPct: pct,
    linkified: md,
  }));

  Alpine.data("icSessionDetail", () => ({
    loading: true,
    error: "",
    session: null,
    subject: null,
    brief: null,
    members: [],
    takes: [],
    async init() {
      const match = location.pathname.match(/^\/committee\/(\d{4}-\d{2}-\d{2})\/([^/]+)/);
      if (!match) return;
      const [, date, subject] = match;
      try {
        const [session, brief, memberIndex] = await Promise.all([
          json(`${ARCHIVE_ROOT}/sessions/${date}-${subject}.json`),
          maybeJson(`${ARCHIVE_ROOT}/briefs/${date}-${subject}.json`),
          maybeJson(`${ARCHIVE_ROOT}/manifests/members/_index.json`),
        ]);
        const normalized = normalizeSession(session, brief);
        this.session = normalized;
        this.subject = normalized.subject;
        this.brief = normalized.brief;
        this.takes = normalized.takes;
        const ids = (memberIndex?.members || memberIndex || ["athena", "robotmoney", "woon"]).map((m) => m.id || m);
        this.members = (await Promise.all(ids.map((id) => maybeJson(`${ARCHIVE_ROOT}/manifests/members/${id}.json`)))).filter(Boolean);
      } catch {
        // Sessions newer than the static reference archive (e.g. today's live
        // session) are only served by the backend — fall back to the live API.
        try {
          const [res, memberList] = await Promise.all([
            api.get(path(ROUTES.committee.session, { date, subject })),
            api.get(ROUTES.committee.members).catch(() => null),
          ]);
          const normalized = normalizeSession({ ...res.session, takes: res.takes }, null);
          this.session = normalized;
          this.subject = normalized.subject;
          this.brief = normalized.brief;
          this.takes = normalized.takes;
          this.members = memberList?.members || [];
        } catch {
          this.error = `No archived committee session found for ${date}/${subject}. The reference archive currently ends at 2026-06-25 for Woon.`;
        }
      } finally {
        this.loading = false;
      }
    },
    formatDate(value) {
      return new Date(`${String(value).slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
        timeZone: "UTC",
      });
    },
    fmtNum(value, digits = 2) {
      const n = Number(value);
      return Number.isFinite(n) ? n.toFixed(digits) : "n/a";
    },
    fmtPct: pct,
    fmtPct1(value) {
      const n = Number(value);
      return Number.isFinite(n) ? `${(n * 100).toFixed(1)}%` : "n/a";
    },
    fmtUsd: usd,
    regimeLabel: titleCase,
    clampPct(value) {
      return Math.max(0, Math.min(100, Number(value) || 0));
    },
    panelInputs() {
      const r = this.session?.regimeSummary || {};
      return [
        ["macro", r.macro_percentile],
        ["onchain", r.onchain_percentile],
        ["factor", r.factor_percentile],
      ]
        .filter(([, value]) => value != null)
        .map(([label, pctValue]) => ({ label, pct: Number(pctValue) }));
    },
    regimeSparkline() {
      return sparkline(this.session?.regimeSummary?.history || this.brief?.regime_history || []);
    },
    briefSummary() {
      return this.subject?.thesis_blurb || this.subject?.thesisBlurb || "No brief summary available.";
    },
    positionRows() {
      return positionRows(this.brief);
    },
    donutStyle(row, i) {
      const colors = ["#00e5ff", "#e8a640", "#8b5cf6", "#ff6644", "#4488ff", "#6ee7b7", "#e2e4ec"];
      return `--pct:${this.clampPct(row.share * 100)}%;--swatch:${colors[i % colors.length]}`;
    },
    recommendationKind() {
      return titleCase(this.session?.committeeRecommendation?.type || "rollup");
    },
    isRollupRecommendation() {
      return Boolean(this.session?.committeeRecommendation?.stances);
    },
    consensusItems() {
      return this.session?.committeeRecommendation?.consensus || [];
    },
    disagreements() {
      return this.session?.committeeRecommendation?.disagreements || [];
    },
    memberById(id) {
      return this.members.find((m) => m.id === id);
    },
    memberLens(id) {
      return this.memberById(id)?.lens || "committee member";
    },
    initials(name) {
      return String(name || "?").split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase();
    },
    stanceColor(stance) {
      return {
        bullish: "#00e5ff",
        constructive: "#6ee7b7",
        neutral: "#e8a640",
        cautious: "#f5a623",
        bearish: "#ff6644",
      }[String(stance || "").toLowerCase()] || "var(--color-text-muted)";
    },
    stanceStyle(stance) {
      return `border-color:${this.stanceColor(stance)}55;color:${this.stanceColor(stance)}`;
    },
    linkified(value) {
      return `<p>${md(value)}</p>`;
    },
  }));
}
