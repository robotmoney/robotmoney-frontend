// The shared harness every live-stack verification leg runs under.
//
// WHY A HARNESS AND NOT MORE SCRIPTS. The repo already had the legs — the CI
// smoke boot runs smoke-e2e-assert.ts, the swarm session driver, the starter
// agent, smoke-frontend-check.ts, smoke-live-smoke.ts and the onboarding eval,
// in sequence, against a live stack. What it did NOT have was a way to run them
// as a PROCESS SEPARATE FROM THE DEPLOYER: the whole sequence sits inside
// scripts/lib/smoke-main.ts behind `if (process.env.CI && !smokeMode)` and then
// tears the stack down, so a standing boot or a production cutover runs none of
// it, and the release's own postflight grew a second, much weaker code path
// that only asserts migrations landed.
//
// So this harness is deliberately thin. It owns four things and nothing else:
//
//   1. LIVENESS — wait until the stack says it is live before asserting
//      anything, so a verification failure means "the product is wrong", never
//      "the stack had not finished starting".
//   2. TIERING — a leg declares whether it is safe against production. Legs
//      that DRIVE the pipeline (publish sessions, spend inference, send mail)
//      may only run against a twin or CI.
//   3. REPORTING — one format for every check, reusing the repo's existing
//      primitives rather than inventing a parallel one.
//   4. DEADLINES — polling with a bound, because live upstreams are eventually
//      consistent right after boot (smoke-live-smoke.ts's own reasoning).
//
// REPORTING/TELEMETRY IS REUSED, NOT INVENTED. `createChecker` gives every
// check the same `[PASS|WARN|FAIL] name  detail` line and the same
// CheckResult{name,status,detail,remediation} record; `printVerdict` gives the
// same terminal verdict block; `emitReceipt` writes the same receipt JSON the
// rollout tooling already reads (step, exit, verdict, timestamps, host,
// host_role, repo sha/branch/tag/dirty, and a checks summary). A verification
// receipt is therefore consumable by `runbook.ts` exactly like a preflight or
// postflight receipt, with no new consumer to write.
import { createChecker, printVerdict, type Checker, type Status } from "../../../backend/scripts/lib/checks.ts";
import { emitReceipt, gitFacts, summarise } from "../../../backend/scripts/lib/rollout-receipt.ts";

/**
 * Where a leg may run.
 *
 * `readonly` — issues GETs and reads state. Safe against production.
 * `full`     — drives the product: publishes sessions, spends inference,
 *              sends mail, writes rows. A twin or CI only. Running one of
 *              these against production would manufacture the very history the
 *              readonly legs are there to audit.
 */
export type VerifyTier = "readonly" | "full";

export interface VerifyContext {
  /** Origin that serves PAGES and the API — website-server's, not the api's
   *  (issue #892). The caller resolves it; legs never guess a port. */
  base: string;
  tier: VerifyTier;
  checker: Checker;
  /** Wall-clock budget for polling legs, shared across the run. */
  deadlineAt: number;
  json<T>(path: string): Promise<T>;
  /** Poll `probe` until it returns a value, or the shared deadline lapses. */
  until<T>(what: string, probe: () => Promise<T | null>): Promise<T | null>;
}

export interface VerifyLeg {
  /** Short, stable id — it becomes the check-name prefix in the report. */
  name: string;
  tier: VerifyTier;
  run(ctx: VerifyContext): Promise<void>;
}

const POLL_INTERVAL_MS = 3000;

/** A GET that fails LOUDLY. A leg asserting on `null` it never noticed is the
 *  failure mode this whole file exists to avoid. */
async function getJson<T>(base: string, path: string): Promise<T> {
  const res = await fetch(`${base}${path}`, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`GET ${path} -> HTTP ${res.status}`);
  return (await res.json()) as T;
}

/**
 * Wait for the stack to declare itself live.
 *
 * `/health` is the contract, and it is the API's — the same signal the stage
 * rehearsal polls. Deliberately NOT a fixed sleep: a sleep long enough to be
 * safe on a cold box is dead time on a warm one, and a sleep short enough to be
 * quick is a flaky verification that reads as a product failure.
 */
export async function waitForLive(base: string, deadlineAt: number, log: (m: string) => void): Promise<boolean> {
  let lastNote = "no response yet";
  while (Date.now() < deadlineAt) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return true;
      lastNote = `HTTP ${res.status}`;
    } catch (e) {
      lastNote = e instanceof Error ? e.message : String(e);
    }
    await Bun.sleep(POLL_INTERVAL_MS);
  }
  log(`stack never became live at ${base}/health — last: ${lastNote}`);
  return false;
}

