import { api, ROUTES, path } from "../lib/api.js";
import {
  createCommitteeArchiveClient,
  loadArchivedCommitteeMember,
  loadArchivedCommitteeSession,
} from "../lib/committee-archive.js";

export function createMemberProfileController({ archive = createCommitteeArchiveClient(), apiClient = api } = {}) {
  return {
    name: "Loading...",
    role: "",
    avatar: "/assets/logo.svg",
    bio: "",
    totalSessions: 0,
    totalSubmissions: 0,
    participationRate: 0,
    joinDate: "-",
    recentSubmissions: [],
    loading: true,
    error: "",
    member: null,
    sessions: [],
    takes: [],
    async load(memberId) {
      try {
        const archived = await loadArchivedCommitteeMember(archive, memberId);
        this.member = archived.member;
        this.sessions = archived.sessions;
        this.takes = archived.takes;
        this.name = archived.member.name;
        this.role = archived.member.lens || archived.member.tagline || "Committee member";
        this.bio = archived.member.mandate || archived.member.tagline || "";
        this.joinDate = archived.member.activatedAt?.slice?.(0, 10) || "-";
        this.totalSessions = archived.sessions.length;
        this.totalSubmissions = archived.takes.length;
        this.participationRate = archived.sessions.length ? Math.round((archived.takes.length / archived.sessions.length) * 100) : 0;
        this.recentSubmissions = archived.takes.map((take) => ({
          id: `${take.date}-${take.subjectId}`,
          sessionDate: take.date,
          sessionSlug: take.subjectId,
          sessionTitle: take.subjectName,
          date: take.date,
          a: 0,
          b: 0,
          c: 0,
          confidence: Math.round(Number(take.confidence || 0) * 100),
        }));
      } catch {
        try {
          const member = await apiClient.get(path(ROUTES.committee.member, { id: memberId }));
          this.member = member;
          this.name = member.name;
          this.role = member.lens || member.tagline || "Committee member";
          this.bio = member.mandate || member.tagline || "";
          this.joinDate = member.activatedAt?.slice?.(0, 10) || "-";
        } catch {
          this.name = "Member not found";
          this.error = "Member not found.";
        }
      } finally {
        this.loading = false;
      }
    },
    async init() {
      const memberId = location.pathname.split("/").filter(Boolean).pop();
      await this.load(memberId);
    },
    formatDate(value) {
      return new Date(value).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
    },
  };
}

export function createIcSessionDetailController({ archive = createCommitteeArchiveClient(), apiClient = api } = {}) {
  return {
    title: "Loading...",
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
    loading: true,
    error: "",
    session: null,
    subject: null,
    takes: [],
    portfolioRows: [],
    recommendationActions: [],
    disagreements: [],
    synthesis: "",
    async load(date, subject) {
      try {
        const archived = await loadArchivedCommitteeSession(archive, date, subject);
        this.session = archived.session;
        this.subject = archived.subject;
        this.takes = archived.takes;
        this.members = archived.members;
        this.portfolioRows = archived.positionRows;
        this.recommendationActions = archived.recommendationActions;
        this.disagreements = archived.disagreements;
        this.synthesis = archived.synthesis;
        this.title = archived.session.subjectName || subject;
        this.date = new Date(`${date}T00:00:00Z`);
        this.status = archived.session.state;
        this.statusLabel = archived.session.state.replaceAll("_", " ");
        this.memberCount = archived.members.length;
        this.submissionCount = archived.takes.length;
        this.submissions = archived.takes.map((take) => ({
          id: take.id,
          memberName: take.memberName,
          allocationA: 0,
          allocationB: 0,
          allocationC: 0,
          confidence: Math.round(Number(take.confidence || 0) * 100),
          comment: take.body || take.stance,
        }));
        this.brief = archived.subject?.thesis_blurb || archived.synthesis || "No brief available.";
        this.phases = ["published", "open", "closed", "aggregated"];
      } catch {
        try {
          const [detail, memberData, brief] = await Promise.all([
            apiClient.get(path(ROUTES.committee.session, { date, subject })),
            apiClient.get(ROUTES.committee.members),
            apiClient.get(ROUTES.committee.brief, { date, subject }),
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
          this.error = "Session not found.";
        }
      } finally {
        this.loading = false;
      }
    },
    async init() {
      const match = location.pathname.match(/^\/committee\/(\d{4}-\d{2}-\d{2})\/([^/]+)/);
      if (!match) return;
      await this.load(match[1], match[2]);
    },
    formatDate(value) {
      return value.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
    },
    phaseDate() {
      return this.formatDate(this.date);
    },
  };
}

export function registerStaticViews(Alpine) {
  Alpine.data("memberProfile", () => createMemberProfileController());
  Alpine.data("icSessionDetail", () => createIcSessionDetailController());
}
