// POST /api/dashboards/submissions (issue #393, docs/bot-analytics-ui-port-
// plan.md §5.17): public, anonymous /submit intake — the CommitForm's
// backend. Same shape as comments.ts (validate → rate-limit per hashed ip →
// insert → return the created row): a real Postgres row every time, never a
// client-side fabricated "submitted!" with nothing persisted (the honesty
// contract this issue's own scope note — "no synthetic mock data" — extends
// to the write path, not just reads). No auto-publish: every row lands
// status='pending' for later moderation from /admin (that surface itself is
// P4.4's own follow-up, tracked separately — out of this issue's narrow
// scope).
import type { Submission, SubmissionActionType, SubmissionCreate, SubmissionRegistration } from "@robotmoney/contract";
import { jsonValue, sql } from "../../db/client.ts";
import { hashKey } from "../../lib/keys.ts";

const MAX_HANDLE = 80;
const MAX_SUMMARY = 4000;
const MAX_TEXT = 500;

// The 8 action types the form's action-type Select offers (§5.17: "action-
// type Select (8 types incl. 🤖 Register Agent)").
export const SUBMISSION_ACTION_TYPES: SubmissionActionType[] = [
  "register_agent",
  "update_agent",
  "link_wallet",
  "link_token",
  "link_vault",
  "report_issue",
  "endorse_agent",
  "general",
];

// Same simple single-box rate limit as comments.ts (createComment) — abuse
// mitigation, not durable accounting, so an in-memory sliding window keyed by
// hashed ip is enough. Kept as an independent copy (not shared with comments)
// since the two surfaces have different abuse profiles and caps; duplicating
// ~15 lines here is cheaper than introducing a shared rate-limit module for
// two call sites.
const RATE_MAX = 5;
const RATE_WINDOW_MS = 60_000;
const postLog = new Map<string, number[]>();
let sweepCounter = 0;

function sweep(now: number): void {
  if (++sweepCounter < 500) return;
  sweepCounter = 0;
  const cutoff = now - RATE_WINDOW_MS;
  for (const [k, ts] of postLog) {
    const r = ts.filter((t) => t > cutoff);
    if (r.length === 0) postLog.delete(k);
    else postLog.set(k, r);
  }
}

function rateLimited(ipHash: string, now = Date.now()): boolean {
  const cutoff = now - RATE_WINDOW_MS;
  const recent = (postLog.get(ipHash) ?? []).filter((t) => t > cutoff);
  if (recent.length >= RATE_MAX) {
    postLog.set(ipHash, recent);
    return true;
  }
  recent.push(now);
  postLog.set(ipHash, recent);
  sweep(now);
  return false;
}

const iso = (d: unknown): string => (d instanceof Date ? d.toISOString() : new Date(d as string).toISOString());

function toSubmission(r: any): Submission {
  return {
    id: r.id,
    actionType: r.action_type,
    submitterHandle: r.submitter_handle,
    agentId: r.agent_id ?? null,
    summary: r.summary,
    registration: r.registration ?? null,
    status: r.status,
    createdAt: iso(r.created_at),
  };
}

function str(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t || t.length > max) return null;
  return t;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// registration is only required/validated when actionType === 'register_agent'
// (§5.17: "agent-registration sub-panel (name*, wallet, description + …
// Claimed Metrics …)"). Every other field is optional — a submitter reporting
// an issue or endorsing an existing agent never needs it.
function parseRegistration(raw: unknown): SubmissionRegistration | null {
  if (raw == null || typeof raw !== "object") return null;
  const b = raw as Partial<SubmissionRegistration>;
  const name = str(b.name, MAX_TEXT);
  if (!name) return null;
  return {
    name,
    walletAddress: str(b.walletAddress, MAX_TEXT),
    description: str(b.description, MAX_SUMMARY),
    claimedRevenueUsd: num(b.claimedRevenueUsd),
    claimedTxns: num(b.claimedTxns),
    claimedUsers: num(b.claimedUsers),
    website: str(b.website, MAX_TEXT),
    twitter: str(b.twitter, MAX_TEXT),
    launchDate: str(b.launchDate, 20),
  };
}

export type CreateResult = { status: number; body: Submission | { error: string } };

// POST /api/dashboards/submissions — validate, rate-limit per hashed ip,
// insert, return the created Submission (201). Never persists a fabricated
// row: an invalid or empty body 400s before touching the database.
export async function createSubmission(raw: unknown, ip: string): Promise<CreateResult> {
  const b = (raw ?? {}) as Partial<SubmissionCreate>;
  const actionType = typeof b.actionType === "string" ? b.actionType : "";
  const submitterHandle = str(b.submitterHandle, MAX_HANDLE);
  const summary = str(b.summary, MAX_SUMMARY);
  const agentId = b.agentId ? String(b.agentId) : null;

  if (!SUBMISSION_ACTION_TYPES.includes(actionType as SubmissionActionType)) {
    return { status: 400, body: { error: "invalid actionType" } };
  }
  if (!submitterHandle) return { status: 400, body: { error: "submitterHandle is required" } };
  if (!summary) return { status: 400, body: { error: "summary is required" } };

  let registration: SubmissionRegistration | null = null;
  if (actionType === "register_agent") {
    registration = parseRegistration(b.registration);
    if (!registration) return { status: 400, body: { error: "registration.name is required for register_agent" } };
  }

  const ipHash = hashKey(ip || "unknown");
  if (rateLimited(ipHash)) {
    return { status: 429, body: { error: "too many submissions — slow down and try again shortly" } };
  }

  const rows = await sql<any[]>`
    INSERT INTO analytics_submissions (action_type, submitter_handle, agent_id, summary, registration, ip_hash)
    VALUES (${actionType}, ${submitterHandle}, ${agentId}, ${summary}, ${registration ? sql.json(jsonValue(registration)) : null}, ${ipHash})
    RETURNING id, action_type, submitter_handle, agent_id, summary, registration, status, created_at`;
  return { status: 201, body: toSubmission(rows[0]) };
}
