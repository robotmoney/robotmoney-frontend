// INVARIANT #1 — the Investment Swarm decision pipeline produces decisions,
// and INVARIANT #2 — the published allocation vector is recomputable from the
// published takes.
//
// These two are one leg because #2 is meaningless without #1: a vector that
// recomputes from an empty take set proves nothing, and a pipeline that runs
// without a checkable output is the thing D42 exists to rule out.
//
// EVERYTHING HERE IS HTTP AND READ-ONLY, on purpose. The check reads the same
// payloads the site serves, so it asserts what a reader actually sees rather
// than what the database happens to hold behind a projection — the principle
// smoke-e2e-assert.ts already follows ("the subject list is derived from the
// sessions feed exactly as swarm.js derives it"). It also means this leg is
// safe against production and needs no database credential, which is what lets
// the same code run in CI, in the stage rehearsal, and at cutover.
//
// WHY #2 IS THE CHECK THAT MATTERS. D42: the allocation vector stays on
// `meanTakeWeights()` and the judge authors no number, so that ANYONE HOLDING
// THE TAKE SET CAN RECOMPUTE THE VECTOR THEMSELVES. Until now nothing
// exercised that claim anywhere — a judge regression, an aggregation bug, or a
// tampered stored vector would pass every check the release runs. This leg
// recomputes with an INDEPENDENT implementation
// (../recompute-weights.ts, held to the real derivation by
// scripts/tests/unit/verify-recompute-weights.test.ts) rather than importing
// the function under test.
import { ROUTES, path as routePath } from "@robotmoney/contract";
import type { VerifyContext, VerifyLeg } from "../harness.ts";
import { recomputeMeanTakeWeights, diffWeightVectors } from "../recompute-weights.ts";

/** Starvation guard (#101): a single wedged worker lane publishes one session
 *  and stops. Two is the smallest count that distinguishes "it ran" from "it
 *  ran once" — the same constant smoke-live-smoke.ts guards on. */
const MIN_PUBLISHED_SESSIONS = 2;

/** How many published sessions to recompute. Bounded because the leg runs at
 *  cutover against a feed with hundreds of rows and each one is a fetch; the
 *  newest are the ones a regression would have touched. */
const RECOMPUTE_DEPTH = 5;

/** A session may sit in `collecting` for its window; past the window plus this
 *  grace it is wedged, not waiting. */
const COLLECTING_GRACE_MS = 60 * 60 * 1000;

interface SessionRow {
  id: string;
  date: string;
  subjectId: string;
  state: string;
  windowClosesAt: string | null;
  publishedAt: string | null;
  swarmRecommendation: { type?: string; weights?: { bucket: string; weight: number }[] } | null;
}
/**
 * GET /api/swarm/sessions/:date/:subject returns `{ session, takes }` — the
 * session is NOT at the top level. Reading it flat yields `undefined` for every
 * session field, which surfaces as "published but no publishedAt" for EVERY
 * row: a uniform failure across unrelated sessions, which is the signature of a
 * reader bug rather than a product one.
 */
interface SessionDetail {
  session: SessionRow;
  takes?: {
    memberId: string;
    weights?: { bucket: string; weight: number }[] | null;
    verified: boolean;
    archival?: boolean;
    revision?: number;
  }[];
}

