import { api, ROUTES, path } from "../lib/api.js";

function chart(canvas, config) {
  return canvas && window.Chart ? new window.Chart(canvas, config) : null;
}

const doughnut = (labels, data, colors) => ({
  type: "doughnut",
  data: { labels, datasets: [{ data, backgroundColor: colors, borderColor: "#0a0f15", borderWidth: 2 }] },
  options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } },
});

export function registerStaticViews(Alpine) {
  Alpine.data("allocationKpis", () => ({
    tvl: "$2.45M",
    tvlChange: 12.5,
    apy: "8.2%",
    totalDeposits: "$2.45M",
    buybackVolume: "$425K",
    buybackCount: 37,
  }));

  Alpine.data("allocationCharts", () => ({
    _charts: [],
    init() {
      this.$nextTick(() => {
        this._charts = [
          chart(this.$refs.allocationChart, doughnut(
            ["Bucket A", "Bucket B", "Bucket C"], [33, 33, 34], ["#00e5ff", "#4488ff", "#8b5cf6"],
          )),
          chart(this.$refs.walletChart, doughnut(
            ["Wallet A", "Wallet B", "Wallet C"], [20, 31, 49], ["#00e5ff", "#4488ff", "#e8a640"],
          )),
          chart(this.$refs.tvlChart, {
            type: "line",
            data: {
              labels: ["Jun 1", "Jun 5", "Jun 10", "Jun 15", "Jun 20", "Jun 25", "Jun 30"],
              datasets: [{
                label: "Vault TVL",
                data: [1800000, 1950000, 2050000, 2200000, 2320000, 2380000, 2450000],
                borderColor: "#00e5ff",
                backgroundColor: "rgba(0,229,255,.1)",
                fill: true,
                tension: 0.4,
              }],
            },
            options: {
              responsive: true,
              maintainAspectRatio: false,
              plugins: { legend: { display: false } },
              scales: { y: { ticks: { callback: (v) => `$${(v / 1000000).toFixed(1)}M` } } },
            },
          }),
        ].filter(Boolean);
      });
    },
    destroy() {
      this._charts.forEach((item) => item.destroy());
      this._charts = [];
    },
  }));

  Alpine.data("walletHoldings", () => ({
    wallets: [
      { address: "0x1234...5678", deposit: "500K USDC", balance: "545K USDC", yield: "+45K", apy: "9.0%" },
      { address: "0xabcd...ef01", deposit: "750K USDC", balance: "815K USDC", yield: "+65K", apy: "8.7%" },
      { address: "0x9876...5432", deposit: "1.2M USDC", balance: "1.31M USDC", yield: "+110K", apy: "8.5%" },
    ],
    load() {},
  }));

  Alpine.data("buybackHistory", () => ({
    buybacks: [
      { date: "2026-06-28", amount: "15,000", token: "ROBOT", price: "$2.34", txnHash: "abc123..." },
      { date: "2026-06-25", amount: "12,500", token: "ROBOT", price: "$2.18", txnHash: "def456..." },
      { date: "2026-06-22", amount: "18,000", token: "ROBOT", price: "$2.05", txnHash: "ghi789..." },
      { date: "2026-06-19", amount: "14,200", token: "ROBOT", price: "$1.98", txnHash: "jkl012..." },
      { date: "2026-06-15", amount: "21,000", token: "ROBOT", price: "$1.88", txnHash: "mno345..." },
    ],
    load() {},
  }));

  Alpine.data("memberProfile", () => ({
    name: "Loading…",
    role: "",
    avatar: "/assets/logo.svg",
    bio: "",
    totalSessions: 0,
    totalSubmissions: 0,
    participationRate: 0,
    joinDate: "—",
    recentSubmissions: [],
    async init() {
      const memberId = location.pathname.split("/").filter(Boolean).pop();
      try {
        const member = await api.get(path(ROUTES.committee.member, { id: memberId }));
        this.name = member.name;
        this.role = member.lens || member.tagline || "Committee member";
        this.bio = member.mandate || member.tagline || "";
        this.joinDate = member.activatedAt?.slice?.(0, 10) || "—";
      } catch {
        this.name = "Member not found";
      }
    },
    formatDate(value) {
      return new Date(value).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
    },
  }));

  Alpine.data("icSessionDetail", () => ({
    title: "Loading…",
    date: new Date(),
    status: "pending",
    statusLabel: "Loading",
    memberCount: 0,
    submissionCount: 0,
    phases: [],
    members: [],
    submissions: [],
    brief: "",
    allocation: [],
    confidence: [],
    async init() {
      const match = location.pathname.match(/^\/committee\/(\d{4}-\d{2}-\d{2})\/([^/]+)/);
      if (!match) return;
      const [, date, subject] = match;
      try {
        const [detail, memberData, brief] = await Promise.all([
          api.get(path(ROUTES.committee.session, { date, subject })),
          api.get(ROUTES.committee.members),
          api.get(ROUTES.committee.brief, { date, subject }),
        ]);
        this.title = detail.session.subjectName || subject;
        this.date = new Date(`${date}T00:00:00Z`);
        this.status = detail.session.state;
        this.statusLabel = detail.session.state.replaceAll("_", " ");
        this.members = (memberData.members || []).map((member) => ({
          ...member,
          role: member.lens || "Committee member",
          avatar: "/assets/logo.svg",
          hasSubmitted: detail.takes.some((take) => take.memberId === member.id),
        }));
        this.memberCount = this.members.length;
        this.submissions = (detail.takes || []).map((take) => ({
          id: take.id,
          memberName: take.memberName,
          allocationA: 0,
          allocationB: 0,
          allocationC: 0,
          confidence: Math.round(Number(take.confidence || 0) * 100),
          comment: take.body || take.stance,
        }));
        this.submissionCount = this.submissions.length;
        this.brief = brief?.body ? JSON.stringify(brief.body, null, 2) : "No brief available.";
        this.phases = ["published", "open", "closed", "aggregated"];
      } catch {
        this.title = "Session not found";
        this.statusLabel = "Unavailable";
      }
    },
    formatDate(value) {
      return value.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
    },
    phaseDate() {
      return this.formatDate(this.date);
    },
  }));
}
