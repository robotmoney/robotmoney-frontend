import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runSmokeTwinRehearsal } from "../../../../scripts/lib/smoke-twin-rehearsal.ts";
import postgres from "postgres";
import { RECEIPT_DOMAIN_SEPARATOR, ROUTES, path } from "@robotmoney/contract";
import type * as postgresTypes from "postgres";
import { TAG_GLOB } from "./release.ts";

const dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(dir, "..", "..", "..", "..");
const backupDir = process.argv.find((a) => !a.startsWith("-") && a !== process.argv[0] && a !== process.argv[1]);
const emit = process.argv.includes("--emit-receipt");
const FUSION_RECEIPT_DEADLINE_MS = 15 * 60 * 1000;

export interface ReceiptCandidate { sessionId: string; source: string; mode: string; fallbackReason?: string | null }

/**
 * Fallback reasons that DISQUALIFY a receipt rather than describing a failure it
 * survived (checklist §4.1, AC-MODEL-01, decision D15).
 *
 * The first five are the FAIL-CLOSED classes: judge.ts refuses to publish on
 * them, so no judgement row and no receipt is written by this candidate at all
 * — but this command also runs against databases with history, and a rehearsal
 * that accepted a `credit_exhausted` fallback would hand the acceptance gate
 * exactly the poisoned evidence the QA plan makes a stop condition.
 *
 * `model_timeout` is the SIXTH, added by this release (decision D15), and it is
 * the one this candidate can still produce. It is what a judge budget below the
 * pinned model's latency looks like from the outside: a signed receipt carrying
 * deterministic template prose that no model ever authored, published by a
 * stack that is working exactly as configured. The rehearsal is the gate that
 * blocks the RC tag on a verified enforce-mode receipt; a receipt no model
 * contributed to is not that, whatever produced it.
 */
export const DISQUALIFYING_FALLBACK_REASONS: readonly string[] = Object.freeze([
  "credit_exhausted",
  "credential_rejected",
  "credential_unconfigured",
  "model_not_supported",
  "model_unconfigured",
  "model_timeout",
]);

/**
 * The subset that makes the JUDGE LANE fail closed — no judgement, no receipt,
 * nothing for the success-side poll to ever see.
 *
 * `model_timeout` is deliberately NOT here. A timeout produces a fallback
 * judgement and a published receipt; the poll above catches it on the receipt.
 * Failing the rehearsal fast on a lane error that still yields a receipt would
 * turn one slow judging into an aborted rehearsal.
 */
export const FAIL_FAST_JUDGE_LANE_REASONS: readonly string[] = Object.freeze([
  "credit_exhausted",
  "credential_rejected",
  "credential_unconfigured",
  "model_not_supported",
  "model_unconfigured",
]);

/** The reason's KEY — the part before the first `:` — since several are parameterised. */
export function isDisqualifyingFallbackReason(reason: string | null | undefined): boolean {
  const key = (reason ?? "").trim().split(":")[0]!;
  return key !== "" && DISQUALIFYING_FALLBACK_REASONS.includes(key);
}

/**
 * The fail-closed class named inside a `jobs.last_error`, or null.
 *
 * The lane records its error as `judge_unavailable:<reason>` (worker/handlers/
 * swarm.ts qualifies it precisely so this is readable), but the column is free
 * text written by several paths across several releases, so this SCANS for a
 * known class rather than parsing a shape. A name it does not recognise is not
 * a fail-fast condition — an unknown error must never abort a rehearsal that
 * would otherwise have produced a good receipt.
 */
export function failFastJudgeReason(lastError: string | null | undefined): string | null {
  const text = (lastError ?? "").trim();
  if (text === "") return null;
  return FAIL_FAST_JUDGE_LANE_REASONS.find((reason) => text.includes(reason)) ?? null;
}

export interface JudgeLaneFailure {
  jobId: number;
  sessionId: string | null;
  lastError: string;
  /** The fail-closed class, or null when the error is not one of them. */
  failFastReason: string | null;
}

/**
 * The `postgres` handle these two queries take. Same shape the backend's own
 * `DbHandle` is, spelled locally because this upgrade script is standalone and
 * must not import the shared pool (postflight-utils.ts's header).
 */
export type RehearsalDb = postgresTypes.Sql<{}> | postgresTypes.TransactionSql<{}>;

