// The pipeline worker's startup check (issue 1034, decision D75).
//
// The worker used to run preflight checks 1-3 against its own rm_worker
// credential (smoke spec §7.2). It holds no credential now, so its check is the
// one a participant runs (§7.2's third caller): the api is reachable and the
// token is valid with the rights it needs. The result is one log line a stack's
// readiness reads (scripts/lib/smoke-readiness-scheduler.ts).
import { waitForApiReady } from "./boot.ts";
import { PipelineRequestError, PipelineUnreachableError, whoami } from "./pipeline-client.ts";

/** The line a passed check logs. Readiness matches it exactly. */
export const PIPELINE_STARTUP_PASSED = "pipeline_startup: passed";

/** The prefix of a refusal's line. */
export const PIPELINE_STARTUP_REFUSED = "pipeline_startup: refused:";

/** The rights the pipeline-worker token must carry (db/automation-tokens.ts HOLDER_RIGHTS). */
const REQUIRED_RIGHTS = ["pipeline_queue", "pipeline_ingest"] as const;

/**
 * The database keys present (non-empty) in `env`: DATABASE_URL,
 * WORKER_DATABASE_URL, any other `*DATABASE_URL`, and the libpq connection
 * keys. The worker refuses to start when this is not empty.
 */
export function databaseKeysIn(env: Record<string, string | undefined>): string[] {
  const libpq = new Set(["PGHOST", "PGHOSTADDR", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD", "PGPASSFILE", "PGSERVICE"]);
  return Object.keys(env)
    .filter((key) => (key.endsWith("DATABASE_URL") || libpq.has(key)) && (env[key] ?? "").trim() !== "")
    .sort();
}

export interface StartupOutcome {
  readonly passed: boolean;
  readonly line: string;
}

/**
 * Wait for the api's /health (when given), then ask /api/pipeline/whoami with
 * the token. Passes when the api answers for the pipeline-worker holder with
 * both rights; refuses on a 401/403, a token of another holder or missing a
 * right, or a token file that cannot be read.
 */
export async function pipelineStartupCheck(options: {
  apiHealthUrl: string | null;
  signal?: AbortSignal;
}): Promise<StartupOutcome> {
  const refused = (reason: string): StartupOutcome => ({ passed: false, line: `${PIPELINE_STARTUP_REFUSED} ${reason}` });
  if (options.apiHealthUrl) {
    const ready = await waitForApiReady(options.apiHealthUrl, {
      signal: options.signal,
      onWait: (detail) => console.warn(`pipeline_startup: ${detail}; retrying`),
    });
    if (!ready) return refused("stopped before the api answered");
  }
  for (;;) {
    try {
      const me = await whoami();
      if (me.holder !== "pipeline-worker") return refused(`the token belongs to ${me.holder}, not pipeline-worker`);
      const missing = REQUIRED_RIGHTS.filter((r) => !me.rights.includes(r));
      if (missing.length > 0) return refused(`the token lacks ${missing.join(", ")}`);
      return { passed: true, line: PIPELINE_STARTUP_PASSED };
    } catch (err) {
      // An api that is still starting is waited for, not refused.
      if (err instanceof PipelineUnreachableError && !options.signal?.aborted) continue;
      if (err instanceof PipelineRequestError) return refused(err.message);
      return refused(err instanceof Error ? err.message : String(err));
    }
  }
}
