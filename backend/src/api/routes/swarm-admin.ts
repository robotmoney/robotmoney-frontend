// Swarm ADMIN REST surface (issue #152): topics, members, session
// scheduling + roster, guarded lifecycle transitions, and audit filtering.
// Thin transport over swarm/admin.ts — every route here is PRIVILEGED
// (X-Admin-Token / isPrivileged(), the same fail-closed guard the rest of the
// swarm admin dispatcher and /api/admin use) and every owned route checks
// that guard BEFORE parsing the request body or touching the database, so an
// unauthenticated caller never causes SQL work (issue #152 AC7).
import * as admin from "../../swarm/admin.ts";
import * as epoch from "../../swarm/domain.ts";
import { getAgentHealthEvents } from "../../swarm/domain.ts";
import { JUDGE_MODES, type JudgeMode } from "../../swarm/judge-config.ts";
import { config as globalConfig } from "../../config.ts";
import { isPrivileged, hasAutomationRole, hasAutomationRight } from "../auth.ts";
import { isRegistrablePublicKey, PUBLIC_KEY_REFUSAL } from "../../lib/signing.ts";
import {
  optionalString,
  parseExpectedVersion,
  parseManualMember,
  parseSubjectCreate,
  readJsonObject,
  requiredString,
  validateMemberAdminPatch,
} from "../validation.ts";

const PREFIX = "/api/swarm/admin/";
const FORBIDDEN = { status: 403, body: { error: "admin authorization required" } } as const;

function ownsPath(p: string): boolean {
  if (!p.startsWith(PREFIX)) return false;
  const rest = p.slice(PREFIX.length);
  return (
    rest.startsWith("epochs/") ||
    rest === "subjects" || rest.startsWith("subjects/") ||
    rest === "members" || rest.startsWith("members/") ||
    rest === "applications" ||
    rest === "sessions" || rest.startsWith("sessions/") ||
    rest === "audit" ||
    rest === "judge" ||
    rest === "agent-health"
  );
}

// Result envelope from swarm/admin.ts already carries {ok, status, error,
// ...}; map it straight through so 200/201/404/409 responses stay consistent.
function fromResult(r: { status: number; [k: string]: unknown }) {
  return { status: r.status, body: r };
}

export interface AdminAuthConfig {
  adminToken: string | null;
  automationToken?: string | null;
  allowInsecure: boolean;
}

// `cfg` is injectable (mirrors routes/admin.ts's handleAdmin) so tests can
// exercise a prod-mode config (token required, insecure disallowed) against
// the ephemeral test DB, which otherwise runs with RM_ENV=ephemeral →
// allowInsecure=true. swarm.ts's live mount omits it (defaults to the
// real global config).

// ─────────────────────────────────────────────────────────────────────────────
// Finalize, and attest — issue #1026 W4
// ─────────────────────────────────────────────────────────────────────────────
//
// §4.4: "Publish — the session goes public, WITH ITS CONSENSUS CERTIFICATE WHEN
// ONE EXISTS."
//
// THIS EXISTS BECAUSE THE REMOVAL ALMOST DROPPED IT. The retired `swarm.publish`
// queue handler assembled the receipt straight after publishing, and deleting
// that handler took the behaviour with it: `finalizeEpoch` publishes and
// assembles nothing, so an `enforce` session with an adopted judgement would
// have gone public with no certificate and nothing calling it a failure. Every
// layer would have behaved correctly, which is exactly the shape of the
// v0.5.0-rc.1 hole `swarm-analyst-weights-receipt.test.ts` was written for.
//
// IT IS HERE, NOT IN `finalizeEpoch`. A receipt is not a state transition, and
// domain.ts cannot reach the assembler anyway — `consensus-receipt.ts` imports
// domain.ts, so the dependency only runs one way. The retired handler made the
// same call from the same side for the same reason.
//
// THE ALLOWLIST IS CARRIED OVER VERBATIM, and it is an allowlist rather than a
// failure list on purpose: a refusal reason added later degrades loudly instead
// of being absorbed into a clean publish.
const EXPECTED_RECEIPT_REFUSALS = new Set([
  // The judge is off, which is the production default.
  "not_judged",
  // Judging was requested and no eligible consensus was recorded by the
  // deadline: §4.4 publishes the session with no certificate, by design.
  "no_consensus",
  // Judgements are on file but none reached the session: they came from a judge
  // that is not the judge of record, or after publication (late evidence).
  "judgement_not_adopted",
  // A member filed a first take after aggregation — consensus-receipt.ts calls
  // this "ordinary product behaviour rather than corruption".
  "session_not_reaggregated",
  // An amendment landed between judging and publishing.
  "judgement_stale",
]);

