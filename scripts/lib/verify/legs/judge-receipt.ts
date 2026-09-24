// INVARIANT #4 — the judge is a MODEL, and it produces a CERTIFICATE.
//
// WHY THIS EXISTS. Everything about the judge failed silently, in four
// independent places at once, and every check this repo runs stayed green
// through all of them:
//
//   1. `swarm_judge_config.mode` is `off` in production, and a twin restores
//      production — so every twin boot judged nothing at all.
//   2. `OPENCODE_API_KEY` reached the member-agent containers but not the
//      worker lane that ran the judge (that lane is gone — issue #1026 made the
//      judge a participant, which receives its model key from
//      `credential.json` like every other participant, smoke-production-spec.md
//      §3), so `resolveJudgeTransport()` returned null and every judgement was
//      template prose.
//   3. A twin adopted production's in-flight session and inherited its
//      six-hour window, so the lifecycle stalled before the judge job.
//   4. The Zen REST API rejects the provider-qualified model id the config
//      holds — with HTTP **401**, which reads as a bad credential.
//
// None of that is visible from outside: a session with a template opinion
// publishes, renders and signs exactly like one a model wrote. The only
// difference is a column. So this leg reads the column, over HTTP, off the
// receipt the product actually serves.
//
// TIER `full`, like twin-roster and for the same reason: production ships the
// judge `off` by design, so "no judgement" is correct there and must not be a
// failure. This asserts what a TWIN owes.
import { ROUTES, path as routePath } from "@robotmoney/contract";
import type { VerifyContext, VerifyLeg } from "../harness.ts";

/** How many of the newest published sessions to look through for one this boot judged. */
const LOOKBACK = 5;

interface SessionRow {
  id: string;
  date: string;
  subjectId: string;
  state: string;
  publishedAt: string | null;
}

/**
 * What the ROUTE serves, which is not the receipt itself: the stored artifact
 * is nested under `receipt`, beside the signature material the page renders.
 * Reading `judge` off the top level (as the first cut of this leg did) makes
 * every receipt look unjudged — a FAIL that blames the product for a reader
 * bug, which is the failure this file's neighbour warns about.
 */
interface ReceiptResponse {
  sessionId?: string;
  schemaVersion?: string;
  /** True when the stored canonical bytes verify against a published signature. */
  verified?: boolean;
  signatures?: unknown[];
  receipt?: Receipt;
}

interface Receipt {
  // The STORED artifact's key is `mode` (verified against a published receipt:
  // `jsonb_object_keys(receipt->'judge')` = mode, source, rationale,
  // disagreements, release_safety). consensus-receipt.ts's TS interface spells
  // the field `judge_mode`, so both are read — keying this on the wrong one
  // made the shadow guard below dead code that could never fire, which is the
  // same "two sides keyed differently" defect twin-roster's test exists for.
  judge?: { source?: string; mode?: string; judge_mode?: string; rationale?: string };
  session?: { id?: string };
  schema_version?: string;
}

/**
 * Is this receipt evidence of a real model call?
 *
 * PURE, and the whole point of the leg: `source` is the one field that
 * separates "a model read the takes and wrote this" from "the aggregator's own
 * template wrote this under the judge's name". `judge_mode` matters too —
 * `shadow` records an opinion the session never adopted, so a receipt carrying
 * one attests less than it appears to.
 */
export function receiptVerdict(body: ReceiptResponse | Receipt): { ok: boolean; why: string } {
  // Accepts the served envelope or a bare receipt, so a shape change surfaces
  // as a failed assertion here rather than as "the product is unjudged".
  const envelope = body as ReceiptResponse;
  const receipt: Receipt = envelope.receipt ?? (body as Receipt);
  const source = receipt.judge?.source;
  const mode = receipt.judge?.mode ?? receipt.judge?.judge_mode;
  const verified = envelope.verified;
  if (!source) return { ok: false, why: "receipt carries no judge.source — it is not a judged receipt at all" };
  if (source !== "model") {
    return {
      ok: false,
      why: `judge.source='${source}', not 'model' — this certificate attests TEMPLATE PROSE, not inference. ` +
        "Check swarm_judge_config.model and that OPENCODE_API_KEY reaches the judge participant's container.",
    };
  }
  if (mode && mode !== "enforce") {
    return { ok: false, why: `judge_mode='${mode}' — only an enforce judgement is one the session adopted` };
  }
  // A CERTIFICATE THAT DOES NOT VERIFY IS NOT ONE. `verified` is the route's own
  // answer on the stored canonical bytes against the published signature; only
  // an explicit `false` fails, so a response that omits it is not read as a lie.
  if (verified === false) {
    return { ok: false, why: "receipt is served with verified=false — its canonical bytes do not match its signature" };
  }
  return {
    ok: true,
    why: `judge.source='model'${mode ? `, judge_mode='${mode}'` : ""}${verified === true ? ", signature verified" : ""}`,
  };
}

export const judgeReceiptLeg: VerifyLeg = {
  name: "judge",
  tier: "full",

  async run(ctx: VerifyContext): Promise<void> {
    const { checker } = ctx;

    // Polled: the judge sits between aggregate and publish, and the model call
    // itself is bounded at ~60s, so a read taken the instant a session
    // publishes can legitimately precede the receipt.
    let lastSeen: string | null = null;
    const found = await ctx.until("a published session carrying a consensus receipt", async () => {
      const body = await ctx.json<{ sessions?: SessionRow[] }>(ROUTES.swarm.sessions);
      const published = (body.sessions ?? [])
        .filter((s) => s.state === "published")
        .sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""))
        .slice(0, LOOKBACK);
      for (const row of published) {
        try {
          const served = await ctx.json<ReceiptResponse>(routePath(ROUTES.swarm.sessionConsensusReceipt, { id: row.id }));
          const verdict = receiptVerdict(served);
          if (verdict.ok) return { row, why: verdict.why };
          lastSeen = `${row.id}: ${verdict.why}`;
        } catch {
          // 404 = this session has no receipt. Normal for restored history, and
          // for a session judged before the receipt auto-publish landed.
        }
      }
      return null;
    });

    if (!found) {
      checker.record(
        "judge:consensus-receipt",
        "FAIL",
        lastSeen ?? "no published session served a consensus receipt within the deadline",
        "No boot enables the judge any more (D48 as waived by D53): the judge is a participant (smoke spec §6.2), " +
          "and until one is seated nothing on the stack publishes a receipt, so this leg fails by construction. " +
          "Once one is seated and it still fails, read the judge participant's own log.",
      );
      return;
    }

    checker.record(
      "judge:consensus-receipt",
      "PASS",
      `session ${found.row.id} (${found.row.subjectId}) published a consensus receipt — ${found.why}`,
    );
  },
};