/**
 * THE RECEIPT'S OWN JUDGEMENT, VIA ITS FOREIGN KEY — not the session's latest.
 *
 * `swarm_consensus_receipts.judgement_id` names the exact append-only row the
 * receipt was assembled from. The previous correlated subquery took the
 * session's newest judgement instead (`ORDER BY j.created_at DESC LIMIT 1`),
 * and the production assembler deliberately matches on prompt_hash +
 * inputs_digest rather than latest-by-time — two enforce runs over the same
 * inputs leave two rows. So a re-judge, or a shadow-then-enforce sequence, made
 * this gate refuse a good receipt or clear a bad one. Exported so it can be
 * driven against a real database: injected into `waitForVerifiedFusionReceipt`
 * by every test, this query used to execute in none.
 */
export async function latestFusionReceiptCandidate(db: RehearsalDb, since: Date): Promise<ReceiptCandidate | null> {
  const row = (await db`
    SELECT r.session_id,
           r.receipt->'judge'->>'source' AS source,
           r.receipt->'judge'->>'mode' AS mode,
           j.fallback_reason AS fallback_reason
      FROM swarm_consensus_receipts r
      JOIN swarm_session_judgements j ON j.id = r.judgement_id
     WHERE r.published_at >= ${since}
     ORDER BY r.published_at DESC LIMIT 1
  `)[0] as { session_id?: string; source?: string; mode?: string; fallback_reason?: string | null } | undefined;
  return row?.session_id
    ? { sessionId: row.session_id, source: row.source ?? "", mode: row.mode ?? "", fallbackReason: row.fallback_reason ?? null }
    : null;
}

/**
 * THE FAILURE SIDE. The judge fails CLOSED on every credential/credit/config
 * class, so on exactly the failures this gate exists to catch there is no
 * judgement row and no receipt — the success-side poll can only run out its
 * fifteen-minute deadline and report "no post-rehearsal receipt row", which is
 * indistinguishable from a slow publish. The lane's own `jobs.last_error`
 * carries the class from the first attempt.
 */
export async function latestJudgeLaneFailure(db: RehearsalDb, since: Date): Promise<JudgeLaneFailure | null> {
  const row = (await db`
    SELECT id, scope_id, last_error FROM jobs
     WHERE kind = 'swarm.judge' AND last_error IS NOT NULL AND btrim(last_error) <> ''
       AND updated_at >= ${since}
     ORDER BY updated_at DESC, id DESC LIMIT 1
  `)[0] as { id: number | string; scope_id: string | null; last_error: string } | undefined;
  if (!row) return null;
  const lastError = String(row.last_error).trim();
  return { jobId: Number(row.id), sessionId: row.scope_id ?? null, lastError, failFastReason: failFastJudgeReason(lastError) };
}

/**
 * Just the shape this poll needs — a GET by URL — rather than `typeof fetch`,
 * whose Bun-specific `preconnect` property no test double can supply.
 */
export type ReceiptFetcher = (url: string) => Promise<Response>;

