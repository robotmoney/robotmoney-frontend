// Derive a member's PUBLIC handle from its display name (issue #562).
//
// WHY THIS EXISTS. Migration 0030 gave every member a `handle` and defaulted it
// to the member's own `id` via a BEFORE INSERT trigger. That default is exactly
// right for the six writers that supply no handle (roster seed, smoke/e2e, the
// v0 archive backfill) — a seeded member's id was already its published URL, so
// nothing moved on deploy. It is useless for a member admitted through the
// public front door: `applyMember` mints `id = crypto.randomUUID()`, so the
// trigger publishes that applicant at /swarm/members/8f3c1e0a-…, and no amount
// of admin diligence produces a readable URL unless somebody types one by hand.
//
// This module is the one place that turns "Noop Analyst" into `noop-analyst`.
// It is a LEAF: it imports a database handle type and nothing else from the
// swarm modules, so both domain.ts (activate, register) and admin.ts (manual
// add) can call it without a cycle.
//
// WHAT IT IS NOT. It is not a validator and it is not a renamer. Nothing here
// ever reads or rewrites an existing member's handle — `deriveMemberHandle`
// only ever RETURNS a string, and every call site decides for itself whether to
// write it. That is what keeps `woon`, `athena` and `robotmoney` untouched
// (issue #562 declined renaming existing members): those rows are inserted raw
// by roster-seed.ts and never pass through here at all.
import type { DbHandle } from "../db/client.ts";

// `handle` is validated at the admin route with `requiredString(body, "handle",
// 80)`, so a derived handle must fit the same budget or an operator could not
// re-type what the system produced. The stem is cut shorter than that to leave
// room for the collision suffix appended below.
export const HANDLE_MAX_LENGTH = 80;
const STEM_MAX_LENGTH = 72;

// DEGENERATE NAMES (issue #562 decision 3). A name that slugifies to nothing —
// "!!!", "。。。", a string of emoji — still needs a handle, because
// swarm_members.handle is NOT NULL. It must NOT fall back to the id: on the
// public apply path the id IS the UUID this module exists to keep out of URLs,
// so that fallback satisfies the constraint and nothing else.
//
// The fallback is therefore a readable stem, disambiguated by the SAME numeric
// suffix rule every other collision uses: `member`, then `member-2`, `member-3`.
// One mechanism, one thing to reason about, and the result is a URL an operator
// can read out loud and then change from the admin surface — which is the only
// property a placeholder has to have.
export const DEGENERATE_NAME_STEM = "member";

// Combining marks left over from NFKD, stripped so "Renée Muñoz" becomes
// `renee-munoz` rather than losing the accented letters entirely to the
// non-alphanumeric run rule below.
const COMBINING_MARKS = /\p{M}+/gu;
const NON_HANDLE_RUN = /[^a-z0-9]+/g;
const EDGE_HYPHENS = /^-+|-+$/g;

/**
 * Slugify a display name into the shape MEMBER_HANDLE_RE accepts —
 * `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`, lowercase kebab-case with no leading,
 * trailing or doubled hyphen.
 *
 * Total: every input produces a string that matches, including the empty
 * string and input that strips to nothing (both yield DEGENERATE_NAME_STEM).
 * Asserted over a property-style corpus in
 * tests/swarm-member-handle-derivation.test.ts against the REAL regex imported
 * from api/validation.ts, so the two can never drift into disagreeing about
 * what a handle is.
 */
export function slugifyMemberName(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(COMBINING_MARKS, "")
    .toLowerCase()
    .replace(NON_HANDLE_RUN, "-")
    .replace(EDGE_HYPHENS, "")
    // Truncation happens AFTER edge-trimming and is re-trimmed, or a name cut
    // mid-word would end in a hyphen and fail the regex.
    .slice(0, STEM_MAX_LENGTH)
    .replace(EDGE_HYPHENS, "");
  return slug === "" ? DEGENERATE_NAME_STEM : slug;
}