export const swarmPipelineLeg: VerifyLeg = {
  name: "swarm",
  tier: "readonly",

  async run(ctx: VerifyContext): Promise<void> {
    const { checker } = ctx;

    // (a) The feed exists at all. Polled: right after a boot the first session
    //     may still be publishing, and a hard read here would report a product
    //     failure for a stack that simply had not finished starting.
    const feed = await ctx.until("the sessions feed to serve published sessions", async () => {
      const body = await ctx.json<{ sessions?: SessionRow[] }>(ROUTES.swarm.sessions);
      const sessions = body.sessions ?? [];
      const published = sessions.filter((s) => s.state === "published");
      return published.length >= MIN_PUBLISHED_SESSIONS ? { sessions, published } : null;
    });

    if (!feed) {
      checker.record(
        "swarm:published-sessions",
        "FAIL",
        `fewer than ${MIN_PUBLISHED_SESSIONS} published session(s) within the deadline`,
        "One published session is the #101 starvation signature: one epoch turned over and nothing after it. Sessions are timed by `system-scheduler` now (system-scheduler-spec.md §1), so check that container's /health — an unauthenticated, unsynchronized or exhausted scheduler answers 503 with the subject and the last error.",
      );
      return; // every check below reads from this feed; continuing would report noise
    }
    checker.record(
      "swarm:published-sessions",
      "PASS",
      `${feed.published.length} published of ${feed.sessions.length} session(s)`,
    );

    // (b) Nothing wedged mid-lifecycle. A session stuck in `collecting` long
    //     past its own window is the shape a stalled lane leaves behind, and it
    //     is invisible in a published-count check.
    const now = Date.now();
    const wedged = feed.sessions.filter((s) => {
      if (s.state !== "collecting" || !s.windowClosesAt) return false;
      const closes = Date.parse(s.windowClosesAt);
      return Number.isFinite(closes) && now > closes + COLLECTING_GRACE_MS;
    });
    checker.record(
      "swarm:no-wedged-sessions",
      wedged.length ? "FAIL" : "PASS",
      wedged.length
        ? wedged.map((s) => `${s.id} (${s.subjectId}) still collecting, window closed ${s.windowClosesAt}`)
        : "no session is past its collection window",
      "A session past its window that never closed means the lifecycle job that advances it did not run.",
    );

    // (c)(d) Lifecycle completeness and THE RECOMPUTE.
    //
    // Two DIFFERENT selections, deliberately. Lifecycle completeness is a
    // property of whatever published most recently, so it reads the newest
    // slice. The recompute can only run on a `bucket_weights` session — a
    // `position_actions` subject produces no vector at all — and those are not
    // necessarily the newest rows, so it filters the whole feed by type rather
    // than hoping the newest slice contains one. List rows carry the
    // recommendation rollup (issue #243), so this costs no extra fetches.
    const newest = (rows: SessionRow[]) =>
      rows.slice().sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""));

    const recentRows = newest(feed.published).slice(0, RECOMPUTE_DEPTH);
    const weightRows = newest(
      feed.published.filter((s) => s.swarmRecommendation?.type === "bucket_weights"),
    ).slice(0, RECOMPUTE_DEPTH);
    // Union, so a bucket_weights session outside the newest slice still gets
    // its lifecycle checked, and the newest slice still gets recomputed if it
    // happens to carry weights.
    const recent = [...new Map([...recentRows, ...weightRows].map((r) => [r.id, r])).values()];

    const incomplete: string[] = [];
    const divergent: string[] = [];
    const unverifiable: string[] = [];
    const archivalClaims: string[] = [];
    let recomputed = 0;

    for (const row of recent) {
      let detail: SessionDetail;
      try {
        detail = await ctx.json<SessionDetail>(routePath(ROUTES.swarm.session, { date: row.date, subject: row.subjectId }));
      } catch (e) {
        incomplete.push(`${row.id}: detail did not load — ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      const session = detail.session;
      if (!session) {
        incomplete.push(`${row.id}: detail carried no session object`);
        continue;
      }

      if (!session.publishedAt) incomplete.push(`${session.id}: state=published but no publishedAt`);
      if (!session.swarmRecommendation) {
        incomplete.push(`${session.id}: published with no swarmRecommendation`);
        continue;
      }

      // An archival take was never member-signed, so it cannot also be a
      // verified one. The two fields carry different meanings (#498) and a row
      // claiming both would make "verified" unreadable.
      for (const t of detail.takes ?? []) {
        if (t.archival === true && t.verified === true) {
          archivalClaims.push(`${session.id}/${t.memberId}: archival take also claims verified`);
        }
      }

      const published = session.swarmRecommendation.weights;
      if (!published || published.length === 0) {
        // Legitimate for a position_actions subject; suspicious for a
        // bucket_weights one, which is exactly what the type field is for.
        if (session.swarmRecommendation.type === "bucket_weights") {
          incomplete.push(`${session.id}: bucket_weights session published no weights`);
        }
        continue;
      }

      const takes = detail.takes ?? [];
      if (takes.length === 0) {
        unverifiable.push(`${session.id}: published a vector but serves no takes — the claim cannot be checked by anyone`);
        continue;
      }

      // The DTO exposes a take's weights at `take.weights`; the derivation
      // reads the row shape `take.payload.weights`. Map, don't re-derive.
      const mine = recomputeMeanTakeWeights(takes.map((t) => ({ payload: { weights: t.weights ?? undefined } })));
      if (!mine) {
        unverifiable.push(`${session.id}: no take carries usable weights, yet a vector was published`);
        continue;
      }
      const problems = diffWeightVectors(published, mine);
      recomputed++;
      if (problems.length) divergent.push(...problems.map((p) => `${session.id}: ${p}`));
    }

    checker.record(
      "swarm:lifecycle-complete",
      incomplete.length ? "FAIL" : "PASS",
      incomplete.length ? incomplete : `${recent.length} newest published session(s) carry a complete recommendation`,
      "A published session missing its recommendation or publish timestamp means the aggregate/publish step wrote a partial row.",
    );

    checker.record(
      "swarm:takes-served",
      unverifiable.length ? "FAIL" : "PASS",
      unverifiable.length ? unverifiable : `every recomputed session serves the take set its vector came from`,
      "D42's guarantee is that a reader can recompute the vector. A published vector whose takes are not served is unfalsifiable by construction.",
    );

    checker.record(
      "swarm:archival-semantics",
      archivalClaims.length ? "FAIL" : "PASS",
      archivalClaims.length ? archivalClaims : "no archival take claims signature verification",
    );

    // THE CHECK. Everything above is precondition.
    checker.record(
      "swarm:vector-recomputable",
      divergent.length ? "FAIL" : recomputed === 0 ? "WARN" : "PASS",
      divergent.length
        ? divergent
        : recomputed === 0
          ? [
              "NOT A PASS: no published bucket_weights session was available to recompute.",
              `feed carried ${feed.published.length} published session(s), ${weightRows.length} of them bucket_weights.`,
              "Expected on a database whose history predates 0051 (the migration that repairs robotmoney-vault/robotmoney-allocation back to bucket_weights after a smoke fixture clobbered them to position_actions). Until a bucket_weights session publishes, D42's recomputability claim has nothing to verify here.",
            ]
          : `${recomputed} published vector(s) recompute exactly from their takes`,
      // Remediation is only read for WARN/FAIL, and the two carry DIFFERENT
      // causes: a divergence is a defect to chase, while "nothing to recompute"
      // is a coverage gap to wait out. Printing the divergence text for the
      // empty case would send an operator hunting a bug that is not there.
      divergent.length
        ? "The published vector does not equal the mean of its own published takes. Either the aggregation path wrote something meanTakeWeights() did not produce, a stored vector was altered after publication, or the derivation changed without the reference implementation being updated with it (D42; scripts/lib/verify/recompute-weights.ts)."
        : "Nothing to fix and nothing proven. Re-run once a bucket_weights subject publishes a session; until then this invariant is unverified on this target.",
    );
  },
};
