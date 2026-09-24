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
  windowClosesAt?: string | null;
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

/**
 * Is a shortfall a DEFECT, or is the evidence simply not in yet?
 *
 * The rehearsal runs this driver minutes after the brief publishes, while the
 * session is still collecting and member containers are still running four at a
 * time. A missing take there means "not finished", and failing on it would turn
 * a good release rehearsal red on timing — `stage-rehearsal.ts` treats any
 * non-zero verify as a blocking failure.
 *
 * So: still `collecting`, inside its own advertised window → WARN, which this
 * repo already uses for "nothing proven" (`swarm:vector-recomputable`). A
 * session whose window has closed, or that published without everyone, had its
 * chance — that is the 3-of-7 defect, and it FAILs.
 */
export function seatingVerdict(
  row: { state: string; windowClosesAt?: string | null },
  now: number = Date.now(),
): "WARN" | "FAIL" {
  if (row.state !== "collecting") return "FAIL";
  const closes = row.windowClosesAt ? Date.parse(row.windowClosesAt) : NaN;
  return Number.isFinite(closes) && now < closes ? "WARN" : "FAIL";
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
      if (!worst) {
        // No live take anywhere. If a session is collecting inside its window,
        // the first takes are simply not in yet; otherwise nothing is running.
        const body = await ctx.json<{ sessions?: SessionRow[] }>(ROUTES.swarm.sessions);
        const newest = (body.sessions ?? [])[0];
        const verdict = newest ? seatingVerdict(newest) : "FAIL";
        checker.record(
          "twin-roster:every-active-member-seated",
          verdict,
          verdict === "WARN"
            ? `NOT A PASS: session ${newest!.id} is still collecting (window closes ${newest!.windowClosesAt}) and no ` +
              `member has filed yet — seating is unproven here, not disproven. Re-run once the window has closed.`
            : "no session with a live (non-archival) take appeared within the deadline",
          "A twin seats every active restored member (scripts/lib/smoke-mode.ts adoptionFilter, twin branch).",
        );
        return;
      }
      const w = worst!;
      const verdict = seatingVerdict(w.row);
      const who = w.missing.map((m) => m.handle ?? m.id).join(", ");
      checker.record(
        "twin-roster:every-active-member-seated",
        verdict,
        verdict === "WARN"
          ? `NOT A PASS: session ${w.row.id} (${w.row.subjectId}) has ${w.seated} of ${active.length} ` +
            `so far and is still collecting until ${w.row.windowClosesAt} — still to file: ${who}. ` +
            `Unproven, not disproven: member containers run a few at a time and takes land over the window.`
          : `session ${w.row.id} (${w.row.subjectId}) seated ${w.seated} of ${active.length} ` +
            `with its window closed — never seated: ${who}`,
        "A twin seats every active restored member (scripts/lib/smoke-mode.ts adoptionFilter, twin branch). " +
          "A shortfall past the window means adoption filtered someone out — check the boot's 'swarm now N seats' line against the roster.",
      );
      return;
    }

    checker.record(
      "twin-roster:every-active-member-seated",
      "PASS",
      `session ${found!.row.id} (${found!.row.subjectId}) carries a live take from all ${active.length} active member(s)`,
    );
  },
};
