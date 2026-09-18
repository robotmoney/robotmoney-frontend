// INVARIANT #3 — a twin session seats the WHOLE restored roster.
//
// WHY THIS IS A CHECK AND NOT A COMMENT. The stage twin ran for weeks with
// three seats on a roster of seven: the four real members (DualMint, Maximus,
// ShodAI, Woon) were filtered out of adoption for having no committed key, and
// nothing anywhere said so. The session page does not distinguish "this member
// was never seated" from "this member was seated and had nothing to say" — both
// render as a take that is not there — so the shortfall was invisible until
// somebody counted the roster against the takes BY HAND. That is the entire
// case for this leg: the failure is silent, it survived every other check this
// repo runs, and it made a twin rehearse less than half the swarm it exists to
// rehearse.
//
// TIER `full`, DELIBERATELY. This asserts a property of the TWIN's seating
// (scripts/lib/smoke-mode.ts's adoptionFilter), not of the product. Against
// production the same assertion would be WRONG and would fire constantly: a
// real member is absent whenever its owner's agent is down, which is an honest
// state the swarm is designed to tolerate (`withMemberAbsent`, and the absence
// path in session.ts). Only a twin — where every seat is driven by this stack —
// owes full attendance.
//
// READ-ONLY HTTP, like its neighbour: it reads the same payloads the site
// serves, so it asserts what a reader can see rather than what the database
// holds behind a projection.
import { ROUTES, path as routePath } from "@robotmoney/contract";
import type { VerifyContext, VerifyLeg } from "../harness.ts";

/** How many of the newest sessions to inspect before giving up. A twin boot's
 *  own session is the newest; the depth exists so a restored feed whose newest
 *  rows are archival history does not hide it. */
const LOOKBACK = 5;

interface MemberRow {
  id: string;
  handle?: string;
  name: string;
  status: string;
}

interface SessionRow {
  id: string;
  date: string;
  subjectId: string;
  state: string;
}

interface TakeRow {
  memberId: string;
  memberHandle?: string;
  memberName?: string;
  archival?: boolean;
}

/**
 * Active members with no take in `takes` — the seating shortfall, as a value.
 *
 * PURE, and separated from the fetching for exactly one reason: it is the part
 * that can be wrong in a way a live run would not reveal (a handle/id mismatch
 * reports every member missing, which looks like a broken stack rather than a
 * broken comparison). scripts/tests/unit/verify-twin-roster.test.ts drives it.
 *
 * Compared by HANDLE with an id fallback, the same key adoption uses: ids are
 * generated per deployment, so they are not stable across a restore, while a
 * pre-0030 row may still carry no handle at all.
 */
export function unseatedMembers(active: readonly MemberRow[], takes: readonly TakeRow[]): MemberRow[] {
  const seated = new Set<string>();
  for (const t of takes) {
    if (t.memberHandle) seated.add(t.memberHandle.toLowerCase());
    if (t.memberId) seated.add(t.memberId.toLowerCase());
  }
  return active.filter((m) => !seated.has((m.handle ?? m.id).toLowerCase()) && !seated.has(m.id.toLowerCase()));
}

/** The takes a THIS-BOOT session produced: archival rows are restored history
 *  and say nothing about who this stack seated. */
export function liveTakes(takes: readonly TakeRow[]): TakeRow[] {
  return takes.filter((t) => !t.archival);
}

export const twinRosterLeg: VerifyLeg = {
  name: "twin-roster",
  tier: "full",

  async run(ctx: VerifyContext): Promise<void> {
    const { checker } = ctx;

    const membersBody = await ctx.json<{ members?: MemberRow[] }>(ROUTES.swarm.members);
    const active = (membersBody.members ?? []).filter((m) => m.status === "active");
    if (!active.length) {
      checker.record(
        "twin-roster:active-members",
        "FAIL",
        "the restored roster carries no active members — nothing could be seated",
        "A twin restores production's roster; an empty one means the restore or the seed pruned it.",
      );
      return;
    }
    checker.record("twin-roster:active-members", "PASS", `${active.length} active member(s) on the restored roster`);

    // Polled, not read once: takes land over the collection window (one member
    // container per seat, four at a time), so a single read right after the
    // brief publishes would report a shortfall that is simply not finished.
    interface Shortfall { row: SessionRow; missing: MemberRow[]; seated: number }
    let closest: Shortfall | undefined;
    const found = await ctx.until("a live session seating every active member", async () => {
      const body = await ctx.json<{ sessions?: SessionRow[] }>(ROUTES.swarm.sessions);
      const rows = (body.sessions ?? []).slice(0, LOOKBACK);
      for (const row of rows) {
        const detail = await ctx.json<{ takes?: TakeRow[] }>(
          routePath(ROUTES.swarm.session, { date: row.date, subject: row.subjectId }),
        );
        const live = liveTakes(detail.takes ?? []);
        if (!live.length) continue; // archival-only: restored history, not this boot's
        const missing = unseatedMembers(active, live);
        if (!missing.length) return { row, live };
        if (!closest || live.length > closest.seated) closest = { row, missing, seated: live.length };
      }
      return null;
    });

    if (!found) {
      const worst: Shortfall | undefined = closest;
      const detail = worst
        ? `newest live session ${worst.row.id} (${worst.row.subjectId}) seated ${worst.seated} of ` +
          `${active.length} — missing: ${worst.missing.map((m) => m.handle ?? m.id).join(", ")}`
        : "no session with a live (non-archival) take appeared within the deadline";
      checker.record(
        "twin-roster:every-active-member-seated",
        "FAIL",
        detail,
        "A twin seats every active restored member (scripts/lib/smoke-mode.ts adoptionFilter, twin branch). " +
          "A shortfall means adoption filtered someone out — check the boot's 'swarm now N seats' line against the roster.",
      );
      return;
    }

    checker.record(
      "twin-roster:every-active-member-seated",
      "PASS",
      `session ${found.row.id} (${found.row.subjectId}) carries a live take from all ${active.length} active member(s)`,
    );
  },
};
