// @ts-nocheck
import {
  createCommitteeArchiveClient,
  loadArchivedCommitteeMember,
  loadArchivedCommitteeSession,
} from "./committee-archive.js";

export function createArchivedMemberProfileController({ archive = createCommitteeArchiveClient() } = {}) {
  return {
    name: "Loading...",
    role: "",
    bio: "",
    member: null,
    sessions: [],
    takes: [],
    async load(memberId) {
      const archived = await loadArchivedCommitteeMember(archive, memberId);
      this.member = archived.member;
      this.sessions = archived.sessions;
      this.takes = archived.takes;
      this.name = archived.member.name;
      this.role = archived.member.lens || archived.member.tagline || "Committee member";
      this.bio = archived.member.mandate || archived.member.tagline || "";
    },
  };
}

export function createArchivedIcSessionDetailController({ archive = createCommitteeArchiveClient() } = {}) {
  return {
    title: "Loading...",
    session: null,
    subject: null,
    members: [],
    takes: [],
    portfolioRows: [],
    recommendationActions: [],
    disagreements: [],
    synthesis: "",
    async load(date, subject) {
      const archived = await loadArchivedCommitteeSession(archive, date, subject);
      this.session = archived.session;
      this.subject = archived.subject;
      this.members = archived.members;
      this.takes = archived.takes;
      this.portfolioRows = archived.positionRows;
      this.recommendationActions = archived.recommendationActions;
      this.disagreements = archived.disagreements;
      this.synthesis = archived.synthesis;
      this.title = archived.session.subjectName || subject;
    },
  };
}
