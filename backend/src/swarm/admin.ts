// Swarm ADMIN domain layer (issue #152): topic/member CRUD with optimistic
// concurrency, member lifecycle + one-time credential issuance, roster
// add/excuse/restore, guarded session lifecycle transitions, and audit-log
// filtering. Sessions are opened only by the epoch lifecycle (domain.ts).
//
// Kept as a SEPARATE module from swarm/domain.ts (the member/public-facing
// surface) so the existing apply/activate/submit/open/publish/aggregate paths —
// used by the smoke, the worker, and their tests — are untouched by this admin
// surface. Where this module's session lifecycle overlaps with domain.ts (e.g.
// aggregateSessionGuarded still calls domain.aggregateSession for the rich
// rollup), it composes those functions rather than duplicating them.
import { sql, type DbHandle } from "../db/client.ts";
import { on, registerQuery } from "../db/registry.ts";
import { hashKey } from "../lib/keys.ts";
import { isRegistrablePublicKey } from "../lib/signing.ts";
import {
  activateMember,
  aggregateSession as domainAggregateSession,
  assertRosterCapacity,
  isHandleUniqueViolation,
  SWARM_ROSTER_CAP,
  appendStreamEvent,
  listJudgements,
  sessionJudgeFingerprint,
} from "./domain.ts";
// Issue #562 — the one implementation of "what handle does this name get".
import { deriveMemberHandle } from "./handle.ts";
// Issue #752 — the consensus judge's runtime switch. A DATABASE row, not an env
// var, because the swarm is live and an operator must be able to take the
// judge off without restarting anything. The judge itself is a participant
// (issue #1026): nothing in this module judges.
import { getJudgeConfig, setJudgeConfig, type JudgeConfig, type JudgeMode } from "./judge-config.ts";
import { ConsensusReceiptRefusal, publishConsensusReceipt } from "./consensus-receipt.ts";
// The published shape of this module's member projection. Imported for the
// `: AdminMember` return annotation on toMemberAdmin() below — see the comment
// there (issue #572).
import { ROUTES, path } from "@robotmoney/contract";
import type { AdminMember } from "@robotmoney/contract";


// ── The admin statements are registered (smoke-production-spec.md §7.1) ─────
// Every one runs on the api's `rm_app` credential, reached from the admin
// route. A statement that joins several relations declares each of them, and
// its declarations carry one probe. The session lifecycle verbs that used to
// live here (cancel, close, reopen, aggregate, publish) moved to the fixtures
// that drive them: no production path reaches them (D55 (13)).
const ADMIN_CALLERS = ["src/api/routes/swarm-admin"];
const PROBE_UUID = "00000000-0000-0000-0000-000000000000";
type Row = Record<string, any>;

const SILENCE_NEVER_PROBE =
  "WITH eligible AS (SELECT sm.member_id, count(*)::int AS sessions_seen FROM swarm_session_members sm " +
  "JOIN swarm_sessions s ON s.id = sm.session_id JOIN swarm_members m ON m.id = sm.member_id " +
  "WHERE m.status = 'active' AND m.role = 'member' AND sm.status != 'excused' AND s.convened_at > m.activated_at " +
  "GROUP BY sm.member_id) SELECT e.member_id, e.sessions_seen FROM eligible e " +
  "WHERE e.sessions_seen >= $1 AND NOT EXISTS (SELECT 1 FROM swarm_recommendations r WHERE r.member_id = e.member_id)";
const SILENCE_QUIET_PROBE =
  "WITH last_take AS (SELECT r.member_id, max(s.convened_at) AS last_take_at FROM swarm_recommendations r " +
  "JOIN swarm_sessions s ON s.id = r.session_id GROUP BY r.member_id) " +
  "SELECT sm.member_id, count(*)::int AS sessions_seen FROM swarm_session_members sm " +
  "JOIN swarm_sessions s ON s.id = sm.session_id JOIN swarm_members m ON m.id = sm.member_id " +
  "JOIN last_take lt ON lt.member_id = sm.member_id WHERE m.status = 'active' AND m.role = 'member' " +
  "AND sm.status != 'excused' AND s.convened_at > lt.last_take_at GROUP BY sm.member_id HAVING count(*) >= $1";
const SUBJECT_COLUMNS_PROBE =
  "INSERT INTO swarm_subjects (id, status, name, operator, homepage, x_handle, thesis_blurb, wallets, nft_contracts, " +
  "source, recommendation_type, linked_member_id, structural_notes, last_reviewed) " +
  "SELECT $1, 'active', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13 WHERE false RETURNING *";
const CLOSE_JOIN_PROBE =
  "UPDATE swarm_sessions s SET state = 'window_closed', version = s.version + 1, " +
  "judge_mode = COALESCE(s.judge_mode, COALESCE((SELECT CASE WHEN c.mode = 'enforce' THEN 'enforce' ELSE 'off' END " +
  "FROM swarm_judge_config c WHERE c.id = 1), 'off')), " +
  "judging_duration_seconds = COALESCE(s.judging_duration_seconds, t.judging_duration_seconds) " +
  "FROM swarm_subjects t WHERE s.id = $1 AND t.id = s.subject_id RETURNING s.id, s.state, s.version";

const auditInsert = registerQuery({
  role: "rm_app", object: "audit_log", privileges: ["INSERT"],
  site: "src/swarm/admin:audit",
  purpose: "Append one audit row for an admin write.",
  callers: ADMIN_CALLERS,
  probe: { statement: "INSERT INTO audit_log (actor, action, scope) SELECT $1, $2, $3 WHERE false", params: ["a", "b", "{}"] },
});

const listSubjects = registerQuery({
  role: "rm_app", object: "swarm_subjects", privileges: ["SELECT"],
  site: "src/swarm/admin:listSubjectsAdmin",
  purpose: "List every subject for the admin surface.",
  callers: ADMIN_CALLERS,
  probe: { statement: "SELECT * FROM swarm_subjects ORDER BY id" },
});

const subjectExists = registerQuery({
  role: "rm_app", object: "swarm_subjects", privileges: ["SELECT"],
  site: "src/swarm/admin:createSubjectAdmin.exists",
  purpose: "Refuse a subject id that already exists.",
  callers: ADMIN_CALLERS,
  probe: { statement: "SELECT id FROM swarm_subjects WHERE id = $1", params: ["probe"] },
});

const insertSubject = registerQuery({
  role: "rm_app", object: "swarm_subjects", privileges: ["INSERT", "SELECT"],
  site: "src/swarm/admin:createSubjectAdmin.insert",
  purpose: "Create an active subject; its scheduling columns take the column defaults.",
  callers: ADMIN_CALLERS,
  probe: { statement: SUBJECT_COLUMNS_PROBE, params: ["probe", "probe", null, null, null, null, null, null, null, null, null, null, null] },
});

const setSubjectScheduling = registerQuery({
  role: "rm_app", object: "swarm_subjects", privileges: ["UPDATE", "SELECT"],
  site: "src/swarm/admin:createSubjectAdmin.scheduling",
  purpose: "Apply the scheduling columns a create request named over the defaults the insert took.",
  callers: ADMIN_CALLERS,
  probe: {
    statement:
      "UPDATE swarm_subjects SET epoch_duration_seconds = COALESCE($1, epoch_duration_seconds), " +
      "epoch_anchor = COALESCE($2::text::timestamptz, epoch_anchor), " +
      "judging_duration_seconds = COALESCE($3, judging_duration_seconds) WHERE id = $4 RETURNING *",
    params: [null, null, null, "probe"],
  },
});

const lockSubject = registerQuery({
  role: "rm_app", object: "swarm_subjects", privileges: ["SELECT", "UPDATE"],
  site: "src/swarm/admin:lockSubject",
  purpose: "Read and lock a subject row before an optimistic-concurrency edit.",
  callers: ADMIN_CALLERS,
  probe: { statement: "SELECT * FROM swarm_subjects WHERE id = $1 FOR NO KEY UPDATE", params: ["probe"] },
});

const openCollectingClose = registerQuery({
  role: "rm_app", object: "swarm_sessions", privileges: ["SELECT"],
  site: "src/swarm/admin:updateSubjectAdmin.openWindow",
  purpose: "Read the close of a subject's collecting window, so a duration change keeps it as the new anchor.",
  callers: ADMIN_CALLERS,
  probe: {
    statement: "SELECT window_closes_at::text AS closes FROM swarm_sessions WHERE subject_id = $1 AND state = 'collecting'",
    params: ["probe"],
  },
});

const updateSubject = registerQuery({
  role: "rm_app", object: "swarm_subjects", privileges: ["UPDATE", "SELECT"],
  site: "src/swarm/admin:updateSubjectAdmin.update",
  purpose: "Write an edited subject under its expected version.",
  callers: ADMIN_CALLERS,
  probe: {
    statement:
      "UPDATE swarm_subjects SET name = $1, operator = $2, homepage = $3, x_handle = $4, thesis_blurb = $5, " +
      "wallets = $6, nft_contracts = $7, source = $8, recommendation_type = $9, linked_member_id = $10, " +
      "structural_notes = $11, last_reviewed = $12, epoch_duration_seconds = $13, " +
      "epoch_anchor = COALESCE($14::text::timestamptz, epoch_anchor), judging_duration_seconds = $15, " +
      "version = version + 1, updated_at = now() WHERE id = $16 AND version = $17 RETURNING *",
    params: [null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, "probe", 1],
  },
});

const renameSessions = registerQuery({
  role: "rm_app", object: "swarm_sessions", privileges: ["UPDATE", "SELECT"],
  site: "src/swarm/admin:updateSubjectAdmin.renameSessions",
  purpose: "Backfill the denormalized subject name onto a renamed subject's sessions.",
  callers: ADMIN_CALLERS,
  probe: { statement: "UPDATE swarm_sessions SET subject_name = $1 WHERE subject_id = $2", params: ["probe", "probe"] },
});

const deactivateSubject = registerQuery({
  role: "rm_app", object: "swarm_subjects", privileges: ["UPDATE", "SELECT"],
  site: "src/swarm/admin:deactivateSubjectAdmin",
  purpose: "Set a subject inactive under its expected version.",
  callers: ADMIN_CALLERS,
  probe: {
    statement:
      "UPDATE swarm_subjects SET status = 'inactive', version = version + 1, updated_at = now() " +
      "WHERE id = $1 AND version = $2 RETURNING *",
    params: ["probe", 1],
  },
});

const activateSubject = registerQuery({
  role: "rm_app", object: "swarm_subjects", privileges: ["UPDATE", "SELECT"],
  site: "src/swarm/admin:activateSubjectAdmin",
  purpose: "Set a subject active under its expected version.",
  callers: ADMIN_CALLERS,
  probe: {
    statement:
      "UPDATE swarm_subjects SET status = 'active', version = version + 1, updated_at = now() " +
      "WHERE id = $1 AND version = $2 RETURNING *",
    params: ["probe", 1],
  },
});

const listMembers = registerQuery({
  role: "rm_app", object: "swarm_members", privileges: ["SELECT"],
  site: "src/swarm/admin:listMembersAdmin",
  purpose: "List every member for the admin surface.",
  callers: ADMIN_CALLERS,
  probe: { statement: "SELECT * FROM swarm_members ORDER BY id" },
});

const neverSubmittedSessionMembers = registerQuery({
  role: "rm_app", object: "swarm_session_members", privileges: ["SELECT"],
  site: "src/swarm/admin:getMemberSilenceFlags.neverSubmitted.sessionMembers",
  purpose: "Flag active members seated in enough sessions since activation without ever submitting a take.",
  callers: ADMIN_CALLERS,
  probe: { statement: SILENCE_NEVER_PROBE, params: [1] },
});
const neverSubmittedSessions = registerQuery({
  role: "rm_app", object: "swarm_sessions", privileges: ["SELECT"],
  site: "src/swarm/admin:getMemberSilenceFlags.neverSubmitted.sessions",
  purpose: "Flag active members seated in enough sessions since activation without ever submitting a take.",
  callers: ADMIN_CALLERS,
  probe: { statement: SILENCE_NEVER_PROBE, params: [1] },
});
const neverSubmittedMembers = registerQuery({
  role: "rm_app", object: "swarm_members", privileges: ["SELECT"],
  site: "src/swarm/admin:getMemberSilenceFlags.neverSubmitted.members",
  purpose: "Flag active members seated in enough sessions since activation without ever submitting a take.",
  callers: ADMIN_CALLERS,
  probe: { statement: SILENCE_NEVER_PROBE, params: [1] },
});
const neverSubmittedTakes = registerQuery({
  role: "rm_app", object: "swarm_recommendations", privileges: ["SELECT"],
  site: "src/swarm/admin:getMemberSilenceFlags.neverSubmitted.takes",
  purpose: "Flag active members seated in enough sessions since activation without ever submitting a take.",
  callers: ADMIN_CALLERS,
  probe: { statement: SILENCE_NEVER_PROBE, params: [1] },
});

