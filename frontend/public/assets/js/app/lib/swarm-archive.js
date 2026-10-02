// What the static swarm archive actually holds: data/swarm/archive-index.json,
// kept equal to the folders by scripts/tests/unit/swarm-archive-index.test.ts.
//
// The archive's session index lists days it has no snapshot or brief for, and
// the pages built those file names from the session list. Every miss was a 404
// the page caught and the browser still logged, once per reader, which is what
// the sitemap sweep caught when a subject page joined the sitemap. Asking the
// index first means a page only requests files that exist. Without the index
// (it failed to load), every file is assumed present, as before.

/** @type {Promise<{ snapshots?: Record<string, string[]>, briefs?: string[] } | null> | undefined} */
let indexRead;

/** @returns {Promise<{ snapshots?: Record<string, string[]>, briefs?: string[] } | null>} */
function archiveIndex() {
  indexRead ??= fetch("/data/swarm/archive-index.json", { headers: { Accept: "application/json" } })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  return indexRead;
}

/** @param {string} subject @param {string} date */
export async function archiveHasSnapshot(subject, date) {
  const ix = await archiveIndex();
  return !ix || (ix.snapshots?.[subject] ?? []).includes(date);
}

/** @param {string} date @param {string} subject */
export async function archiveHasBrief(date, subject) {
  const ix = await archiveIndex();
  return !ix || (ix.briefs ?? []).includes(`${date}-${subject}`);
}

// A session's brief from the archive, or null when the archive has none.
/** @param {string} date @param {string} subject */
export async function loadArchiveBrief(date, subject) {
  if (!date || !subject || !(await archiveHasBrief(date, subject))) return null;
  try {
    const r = await fetch(`/data/swarm/briefs/${date}-${subject}.json`, { headers: { Accept: "application/json" } });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}