export async function waitForVerifiedFusionReceipt(opts: {
  latest: () => Promise<ReceiptCandidate | null>;
  /**
   * The failure side, polled alongside `latest`. Optional so every existing
   * caller and test keeps working; main() always supplies it.
   */
  failure?: () => Promise<JudgeLaneFailure | null>;
  backendUrl: string;
  fetcher?: ReceiptFetcher;
  timeoutMs?: number;
  pollMs?: number;
}): Promise<ReceiptCandidate> {
  const fetcher: ReceiptFetcher = opts.fetcher ?? ((url) => fetch(url));
  const deadline = Date.now() + (opts.timeoutMs ?? FUSION_RECEIPT_DEADLINE_MS);
  let last = "no post-rehearsal receipt row";
  while (Date.now() < deadline) {
    // FAILURE FIRST. On a fail-closed class there will never be a candidate, so
    // asking about the receipt first would only spend the deadline.
    if (opts.failure) {
      const failed = await opts.failure();
      if (failed?.failFastReason) {
        throw new Error(
          `judge lane job #${failed.jobId}${failed.sessionId ? ` (session ${failed.sessionId})` : ""} failed closed with ` +
            `${failed.failFastReason} — last_error ${JSON.stringify(failed.lastError)}. That is a credential/credit/configuration ` +
            "refusal: no judgement and no receipt will EVER be written for it, so waiting out the deadline would report a timeout " +
            "for a condition the lane already named (checklist §4.1 D-A7, AC-MODEL-01). See runbook §8's judge triage table.",
        );
      }
    }
    const candidate = await opts.latest();
    if (candidate) {
      if (candidate.mode !== "enforce") throw new Error(`receipt ${candidate.sessionId} carries judge.mode=${candidate.mode}, expected enforce`);
      if (candidate.source !== "model" && candidate.source !== "fallback") {
        throw new Error(`receipt ${candidate.sessionId} carries unsupported judge.source=${candidate.source}`);
      }
      // A fallback is ACCEPTABLE (AC-FE-05) — but only the kind that means "a
      // model was asked and misbehaved". A credit/credential/model-id reason
      // means no model ever authored anything, and accepting it is how an
      // exhausted account passes a staging gate.
      if (isDisqualifyingFallbackReason(candidate.fallbackReason)) {
        throw new Error(
          `receipt ${candidate.sessionId} carries judge.fallback_reason=${candidate.fallbackReason} — that is a ` +
            "credential/credit/configuration refusal, not a survivable model failure, and nothing produced after it " +
            "is acceptance evidence (checklist §4.1, AC-MODEL-01)",
        );
      }
      // TWO ROUTES, CHECKED TOGETHER (decision D10). The envelope — verdict,
      // per-signature results, the publisher's own canonical bytes — comes from
      // the `/verified` sibling; the ANCHORED path serves the bare preimage,
      // and the rehearsal's job is to prove that the URL a release would anchor
      // actually returns the bytes that hash to the anchored digest. Checking
      // only the envelope is precisely how the run that produced
      // phase3/3.1-FINDING-… passed while the anchor was unresolvable.
      const anchoredUrl = `${opts.backendUrl}${path(ROUTES.swarm.sessionConsensusReceipt, { id: candidate.sessionId })}`;
      const response = await fetcher(
        `${opts.backendUrl}${path(ROUTES.swarm.sessionConsensusReceiptVerified, { id: candidate.sessionId })}`,
      );
      if (response.ok) {
        const body = await response.json() as { verified?: boolean; canonicalBytes?: unknown; signatures?: unknown[] };
        // Four independent facts, reported apart so the poll's own message says
        // WHICH one is missing: a bug that ignored `verified` used to be
        // observable only as a timeout, indistinguishable from a slow publish.
        const anchored = await fetcher(anchoredUrl);
        const anchoredBody = anchored.ok ? await anchored.text() : null;
        const anchorMatches =
          anchoredBody !== null &&
          typeof body.canonicalBytes === "string" &&
          RECEIPT_DOMAIN_SEPARATOR + anchoredBody === body.canonicalBytes;
        const missing = [
          body.verified === true ? null : "not verified",
          typeof body.canonicalBytes === "string" && body.canonicalBytes.length > 0 ? null : "no canonical bytes",
          Array.isArray(body.signatures) && body.signatures.length > 0 ? null : "no signatures",
          anchorMatches
            ? null
            : anchoredBody === null
              ? `anchored URL returned ${anchored.status}`
              : "anchored URL does not serve the anchored bytes",
        ].filter((m): m is string => m !== null);
        if (missing.length === 0) return candidate;
        last = `receipt ${candidate.sessionId} served but was not verified/complete (${missing.join(", ")})`;
      } else {
        last = `receipt ${candidate.sessionId} GET returned ${response.status}`;
      }
    }
    await Bun.sleep(opts.pollMs ?? 2_000);
  }
  throw new Error(`Fusion stage acceptance timed out: ${last}`);
}

export async function main(): Promise<number> {
  const rehearsalStartedAt = new Date();
  return runSmokeTwinRehearsal({
    name: "stage-rehearsal-0.5.0", backupDir,
    onReady: async ({ databaseUrl, backendUrl, log }) => {
      const proc = Bun.spawn(["bun", `backend/scripts/upgrades/0.4.0-to-0.5.0/postflight.ts`, ...(emit ? ["--emit-receipt=P5.rehearsal"] : [])], { cwd: repoRoot, env: { ...process.env, DATABASE_URL: databaseUrl }, stdout: "inherit", stderr: "inherit" });
      const postflight = await proc.exited;
      if (postflight !== 0) return postflight;

      const db = postgres(databaseUrl, { max: 1 });
      try {
        const receipt = await waitForVerifiedFusionReceipt({
          backendUrl,
          latest: () => latestFusionReceiptCandidate(db, rehearsalStartedAt),
          failure: () => latestJudgeLaneFailure(db, rehearsalStartedAt),
        });
        log(`Fusion acceptance: verified enforce/${receipt.source} consensus receipt for session ${receipt.sessionId}`);
        return 0;
      } finally {
        await db.end({ timeout: 5 });
      }
    },
  });
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = await main();
