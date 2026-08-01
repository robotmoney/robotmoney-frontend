// Agent activity log feed (issue #392, docs/bot-analytics-ui-port-plan.md
// §5.6, P4.1): backs the /market + /dashboard TerminalFeed — "Live feed of
// every tracked agent action across the network." `backend/src/api/routes/
// dashboards.ts` is the thin adapter that exposes this as
// GET /api/dashboards/activity.
//
// Reads ONLY — the pipeline writer that populates agent_activity_log (P1.6)
// is a separate, not-yet-landed follow-up (same honesty-contract precedent as
// issue #70's `projects` tables): a fresh deploy has an empty table and this
// returns `{ entries: [] }`, never a fabricated row (issue #98/#346).
import { sql } from "../db/client.ts";
import type { ActivityLogEntry, ActivityLogResponse, ActivityLogStatus } from "@robotmoney/contract";

// §5.6: "50 fetched, zero-score noise filtered, 20 shown" — the DB fetch is
// capped at 50 most-recent rows; the terminal's own max-h-420px scroll box is
// what limits the VISIBLE window to ~20 lines (no separate slice here, so a
// viewer can still scroll to the 21st..50th).
const FETCH_LIMIT = 50;

export async function fetchActivityLog(): Promise<ActivityLogResponse> {
  const rows = await sql<
    {
      id: string;
      occurred_at: string | Date;
      agent_id: string | null;
      agent_name: string;
      live_agent_name: string | null;
      action_type: string;
      status: ActivityLogStatus;
      commit_summary: string | null;
      submitted_by: string | null;
      approved_by: string | null;
    }[]
  >`
    SELECT
      al.id,
      al.occurred_at,
      al.agent_id,
      al.agent_name,
      oa.name AS live_agent_name,
      al.action_type,
      al.status,
      al.commit_summary,
      al.submitted_by,
      al.approved_by
    FROM agent_activity_log al
    LEFT JOIN openclaw_agents oa ON oa.id = al.agent_id
    WHERE al.score IS NULL OR al.score <> 0
    ORDER BY al.occurred_at DESC
    LIMIT ${FETCH_LIMIT}
  `;

  const entries: ActivityLogEntry[] = rows.map((r) => ({
    id: r.id,
    occurredAt: new Date(r.occurred_at).toISOString(),
    agentId: r.agent_id,
    // Prefer the live agent's current name (kept in sync with /agents/:id);
    // fall back to the denormalized name captured at write time, so a row
    // still reads sensibly after its agent is deleted (agent_id -> null via
    // ON DELETE SET NULL).
    agentName: r.live_agent_name ?? r.agent_name ?? "",
    agentHref: r.agent_id ? `/agents/${r.agent_id}` : null,
    actionType: r.action_type,
    status: r.status,
    commitSummary: r.commit_summary,
    submittedBy: r.submitted_by,
    approvedBy: r.approved_by,
  }));

  return { entries };
}