/**
 * What replaced the missing-receipt alert, and why nothing is lost.
 *
 * The retired handler had a second job here: `not_judged` meant two different
 * things — "the judge is off" and "the judge was asked and never answered" —
 * and it told them apart by reading the session's own `swarm.judge` job's
 * `last_error`, so an eligible session could not lose its receipt in silence.
 *
 * There is no `swarm.judge` job any more, and there does not need to be: under
 * §4.4 finalize records the distinction ITSELF, as the session's judging
 * outcome. `not_judged` means the mode was `off`; `no_consensus` means judging
 * was requested and no eligible consensus arrived. The condition the alert
 * existed to surface is now a stored column on the published session rather
 * than an inference from a queue row, which is strictly better — but it is a
 * DIFFERENT mechanism, so it is written down rather than assumed.
 */
async function finalizeAndAttest(sessionId: string) {
  const finalized = await epoch.finalizeEpoch(sessionId);
  if (!finalized.ok) return finalized;

  const receipt = await admin.publishConsensusReceiptAdmin(sessionId, "system-scheduler");
  if (receipt.ok) return { ...finalized, consensusReceipt: { published: true } };

  const consensusReceipt = { published: false, reason: receipt.error };
  if (EXPECTED_RECEIPT_REFUSALS.has(receipt.error)) {
    return { ...finalized, consensusReceipt };
  }
  // An assembly FAILURE — `no_takes`, `schema_invalid`, the `weights_*` family,
  // `signing_key_unresolved`, `nonce_replayed`. The session is published either
  // way (finalize already committed and §4.4 makes that outcome final), so this
  // reports the failure beside the outcome rather than pretending the publish
  // did not happen. The scheduler treats a 200 as success and moves on, which
  // is correct: there is nothing for it to retry, and the refusal is recorded.
  return {
    ...finalized,
    consensusReceipt,
    receiptFailed: true,
    receiptError: `consensus receipt refused: ${receipt.error}`,
  };
}