const goneQuietTakes = registerQuery({
  role: "rm_app", object: "swarm_recommendations", privileges: ["SELECT"],
  site: "src/swarm/admin:getMemberSilenceFlags.goneQuiet.takes",
  purpose: "Flag established members with no take in the enough eligible sessions since their latest one.",
  callers: ADMIN_CALLERS,
  probe: { statement: SILENCE_QUIET_PROBE, params: [1] },
});
const goneQuietSessions = registerQuery({
  role: "rm_app", object: "swarm_sessions", privileges: ["SELECT"],
  site: "src/swarm/admin:getMemberSilenceFlags.goneQuiet.sessions",
  purpose: "Flag established members with no take in the enough eligible sessions since their latest one.",
  callers: ADMIN_CALLERS,
  probe: { statement: SILENCE_QUIET_PROBE, params: [1] },
});
const goneQuietSessionMembers = registerQuery({
  role: "rm_app", object: "swarm_session_members", privileges: ["SELECT"],
  site: "src/swarm/admin:getMemberSilenceFlags.goneQuiet.sessionMembers",
  purpose: "Flag established members with no take in the enough eligible sessions since their latest one.",
  callers: ADMIN_CALLERS,
  probe: { statement: SILENCE_QUIET_PROBE, params: [1] },
});
const goneQuietMembers = registerQuery({
  role: "rm_app", object: "swarm_members", privileges: ["SELECT"],
  site: "src/swarm/admin:getMemberSilenceFlags.goneQuiet.members",
  purpose: "Flag established members with no take in the enough eligible sessions since their latest one.",
  callers: ADMIN_CALLERS,
  probe: { statement: SILENCE_QUIET_PROBE, params: [1] },
});

const listApplicationsByStatus = registerQuery({
  role: "rm_app", object: "swarm_applications", privileges: ["SELECT"],
  site: "src/swarm/admin:listApplicationsAdmin.byStatus",
  purpose: "List the applications in one status, newest first.",
  callers: ADMIN_CALLERS,
  probe: {
    statement: "SELECT id, member_id, status, created_at, reviewed_at FROM swarm_applications WHERE status = $1 ORDER BY created_at DESC",
    params: ["pending"],
  },
});

const listApplications = registerQuery({
  role: "rm_app", object: "swarm_applications", privileges: ["SELECT"],
  site: "src/swarm/admin:listApplicationsAdmin.all",
  purpose: "List every application, newest first.",
  callers: ADMIN_CALLERS,
  probe: { statement: "SELECT id, member_id, status, created_at, reviewed_at FROM swarm_applications ORDER BY created_at DESC" },
});

const keyOwner = registerQuery({
  role: "rm_app", object: "swarm_member_keys", privileges: ["SELECT"],
  site: "src/swarm/admin:addMemberAdmin.keyOwner",
  purpose: "Refuse a public key that already belongs to a member.",
  callers: ADMIN_CALLERS,
  probe: { statement: "SELECT member_id FROM swarm_member_keys WHERE public_key = $1 LIMIT 1", params: ["probe"] },
});

const insertManualMember = registerQuery({
  role: "rm_app", object: "swarm_members", privileges: ["INSERT"],
  site: "src/swarm/admin:addMemberAdmin.insert",
  purpose: "Seat an active member the operator added by hand.",
  callers: ADMIN_CALLERS,
  probe: {
    statement:
      "INSERT INTO swarm_members (id, status, name, lens, contact_email, applied_at, activated_at) " +
      "SELECT $1, 'active', $2, $3, $4, now(), now() WHERE false",
    params: ["probe", "probe", null, null],
  },
});

const setMemberHandle = registerQuery({
  role: "rm_app", object: "swarm_members", privileges: ["UPDATE", "SELECT"],
  site: "src/swarm/admin:addMemberAdmin.handle",
  purpose: "Write the derived handle onto a member added by hand.",
  callers: ADMIN_CALLERS,
  probe: { statement: "UPDATE swarm_members SET handle = $1 WHERE id = $2 RETURNING *", params: ["probe", "probe"] },
});

const insertMemberKey = registerQuery({
  role: "rm_app", object: "swarm_member_keys", privileges: ["INSERT"],
  site: "src/swarm/admin:insertMemberKey",
  purpose: "Register an active key and token hash for a member.",
  callers: ADMIN_CALLERS,
  probe: {
    statement:
      "INSERT INTO swarm_member_keys (member_id, public_key, active, token_hash) SELECT $1, $2, true, $3 WHERE false",
    params: ["probe", "probe", "probe"],
  },
});

const lockMemberStatus = registerQuery({
  role: "rm_app", object: "swarm_members", privileges: ["SELECT", "UPDATE"],
  site: "src/swarm/admin:reviewApplicationAdmin.lock",
  purpose: "Lock the applicant row a rejection is about to fold to inactive.",
  callers: ADMIN_CALLERS,
  probe: { statement: "SELECT id, status FROM swarm_members WHERE id = $1 FOR UPDATE", params: ["probe"] },
});

const rejectMember = registerQuery({
  role: "rm_app", object: "swarm_members", privileges: ["UPDATE", "SELECT"],
  site: "src/swarm/admin:reviewApplicationAdmin.member",
  purpose: "Fold a rejected applicant's member row to inactive.",
  callers: ADMIN_CALLERS,
  probe: {
    statement: "UPDATE swarm_members SET status = 'inactive', version = version + 1, updated_at = now() WHERE id = $1",
    params: ["probe"],
  },
});

const rejectApplication = registerQuery({
  role: "rm_app", object: "swarm_applications", privileges: ["UPDATE", "SELECT"],
  site: "src/swarm/admin:reviewApplicationAdmin.application",
  purpose: "Record the rejection on the member's pending application.",
  callers: ADMIN_CALLERS,
  probe: {
    statement:
      "UPDATE swarm_applications SET status = 'rejected', reviewed_at = now() WHERE member_id = $1 AND status = 'pending'",
    params: ["probe"],
  },
});

const lockMember = registerQuery({
  role: "rm_app", object: "swarm_members", privileges: ["SELECT", "UPDATE"],
  site: "src/swarm/admin:lockMember",
  purpose: "Read and lock a member row before an optimistic-concurrency edit.",
  callers: ADMIN_CALLERS,
  probe: { statement: "SELECT * FROM swarm_members WHERE id = $1 FOR UPDATE", params: ["probe"] },
});

const setMemberRole = registerQuery({
  role: "rm_app", object: "swarm_members", privileges: ["UPDATE", "SELECT"],
  site: "src/swarm/admin:setMemberRoleAdmin.update",
  purpose: "Change a member's duty under its expected version.",
  callers: ADMIN_CALLERS,
  probe: {
    statement:
      "UPDATE swarm_members SET role = $1, version = version + 1, updated_at = now() WHERE id = $2 AND version = $3 RETURNING *",
    params: ["member", "probe", 1],
  },
});

const excuseJudgeFromScheduled = registerQuery({
  role: "rm_app", object: "swarm_session_members", privileges: ["UPDATE", "SELECT"],
  site: "src/swarm/admin:setMemberRoleAdmin.excuse.sessionMembers",
  purpose: "Excuse a newly granted judge from the rosters of sessions not yet collecting.",
  callers: ADMIN_CALLERS,
  probe: {
    statement:
      "UPDATE swarm_session_members sm SET status = 'excused', excused_at = now(), reason = 'member holds judge role' " +
      "FROM swarm_sessions s WHERE sm.session_id = s.id AND sm.member_id = $1 AND s.state = 'scheduled' AND sm.status = 'expected'",
    params: ["probe"],
  },
});
const excuseJudgeFromScheduledSessions = registerQuery({
  role: "rm_app", object: "swarm_sessions", privileges: ["SELECT"],
  site: "src/swarm/admin:setMemberRoleAdmin.excuse.sessions",
  purpose: "Excuse a newly granted judge from the rosters of sessions not yet collecting.",
  callers: ADMIN_CALLERS,
  probe: {
    statement:
      "UPDATE swarm_session_members sm SET status = 'excused', excused_at = now(), reason = 'member holds judge role' " +
      "FROM swarm_sessions s WHERE sm.session_id = s.id AND sm.member_id = $1 AND s.state = 'scheduled' AND sm.status = 'expected'",
    params: ["probe"],
  },
});

const handleTaken = registerQuery({
  role: "rm_app", object: "swarm_members", privileges: ["SELECT"],
  site: "src/swarm/admin:updateMemberAdmin.handleTaken",
  purpose: "Refuse a handle equal to another member's handle or id.",
  callers: ADMIN_CALLERS,
  probe: {
    statement: "SELECT 1 FROM swarm_members WHERE (handle = $1 OR id = $2) AND id <> $3 LIMIT 1",
    params: ["probe", "probe", "probe"],
  },
});

const updateMember = registerQuery({
  role: "rm_app", object: "swarm_members", privileges: ["UPDATE", "SELECT"],
  site: "src/swarm/admin:updateMemberAdmin.update",
  purpose: "Write an edited member profile under its expected version.",
  callers: ADMIN_CALLERS,
  probe: {
    statement:
      "UPDATE swarm_members SET handle = $1, name = $2, lens = $3, contact_email = $4, tagline = $5, mandate = $6, " +
      "biases = $7, voice_md = $8, mode = $9, operator = $10, avatar = $11, version = version + 1, updated_at = now() " +
      "WHERE id = $12 AND version = $13 RETURNING *",
    params: [null, null, null, null, null, null, null, null, null, null, null, "probe", 1],
  },
});

const deactivateMember = registerQuery({
  role: "rm_app", object: "swarm_members", privileges: ["UPDATE", "SELECT"],
  site: "src/swarm/admin:deactivateMemberAdmin.update",
  purpose: "Set a member inactive under its expected version.",
  callers: ADMIN_CALLERS,
  probe: {
    statement:
      "UPDATE swarm_members SET status = 'inactive', version = version + 1, updated_at = now() WHERE id = $1 AND version = $2 RETURNING *",
    params: ["probe", 1],
  },
});

const revokeActiveKeys = registerQuery({
  role: "rm_app", object: "swarm_member_keys", privileges: ["UPDATE", "SELECT"],
  site: "src/swarm/admin:revokeActiveKeys",
  purpose: "Deactivate every active key of a member, on deactivation, reactivation and rotation.",
  callers: ADMIN_CALLERS,
  probe: { statement: "UPDATE swarm_member_keys SET active = false WHERE member_id = $1 AND active = true", params: ["probe"] },
});

const lastMemberKey = registerQuery({
  role: "rm_app", object: "swarm_member_keys", privileges: ["SELECT"],
  site: "src/swarm/admin:reactivateMemberAdmin.lastKey",
  purpose: "Read a member's newest on-file key to carry forward on reactivation.",
  callers: ADMIN_CALLERS,
  probe: {
    statement: "SELECT public_key FROM swarm_member_keys WHERE member_id = $1 ORDER BY created_at DESC LIMIT 1",
    params: ["probe"],
  },
});

const reactivateMember = registerQuery({
  role: "rm_app", object: "swarm_members", privileges: ["UPDATE", "SELECT"],
  site: "src/swarm/admin:reactivateMemberAdmin.update",
  purpose: "Set a member active under its expected version.",
  callers: ADMIN_CALLERS,
  probe: {
    statement:
      "UPDATE swarm_members SET status = 'active', version = version + 1, updated_at = now() WHERE id = $1 AND version = $2 RETURNING *",
    params: ["probe", 1],
  },
});

const lockMemberVersion = registerQuery({
  role: "rm_app", object: "swarm_members", privileges: ["SELECT", "UPDATE"],
  site: "src/swarm/admin:rotateMemberKeyAdmin.lock",
  purpose: "Lock the member row whose key is being rotated.",
  callers: ADMIN_CALLERS,
  probe: { statement: "SELECT id, version FROM swarm_members WHERE id = $1 FOR UPDATE", params: ["probe"] },
});

const priorActiveKey = registerQuery({
  role: "rm_app", object: "swarm_member_keys", privileges: ["SELECT"],
  site: "src/swarm/admin:rotateMemberKeyAdmin.priorKey",
  purpose: "Read a member's active key so a key-less rotation can carry it forward.",
  callers: ADMIN_CALLERS,
  probe: {
    statement: "SELECT public_key FROM swarm_member_keys WHERE member_id = $1 AND active = true ORDER BY created_at DESC LIMIT 1",
    params: ["probe"],
  },
});

const bumpMemberVersion = registerQuery({
  role: "rm_app", object: "swarm_members", privileges: ["UPDATE", "SELECT"],
  site: "src/swarm/admin:rotateMemberKeyAdmin.bump",
  purpose: "Advance a member's version after its key rotated.",
  callers: ADMIN_CALLERS,
  probe: { statement: "UPDATE swarm_members SET version = version + 1, updated_at = now() WHERE id = $1", params: ["probe"] },
});