/**
 * The free public handle nearest to `name`, for the member `memberId`.
 *
 * COLLISION RULE (issue #562 decision 2): a deterministic numeric suffix —
 * `noop-analyst`, then `noop-analyst-2`, `noop-analyst-3` — never a refusal.
 * Refusing would mean one applicant's onboarding is blocked by an unrelated
 * member's name, with no action the administrator approving it can take except
 * to invent a handle by hand; and it would put a 409 on the approve button for
 * a condition the applicant cannot see, let alone fix. The suffix is chosen as
 * the lowest free integer rather than a random tail so that re-deriving the
 * same name against the same roster gives the same answer, which is what makes
 * the behaviour testable and an operator's expectation stable.
 *
 * BOTH NAMESPACES ARE PROBED, and this is load-bearing. `id` is a public URL
 * segment too — getMember/getMemberTakes resolve `handle = $ref OR id = $ref`,
 * which is what keeps every pre-rename link alive — so a handle equal to
 * ANOTHER member's id is refused by migration 0031's trigger with SQLSTATE
 * 23505. A probe against `handle` alone passes here and then dies in the
 * trigger, which on the admin approve route is a sanitized 500. The predicate
 * below is the same one updateMemberAdminTx uses for exactly this reason.
 *
 * `id <> memberId` excludes the member itself: re-deriving for a row that
 * already holds the name it wants must not push it to `-2`.
 *
 * ONE QUERY, NOT N. Every taken name in the stem's family is fetched once and
 * the lowest free suffix is chosen in memory. That also makes termination
 * obvious: `taken` has a finite size, so at most `taken.size + 1` candidates
 * can be occupied, and the scan below is bounded by it — no unbounded probe
 * loop against the database.
 */
export async function deriveMemberHandle(
  db: DbHandle,
  input: { memberId: string; name: string },
): Promise<string> {
  const stem = slugifyMemberName(input.name);
  // The stem is `[a-z0-9-]` by construction, so it carries no LIKE wildcard and
  // needs no escaping.
  const prefix = `${stem}-%`;
  const rows = await db<{ taken: string }[]>`
    SELECT handle AS taken FROM swarm_members
    WHERE id <> ${input.memberId} AND (handle = ${stem} OR handle LIKE ${prefix})
    UNION
    SELECT id AS taken FROM swarm_members
    WHERE id <> ${input.memberId} AND (id = ${stem} OR id LIKE ${prefix})`;
  const taken = new Set(rows.map((r) => r.taken));

  if (!taken.has(stem)) return stem;
  for (let n = 2; n <= taken.size + 2; n++) {
    const candidate = `${stem}-${n}`;
    if (candidate.length <= HANDLE_MAX_LENGTH && !taken.has(candidate)) return candidate;
  }
  // Unreachable: `taken` holds at most taken.size names, and the loop offers
  // taken.size + 1 distinct candidates. Kept as a loud failure rather than a
  // silent `stem` that the database would then refuse with a bare 23505.
  throw new Error(`could not derive a free handle for ${JSON.stringify(input.name)} (stem ${stem})`);
}

/**
 * "Has nobody set a handle for this member yet?"
 *
 * Migration 0030's untouched default is `handle = id`, so that equality is the
 * signal — and it is the ONLY signal available, because the column is NOT NULL
 * and there is no "unset" value to look for.
 *
 * WHY A CONDITION AT ALL (issue #562 decision 1). `updateMemberAdminTx` is not
 * status-gated, so an administrator can already set a pending applicant's
 * handle BEFORE the application is accepted, and that works today. An
 * unconditional derivation at acceptance would silently overwrite it — a
 * regression of a shipped capability, and a published URL moving without anyone
 * asking. Deriving only from the default means acceptance either fills in a
 * blank or leaves a decision alone.
 *
 * KNOWN EDGE. An administrator who explicitly sets a member's handle to its own
 * id is indistinguishable from one who never touched it, so acceptance will
 * re-derive. That is accepted: the two states are identical in the schema, the
 * outcome is a readable URL rather than a UUID, and the administrator can
 * change it back at any time.
 */
export function handleIsUnset(row: { id: string; handle: string | null }): boolean {
  return row.handle === null || row.handle === "" || row.handle === row.id;
}
