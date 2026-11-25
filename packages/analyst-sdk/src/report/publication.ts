// Which frozen artifact publishes a natural key (issue 1182, D83). Pure: the
// backend reads the candidates from its ledger and calls this (issue 1751).

/** One frozen artifact's claim to publish one natural key (a regime day, or a signal's day). */
export interface PublicationCandidate {
  /** The natural key: a regime day, or `<signal>\u0000<day>`. */
  key: string;
  /** The day it is a figure for (YYYY-MM-DD). */
  date: string;
  runId: number;
  artifactId: number;
  /** The UTC day the artifact was written (analytics_output_snapshots.created_at). */
  writtenOn: string;
}

/**
 * THE RULE (D83), pure: for each key, the last candidate written during its
 * day (by run, then artifact); when none was, the first written after it.
 */
export function selectPublications<T extends PublicationCandidate>(candidates: Iterable<T>): Map<string, T> {
  const chosen = new Map<string, T>();
  for (const c of candidates) {
    const held = chosen.get(c.key);
    if (!held || publishesOver(c, held)) chosen.set(c.key, c);
  }
  return chosen;
}

/** True when `a` publishes its key in place of `b`. */
export function publishesOver(a: PublicationCandidate, b: PublicationCandidate): boolean {
  const aDuring = a.writtenOn <= a.date;
  const bDuring = b.writtenOn <= b.date;
  if (aDuring !== bDuring) return aDuring;
  const order = a.runId - b.runId || a.artifactId - b.artifactId;
  return aDuring ? order > 0 : order < 0;
}