const setMemberAvatar = registerQuery({
  role: "rm_app", object: "swarm_members", privileges: ["UPDATE", "SELECT"],
  site: "src/swarm/admin:uploadMemberAvatarAdmin.pointer",
  purpose: "Point a member's avatar at the uploaded bytes.",
  callers: ADMIN_CALLERS,
  probe: {
    statement:
      "UPDATE swarm_members SET avatar = $1, version = version + 1, updated_at = now() WHERE id = $2 RETURNING id",
    params: ["{}", "probe"],
  },
});

const upsertAvatarBytes = registerQuery({
  role: "rm_app", object: "swarm_member_avatars", privileges: ["INSERT", "UPDATE", "SELECT"],
  site: "src/swarm/admin:uploadMemberAvatarAdmin.bytes",
  purpose: "Store a member's uploaded avatar bytes, replacing any earlier upload.",
  callers: ADMIN_CALLERS,
  probe: {
    statement:
      "INSERT INTO swarm_member_avatars (member_id, content_type, bytes, byte_size) SELECT $1, $2, $3, $4 WHERE false " +
      "ON CONFLICT (member_id) DO UPDATE SET content_type = EXCLUDED.content_type, bytes = EXCLUDED.bytes, " +
      "byte_size = EXCLUDED.byte_size, uploaded_at = now()",
    params: ["probe", "image/png", "probe", 1],
  },
});

const lockSession = registerQuery({
  role: "rm_app", object: "swarm_sessions", privileges: ["SELECT", "UPDATE"],
  site: "src/swarm/admin:lockSession",
  purpose: "Read and lock a session row before a roster edit.",
  callers: ADMIN_CALLERS,
  probe: { statement: "SELECT id, state FROM swarm_sessions WHERE id = $1 FOR UPDATE", params: [PROBE_UUID] },
});

const readSessionState = registerQuery({
  role: "rm_app", object: "swarm_sessions", privileges: ["SELECT"],
  site: "src/swarm/admin:getSessionJudgementsAdmin.session",
  purpose: "Read a session's state before listing its judgements.",
  callers: ADMIN_CALLERS,
  probe: { statement: "SELECT id, state FROM swarm_sessions WHERE id = $1", params: [PROBE_UUID] },
});

const readRoster = registerQuery({
  role: "rm_app", object: "swarm_session_members", privileges: ["SELECT"],
  site: "src/swarm/admin:getSessionRoster",
  purpose: "Read a session's roster for the admin surface.",
  callers: ADMIN_CALLERS,
  probe: {
    statement:
      "SELECT member_id, member_name, member_lens, status, included_at, excused_at, reason FROM swarm_session_members " +
      "WHERE session_id = $1 ORDER BY member_id",
    params: [PROBE_UUID],
  },
});

const rosterMember = registerQuery({
  role: "rm_app", object: "swarm_members", privileges: ["SELECT"],
  site: "src/swarm/admin:rosterAddAdmin.member",
  purpose: "Read the member a roster add names, for the name, lens and role it snapshots.",
  callers: ADMIN_CALLERS,
  probe: { statement: "SELECT id, name, lens, role FROM swarm_members WHERE id = $1", params: ["probe"] },
});

const rosterInsert = registerQuery({
  role: "rm_app", object: "swarm_session_members", privileges: ["INSERT", "UPDATE", "SELECT"],
  site: "src/swarm/admin:rosterAddAdmin.insert",
  purpose: "Seat a member on a session's roster, restoring it to expected if it was excused.",
  callers: ADMIN_CALLERS,
  probe: {
    statement:
      "INSERT INTO swarm_session_members (session_id, member_id, member_name, member_lens, status) " +
      "SELECT $1, $2, $3, $4, 'expected' WHERE false " +
      "ON CONFLICT (session_id, member_id) DO UPDATE SET status = 'expected', excused_at = NULL",
    params: [PROBE_UUID, "probe", "probe", null],
  },
});

const rosterExcuse = registerQuery({
  role: "rm_app", object: "swarm_session_members", privileges: ["UPDATE", "SELECT"],
  site: "src/swarm/admin:rosterExcuseAdmin.update",
  purpose: "Excuse a member from a session's roster.",
  callers: ADMIN_CALLERS,
  probe: {
    statement:
      "UPDATE swarm_session_members SET status = 'excused', excused_at = now() WHERE session_id = $1 AND member_id = $2 RETURNING member_id",
    params: [PROBE_UUID, "probe"],
  },
});

const rosterRestore = registerQuery({
  role: "rm_app", object: "swarm_session_members", privileges: ["UPDATE", "SELECT"],
  site: "src/swarm/admin:rosterRestoreAdmin.update",
  purpose: "Restore an excused member to a session's roster.",
  callers: ADMIN_CALLERS,
  probe: {
    statement:
      "UPDATE swarm_session_members SET status = 'expected', excused_at = NULL WHERE session_id = $1 AND member_id = $2 RETURNING member_id",
    params: [PROBE_UUID, "probe"],
  },
});

const listAudit = registerQuery({
  role: "rm_app", object: "audit_log", privileges: ["SELECT"],
  site: "src/swarm/admin:listAuditLog",
  purpose: "Read the audit log, filtered by any of actor, action and a time range, newest first.",
  callers: ADMIN_CALLERS,
  probe: {
    statement:
      "SELECT id, actor, action, scope, at FROM audit_log WHERE ($1::text IS NULL OR actor = $2) " +
      "AND ($3::text IS NULL OR action = $4) AND ($5::timestamptz IS NULL OR at >= $6) " +
      "AND ($7::timestamptz IS NULL OR at <= $8) ORDER BY at DESC LIMIT $9",
    params: [null, null, null, null, null, null, null, null, 1],
  },
});

type Actor = string;
export const ADMIN_ACTOR = "admin";

// ── Shared result shape ──────────────────────────────────────────────────
export interface AdminResult<T = Record<string, unknown>> {
  ok: boolean;
  status: number;
  error?: string;
  [key: string]: unknown;
}

function err(status: number, error: string): AdminResult {
  return { ok: false, status, error };
}

async function audit(actor: Actor, action: string, scope: Record<string, unknown>, tx: DbHandle = sql) {
  await on(tx, auditInsert)`INSERT INTO audit_log (actor, action, scope) VALUES (${actor}, ${action}, ${tx.json(scope as any)})`;
}

