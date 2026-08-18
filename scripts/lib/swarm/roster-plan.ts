// WHO JOINS, WHO IS ADOPTED, WHO IS SKIPPED — pure decisions, no I/O.
//
// The demo's roster logic used to be an in-process counter: admit newcomer #0,
// #1, #2 … starting from 0 in every boot. Against a throwaway database that was
// right. Against a persistent one it re-admitted the same character on every
// restart — the standing demo accumulated FIVE Helios rows, three active and two
// stranded in `applied`, one per boot — while the personas that were already
// there sat on the roster unable to file a take.
//
// Both decisions now depend on what the DATABASE says, which makes them worth
// testing directly rather than discovering on a live stack. They live here,
// pure and side-effect free, so scripts/tests/unit/roster-plan.test.ts can drive
// every branch (including the unreadable-roster branch, which is the one that
// must never quietly admit a duplicate) without booting anything.
//
// Consumed by scripts/lib/demo-main.ts's onboarding and swarm drivers.

/**
 * How long to wait before the NEXT admission attempt.
 *
 * The interval paces real admissions, so it is counted from admissions that
 * actually happened — not from names the driver skipped. The loop used to sleep
 * before deciding, which meant a persona already in the database cost a full
 * interval to say "no" to: on the standing demo (6 h interval) a restart with
 * four known personas would idle a full DAY before admitting the first genuinely
 * new character. A skip is a no-op and must cost nothing.
 *
 * The FIRST admission of a boot still uses the prompt delay, so a visitor sees
 * onboarding shortly after load however many personas were skipped to get there.
 */
export function admissionDelayMs(admittedSoFar: number, firstMs: number, intervalMs: number): number {
  return admittedSoFar === 0 ? firstMs : intervalMs;
}

/** One roster row as the admin members route reports it. */
export interface RosterRow {
  id: string;
  /**
   * The member's public handle (issue #685). OPTIONAL because `id` is what
   * seats a member and what every child row is keyed on — a caller that only
   * has an id is still a valid RosterRow — but it is the only key an ALLOWLIST
   * can be written against, now that ids are generated per deployment
   * (`crypto.randomUUID()`) rather than being the archive's own slug.
   */
  handle?: string;
  name: string;
  lens?: string | null;
  status: string;
}

export type AdmissionDecision =
  | { admit: true }
  | { admit: false; reason: "already-on-roster" | "roster-unreadable" };

/**
 * May this named newcomer be admitted?
 *
 * `takenNames` is null when the roster could not be read. That case FAILS
 * CLOSED — a duplicate member is permanent and visible, a delayed admission is
 * neither — matching how the roster-cap check assumes FULL rather than empty on
 * a read error.
 */
export function decideAdmission(name: string, takenNames: ReadonlySet<string> | null): AdmissionDecision {
  if (takenNames === null) return { admit: false, reason: "roster-unreadable" };
  return takenNames.has(name.trim().toLowerCase())
    ? { admit: false, reason: "already-on-roster" }
    : { admit: true };
}

/** Lower-cased names from a roster, for decideAdmission. Any status counts: a
 *  newcomer stranded at `applied` still owns its name, and re-admitting it only
 *  produces a second stranded row. */
export function takenNamesFrom(roster: readonly RosterRow[]): Set<string> {
  return new Set(roster.map((m) => m.name.trim().toLowerCase()).filter(Boolean));
}

export interface AdoptionPlan {
  /** Personas to seat this boot, at most one per character. */
  adopt: RosterRow[];
  /** Extra active rows for a character already seated — the residue of the
   *  duplicate-admission bug, reported so it is visible rather than silently
   *  ignored. */
  duplicates: RosterRow[];
}

/**
 * Which database personas should take a seat this boot.
 *
 * Three filters, each load-bearing:
 *   - ACTIVE only. An `applied`/`deactivated` row is not a swarm member.
 *   - NOT ALREADY SEATED. The built-in characters are on the list already, under
 *     the same ids the database holds.
 *   - HAS A COMMITTED IDENTITY. Only the demo's own characters have a key in
 *     fixtures/persona-keys.json; anyone else is somebody's real member, and
 *     inventing a key for them is precisely the behaviour being removed.
 *
 * One seat per NAME even when the database holds several actives for that
 * character, so a roster polluted by the old duplicate-admission bug does not
 * seat the same persona three times.
 */
export function planAdoptions(
  roster: readonly RosterRow[],
  seatedIds: ReadonlySet<string>,
  hasCommittedIdentity: (name: string) => boolean,
): AdoptionPlan {
  const adopt: RosterRow[] = [];
  const duplicates: RosterRow[] = [];
  const seenNames = new Set<string>();
  for (const m of roster) {
    if (m.status !== "active") continue;
    if (seatedIds.has(m.id)) continue;
    if (!hasCommittedIdentity(m.name)) continue;
    const key = m.name.trim().toLowerCase();
    if (seenNames.has(key)) {
      duplicates.push(m);
      continue;
    }
    seenNames.add(key);
    adopt.push(m);
  }
  return { adopt, duplicates };
}
