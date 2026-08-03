// @ts-nocheck — the browser's memory of an application this operator started.
//
// The swarm application id is minted server-side and handed to the operator
// exactly once: their agent prints `<host>/swarm/apply/<uuid>` into a chat
// transcript (the swarm-onboarding skill instructs it to, at its Step 3 and
// again in the Step 5 operator report). Nothing on the site links to that page,
// and nothing can: the id does not exist until the application is accepted, by
// which point the operator has left the site entirely.
//
// So the first time they DO open the status page, we write the id down. From
// then on /swarm/apply can offer a way back, and losing the chat message
// stops being terminal. Deliberately not a cookie: this never travels to the
// server, and there is nothing here the server does not already know.
//
// localStorage is already origin-scoped, so a localhost application can never
// surface on production and vice versa.
const KEY = "rm:swarm:application";

/** Write down an application the operator has actually opened. */
export function rememberApplication(entry) {
  if (!entry?.id) return;
  try {
    localStorage.setItem(KEY, JSON.stringify({
      id: entry.id,
      name: entry.name || null,
      state: entry.state || null,
      seenAt: entry.seenAt || new Date().toISOString(),
    }));
  } catch { /* private mode, or storage full — recovery is a courtesy, never a dependency */ }
}

/** The remembered application, or null. Never throws. */
export function recallApplication() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed.id === "string" && parsed.id ? parsed : null;
  } catch { return null; }
}

/** Drop it: the id 404s now, so the pointer is worse than nothing. */
export function forgetApplication() {
  try { localStorage.removeItem(KEY); } catch { /* nothing to do */ }
}