// ── Redacted projections (never expose key_hash/token_hash/public_key) ────
function toSubjectAdmin(row: Record<string, any>) {
  return {
    id: row.id,
    status: row.status,
    version: Number(row.version),
    name: row.name,
    operator: row.operator ?? null,
    homepage: row.homepage ?? null,
    xHandle: row.x_handle ?? null,
    thesisBlurb: row.thesis_blurb ?? null,
    wallets: row.wallets ?? null,
    nftContracts: row.nft_contracts ?? null,
    source: row.source ?? null,
    recommendationType: row.recommendation_type ?? null,
    linkedMemberId: row.linked_member_id ?? null,
    structuralNotes: row.structural_notes ?? null,
    lastReviewed: row.last_reviewed ?? null,
    // The subject's three scheduling columns (scheduler spec §2.2, D53 (7)).
    // Surfaced on every admin read because §2.3 makes this route the only way
    // they change, and an operator cannot change a value the surface never
    // shows.
    epochDuration: row.epoch_duration_seconds != null ? Number(row.epoch_duration_seconds) : null,
    epochAnchor: row.epoch_anchor != null ? new Date(row.epoch_anchor).toISOString() : null,
    judgingDurationSeconds: row.judging_duration_seconds != null ? Number(row.judging_duration_seconds) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Every editable column is projected (issue #567): the admin edit form cannot
// prefill — and the admin page cannot diff — what this does not return. Still
// no key material: key_hash/token_hash/public_key are never projected here.
//
// The `: AdminMember` annotation is load-bearing (issue #572). Without it,
// #571 widened this literal by five fields while contract/src/admin.d.ts kept
// declaring twelve, and nothing anywhere went red — the contract is a `.d.ts`,
// which `skipLibCheck: true` excuses from every typecheck in the repo. With it,
// the returned object literal is contextually typed, so TypeScript's
// excess-property check fails backend.yml's typecheck on the next undeclared
// field. That check is path-gated on `backend/**` and is a typecheck rather
// than a test, so it is the SECOND line only; the enforcing guard is
// scripts/tests/unit/admin-member-contract-parity.test.ts, which runs
// unconditionally on every PR.
function toMemberAdmin(row: Record<string, any>): AdminMember {
  return {
    // Both names, always (issue #593): `id` is what every child row and every
    // signature is keyed on and is NOT editable here; `handle` is the public
    // one the form below may rewrite. An admin page that showed only one of
    // them could not tell an operator which is which.
    id: row.id,
    handle: row.handle ?? row.id,
    status: row.status,
    role: row.role ?? "member",
    version: Number(row.version),
    name: row.name,
    tagline: row.tagline ?? null,
    lens: row.lens ?? null,
    mandate: row.mandate ?? null,
    biases: row.biases ?? null,
    voiceMd: row.voice_md ?? null,
    mode: row.mode ?? null,
    operator: row.operator ?? null,
    avatar: row.avatar ?? null,
    contactEmail: row.contact_email ?? null,
    appliedAt: row.applied_at ?? null,
    activatedAt: row.activated_at ?? null,
    updatedAt: row.updated_at,
  };
}

// ── Topics (swarm_subjects) ─────────────────────────────────────────────
export interface SubjectInput {
  id: string;
  name: string;
  operator?: string;
  homepage?: string;
  xHandle?: string;
  thesisBlurb?: string;
  wallets?: unknown;
  nftContracts?: unknown;
  source?: unknown;
  recommendationType?: string;
  linkedMemberId?: string;
  structuralNotes?: unknown;
  lastReviewed?: string;
  // The three scheduling columns (scheduler spec §2.2, D53 (7)). Typed
  // `unknown` because they arrive straight off a request body and are
  // validated here, in this module, with refusals that name the field. Omitted
  // on create means the schema default; present-but-null is refused (§2.4).
  /** Grid spacing in seconds — the length of every full window. */
  epochDuration?: unknown;
  /** One instant on the grid, as an ISO-8601 timestamp with a zone. */
  epochAnchor?: unknown;
  /** Seconds judging waits for a consensus once requested (§4.4). */
  judgingDurationSeconds?: unknown;
}

export async function listSubjectsAdmin() {
  const rows = await on(sql, listSubjects)<Row>`SELECT * FROM swarm_subjects ORDER BY id`;
  return rows.map(toSubjectAdmin);
}

export async function createSubjectAdmin(input: SubjectInput, actor: Actor = ADMIN_ACTOR): Promise<AdminResult> {
  const existing = (await on(sql, subjectExists)`SELECT id FROM swarm_subjects WHERE id = ${input.id}`)[0];
  if (existing) return err(409, "subject id already exists");
  const refused = schedulingRefusal(input);
  if (refused) return refused;
  // ONE TRANSACTION, because a created subject is an ACTIVE subject and §6.2
  // makes activation a `subject.changed` event the scheduler acts on by opening
  // that subject's first epoch. A create that committed without its event would
  // leave an active subject the clock never hears about until its next rebuild.
  return sql.begin(async (tx) => {
    let rows = await on(tx, insertSubject)<Row>`
      INSERT INTO swarm_subjects
        (id, status, name, operator, homepage, x_handle, thesis_blurb, wallets, nft_contracts,
         source, recommendation_type, linked_member_id, structural_notes, last_reviewed)
      VALUES
        (${input.id}, 'active', ${input.name}, ${input.operator ?? null}, ${input.homepage ?? null},
         ${input.xHandle ?? null}, ${input.thesisBlurb ?? null}, ${tx.json((input.wallets ?? null) as any)},
         ${tx.json((input.nftContracts ?? null) as any)}, ${tx.json((input.source ?? null) as any)},
         ${input.recommendationType ?? null}, ${input.linkedMemberId ?? null},
         ${tx.json((input.structuralNotes ?? null) as any)}, ${input.lastReviewed ?? null})
      RETURNING *`;
    // The three scheduling columns take their column defaults on the insert.
    // A create request that names any of them applies them here, in the same
    // transaction, over those defaults (a column left out keeps its default).
    if (input.epochDuration !== undefined || input.epochAnchor !== undefined || input.judgingDurationSeconds !== undefined) {
      rows = await on(tx, setSubjectScheduling)<Row>`
        UPDATE swarm_subjects SET
          epoch_duration_seconds = COALESCE(${(input.epochDuration as number | undefined) ?? null}, epoch_duration_seconds),
          epoch_anchor = COALESCE(${(input.epochAnchor as string | undefined) ?? null}::text::timestamptz, epoch_anchor),
          judging_duration_seconds = COALESCE(${(input.judgingDurationSeconds as number | undefined) ?? null}, judging_duration_seconds)
        WHERE id = ${input.id}
        RETURNING *`;
    }
    await appendStreamEvent(tx, "subject.changed", {
      subjectId: input.id,
      payload: { reason: "activated", ...schedulingPayload(rows[0]) },
    });
    await audit(actor, "subject_create", { subjectId: input.id }, tx);
    return { ok: true, status: 201, subject: toSubjectAdmin(rows[0]) };
  });
}

/**
 * A whole, positive number of seconds — the only shape a duration may take
 * (scheduler spec §2.2/§2.4, migrations 0085 and 0090's CHECKs).
 */
function isPositiveWholeSeconds(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

/**
 * An instant with an explicit zone. An anchor without one would be read in
 * whatever time zone the connection happened to have: two grids for one input.
 */
const INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;
function isInstant(v: unknown): v is string {
  return typeof v === "string" && INSTANT_RE.test(v) && !Number.isNaN(Date.parse(v));
}

/**
 * The refusal for a scheduling column that is present and wrong, or null.
 *
 * `undefined` means "not supplied" and is never refused. Anything else must be
 * the column's shape: §2.4 says there is no on/off state for scheduling, so a
 * `null`, a zero or a negative duration is not "disabled" — it is refused here
 * with the field named, before the write, rather than surfacing as a 23514
 * from the column's CHECK.
 */
function schedulingRefusal(
  input: { epochDuration?: unknown; epochAnchor?: unknown; judgingDurationSeconds?: unknown },
): AdminResult | null {
  if (input.epochDuration !== undefined && !isPositiveWholeSeconds(input.epochDuration)) {
    return err(400, "epochDuration must be a positive whole number of seconds");
  }
  if (input.judgingDurationSeconds !== undefined && !isPositiveWholeSeconds(input.judgingDurationSeconds)) {
    return err(400, "judgingDurationSeconds must be a positive whole number of seconds");
  }
  if (input.epochAnchor !== undefined && !isInstant(input.epochAnchor)) {
    return err(400, "epochAnchor must be an ISO-8601 timestamp with a zone (e.g. 2026-01-01T22:45:00Z)");
  }
  return null;
}

/** The scheduling columns as `subject.changed` carries them — what the scheduler re-reads (§6.2). */
function schedulingPayload(row: Record<string, any>) {
  return {
    epochDurationSeconds: Number(row.epoch_duration_seconds),
    epochAnchor: new Date(row.epoch_anchor).toISOString(),
    judgingDurationSeconds: Number(row.judging_duration_seconds),
  };
}

export type SubjectPatch = Partial<Omit<SubjectInput, "id">>;

export async function updateSubjectAdmin(
  id: string,
  expectedVersion: number,
  patch: SubjectPatch,
  actor: Actor = ADMIN_ACTOR,
): Promise<AdminResult> {
  // Refused before the transaction: a wrong value is wrong whatever the row says.
  const refused = schedulingRefusal(patch);
  if (refused) return refused;
  return sql.begin(async (tx) => {
    // `FOR NO KEY UPDATE`, not `FOR UPDATE`: a take in flight holds its
    // session row and needs a key-share lock on this row for its foreign key,
    // and this transaction may go on to write that session (the rename
    // backfill below). `FOR UPDATE` would refuse the take its key share and
    // deadlock the two.
    const row = (await on(tx, lockSubject)<Row>`SELECT * FROM swarm_subjects WHERE id = ${id} FOR NO KEY UPDATE`)[0];
    if (!row) return err(404, "subject not found");
    if (Number(row.version) !== expectedVersion) return err(409, "stale_version");

    // §2.2 DURATION CHANGE: "Changing `epoch_duration` through the admin API
    // also sets `epoch_anchor` to the current window's `window_closes_at`, in
    // the same transaction; a subject with no open window keeps its anchor."
    // The current window keeps the close it was opened with, and the grid
    // continues from that close with the new spacing (§6.2). An anchor the
    // operator names in the SAME request is what they asked for, and wins.
    // Read as text so the anchor is that close to the microsecond.
    const durationChanged = patch.epochDuration !== undefined &&
      Number(patch.epochDuration) !== Number(row.epoch_duration_seconds);
    let anchor: string | null = patch.epochAnchor !== undefined ? (patch.epochAnchor as string) : null;
    if (anchor === null && durationChanged) {
      const [open] = await on(tx, openCollectingClose)<{ closes: string | null }>`
        SELECT window_closes_at::text AS closes FROM swarm_sessions
         WHERE subject_id = ${id} AND state = 'collecting'`;
      anchor = open?.closes ?? null;
    }
    const merged = {
      name: patch.name ?? row.name,
      operator: patch.operator ?? row.operator,
      homepage: patch.homepage ?? row.homepage,
      x_handle: patch.xHandle ?? row.x_handle,
      thesis_blurb: patch.thesisBlurb ?? row.thesis_blurb,
      wallets: patch.wallets !== undefined ? patch.wallets : row.wallets,
      nft_contracts: patch.nftContracts !== undefined ? patch.nftContracts : row.nft_contracts,
      source: patch.source !== undefined ? patch.source : row.source,
      recommendation_type: patch.recommendationType ?? row.recommendation_type,
      linked_member_id: patch.linkedMemberId ?? row.linked_member_id,
      structural_notes: patch.structuralNotes !== undefined ? patch.structuralNotes : row.structural_notes,
      last_reviewed: patch.lastReviewed ?? row.last_reviewed,
      epoch_duration_seconds: (patch.epochDuration as number | undefined) ?? row.epoch_duration_seconds,
      judging_duration_seconds: (patch.judgingDurationSeconds as number | undefined) ?? row.judging_duration_seconds,
    };
    const upd = await on(tx, updateSubject)<Row>`
      UPDATE swarm_subjects SET
        name = ${merged.name}, operator = ${merged.operator}, homepage = ${merged.homepage},
        x_handle = ${merged.x_handle}, thesis_blurb = ${merged.thesis_blurb},
        wallets = ${tx.json(merged.wallets as any)}, nft_contracts = ${tx.json(merged.nft_contracts as any)},
        source = ${tx.json(merged.source as any)}, recommendation_type = ${merged.recommendation_type},
        linked_member_id = ${merged.linked_member_id}, structural_notes = ${tx.json(merged.structural_notes as any)},
        last_reviewed = ${merged.last_reviewed}, epoch_duration_seconds = ${merged.epoch_duration_seconds},
        epoch_anchor = COALESCE(${anchor}::text::timestamptz, epoch_anchor),
        judging_duration_seconds = ${merged.judging_duration_seconds},
        version = version + 1, updated_at = now()
      WHERE id = ${id} AND version = ${expectedVersion}
      RETURNING *`;
    if (upd.length === 0) return err(409, "stale_version");

    // subject_name is denormalized onto swarm_sessions (migration
    // 0001_backends.sql) and nothing else backfills it, so a rename that
    // stops at swarm_subjects leaves every past session displaying the old
    // name on member track records (issue #779). Backfilling here, inside
    // the same transaction as the swarm_subjects UPDATE above, makes the
    // rename atomic across both places the name is stored.
    if (patch.name != null && patch.name !== row.name) {
      await on(tx, renameSessions)`UPDATE swarm_sessions SET subject_name = ${merged.name} WHERE subject_id = ${id}`;
    }

    // Scheduler spec §6.2: `subject.changed` — "a scheduling column changed,
    // or subject activated / deactivated". Published for ANY subject edit, not
    // only a duration change: the scheduler's documented reaction is to re-read
    // the subject, and deciding here which fields it cares about would make
    // this function the second place that knowledge lives. Written inside the
    // same transaction as the edit (§9), so the clock is never told about a
    // change that rolled back.
    await appendStreamEvent(tx, "subject.changed", {
      subjectId: id,
      payload: { reason: "updated", ...schedulingPayload(upd[0]) },
    });
    await audit(actor, "subject_update", { subjectId: id }, tx);
    return { ok: true, status: 200, subject: toSubjectAdmin(upd[0]) };
  });
}

/**
 * Deactivate a subject: `active → inactive`, versioned.
 *
 * A SUBJECT EDIT, AND NOTHING ELSE (D55 (4) as corrected 2026-09-25: "the
 * window runs to its close"). It sets the subject inactive, publishes
 * `subject.changed` with reason `deactivated`, and writes its audit row — in
 * one transaction (§9), so the clock is never told about a deactivation that
 * rolled back and never misses one that committed. It CLOSES NOTHING:
 *
 *   * the open window stays `collecting` until its grid boundary and accepts
 *     takes until `window_closes_at` (§4.2, §4.5);
 *   * at that boundary `system-scheduler` turns the epoch over as usual —
 *     the turnover closes and settles N and opens no N+1, because the subject
 *     is inactive (domain.ts `turnOverEpoch`);
 *   * a reactivation inside that window opens nothing, because the subject
 *     still has its `collecting` session.
 *
 * A close here would be the admin early close D55 (4) forbids, and a
 * deactivate-then-activate pair would be the banned early turnover in two
 * calls.
 */
export async function deactivateSubjectAdmin(
  id: string,
  expectedVersion: number,
  actor: Actor = ADMIN_ACTOR,
): Promise<AdminResult> {
  return sql.begin(async (tx) => {
    // `FOR NO KEY UPDATE` for updateSubjectAdmin's reason, and so a boundary
    // turnover of this subject (which takes the same lock) reads the status
    // either before or after this edit, never half of it.
    const row = (await on(tx, lockSubject)<Row>`SELECT * FROM swarm_subjects WHERE id = ${id} FOR NO KEY UPDATE`)[0];
    if (!row) return err(404, "subject not found");
    if (Number(row.version) !== expectedVersion) return err(409, "stale_version");
    const upd = await on(tx, deactivateSubject)<Row>`
      UPDATE swarm_subjects SET status = 'inactive', version = version + 1, updated_at = now()
      WHERE id = ${id} AND version = ${expectedVersion}
      RETURNING *`;
    if (upd.length === 0) return err(409, "stale_version");
    // §6.2: on deactivation the scheduler keeps the open session's boundary
    // timer, so the boundary turns it over with no successor (§4.5). The
    // event carries no closed epoch, because none closed.
    await appendStreamEvent(tx, "subject.changed", {
      subjectId: id,
      payload: { reason: "deactivated" },
    });
    await audit(actor, "subject_deactivate", { subjectId: id }, tx);
    return { ok: true, status: 200, subject: toSubjectAdmin(upd[0]) };
  });
}

/**
 * Re-activate a subject: `inactive → active`, versioned like deactivate.
 *
 * A SUBJECT EDIT, NOT AN EPOCH ROUTE (D55 (4)). Scheduler spec §3: "A first
 * epoch is opened by the rebuild, or by the scheduler on an activation's
 * `subject.changed`, and by nothing else." So this flips the status and
 * publishes `subject.changed` with reason `activated`, and opens NO session.
 * When the subject has no `collecting` session, `system-scheduler` opens its
 * first epoch from the event through `openEpoch`, which places the window on
 * the subject's grid. When it still has one — a reactivation inside the window
 * a deactivation left running (§4.5) — nothing opens, and that window's
 * boundary opens N+1 as usual. An admin path that opened the epoch itself
 * would be the operator lifecycle lever D55 removed.
 *
 * Same transaction as the status flip (§9): the clock is never told about an
 * activation that rolled back, and never misses one that committed.
 *
 * Refusals: 404 for an unknown subject, 409 `stale_version` for a version the
 * caller did not read, 409 `already_active` for a subject that is active —
 * re-publishing the event for it would ask the scheduler to open an epoch it
 * already holds.
 */
export async function activateSubjectAdmin(
  id: string,
  expectedVersion: number,
  actor: Actor = ADMIN_ACTOR,
): Promise<AdminResult> {
  return sql.begin(async (tx) => {
    const row = (await on(tx, lockSubject)<Row>`SELECT * FROM swarm_subjects WHERE id = ${id} FOR NO KEY UPDATE`)[0];
    if (!row) return err(404, "subject not found");
    if (Number(row.version) !== expectedVersion) return err(409, "stale_version");
    if (row.status === "active") return err(409, "already_active");
    const upd = await on(tx, activateSubject)<Row>`
      UPDATE swarm_subjects SET status = 'active', version = version + 1, updated_at = now()
      WHERE id = ${id} AND version = ${expectedVersion}
      RETURNING *`;
    if (upd.length === 0) return err(409, "stale_version");
    await appendStreamEvent(tx, "subject.changed", {
      subjectId: id,
      payload: { reason: "activated", ...schedulingPayload(upd[0]) },
    });
    await audit(actor, "subject_activate", { subjectId: id }, tx);
    return { ok: true, status: 200, subject: toSubjectAdmin(upd[0]) };
  });
}

// ── Members ─────────────────────────────────────────────────────────────────
export async function listMembersAdmin() {
  const rows = await on(sql, listMembers)<Row>`SELECT * FROM swarm_members ORDER BY id`;
  return rows.map(toMemberAdmin);
}

// ── Silence flags (issue #563) ──────────────────────────────────────────────
// A member can complete onboarding, go `active`, and then never submit a
// take — or submit for a while and then go quiet — while every liveness
// signal (status='active', no swarm_agent_health_events row) still reads
// healthy. Computed on read from the same eligibility record closeWindow()'s
// absence bookkeeping already trusts (domain.ts): swarm_session_members is
// what makes a session count toward N at all — a session the member was
// never seated in is not silence, it never happened for them (issue #563,
// "distinguish silence from exclusion") — and an EXCUSED row is dropped from
// the count for the same reason closeWindow() drops it from its own absence
// tally: an excusal is the roster saying this member was not expected, not
// the member saying nothing.
//
// N is how many such eligible sessions must pass before this fires — the
// issue leaves N uncalibrated ("Suggested starting shape" names it only as
// `$1`). Chosen here, not inline, so it is one place to tune:
export const SWARM_SILENCE_THRESHOLD_SESSIONS = 5;
// Five is deliberately more than one: "do not fire on single-session
// absence" is an explicit constraint, and a single miss is not evidence of
// anything — an agent restarting, a slow first boot, a brief's window
// closing early (#570) are all ordinary. Five misses in a row is not
// ordinary, and at the swarm's roughly-daily cadence it still surfaces the
// problem within about a week rather than the ~19-session gap that is what
// this issue was actually filed over (#558) — an operator finds out from the
// admin list, not from reading a transcript months later.

export type MemberSilenceFlagType = "never_submitted" | "gone_quiet";

export interface MemberSilenceFlag {
  type: MemberSilenceFlagType;
  /** Eligible (seated, non-excused) sessions since the reference point:
   * activation for `never_submitted`, the member's own latest take for
   * `gone_quiet`. Always >= SWARM_SILENCE_THRESHOLD_SESSIONS. */
  sessionsSinceReference: number;
}

// Two DISJOINT queries, both gated on SWARM_SILENCE_THRESHOLD_SESSIONS:
//   - never_submitted: the issue's core, required scope — the #558 case.
//     Reuses the issue's own suggested shape almost verbatim, with `s.created_at`
//     read as `s.convened_at` (swarm_sessions has no created_at; convened_at is
//     "the real identity, set when the session actually convenes" — migration
//     0022) and an added `sm.status != 'excused'` filter (see header comment).
//   - gone_quiet: the issue's "Worth extending" note — an established member
//     (>= 1 take on file) with nothing in the N eligible sessions since its
//     OWN latest one. The window is anchored to the member's last take rather
//     than to `now`, so it fires on N consecutive misses at any point in a
//     long history, not only on the N most recent sessions system-wide.
// A member can only ever match one: gone_quiet requires a prior take to
// measure "since"; never_submitted requires there to be none. Callers key the
// result by member_id, so listMembersAdmin() and this can run in parallel and
// merge without either wondering whether the other assigned the same member
// two answers.
export async function getMemberSilenceFlags(tx: DbHandle = sql): Promise<Record<string, MemberSilenceFlag>> {
  const neverSubmitted = await on(tx, neverSubmittedSessionMembers, neverSubmittedSessions, neverSubmittedMembers, neverSubmittedTakes)<{ member_id: string; sessions_seen: number }>`
    WITH eligible AS (
      SELECT sm.member_id, count(*)::int AS sessions_seen
      FROM swarm_session_members sm
      JOIN swarm_sessions s ON s.id = sm.session_id
      JOIN swarm_members m  ON m.id = sm.member_id
      WHERE m.status = 'active' AND m.role = 'member'
        AND sm.status != 'excused'
        AND s.convened_at > m.activated_at
      GROUP BY sm.member_id
    )
    SELECT e.member_id, e.sessions_seen
    FROM eligible e
    WHERE e.sessions_seen >= ${SWARM_SILENCE_THRESHOLD_SESSIONS}
      AND NOT EXISTS (SELECT 1 FROM swarm_recommendations r WHERE r.member_id = e.member_id)`;

  const goneQuiet = await on(tx, goneQuietSessionMembers, goneQuietTakes, goneQuietSessions, goneQuietMembers)<{ member_id: string; sessions_seen: number }>`
    WITH last_take AS (
      SELECT r.member_id, max(s.convened_at) AS last_take_at
      FROM swarm_recommendations r
      JOIN swarm_sessions s ON s.id = r.session_id
      GROUP BY r.member_id
    )
    SELECT sm.member_id, count(*)::int AS sessions_seen
    FROM swarm_session_members sm
    JOIN swarm_sessions s ON s.id = sm.session_id
    JOIN swarm_members m  ON m.id = sm.member_id
    JOIN last_take lt      ON lt.member_id = sm.member_id
    WHERE m.status = 'active' AND m.role = 'member'
      AND sm.status != 'excused'
      AND s.convened_at > lt.last_take_at
    GROUP BY sm.member_id
    HAVING count(*) >= ${SWARM_SILENCE_THRESHOLD_SESSIONS}`;

  const flags: Record<string, MemberSilenceFlag> = {};
  for (const row of neverSubmitted) {
    flags[row.member_id] = { type: "never_submitted", sessionsSinceReference: Number(row.sessions_seen) };
  }
  for (const row of goneQuiet) {
    flags[row.member_id] = { type: "gone_quiet", sessionsSinceReference: Number(row.sessions_seen) };
  }
  return flags;
}

export async function listApplicationsAdmin(status?: string) {
  const rows = status
    ? await on(sql, listApplicationsByStatus)`SELECT id, member_id, status, created_at, reviewed_at FROM swarm_applications WHERE status = ${status} ORDER BY created_at DESC`
    : await on(sql, listApplications)`SELECT id, member_id, status, created_at, reviewed_at FROM swarm_applications ORDER BY created_at DESC`;
  return rows;
}

// NO `memberId` (issue #690). The id is minted by addMemberAdmin below, exactly
// as applyMember mints it for the public front door, and there is no way to ask
// for a particular one. The route's parser (parseManualMember) REFUSES a body
// that still carries the field rather than dropping it, so no client is told
// "201 created" about an id it did not get back.
export interface ManualMemberInput {
  name: string;
  publicKey: string;
  lens?: string;
  contact?: string;
}

// The 409 this path answers a duplicate credential with (issue #690). See the
// probe below for why the public key is what "duplicate" now means here.
export const MANUAL_MEMBER_KEY_CONFLICT =
  "publicKey already belongs to a member; rotate that member's key instead of adding a second one";

// Admin manual add: creates an ACTIVE member + ACTIVE key + one-time bearer
// token in a single transaction, bypassing the public apply/activate flow.
// The token is returned ONLY in this response — never persisted or re-readable.
export async function addMemberAdmin(input: ManualMemberInput, actor: Actor = ADMIN_ACTOR): Promise<AdminResult> {
  // THE ID IS MINTED HERE (issue #690), never supplied. Until #690 this route
  // INSERTed a caller-supplied string as the primary key, which is how members
  // whose id is a human slug came to exist — and a slug id is not cosmetic:
  // migration 0031 refuses a handle equal to ANOTHER member's id (so an id of
  // `woon` bars the member actually named Woon from ever holding `woon`), and
  // migration 0030's `handle = id` sentinel makes such a member read as
  // "handle unset" forever, re-derived at every acceptance. `crypto.randomUUID()`
  // is the same mint applyMember uses (domain.ts), so both admission paths now
  // produce ids of one shape and the public `handle` is the only readable name.
  const memberId = crypto.randomUUID();
  // UNIQUENESS. The old probe asked whether the caller's chosen id was already
  // taken as an id or a handle. With a freshly minted UUID neither question has
  // an answer worth asking, so duplicate detection moves to the one thing the
  // caller still names that IS an identity: the public key. Two members sharing
  // a key make every signed take ambiguous about who produced it, and the same
  // refusal already guards the public path (applyMember). It is also what keeps
  // the realistic accident — an operator submitting the add form twice — a 409
  // rather than two members with one credential between them.
  const existingKey = (await on(sql, keyOwner)<{ member_id: string }>`
    SELECT member_id FROM swarm_member_keys WHERE public_key = ${input.publicKey} LIMIT 1`)[0];
  if (existingKey) return err(409, MANUAL_MEMBER_KEY_CONFLICT);
  const token = `tok_${memberId}_${crypto.randomUUID()}`;
  try {
    return await sql.begin(async (tx) => {
      // Capacity gate: a brand-new active member must fit under SWARM_ROSTER_CAP.
      const cap = await assertRosterCapacity(tx);
      if (!cap.ok) return err(cap.status, cap.error);
      // The INSERT names NO handle, so migration 0030's trigger stamps
      // `handle := id` — the UUID — and the UPDATE two statements below moves it
      // to the name-derived handle. Before #690 that two-step also served as a
      // physical guard: `handle = id` put the create inside
      // swarm_members_handle_key against a concurrent uncommitted rename TO the
      // caller's chosen id (#596). That guard is now moot, because nobody
      // renames a member to a freshly minted UUID — the only handle this create
      // can contend for is the DERIVED one, and it contends for it in the
      // UPDATE, which is where the catch below picks the loser up.
      await on(tx, insertManualMember)`
        INSERT INTO swarm_members (id, status, name, lens, contact_email, applied_at, activated_at)
        VALUES (${memberId}, 'active', ${input.name}, ${input.lens ?? null}, ${input.contact ?? null}, now(), now())`;
      // Issue #562: the manual add seats an ACTIVE member in one shot, so it is
      // its own derivation point — nothing accepts this member later. Unchanged
      // by #690: the id it derives FOR is now a UUID rather than an operator's
      // string, but the handle is still `slugifyMemberName(name)` plus the
      // lowest free numeric suffix, and the id remains the immutable identity
      // that keeps resolving as a public reference (getMember reads both names).
      const handle = await deriveMemberHandle(tx, { memberId, name: input.name });
      const derived = await on(tx, setMemberHandle)<Row>`
        UPDATE swarm_members SET handle = ${handle} WHERE id = ${memberId} RETURNING *`;
      await on(tx, insertMemberKey)`INSERT INTO swarm_member_keys (member_id, public_key, active, token_hash)
               VALUES (${memberId}, ${input.publicKey}, true, ${hashKey(token)})`;
      await audit(actor, "member_manual_add", { memberId, handle }, tx);
      return { ok: true, status: 201, member: toMemberAdmin(derived[0]), token };
    });
  } catch (e) {
    // deriveMemberHandle's probe is a READ COMMITTED snapshot, so it cannot see
    // a rename that commits between it and the UPDATE above. The loser of that
    // race is refused by swarm_members_handle_key (or 0031's trigger) and gets
    // the SAME sentence the rename path's lost race gets, because it is the
    // same situation from the other side: the public name is gone, try again
    // (a retry re-derives and takes the next free suffix). Anything else
    // rethrows untouched rather than being described as a naming conflict.
    if (isHandleUniqueViolation(e)) return err(409, "handle already taken");
    throw e;
  }
}

export async function reviewApplicationAdmin(
  memberId: string,
  decision: "approve" | "reject",
  actor: Actor = ADMIN_ACTOR,
  role: MemberRole = "member",
): Promise<AdminResult> {
  if (decision === "approve") {
    // Reuse the SAME activation transaction the public path uses. Approval
    // activates the pending key and flips status active; bearer plaintext is
    // minted only by the member's first signed claim.
    const res = await activateMember(memberId, role);
    if (!res.ok) return res as AdminResult;
    return {
      ok: true,
      status: 200,
      memberId,
      memberStatus: "active",
      role,
      claimRequired: true,
    };
  }
  return sql.begin(async (tx) => {
    const row = (await on(tx, lockMemberStatus)<Row>`SELECT id, status FROM swarm_members WHERE id = ${memberId} FOR UPDATE`)[0];
    if (!row) return err(404, "no such applicant");
    if (row.status !== "applied") return err(409, `cannot reject a member in status=${row.status}`);
    // swarm_members.status has no 'rejected' value (CHECK constraint from
    // #150's migration 0017_admin_surface.sql only allows applied/active/
    // inactive) — the rejection itself is recorded on the APPLICATION; the
    // member row folds to 'inactive', its key stays inactive (never issued).
    await on(tx, rejectMember)`UPDATE swarm_members SET status = 'inactive', version = version + 1, updated_at = now() WHERE id = ${memberId}`;
    await on(tx, rejectApplication)`UPDATE swarm_applications SET status = 'rejected', reviewed_at = now() WHERE member_id = ${memberId} AND status = 'pending'`;
    await audit(actor, "member_reject", { memberId }, tx);
    return { ok: true, status: 200, memberId, memberStatus: "inactive", applicationStatus: "rejected" };
  });
}

export type MemberRole = "member" | "judge";

/** Change an existing member's duty without issuing a new credential. */
export async function setMemberRoleAdmin(
  memberId: string,
  expectedVersion: number,
  role: MemberRole,
  actor: Actor = ADMIN_ACTOR,
): Promise<AdminResult> {
  return sql.begin(async (tx) => {
    const row = (await on(tx, lockMember)<Row>`SELECT * FROM swarm_members WHERE id = ${memberId} FOR UPDATE`)[0];
    if (!row) return err(404, "member not found");
    if (Number(row.version) !== expectedVersion) return err(409, "stale_version");
    if (row.status !== "active") return err(409, "only active members may hold the judge role");
    if (row.role === role) return { ok: true, status: 200, member: toMemberAdmin(row) };
    const upd = await on(tx, setMemberRole)<Row>`
      UPDATE swarm_members SET role = ${role}, version = version + 1, updated_at = now()
      WHERE id = ${memberId} AND version = ${expectedVersion}
      RETURNING *`;
    if (upd.length === 0) return err(409, "stale_version");
    // Scheduled rosters are still mutable, so the standing no-take rule is
    // reflected immediately. Later rosters are historical snapshots.
    if (role === "judge") {
      await on(tx, excuseJudgeFromScheduled, excuseJudgeFromScheduledSessions)`
        UPDATE swarm_session_members sm SET status = 'excused', excused_at = now(), reason = 'member holds judge role'
        FROM swarm_sessions s
        WHERE sm.session_id = s.id AND sm.member_id = ${memberId} AND s.state = 'scheduled' AND sm.status = 'expected'`;
    }
    await audit(actor, role === "judge" ? "member_grant_judge" : "member_revoke_judge", { memberId, role }, tx);
    return { ok: true, status: 200, member: toMemberAdmin(upd[0]) };
  });
}

// The admin-editable member surface. `undefined` means "absent, leave it
// alone"; an explicit `null` means "CLEAR this column". `name` has no null —
// swarm_members.name is NOT NULL. Validated by validateMemberAdminPatch in
// api/validation.ts, which is the only thing allowed to construct one of these
// from an untrusted body.
export interface MemberAdminPatch {
  /** Public URL segment (issue #593). Never null — a member always has one. */
  handle?: string;
  name?: string;
  lens?: string | null;
  contactEmail?: string | null;
  tagline?: string | null;
  mandate?: string | null;
  biases?: string[] | null;
  voiceMd?: string | null;
  mode?: string | null;
  operator?: string | null;
  avatar?: Record<string, unknown> | null;
}

// The member counterpart to updateSubjectAdmin: same optimistic-concurrency
// contract (FOR UPDATE, expectedVersion, 409 stale_version), same audit row.
//
// This is the ONLY write path that can correct name/lens/contact_email on a
// seated member — the self-service profile route (#325) deliberately refuses
// all three, which is right for the member and useless to the operator who has
// to fix what an agent submitted at apply time.
//
// Deliberately NOT here: no status change (deactivate/reactivate own that), no
// key or credential change (rotate-key owns that).
export async function updateMemberAdmin(
  memberId: string,
  expectedVersion: number,
  patch: MemberAdminPatch,
  actor: Actor = ADMIN_ACTOR,
  reason?: string,
): Promise<AdminResult> {
  try {
    return await updateMemberAdminTx(memberId, expectedVersion, patch, actor, reason);
  } catch (e) {
    // The probe inside the transaction is a READ COMMITTED snapshot, so it
    // cannot see a rename that commits between it and the UPDATE. Since #597
    // the database refuses that write too (0030's unique index for handle vs
    // handle, 0031's trigger for handle vs another member's id), and the loser
    // of the race deserves the same actionable answer the probe gives rather
    // than the `500 internal error` an escaped exception is sanitized to.
    if (isHandleUniqueViolation(e)) return err(409, "handle already taken");
    throw e;
  }
}

async function updateMemberAdminTx(
  memberId: string,
  expectedVersion: number,
  patch: MemberAdminPatch,
  actor: Actor,
  reason?: string,
): Promise<AdminResult> {
  return sql.begin(async (tx) => {
    const row = (await on(tx, lockMember)<Row>`SELECT * FROM swarm_members WHERE id = ${memberId} FOR UPDATE`)[0];
    if (!row) return err(404, "member not found");
    if (Number(row.version) !== expectedVersion) return err(409, "stale_version");

    // UNIQUENESS, and it is deliberately checked against BOTH names of every
    // other member (issue #593). A handle equal to another member's `handle` is
    // the obvious collision — swarm_members_handle_key would raise a 500 out of
    // the UPDATE below rather than an answer an operator can act on. A handle
    // equal to another member's legacy `id` is the subtle one: no index forbids
    // it, and it would make /swarm/members/:ref ambiguous, quietly stealing a
    // URL that has been published for someone else. Both are refused with the
    // same 409 the rest of this surface uses for a lost race.
    if (patch.handle !== undefined && patch.handle !== row.handle) {
      const taken = (await on(tx, handleTaken)`
        SELECT 1 FROM swarm_members
        WHERE (handle = ${patch.handle} OR id = ${patch.handle}) AND id <> ${memberId}
        LIMIT 1`)[0];
      if (taken) return err(409, "handle already taken");
    }

    // `!== undefined`, NOT `??`. An explicit null is a CLEAR, and `??` reads it
    // as "absent" and keeps the old value while returning 200 — a success the
    // database did not perform. updateSubjectAdmin still has exactly that bug
    // on linkedMemberId; it is filed as a separate one-line follow-up so this
    // change does not also move the topic form's client-side guard.
    const keep = <T>(next: T | undefined, current: T): T => (next !== undefined ? next : current);
    const merged = {
      handle: keep(patch.handle, row.handle ?? row.id),
      name: keep(patch.name, row.name),
      lens: keep(patch.lens, row.lens),
      contact_email: keep(patch.contactEmail, row.contact_email),
      tagline: keep(patch.tagline, row.tagline),
      mandate: keep(patch.mandate, row.mandate),
      biases: keep(patch.biases, row.biases),
      voice_md: keep(patch.voiceMd, row.voice_md),
      mode: keep(patch.mode, row.mode),
      operator: keep(patch.operator, row.operator),
      avatar: keep(patch.avatar, row.avatar),
    };

    const upd = await on(tx, updateMember)<Row>`
      UPDATE swarm_members SET
        handle = ${merged.handle}, name = ${merged.name}, lens = ${merged.lens},
        contact_email = ${merged.contact_email}, tagline = ${merged.tagline},
        mandate = ${merged.mandate}, biases = ${tx.json(merged.biases as any)},
        voice_md = ${merged.voice_md}, mode = ${merged.mode}, operator = ${merged.operator},
        avatar = ${tx.json(merged.avatar as any)},
        version = version + 1, updated_at = now()
      WHERE id = ${memberId} AND version = ${expectedVersion}
      RETURNING *`;
    if (upd.length === 0) return err(409, "stale_version");

    // `reason` is PERSISTED here rather than discarded (#561's closing note).
    // The scope also names the fields that changed, so the trail says what was
    // edited and not only that an edit happened.
    // A handle change is the one edit here that moves a PUBLIC URL, so the
    // trail records the old and new value, not just the field name: "handle was
    // in the fields list" cannot answer "what was this member called when that
    // link was shared?" months later.
    await audit(actor, "member_update", {
      memberId,
      fields: Object.keys(patch),
      ...(patch.handle !== undefined
        ? { handleFrom: (row.handle ?? row.id) as string, handleTo: patch.handle }
        : {}),
      ...(reason ? { reason } : {}),
    }, tx);
    return { ok: true, status: 200, member: toMemberAdmin(upd[0]) };
  });
}

export async function deactivateMemberAdmin(
  memberId: string,
  expectedVersion: number,
  actor: Actor = ADMIN_ACTOR,
): Promise<AdminResult> {
  return sql.begin(async (tx) => {
    const row = (await on(tx, lockMember)<Row>`SELECT * FROM swarm_members WHERE id = ${memberId} FOR UPDATE`)[0];
    if (!row) return err(404, "member not found");
    if (Number(row.version) !== expectedVersion) return err(409, "stale_version");
    const upd = await on(tx, deactivateMember)<Row>`
      UPDATE swarm_members SET status = 'inactive', version = version + 1, updated_at = now()
      WHERE id = ${memberId} AND version = ${expectedVersion}
      RETURNING *`;
    if (upd.length === 0) return err(409, "stale_version");
    await on(tx, revokeActiveKeys)`UPDATE swarm_member_keys SET active = false WHERE member_id = ${memberId} AND active = true`;
    // A seat opening used to mail the waitlist here (enqueueSeatOpenNotifications).
    // Swarm email is removed — issue #1026 W5, decision D50 reversing D30 — so
    // deactivation now just frees the seat. The waitlist itself is untouched:
    // rows keep accumulating through POST /api/swarm/waitlist and an operator
    // reads them directly when a seat opens.
    await audit(actor, "member_deactivate", { memberId }, tx);
    return { ok: true, status: 200, member: toMemberAdmin(upd[0]) };
  });
}

// Issue #789 — reactivation and a key-less rotation both CARRY FORWARD the
// member's on-file public key by inserting a new swarm_member_keys row for it.
// Every path that first stores a key now screens it, so a key on file today
// passed that screen; the exception is a row registered BEFORE the gate existed
// (what scripts/scan-low-order-keys.ts is for). Copying such a row forward
// would register a low-order key AFTER the gate shipped, which is exactly what
// §11 R3 says can never happen — so both paths re-screen what they carry and
// refuse rather than duplicate it. The refusal names the remedy, because there
// is one: rotate to a freshly generated key.
const CARRIED_KEY_UNREGISTRABLE =
  "member's on-file public key is not a valid Ed25519 public key (or is a low-order point) " +
  "and cannot be carried forward; use rotate-key with a freshly generated publicKey";

// Reactivation mints a FRESH credential (the prior key/token is never
// silently trusted again) — matches the "revoke prior keys, credential only
// in the response" rule that governs rotation and manual add.
export async function reactivateMemberAdmin(
  memberId: string,
  expectedVersion: number,
  actor: Actor = ADMIN_ACTOR,
): Promise<AdminResult> {
  return sql.begin(async (tx) => {
    const row = (await on(tx, lockMember)<Row>`SELECT * FROM swarm_members WHERE id = ${memberId} FOR UPDATE`)[0];
    if (!row) return err(404, "member not found");
    if (Number(row.version) !== expectedVersion) return err(409, "stale_version");
    const lastKey = (await on(tx, lastMemberKey)<{ public_key: string }>`SELECT public_key FROM swarm_member_keys WHERE member_id = ${memberId} ORDER BY created_at DESC LIMIT 1`)[0] as
      | { public_key: string }
      | undefined;
    if (!lastKey) return err(409, "member has no on-file public key; use rotate-key with a new one");
    if (!isRegistrablePublicKey(lastKey.public_key)) return err(409, CARRIED_KEY_UNREGISTRABLE);
    // Capacity gate: reactivation raises the active count, so the member (which
    // is currently 'inactive') must fit under SWARM_ROSTER_CAP — no exemption.
    const cap = await assertRosterCapacity(tx);
    if (!cap.ok) return err(cap.status, cap.error);
    const upd = await on(tx, reactivateMember)<Row>`
      UPDATE swarm_members SET status = 'active', version = version + 1, updated_at = now()
      WHERE id = ${memberId} AND version = ${expectedVersion}
      RETURNING *`;
    if (upd.length === 0) return err(409, "stale_version");
    await on(tx, revokeActiveKeys)`UPDATE swarm_member_keys SET active = false WHERE member_id = ${memberId} AND active = true`;
    const token = `tok_${memberId}_${crypto.randomUUID()}`;
    await on(tx, insertMemberKey)`INSERT INTO swarm_member_keys (member_id, public_key, active, token_hash) VALUES (${memberId}, ${lastKey.public_key}, true, ${hashKey(token)})`;
    await audit(actor, "member_reactivate", { memberId }, tx);
    return { ok: true, status: 200, member: toMemberAdmin(upd[0]), token };
  });
}

// Key rotation: revoke ALL currently active keys for the member (transactional)
// and mint exactly one new active key + bearer token. `publicKey` is optional —
// omit to rotate only the credential (bearer token) against the member's
// existing on-file public key; supply a new one when the member generated a
// fresh keypair out-of-band.
export async function rotateMemberKeyAdmin(
  memberId: string,
  opts: { publicKey?: string } = {},
  actor: Actor = ADMIN_ACTOR,
): Promise<AdminResult> {
  return sql.begin(async (tx) => {
    const member = (await on(tx, lockMemberVersion)<Row>`SELECT id, version FROM swarm_members WHERE id = ${memberId} FOR UPDATE`)[0];
    if (!member) return err(404, "member not found");
    const priorActive = (await on(tx, priorActiveKey)<{ public_key: string }>`SELECT public_key FROM swarm_member_keys WHERE member_id = ${memberId} AND active = true ORDER BY created_at DESC LIMIT 1`)[0] as
      | { public_key: string }
      | undefined;
    const publicKey = opts.publicKey ?? priorActive?.public_key;
    if (!publicKey) return err(409, "no on-file public key; supply publicKey to rotate");
    // The route already screened a SUPPLIED publicKey; this catches the
    // carried-forward one (and any direct caller of this function).
    if (!isRegistrablePublicKey(publicKey)) return err(409, CARRIED_KEY_UNREGISTRABLE);
    await on(tx, revokeActiveKeys)`UPDATE swarm_member_keys SET active = false WHERE member_id = ${memberId} AND active = true`;
    const token = `tok_${memberId}_${crypto.randomUUID()}`;
    await on(tx, insertMemberKey)`INSERT INTO swarm_member_keys (member_id, public_key, active, token_hash) VALUES (${memberId}, ${publicKey}, true, ${hashKey(token)})`;
    await on(tx, bumpMemberVersion)`UPDATE swarm_members SET version = version + 1, updated_at = now() WHERE id = ${memberId}`;
    await audit(actor, "member_rotate_key", { memberId }, tx);
    return { ok: true, status: 200, memberId, token };
  });
}

// ── Admin avatar upload (issue #626) ────────────────────────────────────────
// The real thing: swarm/admin.ts's updateMemberAdmin already lets an admin
// point avatar.path at an arbitrary URL string (metadata-only, no bytes
// stored). This is the endpoint that stores actual image bytes and points
// avatar.path at them, so it flows through the SAME precedence chain issue
// #625 built in frontend/assets/js/app/lib/member-mark.js: memberAvatarMarkup
// treats any avatar.path that loads as taking precedence over the derived
// mark, so a stored, servable file at the path this writes is all "uploaded
// wins" requires — no separate precedence flag.
//
// STORED IN POSTGRES, NOT STATIC_DIR. The first cut of this wrote bytes to
// STATIC_DIR/avatars/uploads/. That directory does not survive a redeploy:
// scripts/static-assembly.sh wipes and re-copies STATIC_DIR's contents on
// every `docker compose up`, so an uploaded avatar would silently vanish on
// the next release. swarm_member_avatars (migration 0035) is the durable
// store instead; avatar.path now points at a route
// (routes/swarm.ts's GET .../members/:id/avatar) that reads the bytes back
// out of that table, not a file on disk.
export const AVATAR_MAX_BYTES = 5 * 1024 * 1024; // 5 MiB: generous for a profile photo.
export const AVATAR_CONTENT_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

export interface AvatarUploadInput {
  contentType: string | null;
  bytes: Uint8Array;
}

// Storage is DB-backed now, so there is no filesystem path to traverse — the
// UPDATE/INSERT below are parameterized like every other query here, so an
// arbitrary string in memberId cannot reach SQL as anything but a bind value.
// This check stays anyway: every real member id is minted by
// crypto.randomUUID() (addMemberAdmin, applyMember) and never anything else,
// so a non-UUID-shaped id can never name a real member — rejecting it here is
// a fast, clear 404 instead of a round trip to prove the same thing.
const MEMBER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Validation (type, size, id shape) runs BEFORE any database write, so a
// rejected upload leaves nothing behind. The bytes row and the member's
// avatar pointer are written in ONE transaction — a not-found member or a
// failed commit leaves neither half written; there is no temp-file/rename
// dance to get wrong because there is no file.
export async function uploadMemberAvatarAdmin(
  memberId: string,
  input: AvatarUploadInput,
  actor: Actor = ADMIN_ACTOR,
): Promise<AdminResult> {
  const type = (input.contentType ?? "").split(";")[0]!.trim().toLowerCase();
  const ext = AVATAR_CONTENT_TYPES[type];
  if (!ext) {
    return err(400, `unsupported avatar content-type "${input.contentType ?? ""}"; allowed: ${Object.keys(AVATAR_CONTENT_TYPES).join(", ")}`);
  }
  if (input.bytes.byteLength === 0) return err(400, "empty upload");
  if (input.bytes.byteLength > AVATAR_MAX_BYTES) return err(400, `avatar exceeds ${AVATAR_MAX_BYTES}-byte limit`);
  if (!MEMBER_ID_RE.test(memberId)) return err(404, "member not found");

  // Cache-bust token decided up front (not derived from the row's version),
  // so the query string is stable across the write and does not depend on
  // whether the later UPDATE succeeds.
  const cacheBust = crypto.randomUUID().slice(0, 8);
  const avatarPath = `/api/swarm/members/${memberId}/avatar?v=${cacheBust}`;
  const avatar = { path: avatarPath, source_url: null, credit: "Uploaded by admin" };

  return sql.begin(async (tx) => {
    const upd = await on(tx, setMemberAvatar)<Row>`
      UPDATE swarm_members SET avatar = ${tx.json(avatar as any)}, version = version + 1, updated_at = now()
      WHERE id = ${memberId}
      RETURNING id`;
    if (upd.length === 0) return err(404, "member not found");
    await on(tx, upsertAvatarBytes)`
      INSERT INTO swarm_member_avatars (member_id, content_type, bytes, byte_size)
      VALUES (${memberId}, ${type}, ${Buffer.from(input.bytes)}, ${input.bytes.byteLength})
      ON CONFLICT (member_id) DO UPDATE
        SET content_type = EXCLUDED.content_type,
            bytes = EXCLUDED.bytes,
            byte_size = EXCLUDED.byte_size,
            uploaded_at = now()`;
    await audit(actor, "member_avatar_upload", { memberId, path: avatarPath, contentType: type, byteSize: input.bytes.byteLength }, tx);
    return { ok: true, status: 200, memberId, avatar };
  });
}

// ── Sessions: no admin creation (issue #1026, D55 decision 4) ───────────────
// There is no admin session create. `createSessionAdmin` convened a session in
// `scheduled` with three admin-chosen instants and snapshotted the roster; D55
// makes `system-scheduler` the only caller of the epoch lifecycle, and the
// scheduler spec has no `scheduled` state (§4.1: a session is `collecting` from
// its first instant). Its route already answered 410. The roster snapshot it
// took is now taken by the epoch itself (domain.ts insertEpoch), in the
// transaction that opens it; a member activated afterwards joins the next
// epoch (docs/architecture/admin-surface.md US-C3).

// ── Roster add/excuse/restore (only before collecting begins) ──────────────
// Backed by the CANONICAL swarm_session_members table (issue #150). Status
// vocabulary is 'expected' | 'excused' (not 'active'); there is no separate
// "restored" marker — restoring simply flips status back to 'expected'.
async function requireRosterEditable(tx: DbHandle, sessionId: string) {
  const s = (await on(tx, lockSession)<{ id: string; state: string }>`SELECT id, state FROM swarm_sessions WHERE id = ${sessionId} FOR UPDATE`)[0] as
    | { id: string; state: string }
    | undefined;
  if (!s) return { ok: false as const, status: 404, error: "session not found" };
  if (s.state !== "scheduled") return { ok: false as const, status: 409, error: `roster is locked once collection begins (state=${s.state})` };
  return { ok: true as const };
}

export async function getSessionRoster(sessionId: string) {
  return on(sql, readRoster)<Row>`
    SELECT member_id, member_name, member_lens, status, included_at, excused_at, reason
    FROM swarm_session_members WHERE session_id = ${sessionId} ORDER BY member_id`;
}

export async function rosterAddAdmin(sessionId: string, memberId: string, actor: Actor = ADMIN_ACTOR): Promise<AdminResult> {
  return sql.begin(async (tx) => {
    const gate = await requireRosterEditable(tx, sessionId);
    if (!gate.ok) return err(gate.status, gate.error);
    const member = (await on(tx, rosterMember)<{ id: string; name: string; lens: string | null; role: string }>`SELECT id, name, lens, role FROM swarm_members WHERE id = ${memberId}`)[0];
    if (!member) return err(404, "member not found");
    if (member.role === "judge") return err(409, "judge_role_cannot_join_take_roster");
    await on(tx, rosterInsert)`
      INSERT INTO swarm_session_members (session_id, member_id, member_name, member_lens, status)
      VALUES (${sessionId}, ${memberId}, ${member.name}, ${member.lens}, 'expected')
      ON CONFLICT (session_id, member_id) DO UPDATE SET status = 'expected', excused_at = NULL`;
    await audit(actor, "roster_add", { sessionId, memberId }, tx);
    return { ok: true, status: 200, sessionId, memberId, memberStatus: "expected" };
  });
}

// THE AUDITED OPERATOR LEVER (T17). `force` excuses a member from the FROZEN
// roster AFTER collection has begun, which the plain path refuses. It exists
// for one shape of stuck session and no other: a `bucket_weights` session whose
// receipt is refused (`weights_absent_for_bucket_weights_subject`,
// `weights_not_authored_by_every_take`) because a take on file carries no
// canonical-four vector. Those takes cannot be repaired — `swarm_recommendations`
// is append-only, and the amendment window is shut — so without this the session
// never publishes a receipt at all.
//
// IT IS A BACKSTOP, NOT THE FIX. The fix is `submitRecommendation`'s 400 (see
// swarm/domain.ts), which stops such a take existing; this clears the ones that
// already do. So:
//   * it is REFUSED on a terminal session (`published`/`cancelled`) — nothing
//     re-writes a session that has already published, and
//   * it writes a DISTINCT audit action (`roster_excuse_forced`) carrying the
//     session's state and the operator's reason, so the exceptional path is
//     never indistinguishable from the ordinary one in the log, and
//   * it does not itself re-aggregate: the operator runs `aggregate` (and
//     `judge`) explicitly afterwards, through the guarded transitions, so the
//     rollup is recomputed by the same path that computes every other rollup.
//     `loadFrozenTakeSet` filters on non-excused roster rows, which is what
//     makes the excused member's take drop out of the rollup AND out of the
//     receipt's frozen take set.
const FORCE_EXCUSE_TERMINAL_STATES: ReadonlySet<string> = new Set(["published", "cancelled"]);

export interface RosterExcuseOptions {
  /** Excuse after collection has begun. Audited as `roster_excuse_forced`. */
  force?: boolean;
  /** Free-text operator justification, recorded on the audit row. */
  reason?: string;
}

export async function rosterExcuseAdmin(
  sessionId: string,
  memberId: string,
  actor: Actor = ADMIN_ACTOR,
  options: RosterExcuseOptions = {},
): Promise<AdminResult> {
  return sql.begin(async (tx) => {
    let state: string | undefined;
    if (options.force) {
      const s = (await on(tx, lockSession)<{ id: string; state: string }>`SELECT id, state FROM swarm_sessions WHERE id = ${sessionId} FOR UPDATE`)[0] as
        | { id: string; state: string }
        | undefined;
      if (!s) return err(404, "session not found");
      if (FORCE_EXCUSE_TERMINAL_STATES.has(s.state)) {
        return err(409, `session is ${s.state}; a terminal session is never re-rostered (forced excuse refused)`);
      }
      state = s.state;
    } else {
      const gate = await requireRosterEditable(tx, sessionId);
      if (!gate.ok) return err(gate.status, gate.error);
    }
    const upd = await on(tx, rosterExcuse)`UPDATE swarm_session_members SET status = 'excused', excused_at = now() WHERE session_id = ${sessionId} AND member_id = ${memberId} RETURNING member_id`;
    if (upd.length === 0) return err(404, "member is not on this session's roster");
    if (options.force) {
      await audit(actor, "roster_excuse_forced", {
        sessionId,
        memberId,
        state,
        reason: options.reason ?? null,
      }, tx);
    } else {
      await audit(actor, "roster_excuse", { sessionId, memberId }, tx);
    }
    return { ok: true, status: 200, sessionId, memberId, forced: options.force === true };
  });
}

export async function rosterRestoreAdmin(sessionId: string, memberId: string, actor: Actor = ADMIN_ACTOR): Promise<AdminResult> {
  return sql.begin(async (tx) => {
    const gate = await requireRosterEditable(tx, sessionId);
    if (!gate.ok) return err(gate.status, gate.error);
    const upd = await on(tx, rosterRestore)`UPDATE swarm_session_members SET status = 'expected', excused_at = NULL WHERE session_id = ${sessionId} AND member_id = ${memberId} RETURNING member_id`;
    if (upd.length === 0) return err(404, "member is not on this session's roster");
    await audit(actor, "roster_restore", { sessionId, memberId }, tx);
    return { ok: true, status: 200, sessionId, memberId };
  });
}

// The runtime switch itself. Audited like every other admin write, because
// "who turned the judge on, and when" is the first question asked of any prose
// that turns out to be wrong.
export async function getJudgeConfigAdmin(): Promise<AdminResult<{ judge: JudgeConfig }>> {
  return { ok: true, status: 200, judge: await getJudgeConfig() };
}

/**
 * What is STILL true, and hazardous, once the judge is switched on (issue #806).
 *
 * DELIBERATELY SHORT, AND IT SHRANK. #806 closed nine of the ten things an
 * operator would otherwise have had to be warned about — the unverifiable
 * `applied`, the stale `inForce`, the silent `aggregate` overwrite, the five
 * degraded runs per TERMINAL-STATE refusal, the swallowed enqueue, the untied
 * claim order, the degenerate window, the un-deduped judge enqueue, the skipped
 * production assertion. A warning listing fixed problems trains an operator to
 * skip warnings, so this names ONLY what remains, and both entries are design
 * trade-offs rather than defects. If a later change closes one, DELETE the line
 * — do not leave it standing as decoration.
 *
 * NOT LISTED, on purpose: a judging can still be lost when its rollup takes
 * longer to land than the judge job's five backed-off attempts (~30s), because
 * the dedupe key is sticky across terminal states and nothing re-enqueues a
 * `dead` job. That is a real cost of the sticky key — but it is LOUD, not
 * silent: five degraded runs, a `dead` job, and a driver log line naming that
 * no judgement row exists. This list is for what the surface cannot tell you,
 * and that one it tells you plainly.
 */
export function judgeModeWarnings(mode: JudgeMode): string[] {
  if (mode === "off") return [];
  // THE SINGLE-WORKER ORDERING WARNING IS DELETED, NOT SUPPRESSED (issue #1026
  // W4). It said judging and publishing were two queue rows whose order held
  // only because exactly one worker claimed the lane. Neither is a queue row
  // any more: system-scheduler-spec.md §4.4 makes settlement "a chain the
  // scheduler drives through the API, each step as soon as the previous one
  // returns", so the steps are sequenced by the caller rather than by
  // run_after and claim order. This file's own rule is that a warning naming a
  // fixed problem is deleted rather than left standing.
  const warnings: string[] = [];
  if (mode === "enforce") {
    // Not a defect either: the aggregator OWNS the recommendation, and #806
    // chose to report this loss rather than prevent it. But an operator reading
    // "applied to the session" should know it is a fact about a moment.
    warnings.push(
      "an `enforce` opinion is NOT permanent: the sanctioned `judged -> window_closed -> aggregated` " +
        "re-run replaces `swarm_recommendation` wholesale and discards the judge's prose. The judgement " +
        "row survives (the record is append-only) and `GET /api/swarm/admin/sessions/:id/judgements` " +
        "reports it as superseded rather than in force — but the session no longer carries it.",
    );
  }
  return warnings;
}

export async function setJudgeConfigAdmin(
  patch: { mode?: JudgeMode; minTakes?: number; model?: string | null; thirdPartyEnabled?: boolean },
  actor: Actor = ADMIN_ACTOR,
): Promise<AdminResult> {
  let judge: JudgeConfig;
  try {
    judge = await setJudgeConfig(patch);
  } catch (e) {
    return err(400, e instanceof Error ? e.message : "invalid judge config");
  }
  // Audited WITH the warnings, not just beside them: "who turned the judge on,
  // and what were they told at the time" is the second question asked of any
  // prose that turns out to be wrong. `thirdPartyEnabled` rides the same audit
  // row as `mode` — issue #796 wants this "audited admin action, matching how
  // `swarm_judge_config.mode` already behaves," not a second audit surface.
  const warnings = judgeModeWarnings(judge.mode);
  await audit(actor, "judge_config", {
    mode: judge.mode, minTakes: judge.minTakes, model: judge.model,
    thirdPartyEnabled: judge.thirdPartyEnabled, warnings,
  });
  return { ok: true, status: 200, judge, warnings };
}

// ── The judgement record's read path (issue #767, folded from #768) ────────
//
// Built for the `shadow` soak, which D53 retired; it stays because it is the
// only place an operator can read every judgement a session received — the
// judge of record's, a second seated judge's that changed no outcome, late
// evidence after publication, and historical `shadow` rows — beside what the
// session itself carries.
//
// PRIVILEGED like everything else under /api/swarm/admin/*. Rows that never
// reached the session carry model-authored prose about named members that the
// public session page does not show; serving them unauthenticated would publish
// through the read path what the lifecycle kept off the session.

/**
 * One judgement row, camelCased and with the operator-facing facts up front.
 *
 * `carried` is what the SESSION says the judge left on it, read at request time
 * (`swarm_recommendation.judge`). It is passed in rather than re-derived per row
 * so the whole list is reconciled against one reading.
 */
function toJudgementAdmin(
  r: Record<string, unknown>,
  carried: { promptHash: string; inputsDigest: string; judgedByMemberId: string | null } | null,
) {
  const dropped = { positions: Number(r.dropped_positions ?? 0), disagreements: Number(r.dropped_disagreements ?? 0) };
  // Does the session STILL carry this opinion? (issue #806.) `applied` is a
  // fact about the moment the judging committed; it is not a claim about now,
  // and the panel renders it as one ("applied to the session"). Two legal admin
  // actions are enough to make that reading false — `judged -> window_closed`
  // then `window_closed -> aggregated`, at which point `domain.aggregateSession`
  // replaces `swarm_recommendation` wholesale and the judge's prose,
  // release_safety and fingerprint go with it. So the read path reconciles
  // instead of trusting the column.
  //
  // The JUDGE is compared too: two seated judges reading the same take set
  // under the same prompt share both digests, and only the judge of record's
  // judgement is on the session (system-scheduler-spec.md §4.4).
  const carriedBySession = carried != null
    && carried.inputsDigest === String(r.inputs_digest)
    && carried.promptHash === String(r.prompt_hash)
    && carried.judgedByMemberId === ((r.judged_by_member_id as string | null) ?? null);
  return {
    id: String(r.id),
    mode: String(r.mode),
    source: String(r.source),
    fallbackReason: (r.fallback_reason as string | null) ?? null,
    // enforce-only, and the reason a recorded opinion did NOT reach the session
    // (it published while the model was thinking). `mode: 'enforce'` alone was
    // never evidence that the prose landed.
    applied: r.applied === true,
    appliedSkippedReason: (r.applied_skipped_reason as string | null) ?? null,
    model: (r.model as string | null) ?? null,
    promptHash: String(r.prompt_hash),
    inputsDigest: String(r.inputs_digest),
    takeCount: Number(r.take_count),
    minTakes: Number(r.min_takes),
    // A partial drop is NOT a fallback: `source` stays 'model' and
    // `fallbackReason` stays null, because the response was used. This is the
    // only way to tell a model that named few disagreements from one whose
    // output was trimmed for want of a quotable take body (#773).
    dropped,
    partiallyDegraded: dropped.positions > 0 || dropped.disagreements > 0,
    opinion: r.opinion ?? null,
    // Who judged (issue #918/#922): a free-text label plus, when the judge is a
    // known swarm member (e.g. the seeded Themis identity), the member id it
    // resolved to. `judgedByMemberId` is null for the anonymous in-house
    // default ('robotmoney-in-house') and for any judgement recorded before
    // migration 0043 added the columns.
    judgedBy: (r.judged_by as string | null) ?? null,
    judgedByMemberId: (r.judged_by_member_id as string | null) ?? null,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    // Reconciliation against the session as it stands NOW (issue #806).
    carriedBySession,
    // Only an `applied` row can be SUPERSEDED — an unapplied row (a second
    // judge's, late evidence, a historical shadow row) was never on the
    // session, and saying "superseded" about it would invent a loss.
    supersededReason: r.applied === true && !carriedBySession
      ? (carried == null ? "recommendation_overwritten" : "session_carries_a_different_opinion")
      : null,
  };
}

export async function getSessionJudgementsAdmin(sessionId: string, limit = 50): Promise<AdminResult> {
  return sql.begin(async (tx) => {
    const session = (await on(tx, readSessionState)<{ id: string; state: string }>`SELECT id, state FROM swarm_sessions WHERE id = ${sessionId}`)[0] as
      | { id: string; state: string }
      | undefined;
    if (!session) return err(404, "session not found");
    const rows = await listJudgements(sessionId, limit, tx);
    // `listJudgements(sessionId, limit)` already returns the newest rows sorted
    // by `id DESC` (the only ordering that agrees with the order the session was
    // actually written in), so `latest` is simply `rows[0] ?? null` rather than
    // a separate query.
    const latest = rows[0] ?? null;
    // …but "newest row" is not "what the session carries" (issue #806). The
    // append-only record and the session are two different stores, and the
    // sanctioned `judged -> window_closed -> aggregated` re-run rewrites the
    // second without touching the first. Read the session's own fingerprint once
    // and reconcile every row against it, so `inForce` can report SUPERSEDED
    // rather than "applied to the session" for prose the session no longer has.
    const carried = await sessionJudgeFingerprint(tx, sessionId);
    return {
      ok: true,
      status: 200,
      sessionId,
      state: session.state,
      // What the session itself carries, so an operator can see the two stores
      // side by side rather than inferring the disagreement from a boolean.
      sessionJudge: carried,
      inForce: latest ? toJudgementAdmin(latest as Record<string, unknown>, carried) : null,
      judgements: rows.map((r) => toJudgementAdmin(r, carried)),
    };
  });
}

// Publish the consensus receipt for a judged session (issue #754).
//
// NOT A STATE TRANSITION, and deliberately not folded into `publishSessionAdmin`.
// A receipt needs a judgement — it carries the judge's opinion, its prompt_hash
// and its inputs_digest — and the judge is `off` by default on a live swarm, so
// wiring assembly into the publish path would make every ordinary publish
// attempt an assembly that refuses. It is its own idempotent action instead.
//
// IDEMPOTENT AND IMMUTABLE: the second call returns the receipt already on
// file. `publishConsensusReceipt` re-reads before it assembles and migration
// 0042 refuses the UPDATE regardless, so the bytes an on-chain digest commits
// to cannot be replaced by a re-run.
//
// PUBLISH THE SESSION FIRST. Assembly refuses any session that is not already
// `published` (`session_not_published`), because `published` is terminal and a
// non-terminal session can still be reopened, amended and re-aggregated while
// the receipt's bytes stay immutable and anchored. A session an operator may
// still want to reopen must be reopened BEFORE its receipt exists.
//
// AND IT MUST HAVE A CONSENSUS. Only the judge of record's judgement reaches the
// session's own record; any other judgement (a second judge's, late evidence,
// a historical `shadow` row) is never on the session, so there is nothing for a
// receipt to attest to (`judgement_not_adopted`): the receipt embeds the
// session's own judge block or it embeds nothing.
//
// EVERY REFUSAL REACHES THE OPERATOR with its reason code. Besides the two
// above: `session_not_reaggregated` (a late FIRST take arrived after the rollup
// was computed — re-aggregate and re-judge), `judgement_stale` (the adopted
// opinion was formed over a different take set), and
// `weights_not_canonical_four` — a session whose members submitted a bucket set
// schema 1.0 cannot carry is refused here rather than published with the
// allocation silently dropped, which would have the signed artifact contradict
// what GET /api/swarm/sessions/:id serves for the same session.
export async function publishConsensusReceiptAdmin(sessionId: string, actor: Actor = ADMIN_ACTOR) {
  let stored;
  try {
    stored = await publishConsensusReceipt(sessionId);
  } catch (e) {
    if (e instanceof ConsensusReceiptRefusal) {
      await audit(actor, "consensus_receipt_refused", { sessionId, reason: e.reason, details: e.details.slice(0, 10) });
      return {
        ok: false as const,
        status: e.reason === "no_session" ? 404 : 409,
        error: e.reason,
        message: e.message,
        details: e.details,
        sessionId,
      };
    }
    throw e;
  }
  await audit(actor, "consensus_receipt_published", {
    sessionId, subjectId: stored.subjectId, schemaVersion: stored.schemaVersion,
    canonicalByteLength: stored.canonicalBytes.length,
  });
  return {
    ok: true as const, status: 200, sessionId,
    receipt: {
      subjectId: stored.subjectId,
      schemaVersion: stored.schemaVersion,
      publishedAt: stored.publishedAt,
      // From the contract, never a literal — routes.js is the single source of
      // truth for URLs (finding 019).
      //
      // `url` is the ANCHORED one (decision D10): it serves the bare canonical
      // bytes, so `keccak256(domain separator + body)` is the `payloadDigest`
      // robotmoney-core writes beside it, and "the URL drafted from IS the
      // anchored payloadUri" stays a string equality. `verifiedUrl` is the
      // read-time verification envelope — the human/verifier surface — and is
      // never anchored. Both are returned so a caller never has to build either
      // by hand.
      url: path(ROUTES.swarm.sessionConsensusReceipt, { id: stored.sessionId }),
      verifiedUrl: path(ROUTES.swarm.sessionConsensusReceiptVerified, { id: stored.sessionId }),
      canonicalBytes: stored.canonicalBytes,
      receipt: stored.receipt,
    },
  };
}

// ── Audit log (redacted; scope never carries credential material) ──────────
export interface AuditFilter {
  actor?: string;
  action?: string;
  since?: string;
  until?: string;
  limit?: number;
}

export async function listAuditLog(filter: AuditFilter = {}) {
  const limit = filter.limit && filter.limit > 0 ? Math.min(filter.limit, 500) : 100;
  // ONE statement whatever the filter: a filter that is absent is NULL and
  // matches every row, so no fragment is built outside the registered call.
  const actor = filter.actor || null;
  const action = filter.action || null;
  const since = filter.since || null;
  const until = filter.until || null;
  return on(sql, listAudit)<Row>`
    SELECT id, actor, action, scope, at FROM audit_log
    WHERE (${actor}::text IS NULL OR actor = ${actor})
      AND (${action}::text IS NULL OR action = ${action})
      AND (${since}::timestamptz IS NULL OR at >= ${since})
      AND (${until}::timestamptz IS NULL OR at <= ${until})
    ORDER BY at DESC LIMIT ${limit}`;
}
