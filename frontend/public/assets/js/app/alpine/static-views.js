import { api, ROUTES, path } from "../lib/api.js";
export function registerStaticViews(Alpine) {
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