export async function handleSwarmAdmin(
  req: Request,
  url: URL,
  cfg: AdminAuthConfig = globalConfig,
): Promise<{ status: number; body: unknown } | null> {
  const p = url.pathname;
  const m = req.method;
  if (!ownsPath(p)) return null;

  const rest = p.slice(PREFIX.length);
  const segs = rest.split("/").filter(Boolean);

  // Auth FIRST — before any body parsing or DB query (AC7).
  //
  // The epoch-lifecycle routes ask for a RIGHT, not merely for the automation
  // role (issue #1026 W4.5, smoke spec §3): `system-scheduler` presents a
  // per-instance token whose row names what it may do, and a token provisioned
  // to read subjects and sessions must not be able to turn an epoch over. Every
  // other admin route keeps exactly the guard it had.
  if (segs[0] === "epochs") {
    if (!(await isPrivileged(req, cfg) || await hasAutomationRight(req, "lifecycle_transitions", cfg))) {
      return FORBIDDEN;
    }
  } else if (!(await isPrivileged(req, cfg) || hasAutomationRole(req, cfg))) {
    return FORBIDDEN;
  }

  // ── The epoch lifecycle (scheduler spec §4) ───────────────────────────
  //
  // Thin transport, exactly like the rest of this file: each route parses its
  // body, calls one state-guarded transition, and passes the domain layer's own
  // {ok, status, ...} envelope straight through. No route here decides
  // anything — a refusal's reason comes from the transition, because the
  // transition is the only thing that saw the stored state.
  if (segs[0] === "epochs" && m === "POST" && segs.length === 2) {
    const b = (await readJsonObject(req)) ?? {};
    const str = (k: string) => (typeof b[k] === "string" && b[k] ? (b[k] as string) : null);
    switch (segs[1]) {
      case "open": {
        const subjectId = str("subjectId");
        if (!subjectId) return { status: 400, body: { error: "subjectId required" } };
        return fromResult(await epoch.openEpoch(subjectId));
      }
      case "turnover": {
        const subjectId = str("subjectId");
        const expectedSessionId = str("expectedSessionId");
        if (!subjectId || !expectedSessionId) {
          return { status: 400, body: { error: "subjectId and expectedSessionId required" } };
        }
        return fromResult(await epoch.turnOverEpoch(subjectId, expectedSessionId));
      }
      case "aggregate": {
        const sessionId = str("sessionId");
        if (!sessionId) return { status: 400, body: { error: "sessionId required" } };
        return fromResult(await epoch.aggregateEpoch(sessionId));
      }
      case "request-judging": {
        const sessionId = str("sessionId");
        if (!sessionId) return { status: 400, body: { error: "sessionId required" } };
        return fromResult(await epoch.requestJudging(sessionId));
      }
      // THERE IS NO `consensus` ROUTE. A consensus is recorded by exactly one
      // path: `submitJudgement`, in the transaction that writes the judge of
      // record's signed, applied judgement (§4.4, criterion 102: "through part
      // 1's transition rather than a second copy"). A route that took a bare
      // judgement id would let a scheduler token record ANY row — a second
      // judge's, or one that never reached the session — as the consensus, and
      // finalize would then publish `judged` over a session carrying no adopted
      // opinion. `epochs/consensus` therefore falls through to the 404 below.
      case "finalize": {
        const sessionId = str("sessionId");
        if (!sessionId) return { status: 400, body: { error: "sessionId required" } };
        return fromResult(await finalizeAndAttest(sessionId));
      }
    }
  }
  if (segs[0] === "epochs") return { status: 404, body: { error: "unknown epochs admin route" } };

  // ── Topics ────────────────────────────────────────────────────────────
  if (segs[0] === "subjects") {
    if (segs.length === 1 && m === "GET") return { status: 200, body: { subjects: await admin.listSubjectsAdmin() } };
    if (segs.length === 1 && m === "POST") {
      const parsed = parseSubjectCreate(await readJsonObject(req));
      if (!parsed) return { status: 400, body: { error: "id and name required" } };
      return fromResult(await admin.createSubjectAdmin(parsed));
    }
    if (segs.length === 3 && (segs[2] === "update" || segs[2] === "deactivate")) {
      const id = decodeURIComponent(segs[1]!);
      const b = (await readJsonObject(req)) ?? {};
      const expectedVersion = parseExpectedVersion(b);
      if (expectedVersion == null) return { status: 400, body: { error: "expectedVersion (integer >= 1) required" } };
      if (segs[2] === "deactivate") return fromResult(await admin.deactivateSubjectAdmin(id, expectedVersion));
      const { expectedVersion: _ev, ...patch } = b as Record<string, unknown>;
      return fromResult(await admin.updateSubjectAdmin(id, expectedVersion, patch as any));
    }
    return { status: 404, body: { error: "unknown subjects admin route" } };
  }

  // ── Members ───────────────────────────────────────────────────────────
  if (segs[0] === "members") {
    if (segs.length === 1 && m === "GET") {
      // Issue #563: silenceFlags is a SEPARATE query (getMemberSilenceFlags),
      // not a field on toMemberAdmin()'s per-row projection — it needs the
      // whole session/recommendation history, not one row, and admin.ts's
      // other callers of toMemberAdmin() (manual-add, update, deactivate,
      // reactivate) have no such history to hand it. Run in parallel; they
      // read disjoint tables and neither writes.
      const [members, silenceFlags] = await Promise.all([
        admin.listMembersAdmin(),
        admin.getMemberSilenceFlags(),
      ]);
      return { status: 200, body: { members, silenceFlags } };
    }
    if (segs.length === 1 && m === "POST") {
      // The parser owns the message: a body that names `memberId` is refused
      // with its own sentence (issue #690), never folded into "required".
      const parsed = parseManualMember(await readJsonObject(req));
      if (!parsed.ok) return { status: 400, body: { error: parsed.error } };
      return fromResult(await admin.addMemberAdmin(parsed.data));
    }
    // Avatar upload (issue #626), checked BEFORE the generic segs.length===3
    // branch below: that branch unconditionally calls readJsonObject(req),
    // which would consume the body trying to parse it as JSON — and the raw
    // image bytes this route reads via req.arrayBuffer() ARE the body, not
    // JSON. A Content-Length over the limit is refused before the body is
    // even read, so an oversized upload cannot be used to force this process
    // to buffer it into memory first.
    if (segs.length === 3 && segs[2] === "avatar" && m === "POST") {
      const id = decodeURIComponent(segs[1]!);
      const contentLength = req.headers.get("Content-Length");
      if (contentLength && Number(contentLength) > admin.AVATAR_MAX_BYTES) {
        return { status: 400, body: { error: `avatar exceeds ${admin.AVATAR_MAX_BYTES}-byte limit` } };
      }
      const bytes = new Uint8Array(await req.arrayBuffer());
      return fromResult(
        await admin.uploadMemberAvatarAdmin(id, { contentType: req.headers.get("Content-Type"), bytes }),
      );
    }
    if (segs.length === 3) {
      const id = decodeURIComponent(segs[1]!);
      const b = (await readJsonObject(req)) ?? {};
      if (segs[2] === "review") {
        const decision = requiredString(b, "decision", 20);
        if (decision !== "approve" && decision !== "reject") return { status: 400, body: { error: "decision must be approve|reject" } };
        const role = b.role === undefined ? "member" : b.role;
        if (role !== "member" && role !== "judge") return { status: 400, body: { error: "role must be member|judge" } };
        return fromResult(await admin.reviewApplicationAdmin(id, decision, "admin", role));
      }
      if (segs[2] === "update") {
        const expectedVersion = parseExpectedVersion(b);
        if (expectedVersion == null) return { status: 400, body: { error: "expectedVersion (integer >= 1) required" } };
        // `reason` is operator context, not a member column: pulled out before
        // a validator that rejects unknown keys, and threaded to the audit row.
        const { expectedVersion: _ev, reason: _reason, ...fields } = b as Record<string, unknown>;
        const parsed = validateMemberAdminPatch(fields);
        if (!parsed.ok) return { status: 400, body: { error: parsed.error } };
        return fromResult(await admin.updateMemberAdmin(
          id, expectedVersion, parsed.data, "admin", requiredString(b, "reason", 500) ?? undefined,
        ));
      }
      if (segs[2] === "deactivate" || segs[2] === "reactivate") {
        const expectedVersion = parseExpectedVersion(b);
        if (expectedVersion == null) return { status: 400, body: { error: "expectedVersion (integer >= 1) required" } };
        return fromResult(
          segs[2] === "deactivate"
            ? await admin.deactivateMemberAdmin(id, expectedVersion)
            : await admin.reactivateMemberAdmin(id, expectedVersion),
        );
      }
      if (segs[2] === "rotate-key") {
        const publicKey = typeof b.publicKey === "string" && b.publicKey.trim() ? b.publicKey.trim() : undefined;
        // Issue #789. Rotation with a supplied key INSERTs it into
        // swarm_member_keys, so it is a registration path and carries the same
        // gate as apply/manual-add; an omitted publicKey rotates only the
        // bearer token against the key already on file, which passed this gate
        // when it was first stored, so there is nothing to re-check.
        if (publicKey !== undefined && !isRegistrablePublicKey(publicKey)) {
          return { status: 400, body: { error: PUBLIC_KEY_REFUSAL } };
        }
        return fromResult(await admin.rotateMemberKeyAdmin(id, { publicKey }));
      }
      if (segs[2] === "role") {
        const expectedVersion = parseExpectedVersion(b);
        if (expectedVersion == null) return { status: 400, body: { error: "expectedVersion (integer >= 1) required" } };
        if (b.role !== "member" && b.role !== "judge") return { status: 400, body: { error: "role must be member|judge" } };
        return fromResult(await admin.setMemberRoleAdmin(id, expectedVersion, b.role));
      }
    }
    return { status: 404, body: { error: "unknown members admin route" } };
  }

  // ── Applications ──────────────────────────────────────────────────────
  if (segs[0] === "applications" && m === "GET") {
    const status = url.searchParams.get("status") ?? undefined;
    return { status: 200, body: { applications: await admin.listApplicationsAdmin(status) } };
  }

  // ── Sessions: creation, roster, guarded lifecycle ───────────────────────
  if (segs[0] === "sessions") {
    // THE PRE-EPOCH SESSION VERBS ARE RETIRED HERE, as their dispatcher copies
    // are in routes/swarm.ts (issue #1026). Each moved a session outside the
    // epoch transitions and wrote no stream event the scheduler hears:
    //
    //   create    inserted a `scheduled` session (a state §4.1 abolishes) on
    //             an operator-chosen, off-grid `window_closes_at` (§2.2).
    //   close     closed a window with no epoch binding and captured neither
    //             judge mode nor judging duration (§4.3, §4.4) — the NULL-mode
    //             source settlement now refuses as `judging_not_captured`.
    //   aggregate / publish
    //             settled with no captured mode and published with no
    //             `judging_outcome` at all.
    //   reopen    moved a closed epoch back to `collecting` beside its
    //             successor, or under a deactivated subject.
    //   cancel    ended a collecting epoch with no successor and no event.
    //
    // §4.3: "Turnover is the only way an epoch closes while its subject stays
    // active", and only `system-scheduler` turns an epoch over (D55): there is
    // no operator or admin early close. 410, not 404: the verbs were real and
    // their absence is deliberate, so a stale client is told where to go.
    if ((segs.length === 1 && m === "POST") ||
        (segs.length === 3 && m === "POST" && ["cancel", "close", "reopen", "aggregate", "publish"].includes(segs[2]!))) {
      const verb = segs.length === 1 ? "create" : segs[2]!;
      return {
        status: 410,
        body: {
          error: `the session ${verb} action is gone: epochs open, close and settle only through the epoch transitions ` +
            "(POST /api/swarm/admin/epochs/{open,turnover,aggregate,request-judging,finalize}), which only system-scheduler " +
            "calls; there is no early close, and stopping a subject is deactivation (system-scheduler-spec.md §4.3, §4.5; D55)",
        },
      };
    }
    const sessionId = segs[1] ? decodeURIComponent(segs[1]) : undefined;
    // Every judgement a session received (issue #767, folded from #768).
    // Privileged like every other route here — a judgement that never reached
    // the session is model-authored prose about named members that the public
    // session page does not show, so serving it unauthenticated would publish
    // exactly what the lifecycle kept off the session.
    if (sessionId && segs.length === 3 && segs[2] === "judgements" && m === "GET") {
      const limitRaw = Number(url.searchParams.get("limit") ?? NaN);
      return fromResult(await admin.getSessionJudgementsAdmin(sessionId, Number.isFinite(limitRaw) ? limitRaw : 50));
    }
    if (sessionId && segs.length === 3 && segs[2] === "roster" && m === "GET") {
      return { status: 200, body: { roster: await admin.getSessionRoster(sessionId) } };
    }
    if (sessionId && segs.length === 4 && segs[2] === "roster" && ["add", "excuse", "restore"].includes(segs[3]!) && m === "POST") {
      const b = (await readJsonObject(req)) ?? {};
      const memberId = requiredString(b, "memberId", 100);
      if (!memberId) return { status: 400, body: { error: "memberId required" } };
      // THE AUDITED FORCED EXCUSE (T17), excuse-only. `force` is what lets an
      // operator clear a session already stranded by a weightless take on file;
      // it is refused on a terminal session and audited under its own action
      // (`roster_excuse_forced`) with the operator's `reason`. Every other
      // roster operation keeps exactly the pre-T17 contract.
      if (segs[3] === "excuse") {
        const force = b.force === true;
        const reason = optionalString(b, "reason", 500);
        if (!force && reason !== undefined) {
          return { status: 400, body: { error: "reason is only recorded for a forced excuse (send force: true)" } };
        }
        return fromResult(await admin.rosterExcuseAdmin(sessionId, memberId, admin.ADMIN_ACTOR, { force, reason }));
      }
      const fn = { add: admin.rosterAddAdmin, restore: admin.rosterRestoreAdmin }[segs[3] as "add" | "restore"];
      return fromResult(await fn(sessionId, memberId));
    }
    // Issue #754. Not a state transition and therefore not versioned: it
    // publishes an artifact ABOUT a session rather than moving it, and it is
    // idempotent — the second call returns the receipt already on file.
    if (sessionId && segs.length === 3 && segs[2] === "consensus-receipt" && m === "POST") {
      return fromResult(await admin.publishConsensusReceiptAdmin(sessionId));
    }
    // THE API DOES NOT JUDGE (issue #1026 W4). `judge` is answered here rather
    // than left to fall through to the 404 below, because a 404 would read as
    // "you got the URL wrong" for a verb that was real and is deliberately
    // gone. system-scheduler-spec.md §1 puts judging in a participant — a
    // container of its own with its own model key — and §7 keeps that key out
    // of every process holding a database credential, which this one is. The
    // judge CONFIG routes further down are untouched: they set a row, they do
    // not call a model.
    if (sessionId && segs.length === 3 && segs[2] === "judge" && m === "POST") {
      return {
        status: 410,
        body: {
          error: "this API does not judge: judging is a participant that subscribes over HTTP with its own " +
            "model key (system-scheduler-spec.md §1, §7). Use the epoch judging request, not this route",
        },
      };
    }
    return { status: 404, body: { error: "unknown sessions admin route" } };
  }

  // ── Consensus judge switch (issue #752) ───────────────────────────────
  // The one control that must work WITHOUT a redeploy: an operator watching the
  // judge misbehave on live sessions needs `mode: "off"` to take effect on the
  // next session, not on the next deploy. Hence a database row behind a POST,
  // rather than an environment variable behind a container restart.
  //
  // THIS ROUTE IS THE ONLY WRITER of `swarm_judge_config` (smoke-production-spec.md
  // §6.2). The two statements it reaches are registered queries whose declared
  // caller is this module (swarm/judge-config.ts), and
  // tests/swarm-judge-config-registry.test.ts asserts that from the registry.
  //
  // TWO MODES. `shadow` is refused like any other unknown value: D48's replay
  // prerequisite was waived by D53, and no write path accepts it.
  if (segs[0] === "judge" && segs.length === 1) {
    if (m === "GET") return fromResult(await admin.getJudgeConfigAdmin());
    if (m === "POST") {
      const b = (await readJsonObject(req)) ?? {};
      const patch: { mode?: JudgeMode; minTakes?: number; model?: string | null; thirdPartyEnabled?: boolean } = {};
      if (b.mode !== undefined) {
        if (!JUDGE_MODES.includes(b.mode as JudgeMode)) {
          return { status: 400, body: { error: "mode must be off|enforce" } };
        }
        patch.mode = b.mode as JudgeMode;
      }
      if (b.minTakes !== undefined) {
        const minTakes = Number(b.minTakes);
        if (!Number.isInteger(minTakes) || minTakes < 1) return { status: 400, body: { error: "minTakes must be a positive integer" } };
        patch.minTakes = minTakes;
      }
      if (b.model !== undefined) {
        // `null` unsets the model — that is how an operator stops model prose
        // without stopping the judge.
        if (b.model === null) patch.model = null;
        else if (typeof b.model === "string" && b.model.trim() !== "" && b.model.length <= 200) patch.model = b.model.trim();
        else return { status: 400, body: { error: "model must be a non-empty string (max 200 chars), or null" } };
      }
      if (b.thirdPartyEnabled !== undefined) {
        // Issue #796. The admin-flippable, no-redeploy gate for third-party
        // (graduated-member) judging, independent of `mode` — the built-in
        // worker's judgements are unaffected either way.
        if (typeof b.thirdPartyEnabled !== "boolean") {
          return { status: 400, body: { error: "thirdPartyEnabled must be a boolean" } };
        }
        patch.thirdPartyEnabled = b.thirdPartyEnabled;
      }
      if (patch.mode === undefined && patch.minTakes === undefined && patch.model === undefined && patch.thirdPartyEnabled === undefined) {
        return { status: 400, body: { error: "mode, minTakes, model or thirdPartyEnabled required" } };
      }
      return fromResult(await admin.setJudgeConfigAdmin(patch));
    }
    return { status: 404, body: { error: "unknown judge admin route" } };
  }

  // ── The TEST-ONLY judge fault-injection lever (R13, AC-E2E-06) ─────────
  // A sibling of the judge switch above and for the same reason: an acceptance
  // rehearsal must be able to stage a malformed judge response on a RUNNING
  // stack, and the shipped artifact must be the thing that is exercised. Every
  // gate lives below this handler (backend/src/swarm/judge-fault-injection.ts):
  // the process flag, the acceptance-path second opt-in, and the audit row.
  if (segs[0] === "judge" && segs[1] === "fault-injection" && segs.length === 2) {
    if (m === "GET") return fromResult(await admin.getJudgeFaultInjectionAdmin());
    if (m === "POST") {
      const b = (await readJsonObject(req)) ?? {};
      if (typeof b.enabled !== "boolean") return { status: 400, body: { error: "enabled must be a boolean" } };
      const patch: { enabled: boolean; body?: string; remaining?: number; sessionId?: string | null; note?: string | null } = {
        enabled: b.enabled,
      };
      if (b.body !== undefined) {
        if (typeof b.body !== "string") return { status: 400, body: { error: "body must be a string" } };
        patch.body = b.body;
      }
      if (b.remaining !== undefined) {
        const remaining = Number(b.remaining);
        if (!Number.isInteger(remaining)) return { status: 400, body: { error: "remaining must be an integer" } };
        patch.remaining = remaining;
      }
      if (b.sessionId !== undefined) {
        if (b.sessionId !== null && typeof b.sessionId !== "string") {
          return { status: 400, body: { error: "sessionId must be a uuid string, or null" } };
        }
        patch.sessionId = b.sessionId;
      }
      if (b.note !== undefined) {
        if (b.note !== null && typeof b.note !== "string") return { status: 400, body: { error: "note must be a string, or null" } };
        patch.note = b.note;
      }
      return fromResult(await admin.setJudgeFaultInjectionAdmin(patch));
    }
    return { status: 404, body: { error: "unknown judge admin route" } };
  }

  // ── Audit ─────────────────────────────────────────────────────────────
  if (segs[0] === "audit" && m === "GET") {
    const limitRaw = url.searchParams.get("limit");
    return {
      status: 200,
      body: {
        entries: await admin.listAuditLog({
          actor: url.searchParams.get("actor") ?? undefined,
          action: url.searchParams.get("action") ?? undefined,
          since: url.searchParams.get("since") ?? undefined,
          until: url.searchParams.get("until") ?? undefined,
          limit: limitRaw ? Number(limitRaw) : undefined,
        }),
      },
    };
  }

  // ── Agent health (issue #208) ────────────────────────────────────────────
  if (segs[0] === "agent-health" && m === "GET") {
    const limitRaw = url.searchParams.get("limit");
    const eventTypeRaw = url.searchParams.get("eventType") ?? undefined;
    if (eventTypeRaw !== undefined && eventTypeRaw !== "absent" && eventTypeRaw !== "rejected_signature") {
      return { status: 400, body: { error: "eventType must be absent|rejected_signature" } };
    }
    return {
      status: 200,
      body: await getAgentHealthEvents({
        sessionId: url.searchParams.get("sessionId") ?? undefined,
        memberId: url.searchParams.get("memberId") ?? undefined,
        eventType: eventTypeRaw,
        limit: limitRaw ? Number(limitRaw) : undefined,
      }),
    };
  }

  return { status: 404, body: { error: "unknown swarm admin route" } };
}
