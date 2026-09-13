import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runSmokeTwinRehearsal } from "../../../../scripts/lib/smoke-twin-rehearsal.ts";
import postgres from "postgres";
import { TAG_GLOB } from "./release.ts";

const dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(dir, "..", "..", "..", "..");
const backupDir = process.argv.find((a) => !a.startsWith("-") && a !== process.argv[0] && a !== process.argv[1]);
const emit = process.argv.includes("--emit-receipt");
const FUSION_RECEIPT_DEADLINE_MS = 15 * 60 * 1000;

export interface ReceiptCandidate { sessionId: string; source: string; mode: string; fallbackReason?: string | null }

/**
 * Fallback reasons that DISQUALIFY a receipt rather than describing a failure it
 * survived (checklist §4.1, AC-MODEL-01).
 *
 * judge.ts fails closed on all of these now, so a receipt carrying one cannot be
 * produced by this candidate at all — but this command also runs against
 * databases with history, and a rehearsal that accepted a `credit_exhausted`
 * fallback would hand the acceptance gate exactly the poisoned evidence the QA
 * plan makes a stop condition: an exhausted account's template prose, signed,
 * and indistinguishable from a legitimate outage fallback.
 */
export const DISQUALIFYING_FALLBACK_REASONS: readonly string[] = Object.freeze([
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
 * Just the shape this poll needs — a GET by URL — rather than `typeof fetch`,
 * whose Bun-specific `preconnect` property no test double can supply.
 */
export type ReceiptFetcher = (url: string) => Promise<Response>;

export async function waitForVerifiedFusionReceipt(opts: {
  latest: () => Promise<ReceiptCandidate | null>;
  backendUrl: string;
  fetcher?: ReceiptFetcher;
  timeoutMs?: number;
  pollMs?: number;
}): Promise<ReceiptCandidate> {
  const fetcher: ReceiptFetcher = opts.fetcher ?? ((url) => fetch(url));
  const deadline = Date.now() + (opts.timeoutMs ?? FUSION_RECEIPT_DEADLINE_MS);
  let last = "no post-rehearsal receipt row";
  while (Date.now() < deadline) {
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
      const response = await fetcher(`${opts.backendUrl}/api/swarm/sessions/${encodeURIComponent(candidate.sessionId)}/consensus-receipt`);
      if (response.ok) {
        const body = await response.json() as { verified?: boolean; canonicalBytes?: unknown; signatures?: unknown[] };
        // Three independent facts, reported apart so the poll's own message says
        // WHICH one is missing: a bug that ignored `verified` used to be
        // observable only as a timeout, indistinguishable from a slow publish.
        const missing = [
          body.verified === true ? null : "not verified",
          typeof body.canonicalBytes === "string" && body.canonicalBytes.length > 0 ? null : "no canonical bytes",
          Array.isArray(body.signatures) && body.signatures.length > 0 ? null : "no signatures",
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
          latest: async () => {
            // The receipt's own `judge` block carries source and mode but NOT
            // the reason, so the reason comes from the judgement row the
            // receipt was assembled from — which is the only place that can
            // tell a survivable model failure from a credit/credential refusal.
            const row = (await db`
              SELECT r.session_id,
                     r.receipt->'judge'->>'source' AS source,
                     r.receipt->'judge'->>'mode' AS mode,
                     (SELECT j.fallback_reason FROM swarm_session_judgements j
                       WHERE j.session_id = r.session_id ORDER BY j.created_at DESC LIMIT 1) AS fallback_reason
                FROM swarm_consensus_receipts r
               WHERE r.published_at >= ${rehearsalStartedAt}
               ORDER BY r.published_at DESC LIMIT 1
            `)[0] as { session_id?: string; source?: string; mode?: string; fallback_reason?: string | null } | undefined;
            return row?.session_id
              ? { sessionId: row.session_id, source: row.source ?? "", mode: row.mode ?? "", fallbackReason: row.fallback_reason ?? null }
              : null;
          },
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