export interface RunVerificationOpts {
  /** Report prefix and receipt name, e.g. "verify-live". */
  name: string;
  base: string;
  tier: VerifyTier;
  legs: readonly VerifyLeg[];
  deadlineMs: number;
  repoRoot: string;
  /** Emit a receipt under this step id, e.g. "P8.verify-prod". Omit for none. */
  receiptStep?: string;
  tagGlob: string;
  hostRole: string;
}

/**
 * Run the legs the tier admits, report once, and return a process exit code.
 *
 * 0 = every check passed. 1 = at least one FAILed. 2 = could not run (the stack
 * never came live), kept distinct because "the product is broken" and "I never
 * got to look" must not share an exit code — the same contract the upgrade
 * scripts use.
 */
export async function runVerification(opts: RunVerificationOpts): Promise<number> {
  const startedAt = new Date().toISOString();
  const prefix = `[${opts.name}] `;
  const checker = createChecker(prefix);
  const log = (m: string) => console.log(`${prefix}${m}`);
  // Captured BEFORE the run: a verification takes minutes, and a receipt
  // stamped with a SHA committed halfway through describes a run that never
  // happened (rollout-receipt.ts's own rationale for the same field).
  const git = opts.receiptStep ? gitFacts(opts.repoRoot, opts.tagGlob) : undefined;
  const deadlineAt = Date.now() + opts.deadlineMs;

  log(`target ${opts.base} · tier=${opts.tier} · budget ${Math.round(opts.deadlineMs / 1000)}s`);
  if (!(await waitForLive(opts.base, deadlineAt, log))) {
    log("VERDICT: COULD NOT RUN — nothing was asserted.");
    return 2;
  }

  const ctx: VerifyContext = {
    base: opts.base,
    tier: opts.tier,
    checker,
    deadlineAt,
    json: <T,>(path: string) => getJson<T>(opts.base, path),
    async until<T>(what: string, probe: () => Promise<T | null>): Promise<T | null> {
      let last: T | null = null;
      for (;;) {
        try {
          last = await probe();
        } catch {
          last = null; // a transient read is not a verdict; the deadline is
        }
        if (last !== null) return last;
        if (Date.now() >= deadlineAt) {
          log(`deadline lapsed waiting for: ${what}`);
          return null;
        }
        await Bun.sleep(POLL_INTERVAL_MS);
      }
    },
  };

  const admitted = opts.legs.filter((leg) => opts.tier === "full" || leg.tier === "readonly");
  const skipped = opts.legs.filter((leg) => !admitted.includes(leg));
  for (const leg of skipped) {
    // Recorded, never silent. A leg that did not run must be visible in the
    // report, or a readonly run reads like a full one.
    checker.record(`${leg.name}:skipped`, "WARN", `not run at tier=${opts.tier} (leg requires tier=full)`);
  }

  for (const leg of admitted) {
    try {
      await leg.run(ctx);
    } catch (e) {
      checker.record(
        `${leg.name}:error`,
        "FAIL",
        `leg threw: ${e instanceof Error ? e.message : String(e)}`,
        "A leg that throws has asserted nothing; treat it as a failure, not a skip.",
      );
    }
  }

  const exit = printVerdict(checker.results, {
    logPrefix: prefix,
    okAll: `${prefix}VERDICT: LIVE PRODUCT VERIFIED`,
    okWithWarnings: `${prefix}VERDICT: VERIFIED WITH WARNINGS`,
    blocked: `${prefix}VERDICT: PRODUCT CHECKS FAILED`,
  });

  if (opts.receiptStep) {
    const { path } = emitReceipt({
      step: opts.receiptStep,
      exit,
      verdict: exit === 0 ? "LIVE PRODUCT VERIFIED" : "PRODUCT CHECKS FAILED",
      startedAt,
      repoRoot: opts.repoRoot,
      tagGlob: opts.tagGlob,
      hostRole: opts.hostRole,
      git,
      checks: checker.results.length ? summarise(checker.results) : undefined,
    });
    log(`receipt → ${path}`);
  }
  return exit;
}

/** Convenience for legs: record PASS/FAIL from a problem list. */
export function recordProblems(
  checker: Checker,
  name: string,
  problems: readonly string[],
  okDetail: string,
  remediation?: string,
): Status {
  const status: Status = problems.length ? "FAIL" : "PASS";
  checker.record(name, status, problems.length ? [...problems] : okDetail, remediation);
  return status;
}
