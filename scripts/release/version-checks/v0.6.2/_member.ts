// scripts/release/version-checks/v0.6.2/_member.ts — shared by the v0.6.2
// checks that call the take dry run (closed-session-take, dry-run-take). Not a
// check itself: the leading underscore is no valid check name, so the
// dispatcher (../../version-check.ts) can never run it.
//
// The dry run (POST /api/swarm/submit/dry-run, RM-178) needs a member bearer.
// The host's own in-house agents hold theirs in the credential file
// `~/.env`'s RM_CREDENTIALS names (scripts/lib/swarm/credential-file.ts). The
// bearer goes only into the Authorization header: never into `found`, a
// problem or a log line. The dry run writes nothing (domain.ts
// dryRunSubmission: every submit check, no insert), which each check proves by
// counting rows before and after.
import { randomUUID } from "node:crypto";
import { homeEnvFilePath, loadEnvFile } from "../../../lib/env-role.ts";
import { loadCredentialFile } from "../../../lib/swarm/credential-file.ts";

/** The in-house agents, in the order a check tries them (scripts/release/baseline.ts IN_HOUSE_HANDLES, judges excluded). */
export const IN_HOUSE_AGENTS: readonly string[] = Object.freeze(["noop-analyst", "athena", "robot-money"]);

export interface InHouseMember {
  readonly handle: string;
  readonly memberId: string;
  readonly bearer: string;
}

/** PURE. The first in-house agent the credential file's agents namespace holds, or undefined. */
export function pickInHouseAgent(agents: Record<string, { memberId?: string; bearer?: string }>): InHouseMember | undefined {
  for (const handle of IN_HOUSE_AGENTS) {
    const e = agents[handle];
    if (e && typeof e.memberId === "string" && e.memberId !== "" && typeof e.bearer === "string" && e.bearer !== "") {
      return { handle, memberId: e.memberId, bearer: e.bearer };
    }
  }
  return undefined;
}

/** The host's in-house agent credential, or the reason there is none (never its value). */
export function loadInHouseMember(home: string | undefined = process.env.HOME): InHouseMember | { error: string } {
  const envPath = homeEnvFilePath(home);
  const env = loadEnvFile(envPath);
  const path = env?.RM_CREDENTIALS?.trim();
  if (!path) return { error: `${envPath} names no RM_CREDENTIALS file` };
  let agents: Record<string, { memberId?: string; bearer?: string }>;
  try {
    agents = loadCredentialFile(path).agents;
  } catch (error) {
    return { error: `the credential file ${path} cannot be read: ${error instanceof Error ? error.message : String(error)}` };
  }
  return pickInHouseAgent(agents) ?? { error: `the credential file ${path} holds none of ${IN_HOUSE_AGENTS.join(", ")}` };
}

/**
 * PURE. A dry-run take body: every field submit requires (backend/src/api/
 * validation.ts validateSubmission), a fresh nonce, and a signature that is
 * deliberately not one, so nothing about it could ever be filed.
 */
export function dryRunBody(opts: { memberId: string; subjectId: string; date: string; sessionId?: string; nonce?: string }): Record<string, unknown> {
  return {
    memberId: opts.memberId,
    date: opts.date,
    subjectId: opts.subjectId,
    nonce: opts.nonce ?? `version-check-${randomUUID()}`,
    stance: "neutral",
    confidence: 0.5,
    signature: "version-check-unsigned",
    ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
  };
}

/** A take check's outcome as the dry run reports it (contract SwarmTakeCheck). */
export interface DryRunCheck {
  readonly check: string;
  readonly ok: boolean;
  readonly status?: number;
  readonly error?: string;
  readonly situational?: boolean;
}

export interface DryRunVerdict {
  readonly dryRun?: boolean;
  readonly sessionId?: string | null;
  readonly checks?: readonly DryRunCheck[];
}

/** PURE. A session or member id is a uuid-like token before it is put in SQL text. */
export function safeId(id: string): boolean {
  return /^[A-Za-z0-9-]{1,100}$/.test(id);
}
